import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  installNativePerformanceObserver,
  validatedNativePerformanceEvent,
} from "./native-performance.ts";
import type { NativePerformanceSnapshot, NativePerformanceTarget } from "./native-performance.ts";
import { nativePerformanceMatrix, nativePerformancePhases } from "./native-performance-phases.ts";

const TARGET = {
  origin: "https://127.0.0.1:9443",
  app: "wordcraft",
  version: "0.14.0-hyori-host.3",
  maximumRecords: 100,
} satisfies NativePerformanceTarget;

const IDENTITY = { openId: "open_1", documentId: "7", revision: "1" };
const FRAME_URL = `${TARGET.origin}/artcraft/${TARGET.app}/${TARGET.version}/index.html?host=parent`;
const ENVELOPE = { protocol: 2, version: TARGET.version };

/** Executes only the passive bootstrap against a deterministic DOM port, not a native runtime. */
async function fixture(child = false, overrides: Partial<NativePerformanceTarget> = {}) {
  type ProbeEvent = { readonly data: unknown; readonly origin: string; readonly source: object };

  type ProbeWindow = {
    location: URL;
    top?: object;
    parent?: object;
    addEventListener(name: string, listener: (event: ProbeEvent) => void): void;
    __hyoriNativePerformance?: {
      read(): NativePerformanceSnapshot;
      mark(name: "activation" | "input-start"): void;
    };
  };

  let at = 0;
  let listener: ((event: ProbeEvent) => void) | undefined;
  const frameSource = {};
  const hostSource = {};

  const own: ProbeWindow = {
    location: new URL(child ? FRAME_URL : `${TARGET.origin}/files`),
    addEventListener: (_name, receive) => {
      listener = receive;
    },
  };

  own.top = child ? hostSource : own;
  own.parent = own.top;

  await installNativePerformanceObserver(
    {
      async addInitScript(script) {
        runInNewContext(script.content, {
          window: own,
          document: {
            querySelectorAll: () => [{ src: FRAME_URL, contentWindow: frameSource }],
          },
          URL,
          ArrayBuffer,
          Uint8Array,
          TextEncoder,
          TextDecoder,
          performance: { timeOrigin: 1000, now: () => at },
          PerformanceObserver: class {
            static supportedEntryTypes = ["resource"];
            observe() {}
          },
        });
      },
    },
    { ...TARGET, ...overrides },
  );

  const probe = own.__hyoriNativePerformance;

  if (probe === undefined) throw new Error("Observer was not installed");

  return {
    probe,
    frameSource,
    advance(next: number) {
      at = next;
    },
    emit(
      data: ProbeEvent["data"],
      origin = TARGET.origin,
      source = child ? hostSource : frameSource,
    ) {
      listener?.({ data, origin, source });
    },
  };
}

function packet(type: string, extra = {}) {
  return { ...ENVELOPE, type: `wordcraft:${type}`, ...extra };
}

function combine(...snapshots: NativePerformanceSnapshot[]): NativePerformanceSnapshot {
  return {
    records: snapshots.flatMap((snapshot) => snapshot.records),
    dropped: snapshots.reduce((total, snapshot) => total + snapshot.dropped, 0),
    longTasksSupported: false,
    probeSetupMs: snapshots.reduce((total, snapshot) => total + snapshot.probeSetupMs, 0),
  };
}

