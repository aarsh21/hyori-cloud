import { ClientSDKProvider } from "@hyori-cloud/client-sdk/react";
import { QueryClientProvider } from "@hyori-cloud/lib/query";
import { Toaster } from "@hyori-cloud/ui/components/sonner";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";

import type { createAppRuntime } from "@/app/runtime";
import appCss from "@/index.css?url";

export type RouterAppContext = ReturnType<typeof createAppRuntime>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Hyori — your own corner of the cloud" },
      {
        name: "description",
        content: "A thoughtful home for your files, photos, and documents. On your own server.",
      },
      { name: "theme-color", content: "#f8f7f4" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootDocument,
});

function RootDocument() {
  const { queryClient, sdkClient } = Route.useRouteContext();

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <ClientSDKProvider sdkClient={sdkClient}>
            <Outlet />
            <Toaster richColors />
          </ClientSDKProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
