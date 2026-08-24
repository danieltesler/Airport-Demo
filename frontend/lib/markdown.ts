/**
 * Convert a Markdown reply into plain, speakable text for text-to-speech.
 * This is intentionally simple: it removes the most common Markdown syntax so
 * the speech synthesizer doesn't read out asterisks, backticks, and hashes.
 * It is NOT a security sanitizer — react-markdown handles safe rendering.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    // fenced code blocks -> keep inner text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    // inline code
    .replace(/`([^`]+)`/g, "$1")
    // images ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // bold / italic markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // headings and blockquotes at line start
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    // list bullets
    .replace(/^\s*[-*+]\s+/gm, "")
    // horizontal rules
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    // collapse extra whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
