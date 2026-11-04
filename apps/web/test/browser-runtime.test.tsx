import { expect, test } from "bun:test";
import type { Client, FetchCapability, FileEntry } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { Schema } from "@hyori-cloud/lib/effect";
import { useQuery, useQueryClient } from "@hyori-cloud/lib/query";
import { RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { getAppRuntime } from "@/app/runtime";
import { getRouter } from "@/router";
import { Route as IndexRoute } from "@/routes/index";
import { Route as SplatRoute } from "@/routes/$";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
);

const decodeFolder = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }));

function fakeHttp() {
  const calls: string[] = [];
  const fileRequests: string[] = [];
  const folders: FileEntry[] = [];
  const listing = Promise.withResolvers<void>();

  const fetch: FetchCapability = async (url, init) => {
    expect(String(url)).toBe("/api/rpc");
    const request = decodeRequest(await new Response(init?.body).json());

    calls.push(request.operation);

    switch (request.operation) {
      case "auth.status":
        return Response.json({
          ok: true,
          value: {
            initialized: true,
            user: {
              id: "user_1",
              name: "Ada",
              email: "ada@example.com",
              role: "user",
              quotaBytes: 1024,
              usedBytes: 0,
            },
          },
        });
      case "files.list":
        fileRequests.push(JSON.stringify(request.input));
        await listing.promise;

        return Response.json({
          ok: true,
          value: { items: folders, folder: null, breadcrumbs: [], nextCursor: null },
        });
      case "files.createFolder": {
        const { name } = decodeFolder(request.input);

        const folder: FileEntry = {
          id: "folder_1",
          name,
          kind: "folder",
          parentId: null,
          ownerId: "user_1",
          size: 0,
          mimeType: "inode/directory",
          createdAt: "2026-11-04T00:00:00Z",
          updatedAt: "2026-11-04T00:00:00Z",
          trashedAt: null,
          access: {
            role: null,
            isOwner: true,
            canDownload: true,
            canUpload: true,
            canEdit: true,
            canDelete: true,
            canShare: true,
          },
        };

        folders.push(folder);

        return Response.json({ ok: true, value: folder });
      }

      case "photos.sources":
        return Response.json({ ok: true, value: { allMyFiles: true, folderIds: [] } });
      case "photos.timeline":
        return Response.json({
          ok: true,
          value: { items: [], folder: null, breadcrumbs: [], nextCursor: null },
        });
      default:
        throw new Error(`Unscripted operation: ${request.operation}`);
    }
  };

  return { calls, fetch, fileRequests, releaseListings: listing.resolve };
}

type Seen = { sdkClient: Client; queryClient: ReturnType<typeof useQueryClient> };

const seen = new Map<string, Seen>();

function FilesConsumer() {
  const sdkClient = useClientSDK();
  const queryClient = useQueryClient();
  const files = useQuery(sdkClient.query.files.list.getOptions({ parentId: null }));

  seen.set("files", { sdkClient, queryClient });

  return (
    <output aria-label="Files consumer">
      {files.data?.items.map((entry) => entry.name).join(",") ?? "pending"}
    </output>
  );
}

function PhotosConsumer() {
  const sdkClient = useClientSDK();
  const queryClient = useQueryClient();
  const files = useQuery(sdkClient.query.files.list.getOptions({ parentId: null }));
  const sources = useQuery(sdkClient.query.photos.sources.getOptions({}));

  seen.set("photos", { sdkClient, queryClient });

  return (
    <output aria-label="Photos consumer">
      {sources.data === undefined || files.data === undefined
        ? "pending"
        : files.data.items.map((entry) => entry.name).join(",")}
    </output>
  );
}

// Decorate the existing route content only. The real router, generated tree, document root,
// provider composition, runtime and product screens all execute unchanged beneath it.
const IndexPage = IndexRoute.options.component!;
const SplatPage = SplatRoute.options.component!;

function InstrumentedIndex() {
  return (
    <>
      <IndexPage />
      <FilesConsumer />
      <PhotosConsumer />
    </>
  );
}

function InstrumentedSplat() {
  return (
    <>
      <SplatPage />
      <FilesConsumer />
      <PhotosConsumer />
    </>
  );
}

