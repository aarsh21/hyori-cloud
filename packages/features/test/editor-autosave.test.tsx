import { describe, expect } from "bun:test";
import type { EditorDocument } from "@hyori-cloud/client-sdk";
import { decodeNativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import type { NativeHostCommand, NativeHostEvent } from "@hyori-cloud/client-sdk/editor-runtime";
import { createNavigationGuard } from "#features/cloud/navigation-guard.ts";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import { EditorScreen } from "#features/editors/react/editor-screen.tsx";
import {
  act,
  ApiFailure,
  createFakeApi,
  deferred,
  fileEntry,
  fileList,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";
import type { RequestInput } from "#features-test/mounted.tsx";

type Command<Operation extends string> = Extract<
  NativeHostCommand,
  { type: `${string}:${Operation}` }
>;

const DOCUMENT: EditorDocument = {
  sessionId: "native_1",
  app: "wordcraft",
  bridge: "hyori-correlated-host-v2",
  protocol: 2,
  version: "0.14.0-hyori-host.3",
  name: "Synthetic.docx",
  revision: "3",
  writable: true,
  replacementName: "Synthetic.docx",
  maxBytes: 1024 * 1024,
  outputFormats: [{ extension: ".docx", kind: "document" }],
  assetUrl: "/artcraft/wordcraft/0.14.0-hyori-host.3/index.html?host=parent",
};

const UPLOADING = {
  uploadId: "upload_1",
  chunkSize: 1024,
  totalParts: 1,
  parts: [],
  state: "uploading",
  fileId: null,
};

function fixture(
  overrides: Partial<EditorDocument> = {},
  handlers: Record<string, (input: RequestInput) => object | Promise<object>> = {},
) {
  const descriptor = { ...DOCUMENT, ...overrides };
  const owned = fileEntry({ id: "file_1", name: descriptor.name });

  const api = createFakeApi({
    "editors.open": () => descriptor,
    "editors.download": () => ({
      url: "/synthetic-bytes",
      name: descriptor.name,
      size: 10,
      mimeType: "application/octet-stream",
    }),
    "files.get": () => owned,
    "files.list": () => fileList([]),
    "editors.prepareSave": () => UPLOADING,
    "uploads.status": () => UPLOADING,
    "uploads.part": () => ({ url: "/synthetic-part", method: "PUT", headers: {} }),
    "uploads.complete": () => owned,
    "editors.completeSave": () => ({ status: "saved", revision: "4", file: owned }),
    ...handlers,
  });

  const guard = createNavigationGuard();

  const view = mount(
    <CloudNavigationProvider
      location={{ section: "editor", fileId: owned.id }}
      onNavigate={() => {}}
      navigationGuard={guard}
    >
      <EditorScreen
        fileId={owned.id}
        copyDestination={{ kind: "folder", folderId: null }}
        closePath={() => "/"}
      />
    </CloudNavigationProvider>,
    api,
  );

  const frame = view.container.querySelector("iframe");

  if (frame === null) throw new Error("No editor frame");
  const source = frame.contentWindow;
  const commands: NativeHostCommand[] = [];
  let revision = "1";
  let nativeDocumentId = "7";
  let openId = "";
  let saveSequence = 0;

  function emit(data: NativeHostEvent) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: window.location.origin, source, data }),
      );
    });
  }

  Object.defineProperty(source, "postMessage", {
    configurable: true,
    value: (value: Parameters<typeof decodeNativeHostCommand>[0]) => {
      const command = decodeNativeHostCommand(value);

      if (command === null) throw new Error("Invalid native host command");
      commands.push(command);

      if ("fileRevision" in command)
        emit({
          type: "wordcraft:saved",
          protocol: 2,
          version: descriptor.version,
          openId: command.openId,
          documentId: command.documentId,
          revision: command.revision,
          saveId: command.saveId,
          requestId: command.requestId,
          currentRevision: revision,
          dirty: false,
        });
    },
  });

  const requests = () =>
    commands.filter((command): command is Command<"request-save"> => "reason" in command);

  async function ready() {
    await screen.findByText(descriptor.name);
    emit({
      type: "wordcraft:ready",
      protocol: 2,
      version: descriptor.version,
      maxBytes: descriptor.maxBytes,
      capabilities: {
        serialize: true,
        parsedOpen: true,
        documentRevision: true,
        durableSaveAck: true,
        theme: true,
      },
    });
    const command = commands.find((value): value is Command<"open"> => "bytes" in value);

    if (command === undefined) throw new Error("No native open");
    openId = command.openId;
    emit({
      type: "wordcraft:opened",
      protocol: 2,
      version: descriptor.version,
      openId,
      documentId: nativeDocumentId,
      revision,
    });
  }

  function dirty() {
    revision = String(BigInt(revision) + 1n);
    emit({
      type: "wordcraft:dirty",
      protocol: 2,
      version: descriptor.version,
      openId,
      documentId: nativeDocumentId,
      revision,
      dirty: true,
    });
  }

  function output() {
    const request = requests().at(-1);

    if (request === undefined) throw new Error("No requested snapshot");
    saveSequence += 1;
    emit({
      type: "wordcraft:save",
      protocol: 2,
      version: descriptor.version,
      openId,
      documentId: request.documentId,
      revision,
      requestId: request.requestId,
      saveId: `${openId}:${saveSequence}`,
      saveAs: request.saveAs === true,
      name: request.name ?? descriptor.name,
      bytes: new TextEncoder().encode("synthetic changes"),
    });
  }

  function observe(next: string, dirty: boolean, documentId = nativeDocumentId) {
    revision = next;
    nativeDocumentId = documentId;
    emit({
      type: "wordcraft:dirty",
      protocol: 2,
      version: descriptor.version,
      openId,
      documentId,
      revision,
      dirty,
    });
  }

  return {
    api,
    guard,
    view,
    frame,
    commands,
    requests,
    ready,
    dirty,
    output,
    emit,
    descriptor,
    observe,
  };
}

