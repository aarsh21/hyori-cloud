import type { FileEntry, ShareRole } from "@hyori-cloud/client-sdk";
import { Download, FolderOpen, Upload } from "@hyori-cloud/lib/icons";
import { lazy, Suspense, useState } from "@hyori-cloud/lib/react";
import { AppMain, AppShell } from "@hyori-cloud/ui/components/app-shell";
import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { ShortcutPreferenceMenuItems } from "@hyori-cloud/ui/components/shortcut-preference-menu-items";
import { Heading, Stack, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { OpenInEditorButton } from "#features/editors/react/open-in-editor-button.tsx";
import { FileBrowser } from "#features/files/react/file-browser.tsx";
import { loadReplaceFileDialog } from "#features/files/react/file-dialog-loaders.ts";
import { useCurrentFile } from "#features/files/react/use-current-file.ts";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { describeCloudError, endsItemAccess } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import { formatBytes } from "#features/shared/format.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { UploadTray } from "#features/uploads/react/upload-tray.tsx";

const NoteDocument = lazy(async () => ({
  default: (await import("#features/notes/react/note-document.tsx")).NoteDocument,
}));

const ReplaceFileDialog = lazy(async () => ({
  default: (await loadReplaceFileDialog()).ReplaceFileDialog,
}));

/** What a visitor may do through this link, in the words the public page shows. */
const LINK_ACCESS_LABELS: Record<ShareRole, string> = {
  viewer: "View only",
  contributor: "Can upload",
  editor: "Can edit",
};

export function PublicSharedItem({
  token,
  folderId,
  role,
  sharedByName,
  item,
}: {
  token: string;
  folderId: string | null;
  /** The access this link grants, from the share the link resolved to. */
  role: ShareRole;
  /** Who shared it, once the link is open. Older servers don't say. */
  sharedByName?: string | null | undefined;
  item: FileEntry;
}) {
  const access = sharedByName
    ? `Shared by ${sharedByName} · ${LINK_ACCESS_LABELS[role]}`
    : LINK_ACCESS_LABELS[role];

  if (item.mimeType === "application/vnd.hyori.note")
    return (
      <AppShell className="md:p-2">
        <AppMain className="md:m-0">
          <Suspense fallback={<Spinner />}>
            <NoteDocument
              id={item.id}
              closePath={formatCloudPath({ section: "publicShare", token, folderId: null })}
            />
          </Suspense>
        </AppMain>
      </AppShell>
    );

  if (item.kind === "file") return <PublicSharedFile item={item} access={access} />;

  return (
    <AppShell className="md:p-2">
      <AppMain className="md:m-0">
        <FileBrowser
          parentId={folderId ?? item.id}
          view="files"
          rootLabel={item.name}
          rootSearchScope="this folder"
          rootFolderId={item.id}
          rootCanUpload={false}
          titleMeta={access}
          actions={
            <AppearanceMenu compact>
              <ShortcutPreferenceMenuItems />
            </AppearanceMenu>
          }
          folderPath={(id) =>
            formatCloudPath({
              section: "publicShare",
              token,
              folderId: id === item.id ? null : id,
            })
          }
          empty={() => <RegionState icon={<FolderOpen />} title="This folder is empty" />}
        />
        <UploadTray />
      </AppMain>
    </AppShell>
  );
}

function PublicSharedFile({ item, access }: { item: FileEntry; access: string }) {
  const file = useCurrentFile(item);
  const refresh = () => void file.refetch();

  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      {/* What was opened earlier stays up through a failed refresh, but not once access has ended. */}
      {file.error !== null && endsItemAccess(file.error) ? (
        <SharedFileGone
          error={file.error}
          retrying={file.fetchStatus === "fetching"}
          onRetry={refresh}
        />
      ) : (
        <SharedFileContent
          file={file.data}
          error={file.error}
          onRefresh={refresh}
          access={access}
        />
      )}
      <UploadTray floating />
    </FocusLayout>
  );
}

function SharedFileGone({
  error,
  retrying,
  onRetry,
}: {
  error: CloudError;
  retrying: boolean;
  onRetry: () => void;
}) {
  const recovery = useAccessRecovery(error);
  const copy = recovery ?? describeCloudError(error);

  return (
    <>
      <FocusLayoutHeader role="alert">
        <Heading>{copy.title}</Heading>
        {copy.detail === undefined ? null : <Text tone="muted">{copy.detail}</Text>}
      </FocusLayoutHeader>
      {recovery === null ? (
        <Button
          size="lg"
          variant="outline"
          pending={retrying}
          pendingLabel="Trying again…"
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : (
        <AccessRecoveryButton recovery={recovery} size="lg" onRecovered={onRetry} />
      )}
    </>
  );
}

function SharedFileContent({
  file,
  error,
  onRefresh,
  access,
}: {
  file: FileEntry;
  error: CloudError | null;
  onRefresh: () => void;
  access: string;
}) {
  const download = useDownloadFile();
  const [replacing, setReplacing] = useState(false);

  return (
    <>
      <FocusLayoutHeader>
        <Heading className="wrap-anywhere">{file.name}</Heading>
        <Text tone="muted" numeric>
          {formatBytes(file.size)} · {access}
        </Text>
      </FocusLayoutHeader>
      {error === null ? null : <RefreshFailure error={error} onRetry={onRefresh} />}
      <MutationFailure error={download.error} onRecovered={() => download.reset()} />
      <Stack className="gap-2">
        <OpenInEditorButton entry={file} />
        {file.access.canDownload ? (
          <Button
            size="lg"
            pending={download.isPending}
            pendingLabel="Preparing…"
            onClick={() => download.mutate({ id: file.id })}
          >
            <Download aria-hidden />
            Download
          </Button>
        ) : null}
        {file.access.canEdit ? (
          <Button size="lg" variant="outline" onClick={() => setReplacing(true)}>
            <Upload aria-hidden />
            Upload new version
          </Button>
        ) : null}
      </Stack>
      {file.access.canEdit ? (
        <Suspense fallback={null}>
          <ReplaceFileDialog entry={file} open={replacing} onOpenChange={setReplacing} />
        </Suspense>
      ) : null}
    </>
  );
}
