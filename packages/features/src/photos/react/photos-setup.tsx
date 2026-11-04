import { PageBody } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { Heading, Stack, Text } from "@hyori-cloud/ui/components/text";
import { SourceSelection, useSourcesDraft } from "#features/photos/react/source-selection.tsx";
import { useSetPhotoSources } from "#features/photos/react/use-photos.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

const NO_SOURCES = { allMyFiles: false, folderIds: [] };

export function PhotosSetup() {
  const draft = useSourcesDraft(NO_SOURCES);
  const save = useSetPhotoSources();

  return (
    <PageBody>
      <Stack className="mx-auto w-full max-w-md gap-5 px-5 py-10">
        <Stack className="gap-1.5">
          <Heading className="text-lg">Choose what appears in Photos</Heading>
          <Text tone="muted">
            Photos shows images and videos from the folders you pick. Nothing is moved or copied.
          </Text>
        </Stack>
        <SourceSelection draft={draft} />
        <MutationFailure error={save.error} />
        <Button
          size="lg"
          disabled={!draft.canSave}
          pending={save.isPending}
          pendingLabel="Saving…"
          onClick={() =>
            save.mutate({
              allMyFiles: draft.value.allMyFiles,
              folderIds: [...draft.value.folderIds],
            })
          }
        >
          Show my photos
        </Button>
      </Stack>
    </PageBody>
  );
}
