import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptMessage } from "@/lib/types";
import { StructuredResult } from "./StructuredResult";
import { AssumptionsPanel } from "./AssumptionsPanel";
import styles from "./MessageBubble.module.css";

interface MessageBubbleProps {
  message: TranscriptMessage;
}

/**
 * One turn in the transcript. User turns are plain text; assistant turns render
 * Markdown and, when present, the structured table/chart and the assumptions
 * panel directly beneath the bubble.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`${styles.row} ${isUser ? styles.rowUser : styles.rowAgent}`}>
      <div className={styles.meta}>{isUser ? "You" : "Analyst agent"}</div>
      <div
        className={`${styles.bubble} ${
          isUser ? styles.bubbleUser : styles.bubbleAgent
        }`}
      >
        {isUser ? (
          <p className={styles.userText}>{message.content}</p>
        ) : (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {!isUser && message.structured && (
        <StructuredResult data={message.structured} />
      )}

      {!isUser && (
        <AssumptionsPanel
          assumptions={message.assumptions}
          uncertainty={message.uncertainty}
          meta={message.meta}
        />
      )}
    </div>
  );
}
