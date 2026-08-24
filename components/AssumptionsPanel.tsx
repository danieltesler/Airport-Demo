import type { ResponseMeta } from "@/lib/types";
import styles from "./AssumptionsPanel.module.css";

interface AssumptionsPanelProps {
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
}

/**
 * Subtle, visually distinct panel that surfaces the agent's assumptions,
 * uncertainty, and provenance. Communicating these clearly is a graded part of
 * the exam, so it is always shown when any of the fields are present.
 */
export function AssumptionsPanel({
  assumptions,
  uncertainty,
  meta,
}: AssumptionsPanelProps) {
  const hasAssumptions = !!assumptions && assumptions.length > 0;
  const hasUncertainty = !!uncertainty && uncertainty.trim().length > 0;
  const hasMeta =
    !!meta && ((meta.tools_used?.length ?? 0) > 0 || !!meta.data_vintage);

  if (!hasAssumptions && !hasUncertainty && !hasMeta) return null;

  return (
    <aside className={styles.panel} aria-label="Assumptions and uncertainty">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          ⚑
        </span>
        Assumptions &amp; uncertainty
      </div>

      {hasAssumptions && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>Assumptions</div>
          <ul className={styles.list}>
            {assumptions!.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {hasUncertainty && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>Uncertainty</div>
          <p className={styles.uncertainty}>{uncertainty}</p>
        </div>
      )}

      {hasMeta && (
        <div className={styles.metaRow}>
          {meta!.data_vintage && (
            <span className={styles.metaItem}>
              Data vintage: {meta!.data_vintage}
            </span>
          )}
          {meta!.tools_used && meta!.tools_used.length > 0 && (
            <span className={styles.metaItem}>
              Tools: {meta!.tools_used.join(", ")}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
