import { describe, expect } from "bun:test";
import type { MediaDerivative, PhotoItem } from "#features/photos/photo-derivative.ts";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import { AlbumScreen } from "#features/photos/react/album-screen.tsx";
import { PhotoTile } from "#features/photos/react/photo-tile.tsx";
import { PhotosScreen } from "#features/photos/react/photos-screen.tsx";
import { PhotoTimeline } from "#features/photos/react/photo-timeline.tsx";
import { usePhotoTimeline } from "#features/photos/react/use-photos.ts";
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

const ORIGINAL = "/api/storage/previews/original_1?revision=3";
const THUMBNAIL = "/api/storage/derivatives/photo_1/artifact_1?revision=3";

function withDerivative(item: PhotoItem, derivative: MediaDerivative | undefined): PhotoItem {
  return derivative === undefined ? item : { ...item, derivative };
}

function photo(derivative?: MediaDerivative, overrides: Partial<PhotoItem> = {}): PhotoItem {
  return withDerivative(
    {
      ...fileEntry({ id: "photo_1", name: "one.png", mimeType: "image/png" }),
      previewUrl: ORIGINAL,
      ...overrides,
    },
    derivative,
  );
}

function clip(derivative?: MediaDerivative): PhotoItem {
  return withDerivative(
    {
      ...fileEntry({ id: "clip_1", name: "clip.mp4", mimeType: "video/mp4" }),
      previewUrl: "/api/storage/previews/clip_1?revision=1",
    },
    derivative,
  );
}

function ready(url = THUMBNAIL, sourceRevision = 3): MediaDerivative {
  return { status: "ready", kind: "thumbnail", sourceRevision, url, width: 256, height: 192 };
}

function tile(item: PhotoItem, onOpen: (id: string) => void = () => {}) {
  return <PhotoTile item={item} onOpen={onOpen} />;
}

function imageSources() {
  return [...document.querySelectorAll("img")].map((image) => image.getAttribute("src"));
}

function timelinePage(items: readonly PhotoItem[]) {
  return { items, nextCursor: null, breadcrumbs: [], folder: null };
}

function MountedTimeline() {
  return <PhotoTimeline timeline={usePhotoTimeline()} empty={<p>No photos</p>} />;
}

