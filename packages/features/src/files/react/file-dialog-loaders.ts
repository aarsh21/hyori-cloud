export const loadMoveDialog = () => import("#features/files/react/move-dialog.tsx");

export const loadShareDialog = () => import("#features/sharing/react/share-dialog.tsx");

export const loadReplaceFileDialog = () => import("#features/files/react/replace-file-dialog.tsx");

export const loadVersionHistoryDialog = () =>
  import("#features/files/react/version-history-dialog.tsx");

function ignoreLoadFailure() {
  // A preload is only a head start. If the code really is unavailable, opening the dialog fails
  // into the host's error boundary, which is where someone can act on it.
}

/** Called as a row's menu opens, so the dialog is usually ready by the time an item is chosen. */
export function preloadFileDialogs() {
  void loadMoveDialog().catch(ignoreLoadFailure);
  void loadReplaceFileDialog().catch(ignoreLoadFailure);
  void loadShareDialog().catch(ignoreLoadFailure);
  void loadVersionHistoryDialog().catch(ignoreLoadFailure);
}
