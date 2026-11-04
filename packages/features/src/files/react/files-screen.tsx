import { FolderOpen } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Row } from "@hyori-cloud/ui/components/text";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { FileBrowser } from "#features/files/react/file-browser.tsx";

function libraryFolderPath(folderId: string | null) {
  return formatCloudPath({ section: "files", folderId });
}

const SHARED_ROOT = { label: "Shared with me", path: formatCloudPath({ section: "shared" }) };

export function FilesScreen({ folderId }: { folderId: string | null }) {
  return (
    <FileBrowser
      parentId={folderId}
      view="files"
      rootLabel="Files"
      rootSearchScope="all files"
      foreignRoot={SHARED_ROOT}
      rootCanUpload
      folderPath={libraryFolderPath}
      empty={({ upload, createFolder }) => (
        <RegionState
          icon={<FolderOpen />}
          title={folderId === null ? "No files yet" : "This folder is empty"}
          description={upload ? "Upload something or drop files here." : undefined}
          action={
            upload && createFolder ? (
              <Row className="gap-2">
                <Button onClick={upload}>Upload files</Button>
                <Button variant="outline" onClick={createFolder}>
                  New folder
                </Button>
              </Row>
            ) : undefined
          }
        />
      )}
    />
  );
}
