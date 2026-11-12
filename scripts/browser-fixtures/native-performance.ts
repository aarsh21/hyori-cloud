import { decodeNativeHostEvent } from "@hyori-cloud/client-sdk/editor-runtime";
import type {
  NativeHostCommand,
  NativeHostEvent,
  NativeSnapshotIdentity,
} from "@hyori-cloud/client-sdk/editor-runtime";
import type { Page } from "playwright-core";

export type NativePerformanceTarget = {
  readonly origin: string;
  readonly app: "wordcraft" | "gridcraft" | "pdfcraft" | "deckcraft";
  readonly version: string;
  readonly maximumRecords: number;
};

export type NativePacketMetadata = Partial<NativeSnapshotIdentity> & {
  readonly type: NativeHostCommand["type"] | NativeHostEvent["type"];
  readonly version: string;
  readonly protocol: 3;
  capabilities?: Extract<NativeHostEvent, { type: `${string}:ready` }>["capabilities"];
  maxBytes?: number;
  dirty?: boolean;
  saveAs?: boolean;
  writable?: boolean;
  currentRevision?: string;
  intentId?: string;
  reason?: "manual" | "automatic";
  status?: "saved" | "failed" | "conflict" | "read-only" | "access-ended";
  code?: Extract<NativeHostEvent, { type: `${string}:error` }>["code"];
  operation?: "open" | "save" | "theme";
  theme?: "light" | "dark" | "system";
  resolvedTheme?: "light" | "dark";
};

type PacketObservation = {
  readonly kind: "packet";
  readonly at: number;
  readonly direction: "host-to-frame" | "frame-to-host";
  readonly packet: NativePacketMetadata;
  readonly omittedFields: number;
  readonly byteLength: number | null;
};

type ResourceObservation = {
  readonly kind: "resource";
  readonly at: number;
  readonly duration: number;
  readonly category: "runtime" | "rpc" | "storage" | "host-asset";
  readonly asset: string | null;
  readonly protocol: string;
  readonly requestStart: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
};

type LongTaskObservation = {
  readonly kind: "long-task";
  readonly at: number;
  readonly duration: number;
};

type MarkObservation = {
  readonly kind: "mark";
  readonly at: number;
  readonly name: "activation" | "input-start";
};

export type NativePerformanceObservation =
  | PacketObservation
  | ResourceObservation
  | LongTaskObservation
  | MarkObservation;

export type NativePerformanceSnapshot = {
  readonly records: readonly NativePerformanceObservation[];
  readonly dropped: number;
  readonly longTasksSupported: boolean;
  readonly probeSetupMs: number;
};

declare global {
  interface Window {
    __hyoriNativePerformance?: {
      read(): NativePerformanceSnapshot;
      mark(name: MarkObservation["name"]): void;
    };
  }
}

let browserProbe: Promise<string> | undefined;

/** Install before navigation, only on an owned disposable same-origin fixture. Never sends IPC. */
export async function installNativePerformanceObserver(
  context: { addInitScript(script: { content: string }): Promise<void> },
  target: NativePerformanceTarget,
) {
  const origin = new URL(target.origin);

  if (
    origin.protocol !== "https:" ||
    origin.origin !== target.origin ||
    !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
    !["wordcraft", "gridcraft", "pdfcraft", "deckcraft"].includes(target.app) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.version) ||
    !Number.isSafeInteger(target.maximumRecords) ||
    target.maximumRecords < 1 ||
    target.maximumRecords > 20_000
  )
    throw new Error("Native performance observation requires bounded owned-loopback HTTPS scope");

  browserProbe ??= bundleBrowserProbe();

  const bundle = await browserProbe;
  const content = `(()=>{const HYORI_NATIVE_PERFORMANCE_TARGET=${JSON.stringify(target)};\n${bundle}\n})();`;

  await context.addInitScript({ content });

  return { probeBundleBytes: Buffer.byteLength(content) };
}

async function bundleBrowserProbe() {
  // Bundle the existing canonical codecs, not a second handwritten IPC parser. This in-memory
  // probe build neither rebuilds the app/runtime nor writes any shipping artifact.
  const build = await Bun.build({
    entrypoints: [new URL("./native-performance-browser.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    minify: true,
  });

  if (!build.success || build.outputs.length !== 1)
    throw new Error("Could not bundle canonical native performance observer");

  const script = build.outputs[0];

  if (script === undefined) throw new Error("Missing native performance observer");

  return script.text();
}

/** No projected/redacted envelope is promoted to a strict parsed-open or durable native ack. */
export function validatedNativePerformanceEvent(
  observation: NativePerformanceObservation,
): NativeHostEvent | null {
  if (
    observation.kind !== "packet" ||
    observation.direction !== "frame-to-host" ||
    observation.omittedFields !== 0
  )
    return null;

  return decodeNativeHostEvent(observation.packet);
}

export async function readNativePerformance(page: Page, target: NativePerformanceTarget) {
  const snapshots: NativePerformanceSnapshot[] = [];

  for (const frame of page.frames()) {
    const url = new URL(frame.url());

    if (
      url.origin !== target.origin ||
      (frame !== page.mainFrame() &&
        url.pathname !== `/artcraft/${target.app}/${target.version}/index.html`)
    )
      continue;

    const snapshot = await frame.evaluate(() => window.__hyoriNativePerformance?.read() ?? null);

    if (snapshot !== null) snapshots.push(snapshot);
  }

  return {
    records: snapshots.flatMap((snapshot) => snapshot.records).sort((a, b) => a.at - b.at),
    dropped: snapshots.reduce((total, snapshot) => total + snapshot.dropped, 0),
    longTasksSupported:
      snapshots.length > 0 && snapshots.every((snapshot) => snapshot.longTasksSupported),
    probeSetupMs: snapshots.reduce((total, snapshot) => total + snapshot.probeSetupMs, 0),
  } satisfies NativePerformanceSnapshot;
}
