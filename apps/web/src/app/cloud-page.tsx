import { CloudScreen } from "@hyori-cloud/features/react";
import { useLocation, useRouter } from "@tanstack/react-router";

export function CloudPage() {
  const path = useLocation({ select: (location) => location.pathname });
  const router = useRouter();

  return <CloudScreen path={path} onNavigate={(nextPath) => router.history.push(nextPath)} />;
}
