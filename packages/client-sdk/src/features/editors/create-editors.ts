import type { EditorDestination } from "@hyori-cloud/api/rpc";
import { normalizeClientError, SDKError } from "#client-sdk/errors";
import type { InputOf } from "#client-sdk/inference";
import type { RPC } from "#client-sdk/product-types";
import type { createUploads } from "#client-sdk/features/uploads/upload";
import type { UploadTask } from "#client-sdk/features/uploads/upload";
import type {
  EditorBackendPort,
  EditorDocument,
  EditorOutput,
  EditorSaveResult,
  EditorStopReason,
} from "#client-sdk/features/editors/editor-contract";
import { hashEditorBytes, readEditorBytes } from "#client-sdk/features/editors/editor-bytes";
import {
  copyEditorBytes,
  validateEditorDocument,
} from "#client-sdk/features/editors/editor-protocol";

export type EditorBackendOptions = InputOf<RPC["editors"]["open"]> & {
  /** An explicitly selected fixed destination, never an inferred source/root fallback. */
  readonly destination?: EditorDestination;
  /** Browser hosts may supply only the user choice; authorization/workflows stay on the server. */
  readonly chooseDestination?: (
    output: Pick<EditorOutput, "name" | "intent">,
    options: { signal: AbortSignal },
  ) => Promise<EditorDestination | null>;
};

function saveFailure(
  cause: unknown,
  intent: EditorOutput["intent"],
): Exclude<EditorSaveResult, { status: "saved" }> {
  const error = normalizeClientError(cause);

  switch (error.code) {
    case "resource.conflict":
      return intent === "replace"
        ? {
            status: "conflict",
            message: "The server reported a save conflict; recovery bytes are retained.",
          }
        : {
            status: "conflict",
            message:
              "The copy wasn't saved: that folder already has a file with this name, or the original changed.",
          };
    case "access.denied":
      // Replacement needs Edit; a session that can still read may keep working on copies.
      return intent === "replace"
        ? { status: "read-only", message: "You can no longer edit this file. Save a copy instead." }
        : { status: "read-only", message: "You can't save a copy to that folder." };
    case "auth.required":
      return {
        status: "access-ended",
        reason: "access-revoked",
        message: "The editor session or its current access is no longer available.",
      };
    case "resource.notFound":
      // Expiry, closure and a removed file all remove the session; none can save again.
      return {
        status: "access-ended",
        reason: "session-ended",
        message: "This editing session has ended. Download your changes and reopen the file.",
      };
    default:
      return {
        status: "failed",
        message: "Could not confirm the save; retry uses the same save ID and retained bytes.",
      };
  }
}

/** Classifies why opening failed from the server's error code, never from its prose. */
export function editorOpenFailure(cause: unknown): EditorStopReason {
  const error = normalizeClientError(cause);

  switch (error.code) {
    case "input.invalid":
      return "unsupported";
    case "resource.conflict":
      return "session-limit";
    case "service.unavailable":
      return "unavailable";
    case "auth.required":
    case "access.denied":
    case "resource.notFound":
      return "access-revoked";
    case "SDK_PROTOCOL":
      return "unsupported";
    default:
      return "network";
  }
}

