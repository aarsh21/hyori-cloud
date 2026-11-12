import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { SunMoon } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";

const AppearanceMenu = lazy(async () => {
  const module = await import("@hyori-cloud/ui/components/appearance-menu");

  return { default: module.AppearanceMenu };
});

/** The sign-in form can hydrate before the optional menu and its positioning library arrive. */
export function DeferredAppearanceMenu() {
  return (
    <Suspense
      fallback={
        <Button variant="ghost" disabled>
          <SunMoon aria-hidden />
          Appearance
        </Button>
      }
    >
      <AppearanceMenu />
    </Suspense>
  );
}
