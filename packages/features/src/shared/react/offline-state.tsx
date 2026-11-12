import { Cloud } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { RegionState } from "@hyori-cloud/ui/components/region-state";

/** Everything that waits for a connection says so the same way, and loads again on its own. */
export function OfflineState({ action }: { action?: ReactNode }) {
  return (
    <RegionState
      role="status"
      icon={<Cloud />}
      title="You’re offline"
      description="This will load as soon as your connection returns."
      action={action}
    />
  );
}
