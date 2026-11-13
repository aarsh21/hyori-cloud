import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Suspense } from "@hyori-cloud/lib/react";
import { FocusLayout } from "@hyori-cloud/ui/components/focus-layout";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Row } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import {
  lazyScreen,
  loadEditorScreen,
  loadNoteDocument,
} from "#features/cloud/react/cloud-screen-loaders.ts";
import { AppMain, AppShell } from "@hyori-cloud/ui/components/app-shell";
import { useQuery } from "@hyori-cloud/lib/query";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";

const EditorScreen = lazyScreen(loadEditorScreen, (module) => module.EditorScreen);

const NoteDocument = lazyScreen(loadNoteDocument, (module) => module.NoteDocument);

/** Editing through a link: nothing to sign in to, and every way out goes back to that link. */
export function PublicEditor({
  token,
  fileId,
  item,
}: {
  token: string;
  fileId: string;
  item: FileEntry;
}) {
  const isFolderLink = item.kind !== "file";
  const { query } = useClientSDK();
  const file = useQuery(query.files.get.getOptions({ id: fileId }));

  if (file.data === undefined) return <QueryWaiting resource={file} pending={<Spinner />} />;

  if (file.data.mimeType === "application/vnd.hyori.note")
    return (
      <AppShell className="md:p-2">
        <AppMain className="md:m-0">
          <Suspense fallback={<Spinner />}>
            <NoteDocument
              id={fileId}
              closePath={formatCloudPath({ section: "publicShare", token, folderId: null })}
            />
          </Suspense>
        </AppMain>
      </AppShell>
    );

  return (
    <Suspense
      fallback={
        <FocusLayout>
          <Wordmark />
          <Row className="min-h-9">
            <Spinner />
          </Row>
        </FocusLayout>
      }
    >
      <EditorScreen
        key={fileId}
        fileId={fileId}
        copyDestination={isFolderLink ? { kind: "folder", folderId: item.id } : { kind: "none" }}
        closePath={(parentId) =>
          formatCloudPath({
            section: "publicShare",
            token,
            folderId: isFolderLink && parentId !== item.id ? parentId : null,
          })
        }
      />
    </Suspense>
  );
}
