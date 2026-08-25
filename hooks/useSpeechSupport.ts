"use client";

import { useEffect, useState } from "react";

/**
 * Reports whether the "Read aloud" control should show. Read-aloud now uses OpenAI
 * TTS (via /api/tts) played through an <audio> element, which every browser has, so
 * it's effectively always available. We still flip it on after mount (starting
 * false) to keep the server and first client render identical and avoid hydration
 * mismatches.
 *
 * Mic dictation availability is detected separately, inside useDictation.
 */
export function useSpeechSupport(): { synthesis: boolean } {
  const [synthesis, setSynthesis] = useState(false);

  useEffect(() => {
    setSynthesis(true);
  }, []);

  return { synthesis };
}
