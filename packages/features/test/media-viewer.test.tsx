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
    const api = createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT });

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
    const api = createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT });
    const view = mount(viewer(), api);

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.download"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(screen.getByRole("button", { name: `Download ${PHOTO.name}` }));
    await screen.findByText(/Couldn’t download/);

    view.rerender(viewer([PHOTO, SECOND], SECOND.id));

    await waitFor(() => expect(screen.queryByText(/Couldn’t download/)).toBeNull());
  });

  test("an image the browser can't decode falls back to a message", async () => {
    mount(
      viewer(),
      createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT }),
    );
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    const image = document.querySelector("img");

    if (image === null) throw new Error("The viewer rendered no image.");
    fireEvent.error(image);

    expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("previews and downloads are separate", () => {
  test("showing a file asks for its preview; only the button asks to download", async () => {
    const api = createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT });

    mount(viewer(), api);
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(CONTENT.url),
    );
    expect(api.callsTo("files.preview")).toEqual([
      { operation: "files.preview", input: { id: PHOTO.id } },
    ]);
    expect(api.callsTo("files.download")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: `Download ${PHOTO.name}` }));
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(1));
    expect(api.callsTo("files.preview")).toHaveLength(1);
  });

  test("a type the server won't show inline says so, with no retry that couldn't work", async () => {
    const api = createFakeApi({
      "files.preview": () => {
        throw new ApiFailure("input.invalid", "Invalid request input");
      },
    });

    mount(viewer(), api);

    await screen.findByText("This can’t be previewed here. You can still download it.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: `Download ${PHOTO.name}` })).toBeTruthy();
  });

  test("someone who can't download isn't told they can", async () => {
    const api = createFakeApi({
      "files.preview": () => {
        throw new ApiFailure("input.invalid");
      },
    });

    const noDownload = { ...PHOTO, access: { ...PHOTO.access, canDownload: false } };

    mount(viewer([noDownload]), api);

    await screen.findByText("This can’t be previewed here.");
    expect(screen.queryByRole("button", { name: `Download ${PHOTO.name}` })).toBeNull();
  });

  test("a video this browser can't play offers the download instead", async () => {
    mount(
      <MediaViewer
        items={[CLIP]}
        itemId={CLIP.id}
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
      createFakeApi({ "files.preview": () => ({ ...CONTENT, mimeType: CLIP.mimeType }) }),
    );

    const video = await waitFor(() => {
      const found = document.querySelector("video");

      if (found === null) throw new Error("The viewer rendered no video.");

      return found;
    });

    fireEvent.error(video);
    await screen.findByText("This can’t be previewed here. You can still download it.");
  });

  test("access that ended replaces an earlier preview, and comes back through recovery", async () => {
    const api = createFakeApi({ "files.preview": () => CONTENT });
    const view = mount(viewer(), api);

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.preview"] = () => {
      throw new ApiFailure("resource.notFound");
    };

    await view.refetchActive();

    await screen.findByText("This is no longer here");
    expect(document.querySelector("img")).toBeNull();

    api.handlers["files.preview"] = () => CONTENT;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
  });

  test("a share revoked from this account stops showing what was already open", async () => {
    const api = createFakeApi({ "files.preview": () => CONTENT });
    const view = mount(viewer(), api);

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.preview"] = () => {
      throw new ApiFailure("access.denied");
    };

    await view.refetchActive();

    await screen.findByText("You don’t have access to this");
    expect(document.querySelector("img")).toBeNull();
  });

  test("a new preview URL for the same file replaces the image and clears its failure", async () => {
    const first = { ...CONTENT, url: "/content/photo_1?revision=1" };
    const second = { ...CONTENT, url: "/content/photo_1?revision=2" };
    const api = createFakeApi({ "files.preview": () => first });
    const view = mount(viewer(), api);

    const image = await waitFor(() => {
      const found = document.querySelector("img");

      if (found === null) throw new Error("The viewer rendered no image.");

      return found;
    });

    expect(image.getAttribute("src")).toBe(first.url);
    fireEvent.error(image);
    await screen.findByText(/This can’t be previewed here/);

    api.handlers["files.preview"] = () => second;
    await view.refetchActive();

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(second.url),
    );
    expect(screen.queryByText(/This can’t be previewed here/)).toBeNull();
  });

  test("a brief failure keeps showing what's already on screen", async () => {
    const api = createFakeApi({ "files.preview": () => CONTENT });
    const view = mount(viewer(), api);

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    api.handlers["files.preview"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    await view.refetchActive();

    expect(document.querySelector("img")).not.toBeNull();
    expect(screen.queryByText(/can’t reach its services/)).toBeNull();
  });
});

