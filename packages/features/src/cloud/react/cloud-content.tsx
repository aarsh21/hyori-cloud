import { File as FileIcon } from "@hyori-cloud/lib/icons";
import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { CloudScreenFallback } from "#features/cloud/react/cloud-screen-fallback.tsx";
import {
  loadAdminScreen,
  loadAlbumScreen,
  loadAlbumsScreen,
  loadFilesScreen,
  loadPhotosScreen,
  loadSharedScreen,
  loadTrashScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";

const FilesScreen = lazy(async () => ({ default: (await loadFilesScreen()).FilesScreen }));
const SharedScreen = lazy(async () => ({ default: (await loadSharedScreen()).SharedScreen }));
const TrashScreen = lazy(async () => ({ default: (await loadTrashScreen()).TrashScreen }));
const PhotosScreen = lazy(async () => ({ default: (await loadPhotosScreen()).PhotosScreen }));
const AlbumsScreen = lazy(async () => ({ default: (await loadAlbumsScreen()).AlbumsScreen }));
const AlbumScreen = lazy(async () => ({ default: (await loadAlbumScreen()).AlbumScreen }));
const AdminScreen = lazy(async () => ({ default: (await loadAdminScreen()).AdminScreen }));

type ShellLocation = Exclude<
  CloudLocation,
  { section: "invite" | "publicShare" | "publicEditor" | "editor" }
>;

function CloudSection({ location }: { location: ShellLocation }) {
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

export function CloudContent({ location }: { location: ShellLocation }) {
  return (
    <Suspense fallback={<CloudScreenFallback location={location} />}>
      <CloudSection location={location} />
    </Suspense>
  );
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
