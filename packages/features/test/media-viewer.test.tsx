import { describe, expect } from "bun:test";
import { Lightbox } from "@hyori-cloud/ui/components/lightbox";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { AlbumMenu } from "#features/photos/react/album-menu.tsx";
import { PhotoTile } from "#features/photos/react/photo-tile.tsx";
import { enterViewport } from "#features-test/dom-environment.ts";
import {
  act,
  ApiFailure,
  createFakeApi,
  deferred,
  fileEntry,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const PHOTO = fileEntry({ id: "photo_1", name: "one.heic", mimeType: "image/heic" });
const SECOND = fileEntry({ id: "photo_2", name: "two.png", mimeType: "image/png" });
const CLIP = fileEntry({ id: "clip_1", name: "clip.mp4", mimeType: "video/mp4" });
const CONTENT = { url: "/content/photo_1", name: PHOTO.name, size: 7, mimeType: PHOTO.mimeType };

function viewer(items = [PHOTO, SECOND], itemId = PHOTO.id) {
  return (
    <MediaViewer items={items} itemId={itemId} open onOpenChange={() => {}} onSelect={() => {}} />
  );
}

describe("viewer failures", () => {
  test("a failed download is reported in the viewer and can be retried", async () => {
    const api = createFakeApi({ "files.download": () => CONTENT });

    mount(viewer(), api);
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.download"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(screen.getByRole("button", { name: `Download ${PHOTO.name}` }));

    expect(await screen.findByText(/Couldn’t download/)).toBeTruthy();
    const before = api.callsTo("files.download").length;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(api.callsTo("files.download").length).toBe(before + 1));
    expect(await screen.findByText(/Couldn’t download/)).toBeTruthy();
  });

  test("a failed download for one item isn't shown on the next", async () => {
    const api = createFakeApi({ "files.download": () => CONTENT });
    const view = mount(viewer(), api);

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.download"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(screen.getByRole("button", { name: `Download ${PHOTO.name}` }));
    await screen.findByText(/Couldn’t download/);

    view.rerender(viewer([PHOTO, SECOND], SECOND.id));

    await waitFor(() => expect(screen.queryByText(/Couldn’t download/)).toBeNull());

    // The next item's own preview request also fails here. Wait for it so nothing updates after the test.
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("an image the browser can't decode falls back to a message", async () => {
    mount(viewer(), createFakeApi({ "files.download": () => CONTENT }));
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    const image = document.querySelector("img");

    if (image === null) throw new Error("The viewer rendered no image.");
    fireEvent.error(image);

    expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("photo tiles", () => {
  function tile(item = PHOTO) {
    return <PhotoTile item={item} previewUrl={`/content/${item.id}`} onOpen={() => {}} />;
  }

  test("load the server's preview URL only near the viewport, with no per-tile request", async () => {
    const api = createFakeApi({});

    mount(tile(), api);
    expect(document.querySelector("img")).toBeNull();

    act(() => enterViewport());

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/content/photo_1"),
    );
    expect(api.calls).toHaveLength(0);
  });

  test("videos stay a placeholder even in view", () => {
    mount(tile(CLIP), createFakeApi({}));

    act(() => enterViewport());

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: CLIP.name }).querySelector("svg")).not.toBeNull();
  });

  test("a preview that fails falls back to the placeholder instead of a blank tile", async () => {
    mount(tile(), createFakeApi({}));

    act(() => enterViewport());

    const image = await waitFor(() => {
      const found = document.querySelector("img");

      if (found === null) throw new Error("No image yet.");

      return found;
    });

    fireEvent.error(image);

    await waitFor(() => expect(document.querySelector("img")).toBeNull());
    expect(screen.getByRole("button", { name: PHOTO.name }).querySelector("svg")).not.toBeNull();
  });
});

describe("album menu", () => {
  function albumMenu() {
    return (
      <Lightbox
        open
        onOpenChange={() => {}}
        title="Photo"
        actions={<AlbumMenu fileId={PHOTO.id} />}
      >
        <p>Stage</p>
      </Lightbox>
    );
  }

  function openMenu() {
    fireEvent.click(screen.getByRole("button", { name: "Add to album" }));
  }

  test("loading is not the same as having no albums", async () => {
    const pending = deferred<object>();

    mount(albumMenu(), createFakeApi({ "photos.albums": () => pending.promise }));
    openMenu();

    expect(await screen.findByText("Loading albums…")).toBeTruthy();
    expect(screen.queryByText("No albums yet")).toBeNull();

    pending.resolve({ items: [] });

    expect(await screen.findByText("No albums yet")).toBeTruthy();
  });

  test("a failure says so and retries in place", async () => {
    const api = createFakeApi({
      "photos.albums": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    mount(albumMenu(), api);
    openMenu();

    const retry = await screen.findByRole("menuitem", { name: /Couldn’t load albums/ });

    expect(screen.queryByText("No albums yet")).toBeNull();

    api.handlers["photos.albums"] = () => ({
      items: [{ id: "album_1", name: "Summer", createdAt: "2026-11-04T00:00:00Z", count: 1 }],
    });
    fireEvent.click(retry);

    expect(await screen.findByRole("menuitem", { name: "Summer" })).toBeTruthy();
  });
});
