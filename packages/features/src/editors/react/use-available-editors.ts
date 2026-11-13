import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";
import { createContext } from "@hyori-cloud/lib/react";

/** A file browser observes capabilities once; its rows and portaled menus share that answer. */
export const AvailableEditorsContext = createContext<ReturnType<typeof useAvailableEditors> | null>(
  null,
);

/** One instance-wide read shared through the app's cache, however many rows ask. */
export function useAvailableEditors() {
  const { query } = useClientSDK();

  return useQuery(query.editors.available.getOptions({}));
}
