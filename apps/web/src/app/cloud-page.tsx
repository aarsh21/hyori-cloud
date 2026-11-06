import { CloudScreen, createNavigationGuard } from "@hyori-cloud/features/react";
import { useBlocker, useLocation, useRouter } from "@tanstack/react-router";
import { useState } from "react";

export function CloudPage() {
  const path = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  const [navigationGuard] = useState(createNavigationGuard);

  // Covers Back, typed URLs and reload. Features ask through the guard, and never touch the router.
  useBlocker({
    shouldBlockFn: () =>
      navigationGuard.isHeld() &&
      !window.confirm("Leave this document? Changes you haven’t saved will be lost."),
    enableBeforeUnload: () => navigationGuard.isHeld(),
  });

  return (
    <CloudScreen
      path={path}
      onNavigate={(nextPath) => router.history.push(nextPath)}
      navigationGuard={navigationGuard}
    />
  );
}
