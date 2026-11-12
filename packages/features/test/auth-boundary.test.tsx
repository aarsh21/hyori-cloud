import { expect } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { ClientSDKProvider, setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { QueryClient, QueryClientProvider } from "@hyori-cloud/lib/query";
import { MutationObserver } from "@hyori-cloud/lib/query-core";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";
import { render } from "@testing-library/react";
import { AuthBoundary } from "#features/auth/react/auth-boundary.tsx";
import {
  act,
  ApiFailure,
  createFakeApi,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

test("real AuthBoundary removes old authenticated content after logout despite a failed identity refresh", async () => {
  let failRefresh = false;

  const api = createFakeApi({
    "auth.status": () => {
      if (failRefresh) throw new ApiFailure("service.unavailable", "Refresh unavailable");

      return { initialized: true, user: SIGNED_IN_USER };
    },
    "auth.logout": () => ({ success: true }),
  });

  const sdk = createClient({ fetch: api.fetch });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  setMutationDefaults(queryClient);
  await queryClient.fetchQuery(sdk.query.auth.status.getOptions({}));
  queryClient.setQueryData(sdk.query.files.list.getKey({}), {
    items: [],
    folder: null,
    breadcrumbs: [],
    nextCursor: null,
  });

  const view = render(
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <ClientSDKProvider sdkClient={sdk}>
          <AuthBoundary>Private content</AuthBoundary>
        </ClientSDKProvider>
      </QueryClientProvider>
    </AppearanceProvider>,
  );

  try {
    expect(screen.getByText("Private content")).toBeTruthy();
    failRefresh = true;
    await act(async () => {
      await new MutationObserver(queryClient, sdk.mutation.auth.logout.mutationOptions()).mutate(
        {},
      );
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(sdk.query.auth.status.getKey({}))?.status).toBe("error"),
    );
    const cachedStatus = queryClient.getQueryData(sdk.query.auth.status.getKey({}));

    expect(cachedStatus?.initialized).toBe(true);
    expect(cachedStatus?.user).toBeNull();
    expect(queryClient.getQueryData(sdk.query.files.list.getKey({}))).toBeUndefined();
    expect(screen.queryByText("Private content") === null).toBe(true);
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
  } finally {
    view.unmount();
    queryClient.clear();
    sdk.dispose();
  }
});

test("retrying keeps the same focused button in place, however the attempt ends", async () => {
  let attempt = 0;

  const api = createFakeApi({
    "auth.status": () => {
      attempt += 1;

      if (attempt < 3) throw new ApiFailure("service.unavailable");

      return { initialized: true, user: SIGNED_IN_USER };
    },
  });

  mount(<AuthBoundary>Private content</AuthBoundary>, api);

  const retry = await screen.findByRole("button", { name: "Try again" });

  act(() => retry.focus());
  fireEvent.click(retry);

  await waitFor(() => expect(attempt).toBe(2));
  await waitFor(() => expect(retry.getAttribute("aria-busy")).toBeNull());
  expect(retry.isConnected).toBe(true);
  expect(document.activeElement).toBe(retry);

  fireEvent.click(retry);

  expect(await screen.findByText("Private content")).toBeTruthy();
});
