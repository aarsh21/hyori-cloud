import type { Locator } from "playwright-core";

declare global {
  interface Window {
    deliveryCommittedControls: WeakSet<Element>;
    deliverySignInCommitMs: number | null;
    deliverySignInTwoFramesMs: number | null;
  }
}

/** Installed before production React starts, identically on both measured builds. */
export function observeDeliveryHydration(selector = "button") {
  const committed = new WeakSet<Element>();

  Object.assign(window, {
    deliveryCommittedControls: committed,
    deliverySignInCommitMs: null,
    deliverySignInTwoFramesMs: null,
    // A Fiber can appear during concurrent rendering. Do not count SSR markup until commit.
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot() {
        for (const control of document.querySelectorAll(selector)) {
          if (Object.keys(control).some((key) => key.startsWith("__reactFiber$"))) {
            committed.add(control);

            if (
              window.deliverySignInCommitMs === null &&
              control instanceof HTMLButtonElement &&
              control.type === "submit" &&
              // The shared button also reserves width with an aria-hidden pending label.
              control.textContent?.startsWith("Sign in") &&
              !control.disabled
            ) {
              window.deliverySignInCommitMs = performance.now();
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  window.deliverySignInTwoFramesMs = performance.now();
                });
              });
            }
          }
        }
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
