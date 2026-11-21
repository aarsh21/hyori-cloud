import {
  loadAdminScreen,
  loadAlbumScreen,
  loadAlbumsScreen,
  loadFilesScreen,
  loadNotesScreen,
  loadPhotosScreen,
  loadSharedScreen,
  loadTrashScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";

/**
 * Every section's code, fetched once the browser is idle after the signed-in app has painted, so
 * the first visit to a section waits only for its data. The editor and note documents stay out:
 * their code is a hundred times a section's and most sessions never open either. Chunks download
 * one at a time to keep the wire free for whatever the person is actually doing, and each request
 * is the memoized one the section's own open would make, so nothing is fetched twice.
 *
 * The idle hook owns the when; this only says what runs, at most once per page load.
 */
const IDLE_SCREENS = [
  loadFilesScreen,
  loadPhotosScreen,
  loadNotesScreen,
  loadSharedScreen,
  loadTrashScreen,
  loadAlbumsScreen,
  loadAlbumScreen,
] as const;

let scheduled = false;

export function preloadIdleCloudScreens(isAdmin: boolean) {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;

  void preloadIdleScreens(isAdmin);
}

async function preloadIdleScreens(isAdmin: boolean) {
  const screens = isAdmin ? [...IDLE_SCREENS, loadAdminScreen] : [...IDLE_SCREENS];

  for (const load of screens) {
    // A failure is forgotten by the chunk itself, so the section's own open asks again.
    await load().catch(() => {});
  }
}
