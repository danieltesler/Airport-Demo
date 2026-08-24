"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@/hooks/useChat";
import { useSpeech } from "@/hooks/useSpeech";
import { Header } from "./Header";
import { ExampleChips } from "./ExampleChips";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import { Composer } from "./Composer";
import { VoiceControls } from "./VoiceControls";
import styles from "./ChatWindow.module.css";

/**
 * Top-level orchestrator. Owns the composer's input text and wires together the
 * chat transcript (useChat) and the voice affordances (useSpeech). Presentation
 * components below stay stateless so dictation, example chips, and typing all
 * write to the same single input value.
 */
export function ChatWindow() {
  const { messages, isSending, send, latestAssistantReply } = useChat();
  const [input, setInput] = useState("");

  // Dictation writes recognized speech straight into the composer.
  const speech = useSpeech((transcript) => setInput(transcript));

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const isEmpty = messages.length === 0;

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isSending]);

  function submit() {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    void send(text);
  }

  // Example chips submit immediately rather than only populating the box.
  function pickExample(question: string) {
    if (isSending) return;
    setInput("");
    void send(question);
  }

  function toggleMic() {
    if (speech.isListening) speech.stopListening();
    else speech.startListening();
  }

  function toggleSpeak() {
    if (speech.isSpeaking) speech.cancelSpeaking();
    else if (latestAssistantReply) speech.speak(latestAssistantReply);
  }

  const voiceControls = (
    <VoiceControls
      recognitionSupported={speech.recognitionSupported}
      synthesisSupported={speech.synthesisSupported}
      isListening={speech.isListening}
      isSpeaking={speech.isSpeaking}
      canSpeak={Boolean(latestAssistantReply)}
      onToggleMic={toggleMic}
      onToggleSpeak={toggleSpeak}
    />
  );

  return (
    <div className={styles.shell}>
      <Header />

      <main className={styles.transcript}>
        {isEmpty ? (
          <div className={styles.empty}>
            <p className={styles.emptyLede}>
              I analyze U.S. airports for terminal-expansion potential using a
              transparent, rules-based scoring model over public aviation data.
            </p>
            <ExampleChips onPick={pickExample} disabled={isSending} />
          </div>
        ) : (
          <div className={styles.messages}>
            {messages.map((message, index) => (
              <MessageBubble key={index} message={message} />
            ))}
            {isSending && <TypingIndicator />}
            <div ref={transcriptEndRef} />
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        {!isEmpty && (
          <ExampleChips onPick={pickExample} disabled={isSending} />
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={submit}
          disabled={isSending}
          voiceSlot={voiceControls}
        />
      </footer>
    </div>
  );
}
