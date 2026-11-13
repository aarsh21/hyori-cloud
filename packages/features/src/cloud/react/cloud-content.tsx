import { File as FileIcon } from "@hyori-cloud/lib/icons";
import { onlineManager } from "@hyori-cloud/lib/query-core";
import { Component, Suspense, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { useRetryOnReconnect } from "@hyori-cloud/ui/hooks/use-retry-on-reconnect";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { CloudScreenFallback } from "#features/cloud/react/cloud-screen-fallback.tsx";
import {
  forgetFailedScreens,
  loadAdminScreen,
  loadAlbumScreen,
  loadAlbumsScreen,
  loadFilesScreen,
  loadNotesScreen,
  loadPhotosScreen,
  loadSharedScreen,
  loadTrashScreen,
  lazyScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";
import { OfflineState } from "#features/shared/react/offline-state.tsx";

const FilesScreen = lazyScreen(loadFilesScreen, (module) => module.FilesScreen);
const NotesScreen = lazyScreen(loadNotesScreen, (module) => module.NotesScreen);
const SharedScreen = lazyScreen(loadSharedScreen, (module) => module.SharedScreen);
const TrashScreen = lazyScreen(loadTrashScreen, (module) => module.TrashScreen);
const PhotosScreen = lazyScreen(loadPhotosScreen, (module) => module.PhotosScreen);
const AlbumsScreen = lazyScreen(loadAlbumsScreen, (module) => module.AlbumsScreen);
const AlbumScreen = lazyScreen(loadAlbumScreen, (module) => module.AlbumScreen);
const AdminScreen = lazyScreen(loadAdminScreen, (module) => module.AdminScreen);

type ShellLocation = Exclude<
  CloudLocation,
  { section: "invite" | "passwordReset" | "publicShare" | "publicEditor" | "editor" }
>;

function CloudSection({ location }: { location: ShellLocation }) {
  switch (location.section) {
    case "files":
      return <FilesScreen folderId={location.folderId} />;
    case "notes":
      return <NotesScreen noteId={location.noteId} />;
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

type CloudContentState = { phase: "screen" } | { phase: "failed"; error: Error };

/** Screen-code failures must not dispose the shell, navigation or upload queue. */
export class CloudContent extends Component<{ location: ShellLocation }, CloudContentState> {
  override state: CloudContentState = { phase: "screen" };

  static getDerivedStateFromError(error: Error): CloudContentState {
    return { phase: "failed", error };
  }

  override componentDidCatch() {
    forgetFailedScreens();
  }

  retry = () => {
    this.setState({ phase: "screen" });
  };

  override render() {
    const { location } = this.props;

    switch (this.state.phase) {
      case "failed":
        return <ScreenLoadFailure error={this.state.error} onRetry={this.retry} />;
      case "screen":
        return (
          <Suspense fallback={<CloudScreenFallback location={location} />}>
            <CloudSection location={location} />
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
    <OfflineState
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
