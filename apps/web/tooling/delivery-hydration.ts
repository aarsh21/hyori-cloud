import type { Locator } from "playwright-core";

declare global {
  interface Window {
    deliveryCommittedControls: WeakSet<Element>;
  }
}

/** Installed before production React starts, identically on both measured builds. */
export function observeDeliveryHydration(selector = "button") {
  const committed = new WeakSet<Element>();

  Object.assign(window, {
    deliveryCommittedControls: committed,
    // A Fiber can appear during concurrent rendering. Do not count SSR markup until commit.
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot() {
        for (const control of document.querySelectorAll(selector))
          if (Object.keys(control).some((key) => key.startsWith("__reactFiber$")))
            committed.add(control);
      },
    },
  });
}

export async function waitForDeliveryHydration(control: Locator) {
  await control.waitFor();
  await control
    .page()
    .waitForFunction(
      (element) => element && window.deliveryCommittedControls.has(element),
      await control.elementHandle(),
    );
}
