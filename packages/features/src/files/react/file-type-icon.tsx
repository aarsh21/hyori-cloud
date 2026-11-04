import type { FileEntry } from "@hyori-cloud/client-sdk";
import {
  File as GenericFileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
} from "@hyori-cloud/lib/icons";

const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/vnd.rar",
]);

export function FileTypeIcon({ entry }: { entry: Pick<FileEntry, "kind" | "mimeType"> }) {
  const { kind, mimeType } = entry;

  if (kind === "folder") return <Folder aria-hidden className="fill-folder/25 text-folder" />;

  if (mimeType.startsWith("image/")) return <FileImage aria-hidden />;

  if (mimeType.startsWith("video/")) return <FileVideo aria-hidden />;

  if (mimeType.startsWith("audio/")) return <FileAudio aria-hidden />;

  if (ARCHIVE_TYPES.has(mimeType)) return <FileArchive aria-hidden />;

  if (mimeType.startsWith("text/") || mimeType === "application/pdf")
    return <FileText aria-hidden />;

  return <GenericFileIcon aria-hidden />;
}
