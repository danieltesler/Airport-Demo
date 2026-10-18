/**
 * Tells a hands-free session when the page goes away or comes back.
 *
 * Chrome on Android can freeze a backgrounded page (the `freeze` event) without ever firing
 * `visibilitychange`, and `pagehide` fires when the page is leaving whatever `visibilityState`
 * says, so all of them pause the session. Coming back (`visibilitychange` to visible, or `resume`)
 * only re-requests the screen wake lock if a session still wants it; it never restarts listening.
 */

export interface LifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface LifecycleDocument extends LifecycleTarget {
  readonly visibilityState: string;
}

export function watchPageLifecycle(options: {
  document: LifecycleDocument;
  window: LifecycleTarget;
  onHidden: () => void;
  onVisible: () => void;
}): () => void {
  const { document, window, onHidden, onVisible } = options;

  const onVisibilityChange = () => (document.visibilityState === "hidden" ? onHidden() : onVisible());

  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("freeze", onHidden);
  document.addEventListener("resume", onVisible);
  window.addEventListener("pagehide", onHidden);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("freeze", onHidden);
    document.removeEventListener("resume", onVisible);
    window.removeEventListener("pagehide", onHidden);
  };
}
