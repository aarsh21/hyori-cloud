import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { CloudContent } from "#features/cloud/react/cloud-content.tsx";
import { CloudShell } from "#features/cloud/react/cloud-shell.tsx";

type ShellLocation = Exclude<
  CloudLocation,
  { section: "invite" | "publicShare" | "publicEditor" | "editor" }
>;

/** The signed-in application as one chunk, so anyone at the sign-in screen never downloads it. */
export function SignedInCloud({ location }: { location: ShellLocation }) {
  return (
    <CloudShell>
      <CloudContent location={location} />
    </CloudShell>
  );
}
