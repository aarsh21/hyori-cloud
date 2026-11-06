import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { Images, Plus } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import {
  ItemGrid,
  ItemGridSkeleton,
  ItemLink,
  ItemNavigation,
  ItemTile,
  ItemTileLabel,
} from "@hyori-cloud/ui/components/item-collection";
import { Label } from "@hyori-cloud/ui/components/label";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { PhotosBar } from "#features/photos/react/photos-bar.tsx";
import { useAlbums, useCreateAlbum } from "#features/photos/react/use-photos.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

type Album = OutputOf<RPC["photos"]["albums"]>["items"][number];

export function AlbumsScreen() {
  const [creating, setCreating] = useState(false);
  const albums = useAlbums();

  function renderBody() {
    if (albums.data === undefined) {
      return <QueryWaiting resource={albums} pending={<ItemGridSkeleton tiles={6} />} />;
    }

    return (
      <>
        {albums.error !== null ? (
          <RefreshFailure error={albums.error} onRetry={() => albums.refetch()} />
        ) : null}
        {albums.data.items.length === 0 ? (
          <RegionState
            icon={<Images />}
            title="No albums yet"
            description="Albums collect photos without moving or copying the originals."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                New album
              </Button>
            }
          />
        ) : (
          <AlbumGrid albums={albums.data.items} />
        )}
      </>
    );
  }

  return (
    <>
      <PhotosBar
        actions={
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            New album
          </Button>
        }
      />
      <PageBody>
        <PageSection>{renderBody()}</PageSection>
      </PageBody>
      <CreateAlbumDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function AlbumGrid({ albums }: { albums: readonly Album[] }) {
  const { navigatePath } = useCloudNavigation();

  return (
    <ItemNavigation itemKeys={albums.map((album) => album.id)} layout="grid">
      <ItemGrid aria-label="Albums">
        {albums.map((album) => (
          <ItemTile key={album.id} itemKey={album.id} preview={<Images aria-hidden />}>
            <ItemLink
              href={formatCloudPath({ section: "album", albumId: album.id })}
              onNavigate={navigatePath}
            >
              <ItemTileLabel meta={`${album.count} ${album.count === 1 ? "item" : "items"}`}>
                {album.name}
              </ItemTileLabel>
            </ItemLink>
          </ItemTile>
        ))}
      </ItemGrid>
    </ItemNavigation>
  );
}

function CreateAlbumDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createAlbum = useCreateAlbum();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New album</DialogTitle>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) =>
            createAlbum.mutate(
              { name: formText(values, "name").trim() },
              { onSuccess: () => onOpenChange(false) },
            )
          }
        >
          <DialogBody>
            <Field>
              <Label htmlFor="album-name">Name</Label>
              <Input id="album-name" name="name" required maxLength={255} autoComplete="off" />
            </Field>
            <MutationFailure error={createAlbum.error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={createAlbum.isPending} pendingLabel="Creating…">
              Create
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
