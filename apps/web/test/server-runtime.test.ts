import { expect, test } from "bun:test";
import { getAppRuntime } from "@/app/runtime";
import { getRouter } from "@/router";
import { renderRequest } from "@/app/render-request";
import { createWebBackendHandler } from "@/server/backend-handler";
import { loadPage } from "@/app/load-page";
import { createClient } from "@hyori-cloud/client-sdk";
import { QueryClient, dehydrate } from "@hyori-cloud/lib/query";
import { browserPreferencesFromCookie } from "@hyori-cloud/ui/lib/browser-preferences";

test("presentation cookies accept only a single complete versioned preference value", () => {
  const defaults = {
    layout: "list",
    sidebarOpen: true,
    singleKeyShortcuts: true,
    fileSort: "nameAsc",
  } as const;

  for (const layout of ["l", "g"]) {
    for (const sidebar of ["o", "c"]) {
      for (const shortcuts of ["0", "1"]) {
        const value = `1.${layout}.${sidebar}.${shortcuts}`;

        expect(browserPreferencesFromCookie(`other=ignored; hyori_ui=${value}`)).toEqual({
          layout: layout === "g" ? "grid" : "list",
          sidebarOpen: sidebar === "o",
          singleKeyShortcuts: shortcuts === "1",
          fileSort: "nameAsc",
        });

        // Any one-character corruption must default, unless it is another valid choice.
        for (let index = 0; index < value.length; index++) {
          for (let ascii = 33; ascii < 127; ascii++) {
            const candidate =
              value.slice(0, index) + String.fromCharCode(ascii) + value.slice(index + 1);

            if (/^1\.[lg]\.[oc]\.[01]$/.test(candidate)) continue;
            expect(browserPreferencesFromCookie(`hyori_ui=${candidate}`)).toEqual(defaults);
          }
        }
      }
    }
  }

  for (const header of [
    "",
    "hyori_ui=",
    "hyori_ui=1.g.c.0.extra",
    "hyori_ui=%31.g.c.0",
    'hyori_ui="1.g.c.0"',
    "hyori_ui=1.g.c.0 ; other=1",
    "hyori_ui=1.g.c.0\t; other=1",
    "hyori_ui=1.g.c.0\r\n",
    `hyori_ui=${"x".repeat(8192)}`,
    "hyori_ui=1.g.c.0; hyori_ui=1.l.o.1",
    "hyori_ui=1.g.c.0; hyori_ui=1.g.c.0",
  ]) {
    expect(browserPreferencesFromCookie(header)).toEqual(defaults);
  }

  const sorts = [
    "nameAsc",
    "nameDesc",
    "sizeAsc",
    "sizeDesc",
    "modifiedAsc",
    "modifiedDesc",
  ] as const;

  for (const [code, fileSort] of sorts.entries()) {
    const value = `2.g.c.0.${code}`;
    expect(browserPreferencesFromCookie(`hyori_ui=${value}`)).toEqual({
      layout: "grid",
      sidebarOpen: false,
      singleKeyShortcuts: false,
      fileSort,
    });

    for (let index = 0; index < value.length; index++) {
      for (let ascii = 33; ascii < 127; ascii++) {
        const candidate =
          value.slice(0, index) + String.fromCharCode(ascii) + value.slice(index + 1);

        if (/^2\.[lg]\.[oc]\.[01]\.[0-5]$/.test(candidate)) continue;
        expect(browserPreferencesFromCookie(`hyori_ui=${candidate}`)).toEqual(defaults);
      }
    }

    for (const suffix of [".extra", "\n", "\r\n", "\t", " "]) {
      expect(browserPreferencesFromCookie(`hyori_ui=${value}${suffix}`)).toEqual(defaults);
    }
  }
});

test("a refused render read still returns a document and can be fetched again by the browser", async () => {
  let busy = true;

  const sdkClient = createClient({
    fetch: async () =>
      busy
        ? Response.json(
            { ok: false, error: { code: "service.unavailable", message: "Busy" } },
            { status: 503 },
          )
        : Response.json({ ok: true, value: { initialized: true, user: null } }),
  });

  const queryClient = new QueryClient();

  try {
    expect(await loadPage({ sdkClient, queryClient }, "/folders/private-folder")).toEqual({
      preloads: [],
    });
    expect(dehydrate(queryClient).queries).toEqual([]);
    busy = false;
    expect(await queryClient.fetchQuery(sdkClient.query.auth.status.getOptions({}))).toEqual({
      initialized: true,
      user: null,
    });
  } finally {
    sdkClient.dispose();
    queryClient.clear();
  }
});

test("actual server router requests own separate SDKs and Query caches", () => {
  expect(globalThis.window).toBeUndefined();
  const first = getRouter();
  const second = getRouter();
  const a = first.options.context;
  const b = second.options.context;

  try {
    expect(a).not.toBe(b);
    expect(a.queryClient).not.toBe(b.queryClient);
    expect(a.sdkClient).not.toBe(b.sdkClient);
    const key = a.sdkClient.query.auth.status.getOptions({}).queryKey;

    a.queryClient.setQueryData(key, { initialized: true, user: null });
    expect(a.queryClient.getQueryState(key)?.data).toEqual({ initialized: true, user: null });
    expect(b.queryClient.getQueryData(key)).toBeUndefined();
    const third = getAppRuntime();

    expect(third).not.toBe(a);
    expect(third.queryClient.getQueryData(key)).toBeUndefined();
    third.sdkClient.dispose();
    third.queryClient.clear();
  } finally {
    a.sdkClient.dispose();
    b.sdkClient.dispose();
    a.queryClient.clear();
    b.queryClient.clear();
  }
});

test("render RPC keeps the visitor cookie, gateway address evidence, authority and cancellation", async () => {
  const origin = "https://cloud.example.test";

  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      Response.json({
        address: request.headers.get("x-hyori-client-address"),
        cookie: request.headers.get("cookie"),
      }),
  });

  const proxy = createWebBackendHandler({
    origin,
    backendUrl: backend.url.origin,
    production: true,
    gatewayClientAddressHeader: "x-forwarded-for",
  });

  try {
    for (const [rawHeaders, address] of [
      [["X-Forwarded-For", "192.0.2.6, 203.0.113.9"], "203.0.113.9"],
      [["X-Forwarded-For", "192.0.2.6", "X-Forwarded-For", "203.0.113.9"], null],
    ] as const) {
      const cancelled = new AbortController();

      const incoming = Object.assign(
        new Request(`${origin}/folders/folder-1`, {
          headers: {
            host: new URL(origin).host,
            cookie: "hyori_session=visitor",
            "accept-encoding": "gzip, br",
            "x-forwarded-for": "192.0.2.6, 203.0.113.9",
            "x-hyori-client-address": "198.51.100.99",
          },
          signal: cancelled.signal,
        }),
        { runtime: { node: { req: { rawHeaders: [...rawHeaders] } } } },
      );

      const request = renderRequest(
        incoming,
        {
          method: "POST",
          body: JSON.stringify({ operation: "auth.status", input: {} }),
        },
        origin,
      );

      expect(request.headers.has("accept-encoding")).toBe(false);
      const response = await proxy(request);
      expect(await response.json()).toEqual({ address, cookie: "hyori_session=visitor" });
      expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");

      incoming.headers.set("host", "attacker.example.test");
      expect(
        (
          await proxy(
            renderRequest(
              incoming,
              {
                method: "POST",
                body: "{}",
              },
              origin,
            ),
          )
        ).status,
      ).toBe(403);

      cancelled.abort();
      expect(request.signal.aborted).toBe(true);
    }
  } finally {
    backend.stop(true);
  }
});
