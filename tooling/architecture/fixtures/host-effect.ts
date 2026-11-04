import { useEffect as synchronize } from "@hyori-cloud/lib/react";

export function useHostSynchronization() {
  synchronize(() => undefined, []);
}