describe("passive native performance preparation; no real browser/native acceptance", () => {
  test("matrix plans five fresh profiles and ten clean-close warm attachments without retry slots", () => {
    const matrix = nativePerformanceMatrix();

    expect(matrix).toHaveLength(15);
    expect(matrix.filter((sample) => sample.cache === "cold")).toHaveLength(5);
    expect(matrix.filter((sample) => sample.cache === "warm")).toHaveLength(10);

    for (let profile = 0; profile < 5; profile += 1) {
      expect(matrix.filter((sample) => sample.profile === profile)).toEqual([
        { profile, attachment: 0, cache: "cold", requiresCleanPreviousClose: false },
        { profile, attachment: 1, cache: "warm", requiresCleanPreviousClose: true },
        { profile, attachment: 2, cache: "warm", requiresCleanPreviousClose: true },
      ]);
    }
  });

  test("rejects live LAN scope and unbounded buffers before installing anything", async () => {
    let installed = false;

    const context = {
      async addInitScript() {
        installed = true;
      },
    };

    for (const overrides of [
      { origin: "https://192.168.1.10" },
      { origin: "http://127.0.0.1:9443" },
      { origin: `${TARGET.origin}/files` },
      { maximumRecords: 0 },
      { maximumRecords: 20_001 },
      { version: "../private" },
    ]) {
      await expect(
        installNativePerformanceObserver(context, { ...TARGET, ...overrides }),
      ).rejects.toThrow("owned-loopback");
    }

    expect(installed).toBe(false);
  });

  test("metadata keeps byte count but never names, bytes, messages, or unknown field values", async () => {
    const f = await fixture();

    f.emit(
      packet("save", {
        ...IDENTITY,
        saveId: "snapshot_1",
        requestId: "request_1",
        saveAs: false,
        name: "PROHIBITED_NAME",
        bytes: new TextEncoder().encode("PROHIBITED_CONTENT"),
      }),
    );
    const snapshot = f.probe.read();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("PROHIBITED");
    expect(serialized).not.toContain("unexpected");
    expect(snapshot.records[0]).toMatchObject({ byteLength: 18, omittedFields: 2 });
    f.emit(packet("error", { operation: "save", code: "busy", message: "PROHIBITED_MESSAGE" }));
    expect(JSON.stringify(f.probe.read())).not.toContain("PROHIBITED");
    expect(snapshot.records[0] && validatedNativePerformanceEvent(snapshot.records[0])).toBeNull();
  });

  test("exact origin, source, app and version gates exclude unrelated messages", async () => {
    const f = await fixture();
    const opened = packet("opened", IDENTITY);

    f.emit(opened, "https://example.invalid");
    f.emit(opened, TARGET.origin, {});
    f.emit({ ...opened, version: "old-version" });
    f.emit({ ...opened, type: "gridcraft:opened" });
    f.emit({ ...opened, protocol: 1 });
    expect(f.probe.read().records).toHaveLength(0);
    f.emit(opened);
    expect(f.probe.read().records).toHaveLength(1);
  });

  test("unknown top-level and nested capability fields cannot become strict validated events", async () => {
    const f = await fixture();

    const ready = packet("ready", {
      maxBytes: 1024,
      capabilities: {
        serialize: true,
        parsedOpen: true,
        documentRevision: true,
        durableSaveAck: true,
        theme: true,
      },
    });

    f.emit(ready);
    f.emit({ ...ready, unexpected: "not-retained" });
    f.emit({ ...ready, capabilities: { ...ready.capabilities, unexpected: true } });
    const snapshot = f.probe.read();
    const valid = snapshot.records[0];

    expect(valid && validatedNativePerformanceEvent(valid)?.type).toBe("wordcraft:ready");
    expect(snapshot.records).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("unexpected");
  });

  test("overflow is counted, never silently presented as complete evidence", async () => {
    const f = await fixture(false, { maximumRecords: 1 });

    f.emit(packet("opened", IDENTITY));
    f.emit(packet("dirty", { ...IDENTITY, revision: "2", dirty: true }));
    expect(f.probe.read().records).toHaveLength(1);
    expect(f.probe.read().dropped).toBe(1);
    expect(nativePerformancePhases(f.probe.read()).droppedObservations).toBe(1);
  });

  test("ready is not parsed open and a false draft observation is not usable input", async () => {
    const f = await fixture();

    f.probe.mark("activation");
    f.advance(10);
    f.emit(
      packet("ready", {
        maxBytes: 1024,
        capabilities: {
          serialize: true,
          parsedOpen: true,
          documentRevision: true,
          durableSaveAck: true,
          theme: true,
        },
      }),
    );
    f.probe.mark("input-start");
    f.emit(packet("dirty", { ...IDENTITY, revision: "2", dirty: false }));
    expect(nativePerformancePhases(f.probe.read())).toMatchObject({
      activationToReadyMs: 10,
      activationToParsedOpenMs: null,
      inputToDirtyObservationMs: null,
      usableInputVerified: false,
      authoritativeDurabilityMs: null,
      isolatedHashingMs: null,
    });
  });

  test("separates idle and snapshot observations, requiring exact attachment/request correlation", async () => {
    const host = await fixture();
    const frame = await fixture(true);

    host.probe.mark("activation");
    host.advance(20);
    host.emit(packet("opened", IDENTITY));
    host.advance(30);
    host.probe.mark("input-start");
    host.advance(35);
    host.emit(packet("dirty", { ...IDENTITY, revision: "2", dirty: true }));
    frame.advance(785);
    frame.emit(
      packet("request-save", {
        openId: "open_1",
        documentId: "7",
        requestId: "request_1",
        reason: "automatic",
      }),
    );
    host.advance(800);

    const output = packet("save", {
      ...IDENTITY,
      revision: "2",
      requestId: "request_1",
      saveId: "snapshot_1",
      saveAs: false,
      name: "Synthetic.docx",
      bytes: new Uint8Array([1]),
    });

    host.emit({ ...output, requestId: "unrelated" });
    host.advance(810);
    host.emit(output);
    host.advance(820);
    host.emit(
      packet("saved", {
        ...IDENTITY,
        revision: "2",
        currentRevision: "2",
        requestId: "request_1",
        saveId: "snapshot_1",
        dirty: false,
      }),
    );
    expect(nativePerformancePhases(combine(host.probe.read(), frame.probe.read()))).toMatchObject({
      activationToParsedOpenMs: 20,
      inputToDirtyObservationMs: 5,
      dirtyToCaptureRequestMs: 750,
      requestToSnapshotObservationMs: 25,
      authoritativeDurabilityMs: null,
      usableInputVerified: false,
    });
  });
});