export function createEditors(
  rpc: RPC["editors"],
  uploads: Pick<ReturnType<typeof createUploads>, "resume">,
  request: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const lifetime = new AbortController();
  const closers = new Set<() => Promise<void>>();

  function reportCloseFailure() {
    console.error("Editor session cleanup could not be confirmed; server expiry remains active.");
  }

  function signalFor(signal: AbortSignal) {
    if (lifetime.signal.aborted)
      throw new SDKError("SDK_DISPOSED", "This editor client has been disposed.");
    const combined = AbortSignal.any([signal, lifetime.signal]);

    if (combined.aborted)
      throw new SDKError("SDK_CANCELLED", "The editor operation was cancelled.");

    return combined;
  }

  return {
    backend(options: EditorBackendOptions) {
      if (options.destination && options.chooseDestination)
        throw new SDKError("SDK_VALIDATION", "Supply one explicit destination capability.");
      const id = options.id;

      const fixedDestination = options.destination
        ? Object.freeze({ ...options.destination })
        : undefined;

      const chooseDestination = options.chooseDestination;
      let document: EditorDocument | null = null;
      let opening: Promise<EditorDocument> | null = null;
      let saving = false;
      let retired = false;
      let unconfirmedPublication = false;
      let closeRequest: Promise<void> | null = null;

      function release() {
        if (!document || saving || unconfirmedPublication) return Promise.resolve();

        closeRequest ??= rpc
          .close({ sessionId: document.sessionId }, { keepalive: true })
          .then(() => {
            closers.delete(close);
          });

        return closeRequest;
      }

      async function close() {
        retired = true;

        if (document) return release();

        if (opening) {
          try {
            await opening;
          } catch {
            closers.delete(close);

            return;
          }

          return release();
        }

        closers.delete(close);
      }

      closers.add(close);
      let chosen: { saveId: string; destination: EditorDestination } | null = null;

      return {
        close,
        async open({ signal }) {
          if (retired) throw new SDKError("SDK_DISPOSED", "This editor attachment has closed.");
          const currentSignal = signalFor(signal);

          if (!opening) {
            opening = rpc
              .open({ id }, { signal: currentSignal })
              .then((result) => {
                validateEditorDocument(result, 64 * 1024 * 1024);
                document = Object.freeze({
                  ...result,
                  outputFormats: Object.freeze(
                    result.outputFormats.map((format) => Object.freeze({ ...format })),
                  ),
                });

                return document;
              })
              .catch((cause) => {
                opening = null;
                throw cause;
              });
          }

          return opening;
        },
        async download(input, { signal }) {
          if (retired) throw new SDKError("SDK_DISPOSED", "This editor attachment has closed.");
          const currentSignal = signalFor(signal);

          if (!document || input.sessionId !== document.sessionId)
            throw new SDKError(
              "SDK_VALIDATION",
              "The download does not belong to this editor attachment.",
            );

          const descriptor = await rpc.download(
            { sessionId: input.sessionId, expectedRevision: input.revision },
            { signal: currentSignal },
          );

          const response = await request(descriptor.url, { signal: currentSignal });

          return readEditorBytes(response, descriptor.size, document.maxBytes, currentSignal);
        },
        async save(input, { signal }) {
          if (saving)
            return {
              status: "failed",
              message: "Another save is still pending in this attachment.",
            };

          if (retired || !document || input.sessionId !== document.sessionId)
            return {
              status: "access-ended",
              message: "The save does not belong to this editor attachment.",
            };
          saving = true;
          let task: UploadTask | null = null;

          try {
            const currentSignal = signalFor(signal);

            // Automatic admission cannot trigger a local destination dialog, even for a bad caller.
            if (input.saveMode === "automatic" && input.output.intent !== "replace")
              return {
                status: "failed",
                message:
                  "Automatic saving requires a source replacement; choose copies explicitly.",
              };

            const extension = input.output.name
              .slice(input.output.name.lastIndexOf("."))
              .toLowerCase();

            const format = document.outputFormats.find(
              (candidate) => candidate.extension === extension,
            );

            if (!format)
              return {
                status: "failed",
                message: "This output format is not authorized by the open descriptor.",
              };

            const bytes = copyEditorBytes(
              input.output.bytes,
              Math.min(format.maxBytes ?? document.maxBytes, document.maxBytes),
            );

            if (!bytes)
              return {
                status: "failed",
                message: "The editor output is empty, shared or larger than its declared limit.",
              };
            let destination = fixedDestination;

            if (input.output.intent !== "replace" && !destination) {
              if (chosen?.saveId === input.saveId) destination = chosen.destination;
              else if (chooseDestination) {
                const selected = await chooseDestination(
                  { name: input.output.name, intent: input.output.intent },
                  { signal: currentSignal },
                );

                currentSignal.throwIfAborted();

                if (selected) {
                  destination = Object.freeze({ ...selected });
                  chosen = { saveId: input.saveId, destination };
                }
              }

              if (!destination)
                return {
                  status: "cancelled",
                  message: "No folder was chosen, so the copy wasn't saved.",
                };
            }

            const sha256 = await hashEditorBytes(bytes, currentSignal);

            const basePreparation: Omit<InputOf<RPC["editors"]["prepareSave"]>, "destination"> = {
              sessionId: input.sessionId,
              saveId: input.saveId,
              expectedRevision: input.expectedRevision,
              name: input.output.name,
              size: bytes.byteLength,
              sha256,
              intent: input.output.intent,
            };

            const preparation =
              input.saveMode === undefined
                ? basePreparation
                : { ...basePreparation, saveMode: input.saveMode };

            const payload =
              input.output.intent !== "replace" && destination
                ? { ...preparation, destination }
                : preparation;

            const prepared = await rpc.prepareSave(payload, { signal: currentSignal });
            const blob = new Blob([bytes], { type: "application/octet-stream" });

            const file = {
              name: input.output.name,
              size: blob.size,
              type: blob.type,
              lastModified: 0,
              slice: (start?: number, end?: number) => blob.slice(start, end),
            };

            const intent =
              input.output.intent === "replace"
                ? {
                    kind: "replacement" as const,
                    name: document.replacementName ?? input.output.name,
                    targetId: id,
                  }
                : { kind: "new" as const, name: input.output.name };

            // Once transfer starts, a lost reply may hide publication. Only confirmed completion
            // releases that uncertainty; disposal must not delete the stable save's replay state.
            unconfirmedPublication = true;
            task = uploads.resume(
              {
                checkpoint: {
                  version: 2,
                  uploadId: prepared.uploadId,
                  file: { name: file.name, size: file.size, type: file.type, lastModified: 0 },
                  intent,
                },
                file,
                confirmSameFile: true,
              },
              { signal: currentSignal },
            );
            await task.result;

            const saved = await rpc.completeSave(
              { sessionId: input.sessionId, saveId: input.saveId },
              { signal: currentSignal },
            );

            unconfirmedPublication = false;

            return saved;
          } catch (cause) {
            const failure = saveFailure(cause, input.output.intent);

            // Denial means a lost Edit (still readable: keep working on copies) or lost access
            // altogether (a revoked link, say). Only the server can tell; a Read-only probe asks.
            if (
              failure.status === "read-only" &&
              input.output.intent === "replace" &&
              !lifetime.signal.aborted
            ) {
              const readable = await rpc
                .download(
                  { sessionId: input.sessionId, expectedRevision: input.expectedRevision },
                  { signal: lifetime.signal },
                )
                .then(
                  () => true,
                  (probe) => normalizeClientError(probe).code === "resource.conflict",
                );

              if (!readable)
                return {
                  status: "access-ended",
                  reason: "access-revoked",
                  message: "The editor session or its current access is no longer available.",
                };
            }

            // An unavailable save stays retryable. A newer current version is no evidence against
            // this one: the server keeps saving verified legacy sessions, and only a response
            // about this session itself (handled above) ends it.
            return failure;
          } finally {
            task?.dispose();
            saving = false;

            if (retired) void release().catch(reportCloseFailure);
          }
        },
      } satisfies EditorBackendPort;
    },
    dispose() {
      for (const close of closers) void close().catch(reportCloseFailure);
      closers.clear();
      lifetime.abort();
    },
  };
}
