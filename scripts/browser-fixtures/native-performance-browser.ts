import {
  decodeNativeHostCommand,
  decodeNativeHostEvent,
} from "@hyori-cloud/client-sdk/editor-runtime";
import type {
  NativePacketMetadata,
  NativePerformanceObservation,
  NativePerformanceTarget,
} from "./native-performance.ts";

declare const HYORI_NATIVE_PERFORMANCE_TARGET: NativePerformanceTarget;

function observeNativePerformance(target: NativePerformanceTarget) {
  const setupStart = performance.now();

  if (window.location.origin !== target.origin || window.__hyoriNativePerformance !== undefined)
    return;

  const framePath = `/artcraft/${target.app}/${target.version}/index.html`;
  const host = window === window.top;

  if (!host && (window.parent !== window.top || window.location.pathname !== framePath)) return;

  const records: NativePerformanceObservation[] = [];
  let dropped = 0;
  let probeSetupMs = 0;
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const now = () => performance.timeOrigin + performance.now();

  function record(value: NativePerformanceObservation) {
    if (records.length < target.maximumRecords) records.push(value);
    else dropped += 1;
  }

  Object.defineProperty(window, "__hyoriNativePerformance", {
    value: {
      read: () => ({ records: records.slice(), dropped, longTasksSupported, probeSetupMs }),
      mark: (name: "activation" | "input-start") => record({ kind: "mark", name, at: now() }),
    },
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.origin !== target.origin) return;

    if (host) {
      const ownsSource = Array.from(document.querySelectorAll("iframe")).some((frame) => {
        const url = new URL(frame.src, window.location.href);

        return (
          url.origin === target.origin &&
          url.pathname === framePath &&
          frame.contentWindow === event.source
        );
      });

      if (!ownsSource) return;
    } else if (event.source !== window.parent) return;

    const value = host ? decodeNativeHostEvent(event.data) : decodeNativeHostCommand(event.data);

    if (
      value === null ||
      value.version !== target.version ||
      !value.type.startsWith(`${target.app}:`)
    )
      return;

    const packet: NativePacketMetadata = {
      type: value.type,
      protocol: value.protocol,
      version: value.version,
    };

    if ("openId" in value) packet.openId = value.openId;

    if ("documentId" in value) packet.documentId = value.documentId;

    if ("revision" in value) packet.revision = value.revision;

    if ("requestId" in value && value.requestId !== undefined) packet.requestId = value.requestId;

    if ("saveId" in value) packet.saveId = value.saveId;

    if ("intentId" in value && value.intentId !== undefined) packet.intentId = value.intentId;

    if ("currentRevision" in value) packet.currentRevision = value.currentRevision;

    if ("capabilities" in value) packet.capabilities = value.capabilities;

    if ("maxBytes" in value) packet.maxBytes = value.maxBytes;

    if ("dirty" in value) packet.dirty = value.dirty;

    if ("saveAs" in value && value.saveAs !== undefined) packet.saveAs = value.saveAs;

    if ("writable" in value) packet.writable = value.writable;

    if ("reason" in value) packet.reason = value.reason;

    if ("status" in value) packet.status = value.status;

    if ("code" in value) packet.code = value.code;

    if ("operation" in value) packet.operation = value.operation;

    if ("theme" in value) packet.theme = value.theme;

    if ("resolvedTheme" in value) packet.resolvedTheme = value.resolvedTheme;

    record({
      kind: "packet",
      at: now(),
      direction: host ? "frame-to-host" : "host-to-frame",
      packet,
      omittedFields: Object.keys(value).length - Object.keys(packet).length,
      byteLength: "bytes" in value ? value.bytes.byteLength : null,
    });
  });

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "longtask") {
        record({
          kind: "long-task",
          at: performance.timeOrigin + entry.startTime,
          duration: entry.duration,
        });
        continue;
      }

      if (!(entry instanceof PerformanceResourceTiming)) continue;
      const url = new URL(entry.name, window.location.href);

      if (url.origin !== target.origin) continue;
      let category: "runtime" | "rpc" | "storage" | "host-asset";
      let asset: string | null = null;

      if (url.pathname.startsWith(`/artcraft/${target.app}/${target.version}/`)) {
        const basename = url.pathname.split("/").at(-1) ?? "";

        if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(basename)) continue;
        category = "runtime";
        asset = basename;
      } else if (url.pathname === "/api/rpc") category = "rpc";
      else if (url.pathname.startsWith("/api/storage/")) category = "storage";
      else if (url.pathname.startsWith("/assets/")) category = "host-asset";
      else continue;

      record({
        kind: "resource",
        at: performance.timeOrigin + entry.startTime,
        duration: entry.duration,
        category,
        asset,
        protocol: entry.nextHopProtocol,
        requestStart: performance.timeOrigin + entry.requestStart,
        responseStart: performance.timeOrigin + entry.responseStart,
        responseEnd: performance.timeOrigin + entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      });
    }
  });

  observer.observe({ type: "resource", buffered: true });

  if (longTasksSupported) observer.observe({ type: "longtask", buffered: true });
  probeSetupMs = performance.now() - setupStart;
}

observeNativePerformance(HYORI_NATIVE_PERFORMANCE_TARGET);
