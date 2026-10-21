"use client";

import { useAuthStatus } from "./AuthStatusProvider";
import { ExampleChips } from "./ExampleChips";
import { SignInCard } from "./SignInCard";
import styles from "./chat.module.css";

/**
 * What the home screen offers under the greeting: the example cards, or, when sign-in is required
 * and nobody is signed in, the sign-in card instead. The example cards are hidden rather than
 * disabled: a row of greyed-out cards says nothing the card does not, and hiding them also frees
 * the room the card needs on a short screen. While the server has not answered yet the cards keep
 * their space but stay invisible, so a signed-out visitor never sees them flash and the page does not shift.
 */
export function HomeStart() {
  const auth = useAuthStatus();
  if (auth?.required && !auth.signedIn) return <SignInCard variant="start" />;

  return (
    <div className={auth ? undefined : styles.awaitingAuth}>
      <span className={styles.tryLabel} id="try-asking">
        Try asking
      </span>
      <ExampleChips />
    </div>
  );
}
