import { Share2 } from "@hyori-cloud/lib/icons";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { FileBrowser } from "#features/files/react/file-browser.tsx";

function sharedFolderPath(folderId: string | null) {
  return folderId === null
    ? formatCloudPath({ section: "shared" })
    : formatCloudPath({ section: "files", folderId });
}

export function SharedScreen() {
  return (
    <FileBrowser
      parentId={null}
      view="shared"
      rootLabel="Shared with me"
      rootSearchScope="shared items"
      rootCanUpload={false}
      folderPath={sharedFolderPath}
      empty={() => (
        <RegionState
          icon={<Share2 />}
          title="Nothing shared with you yet"
          description="Files and folders other people share with your account appear here."
        />
      )}
    />
  );
}
