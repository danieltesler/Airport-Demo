"use client";

import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import { airportChatAdapter } from "@/lib/chatModelAdapter";
import { MarkdownSpeechSynthesisAdapter } from "@/lib/speechAdapters";

/**
 * Provides the assistant-ui LocalRuntime to the tree. The runtime talks to our
 * same-origin `/api/chat` via the custom chat-model adapter, and read-aloud
 * comes from the Markdown-aware speech adapter. Mic dictation is handled
 * separately in VoiceInput (a direct SpeechRecognition control) rather than the
 * built-in dictation adapter, which was unreliable and locked to en-US.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(airportChatAdapter, {
    adapters: {
      speech: new MarkdownSpeechSynthesisAdapter(),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
