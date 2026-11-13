import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { RPC } from "#client-sdk/product-types";
import type { OutputOf } from "#client-sdk/inference";
import { normalizeClientError, SDKError } from "#client-sdk/errors";
import { Schema } from "@hyori-cloud/lib/effect";

const PeerPresence = Schema.Struct({
  user: Schema.Struct({ name: Schema.String, color: Schema.String }),
  cursor: Schema.Unknown,
});

export type CollaborationRecovery = {
  generation: string;
  state: string;
  pending: string;
  updatedAt: number;
};

export type CollaborationJournal = {
  load(): Promise<CollaborationRecovery | null>;
  save(value: CollaborationRecovery | null): Promise<void>;
  dispose?(): void;
};

type Descriptor = OutputOf<RPC["collaboration"]["open"]>;

type Snapshot = {
  document: Descriptor | null;
  status: "opening" | "saved" | "pending" | "offline" | "blocked";
  writable: boolean;
  hasUnsavedChanges: boolean;
  recoveryError: boolean;
  error: string | null;
  peers: readonly string[];
};

export function encodeCollaborationBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeCollaborationBytes(hex: string): Uint8Array {
  if (hex.length % 2 || !/^[0-9a-f]*$/.test(hex))
    throw new SDKError("SDK_PROTOCOL", "Invalid collaborative state.");

  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** One content authority per open document. HTTP is only a transport: receipts follow PostgreSQL
 * commit, and a future socket transport can use the same session, generation and receipt contract.
 * The server exchanges missing Yjs structs; Query never stores an editable copy of this document.
 */
export function createCollaborationSession({
  id,
  backend,
  journal,
  onUnsavedChange,
}: {
  id: string;
  backend: RPC["collaboration"];
  journal?: CollaborationJournal | undefined;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const doc = new Y.Doc();
  const remote = Symbol("accepted remote update");
  const listeners = new Set<() => void>();
  let awareness: Awareness | null = null;
  let descriptor: Descriptor | null = null;
  let pending: Uint8Array[] = [];

  let snapshot: Snapshot = {
    document: null,
    status: "opening",
    writable: false,
    hasUnsavedChanges: false,
    recoveryError: false,
    error: null,
    peers: [],
  };

  let started = false;
  let disposed = false;
  let blocked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = Infinity;
  let flight: Promise<void> | null = null;
  let journalWrite = Promise.resolve();
  let journalQueued = false;
  let journalUnreadable = false;
  const abort = new AbortController();
  let peerClock = 0;

  function publish(patch: Partial<Snapshot>) {
    if (disposed) return;

    if (
      patch.hasUnsavedChanges !== undefined &&
      patch.hasUnsavedChanges !== snapshot.hasUnsavedChanges
    )
      onUnsavedChange?.(patch.hasUnsavedChanges);
    snapshot = { ...snapshot, ...patch };

    for (const listener of listeners) listener();
  }

  function preserve() {
    if (!journal || !descriptor || journalQueued || journalUnreadable) return;
    journalQueued = true;
    journalWrite = journalWrite
      .then(async () => {
        journalQueued = false;

        const value =
          pending.length === 0
            ? null
            : {
                generation: descriptor!.generation,
                state: encodeCollaborationBytes(Y.encodeStateAsUpdate(doc)),
                pending: encodeCollaborationBytes(Y.mergeUpdates(pending)),
                updatedAt: Date.now(),
              };

        await journal.save(value);
      })
      .catch(() => {
        publish({ recoveryError: true });
      });
  }

  // Yjs transaction origins are opaque identity tokens, not product input.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  function changed(update: Uint8Array, origin: unknown) {
    if (origin === remote || disposed) return;
    pending.push(update);
    publish({ hasUnsavedChanges: true, status: blocked ? "blocked" : "pending" });
    preserve();

    if (pending.reduce((sum, bytes) => sum + bytes.length, 0) > 1024 * 1024) {
      blocked = true;
      publish({
        status: "blocked",
        writable: false,
        error: "The local recovery limit was reached. Export your note before reopening.",
      });

      return;
    }

    schedule(250);
  }

  function schedule(delay: number) {
    if (disposed || blocked) return;
    const deadline = Date.now() + delay;

    // Continuous input must not postpone the first unsent batch or an earlier retry.
    if (timer !== undefined && scheduledAt <= deadline) return;
    clearTimeout(timer);
    scheduledAt = deadline;
    timer = setTimeout(() => void flush(), delay);
  }

  async function start() {
    if (started || disposed) return;
    started = true;

    try {
      descriptor = await backend.open(
        { id, clientId: String(doc.clientID), schemaVersion: 1 },
        { signal: abort.signal },
      );

      if (disposed) {
        void backend.close({ sessionId: descriptor.sessionId }).catch(() => undefined);

        return;
      }

      let recovery: CollaborationRecovery | null = null;

      if (journal) {
        try {
          recovery = await journal.load();
        } catch {
          // Never replace a retained draft we could not read with a new editor's empty journal.
          journalUnreadable = true;
          blocked = true;
          publish({
            recoveryError: true,
            error: "Device recovery could not be read. Retained work has not been overwritten.",
          });
        }
      }

      if (disposed) {
        journal?.dispose?.();

        return;
      }

      if (recovery) {
        Y.applyUpdate(doc, decodeCollaborationBytes(recovery.state), remote);
        pending = [decodeCollaborationBytes(recovery.pending)];

        if (
          recovery.generation !== descriptor.generation ||
          Date.now() - recovery.updatedAt > 24 * 60 * 60 * 1000
        ) {
          blocked = true;
          // The old branch remains the visible/exportable document. Do not merge it into a new head.
          publish({
            document: descriptor,
            status: "blocked",
            hasUnsavedChanges: true,
            error:
              "Recovered work needs review. Export this version before opening the current note.",
          });
        }
      }

      if (!blocked || recovery === null)
        Y.applyUpdate(doc, decodeCollaborationBytes(descriptor.state), remote);
      awareness = new Awareness(doc);
      awareness.setLocalStateField("user", { name: descriptor.name, color: descriptor.color });
      doc.on("update", changed);
      publish({
        document: descriptor,
        writable: descriptor.writable && !blocked,
        status: blocked ? "blocked" : pending.length ? "pending" : "saved",
        hasUnsavedChanges: pending.length > 0,
      });
      schedule(0);
    } catch (cause) {
      const error = normalizeClientError(cause);
      publish({
        status: "blocked",
        error:
          error.code === "auth.rateLimited"
            ? "This note is full. Try again in a moment."
            : error.message,
      });
    }
  }

  async function exchange() {
    if (!descriptor || !awareness || disposed || blocked) return;
    // Capture exactly this batch. A receipt for it must not clear edits made during the request.
    const count = pending.length;
    const update = count ? encodeCollaborationBytes(Y.mergeUpdates(pending.slice(0, count))) : "";

    if (update.length > 196608) {
      blocked = true;
      publish({
        status: "blocked",
        writable: false,
        error: "This edit exceeds the sync limit. Export your work before reopening the note.",
      });

      return;
    }

    try {
      const receipt = await backend.sync(
        {
          sessionId: descriptor.sessionId,
          generation: descriptor.generation,
          vector: encodeCollaborationBytes(Y.encodeStateVector(doc)),
          update,
          presence: JSON.stringify({ cursor: awareness.getLocalState()?.cursor ?? null }),
        },
        { signal: abort.signal },
      );

      if (disposed) return;

      if (receipt.acknowledged !== update)
        throw new SDKError("SDK_PROTOCOL", "The server did not acknowledge this edit batch.");
      Y.applyUpdate(doc, decodeCollaborationBytes(receipt.update), remote);
      pending.splice(0, count);
      preserve();
      const present = new Set(receipt.peers.map((peer) => Number(peer.clientId)));

      const gone = [...awareness.getStates().keys()].filter(
        (key) => key !== doc.clientID && !present.has(key),
      );

      removeAwarenessStates(awareness, gone, remote);
      const peerNames: string[] = [];

      for (const peer of receipt.peers) {
        const peerId = Number(peer.clientId);
        const state = Schema.decodeUnknownSync(PeerPresence)(JSON.parse(peer.presence));
        peerNames.push(state.user.name);
        // Awareness is ephemeral, separate from the acknowledged content stream.
        awareness.meta.set(peerId, { clock: ++peerClock, lastUpdated: Date.now() });
        const states = new Map([[peerId, state]]);
        const packet = encodeAwarenessUpdate(awareness, [peerId], states);
        awareness.meta.delete(peerId);
        applyAwarenessUpdate(awareness, packet, remote);
      }

      descriptor = { ...descriptor, sequence: receipt.sequence, writable: receipt.writable };
      publish({
        document: descriptor,
        writable: receipt.writable,
        status: pending.length ? "pending" : "saved",
        hasUnsavedChanges: pending.length > 0,
        error: null,
        peers: peerNames,
      });
    } catch (cause) {
      if (disposed) return;
      const error = normalizeClientError(cause);

      if (error.code === "auth.required") {
        try {
          const next = await backend.open(
            { id, clientId: String(doc.clientID), schemaVersion: 1 },
            { signal: abort.signal },
          );

          if (disposed) {
            void backend.close({ sessionId: next.sessionId }).catch(() => undefined);

            return;
          }

          if (next.generation === descriptor.generation) {
            descriptor = next;
            Y.applyUpdate(doc, decodeCollaborationBytes(next.state), remote);
            publish({
              status: pending.length ? "pending" : "saved",
              writable: next.writable,
              error: null,
            });

            return;
          }

          void backend.close({ sessionId: next.sessionId }).catch(() => undefined);
        } catch {
          /* The original authentication failure remains authoritative. */
        }
      }

      blocked = [
        "access.denied",
        "auth.required",
        "resource.notFound",
        "resource.conflict",
        "input.invalid",
        "storage.quotaExceeded",
      ].includes(error.code);
      publish({
        status: blocked ? "blocked" : "offline",
        writable: !blocked && descriptor.writable,
        error: blocked
          ? `${error.message}. Your local work is retained; export it before reopening.`
          : "Connection interrupted. Your edits will sync when Hyori is reachable.",
        peers: [],
      });
      removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((key) => key !== doc.clientID),
        remote,
      );
    } finally {
      schedule(pending.length ? 500 : 1000);
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    scheduledAt = Infinity;

    if (flight) return flight;
    flight = exchange().finally(() => {
      flight = null;
    });

    return flight;
  }

  return {
    doc,
    get awareness() {
      return awareness;
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void start();

      return () => {
        listeners.delete(listener);
      };
    },
    flush,
    async discardRecovery() {
      await journalWrite;

      if (journal) await journal.save(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      doc.off("update", changed);
      awareness?.destroy();
      doc.destroy();
      listeners.clear();
      onUnsavedChange?.(false);
      // Keep a tab's recovery lease until its last serialized journal write is settled.
      void journalWrite.finally(() => journal?.dispose?.());

      if (descriptor)
        void backend.close({ sessionId: descriptor.sessionId }).catch(() => undefined);
    },
  };
}

export type CollaborationSession = ReturnType<typeof createCollaborationSession>;
