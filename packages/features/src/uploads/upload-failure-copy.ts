import { getUploadFailure } from "@hyori-cloud/client-sdk";
import type { UploadFailure, UploadIntent } from "@hyori-cloud/client-sdk";
import type { CloudError } from "#features/shared/cloud-error.ts";

type ErrorCopy = { readonly title: string; readonly detail?: string };

/**
 * A client-side failure doesn't say what the server did: a commit can succeed and its reply be lost.
 * So none of this claims the file did or didn't change, or why a conflict happened, because a
 * conflict can be about a name, a revision, a destination, or a lease. Retrying reconciles an upload
 * by its own ID and can't publish it twice.
 */
// Keyed by the SDK's declared union, so a new failure meaning fails typechecking here until it has copy.
const FAILURE_COPY: Record<
  UploadFailure,
  (message: string) => { readonly detail: string; readonly canRetry: boolean }
> = {
  "replacement-conflict": () => ({
    detail:
      "The server reported a conflict, so this new version can’t continue. Cancel it, check the file, and start again if you still need to.",
    canRetry: false,
  }),
  "replacement-failed": (message) => ({
    detail: `Couldn’t confirm the new version. ${message} Retrying checks whether it saved, so check the file before starting again.`,
    canRetry: true,
  }),
  "upload-conflict": () => ({
    detail:
      "The server reported a conflict, possibly an item with this name or a change to this folder. Check the folder, then try again.",
    canRetry: true,
  }),
  "upload-failed": (message) => ({ detail: message, canRetry: true }),
};

/** What a failed upload means for this intent, which the error's code alone can't say. */
export function describeUploadFailure(intent: UploadIntent, error: CloudError, copy: ErrorCopy) {
  return FAILURE_COPY[getUploadFailure(intent, error)](copy.detail ?? copy.title);
}

/** A cancel that wasn't confirmed is about the cancel, whatever the error was. It may still commit. */
export function describeCancelFailure(error: CloudError, copy: ErrorCopy) {
  const message =
    error.code === "resource.conflict"
      ? "This upload may still finish."
      : (copy.detail ?? copy.title);

  return `Couldn’t confirm the cancellation. ${message}`;
}

// A row reads "cancelled" only once the server confirms the upload aborted, or it never began.
export const NEW_VERSION_CANCELLED = "Cancelled. This new version wasn’t saved.";
