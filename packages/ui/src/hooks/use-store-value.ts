import * as React from "react";

type ObservableValue<Value> = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Value;
};

/** Reads a small vanilla store, so feature code never subscribes to anything itself. */
export function useStoreValue<Value>(store: ObservableValue<Value>) {
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
