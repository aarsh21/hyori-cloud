import { loadCloudPage, parseCloudPath, preloadCloudPath } from "@hyori-cloud/features/react";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import type { createAppRuntime } from "@/app/runtime";
import screenAssets from "virtual:hyori-screen-assets";

const loadDocument = createIsomorphicFn()
  .server(async (runtime: ReturnType<typeof createAppRuntime>, path: string) => {
    const location = parseCloudPath(path);
    let crossSiteNavigation = false;

    try {
      crossSiteNavigation = getGlobalStartContext()?.crossSiteNavigation ?? false;
    } catch {
      // Standalone runtime tests have no Start request context.
    }

    // Strict session cookies are absent on a cross-site document, but present on the browser's
    // subsequent same-origin RPC. Leave private routes pending rather than caching false sign-out.
    if (
      !crossSiteNavigation ||
      location.section === "publicShare" ||
      location.section === "publicEditor" ||
      location.section === "invite" ||
      location.section === "passwordReset"
    )
      await loadCloudPage(runtime, path).catch(() => {
        // The regular query boundary owns service failures; never mistake them for setup/sign-out.
      });

    const status = runtime.queryClient.getQueryData(runtime.sdkClient.query.auth.status.getKey({}));

    const names =
      location.section === "publicShare" || location.section === "publicEditor"
        ? ["public-share-screen"]
        : location.section === "invite"
          ? ["invite-screen"]
          : location.section === "passwordReset"
            ? ["password-reset-screen"]
            : status?.user
              ? ["signed-in-cloud", `${location.section}-screen`]
              : [];

    return { preloads: [...new Set(names.flatMap((name) => screenAssets[name] ?? []))] };
  })
  .client(() => ({ preloads: [] }));

export function loadPage(runtime: ReturnType<typeof createAppRuntime>, path: string) {
  if (typeof window === "undefined") return loadDocument(runtime, path);

  const status = runtime.queryClient.getQueryData(runtime.sdkClient.query.auth.status.getKey({}));

  if (status?.user) preloadCloudPath(path);

  return { preloads: [] };
}
