import type { ReactNode } from "@hyori-cloud/lib/react";
import { FocusLayout } from "@hyori-cloud/ui/components/focus-layout";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Row } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { CurrentUserProvider } from "#features/auth/react/current-user.tsx";
import { LoginScreen } from "#features/auth/react/login-screen.tsx";
import { SetupScreen } from "#features/auth/react/setup-screen.tsx";
import { useAuthStatus } from "#features/auth/react/use-auth-status.ts";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";

/**
 * Data first: a failed background refresh keeps the signed-in app on screen. An unreachable
 * backend is a service failure and is never presented as an uninitialized instance.
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const status = useAuthStatus();

  if (status.data !== undefined) {
    if (!status.data.initialized) return <SetupScreen />;

    if (status.data.user === null) return <LoginScreen />;

    return <CurrentUserProvider value={status.data.user}>{children}</CurrentUserProvider>;
  }

  return (
    <FocusLayout>
      <Wordmark />
      <QueryWaiting
        resource={status}
        pending={
          <Row className="min-h-9">
            <Spinner />
          </Row>
        }
      />
    </FocusLayout>
  );
}
