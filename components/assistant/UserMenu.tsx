"use client";

import { useEffect, useId, useRef, useState } from "react";
import { signOut } from "@/lib/api";
import { useAuthStatus } from "./AuthStatusProvider";
import styles from "./chat.module.css";

/**
 * Header avatar for a signed-in user. It opens a small panel with the name, the email and Sign out.
 * Renders nothing when nobody is signed in. The panel is a disclosure (a button that shows and hides
 * a group), so it needs no arrow-key handling: Tab walks into it, Escape or a click outside closes it.
 */
export function UserMenu() {
  const auth = useAuthStatus();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pictureBroken, setPictureBroken] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  if (!auth?.signedIn) return null;

  const name = auth.name || auth.email || "Signed in";
  const showEmail = !!auth.email && auth.email !== name;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Tabbing out of the panel closes it, so it never stays open behind the conversation.
  const handleBlur = (event: React.FocusEvent) => {
    if (open && !containerRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    window.location.assign("/"); // a full reload drops the conversation and re-checks the session
  };

  return (
    <div ref={containerRef} className={styles.userMenu} onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.userTrigger}
        aria-label={`Account: ${name}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {auth.picture && !pictureBroken ? (
          // no-referrer: Google's image host can refuse requests that carry another site's address
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.userAvatar} src={auth.picture} alt="" referrerPolicy="no-referrer" onError={() => setPictureBroken(true)} />
        ) : (
          <span className={styles.userAvatar} aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </button>

      {open && (
        <div id={panelId} className={styles.userPanel} role="group" aria-label="Account">
          <div className={styles.userIdentity}>
            <span className={styles.userPanelName}>{name}</span>
            {showEmail && <span className={styles.userPanelEmail}>{auth.email}</span>}
          </div>
          <button type="button" className={styles.signOutItem} disabled={signingOut} onClick={handleSignOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
