"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { orbLevel, orbVisual, type OrbPhase } from "./orbState";
import styles from "./voiceOrb.module.css";

interface VoiceOrbProps {
  phase: OrbPhase;
  /** Optional 0-1 speech level; scales the orb slightly. Ignored when motion is reduced. */
  level?: number;
  /** Small hero version for the empty state. */
  small?: boolean;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * A glowing sphere drawn with CSS only. Its look follows the phase (idle, listening, thinking,
 * speaking, paused); the stylesheet animates transform and opacity only. Purely presentational.
 */
export function VoiceOrb({ phase, level, small = false }: VoiceOrbProps) {
  const reduced = usePrefersReducedMotion();
  const style = { "--orb-level": orbLevel(level, reduced) } as CSSProperties;

  return (
    <div
      className={small ? `${styles.orb} ${styles.orbSmall}` : styles.orb}
      data-visual={orbVisual(phase)}
      style={style}
      aria-hidden="true"
    >
      <div className={styles.levelScale}>
        <div className={styles.glow} />
        <div className={styles.ring} />
        <div className={`${styles.ring} ${styles.ringSecond}`} />
        <div className={styles.sphere}>
          <div className={styles.swirl}>
            <div className={styles.conic} />
            <div className={styles.blobB} />
            <div className={`${styles.ribbon} ${styles.ribbonCyan}`} />
            <div className={`${styles.ribbon} ${styles.ribbonViolet}`} />
            <div className={`${styles.ribbon} ${styles.ribbonPink}`} />
            <div className={`${styles.ribbon} ${styles.ribbonTeal}`} />
            <div className={`${styles.ribbon} ${styles.ribbonBlue}`} />
            <div className={`${styles.ribbon} ${styles.ribbonRose}`} />
          </div>
          <div className={styles.pearl} />
          <div className={styles.rim} />
          <div className={styles.highlight} />
        </div>
      </div>
    </div>
  );
}
