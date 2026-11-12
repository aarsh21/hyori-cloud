import { Schema } from "@hyori-cloud/lib/effect";
import type { RPC } from "#client-sdk/product-types";
import { normalizeClientError, SDKError, type ClientError } from "#client-sdk/errors";
import {
  checkpointIntent,
  decodeUploadCheckpoint,
  matchesCheckpointFile,
  UploadFileFingerprint,
} from "#client-sdk/features/uploads/upload-checkpoint";
import type { UploadCheckpoint } from "#client-sdk/features/uploads/upload-checkpoint";
import type { InputOf, OutputOf } from "#client-sdk/inference";
import { UploadSnapshot } from "#client-sdk/features/uploads/upload-state";
import { UploadIntent } from "#client-sdk/features/uploads/upload-intent";
import { readBinaryRejection } from "#client-sdk/read-binary-rejection";

type UploadRpc = RPC["uploads"];

type BeginInput = InputOf<UploadRpc["begin"]>;

type UploadStatus = OutputOf<UploadRpc["status"]>;

type FileEntry = OutputOf<UploadRpc["complete"]>;

/** A File or a non-browser implementation with bounded Blob slices. No file bytes are persisted. */
export type UploadFile = Pick<File, "name" | "size" | "type" | "lastModified" | "slice">;

type UploadError = ClientError;

export const normalizeUploadError = normalizeClientError;

/** Abort can race with a commit or lose its response; only server-terminal state releases checkpoints. */
export async function confirmUploadAbort(
  rpc: UploadRpc,
  uploadId: UploadStatus["uploadId"],
): Promise<"aborted" | "complete"> {
  let abortFailure: UploadError | null = null;

  try {
    await rpc.abort({ uploadId });
  } catch (error) {
    abortFailure = normalizeUploadError(error);
  }

  const confirmed = await rpc.status({ uploadId }).catch((error) => {
    throw abortFailure ?? error;
  });

  if (confirmed.uploadId !== uploadId)
    throw new SDKError("SDK_PROTOCOL", "The server returned a different upload's status.");

  if (confirmed.state === "aborted" || confirmed.state === "complete") return confirmed.state;
  throw (
    abortFailure ?? new SDKError("SDK_PROTOCOL", "The server did not confirm upload cancellation.")
  );
}

export type { UploadSnapshot } from "#client-sdk/features/uploads/upload-state";

export type UploadOptions = {
  readonly signal?: AbortSignal;
  /** Additional outage attempts per idempotent part/status request. Explicit busy refusals wait separately. */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly onProgress?: (snapshot: UploadSnapshot) => void;
};

export type StartUpload = Omit<BeginInput, "name" | "size" | "mimeType"> & {
  readonly file: UploadFile;
};

export type ReplaceUpload = Omit<StartUpload, "replaceId"> & {
  readonly target: {
    readonly id: NonNullable<BeginInput["replaceId"]>;
    readonly name: BeginInput["name"];
  };
};

export type ResumeUpload = {
  readonly checkpoint: UploadCheckpoint;
  readonly file: UploadFile;
  /** Required after file reselection. Matching metadata cannot prove identical bytes. */
  readonly confirmSameFile: true;
};

