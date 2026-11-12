import { Schema } from "@hyori-cloud/lib/effect";
import type { Client } from "#client-sdk/client";
import type { InputOf } from "#client-sdk/inference";
import type { RequestOptions } from "#client-sdk/operation-catalog";
import { normalizeError, SDKError } from "#client-sdk/errors";
import { confirmUploadAbort, normalizeUploadError } from "#client-sdk/features/uploads/upload";
import {
  checkpointIntent,
  decodeUploadCheckpoint,
  matchesCheckpointFile,
} from "#client-sdk/features/uploads/upload-checkpoint";
import type { UploadCheckpoint } from "#client-sdk/features/uploads/upload-checkpoint";
import type {
  ReplaceUpload,
  UploadFile,
  UploadSnapshot,
  UploadTask,
} from "#client-sdk/features/uploads/upload";
import { UploadIntent } from "#client-sdk/features/uploads/upload-intent";

export type CheckpointStore = {
  readonly read: () => readonly unknown[];
  readonly write: (checkpoints: readonly UploadCheckpoint[]) => void;
};

export type UploadEntry = { readonly intent: UploadIntent } & (
  | {
      readonly state: "waiting";
      readonly id: string;
      readonly file: UploadFile;
      readonly parentId: string | null;
    }
  | {
      readonly state: "started";
      readonly id: string;
      readonly name: string;
      /** A requested retry is waiting for one of this queue's transfer slots. */
      readonly retryQueued: boolean;
      readonly task: UploadTask;
    }
  | {
      readonly state: "interrupted";
      readonly id: string;
      readonly checkpoint: UploadCheckpoint;
      readonly cancelling?: boolean;
      readonly error: ReturnType<typeof normalizeUploadError> | null;
    }
);

export type UploadSummary = {
  readonly total: number;
  readonly active: number;
  readonly failed: number;
  readonly complete: number;
};

const emptyEntries: readonly UploadEntry[] = [];
const emptySummary: UploadSummary = { total: 0, active: 0, failed: 0, complete: 0 };

function running(snapshot: UploadSnapshot): boolean {
  switch (snapshot.status) {
    case "pending":
    case "uploading":
    case "finalizing":
    case "cancelling":
      return true;
    case "paused":
    case "cancelled":
    case "failed":
    case "complete":
      return false;
  }

  snapshot satisfies never;

  return false;
}

function readCheckpoints(store: CheckpointStore): UploadCheckpoint[] {
  const unique = new Set<string>();

  return store.read().flatMap((value) => {
    try {
      const checkpoint = decodeUploadCheckpoint(value);

      if (unique.has(checkpoint.uploadId)) return [];
      unique.add(checkpoint.uploadId);

      return [checkpoint];
    } catch {
      return [];
    }
  });
}

