import type { FileEntry } from "@hyori-cloud/client-sdk";
import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { FocusLayout } from "@hyori-cloud/ui/components/focus-layout";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Row } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { loadEditorScreen } from "#features/cloud/react/cloud-screen-loaders.ts";

const EditorScreen = lazy(async () => ({ default: (await loadEditorScreen()).EditorScreen }));

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
