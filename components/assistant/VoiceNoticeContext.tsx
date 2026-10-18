"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { VoiceNotice } from "./voiceNotice";

interface VoiceNoticeValue {
  notice: VoiceNotice | null;
  setNotice: (notice: VoiceNotice | null) => void;
}

const VoiceNoticeContext = createContext<VoiceNoticeValue>({ notice: null, setNotice: () => {} });

/** Lets the voice controls (inside the composer pill) put one calm line above the composer. */
export function VoiceNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<VoiceNotice | null>(null);
  const value = useMemo(() => ({ notice, setNotice }), [notice]);
  return <VoiceNoticeContext.Provider value={value}>{children}</VoiceNoticeContext.Provider>;
}

export const useVoiceNotice = (): VoiceNoticeValue => useContext(VoiceNoticeContext);