test("actual app root shares SDK/cache across features, invalidation and real route navigation", async () => {
  const api = fakeHttp();
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { fetch: api.fetch });
  IndexRoute.update({ component: InstrumentedIndex });
  SplatRoute.update({ component: InstrumentedSplat });
  const router = getRouter();
  const runtime = router.options.context;
  const root = createRoot(document);

  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    await waitFor(() => {
      expect(within(document.body).getByLabelText("Files consumer").textContent).toBe("pending");
      expect(within(document.body).getByLabelText("Photos consumer").textContent).toBe("pending");
      expect(api.fileRequests.filter((input) => input === '{"parentId":null}')).toHaveLength(1);
    });
    await act(async () => {
      api.releaseListings();
    });
    await waitFor(() => {
      expect(within(document.body).getByLabelText("Files consumer").textContent).toBe("");
      expect(within(document.body).getByLabelText("Photos consumer").textContent).toBe("");
      expect(within(document.body).getAllByRole("button", { name: "New folder" })[0]!).toBeTruthy();
    });

    for (const value of seen.values()) {
      expect(value.sdkClient).toBe(runtime.sdkClient);
      expect(value.queryClient).toBe(runtime.queryClient);
    }

    expect(seen.size).toBe(2);
    const sharedKey = runtime.sdkClient.query.files.list.getOptions({ parentId: null }).queryKey;

    const sharedQuery = runtime.queryClient
      .getQueryCache()
      .find({ queryKey: sharedKey, exact: true });

    expect(sharedQuery?.getObserversCount()).toBe(2);
    const fileReads = api.calls.filter((operation) => operation === "files.list").length;
    const sourceReads = api.calls.filter((operation) => operation === "photos.sources").length;

    await act(async () => {
      fireEvent.click(within(document.body).getAllByRole("button", { name: "New folder" })[0]!);
    });
    const dialog = await within(document.body).findByRole("dialog");
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Pictures" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    });
    await waitFor(() => {
      expect(within(document.body).getByLabelText("Files consumer").textContent).toBe("Pictures");
      expect(within(document.body).getByLabelText("Photos consumer").textContent).toBe("Pictures");
      expect(within(document.body).getByRole("link", { name: /^Pictures/ })).toBeTruthy();
    });
    expect(api.calls.filter((operation) => operation === "files.createFolder")).toHaveLength(1);
    expect(api.fileRequests.filter((input) => input === '{"parentId":null}')).toHaveLength(2);
    expect(api.calls.filter((operation) => operation === "files.list").length).toBeGreaterThan(
      fileReads,
    );
    expect(api.calls.filter((operation) => operation === "photos.sources").length).toBeGreaterThan(
      sourceReads,
    );
    const readsAfterMutation = api.calls.filter((operation) => operation === "files.list").length;

    await act(async () => {
      fireEvent.click(within(document.body).getAllByRole("button", { name: /Ada/ })[0]!);
    });
    const appearance = await within(document.body).findByRole("menuitemradio", { name: "Dark" });
    await act(async () => fireEvent.click(appearance));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(localStorage.getItem("hyori-appearance")).toBe("dark");
    expect(getAppRuntime()).toBe(runtime);
    expect(sharedQuery?.getObserversCount()).toBe(2);
    expect(runtime.queryClient.getQueryCache().find({ queryKey: sharedKey, exact: true })).toBe(
      sharedQuery,
    );
    expect(api.calls.filter((operation) => operation === "files.list")).toHaveLength(
      readsAfterMutation,
    );

    seen.clear();
    await act(async () => {
      await router.navigate({ to: "/$", params: { _splat: "photos" } });
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("No photos found yet");
      expect(seen.size).toBe(2);
    });
    expect(router.state.location.pathname).toBe("/photos");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(getAppRuntime()).toBe(runtime);
    const anotherRouter = getRouter();

    expect(anotherRouter.options.context).toBe(runtime);
    anotherRouter.history.destroy();

    for (const value of seen.values()) {
      expect(value.sdkClient).toBe(runtime.sdkClient);
      expect(value.queryClient).toBe(runtime.queryClient);
    }

    seen.clear();
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await waitFor(() => {
      expect(within(document.body).getAllByRole("button", { name: "New folder" })[0]!).toBeTruthy();
      expect(seen.size).toBe(2);
    });

    for (const value of seen.values()) {
      expect(value.sdkClient).toBe(runtime.sdkClient);
      expect(value.queryClient).toBe(runtime.queryClient);
    }

    expect(router.state.location.pathname).toBe("/");
    expect(runtime.queryClient.getQueryCache().find({ queryKey: sharedKey, exact: true })).toBe(
      sharedQuery,
    );
    expect(api.calls.filter((operation) => operation === "files.list")).toHaveLength(
      readsAfterMutation,
    );
    expect(api.calls.filter((operation) => operation === "auth.status")).toHaveLength(1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    runtime.queryClient.clear();
    runtime.sdkClient.dispose();
    router.history.destroy();
    IndexRoute.update({ component: IndexPage });
    SplatRoute.update({ component: SplatPage });
    Object.assign(globalThis, { fetch: originalFetch });
    seen.clear();
  }
}, 30_000);
