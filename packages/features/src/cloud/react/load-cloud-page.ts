import type { Client } from "@hyori-cloud/client-sdk";
import type { QueryClient } from "@hyori-cloud/lib/query";
import { parseCloudPath } from "#features/cloud/cloud-path.ts";
import { preloadCloudPath } from "#features/cloud/react/cloud-screen-loaders.ts";
import { NO_FILTERS, toListFilesInput } from "#features/files/file-filters.ts";
import { cursorPagesOptions } from "#features/shared/react/use-cursor-pages.ts";

/** First-document reads only. Link consent never resolves a grant or exposes account state. */
export async function loadCloudPage(
  { sdkClient, queryClient }: { sdkClient: Client; queryClient: QueryClient },
  path: string,
) {
  const location = parseCloudPath(path);

  if (
    location.section === "publicShare" ||
    location.section === "publicEditor" ||
    location.section === "invite" ||
    location.section === "passwordReset"
  ) {
    await preloadCloudPath(path);

    return;
  }

  const status = await queryClient.fetchQuery(sdkClient.query.auth.status.getOptions({}));

  if (status.user === null) return;

  await preloadCloudPath(path);

  switch (location.section) {
    case "files":
    case "shared": {
      const input = toListFilesInput(
        location.section === "files" ? location.folderId : null,
        location.section === "files" ? "files" : "shared",
        NO_FILTERS,
      );

      await queryClient.prefetchInfiniteQuery(
        cursorPagesOptions(sdkClient.query.files.list, sdkClient.rpc.files.list, input),
      );
      break;
    }

    case "admin":
      if (status.user.role === "admin")
        await queryClient.prefetchInfiniteQuery(
          cursorPagesOptions(sdkClient.query.admin.users, sdkClient.rpc.admin.users, {}),
        );

      break;
    case "photos":
    case "editor":
    case "trash":
    case "albums":
    case "album":
    case "notFound":
      break;
  }
}
