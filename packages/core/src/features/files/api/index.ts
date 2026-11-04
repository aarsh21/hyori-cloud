import type {
  CreateFolder,
  DownloadInput,
  ItemInput,
  ListFiles,
  ListVersions,
  MoveFile,
  RenameFile,
  RestoreVersion,
} from "#core/features/files/api/schema";
import { FilesService } from "#core/features/files/service";
import type { RequestContext } from "#core/runtime";

export function filesHandlers(context: RequestContext) {
  const service = new FilesService(context);

  return {
    "files.list": (input: typeof ListFiles.Type) => service.list(input),
    "files.createFolder": (input: typeof CreateFolder.Type) => service.createFolder(input),
    "files.rename": (input: typeof RenameFile.Type) => service.rename(input),
    "files.move": (input: typeof MoveFile.Type) => service.move(input),
    "files.trash": (input: typeof ItemInput.Type) => service.trash(input),
    "files.restore": (input: typeof ItemInput.Type) => service.restore(input),
    "files.versions": (input: typeof ListVersions.Type) => service.versions(input),
    "files.restoreVersion": (input: typeof RestoreVersion.Type) => service.restoreVersion(input),
    "files.download": (input: typeof DownloadInput.Type) => service.download(input),
  };
}
