import { ClientSDKProvider } from "@hyori-cloud/client-sdk/react";
import { QueryClientProvider, useQuery } from "@hyori-cloud/lib/query";
import { Toaster } from "@hyori-cloud/ui/components/sonner";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";
import { BrowserPreferencesScript } from "@hyori-cloud/ui/components/browser-preferences-script";
import { BrowserPreferencesProvider } from "@hyori-cloud/ui/components/browser-preferences-provider";
import {
  DEFAULT_BROWSER_PREFERENCES,
  parseBrowserPreferences,
} from "@hyori-cloud/ui/lib/browser-preferences";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";

import type { createAppRuntime } from "@/app/runtime";
import { DocumentHead, DocumentScripts } from "@/components/document-assets";
import appCss from "@/index.css?url";
import latinFont from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";

export type RouterAppContext = ReturnType<typeof createAppRuntime>;

const requestBrowserPreferences = createIsomorphicFn()
  .server(() => {
    // Standalone render tests have no Start request context.
    try {
      return getGlobalStartContext()?.browserPreferences ?? DEFAULT_BROWSER_PREFERENCES;
    } catch {
      return DEFAULT_BROWSER_PREFERENCES;
    }
  })
  .client(() =>
    parseBrowserPreferences(
      document.querySelector('meta[name="hyori-ui"]')?.getAttribute("content"),
    ),
  );

export const Route = createRootRouteWithContext<RouterAppContext>()({
  beforeLoad: () => ({ browserPreferences: requestBrowserPreferences() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // `cover` is what makes the safe-area insets the layouts reserve report real values.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Hyori: your own corner of the cloud" },
      {
        name: "description",
        content: "A thoughtful home for your files, photos, and documents. On your own server.",
      },
      { name: "color-scheme", content: "light dark" },
      // Follow the app's ground in each scheme, so browser chrome reads as part of the frame.
      { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#f1eee8" },
      { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#07080a" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: latinFont,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", type: "image/png", href: "/favicon-32.png", sizes: "32x32" },
      { rel: "icon", type: "image/png", href: "/icon-192.png", sizes: "192x192" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  const { queryClient, sdkClient, browserPreferences } = Route.useRouteContext();
  const nonce = useRouter().options.ssr?.nonce;

  const publicShare = useRouterState({
    select: ({ location }) => location.pathname.startsWith("/share/"),
  });

  const status = useQuery(
    { ...sdkClient.query.auth.status.getOptions({}), enabled: false },
    queryClient,
  );

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <DocumentHead />
        <BrowserPreferencesScript nonce={nonce} preferences={browserPreferences} />
      </head>
      <body>
        <AppearanceProvider nonce={nonce}>
          <QueryClientProvider client={queryClient}>
            <ClientSDKProvider sdkClient={sdkClient}>
              <BrowserPreferencesProvider value={browserPreferences}>
                <Outlet />
              </BrowserPreferencesProvider>
              {status.data?.user || publicShare ? <Toaster /> : null}
            </ClientSDKProvider>
          </QueryClientProvider>
        </AppearanceProvider>
        <DocumentScripts />
      </body>
    </html>
  );
}
