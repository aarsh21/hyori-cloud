import type { ClientError } from "@hyori-cloud/client-sdk";

export type CloudError = ClientError;

export type CloudErrorCode = CloudError["code"];

export type ErrorCopy = { readonly title: string; readonly detail?: string };

// Keyed by the declared union, so a new API failure fails typechecking here until it has copy.
const COPY: Record<CloudErrorCode, ErrorCopy> = {
  "auth.required": { title: "Your session has ended", detail: "Sign in again to continue." },
  "auth.invalidCredentials": { title: "That email and password don’t match" },
  "auth.setupDenied": {
    title: "That setup token wasn’t accepted",
    detail: "Check the token on your server, or sign in if setup has already finished.",
  },
  "auth.rateLimited": { title: "Too many attempts", detail: "Wait a moment and try again." },
  "auth.signInBusy": {
    title: "Sign-in is busy right now",
    detail: "Lots of people are signing in. Try again in a moment.",
  },
  "access.denied": { title: "You don’t have access to this" },
  "input.invalid": { title: "That doesn’t look right" },
  "resource.notFound": {
    title: "This is no longer here",
    detail: "It may have been moved, deleted, or unshared.",
  },
  "resource.conflict": {
    title: "That couldn’t be applied",
    detail: "It conflicts with something that already exists or just changed.",
  },
  "uploads.limitReached": {
    title: "Too many unfinished uploads",
    // Upload rows show only the detail, so it carries the reason as well as the way out.
    detail:
      "You’ve reached the limit on unfinished uploads. Cancel some in Unfinished uploads, in your account menu, then try again.",
  },
  "uploads.busy": {
    title: "Uploads are busy",
    detail: "Wait for a running transfer to finish, then try again.",
  },
  "storage.quotaExceeded": {
    title: "Not enough storage",
    detail: "Free up space or ask your admin for a larger quota.",
  },
  "service.unavailable": {
    title: "Hyori can’t reach its services",
    detail: "Your files are safe. Try again in a moment.",
  },
  SDK_TRANSPORT: {
    title: "Can’t reach the server",
    detail: "Check your connection and try again.",
  },
  SDK_PROTOCOL: {
    title: "The server sent an unexpected response",
    detail: "Reload the page. If this continues, the app and server may be out of date.",
  },
  SDK_VALIDATION: { title: "That doesn’t look right" },
  SDK_CANCELLED: { title: "Cancelled" },
  SDK_DISPOSED: { title: "This session has closed", detail: "Reload the page to continue." },
  SDK_FILE_MISMATCH: {
    title: "That isn’t the same file",
    detail: "Choose the file you originally started uploading.",
  },
};

/** This person can no longer see the item, so anything fetched earlier shouldn't stay on screen. */
export function endsItemAccess(error: CloudError): boolean {
  return (
    error.code === "auth.required" ||
    error.code === "access.denied" ||
    error.code === "resource.notFound"
  );
}

export function describeCloudError(error: CloudError): ErrorCopy {
  return COPY[error.code];
}
