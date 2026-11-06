import type { EditorSessionOptions } from "#client-sdk/features/editors/editor-contract";

export function validateAutosaveTiming({
  idleMs,
  maxWaitMs,
}: NonNullable<EditorSessionOptions["autosave"]>) {
  if (
    !Number.isSafeInteger(idleMs) ||
    idleMs <= 0 ||
    !Number.isSafeInteger(maxWaitMs) ||
    maxWaitMs < idleMs ||
    maxWaitMs > 0x7fffffff
  )
    throw new Error("Invalid autosave timing");
}

/** Debounce bursts without letting continuous editing postpone capture forever. Owns no save policy. */
export function createAutosaveScheduler(
  timing: NonNullable<EditorSessionOptions["autosave"]>,
  flush: () => void,
) {
  validateAutosaveTiming(timing);
  const { idleMs, maxWaitMs } = timing;

  let idle: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    clearTimeout(idle);
    clearTimeout(deadline);
    idle = undefined;
    deadline = undefined;
  }

  function run() {
    cancel();
    flush();
  }

  return {
    pending: () => deadline !== undefined,
    schedule() {
      clearTimeout(idle);
      idle = setTimeout(run, idleMs);
      deadline ??= setTimeout(run, maxWaitMs);
    },
    cancel,
  };
}
