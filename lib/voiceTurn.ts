/**
 * Remembers which question was spoken, so only that answer is read aloud
 * automatically. Typed questions stay silent. Matching on the transcript text
 * (not a bare flag) means a typed message sent in between cannot trigger speech.
 */
let spokenQuestion: string | null = null;

export function markVoiceTurn(transcript: string): void {
  spokenQuestion = transcript.trim();
}

/** True once, for the answer to the question that was marked. */
export function consumeVoiceTurn(message: string): boolean {
  const matches = spokenQuestion !== null && spokenQuestion === message.trim();
  spokenQuestion = null;
  return matches;
}