describe("photo tiles", () => {
  function tile(item = PHOTO, previewUrl = `/content/${item.id}`) {
    return <PhotoTile key={item.id} item={{ ...item, previewUrl }} onOpen={() => {}} />;
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

  test("a new URL from the server for the same photo replaces the old one, with no request", async () => {
    const api = createFakeApi({});
    const view = mount(tile(PHOTO, "/content/photo_1?revision=1"), api);

    act(() => enterViewport());
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "/content/photo_1?revision=1",
      ),
    );

    view.rerender(tile(PHOTO, "/content/photo_1?revision=2"));

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "/content/photo_1?revision=2",
      ),
    );
    expect(api.calls).toHaveLength(0);
  });

  test("an earlier failure says nothing about the server's next URL", async () => {
    const view = mount(tile(PHOTO, "/content/photo_1?revision=1"), createFakeApi({}));

    act(() => enterViewport());

    const failing = await waitFor(() => {
      const found = document.querySelector("img");

      if (found === null) throw new Error("No image yet.");

      return found;
    });

    fireEvent.error(failing);
    await waitFor(() => expect(document.querySelector("img")).toBeNull());

    view.rerender(tile(PHOTO, "/content/photo_1?revision=2"));

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(
        "/content/photo_1?revision=2",
      ),
    );
  });

  test("a new URL waits its turn like any other load", async () => {
    const photos = Array.from({ length: 7 }, (_, index) =>
      fileEntry({ id: `photo_${index}`, name: `${index}.png`, mimeType: "image/png" }),
    );

    const row = (firstUrl: string) => (
      <>{photos.map((photo, index) => (index === 0 ? tile(photo, firstUrl) : tile(photo)))}</>
    );

    const view = mount(row("/content/first?revision=1"), createFakeApi({}));
    const loaded = () => document.querySelectorAll("img");
    const withSource = (url: string) => document.querySelector(`img[src="${url}"]`);

    act(() => enterViewport());
    await waitFor(() => expect(loaded()).toHaveLength(6));

    const finished = withSource("/content/first?revision=1");

    if (finished === null) throw new Error("The first tile has no image.");
    fireEvent.load(finished);
    await waitFor(() => expect(withSource("/content/photo_6")).not.toBeNull());

    // Six are loading again, so the finished tile's new URL can't jump the line.
    view.rerender(row("/content/first?revision=2"));
    await waitFor(() => expect(withSource("/content/first?revision=1")).toBeNull());
    expect(withSource("/content/first?revision=2")).toBeNull();

    const next = withSource("/content/photo_1");

    if (next === null) throw new Error("The second tile has no image.");
    fireEvent.load(next);
    await waitFor(() => expect(withSource("/content/first?revision=2")).not.toBeNull());
  });

  test("only a few load at a time, and each one finishing lets the next begin", async () => {
    const photos = Array.from({ length: 9 }, (_, index) =>
      fileEntry({ id: `photo_${index}`, name: `${index}.png`, mimeType: "image/png" }),
    );

    mount(<>{photos.map((photo) => tile(photo))}</>, createFakeApi({}));
    act(() => enterViewport());

    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(6));

    const [first, second] = document.querySelectorAll("img");

    if (first === undefined || second === undefined) throw new Error("No images yet.");
    fireEvent.load(first);
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(7));

    // A failure frees its turn too, and a tile that finished stays where it is.
    fireEvent.error(second);
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(7));
    expect(first.isConnected).toBe(true);
  });

  test("a tile that leaves gives up its turn", async () => {
    const photos = Array.from({ length: 7 }, (_, index) =>
      fileEntry({ id: `photo_${index}`, name: `${index}.png`, mimeType: "image/png" }),
    );

    const view = mount(<>{photos.map((photo) => tile(photo))}</>, createFakeApi({}));

    act(() => enterViewport());
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(6));

    view.rerender(<>{photos.slice(1).map((photo) => tile(photo))}</>);

    await waitFor(() =>
      expect(document.querySelector('img[src="/content/photo_6"]')).not.toBeNull(),
    );
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

describe("opening and moving through photos", () => {
  const WITH_PREVIEWS = [
    { ...PHOTO, previewUrl: "/content/one" },
    { ...SECOND, previewUrl: "/content/two" },
    { ...CLIP, previewUrl: "/content/clip" },
    { ...SECOND, id: "photo_3", size: 40 * 1024 * 1024, previewUrl: "/content/huge" },
  ];

  function requestedImages(run: () => void) {
    const original = globalThis.Image;
    const requested: string[] = [];

    class RecordingImage {
      decoding = "";
      set src(url: string) {
        if (url !== "") requested.push(url);
      }
    }

    Object.defineProperty(globalThis, "Image", { configurable: true, value: RecordingImage });
    run();

    return {
      requested,
      restore: () =>
        Object.defineProperty(globalThis, "Image", { configurable: true, value: original }),
    };
  }

  test("a photo with a URL of its own opens without another request", async () => {
    const api = createFakeApi({});

    mount(
      <MediaViewer
        items={WITH_PREVIEWS}
        itemId={PHOTO.id}
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
      api,
    );

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/content/one"),
    );
    expect(api.callsTo("files.preview")).toHaveLength(0);
    expect(api.callsTo("files.download")).toHaveLength(0);
  });

  test("a video with a URL of its own opens without another request either", async () => {
    const api = createFakeApi({});

    mount(
      <MediaViewer
        items={WITH_PREVIEWS}
        itemId={CLIP.id}
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
      api,
    );

    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe("/content/clip"),
    );
    expect(api.calls).toHaveLength(0);
  });

  test("a new URL for the same photo or video updates the open viewer, with no request", async () => {
    const api = createFakeApi({});

    const opened = (itemId: string, revision: number) => (
      <MediaViewer
        items={[
          { ...PHOTO, previewUrl: `/content/one?revision=${revision}` },
          { ...CLIP, previewUrl: `/content/clip?revision=${revision}` },
        ]}
        itemId={itemId}
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />
    );

    const view = mount(opened(PHOTO.id, 1), api);

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/content/one?revision=1"),
    );
    view.rerender(opened(PHOTO.id, 2));
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/content/one?revision=2"),
    );

    view.rerender(opened(CLIP.id, 2));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe("/content/clip?revision=2"),
    );
    view.rerender(opened(CLIP.id, 3));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe("/content/clip?revision=3"),
    );

    expect(api.calls).toHaveLength(0);
  });

  test("a photo's own URL that fails falls back to the file's content URL", async () => {
    const api = createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT });

    mount(
      <MediaViewer
        items={WITH_PREVIEWS}
        itemId={PHOTO.id}
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
      api,
    );

    const image = await waitFor(() => {
      const found = document.querySelector("img");

      if (found === null) throw new Error("The viewer rendered no image.");

      return found;
    });

    fireEvent.error(image);

    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toBe(CONTENT.url),
    );
    expect(api.callsTo("files.preview")).toHaveLength(1);
    expect(api.callsTo("files.download")).toHaveLength(0);
  });

  test("the next image is fetched ahead, but never a video or a very large original", async () => {
    const atStart = requestedImages(() => {
      mount(
        <MediaViewer
          items={WITH_PREVIEWS}
          itemId={PHOTO.id}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />,
        createFakeApi({}),
      );
    });

    await waitFor(() => expect(atStart.requested).toEqual(["/content/two"]));
    atStart.restore();

    const beforeVideo = requestedImages(() => {
      mount(
        <MediaViewer
          items={WITH_PREVIEWS}
          itemId={SECOND.id}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />,
        createFakeApi({}),
      );
    });

    await waitFor(() => expect(beforeVideo.requested).toEqual(["/content/one"]));
    beforeVideo.restore();

    const betweenLarge = requestedImages(() => {
      mount(
        <MediaViewer
          items={WITH_PREVIEWS}
          itemId={CLIP.id}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />,
        createFakeApi({ "files.preview": () => CONTENT, "files.download": () => CONTENT }),
      );
    });

    await waitFor(() => expect(betweenLarge.requested).toEqual(["/content/two"]));
    betweenLarge.restore();
  });
});

