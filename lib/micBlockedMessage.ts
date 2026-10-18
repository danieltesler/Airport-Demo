const GENERIC = "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
const CHROME =
  "Microphone access is blocked. In Chrome, tap the lock icon, then Permissions, and allow the microphone.";

/** Chrome-specific steps only when the browser is Chromium-based; every other browser gets the generic wording. */
export function micBlockedMessage(userAgent: string): string {
  const isChromium = /(Chrome|Chromium|CriOS)\//.test(userAgent) && !/(Firefox|FxiOS)\//.test(userAgent);
  return isChromium ? CHROME : GENERIC;
}
