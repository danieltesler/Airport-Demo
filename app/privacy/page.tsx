import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · Airport Investment Intelligence",
};

// Google requires a public privacy policy before a sign-in app can be published; this states plainly what the demo handles.
export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px 64px", lineHeight: 1.6, color: "#16151A" }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 300, fontSize: 40, lineHeight: 1.1, margin: "0 0 8px" }}>
        Privacy
      </h1>
      <p style={{ color: "#4F4B5A", margin: "0 0 32px" }}>Airport Investment Intelligence is a demonstration app.</p>

      <h2 style={{ fontSize: 18, margin: "24px 0 8px" }}>What we use when you sign in with Google</h2>
      <p>
        Your name, email address and profile picture, read from the ID token Google returns. We use them only to keep
        you signed in, in a secure cookie that expires after 8 hours. We do not store them in a database and we do not
        keep Google&apos;s access tokens.
      </p>

      <h2 style={{ fontSize: 18, margin: "24px 0 8px" }}>What you ask</h2>
      <p>
        Your typed questions and voice recordings are sent to OpenAI (to understand the question and turn speech into
        text) and to ElevenLabs (to read the answer aloud). Nothing you ask is stored by this app. Conversation history
        stays in your browser.
      </p>

      <h2 style={{ fontSize: 18, margin: "24px 0 8px" }}>Data sources</h2>
      <p>
        Answers use public aviation data from U.S. government sources and OurAirports. No personal data is used in the
        analysis.
      </p>

      <h2 style={{ fontSize: 18, margin: "24px 0 8px" }}>Signing out</h2>
      <p>Use Sign out in the app menu to clear your session cookie at any time.</p>

      <p style={{ marginTop: 40 }}>
        <a href="/" style={{ color: "#5A3FE0" }}>Back to the app</a>
      </p>
    </main>
  );
}