describe("autosave shell consuming the real SDK over explicit synthetic transport", () => {
  test("default idle timing schedules once; the UI stays unsaved until durable replacement", async () => {
    const committed = deferred<object>();
    const f = fixture({}, { "editors.completeSave": () => committed.promise });

    await f.ready();
    expect(await screen.findByText("Ready to edit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    f.dirty();
    expect(await screen.findByText("Saving soon…")).toBeTruthy();
    expect(f.guard.isHeld()).toBe(true);
    expect(f.api.callsTo("editors.prepareSave")).toHaveLength(0);
    await waitFor(() => expect(f.requests()).toHaveLength(1));
    expect(f.requests()[0]?.reason).toBe("automatic");
    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect(f.api.callsTo("files.list")).toHaveLength(0);
    f.output();
    await waitFor(() => expect(f.api.callsTo("editors.completeSave")).toHaveLength(1));
    expect(f.api.callsTo("editors.prepareSave")[0]?.input.saveMode).toBe("automatic");
    expect(screen.queryByText("All changes saved")).toBeNull();
    committed.resolve({
      status: "saved",
      revision: "4",
      file: fileEntry({ id: "file_1", name: DOCUMENT.name }),
    });
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(f.guard.isHeld()).toBe(false);
    expect(f.view.container.querySelector("iframe")).toBe(f.frame);
  });

  test("Save flushes immediately as manual without a second timer-driven request", async () => {
    const f = fixture();

    await f.ready();
    f.dirty();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(f.requests()).toHaveLength(1);
    expect(f.requests()[0]?.reason).toBe("manual");
    f.output();
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(f.api.callsTo("editors.prepareSave")[0]?.input.saveMode).toBe("manual");
  });

  test("serialization failure offers a new native capture, not backend retry with invented bytes", async () => {
    const f = fixture();

    await f.ready();
    f.dirty();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const request = f.requests()[0];

    if (request === undefined) throw new Error("No capture request");
    f.emit({
      type: "wordcraft:error",
      protocol: 2,
      version: f.descriptor.version,
      operation: "save",
      requestId: request.requestId,
      code: "serialization-failed",
      message: "Native snapshot unavailable",
    });
    expect(await screen.findByText("Not saved: couldn’t prepare changes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download my version" })).toBeNull();
    expect(f.api.callsTo("editors.prepareSave")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
    expect(f.requests()).toHaveLength(2);
    expect(f.requests()[1]?.reason).toBe("manual");
    f.output();
    expect(await screen.findByText("All changes saved")).toBeTruthy();
  });

  test("a read-only copy serialization failure remains visible and can be explicitly recaptured", async () => {
    const f = fixture({ replacementName: null, writable: false });

    await f.ready();
    await screen.findByText("Read only");
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    const request = f.requests()[0];

    if (request === undefined) throw new Error("No explicit copy capture");
    f.emit({
      type: "wordcraft:error",
      protocol: 2,
      version: f.descriptor.version,
      operation: "save",
      requestId: request.requestId,
      code: "serialization-failed",
      message: "Could not prepare the copy. Try saving a copy again.",
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not prepare the copy. Try saving a copy again.",
    );
    expect(f.api.callsTo("files.list")).toHaveLength(0);
    expect(f.api.callsTo("editors.prepareSave")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(f.requests()).toHaveLength(2);
    expect(f.requests()[1]).toMatchObject({ reason: "manual", saveAs: true });
  });

  test("copy-only files never auto-prompt; name and destination are explicit and the source stays dirty", async () => {
    const f = fixture(
      { replacementName: null },
      {
        "editors.completeSave": () => ({
          status: "saved",
          revision: "1",
          file: fileEntry({ id: "copy_1", name: "Synthetic copy.docx" }),
        }),
      },
    );

    await f.ready();
    expect(await screen.findByText("Save a copy to keep changes")).toBeTruthy();
    f.dirty();
    await act(() => new Promise((resolve) => setTimeout(resolve, 850)));
    expect(f.requests()).toHaveLength(0);
    expect(f.api.callsTo("files.list")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(await screen.findByLabelText("Copy name")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Copy name").value).toBe("Synthetic copy.docx");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(f.requests()[0]).toMatchObject({
      saveAs: true,
      name: "Synthetic copy.docx",
      reason: "manual",
    });
    expect(f.api.callsTo("files.list")).toHaveLength(0);
    f.output();
    expect(
      await screen.findByRole("heading", { name: "Save “Synthetic copy.docx” to…" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save here" }));
    await waitFor(() => expect(f.api.callsTo("editors.completeSave")).toHaveLength(1));
    expect(await screen.findByText("Save a copy to keep changes")).toBeTruthy();
    expect(f.api.callsTo("editors.prepareSave")[0]?.input.intent).toBe("save-as");
    expect(f.guard.isHeld()).toBe(true);
    expect(screen.queryByText("All changes saved")).toBeNull();
  });

  test("a failed source save keeps stable retry and never recaptures", async () => {
    const f = fixture(
      {},
      {
        "editors.prepareSave": () => {
          throw new ApiFailure("service.unavailable");
        },
      },
    );

    await f.ready();
    f.dirty();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    f.output();
    fireEvent.click(await screen.findByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(f.api.callsTo("editors.prepareSave")).toHaveLength(2));
    const [first, second] = f.api.callsTo("editors.prepareSave");

    expect(second?.input.saveId).toBe(first?.input.saveId);
    expect(second?.input.sha256).toBe(first?.input.sha256);
    expect(f.requests()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Download my version" })).toBeTruthy();
  });

  test("native busy is honest waiting, and a false safe-point token resumes autosave without manual retry", async () => {
    const f = fixture();
    await f.ready();
    f.dirty();

    for (let count = 1; count <= 3; count += 1) {
      await waitFor(() => expect(f.requests()).toHaveLength(count));
      const request = f.requests()[count - 1];

      if (request === undefined) throw new Error("No automatic request");
      f.emit({
        type: "wordcraft:error",
        protocol: 2,
        version: f.descriptor.version,
        operation: "save",
        requestId: request.requestId,
        code: "busy",
        message: "Native input is active",
      });
    }

    expect(await screen.findByText("Waiting for current edit…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try saving again" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    f.observe("3", false);
    await waitFor(() => expect(f.requests()).toHaveLength(4));
    expect(f.requests()[3]?.reason).toBe("automatic");
    f.output();
    expect(await screen.findByText("All changes saved")).toBeTruthy();
  });

  test("local new document becomes primary copy-only without falsifying original writable metadata", async () => {
    const f = fixture();
    await f.ready();
    expect(f.descriptor.writable).toBe(true);
    f.observe("1", false, "8");
    expect(await screen.findByText("Save a copy to keep changes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(f.requests()[0]).toMatchObject({ documentId: "8", saveAs: true, reason: "manual" });
    f.output();
    fireEvent.click(await screen.findByRole("button", { name: "Save here" }));
    await waitFor(() => expect(f.api.callsTo("editors.completeSave")).toHaveLength(1));
    expect(await screen.findByText("Save a copy to keep changes")).toBeTruthy();
    expect(f.guard.isHeld()).toBe(true);
    expect(f.descriptor.writable).toBe(true);
  });

  test("appearance changes use negotiated native theme commands and retain the frame", async () => {
    const f = fixture();

    await f.ready();
    fireEvent.click(screen.getByRole("button", { name: "Document options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    await waitFor(() =>
      expect(f.commands.some((command) => "theme" in command && command.theme === "dark")).toBe(
        true,
      ),
    );
    expect(f.view.container.querySelector("iframe")).toBe(f.frame);
    expect(f.frame.style.cssText).toBe("");
  });
});
