import { ClientSDKProvider } from "@hyori-cloud/client-sdk/react";
import { QueryClientProvider } from "@hyori-cloud/lib/query";
import { Toaster } from "@hyori-cloud/ui/components/sonner";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";
import { Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";

import type { createAppRuntime } from "@/app/runtime";
import { DocumentHead, DocumentScripts } from "@/components/document-assets";
import appCss from "@/index.css?url";

export type RouterAppContext = ReturnType<typeof createAppRuntime>;

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

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <DocumentHead />
      </head>
      <body>
        <AppearanceProvider nonce={nonce}>
          <QueryClientProvider client={queryClient}>
            <ClientSDKProvider sdkClient={sdkClient}>
              <Outlet />
              <Toaster />
            </ClientSDKProvider>
          </QueryClientProvider>
        </AppearanceProvider>
        <DocumentScripts />
      </body>
    </html>
  );
}
