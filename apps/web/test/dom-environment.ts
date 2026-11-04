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

type SchemeListener = (this: MediaQueryList, event: MediaQueryListEvent) => void;

class SystemAppearanceQuery extends dom.window.EventTarget implements MediaQueryList {
  readonly media = "(prefers-color-scheme: dark)";
  matches = false;
  onchange: SchemeListener | null = null;
  private readonly listeners = new Set<SchemeListener>();

  addListener(listener: SchemeListener | null) {
    if (listener) this.listeners.add(listener);
  }

  removeListener(listener: SchemeListener | null) {
    if (listener) this.listeners.delete(listener);
  }

  get listenerCount() {
    return this.listeners.size;
  }

  set(appearance: "light" | "dark") {
    this.matches = appearance === "dark";

    const event = Object.assign(new dom.window.Event("change"), {
      matches: this.matches,
      media: this.media,
    });

    this.dispatchEvent(event);
    this.onchange?.call(this, event);

    for (const listener of this.listeners) listener.call(this, event);
  }
}

export const systemAppearance = new SystemAppearanceQuery();

Object.assign(dom.window, {
  ResizeObserver: LayoutObserver,
  IntersectionObserver: LayoutObserver,
  scrollTo() {},
  matchMedia: (media: string) => {
    if (media === systemAppearance.media) return systemAppearance;

    return {
      matches: false,
      media,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    };
  },
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
