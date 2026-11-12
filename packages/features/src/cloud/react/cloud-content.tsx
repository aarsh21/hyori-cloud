import { Cloud, File as FileIcon } from "@hyori-cloud/lib/icons";
import { onlineManager } from "@hyori-cloud/lib/query-core";
import { Component, lazy, Suspense, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { useRetryOnReconnect } from "@hyori-cloud/ui/hooks/use-retry-on-reconnect";
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

function createScreens() {
  // React.lazy retains rejected promises. A retry needs new wrappers, not just a boundary reset.
  return {
    FilesScreen: lazy(async () => ({ default: (await loadFilesScreen()).FilesScreen })),
    SharedScreen: lazy(async () => ({ default: (await loadSharedScreen()).SharedScreen })),
    TrashScreen: lazy(async () => ({ default: (await loadTrashScreen()).TrashScreen })),
    PhotosScreen: lazy(async () => ({ default: (await loadPhotosScreen()).PhotosScreen })),
    AlbumsScreen: lazy(async () => ({ default: (await loadAlbumsScreen()).AlbumsScreen })),
    AlbumScreen: lazy(async () => ({ default: (await loadAlbumScreen()).AlbumScreen })),
    AdminScreen: lazy(async () => ({ default: (await loadAdminScreen()).AdminScreen })),
  };
}

type ShellLocation = Exclude<
  CloudLocation,
  { section: "invite" | "publicShare" | "publicEditor" | "editor" }
>;

function CloudSection({
  location,
  screens,
}: {
  location: ShellLocation;
  screens: ReturnType<typeof createScreens>;
}) {
  const {
    FilesScreen,
    SharedScreen,
    TrashScreen,
    PhotosScreen,
    AlbumsScreen,
    AlbumScreen,
    AdminScreen,
  } = screens;

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

type CloudContentState = ({ phase: "screen" } | { phase: "failed"; error: Error }) & {
  screens: ReturnType<typeof createScreens>;
};

/** Screen-code failures must not dispose the shell, navigation or upload queue. */
export class CloudContent extends Component<{ location: ShellLocation }, CloudContentState> {
  override state: CloudContentState = {
    phase: "screen",
    screens: createScreens(),
  };

  static getDerivedStateFromError(error: Error): Partial<CloudContentState> {
    return { phase: "failed", error };
  }

  retry = () => {
    this.setState({ phase: "screen", screens: createScreens() });
  };

  override render() {
    const { location } = this.props;

    switch (this.state.phase) {
      case "failed":
        return <ScreenLoadFailure error={this.state.error} onRetry={this.retry} />;
      case "screen":
        return (
          <Suspense fallback={<CloudScreenFallback location={location} />}>
            <CloudSection location={location} screens={this.state.screens} />
          </Suspense>
        );
    }

    this.state satisfies never;

    return null;
  }
}

function ScreenLoadFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const [offlineFailure] = useState(
    () =>
      !onlineManager.isOnline() &&
      /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
        error.message,
      ),
  );

  useRetryOnReconnect(offlineFailure, onRetry);

  // Online chunk failures (including stale deployments) and unrelated render errors still reach
  // the host's existing error screen. Only a failed offline import is recoverable in this region.
  if (!offlineFailure) throw error;

  return (
    <RegionState
      role="status"
      icon={<Cloud />}
      title="You’re offline"
      description="This screen couldn’t load without a connection. We’ll retry when you’re online."
      action={
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
    />
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
