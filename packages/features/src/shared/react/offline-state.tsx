import { Cloud } from "@hyori-cloud/lib/icons";
import { RegionState } from "@hyori-cloud/ui/components/region-state";

export function OfflineState() {
  return (
    <RegionState
      role="status"
      icon={<Cloud />}
      title="You’re offline"
      description="This will load as soon as your connection returns."
    />
  );
}
