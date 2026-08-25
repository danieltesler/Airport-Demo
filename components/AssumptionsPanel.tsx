import type { ResponseMeta } from "@/lib/types";
import { PANEL_LABELS } from "@/lib/i18n";
import styles from "./AssumptionsPanel.module.css";

interface AssumptionsPanelProps {
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
}

/**
 * Subtle, visually distinct panel that surfaces the agent's assumptions,
 * uncertainty, and provenance. It only appears when real analysis ran (a tool call),
 * so greetings and small talk don't drag in a data-vintage panel.
 */
export function AssumptionsPanel({
  assumptions,
  uncertainty,
  meta,
}: AssumptionsPanelProps) {
  const hasAssumptions = !!assumptions && assumptions.length > 0;
  const hasUncertainty = !!uncertainty && uncertainty.trim().length > 0;
  const usedTools = (meta?.tools_used?.length ?? 0) > 0;

  if (!hasAssumptions && !hasUncertainty && !usedTools) return null;

  const hasMeta = usedTools && !!meta?.data_vintage;

  return (
    <aside className={styles.panel} aria-label={PANEL_LABELS.title}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          ⚑
        </span>
        {PANEL_LABELS.title}
      </div>

      {hasAssumptions && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>{PANEL_LABELS.assumptions}</div>
          <ul className={styles.list}>
            {assumptions!.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {hasUncertainty && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>{PANEL_LABELS.uncertainty}</div>
          <p className={styles.uncertainty}>{uncertainty}</p>
        </div>
      )}

      {(hasMeta || usedTools) && (
        <div className={styles.metaRow}>
          {meta?.data_vintage && (
            <span className={styles.metaItem}>
              {PANEL_LABELS.dataVintage}: {meta.data_vintage}
            </span>
          )}
          {meta?.tools_used && meta.tools_used.length > 0 && (
            <span className={styles.metaItem}>
              {PANEL_LABELS.tools}: {meta.tools_used.join(", ")}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
