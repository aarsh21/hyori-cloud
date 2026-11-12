import type { User } from "@hyori-cloud/client-sdk";
import { createContext, useContext } from "@hyori-cloud/lib/react";

const CurrentUserContext = createContext<User | null>(null);

export const CurrentUserProvider = CurrentUserContext;

export function useCurrentUser(): User {
  const user = useContext(CurrentUserContext);

  if (user === null) throw new Error("useCurrentUser requires an authenticated AuthBoundary.");

  return user;
}
