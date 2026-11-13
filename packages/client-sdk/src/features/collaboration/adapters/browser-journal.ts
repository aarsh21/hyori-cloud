import { Schema } from "@hyori-cloud/lib/effect";
import type { CollaborationJournal } from "../../../collaboration.ts";

const Recovery = Schema.Struct({
  generation: Schema.String,
  state: Schema.String,
  pending: Schema.String,
  updatedAt: Schema.Number,
});

/** Authenticated accounts retain pending edits locally. Public/anonymous notes never call this
 * adapter. IndexedDB transactions retain the previous journal if writing the next one fails.
 */
export function createBrowserCollaborationJournal(
  accountId: string,
  noteId: string,
): CollaborationJournal {
  let recordKey: Promise<string> | undefined;
  let release: (() => void) | undefined;
  let disposed = false;

  async function claim(candidate: string) {
    return new Promise<boolean>((resolve, reject) => {
      void navigator.locks
        .request(`hyori-note:${candidate}`, { ifAvailable: true }, (lock) => {
          if (!lock || disposed) {
            resolve(false);

            return;
          }

          return new Promise<void>((unlock) => {
            release = unlock;
            resolve(true);
          });
        })
        .catch(reject);
    });
  }

  async function acquireKey() {
    // Duplicating a tab copies sessionStorage. An exclusive lease detects that copy so the
    // second tab cannot overwrite the first tab's pending work; reload can reclaim a released key.
    let tab = sessionStorage.getItem("hyori-note-tab");

    while (!disposed) {
      tab ??= crypto.randomUUID();
      const candidate = `${accountId}:${noteId}:blocknote-1:${tab}`;

      if (await claim(candidate)) {
        sessionStorage.setItem("hyori-note-tab", tab);

        return candidate;
      }

      tab = crypto.randomUUID();
    }

    throw new Error("Note recovery was closed.");
  }

  function key() {
    return (recordKey ??= acquireKey());
  }

  async function store<Value>(
    mode: IDBTransactionMode,
    operation: (table: IDBObjectStore) => IDBRequest<Value>,
  ): Promise<Value> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("hyori-note-recovery", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("journals");
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      return await new Promise<Value>((resolve, reject) => {
        const tx = db.transaction("journals", mode);
        const request = operation(tx.objectStore("journals"));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    async load() {
      const id = await key();
      const value: unknown = await store("readonly", (table) => table.get(id));

      return value === undefined ? null : Schema.decodeUnknownSync(Recovery)(value);
    },
    async save(value) {
      if (value && value.state.length + value.pending.length > 4 * 1024 * 1024)
        throw new Error("Note recovery storage is full.");

      const id = await key();

      if (value === null) await store("readwrite", (table) => table.delete(id));
      else await store("readwrite", (table) => table.put(value, id));
    },
    dispose() {
      disposed = true;
      release?.();
    },
  };
}
