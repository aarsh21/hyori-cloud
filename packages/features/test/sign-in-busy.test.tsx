import { expect } from "bun:test";
import { LoginScreen } from "#features/auth/react/login-screen.tsx";
import {
  ApiFailure,
  createFakeApi,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

function submit() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: SIGNED_IN_USER.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

test("a sign-in answered busy is retried on its own and signs in once the lane clears", async () => {
  let busy = 3;

  const api = createFakeApi({
    "auth.login": () => {
      if (busy-- > 0) throw new ApiFailure("auth.signInBusy", "Sign-in is busy");

      return SIGNED_IN_USER;
    },
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
  });

  mount(<LoginScreen />, api);
  submit();

  await waitFor(() => expect(api.callsTo("auth.login")).toHaveLength(4));
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
  expect(screen.queryByText("Sign-in is busy right now")).toBeNull();
  expect(screen.queryByText("Too many attempts")).toBeNull();
});

test("a lane still full after every retry says sign-in is busy, not too many attempts", async () => {
  const api = createFakeApi({
    "auth.login": () => {
      throw new ApiFailure("auth.signInBusy", "Sign-in is busy");
    },
  });

  mount(<LoginScreen />, api);
  submit();

  expect(await screen.findByText("Sign-in is busy right now")).toBeTruthy();
  expect(api.callsTo("auth.login")).toHaveLength(5);
  expect(screen.queryByText("Too many attempts")).toBeNull();
});

test("a lockout is shown at once, without retrying", async () => {
  const api = createFakeApi({
    "auth.login": () => {
      throw new ApiFailure("auth.rateLimited", "Too many attempts");
    },
  });

  mount(<LoginScreen />, api);
  submit();

  expect(await screen.findByText("Too many attempts")).toBeTruthy();
  expect(api.callsTo("auth.login")).toHaveLength(1);
});
