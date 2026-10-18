"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./StructuredResult.module.css";

/**
 * A sideways-scrolling container that shows a soft shadow on its right edge while more
 * content is hidden there, so a table wider than the screen is never a silent surprise.
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [moreOnRight, setMoreOnRight] = useState(false);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setMoreOnRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={styles.scrollFrame} data-more={moreOnRight}>
      <div ref={scroller} className={styles.tableScroll} tabIndex={0} role="region" aria-label={label}>
        {children}
      </div>
    </div>
  );
}