describe("photo tiles with server thumbnails", () => {
  test("a ready thumbnail loads near the viewport, instead of the original, with no request", async () => {
    const api = createFakeApi({});

    mount(tile(photo(ready())), api);
    expect(imageSources()).toEqual([]);

    act(() => enterViewport());

    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));
    expect(api.calls).toHaveLength(0);
  });

  test("a ready poster shows as a still marked as a video, instead of the video stream", async () => {
    const poster = "/api/storage/derivatives/clip_1/artifact_2?revision=1";

    mount(
      tile(
        clip({
          status: "ready",
          kind: "poster",
          sourceRevision: 1,
          url: poster,
          width: 256,
          height: 144,
        }),
      ),
      createFakeApi({}),
    );

    act(() => enterViewport());

    await waitFor(() => expect(imageSources()).toEqual([poster]));
    expect(screen.getByRole("button", { name: "clip.mp4. Video." })).toBeTruthy();
    expect(document.querySelector('[data-slot="media-tile-badge"]')).not.toBeNull();
  });

  test("a server that sends no derivative state keeps showing originals for images", async () => {
    mount(tile(photo()), createFakeApi({}));

    act(() => enterViewport());

    await waitFor(() => expect(imageSources()).toEqual([ORIGINAL]));
    expect(screen.getByRole("button", { name: "one.png" })).toBeTruthy();
  });

  test("a server that sends no derivative state never loads a video as an image", async () => {
    mount(tile(clip()), createFakeApi({}));

    act(() => enterViewport());

    await waitFor(() => expect(screen.getByRole("button", { name: "clip.mp4" })).toBeTruthy());
    expect(imageSources()).toEqual([]);
  });

  for (const status of ["queued", "processing"] as const) {
    test(`${status} shows that it's being prepared, and never downloads the original`, async () => {
      const api = createFakeApi({});

      mount(tile(photo({ status, kind: "thumbnail", sourceRevision: 3 })), api);
      act(() => enterViewport());

      expect(
        await screen.findByRole("button", { name: "one.png. Preparing thumbnail." }),
      ).toBeTruthy();
      expect(screen.queryByText("Preparing thumbnail")).toBeNull();
      expect(imageSources()).toEqual([]);
      expect(api.calls).toHaveLength(0);
    });
  }

  test("unavailable stays a quiet placeholder and never downloads the original", async () => {
    mount(
      tile(photo({ status: "unavailable", kind: "thumbnail", sourceRevision: 3 })),
      createFakeApi({}),
    );

    act(() => enterViewport());

    expect(await screen.findByRole("button", { name: "one.png" })).toBeTruthy();
    expect(imageSources()).toEqual([]);
    expect(screen.queryByText("Preparing thumbnail")).toBeNull();
  });

  test("unsupported says why and offers no retry", async () => {
    mount(
      tile(
        photo({
          status: "unsupported",
          kind: "thumbnail",
          sourceRevision: 3,
          failure: "resourceLimit",
        }),
      ),
      createFakeApi({}),
    );

    act(() => enterViewport());

    expect(await screen.findByText("Too large for a thumbnail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
    expect(imageSources()).toEqual([]);
  });

  test("a failure the server won't retry says why and offers no retry", async () => {
    mount(
      tile(
        photo({
          status: "failed",
          kind: "thumbnail",
          sourceRevision: 3,
          failure: "invalidMedia",
          canRetry: false,
        }),
      ),
      createFakeApi({}),
    );

    expect(await screen.findByText("Couldn’t read this file")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  test("a thumbnail that won't load falls back to its placeholder, not the original", async () => {
    mount(tile(photo(ready())), createFakeApi({}));

    act(() => enterViewport());
    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));

    const image = document.querySelector("img");

    if (image === null) throw new Error("Expected the thumbnail.");
    fireEvent.error(image);

    await waitFor(() => expect(imageSources()).toEqual([]));
  });

  test("a new source revision replaces the thumbnail, and clears an earlier load failure", async () => {
    const next = "/api/storage/derivatives/photo_1/artifact_9?revision=4";
    const view = mount(tile(photo(ready())), createFakeApi({}));

    act(() => enterViewport());
    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));

    const image = document.querySelector("img");

    if (image === null) throw new Error("Expected the thumbnail.");
    fireEvent.error(image);
    await waitFor(() => expect(imageSources()).toEqual([]));

    view.rerender(tile(photo(ready(next, 4))));
    await waitFor(() => expect(imageSources()).toEqual([next]));
  });

  test("a replaced source that's still being prepared doesn't keep showing the old thumbnail", async () => {
    const view = mount(tile(photo(ready())), createFakeApi({}));

    act(() => enterViewport());
    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));

    view.rerender(tile(photo({ status: "queued", kind: "thumbnail", sourceRevision: 4 })));

    expect(
      await screen.findByRole("button", { name: "one.png. Preparing thumbnail." }),
    ).toBeTruthy();
    expect(imageSources()).toEqual([]);
  });

  test("ready thumbnails share the same limit on images loading at once", async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      photo(ready(`/api/storage/derivatives/photo_${index}/a?revision=1`, 1), {
        id: `photo_${index}`,
        name: `${index}.png`,
      }),
    );

    mount(
      <ul>
        {items.map((item) => (
          <PhotoTile key={item.id} item={item} onOpen={() => {}} />
        ))}
      </ul>,
      createFakeApi({}),
    );

    act(() => enterViewport());

    const waiting = () =>
      document.querySelectorAll('[data-slot="media-tile-image"][data-state="waiting"]');

    await waitFor(() => expect(imageSources()).toHaveLength(6));
    // A ready tile behind the limit says its image is coming, unlike one with nothing to show.
    expect(waiting()).toHaveLength(2);

    const first = document.querySelector("img");

    if (first === null) throw new Error("Expected a thumbnail.");
    fireEvent.load(first);

    await waitFor(() => expect(imageSources()).toHaveLength(7));
    expect(waiting()).toHaveLength(1);
  });
});