/** File queue, retry admission and checkpoint retention are portable SDK policy, not React state. */
export function createUploadQueue(
  sdkClient: Client,
  store: CheckpointStore,
  options?: { readonly onStored?: () => void | Promise<void> },
) {
  let entries: readonly UploadEntry[] = [];
  let persistenceError: SDKError | null = null;

  try {
    entries = readCheckpoints(store).map((checkpoint) => ({
      state: "interrupted" as const,
      id: checkpoint.uploadId,
      checkpoint,
      intent: Object.freeze(checkpointIntent(checkpoint)),
      error: null,
    }));
  } catch (error) {
    persistenceError = normalizeError(error);
  }

  let summary = emptySummary;
  let sequence = 0;
  let pumping = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const unsubscribes = new Map<string, () => void>();
  const completed = new Set<string>();
  const starts = new Map<string, () => UploadTask>();
  const retries = new Set<string>();
  const pendingCheckpoints = new Map<string, UploadCheckpoint>();
  const cancellations = new Map<string, Promise<void>>();
  const ownedCheckpoints = new Set(entries.map((entry) => entry.id));
  const maxConcurrent = 2;

  const replace = (id: string, value: UploadEntry) => {
    entries = entries.map((entry) => (entry.id === id ? value : entry));
  };

  const find = (id: string) => entries.find((entry) => entry.id === id);

  const assertActive = () => {
    if (disposed) throw new Error("This upload queue is disposed.");
  };

  function persist() {
    const checkpoints = entries.flatMap((entry) => {
      if (entry.state === "interrupted") {
        ownedCheckpoints.add(entry.checkpoint.uploadId);

        return [entry.checkpoint];
      }

      if (entry.state !== "started") {
        const pending = pendingCheckpoints.get(entry.id);

        return pending ? [pending] : [];
      }

      const snapshot = entry.task.getSnapshot();

      if (snapshot.checkpoint) ownedCheckpoints.add(snapshot.checkpoint.uploadId);

      return snapshot.checkpoint &&
        snapshot.status !== "complete" &&
        snapshot.status !== "cancelled"
        ? [snapshot.checkpoint]
        : [];
    });

    try {
      // A detached begin can publish a new ID after this owner was constructed.
      const unowned = readCheckpoints(store).filter(
        (checkpoint) => !ownedCheckpoints.has(checkpoint.uploadId),
      );

      store.write([...unowned, ...checkpoints]);
      persistenceError = null;
    } catch (error) {
      persistenceError = normalizeError(error);
    }
  }

  function publish() {
    if (
      entries.some(
        (entry) => entry.state === "started" && entry.retryQueued !== retries.has(entry.id),
      )
    )
      entries = entries.map((entry) =>
        entry.state === "started" && entry.retryQueued !== retries.has(entry.id)
          ? { ...entry, retryQueued: retries.has(entry.id) }
          : entry,
      );

    let active = 0;
    let failed = 0;
    let complete = 0;

    for (const entry of entries) {
      if (entry.state === "waiting" || retries.has(entry.id)) active++;
      else if (entry.state === "interrupted") {
        if (entry.cancelling) active++;
        else failed++;
      } else {
        const snapshot = entry.task.getSnapshot();

        if (running(snapshot)) active++;

        if (snapshot.status === "failed") failed++;

        if (snapshot.status === "complete") complete++;
      }
    }

    if (
      summary.total !== entries.length ||
      summary.active !== active ||
      summary.failed !== failed ||
      summary.complete !== complete
    )
      summary = { total: entries.length, active, failed, complete };

    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observers do not own queue policy. */
      }
    }
  }

  function remove(id: string) {
    unsubscribes.get(id)?.();
    unsubscribes.delete(id);
    const entry = find(id);

    if (entry?.state === "started") entry.task.dispose();
    completed.delete(id);
    starts.delete(id);
    retries.delete(id);
    pendingCheckpoints.delete(id);
    entries = entries.filter((entry) => entry.id !== id);
  }

  function notifyStored() {
    // Query adapters supply declaration-derived policy; the vanilla queue has no cache dependency.
    try {
      void Promise.resolve(options?.onStored?.()).catch(() => undefined);
    } catch {
      /* Query observers expose refetch failures. */
    }
  }

  function forgetTerminalCheckpoint(uploadId: string) {
    try {
      const latest = readCheckpoints(store);
      const retained = latest.filter((checkpoint) => checkpoint.uploadId !== uploadId);

      if (retained.length !== latest.length) store.write(retained);
    } catch (error) {
      persistenceError = normalizeError(error);
    }
  }

  function settleDetachedTask(id: string, task: UploadTask) {
    const checkpointWasUnknown = task.getSnapshot().checkpoint === null;

    const settled = () => {
      const snapshot = task.getSnapshot();
      const checkpoint = snapshot.checkpoint;

      if (snapshot.status === "complete" && !completed.has(id)) {
        completed.add(id);
        notifyStored();
      }

      if (!checkpoint) return;
      const terminal = snapshot.status === "complete" || snapshot.status === "cancelled";

      if (terminal) {
        forgetTerminalCheckpoint(checkpoint.uploadId);

        return;
      }

      if (!checkpointWasUnknown) return;

      try {
        // Merge only this previously unknown ID, never this owner's old list.
        const latest = readCheckpoints(store);

        if (!latest.some((value) => value.uploadId === checkpoint.uploadId))
          store.write([...latest, checkpoint]);
      } catch (error) {
        persistenceError = normalizeError(error);
      }
    };

    void task.result.then(settled, settled);
    void cancellations.get(id)?.then(settled, settled);
  }

  function observe(id: string, task: UploadTask) {
    unsubscribes.get(id)?.();

    const changed = () => {
      if (disposed) return;

      if (task.getSnapshot().status === "complete" && !completed.has(id)) {
        completed.add(id);

        notifyStored();
      }

      pump();
      persist();
      publish();
    };

    unsubscribes.set(id, task.subscribe(changed));
    void task.result.then(changed, changed);
    changed();
  }

  function pump() {
    if (pumping || disposed) return;
    pumping = true;

    try {
      let active = entries.filter(
        (entry) => entry.state === "started" && running(entry.task.getSnapshot()),
      ).length;

      for (const entry of entries) {
        if (active >= maxConcurrent) break;

        if (cancellations.has(entry.id)) continue;

        if (entry.state === "started" && retries.delete(entry.id)) {
          completed.delete(entry.id);
          void entry.task.retry().then(
            () => {
              pump();
              publish();
            },
            () => {
              pump();
              publish();
            },
          );
          active++;
        } else if (entry.state === "waiting") {
          const start = starts.get(entry.id);

          if (!start) continue;
          starts.delete(entry.id);

          try {
            const task = start();
            pendingCheckpoints.delete(entry.id);
            replace(entry.id, {
              state: "started",
              id: entry.id,
              name: entry.intent.name,
              intent: entry.intent,
              retryQueued: false,
              task,
            });
            observe(entry.id, task);
            active++;
          } catch (error) {
            // A malformed local file/resume is rejected before I/O; preserve recoverable metadata.
            const checkpoint = pendingCheckpoints.get(entry.id);

            if (checkpoint)
              replace(entry.id, {
                state: "interrupted",
                id: entry.id,
                checkpoint,
                intent: entry.intent,
                error: normalizeUploadError(error),
              });
            else entries = entries.filter((current) => current.id !== entry.id);
            pendingCheckpoints.delete(entry.id);
            persistenceError = normalizeError(error);
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  publish();

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    getEntries: () => entries,
    getSummary: () => summary,
    getPersistenceError: () => persistenceError,
    getServerEntries: () => emptyEntries,
    getServerSummary: () => emptySummary,
    /** Discovery works across browsers. A null checkpoint means cancel-only here; resumable
     * entries still require file reselection and explicit same-file confirmation. */
    async listPending(
      input: InputOf<Client["rpc"]["uploads"]["pending"]>,
      options?: RequestOptions,
    ) {
      assertActive();
      const page = await sdkClient.rpc.uploads.pending(input, options);

      // A paginated inventory's omission is not proof of removal. Ask for explicit state
      // only for interrupted rows absent from this page, while the caller is viewing uploads.
      for (const entry of entries) {
        if (
          entry.state !== "interrupted" ||
          entry.cancelling ||
          page.items.some((upload) => upload.uploadId === entry.id)
        )
          continue;
        let gone = false;

        try {
          const status = await sdkClient.rpc.uploads.status({ uploadId: entry.id }, options);
          gone = status.uploadId === entry.id && status.state === "aborted";
        } catch (error) {
          gone = normalizeUploadError(error).code === "resource.notFound";
        }

        // Do not remove a row which resumed or began cancellation during this lookup.
        if (!disposed && gone && find(entry.id) === entry) {
          remove(entry.id);
          persist();
          publish();
        }
      }

      const checkpoints = readCheckpoints(store);

      return {
        ...page,
        items: page.items.map((upload) => ({
          ...upload,
          checkpoint:
            checkpoints.find((checkpoint) => checkpoint.uploadId === upload.uploadId) ?? null,
        })),
      };
    },
    add(files: readonly UploadFile[], parentId: string | null) {
      assertActive();

      for (const file of files) {
        const id = `local-${++sequence}`;
        const intent = Object.freeze({ kind: "new" as const, name: file.name });
        entries = [...entries, { state: "waiting", id, file, parentId, intent }];
        starts.set(id, () => sdkClient.uploads.start({ file, parentId }));
      }

      pump();
      persist();
      publish();
    },
    replace(input: ReplaceUpload) {
      assertActive();
      let intent: UploadIntent;

      try {
        intent = Object.freeze(
          Schema.decodeUnknownSync(UploadIntent)({
            kind: "replacement",
            name: input.target.name,
            targetId: input.target.id,
          }),
        );
      } catch (error) {
        throw new SDKError("SDK_VALIDATION", "The replacement target is invalid.", {
          cause: error,
        });
      }

      const { file, parentId } = input;
      const target = Object.freeze({ id: input.target.id, name: input.target.name });
      const id = `local-${++sequence}`;
      entries = [...entries, { state: "waiting", id, file, parentId, intent }];
      starts.set(id, () => sdkClient.uploads.replace({ file, parentId, target }));
      pump();
      persist();
      publish();
    },
    resume(id: string, file: UploadFile) {
      assertActive();
      const entry = find(id);

      if (entry?.state !== "interrupted" || entry.cancelling || cancellations.has(id)) return;
      // Validate synchronously so a bad reselection never drops the retained checkpoint.
      const checkpoint = entry.checkpoint;
      const matches = matchesCheckpointFile(checkpoint, file);

      if (!matches) {
        replace(id, {
          ...entry,
          error: new SDKError("SDK_FILE_MISMATCH", "Reselect the same original file to resume."),
        });
        publish();

        return;
      }

      pendingCheckpoints.set(id, checkpoint);
      starts.set(id, () => sdkClient.uploads.resume({ checkpoint, file, confirmSameFile: true }));
      replace(id, { state: "waiting", id, file, parentId: null, intent: entry.intent });
      pump();
      persist();
      publish();
    },
    retry(id: string) {
      assertActive();
      const entry = find(id);

      if (
        entry?.state !== "started" ||
        !["failed", "paused"].includes(entry.task.getSnapshot().status)
      )
        return;
      retries.add(id);
      pump();
      publish();
    },
    pause(id: string) {
      retries.delete(id);
      const entry = find(id);

      if (entry?.state === "started") entry.task.pause();
      publish();
    },
    cancel(id: string): Promise<void> {
      assertActive();
      const pending = cancellations.get(id);

      if (pending) return pending;
      const entry = find(id);

      if (!entry) return Promise.resolve();
      retries.delete(id);

      const owner =
        entry.state === "interrupted" ? { ...entry, cancelling: true, error: null } : entry;

      replace(id, owner);

      const cancel = async () => {
        if (owner.state === "started") await owner.task.cancel();
        else {
          const checkpoint =
            owner.state === "interrupted" ? owner.checkpoint : pendingCheckpoints.get(id);

          if (checkpoint) {
            try {
              const confirmed = await confirmUploadAbort(
                sdkClient.rpc.uploads,
                checkpoint.uploadId,
              );

              if (confirmed === "complete") notifyStored();

              if (!disposed && find(id) === owner) remove(id);
              else forgetTerminalCheckpoint(checkpoint.uploadId);
            } catch (error) {
              if (!disposed && find(id) === owner) {
                replace(id, {
                  state: "interrupted",
                  id,
                  checkpoint,
                  intent: owner.intent,
                  cancelling: false,
                  error: normalizeUploadError(error),
                });
              }

              throw error;
            }
          } else if (!disposed && find(id) === owner) remove(id);
        }
      };

      const result = cancel().finally(() => {
        cancellations.delete(id);

        if (!disposed) {
          persist();
          pump();
          publish();
        }
      });

      cancellations.set(id, result);
      publish();

      return result;
    },
    dismiss(id: string) {
      const entry = find(id);

      if (
        pendingCheckpoints.has(id) ||
        entry?.state === "interrupted" ||
        (entry?.state === "started" &&
          !["complete", "cancelled"].includes(entry.task.getSnapshot().status))
      )
        return;
      remove(id);
      pump();
      persist();
      publish();
    },
    clearFinished() {
      for (const entry of entries)
        if (
          entry.state === "started" &&
          ["complete", "cancelled"].includes(entry.task.getSnapshot().status)
        )
          remove(entry.id);
      persist();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;

      for (const entry of entries)
        if (entry.state === "started") {
          settleDetachedTask(entry.id, entry.task);
          entry.task.dispose();
        }

      persist();

      for (const unsubscribe of unsubscribes.values()) unsubscribe();
      unsubscribes.clear();
      listeners.clear();
      starts.clear();
      retries.clear();
    },
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;
