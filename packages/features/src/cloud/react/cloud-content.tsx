import { Button } from "@hyori-cloud/ui/components/button";
import { File as FileIcon } from "@hyori-cloud/lib/icons";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { AdminScreen } from "#features/admin/react/admin-screen.tsx";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { FilesScreen } from "#features/files/react/files-screen.tsx";
import { SharedScreen } from "#features/files/react/shared-screen.tsx";
import { TrashScreen } from "#features/files/react/trash-screen.tsx";
import { AlbumScreen } from "#features/photos/react/album-screen.tsx";
import { AlbumsScreen } from "#features/photos/react/albums-screen.tsx";
import { PhotosScreen } from "#features/photos/react/photos-screen.tsx";

type ShellLocation = Exclude<CloudLocation, { section: "invite" | "publicShare" }>;

export function CloudContent({ location }: { location: ShellLocation }) {
  switch (location.section) {
    case "files":
      return <FilesScreen folderId={location.folderId} />;
    case "shared":
      return <SharedScreen />;
    case "trash":
      return <TrashScreen />;
    case "photos":
      return <PhotosScreen />;
    case "albums":
      return <AlbumsScreen />;
    case "album":
      return <AlbumScreen albumId={location.albumId} />;
    case "admin":
      return <AdminScreen />;
    case "notFound":
      return <NotFoundState />;
  }

  location satisfies never;

  return null;
}

function NotFoundState() {
  const navigateTo = useNavigateTo();

  return (
    <RegionState
      icon={<FileIcon />}
      title="This page doesn’t exist"
      action={
        <Button variant="outline" onClick={() => navigateTo({ section: "files", folderId: null })}>
          Go to Files
        </Button>
      }
    />
  );
}
