"use client";

import { useSyncExternalStore } from "react";
import { voiceTrace } from "@/lib/voiceTrace";

/**
 * A small collapsible log of what the voice just did, shown only with ?debug=voice in the URL (it is
 * loaded on demand, so nothing here ships to anyone else). Event names and timings only: nothing the
 * user said and nothing the assistant answered.
 */
export default function VoiceDebugPanel() {
  const trace = voiceTrace();
  const events = useSyncExternalStore(trace.subscribe, trace.events, () => []);

  return (
    <details
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 60,
        maxWidth: "calc(100vw - 16px)",
        padding: "0.35rem 0.5rem",
        border: "1px solid #94a3b8",
        borderRadius: 8,
        background: "rgba(15, 23, 42, 0.92)",
        color: "#e2e8f0",
        fontSize: "0.68rem",
        lineHeight: 1.35,
      }}
    >
      <summary style={{ cursor: "pointer" }}>Voice debug ({events.length})</summary>
      <div style={{ maxHeight: "40vh", overflow: "auto", marginTop: 4 }}>
        {events.length === 0 && <div>No voice events yet.</div>}
        {events.map((entry, index) => (
          <div key={`${index}-${entry.at}-${entry.event}`} style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            +{entry.at}ms {entry.event}
            {entry.detail ? ` (${entry.detail})` : ""}
          </div>
        ))}
        <button type="button" onClick={() => trace.clear()} style={{ marginTop: 4, fontSize: "0.68rem" }}>
          Clear
        </button>
      </div>
    </details>
  );
}
