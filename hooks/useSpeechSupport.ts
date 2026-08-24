"use client";

import { useEffect, useState } from "react";

/**
 * Feature-detects the read-aloud (speechSynthesis) API so the UI can hide the
 * "Read aloud" control where it isn't supported. Detection runs after mount
 * (starts false), keeping server and first client render identical to avoid
 * hydration mismatches.
 *
 * Mic dictation availability is detected separately, inside useDictation.
 */
export function useSpeechSupport(): { synthesis: boolean } {
  const [synthesis, setSynthesis] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSynthesis("speechSynthesis" in window);
  }, []);

  return { synthesis };
}