describe("retrying a thumbnail", () => {
  const FAILED: MediaDerivative = {
    status: "failed",
    kind: "thumbnail",
    sourceRevision: 3,
    failure: "timeout",
    canRetry: true,
  };

  test("nothing is retried until asked, and asking doesn't open the photo", async () => {
    const opened: string[] = [];

    const api = createFakeApi({
      "media.retry": () => ({ status: "queued", kind: "thumbnail", sourceRevision: 3 }),
    });

    mount(
      tile(photo(FAILED), (id) => opened.push(id)),
      api,
    );

    const retry = await screen.findByRole("button", { name: "Retry thumbnail of one.png" });

    expect(screen.getByText("Thumbnail took too long")).toBeTruthy();
    expect(api.calls).toHaveLength(0);

    fireEvent.click(retry);

    await waitFor(() => expect(api.callsTo("media.retry")).toHaveLength(1));
    expect(api.callsTo("media.retry")[0]?.input).toEqual({ id: "photo_1" });
    expect(opened).toEqual([]);
  });

  test("the timeline learns the new state from one refetch, and keyboard focus stays on the tile", async () => {
    let current = photo(FAILED);

    const api = createFakeApi({
      "photos.timeline": () => timelinePage([current]),
      "media.retry": () => {
        current = photo({ status: "queued", kind: "thumbnail", sourceRevision: 3 });

        return { status: "queued", kind: "thumbnail", sourceRevision: 3 };
      },
    });

    mount(<MountedTimeline />, api);

    const retry = await screen.findByRole("button", { name: "Retry thumbnail of one.png" });

    expect(api.callsTo("photos.timeline")).toHaveLength(1);

    act(() => retry.focus());
    fireEvent.click(retry);

    const tileButton = await screen.findByRole("button", {
      name: "one.png. Preparing thumbnail.",
    });

    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
    expect(document.activeElement).toBe(tileButton);
    expect(api.callsTo("photos.timeline")).toHaveLength(2);
    expect(api.callsTo("media.retry")).toHaveLength(1);
    expect(api.callsTo("media.get")).toHaveLength(0);
  });

  test("a press is blocked while one is on its way, and focus stays on the control", async () => {
    const reply = deferred<object>();
    const api = createFakeApi({ "media.retry": () => reply.promise });

    mount(tile(photo(FAILED)), api);

    const retry = await screen.findByRole("button", { name: "Retry thumbnail of one.png" });

    act(() => retry.focus());
    fireEvent.click(retry);

    await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(retry);
    expect(api.callsTo("media.retry")).toHaveLength(1);
    expect(document.activeElement).toBe(retry);

    await act(async () => {
      reply.resolve({ status: "queued", kind: "thumbnail", sourceRevision: 3 });
      await reply.promise;
    });
  });

  test("a refused retry says so and can be pressed again", async () => {
    const api = createFakeApi({
      "media.retry": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    mount(tile(photo(FAILED)), api);

    const retry = await screen.findByRole("button", { name: "Retry thumbnail of one.png" });

    fireEvent.click(retry);

    expect(await screen.findByText("Couldn’t retry")).toBeTruthy();
    expect(screen.queryByText("Thumbnail took too long")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Couldn’t retry the thumbnail of one.png.");
    expect(screen.getByRole("button", { name: "Retry thumbnail of one.png" })).toBeTruthy();
  });

  test("only the tile holding the collection's tab stop has a tabbable retry", async () => {
    const second = photo(FAILED, { id: "photo_2", name: "two.png" });

    mount(
      <MountedTimeline />,
      createFakeApi({ "photos.timeline": () => timelinePage([photo(FAILED), second]) }),
    );

    const first = await screen.findByRole("button", { name: "Retry thumbnail of one.png" });
    const other = screen.getByRole("button", { name: "Retry thumbnail of two.png" });

    expect(first.getAttribute("tabindex")).toBe("0");
    expect(other.getAttribute("tabindex")).toBe("-1");
  });

  test("the context-menu keys don't start a retry nobody asked for", async () => {
    const api = createFakeApi({ "photos.timeline": () => timelinePage([photo(FAILED)]) });

    mount(<MountedTimeline />, api);

    const tileButton = await screen.findByRole("button", {
      name: "one.png. Thumbnail took too long.",
    });

    fireEvent.keyDown(tileButton, { key: "ContextMenu" });
    fireEvent.keyDown(tileButton, { key: "F10", shiftKey: true });

    expect(api.callsTo("media.retry")).toHaveLength(0);
  });
});

describe("the timeline with server thumbnails", () => {
  test("one timeline read supplies every tile's state, with no request per tile", async () => {
    const api = createFakeApi({
      "photos.timeline": () =>
        timelinePage([
          photo(ready()),
          photo(
            { status: "queued", kind: "thumbnail", sourceRevision: 1 },
            {
              id: "photo_2",
              name: "two.png",
            },
          ),
          clip({
            status: "failed",
            kind: "poster",
            sourceRevision: 1,
            failure: "busy",
            canRetry: true,
          }),
        ]),
    });

    mount(<MountedTimeline />, api);

    expect(
      await screen.findByRole("button", { name: "two.png. Preparing thumbnail." }),
    ).toBeTruthy();
    expect(screen.getByText("Server was busy")).toBeTruthy();
    act(() => enterViewport());
    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));
    expect(api.calls.map((call) => call.operation)).toEqual(["photos.timeline"]);
  });

  test("a refresh that finds a finished thumbnail swaps it in, without touching the original", async () => {
    let current = photo({ status: "queued", kind: "thumbnail", sourceRevision: 3 });
    const api = createFakeApi({ "photos.timeline": () => timelinePage([current]) });
    const view = mount(<MountedTimeline />, api);

    expect(
      await screen.findByRole("button", { name: "one.png. Preparing thumbnail." }),
    ).toBeTruthy();
    act(() => enterViewport());
    expect(imageSources()).toEqual([]);

    current = photo(ready());
    await view.refetchActive();

    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));
    expect(screen.queryByRole("button", { name: "one.png. Preparing thumbnail." })).toBeNull();
    expect(api.callsTo("photos.timeline")).toHaveLength(2);
  });

  test("refreshing to the same state keeps the loaded image, so it isn't fetched again", async () => {
    const api = createFakeApi({ "photos.timeline": () => timelinePage([photo(ready())]) });
    const view = mount(<MountedTimeline />, api);

    await screen.findByRole("button", { name: "one.png" });
    act(() => enterViewport());
    await waitFor(() => expect(imageSources()).toEqual([THUMBNAIL]));

    const loaded = document.querySelector("img");

    await view.refetchActive();

    expect(api.callsTo("photos.timeline")).toHaveLength(2);
    expect(document.querySelector("img")).toBe(loaded);
  });

  test("a job that fails while waiting gains its retry on refresh, with keyboard focus undisturbed", async () => {
    let current = photo({ status: "processing", kind: "thumbnail", sourceRevision: 3 });
    const api = createFakeApi({ "photos.timeline": () => timelinePage([current]) });
    const view = mount(<MountedTimeline />, api);

    const tileButton = await screen.findByRole("button", {
      name: "one.png. Preparing thumbnail.",
    });

    act(() => tileButton.focus());

    current = photo({
      status: "failed",
      kind: "thumbnail",
      sourceRevision: 3,
      failure: "unavailable",
      canRetry: true,
    });
    await view.refetchActive();

    expect(await screen.findByRole("button", { name: "Retry thumbnail of one.png" })).toBeTruthy();
    expect(document.activeElement).toBe(tileButton);
    expect(tileButton.getAttribute("aria-label")).toBe("one.png. Thumbnail unavailable.");
    expect(api.callsTo("media.retry")).toHaveLength(0);
  });

  test("opening a tile with a thumbnail shows the original full size, not the thumbnail", async () => {
    const api = createFakeApi({ "photos.timeline": () => timelinePage([photo(ready())]) });

    mount(<MountedTimeline />, api);

    fireEvent.click(await screen.findByRole("button", { name: "one.png" }));

    await waitFor(() => {
      const shown = screen
        .getAllByRole("dialog")
        .flatMap((dialog) => [...dialog.querySelectorAll("img")]);

      expect(shown.map((image) => image.getAttribute("src"))).toEqual([ORIGINAL]);
    });
  });

  test("opening a video tile with a poster plays the original stream", async () => {
    const stream = "/api/storage/previews/clip_1?revision=1";

    const api = createFakeApi({
      "photos.timeline": () =>
        timelinePage([
          clip({
            status: "ready",
            kind: "poster",
            sourceRevision: 1,
            url: "/api/storage/derivatives/clip_1/a?revision=1",
            width: 256,
            height: 144,
          }),
        ]),
    });

    mount(<MountedTimeline />, api);

    fireEvent.click(await screen.findByRole("button", { name: "clip.mp4. Video." }));

    await waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toBe(stream));
  });

  test("a failing tile's status can't be read as an unopenable photo", async () => {
    const api = createFakeApi({
      "photos.timeline": () =>
        timelinePage([
          photo({
            status: "unsupported",
            kind: "thumbnail",
            sourceRevision: 3,
            failure: "unsupported",
          }),
        ]),
    });

    mount(<MountedTimeline />, api);

    fireEvent.click(
      await screen.findByRole("button", { name: "one.png. No thumbnail for this format." }),
    );

    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBeGreaterThan(0));
    expect(api.callsTo("media.retry")).toHaveLength(0);
  });
});

