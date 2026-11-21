import { isConstrainedConnection } from "@hyori-cloud/ui/lib/browser";
import {
  loadAdminScreen,
  loadAlbumScreen,
  loadAlbumsScreen,
  loadFilesScreen,
  loadNoteDocument,
  loadNotesScreen,
  loadPhotosScreen,
  loadSharedScreen,
  loadTrashScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";

/**
 * Every section's code, fetched once the browser is idle after the signed-in app has painted, so
 * the first visit to a section waits only for its data. Chunks download one at a time to keep the
 * wire free for whatever the person is actually doing, and each request is the memoized one the
 * section's own open would make, so nothing is fetched twice.
 *
 * Editors stay out: their code is a hundred times a section's and most sessions never open one.
 * The note editor is the one exception. On a slow phone its 222 KB download is most of the wait
 * for the first note opened from the list, and a hashed chunk stays in the browser cache, so it is
 * paid once per release rather than once per session. It loads last, after every section, and
 * never when the browser asks to save data or reports a 2G connection. The document editors
 * (`loadEditorScreen`) remain on demand.
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

  // Checked when the editor's turn comes, so a connection that degraded meanwhile still skips it.
  const noteEditor = () =>
    isConstrainedConnection() ? Promise.resolve() : loadNoteDocument().then(() => {});

  for (const load of [...screens, noteEditor]) {
    // A failure is forgotten by the chunk itself, so the section's own open asks again.
    await load().catch(() => {});
  }
}
