import { afterAll, describe, expect } from "bun:test";
import type { EditorDocument } from "@hyori-cloud/client-sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createNavigationGuard } from "#features/cloud/navigation-guard.ts";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import {
  act,
  ApiFailure,
  createFakeApi,
  fileEntry,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";
import type { FakeApi, RequestInput } from "#features-test/mounted.tsx";

/**
 * The web build runs React Compiler and these tests otherwise don't, and it can change behavior: a
 * value read from a stable object in render gets cached against that object forever. So this mounts
 * the real screen after the same compiler the production build applies.
 */
const SOURCE = join(import.meta.dir, "../src/editors/react/editor-screen.tsx");
const webRequire = createRequire(join(import.meta.dir, "../../../apps/web/package.json"));

type CompileOptions = {
  readonly filename: string;
  readonly babelrc: boolean;
  readonly configFile: boolean;
  readonly parserOpts: { readonly plugins: readonly string[] };
  readonly plugins: readonly (readonly [string, Record<string, never>])[];
};

// SAFETY: Babel's documented entry point, from the version the web build pins. It has no types here,
// and a wrong shape fails this suite at once.
const { transformAsync } = webRequire("@babel/core") as {
  transformAsync: (source: string, options: CompileOptions) => Promise<{ code: string } | null>;
};

const compiled = await transformAsync(readFileSync(SOURCE, "utf8"), {
  filename: SOURCE,
  babelrc: false,
  configFile: false,
  parserOpts: { plugins: ["typescript", "jsx"] },
  plugins: [[webRequire.resolve("babel-plugin-react-compiler"), {}]],
});

if (compiled === null) throw new Error("The compiler returned nothing.");

// Beside the sources' package, so its private imports resolve as they do in the real file.
const buildDirectory = join(import.meta.dir, ".compiled");

mkdirSync(buildDirectory, { recursive: true });

const directory = mkdtempSync(join(buildDirectory, "editor-screen-"));
const compiledPath = join(directory, "editor-screen.tsx");

writeFileSync(compiledPath, compiled.code);

afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

// SAFETY: The same module as the one this type names, after a compiler that doesn't change exports.
const { EditorScreen } = (await import(
  compiledPath
)) as typeof import("#features/editors/react/editor-screen.tsx");

const DOCUMENT = {
  sessionId: "session_1",
  app: "wordcraft",
  bridge: "upstream-host-parent",
  protocol: null,
  version: "0.14.0",
  name: "report.docx",
  revision: "3",
  writable: true,
  maxBytes: 1024 * 1024,
  replacementName: "report.docx",
  outputFormats: [{ extension: ".docx", kind: "document" }],
  assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
} satisfies EditorDocument;

const DOWNLOAD = { name: "Download my version" };

type EditorMessage = {
  readonly type: string;
  readonly version?: string;
  readonly name?: string;
  readonly saveAs?: boolean;
  readonly bytes?: Uint8Array;
};

function apiFor(handlers: Record<string, (input: RequestInput) => object | Promise<object>>) {
  return createFakeApi({
    "editors.open": () => DOCUMENT,
    "editors.download": () => ({
      url: "/api/storage/editors/session_1?revision=3",
      name: "report.docx",
      size: 10,
      mimeType: "application/octet-stream",
    }),
    "files.get": () => fileEntry({ id: "file_1", name: "report.docx", parentId: null }),
    ...handlers,
  });
}

/** Opened and clean, then saved once, with the only render before it having nothing pending. */
async function openAndSave(api: FakeApi) {
  const view = mount(
    <CloudNavigationProvider
      location={{ section: "editor", fileId: "file_1" }}
      onNavigate={() => {}}
      navigationGuard={createNavigationGuard()}
    >
      <EditorScreen
        fileId="file_1"
        copyDestination={{ kind: "folder", folderId: null }}
        closePath={() => "/"}
      />
    </CloudNavigationProvider>,
    api,
  );

  const editorWindow = view.container.querySelector("iframe")?.contentWindow ?? null;

  Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

  const fromEditor = (data: EditorMessage) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: window.location.origin,
          source: editorWindow,
        }),
      ),
    );

  await screen.findByText(DOCUMENT.name);
  fromEditor({ type: "wordcraft:ready", version: "0.14.0" });
  await screen.findByText("All changes saved");
  expect(screen.queryByRole("button", DOWNLOAD)).toBeNull();

  fromEditor({
    type: "wordcraft:save",
    name: "report.docx",
    saveAs: false,
    bytes: new TextEncoder().encode("edited"),
  });
}

describe("recovering unsaved work, after the production compiler", () => {
  test("this really is compiled output, or nothing here would mean anything", () => {
    expect(compiled.code).toContain("react/compiler-runtime");
  });

  test("a conflict offers the bytes, though nothing was pending when it first drew", async () => {
    await openAndSave(
      apiFor({
        "editors.prepareSave": () => {
          throw new ApiFailure("resource.conflict");
        },
      }),
    );

    await screen.findByText("Not saved: changed elsewhere");
    expect(screen.getByRole("button", DOWNLOAD)).toBeTruthy();
  });

  test("a failed save offers the bytes beside Retry", async () => {
    await openAndSave(
      apiFor({
        "editors.prepareSave": () => {
          throw new ApiFailure("service.unavailable");
        },
      }),
    );

    await screen.findByText("Not saved");
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
    expect(screen.getByRole("button", DOWNLOAD)).toBeTruthy();
  });

  test("the offer goes once a retry has saved them, so it follows the session both ways", async () => {
    const saved = fileEntry({ id: "file_1", name: "report.docx", parentId: null });

    const uploading = {
      uploadId: "upload_1",
      chunkSize: 1024,
      totalParts: 1,
      parts: [],
      state: "uploading",
      fileId: null,
    };

    let attempts = 0;

    await openAndSave(
      apiFor({
        "editors.prepareSave": () => {
          attempts += 1;

          if (attempts === 1) throw new ApiFailure("service.unavailable");

          return uploading;
        },
        "uploads.status": () => uploading,
        "uploads.part": () => ({ url: "/parts/1", method: "PUT", headers: {} }),
        "uploads.complete": () => saved,
        "editors.completeSave": () => ({ status: "saved", revision: "4", file: saved }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Retry save" }));

    await screen.findByText("All changes saved");
    expect(screen.queryByRole("button", DOWNLOAD)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  });

  test("losing access offers the bytes in the bar and on the cover", async () => {
    await openAndSave(
      apiFor({
        "editors.prepareSave": () => {
          throw new ApiFailure("access.denied");
        },
      }),
    );

    await screen.findByText("You no longer have access to this file");
    await waitFor(() => expect(screen.getAllByRole("button", DOWNLOAD)).toHaveLength(2));
  });
});