describe("the bar's summary of a backlog", () => {
  const QUEUED: MediaDerivative = { status: "queued", kind: "thumbnail", sourceRevision: 1 };
  const SOURCES = { allMyFiles: true, folderIds: [] };

  const named = (index: number, derivative: MediaDerivative) =>
    photo(derivative, { id: `photo_${index}`, name: `${index}.png` });

  function screenAt(section: "photos") {
    return (
      <CloudNavigationProvider location={{ section }} onNavigate={() => {}}>
        <PhotosScreen />
      </CloudNavigationProvider>
    );
  }

  test("one line in the bar, and every waiting tile keeps its state in its label alone", async () => {
    const api = createFakeApi({
      "photos.sources": () => SOURCES,
      "photos.timeline": () =>
        timelinePage([named(1, QUEUED), named(2, QUEUED), named(3, ready())]),
    });

    mount(screenAt("photos"), api);

    expect(await screen.findByText("Preparing thumbnails for 2 of 3 loaded items")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1.png. Preparing thumbnail." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2.png. Preparing thumbnail." })).toBeTruthy();
    expect(screen.queryByText("Preparing thumbnail")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(api.calls.map((call) => call.operation).toSorted()).toEqual([
      "photos.sources",
      "photos.timeline",
    ]);
  });

  test("it counts only what's loaded, even when the server has more pages", async () => {
    const api = createFakeApi({
      "photos.sources": () => SOURCES,
      "photos.timeline": () => ({ ...timelinePage([named(1, QUEUED)]), nextCursor: "more" }),
    });

    mount(screenAt("photos"), api);

    expect(await screen.findByText("Preparing a thumbnail for 1 of 1 loaded item")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
    expect(api.callsTo("photos.timeline")).toHaveLength(1);
  });

  test("it follows the timeline's own reads, and leaves when nothing is on its way", async () => {
    let items = [named(1, QUEUED), named(2, QUEUED)];

    const api = createFakeApi({
      "photos.sources": () => SOURCES,
      "photos.timeline": () => timelinePage(items),
    });

    const view = mount(screenAt("photos"), api);

    await screen.findByText("Preparing thumbnails for 2 of 2 loaded items");

    items = [named(1, ready()), named(2, QUEUED)];
    await view.refetchActive();
    await screen.findByText("Preparing a thumbnail for 1 of 2 loaded items");

    items = [named(1, ready()), named(2, ready("/api/storage/derivatives/2/a?revision=1", 1))];
    await view.refetchActive();

    await waitFor(() => expect(screen.queryByText(/loaded item/)).toBeNull());
    expect(api.callsTo("media.get")).toHaveLength(0);
    expect(api.callsTo("media.retry")).toHaveLength(0);
  });

  test("failures stay on their own tiles, and aren't counted as waiting", async () => {
    const api = createFakeApi({
      "photos.sources": () => SOURCES,
      "photos.timeline": () =>
        timelinePage([
          named(1, QUEUED),
          named(2, {
            status: "failed",
            kind: "thumbnail",
            sourceRevision: 1,
            failure: "busy",
            canRetry: true,
          }),
        ]),
    });

    mount(screenAt("photos"), api);

    expect(await screen.findByText("Preparing a thumbnail for 1 of 2 loaded items")).toBeTruthy();
    expect(screen.getByText("Server was busy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry thumbnail of 2.png" })).toBeTruthy();
  });

  test("nothing shows while the timeline loads, or for a server that sends no state", async () => {
    const pending = deferred<object>();

    const api = createFakeApi({
      "photos.sources": () => SOURCES,
      "photos.timeline": () => pending.promise,
    });

    mount(screenAt("photos"), api);

    await waitFor(() => expect(api.callsTo("photos.timeline")).toHaveLength(1));
    expect(screen.queryByText(/loaded item/)).toBeNull();

    await act(async () => {
      pending.resolve(timelinePage([photo()]));
      await pending.promise;
    });

    await screen.findByRole("button", { name: "one.png" });
    expect(screen.queryByText(/loaded item/)).toBeNull();
  });

  test("an album gets the same summary, about its own loaded items", async () => {
    const api = createFakeApi({
      "photos.albums": () => ({ items: [] }),
      "photos.timeline": () => timelinePage([named(1, QUEUED)]),
    });

    mount(
      <CloudNavigationProvider location={{ section: "album", albumId: "a" }} onNavigate={() => {}}>
        <AlbumScreen albumId="a" />
      </CloudNavigationProvider>,
      api,
    );

    expect(await screen.findByText("Preparing a thumbnail for 1 of 1 loaded item")).toBeTruthy();
    expect(api.callsTo("photos.timeline")[0]?.input).toMatchObject({ albumId: "a" });
  });
});
