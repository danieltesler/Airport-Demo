/** The few thread controls a fresh start needs; assistant-ui's `aui.thread()` provides them. */
export interface ResettableThread {
  getState: () => { isRunning: boolean };
  cancelRun: () => void;
  reset: () => void;
}

/**
 * Throw the current conversation away and go back to the empty home screen.
 *
 * Order matters: a running answer is cancelled first (reset alone leaves its request running),
 * and anything still being read aloud is stopped and marked stale so a late answer is never spoken
 * into the new chat. The runtime ignores updates from a cancelled run once the thread is reset.
 */
export function startNewChat(thread: ResettableThread, stopSpeech: () => void): void {
  if (thread.getState().isRunning) thread.cancelRun();
  stopSpeech();
  thread.reset();
}

/** True when a thread that had messages is now empty, i.e. the user started a new chat. */
export function threadWasCleared(previousCount: number, count: number): boolean {
  return previousCount > 0 && count === 0;
}
