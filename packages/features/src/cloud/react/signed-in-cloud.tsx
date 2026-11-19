import { Suspense, useEffect } from "@hyori-cloud/lib/react";
import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { CloudContent } from "#features/cloud/react/cloud-content.tsx";
import { scheduleIdleCloudPreload } from "#features/cloud/react/idle-preload.ts";
import {
  lazyScreen,
  loadEditorScreen,
  loadUploadTray,
} from "#features/cloud/react/cloud-screen-loaders.ts";
import { CloudShell } from "#features/cloud/react/cloud-shell.tsx";
import { FocusFallback } from "#features/cloud/react/focus-fallback.tsx";
import { UploadsProvider } from "#features/uploads/react/uploads-provider.tsx";

const EditorScreen = lazyScreen(loadEditorScreen, (module) => module.EditorScreen);
const UploadTray = lazyScreen(loadUploadTray, (module) => module.UploadTray);

type SignedInLocation = Exclude<
  CloudLocation,
  { section: "invite" | "passwordReset" | "publicShare" | "publicEditor" }
>;

const ACCOUNT_DESTINATION = { kind: "folder", folderId: null } as const;

function filesFolderPath(parentId: string | null) {
  return formatCloudPath({ section: "files", folderId: parentId });
}

/**
 * The signed-in application as one chunk, so anyone at the sign-in screen never downloads it.
 *
 * The upload queue sits above the editor and the shell alike: opening a document must not dispose
 * the transfers still running, whose only copy of each file is the reference this queue holds.
 */
export function SignedInCloud({ location }: { location: SignedInLocation }) {
  const user = useCurrentUser();

  // Once the app has painted, whatever is left of the wire goes to the other sections' code.
  useEffect(() => {
    scheduleIdleCloudPreload(user.role === "admin");
  }, [user.role]);

  return (
    // Interrupted uploads belong to one account. Changing accounts must not carry them across.
    <UploadsProvider key={user.id} scope={user.id}>
      <TooltipProvider>
        <SignedInLocationScreen location={location} />
      </TooltipProvider>
    </UploadsProvider>
  );
}

function SignedInLocationScreen({ location }: { location: SignedInLocation }) {
  if (location.section === "editor") {
    return (
      <>
        <Suspense fallback={<FocusFallback />}>
          <EditorScreen
            key={location.fileId}
            fileId={location.fileId}
            copyDestination={ACCOUNT_DESTINATION}
            closePath={filesFolderPath}
          />
        </Suspense>
        {/* Starts as one line over the document, still there to expand, retry, or clear. */}
        <Suspense fallback={null}>
          <UploadTray defaultCollapsed floating />
        </Suspense>
      </>
    );
  }

  return (
    <CloudShell>
      <CloudContent key={location.section} location={location} />
    </CloudShell>
  );
}
