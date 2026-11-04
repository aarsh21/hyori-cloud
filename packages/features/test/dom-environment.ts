import { JSDOM } from "jsdom";

/**
 * Preloaded before any suite here. React DOM decides what its host supports as it loads, and Bun
 * shares one module cache across a process, so these suites run in their own process with a DOM
 * that exists first. See `src/mounted-suites.test.ts`.
 */

// Bun's own versions stay in place for these so the real SDK can use its fetch and Response bodies.
const KEEP_RUNTIME_GLOBALS = new Set([
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

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const viewportWatchers = new Set<() => void>();

/** Nothing has a layout here, so tests say when observed elements come near the screen. */
export function enterViewport() {
  for (const notify of viewportWatchers) notify();
}

class StubIntersectionObserver {
  private readonly watchers: (() => void)[] = [];

  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}

  observe() {
    const notify = () => this.callback([{ isIntersecting: true }]);

    this.watchers.push(notify);
    viewportWatchers.add(notify);
  }

  unobserve() {}

  disconnect() {
    for (const notify of this.watchers) viewportWatchers.delete(notify);
  }
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://hyori.test/",
  pretendToBeVisual: true,
});

Object.assign(dom.window, {
  ResizeObserver: StubResizeObserver,
  IntersectionObserver: StubIntersectionObserver,
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }),
});

for (const key of Object.getOwnPropertyNames(dom.window)) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);

  if (KEEP_RUNTIME_GLOBALS.has(key) || existing?.configurable === false) continue;
  const source = Object.getOwnPropertyDescriptor(dom.window, key);

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: source?.get === undefined ? source?.value : source.get.call(dom.window),
  });
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
