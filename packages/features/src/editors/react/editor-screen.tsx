import {
  createQueryEditorBackend,
  useClientSDK,
  useEditorSession,
} from "@hyori-cloud/client-sdk/react";
import type { EditorSession, EditorSnapshot, EditorStopReason } from "@hyori-cloud/client-sdk";
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
import { useStoreValue } from "@hyori-cloud/ui/hooks/use-store-value";
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

// Read before an attachment exists, so the frame's lock can be derived in the one place it renders.
const NO_SESSION = {
  subscribe: () => () => {},
  getSnapshot: (): EditorSnapshot | null => null,
};

/** What "Download my version" holds once editing has stopped. */
const DOWNLOAD_HOLDS = "Download my version saves your changes as they were when editing stopped.";

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
  const snapshot = useStoreValue<EditorSnapshot | null>(attachment?.session ?? NO_SESSION);

  // Nothing typed here could be saved any more, so the editor stops taking input under its cover.
  const locked =
    snapshot?.status === "conflict" ||
    snapshot?.status === "access-ended" ||
    snapshot?.status === "failed";

  function attach(frame: HTMLIFrameElement) {
    const created = createEditorAttachment({
      frame,
      guard: navigationGuard,
      onReturn: onReopen,
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
            canCopy={copyDestination.kind !== "none"}
            onReopen={onReopen}
          />
        )
      }
    >
      <HostedDocumentFrame title="Document editor" onAttach={attach} inert={locked} />
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
  canCopy,
  onReopen,
}: {
  attachment: EditorAttachment;
  fileId: string;
  closePath: ClosePath;
  /** False where there is nowhere to put a copy, such as a link that shares a single file. */
  canCopy: boolean;
  onReopen: () => void;
}) {
  const { session } = attachment;
  const snapshot = useEditorSession(session);
  const close = useCloseEditor(fileId, closePath);
  const [confirming, setConfirming] = useState<"close" | "reopen" | null>(null);
  const hasRecovery = snapshot.recoveryCount > 0;
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
        onCopy={canCopy ? () => setCopying(true) : null}
      />
      <EditorProblem
        snapshot={snapshot}
        hasRecovery={hasRecovery}
        onRetry={() => session.retry()}
        onDismiss={() => session.dismiss()}
        onDownload={() => downloadMyVersion(session)}
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
          {native && canCopy && !copyOnly && live ? (
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
      {native && canCopy && snapshot.document !== null ? (
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
  onDismiss,
  onDownload,
}: {
  snapshot: EditorSnapshot;
  hasRecovery: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onDownload: () => void;
}) {
  const copy = snapshot.pendingOutput !== null && snapshot.pendingOutput.intent !== "replace";

  switch (snapshot.status) {
    case "save-failed":
      // A copy may give up and leave the original editing; the original itself can only retry.
      return (
        <>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {copy ? "Retry copy" : "Retry save"}
          </Button>
          {copy ? (
            <Button size="xs" variant="ghost" onClick={onDismiss}>
              Don’t save copy
            </Button>
          ) : null}
          {!copy && hasRecovery ? (
            <Button size="xs" variant="outline" onClick={onDownload}>
              Download my version
            </Button>
          ) : null}
        </>
      );
    case "conflict":
    case "access-ended":
      // Covered: the cover says what happened and offers the way out.
      return null;
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
  const hasRecovery = snapshot.recoveryCount > 0;

  const download = hasRecovery ? (
    <Button size="sm" variant="outline" onClick={() => downloadMyVersion(session)}>
      Download my version
    </Button>
  ) : null;

  const closeButton = (
    <Button size="sm" variant="ghost" onClick={close}>
      Close
    </Button>
  );

  switch (snapshot.status) {
    case "opening":
      return (
        <HostedDocumentCover>
          <Spinner label="Opening the editor" />
        </HostedDocumentCover>
      );
    case "failed": {
      const failure = openFailure(snapshot.reason);

      return (
        <HostedDocumentCover>
          <Notice
            title={failure.title}
            action={
              <>
                {download}
                {failure.retry ? (
                  <ReopenButton hasRecovery={hasRecovery} onReopen={onReopen}>
                    Try again
                  </ReopenButton>
                ) : null}
                {closeButton}
              </>
            }
          >
            {failure.detail}{" "}
            {snapshot.lastSavedAt === null
              ? "Your file hasn’t changed."
              : "Changes saved before this are in the file."}
            {hasRecovery ? ` ${DOWNLOAD_HOLDS}` : ""}
          </Notice>
        </HostedDocumentCover>
      );
    }

    case "conflict":
      return (
        <HostedDocumentCover>
          <Notice
            title="This file was changed somewhere else"
            action={
              <>
                {download}
                <ReopenButton hasRecovery={hasRecovery} onReopen={onReopen}>
                  Open latest version
                </ReopenButton>
              </>
            }
          >
            Your recent changes weren’t saved over it, and editing has stopped here.{" "}
            {DOWNLOAD_HOLDS}
          </Notice>
        </HostedDocumentCover>
      );
    case "access-ended": {
      const ended = endedSession(snapshot.reason);

      return (
        <HostedDocumentCover>
          <Notice
            title={ended.title}
            action={
              <>
                {download}
                {ended.reopen ? (
                  <ReopenButton hasRecovery={hasRecovery} onReopen={onReopen}>
                    Reopen
                  </ReopenButton>
                ) : null}
                {closeButton}
              </>
            }
          >
            {ended.detail}
            {hasRecovery ? ` ${DOWNLOAD_HOLDS}` : ""}
          </Notice>
        </HostedDocumentCover>
      );
    }

    case "editing":
    case "saving":
    case "read-only":
    case "save-failed":
    case "disposed":
      return null;
    default:
      snapshot.status satisfies never;

      return null;
  }
}

/** Reopening drops what this editor holds, so with something to download first it asks. */
function ReopenButton({
  hasRecovery,
  onReopen,
  children,
}: {
  hasRecovery: boolean;
  onReopen: () => void;
  children: string;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => (hasRecovery ? setConfirming(true) : onReopen())}
      >
        {children}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Leave your version behind?</AlertDialogTitle>
          <AlertDialogDescription>
            Reopening starts from the saved file. Download your version first to keep it.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={onReopen}>
              Reopen without it
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** How the cover explains a session that never opened, and whether trying again can help. */
type OpenFailure = { title: string; detail: string; retry: boolean };

/** How the cover explains a session that ended, and whether reopening can help. */
type EndedSession = { title: string; detail: string; reopen: boolean };

function openFailure(reason: EditorStopReason | null): OpenFailure {
  switch (reason) {
    case "unsupported":
      return {
        title: "This file can’t be opened in the editor",
        detail: "It’s larger than the editor allows, or in a format it can’t open.",
        retry: false,
      };
    case "session-limit":
      return {
        title: "Too many documents are open",
        detail: "Close a document open in another tab or window, then try again.",
        retry: true,
      };
    case "unavailable":
      return {
        title: "Editing isn’t available right now",
        detail: "The editor is turned off on this server, or its storage can’t be reached.",
        retry: true,
      };
    case "unreadable":
      return {
        title: "The editor couldn’t read this file",
        detail: "It may be damaged, or use something the editor doesn’t support.",
        retry: false,
      };
    case "network":
      return {
        title: "The document couldn’t be loaded",
        detail: "Check your connection, then try again.",
        retry: true,
      };
    case "timeout":
      return {
        title: "The editor took too long to start",
        detail: "This can happen on a slow connection or with a large file.",
        retry: true,
      };
    case "access-revoked":
      return {
        title: "You don’t have access to this file",
        detail: "Ask its owner to share it with you again.",
        retry: false,
      };
    case "editor-updated":
      return {
        title: "The editor was updated",
        detail: "Reopen the file to use the new version.",
        retry: true,
      };
    case "crashed":
    case "session-ended":
    case null:
      return {
        title: "The editor stopped",
        detail: "Something went wrong while it was running.",
        retry: true,
      };
  }

  reason satisfies never;

  return { title: "The editor stopped", detail: "", retry: true };
}

function endedSession(reason: EditorStopReason | null): EndedSession {
  switch (reason) {
    case "session-ended":
      return {
        title: "This editing session has ended",
        detail: "Sessions end after a day, or when the file is moved or removed.",
        reopen: true,
      };
    case "editor-updated":
      return {
        title: "The editor was updated",
        detail: "This tab still has the old editor, which can’t save any more.",
        reopen: true,
      };
    case "access-revoked":
    case "unsupported":
    case "session-limit":
    case "unavailable":
    case "unreadable":
    case "network":
    case "timeout":
    case "crashed":
    case null:
      return {
        title: "You no longer have access to this file",
        detail: "Nothing more can be saved to it.",
        reopen: false,
      };
  }

  reason satisfies never;

  return { title: "", detail: "", reopen: false };
}
