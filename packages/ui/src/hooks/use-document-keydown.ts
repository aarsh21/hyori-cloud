import { useEffect, useEffectEvent } from "react";

/**
 * Host adapter. Global shortcuts must fire when focus rests on `<body>`, which no React handler in
 * the tree can observe, so this subscribes to the document directly. Registered as a host adapter:
 * portable features consume the hook and never touch the effect.
 */
export function useDocumentKeydown(handler: (event: KeyboardEvent) => void) {
  const onKeydown = useEffectEvent(handler);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeydown(event);
    document.addEventListener("keydown", listener);

    return () => document.removeEventListener("keydown", listener);
  }, []);
}
