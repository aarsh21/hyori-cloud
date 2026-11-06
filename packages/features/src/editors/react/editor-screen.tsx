import {
  createQueryEditorBackend,
  useClientSDK,
  useEditorSession,
} from "@hyori-cloud/client-sdk/react";
import type { EditorSession, EditorSnapshot } from "@hyori-cloud/client-sdk";
import { useQuery, useQueryClient } from "@hyori-cloud/lib/query";
import { ArrowLeft, MoreHorizontal } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { AppearanceMenuItems } from "@hyori-cloud/ui/components/appearance-menu-items";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hyori-cloud/ui/components/alert-dialog";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import {
  HostedDocumentCover,
  HostedDocumentFrame,
  HostedDocumentIdentity,
  HostedDocumentLayout,
  HostedDocumentLink,
  HostedDocumentStatus,
} from "@hyori-cloud/ui/components/hosted-document";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { InlineText, Text } from "@hyori-cloud/ui/components/text";
import { saveBytesAsDownload } from "@hyori-cloud/ui/lib/browser";
import { AppearanceObserver } from "@hyori-cloud/ui/theme";
import { editorSaveState } from "#features/editors/editor-save-state.ts";
import { EditorCopyDialog } from "#features/editors/react/editor-copy-dialog.tsx";
import { EditorSaveActions } from "#features/editors/react/editor-save-actions.tsx";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { createDestinationRequests } from "#features/editors/destination-requests.ts";
import { createEditorAttachment } from "#features/editors/editor-attachment.ts";
import type { EditorAttachment } from "#features/editors/editor-attachment.ts";
import { DestinationDialog } from "#features/editors/react/destination-dialog.tsx";
import type { CopyDestination } from "#features/editors/react/destination-dialog.tsx";

type ClosePath = (parentId: string | null) => string;

const NOTICES_URL = "/artcraft/legal/RUNTIME-NOTICE-INDEX.md";

/** One attempt per mount: reopening is a new attachment, never a replay into a live editor. */
export function EditorScreen({
  fileId,
  copyDestination,
  closePath,
}: {
  fileId: string;
  /** Where this visitor could save a copy, which isn't always anywhere. */
  copyDestination: CopyDestination;
  /** Where Close goes, given the folder the file is in. */
  closePath: ClosePath;
}) {
  const [attempt, setAttempt] = useState(0);

  return (
    <EditorAttempt
      key={attempt}
      fileId={fileId}
      copyDestination={copyDestination}
      closePath={closePath}
      onReopen={() => setAttempt(attempt + 1)}
    />
  );
}

function EditorAttempt({
  fileId,
  copyDestination,
  closePath,
  onReopen,
}: {
  fileId: string;
  copyDestination: CopyDestination;
  closePath: ClosePath;
  onReopen: () => void;
}) {
  const sdkClient = useClientSDK();
  const queryClient = useQueryClient();
  const { navigationGuard } = useCloudNavigation();
  const [requests] = useState(createDestinationRequests);
  const [attachment, setAttachment] = useState<EditorAttachment | null>(null);

  function attach(frame: HTMLIFrameElement) {
    const created = createEditorAttachment({
      frame,
      guard: navigationGuard,
      backend: createQueryEditorBackend(sdkClient, queryClient, {
        id: fileId,
        chooseDestination: requests.choose,
      }),
    });

    setAttachment(created);

    return created.dispose;
  }

  return (
    <HostedDocumentLayout
      bar={
        attachment === null ? null : (
          <EditorBar
            attachment={attachment}
            fileId={fileId}
            closePath={closePath}
            onReopen={onReopen}
          />
        )
      }
    >
      <HostedDocumentFrame title="Document editor" onAttach={attach} />
      {attachment === null ? null : (
        <EditorCover
          session={attachment.session}
          fileId={fileId}
          closePath={closePath}
          onReopen={onReopen}
        />
      )}
      <DestinationDialog requests={requests} destination={copyDestination} />
    </HostedDocumentLayout>
  );
}

function useCloseEditor(fileId: string, closePath: ClosePath) {
  const { query } = useClientSDK();
  const { navigatePath } = useCloudNavigation();
  const file = useQuery(query.files.get.getOptions({ id: fileId }));

  return () => navigatePath(closePath(file.data?.parentId ?? null));
}

function downloadMyVersion(session: EditorSession) {
  const latest = session.getRecoveryOutputs().at(-1);

  if (latest !== undefined) saveBytesAsDownload(latest.bytes, latest.name);
}