export type UploadTask = {
  readonly intent: UploadIntent;
  readonly result: Promise<FileEntry>;
  readonly getSnapshot: () => UploadSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly pause: () => void;
  readonly cancel: () => Promise<void>;
  readonly retry: () => Promise<FileEntry>;
  readonly dispose: () => void;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();

    const onAbort = () => {
      clearTimeout(timer);
      reject(new SDKError("SDK_CANCELLED", "Upload paused or cancelled."));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createUploads(
  rpc: UploadRpc,
  request: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const tasks = new Set<UploadTask>();

  function task(
    input: StartUpload | ReplaceUpload | ResumeUpload,
    options: UploadOptions = {},
  ): UploadTask {
    const file = input.file;
    const resume = "checkpoint" in input ? input : null;
    let checkpoint: UploadCheckpoint | null = null;
    let fingerprint: UploadFileFingerprint;
    let intent: UploadIntent;

    try {
      // Decode copies only metadata: never freeze or serialize a host's File/slice capability.
      fingerprint = Schema.decodeUnknownSync(UploadFileFingerprint)({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      });
      checkpoint = resume ? decodeUploadCheckpoint(resume.checkpoint) : null;
      let requestedIntent: UploadIntent = { kind: "new", name: file.name };

      if (checkpoint) requestedIntent = checkpointIntent(checkpoint);
      else if ("target" in input)
        requestedIntent = {
          kind: "replacement",
          name: input.target.name,
          targetId: input.target.id,
        };
      else if ("replaceId" in input && input.replaceId !== undefined)
        requestedIntent = { kind: "replacement", name: file.name, targetId: input.replaceId };
      intent = Schema.decodeUnknownSync(UploadIntent)(requestedIntent);
      // These values are exposed to observers and durable storage; they must not be retargetable.
      Object.freeze(fingerprint);
      Object.freeze(intent);

      if (checkpoint) {
        Object.freeze(checkpoint.file);

        if (checkpoint.version === 2) Object.freeze(checkpoint.intent);
        Object.freeze(checkpoint);
      }
    } catch (error) {
      throw new SDKError("SDK_VALIDATION", "The upload source, target or checkpoint is invalid.", {
        cause: error,
      });
    }

    if (
      resume &&
      (resume.confirmSameFile !== true || !matchesCheckpointFile(checkpoint!, fingerprint))
    ) {
      throw new SDKError(
        "SDK_FILE_MISMATCH",
        "Reselect and explicitly confirm the same original local file to resume this upload.",
      );
    }

    const retries = options.maxRetries ?? 3;
    const delay = options.retryDelayMs ?? 1000;

    if (
      !Number.isInteger(retries) ||
      retries < 0 ||
      retries > 5 ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 30000
    )
      throw new SDKError("SDK_VALIDATION", "Upload retry bounds are invalid.");

    let snapshot: UploadSnapshot = {
      status: "pending",
      uploadedBytes: 0,
      totalBytes: file.size,
      checkpoint,
      error: null,
      file: null,
    };

    const listeners = new Set<() => void>();
    let controller = new AbortController();
    let running = false;
    let released = false;
    let cancelRequested = false;
    let finalizing = false;
    let completedFile: FileEntry | null = null;
    let cancellation: Promise<void> | null = null;
    let promise: Promise<FileEntry>;

    const publish = (patch: Partial<UploadSnapshot>) => {
      snapshot = Schema.decodeUnknownSync(UploadSnapshot)({ ...snapshot, ...patch });

      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* An observer cannot corrupt the transfer. */
        }
      }

      try {
        options.onProgress?.(snapshot);
      } catch {
        /* An observer cannot corrupt the transfer. */
      }
    };

    const attempt = async <T>(
      run: () => Promise<T>,
      signal: AbortSignal,
      retryOutage = true,
    ): Promise<T> => {
      let outages = 0;
      let busySince: number | null = null;
      let busyWaits = 0;

      for (;;) {
        signal.throwIfAborted();

        try {
          return await run();
        } catch (error) {
          const failure = normalizeUploadError(error);

          if (!signal.aborted && failure.code === "uploads.busy") {
            // The server refused before writing. Outlast its unchanged three-minute lease,
            // without replaying an ambiguous begin/complete or consuming the outage budget.
            busySince ??= performance.now();
            const remaining = 195000 - (performance.now() - busySince);

            if (busyWaits >= 39 || remaining <= 0) throw error;
            busyWaits++;
            await wait(Math.min(5000, remaining), signal);
            continue;
          }

          if (
            signal.aborted ||
            !retryOutage ||
            outages >= retries ||
            (failure.code !== "SDK_TRANSPORT" && failure.code !== "service.unavailable")
          )
            throw error;
          await wait(delay * 2 ** outages++, signal);
        }
      }
    };

    const validateStatus = (status: UploadStatus) => {
      if (
        status.uploadId !== snapshot.checkpoint?.uploadId ||
        !Number.isSafeInteger(status.chunkSize) ||
        status.chunkSize <= 0 ||
        status.chunkSize > 64 * 1024 * 1024 ||
        status.totalParts !== Math.max(1, Math.ceil(file.size / status.chunkSize))
      )
        throw new SDKError("SDK_PROTOCOL", "Invalid upload checkpoint returned by the server.");
      const parts = new Set<number>();
      let acknowledged = 0;

      for (const part of status.parts) {
        const expected = Math.min(
          status.chunkSize,
          Math.max(0, file.size - (part.partNumber - 1) * status.chunkSize),
        );

        if (
          !Number.isInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > status.totalParts ||
          parts.has(part.partNumber) ||
          part.size !== expected
        )
          throw new SDKError(
            "SDK_PROTOCOL",
            "The server returned invalid acknowledged upload parts.",
          );
        parts.add(part.partNumber);
        acknowledged += part.size;
      }

      return { parts, acknowledged };
    };

    const run = async (): Promise<FileEntry> => {
      if (released) throw new SDKError("SDK_DISPOSED", "This upload task has been disposed.");

      if (running) throw new SDKError("SDK_VALIDATION", "This upload is already running.");

      if (cancelRequested)
        throw new SDKError(
          "SDK_CANCELLED",
          "A cancelled upload cannot be retried. Start a new upload.",
        );

      if (completedFile) return completedFile;
      running = true;
      controller = new AbortController();

      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;

      publish({ status: "pending", error: null });

      try {
        signal.throwIfAborted();

        if (!snapshot.checkpoint) {
          if (!("parentId" in input) || intent.kind === "legacy")
            throw new SDKError("SDK_VALIDATION", "A new upload requires a destination.");

          // Do not cancel an ambiguous begin: retain its returned ID before observing local cancellation.
          const begun = await attempt(
            () =>
              rpc.begin({
                parentId: input.parentId,
                replaceId: intent.kind === "replacement" ? intent.targetId : undefined,
                name: intent.name,
                size: fingerprint.size,
                mimeType: fingerprint.type || "application/octet-stream",
              }),
            signal,
            false,
          );

          publish({
            checkpoint: Object.freeze({
              version: 2,
              uploadId: begun.uploadId,
              file: fingerprint,
              intent,
            }),
          });
        }

        const uploadId = snapshot.checkpoint!.uploadId;
        const status = await attempt(() => rpc.status({ uploadId }, { signal }), signal);
        signal.throwIfAborted();

        if (status.state === "aborted")
          throw new SDKError("SDK_CANCELLED", "The server has aborted this upload.");
        const { parts, acknowledged } = validateStatus(status);
        publish({ uploadedBytes: acknowledged, status: "uploading" });

        if (status.state !== "complete") {
          // Serial, bounded slices keep memory and outstanding transfer work independent of file size.
          for (let partNumber = 1; partNumber <= status.totalParts; partNumber++) {
            if (parts.has(partNumber)) continue;
            const start = (partNumber - 1) * status.chunkSize;
            const body = file.slice(start, Math.min(start + status.chunkSize, file.size));
            await attempt(async () => {
              const capability = await rpc.part({ uploadId, partNumber }, { signal });

              const response = await request(capability.url, {
                method: capability.method,
                headers: capability.headers,
                body,
                signal,
              });

              if (!response.ok) {
                if (response.status === 408 || response.status === 429 || response.status >= 500)
                  throw new SDKError("SDK_TRANSPORT", `Upload part failed (${response.status}).`);
                throw await readBinaryRejection(response, signal);
              }
            }, signal);
            publish({ uploadedBytes: snapshot.uploadedBytes + body.size });
          }
        }

        signal.throwIfAborted();
        // Once commit begins, local cancellation cannot retract it. Await the authoritative outcome.
        finalizing = true;
        publish({ status: "finalizing" });
        completedFile = await attempt(() => rpc.complete({ uploadId }), signal, false);
        publish({ status: "complete", file: completedFile, uploadedBytes: file.size });
        tasks.delete(handle);

        return completedFile;
      } catch (error) {
        const failure = signal.aborted
          ? new SDKError("SDK_CANCELLED", "Upload paused or cancelled.", { cause: error })
          : normalizeUploadError(error);

        if (cancelRequested) publish({ status: "cancelling", error: null });
        else publish({ status: signal.aborted ? "paused" : "failed", error: failure });
        throw failure;
      } finally {
        running = false;
        finalizing = false;
      }
    };

    const handle: UploadTask = {
      intent,
      get result() {
        return promise;
      },
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      pause: () => {
        if (!finalizing) controller.abort();
      },
      cancel: () => {
        if (cancellation) return cancellation;

        const cancel = async () => {
          if (finalizing) {
            await promise;

            return;
          }

          if (completedFile || snapshot.status === "cancelled") return;
          cancelRequested = true;
          publish({ status: "cancelling", error: null });
          controller.abort();
          await promise.catch(() => undefined);

          if (snapshot.checkpoint) {
            try {
              const uploadId = snapshot.checkpoint.uploadId;
              const confirmed = await confirmUploadAbort(rpc, uploadId);

              if (confirmed === "complete") {
                completedFile = await rpc.complete({ uploadId });
                publish({
                  status: "complete",
                  file: completedFile,
                  uploadedBytes: file.size,
                  error: null,
                });
                tasks.delete(handle);

                return;
              }
            } catch (error) {
              const failure = normalizeUploadError(error);
              publish({ status: "failed", intent: "cancel", error: failure });
              throw failure;
            }
          }

          publish({ status: "cancelled", error: null });
          tasks.delete(handle);
        };

        cancellation = cancel().finally(() => {
          cancellation = null;
        });

        return cancellation;
      },
      dispose: () => {
        released = true;

        if (!finalizing) controller.abort();
        listeners.clear();
        tasks.delete(handle);
      },
      retry: () => {
        if (running) return promise;

        const retryCancellation = async () => {
          await handle.cancel();

          if (completedFile) return completedFile;
          throw new SDKError("SDK_CANCELLED", "The server confirmed upload cancellation.");
        };

        promise = cancelRequested && !released ? retryCancellation() : run();
        void promise.catch(() => undefined);

        return promise;
      },
    };

    tasks.add(handle);
    promise = run();
    void promise.then(
      () => tasks.delete(handle),
      () => undefined,
    );

    return handle;
  }

  return {
    start: ({ file, parentId, replaceId }: StartUpload, options?: UploadOptions) =>
      task({ file, parentId, replaceId }, options),
    replace: ({ file, parentId, target }: ReplaceUpload, options?: UploadOptions) =>
      task({ file, parentId, target }, options),
    resume: ({ checkpoint, file, confirmSameFile }: ResumeUpload, options?: UploadOptions) =>
      task({ checkpoint, file, confirmSameFile }, options),
    /** Disposal pauses local transfers. It intentionally does not destroy resumable server checkpoints. */
    dispose: () => {
      for (const upload of tasks) upload.dispose();
      tasks.clear();
    },
  };
}
