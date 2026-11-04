import type { ShareRole } from "@hyori-cloud/client-sdk";

export const SHARE_ROLE_LABELS: Record<ShareRole, string> = {
  viewer: "Viewer",
  contributor: "Contributor",
  editor: "Editor",
};

export const SHARE_ROLE_DESCRIPTIONS: Record<ShareRole, string> = {
  viewer: "View and download",
  contributor: "View, download, and upload new files",
  editor: "Everything above, plus change existing files",
};

export const SHARE_ROLES: readonly ShareRole[] = ["viewer", "contributor", "editor"];
