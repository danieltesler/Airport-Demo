"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant reply text as Markdown (GitHub-flavored). Used as the
 * `Text` part component inside the assistant message. Streaming is off because
 * our backend returns complete replies, so there's no typing animation to run.
 */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="markdown"
      remarkPlugins={[remarkGfm]}
      smooth={false}
    />
  );
}
