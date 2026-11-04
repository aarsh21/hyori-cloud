import { createContext, use } from "@hyori-cloud/lib/react";

type FolderPath = (folderId: string | null) => string;

const FolderPathContext = createContext<FolderPath | null>(null);

/** Where a folder lives depends on who's browsing: a signed-in library or a public link. */
export const FolderPathProvider = FolderPathContext;

export function useFolderPath(): FolderPath {
  const folderPath = use(FolderPathContext);

  if (folderPath === null) throw new Error("useFolderPath requires FolderPathProvider.");

  return folderPath;
}
