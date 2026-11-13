import { Images, Plus, RotateCcw } from "@hyori-cloud/lib/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { LightboxAction } from "@hyori-cloud/ui/components/lightbox";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { useAddToAlbum, useAlbums } from "#features/photos/react/use-photos.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";

export function AlbumMenu({ fileId }: { fileId: string }) {
  const albums = useAlbums();
  const addToAlbum = useAddToAlbum();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<LightboxAction aria-label="Add to album" />}>
        <Plus aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Add to album</DropdownMenuLabel>
          <AlbumItems albums={albums} fileId={fileId} addToAlbum={addToAlbum} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AlbumItems({
  albums,
  fileId,
  addToAlbum,
}: {
  albums: ReturnType<typeof useAlbums>;
  fileId: string;
  addToAlbum: ReturnType<typeof useAddToAlbum>;
}) {
  if (albums.data === undefined) return <AlbumsWaiting albums={albums} />;

  if (albums.data.items.length === 0) {
    return (
      <DropdownMenuItem disabled>
        <Images />
        No albums yet
      </DropdownMenuItem>
    );
  }

  return albums.data.items.map((album) => (
    <DropdownMenuItem
      key={album.id}
      onClick={() =>
        addToAlbum.mutate(
          { albumId: album.id, fileIds: [fileId] },
          {
            onSuccess: () => toast(`Added to ${album.name}`),
            // The menu has closed, and the viewer has no region this could persist beside.
            onError: (error) => toast.error(describeCloudError(error).title),
          },
        )
      }
    >
      <Images />
      {album.name}
    </DropdownMenuItem>
  ));
}

/** Not having the list yet is different from having no albums, so neither reads as the other. */
function AlbumsWaiting({ albums }: { albums: ReturnType<typeof useAlbums> }) {
  if (albums.error !== null) {
    return (
      <DropdownMenuItem closeOnClick={false} onClick={() => albums.refetch()}>
        <RotateCcw />
        Couldn’t load albums. Try again
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem disabled>
      <Images />
      {albums.fetchStatus === "paused" ? "Waiting for a connection" : "Loading albums…"}
    </DropdownMenuItem>
  );
}
