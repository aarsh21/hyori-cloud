import { useEffect as synchronize } from "@hyori-cloud/lib/react";

export function useRejectedFeature() {
  synchronize(() => undefined, []);
}
