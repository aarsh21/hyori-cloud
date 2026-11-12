/**
 * Lets a screen with unsaved work ask the host to warn before leaving. The host owns the router and
 * the browser's unload prompt, and features never touch either.
 */
export function createNavigationGuard() {
  const holds = new Set<symbol>();

  return {
    isHeld: () => holds.size > 0,
    hold() {
      const hold = Symbol("unsaved work");

      holds.add(hold);

      return () => {
        holds.delete(hold);
      };
    },
  };
}

export type NavigationGuard = ReturnType<typeof createNavigationGuard>;