function EditorBar({
  attachment,
  fileId,
  closePath,
  onReopen,
}: {
  attachment: EditorAttachment;
  fileId: string;
  closePath: ClosePath;
  onReopen: () => void;
}) {
  const { session } = attachment;
  const snapshot = useEditorSession(session);
  const close = useCloseEditor(fileId, closePath);
  const [confirming, setConfirming] = useState<"close" | "reopen" | null>(null);
  const hasRecovery = snapshot.pendingSaveCount > 0;
  const [copying, setCopying] = useState(false);

  const native =
    snapshot.document?.bridge === "hyori-correlated-host-v2" && snapshot.document.protocol === 2;

  const copyOnly =
    snapshot.document?.writable === false ||
    snapshot.document?.replacementName === null ||
    (snapshot.autosave.status === "disabled" && snapshot.autosave.reason === "copy-required");

  const live = snapshot.status === "editing" || snapshot.status === "read-only";
  const serializing = snapshot.autosave.status === "serializing";

  function leave(action: "close" | "reopen") {
    // Ended first, so the frame is still there when the session lets go of it.
    attachment.dispose();

    if (action === "close") close();
    else onReopen();
  }

  function request(action: "close" | "reopen") {
    if (snapshot.hasUnsavedChanges) setConfirming(action);
    else leave(action);
  }

  return (
    <>
      <AppearanceObserver onChange={session.setTheme} />
      <Button size="sm" variant="ghost" onClick={() => request("close")}>
        <ArrowLeft aria-hidden />
        Close
      </Button>
      <HostedDocumentIdentity>
        <InlineText truncate size="md" className="font-medium" title={snapshot.document?.name}>
          {snapshot.document?.name ?? "Opening document…"}
        </InlineText>
        <HostedDocumentStatus>{editorSaveState(snapshot)}</HostedDocumentStatus>
      </HostedDocumentIdentity>
      <EditorSaveActions
        snapshot={snapshot}
        requestSave={session.requestSave}
        onCopy={() => setCopying(true)}
      />
      <EditorProblem
        snapshot={snapshot}
        hasRecovery={hasRecovery}
        onRetry={() => session.retry()}
        onDownload={() => downloadMyVersion(session)}
        onReopen={() => request("reopen")}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon" variant="ghost" aria-label="Document options" />}
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="data-open:animate-none data-closed:animate-none"
        >
          {native && !copyOnly && live ? (
            <>
              <DropdownMenuItem
                disabled={serializing || hasRecovery}
                onClick={() => setCopying(true)}
              >
                Save a copy…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <AppearanceMenuItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            render={<HostedDocumentLink href={NOTICES_URL} target="_blank" rel="noreferrer" />}
          >
            Notices
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {native && snapshot.document !== null ? (
        <EditorCopyDialog
          document={snapshot.document}
          open={copying}
          onOpenChange={setCopying}
          requestSave={session.requestSave}
        />
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {confirming === "reopen" ? "Open the latest version?" : "Close without saving?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Changes you haven’t saved will be lost.
            {hasRecovery ? " Download your version first to keep a copy." : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep editing</AlertDialogClose>
            {hasRecovery ? (
              <Button variant="outline" onClick={() => downloadMyVersion(session)}>
                Download my version
              </Button>
            ) : null}
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming !== null) leave(confirming);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What went wrong while the editor stays usable, with what can be done about it from here. */
function EditorProblem({
  snapshot,
  hasRecovery,
  onRetry,
  onDownload,
  onReopen,
}: {
  snapshot: EditorSnapshot;
  hasRecovery: boolean;
  onRetry: () => void;
  onDownload: () => void;
  onReopen: () => void;
}) {
  const download = hasRecovery ? (
    <Button size="xs" variant="outline" onClick={onDownload}>
      Download my version
    </Button>
  ) : null;

  switch (snapshot.status) {
    case "save-failed":
      return (
        <>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry save
          </Button>
          {download}
        </>
      );
    case "conflict":
      return (
        <>
          {download}
          <Button size="xs" variant="outline" onClick={onReopen}>
            Open latest version
          </Button>
        </>
      );
    case "access-ended":
      return download;
    case "editing":
    case "read-only":
      return snapshot.message === null ? null : (
        <Text size="xs" tone="destructive" role="alert" className="order-last basis-full px-2">
          {snapshot.message}
        </Text>
      );
    case "opening":
    case "saving":
    case "failed":
    case "disposed":
      return null;
    default:
      snapshot.status satisfies never;

      return null;
  }
}

function EditorCover({
  session,
  fileId,
  closePath,
  onReopen,
}: {
  session: EditorSession;
  fileId: string;
  closePath: ClosePath;
  onReopen: () => void;
}) {
  const snapshot = useEditorSession(session);
  const close = useCloseEditor(fileId, closePath);
  const hasRecovery = snapshot.pendingSaveCount > 0;

  switch (snapshot.status) {
    case "opening":
      return (
        <HostedDocumentCover>
          <Spinner label="Opening the editor" />
        </HostedDocumentCover>
      );
    case "failed":
      return (
        <HostedDocumentCover>
          <Notice
            title="This document couldn’t be opened in the editor"
            action={
              <>
                {hasRecovery ? (
                  <Button size="sm" variant="outline" onClick={() => downloadMyVersion(session)}>
                    Download my version
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={onReopen}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={close}>
                  Close
                </Button>
              </>
            }
          >
            Your file hasn’t changed. Editing may not be available on this server right now.
          </Notice>
        </HostedDocumentCover>
      );
    case "access-ended":
      return (
        <HostedDocumentCover>
          <Notice
            title="You no longer have access to this file"
            action={
              <>
                {hasRecovery ? (
                  <Button size="sm" variant="outline" onClick={() => downloadMyVersion(session)}>
                    Download my version
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={close}>
                  Close
                </Button>
              </>
            }
          >
            Nothing more can be saved to it.
          </Notice>
        </HostedDocumentCover>
      );
    case "editing":
    case "saving":
    case "read-only":
    case "save-failed":
    case "conflict":
    case "disposed":
      return null;
    default:
      snapshot.status satisfies never;

      return null;
  }
}
