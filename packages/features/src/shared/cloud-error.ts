import type { ClientError } from "@hyori-cloud/client-sdk";

export type CloudError = ClientError;

export type CloudErrorCode = CloudError["code"];

type ErrorCopy = { readonly title: string; readonly detail?: string };

// Keyed by the declared union, so a new API failure fails typechecking here until it has copy.
const COPY: Record<CloudErrorCode, ErrorCopy> = {
  "auth.required": { title: "Your session has ended", detail: "Sign in again to continue." },
  "auth.invalidCredentials": { title: "That email and password don’t match" },
  "auth.setupDenied": {
    title: "That setup token wasn’t accepted",
    detail: "Check the token on your server, or sign in if setup has already finished.",
  },
  "auth.rateLimited": { title: "Too many attempts", detail: "Wait a moment and try again." },
  "access.denied": { title: "You don’t have access to this" },
  "input.invalid": { title: "That doesn’t look right" },
  "resource.notFound": {
    title: "This is no longer here",
    detail: "It may have been moved, deleted, or unshared.",
  },
  "resource.conflict": { title: "That couldn’t be applied" },
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

// These codes carry a server message written for people about this specific input.
const SPECIFIC_MESSAGES = new Set<CloudErrorCode>([
  "input.invalid",
  "resource.conflict",
  "access.denied",
]);

export function describeCloudError(error: CloudError): ErrorCopy {
  const copy = COPY[error.code];

  if (SPECIFIC_MESSAGES.has(error.code) && error.message !== "") {
    return { title: copy.title, detail: error.message };
  }

  return copy;
}
