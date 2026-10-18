/**
 * A counter that says which spoken question an answer belongs to. Anything that makes a pending
 * spoken answer stale bumps it: a new question, End, a pause, the user tapping to talk, leaving the
 * page. An answer is only spoken (and a "one moment" only played) if the counter has not moved since
 * the question was sent, so nothing speaks after the user has moved on.
 */
let epoch = 0;

export const currentVoiceEpoch = (): number => epoch;

/** Mark every spoken answer still pending as stale; returns the new epoch. */
export function bumpVoiceEpoch(): number {
  epoch += 1;
  return epoch;
}
