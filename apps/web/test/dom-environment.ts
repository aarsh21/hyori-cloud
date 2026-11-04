import { JSDOM } from "jsdom";

// Preload in a separate process: React DOM and TanStack detect the host at import time.
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://hyori.test/",
  pretendToBeVisual: true,
});

const keepRuntime = new Set([
  "fetch",
  "Request",
  "Response",
  "Headers",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "performance",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "console",
]);

class LayoutObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(dom.window, {
  ResizeObserver: LayoutObserver,
  IntersectionObserver: LayoutObserver,
  scrollTo() {},
  matchMedia: (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }),
});

for (const key of Object.getOwnPropertyNames(dom.window)) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);

  if (keepRuntime.has(key) || existing?.configurable === false) continue;
  const source = Object.getOwnPropertyDescriptor(dom.window, key);

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: source?.get === undefined ? source?.value : source.get.call(dom.window),
  });
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
