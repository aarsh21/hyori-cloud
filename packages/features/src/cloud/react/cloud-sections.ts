import { Files, Images, NotebookPen, Share2, Trash2 } from "@hyori-cloud/lib/icons";
import type { LucideIcon } from "@hyori-cloud/lib/icons";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";

export type CloudSection = {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly location: CloudLocation;
  readonly isCurrent: (location: CloudLocation) => boolean;
};

export const CLOUD_SECTIONS: readonly CloudSection[] = [
  {
    label: "Files",
    icon: Files,
    location: { section: "files", folderId: null },
    isCurrent: (location) => location.section === "files",
  },
  {
    label: "Photos",
    icon: Images,
    location: { section: "photos" },
    isCurrent: (location) =>
      location.section === "photos" ||
      location.section === "albums" ||
      location.section === "album",
  },
  {
    label: "Notes",
    icon: NotebookPen,
    location: { section: "notes", noteId: null },
    isCurrent: (location) => location.section === "notes",
  },
  {
    label: "Shared",
    icon: Share2,
    location: { section: "shared" },
    isCurrent: (location) => location.section === "shared",
  },
  {
    label: "Trash",
    icon: Trash2,
    location: { section: "trash" },
    isCurrent: (location) => location.section === "trash",
  },
];
