import { createElement, lazy, useState } from "@hyori-cloud/lib/react";
import type { ComponentType } from "@hyori-cloud/lib/react";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { parseCloudPath } from "#features/cloud/cloud-path.ts";

type Chunk<Module> = (() => Promise<Module>) & { readonly arrived: () => Module | undefined };

const failedChunks = new Set<() => void>();
const lazyRebuilds = new Set<() => void>();

/** One request per chunk, which remembers the module once it has arrived. */
function chunk<Module>(load: () => Promise<Module>): Chunk<Module> {
  let current: Promise<Module> | null = null;
  let arrived: Module | undefined;

  function request() {
    if (current !== null) return current;

    const pending = load();

    current = pending;
    pending.then(
      (module) => {
        arrived = module;
      },
      () => {
        failedChunks.add(() => {
          current = null;
        });
      },
    );

    return pending;
  }

  return Object.assign(request, { arrived: () => arrived });
}

/**
 * Once a failure is on screen: the next render, Retry or preload requests those chunks again. Until
 * then a failed request stays, so React's own retry render sees the failure instead of a new request.
 */
export function forgetFailedChunks() {
  for (const forget of failedChunks) forget();

  failedChunks.clear();

  for (const rebuild of lazyRebuilds) rebuild();
}

/**
 * A screen from its chunk. `React.lazy` suspends at least once even for code that is already here,
 * and React then holds the fallback for 300 ms before revealing the screen. So once the chunk has
 * arrived, a newly mounted screen renders the component itself; only code still on its way goes
 * through `React.lazy`, whose wrapper is rebuilt after a failure because it keeps the rejection.
 */
export function lazyScreen<Module, Props extends object>(
  load: Chunk<Module>,
  pick: (module: Module) => ComponentType<Props>,
) {
  const create = () => lazy(async () => ({ default: pick(await load()) }));
  let pending = create();

  lazyRebuilds.add(() => {
    pending = create();
  });

  return function LazyScreen(props: Props) {
    // Chosen once per mount, so a screen that mounted through the wrapper never remounts.
    const [Screen] = useState(() => {
      const module = load.arrived();

      return module === undefined ? pending : pick(module);
    });

    return createElement(Screen, props);
  };
}

/**
 * Every screen is its own chunk, so opening a shared link never downloads the file manager and
 * opening Files never downloads the admin console. Each chunk is requested once, so preloading a
 * screen is free once it has happened, and these only ever fetch code: no private data moves on
 * intent.
 */
export const loadCloudShell = chunk(() => import("#features/cloud/react/signed-in-cloud.tsx"));

export const loadInviteScreen = chunk(() => import("#features/auth/react/invite-screen.tsx"));

export const loadPublicShareScreen = chunk(
  () => import("#features/sharing/react/public-share-screen.tsx"),
);

export const loadFilesScreen = chunk(() => import("#features/files/react/files-screen.tsx"));
export const loadSharedScreen = chunk(() => import("#features/files/react/shared-screen.tsx"));
export const loadTrashScreen = chunk(() => import("#features/files/react/trash-screen.tsx"));
export const loadPhotosScreen = chunk(() => import("#features/photos/react/photos-screen.tsx"));
export const loadAlbumsScreen = chunk(() => import("#features/photos/react/albums-screen.tsx"));
export const loadAlbumScreen = chunk(() => import("#features/photos/react/album-screen.tsx"));
export const loadAdminScreen = chunk(() => import("#features/admin/react/admin-screen.tsx"));
export const loadEditorScreen = chunk(() => import("#features/editors/react/editor-screen.tsx"));

function ignoreLoadFailure() {
  // A preload is only a head start. If the code really is unavailable, rendering the screen fails
  // into its offline recovery boundary, or the host's Reload screen for an online chunk failure.
}

/** For a document someone may open next: the editor renders without a fallback once this is done. */
export function preloadEditorScreen() {
  void loadEditorScreen().catch(ignoreLoadFailure);
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
      // The account's editor opens inside the signed-in chunk, which owns its upload queue.
      void loadEditorScreen().catch(ignoreLoadFailure);
      break;
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
