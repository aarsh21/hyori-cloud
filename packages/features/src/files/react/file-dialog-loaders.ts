export const loadFileDialogs = () => import("#features/files/react/file-dialogs.tsx");

export const loadMoveDialog = () => import("#features/files/react/move-dialog.tsx");

export const loadShareDialog = () => import("#features/sharing/react/share-dialog.tsx");

export const loadReplaceFileDialog = () => import("#features/files/react/replace-file-dialog.tsx");

export const loadVersionHistoryDialog = () =>
  import("#features/files/react/version-history-dialog.tsx");

function ignoreLoadFailure() {
  // A preload is only a head start. An explicit open owns loading, failure and retry feedback.
}

/** Called as a row's menu opens, so the dialog is usually ready by the time an item is chosen. */
export function preloadFileDialogs() {
  void loadFileDialogs().catch(ignoreLoadFailure);
  void loadMoveDialog().catch(ignoreLoadFailure);
  void loadReplaceFileDialog().catch(ignoreLoadFailure);
  void loadShareDialog().catch(ignoreLoadFailure);
  void loadVersionHistoryDialog().catch(ignoreLoadFailure);
}
