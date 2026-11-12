import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError, ErrorCopy } from "#features/shared/cloud-error.ts";

export const NEW_PASSWORD_HINT =
  "At least 12 characters. A few unrelated words are strong and easy to remember.";

const TOO_SHORT = "Use at least 12 characters.";

const RATE_LIMITED: ErrorCopy = {
  title: "Too many attempts",
  detail: "Wait up to 15 minutes, then try again.",
};

/** Counted as the server counts, in characters rather than UTF-16 units, so the two never disagree. */
export function newPasswordProblem(password: string): string | null {
  return Array.from(password).length < 12 ? TOO_SHORT : null;
}

// A reply lost in transit says nothing about the outcome: the change may have committed.
function unconfirmed(error: CloudError) {
  return error.code === "SDK_TRANSPORT" || error.code === "SDK_PROTOCOL";
}

export function describeChangePasswordError(error: CloudError): ErrorCopy {
  if (unconfirmed(error)) {
    return {
      title: "Couldn’t confirm the change",
      detail:
        "Your password may already be the new one. If your current password stops working, use the new one.",
    };
  }

  if (error.code === "auth.invalidCredentials") {
    return { title: "Your current password wasn’t accepted. Try again." };
  }

  if (error.code === "auth.rateLimited") return RATE_LIMITED;

  if (error.code === "input.invalid" || error.code === "SDK_VALIDATION") {
    return { title: "Check your passwords", detail: TOO_SHORT };
  }

  return describeCloudError(error);
}

export function describeResetPasswordError(error: CloudError): ErrorCopy {
  if (unconfirmed(error)) {
    return {
      title: "Couldn’t confirm the new password",
      detail:
        "It may already be set. Try signing in with it, or ask your administrator for a new link.",
    };
  }

  return error.code === "auth.rateLimited" ? RATE_LIMITED : describeCloudError(error);
}

export const INVALID_RESET_LINK =
  "This link is invalid, expired, or already used. Ask your administrator for a new one.";

/**
 * Used, expired, replaced and deleted-account links are refused alike. The length is checked before
 * sending, so a refused input is the link itself.
 */
export function isUnusableResetLink(error: CloudError): boolean {
  return (
    error.code === "access.denied" ||
    error.code === "input.invalid" ||
    error.code === "SDK_VALIDATION"
  );
}

export function describeResetLinkError(error: CloudError): ErrorCopy {
  if (unconfirmed(error)) {
    return {
      title: "Couldn’t confirm a link was created",
      detail: "Create another link. It replaces any link that was just made.",
    };
  }

  if (error.code === "access.denied") {
    return {
      title: "This account can’t be reset",
      detail: "It may have been deleted, or you may no longer be an administrator. Reload Users.",
    };
  }

  return describeCloudError(error);
}
