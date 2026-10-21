/**
 * Response security headers for every route (used by next.config.mjs, tested in
 * lib/securityHeaders.test.ts).
 *
 * The CSP is as tight as the app allows:
 *  - script-src 'unsafe-inline': Next.js inlines its hydration scripts. 'unsafe-eval' is added
 *    only in development (React Refresh needs it); the production build does not.
 *  - img-src https://*.googleusercontent.com: the signed-in user's Google profile picture (the avatar
 *    in the header). Nothing else is loaded from another origin.
 *  - media-src blob: data:: spoken answers play from a blob URL, and the iOS audio unlock uses a
 *    data: WAV (lib/voicePlayback.ts).
 *  - connect-src 'self': every fetch (/api/chat, /api/stt, /api/tts, /api/health, /api/auth/*) is same-origin;
 *    Sign in with Google is a top-level navigation to accounts.google.com, which no CSP directive here restricts
 *    (form-action only covers form submissions, and sign-in uses a link);
 *    development adds ws: so the dev server's hot reload socket works.
 *  - microphone=(self): the page itself may record; no other origin may, and camera and
 *    geolocation are off.
 */

/** @param {boolean} production */
export function contentSecurityPolicy(production) {
  const script = ["'self'", "'unsafe-inline'", ...(production ? [] : ["'unsafe-eval'"])];
  const connect = ["'self'", ...(production ? [] : ["ws:", "wss:"])];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.googleusercontent.com",
    "media-src 'self' blob: data:",
    `connect-src ${connect.join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** @param {boolean} production */
export function securityHeaders(production) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(production) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
  ];
}