describe("swiping between items", () => {
  function stage(onNext: () => void, children = <p>Stage</p>) {
    return (
      <Lightbox open onOpenChange={() => {}} title="Photo" onNext={onNext}>
        {children}
      </Lightbox>
    );
  }

  function swipe(from: Element, startX: number, endX: number, endY = 100) {
    fireEvent.pointerDown(from, {
      pointerType: "touch",
      isPrimary: true,
      clientX: startX,
      clientY: 100,
    });
    fireEvent.pointerUp(from, {
      pointerType: "touch",
      isPrimary: true,
      clientX: endX,
      clientY: endY,
    });
  }

  test("a horizontal swipe on the stage moves to the next item", async () => {
    let moved = 0;

    mount(
      stage(() => (moved += 1)),
      createFakeApi({}),
    );
    swipe(await screen.findByText("Stage"), 300, 100);

    expect(moved).toBe(1);
  });

  test("scrubbing a video isn't a swipe", async () => {
    let moved = 0;

    mount(
      stage(
        () => (moved += 1),
        <video data-testid="clip" aria-label="Clip">
          <track kind="captions" />
        </video>,
      ),
      createFakeApi({}),
    );
    swipe(await screen.findByTestId("clip"), 300, 100);

    expect(moved).toBe(0);
  });

  test("a mostly vertical drag is a pan, not a swipe", async () => {
    let moved = 0;

    mount(
      stage(() => (moved += 1)),
      createFakeApi({}),
    );
    swipe(await screen.findByText("Stage"), 300, 200, 400);

    expect(moved).toBe(0);
  });
});
