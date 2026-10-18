"use client";

import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import { airportChatAdapter } from "@/lib/chatModelAdapter";

/**
 * Provides the assistant-ui LocalRuntime to the tree. The runtime talks to our
 * same-origin `/api/chat` via the custom chat-model adapter. Speech is handled
 * outside the runtime: mic input in VoiceInput (useDictation) and playback in
 * lib/voicePlayback.ts, so read-aloud can speak the code-built summary rather
 * than the reply text assistant-ui would hand to a speech adapter.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(airportChatAdapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
