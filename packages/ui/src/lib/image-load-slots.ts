// Previews are full originals and share the server's transfer limit with uploads and downloads, so
// a screenful of tiles can't all ask at once. Below that limit on purpose, to leave room for those.
const MAX_LOADING = 6;

type Slot = { readonly grant: () => void };

const loading = new Set<Slot>();
const waiting: Slot[] = [];

function admitNext() {
  while (loading.size < MAX_LOADING) {
    const next = waiting.shift();

    if (next === undefined) return;
    loading.add(next);
    next.grant();
  }
}

/** One image's place in line. Subscribing joins it and unsubscribing leaves, freeing any held slot. */
export function createImageLoadSlot() {
  let granted = false;
  let finished = false;
  let notify = () => {};

  const slot: Slot = {
    grant() {
      granted = true;
      notify();
    },
  };

  function leave() {
    const queued = waiting.indexOf(slot);

    if (queued !== -1) waiting.splice(queued, 1);

    if (loading.delete(slot)) admitNext();
  }

  return {
    isGranted: () => granted,
    subscribe(listener: () => void) {
      notify = listener;

      if (!granted && !finished) {
        waiting.push(slot);
        admitNext();
      } else if (granted && !finished) {
        loading.add(slot);
      }

      return () => {
        notify = () => {};

        leave();
      };
    },
    /** Loaded or failed: the image stays on screen, and its place goes to the next one. */
    finish() {
      finished = true;
      leave();
    },
  };
}
