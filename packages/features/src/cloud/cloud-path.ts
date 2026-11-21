export type CloudLocation =
  | { readonly section: "files"; readonly folderId: string | null }
  | { readonly section: "shared" }
  | { readonly section: "sharedByMe" }
  | { readonly section: "notes"; readonly noteId: string | null }
  | { readonly section: "trash" }
  | { readonly section: "photos" }
  | { readonly section: "albums" }
  | { readonly section: "album"; readonly albumId: string }
  | { readonly section: "admin" }
  | { readonly section: "editor"; readonly fileId: string }
  | { readonly section: "invite"; readonly token: string }
  | { readonly section: "passwordReset"; readonly token: string }
  | { readonly section: "publicShare"; readonly token: string; readonly folderId: string | null }
  | { readonly section: "publicEditor"; readonly token: string; readonly fileId: string }
  | { readonly section: "notFound" };

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseCloudPath(path: string): CloudLocation {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [head, second, third] = segments.map(decodeSegment);

  if (segments.some((segment) => decodeSegment(segment) === null)) {
    return { section: "notFound" };
  }

  if (segments.length === 0) return { section: "files", folderId: null };

  if (head === "folders" && second && segments.length === 2) {
    return { section: "files", folderId: second };
  }

  if (head === "shared" && segments.length === 1) return { section: "shared" };

  if (head === "shared" && second === "by-me" && segments.length === 2) {
    return { section: "sharedByMe" };
  }

  if (head === "notes" && segments.length <= 2) return { section: "notes", noteId: second ?? null };

  if (head === "trash" && segments.length === 1) return { section: "trash" };

  if (head === "photos" && segments.length === 1) return { section: "photos" };

  if (head === "photos" && second === "albums" && segments.length === 2) {
    return { section: "albums" };
  }

  if (head === "photos" && second === "albums" && third && segments.length === 3) {
    return { section: "album", albumId: third };
  }

  if (head === "admin" && segments.length === 1) return { section: "admin" };

  if (head === "edit" && second && segments.length === 2) {
    return { section: "editor", fileId: second };
  }

  if (head === "invite" && second && segments.length === 2) {
    return { section: "invite", token: second };
  }

  if (head === "reset-password" && second && segments.length === 2) {
    return { section: "passwordReset", token: second };
  }

  if (head === "share" && second && third === "edit" && segments.length === 4) {
    const fileId = decodeSegment(segments[3] ?? "");

    if (fileId) return { section: "publicEditor", token: second, fileId };
  }

  if (head === "share" && second && segments.length <= 3) {
    return { section: "publicShare", token: second, folderId: third ?? null };
  }

  return { section: "notFound" };
}

export function formatCloudPath(location: CloudLocation): string {
  switch (location.section) {
    case "files":
      return location.folderId === null ? "/" : `/folders/${encodeURIComponent(location.folderId)}`;
    case "shared":
      return "/shared";
    case "sharedByMe":
      return "/shared/by-me";
    case "notes":
      return location.noteId === null ? "/notes" : `/notes/${encodeURIComponent(location.noteId)}`;
    case "trash":
      return "/trash";
    case "photos":
      return "/photos";
    case "albums":
      return "/photos/albums";
    case "album":
      return `/photos/albums/${encodeURIComponent(location.albumId)}`;
    case "admin":
      return "/admin";
    case "editor":
      return `/edit/${encodeURIComponent(location.fileId)}`;
    case "invite":
      return `/invite/${encodeURIComponent(location.token)}`;
    case "passwordReset":
      return `/reset-password/${encodeURIComponent(location.token)}`;
    case "publicShare": {
      const base = `/share/${encodeURIComponent(location.token)}`;

      return location.folderId === null ? base : `${base}/${encodeURIComponent(location.folderId)}`;
    }

    case "publicEditor":
      return `/share/${encodeURIComponent(location.token)}/edit/${encodeURIComponent(location.fileId)}`;
    case "notFound":
      return "/";
  }

  location satisfies never;

  return "/";
}
