import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { parseCloudPath } from "#features/cloud/cloud-path.ts";

/**
 * Every screen is its own chunk, so opening a shared link never downloads the file manager and
 * opening Files never downloads the admin console. `import()` caches, so preloading a screen is free
 * once it has happened, and these only ever fetch code: no private data moves on intent.
 */
export const loadCloudShell = () => import("#features/cloud/react/signed-in-cloud.tsx");

export const loadInviteScreen = () => import("#features/auth/react/invite-screen.tsx");

export const loadPublicShareScreen = () =>
  import("#features/sharing/react/public-share-screen.tsx");

export const loadFilesScreen = () => import("#features/files/react/files-screen.tsx");
export const loadSharedScreen = () => import("#features/files/react/shared-screen.tsx");
export const loadTrashScreen = () => import("#features/files/react/trash-screen.tsx");
export const loadPhotosScreen = () => import("#features/photos/react/photos-screen.tsx");
export const loadAlbumsScreen = () => import("#features/photos/react/albums-screen.tsx");
export const loadAlbumScreen = () => import("#features/photos/react/album-screen.tsx");
export const loadAdminScreen = () => import("#features/admin/react/admin-screen.tsx");
export const loadEditorScreen = () => import("#features/editors/react/editor-screen.tsx");

function ignoreLoadFailure() {
  // A preload is only a head start. If the code really is unavailable, rendering the screen fails
  // into the host's error boundary, which is where someone can act on it.
}

export function preloadCloudLocation(location: CloudLocation) {
  switch (location.section) {
    case "invite":
      void loadInviteScreen().catch(ignoreLoadFailure);

      return;
    case "publicShare":
      void loadPublicShareScreen().catch(ignoreLoadFailure);

      return;
    case "publicEditor":
      void loadPublicShareScreen().catch(ignoreLoadFailure);
      void loadEditorScreen().catch(ignoreLoadFailure);

      return;
    case "editor":
      void loadEditorScreen().catch(ignoreLoadFailure);

      return;
    case "files":
      void loadFilesScreen().catch(ignoreLoadFailure);
      break;
    case "shared":
      void loadSharedScreen().catch(ignoreLoadFailure);
      break;
    case "trash":
      void loadTrashScreen().catch(ignoreLoadFailure);
      break;
    case "photos":
      void loadPhotosScreen().catch(ignoreLoadFailure);
      break;
    case "albums":
      void loadAlbumsScreen().catch(ignoreLoadFailure);
      break;
    case "album":
      void loadAlbumScreen().catch(ignoreLoadFailure);
      break;
    case "admin":
      void loadAdminScreen().catch(ignoreLoadFailure);
      break;
    case "notFound":
      break;
    default:
      location satisfies never;
  }

  void loadCloudShell().catch(ignoreLoadFailure);
}

/** For a host to start fetching a location's code alongside, not after, its first data request. */
export function preloadCloudPath(path: string) {
  preloadCloudLocation(parseCloudPath(path));
}
