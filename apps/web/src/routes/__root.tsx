import { ClientSDKProvider } from "@hyori-cloud/client-sdk/react";
import { QueryClientProvider, useQuery } from "@hyori-cloud/lib/query";
import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";
import { BrowserPreferencesScript } from "@hyori-cloud/ui/components/browser-preferences-script";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";

import type { createAppRuntime } from "@/app/runtime";
import { DocumentHead, DocumentScripts } from "@/components/document-assets";
import appCss from "@/index.css?url";

export type RouterAppContext = ReturnType<typeof createAppRuntime>;

const Toaster = lazy(async () => ({
  default: (await import("@hyori-cloud/ui/components/sonner")).Toaster,
}));

export const Route = createRootRouteWithContext<RouterAppContext>()({
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
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", type: "image/png", href: "/favicon-32.png", sizes: "32x32" },
      { rel: "icon", type: "image/png", href: "/icon-192.png", sizes: "192x192" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  const { queryClient, sdkClient } = Route.useRouteContext();
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
        <BrowserPreferencesScript nonce={nonce} />
      </head>
      <body>
        <AppearanceProvider nonce={nonce}>
          <QueryClientProvider client={queryClient}>
            <ClientSDKProvider sdkClient={sdkClient}>
              <Outlet />
              {status.data?.user || publicShare ? (
                <Suspense fallback={null}>
                  <Toaster />
                </Suspense>
              ) : null}
            </ClientSDKProvider>
          </QueryClientProvider>
        </AppearanceProvider>
        <DocumentScripts />
      </body>
    </html>
  );
}
