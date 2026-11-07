import type { EditorBackendOptions } from "@hyori-cloud/client-sdk";

type ChooseDestination = NonNullable<EditorBackendOptions["chooseDestination"]>;

type Output = Parameters<ChooseDestination>[0];

type Destination = Awaited<ReturnType<ChooseDestination>>;

type Pending = { readonly output: Output; readonly settle: (choice: Destination) => void };

/**
 * Turns the SDK's request for a destination into something a dialog can show and answer. Only the
 * person's choice crosses here: where a save may go is still the server's decision. A cancelled
 * request answers null, which the SDK reports as a cancelled copy rather than a save to root.
 */
export function createDestinationRequests() {
  const listeners = new Set<() => void>();
  let pending: Pending | null = null;
  let output: Output | null = null;

  function settle(choice: Destination) {
    const current = pending;

    pending = null;
    output = null;
    current?.settle(choice);

    for (const listener of listeners) listener();
  }

  const choose: ChooseDestination = (requested, { signal }) =>
    new Promise((resolve) => {
      // One at a time: the SDK saves one output at a time, so a second means the first was dropped.
      settle(null);

      // Aborting withdraws this request only, never a newer one that has replaced it.
      const withdraw = () => {
        if (pending === request) settle(null);
      };

      const request: Pending = {
        output: requested,
        settle(choice) {
          signal.removeEventListener("abort", withdraw);
          resolve(choice);
        },
      };

      pending = request;
      output = requested;

      signal.addEventListener("abort", withdraw, { once: true });

      for (const listener of listeners) listener();
    });

  return {
    choose,
    answer: settle,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => output,
  };
}

export type DestinationRequests = ReturnType<typeof createDestinationRequests>;
