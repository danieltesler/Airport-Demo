import type { ResponseMeta } from "@/lib/types";
import { PANEL_LABELS, type Lang } from "@/lib/i18n";
import styles from "./AssumptionsPanel.module.css";

interface AssumptionsPanelProps {
  assumptions?: string[] | null;
  uncertainty?: string | null;
  meta?: ResponseMeta | null;
}

/**
 * Subtle, visually distinct panel that surfaces the agent's assumptions,
 * uncertainty, and provenance. It is always shown when any of these are present,
 * and follows the answer's language (labels and direction switch to Hebrew when
 * the conversation is in Hebrew).
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

  const lang: Lang = meta?.lang === "he" ? "he" : "en";
  const t = (key: keyof typeof PANEL_LABELS) => PANEL_LABELS[key][lang];

  return (
    <aside
      className={styles.panel}
      aria-label={t("title")}
      dir={lang === "he" ? "rtl" : "ltr"}
    >
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          ⚑
        </span>
        {t("title")}
      </div>

      {hasAssumptions && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>{t("assumptions")}</div>
          <ul className={styles.list}>
            {assumptions!.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {hasUncertainty && (
        <div className={styles.block}>
          <div className={styles.blockLabel}>{t("uncertainty")}</div>
          <p className={styles.uncertainty}>{uncertainty}</p>
        </div>
      )}

      {hasMeta && (
        <div className={styles.metaRow}>
          {meta!.data_vintage && (
            <span className={styles.metaItem}>
              {t("dataVintage")}: {meta!.data_vintage}
            </span>
          )}
          {meta!.tools_used && meta!.tools_used.length > 0 && (
            <span className={styles.metaItem}>
              {t("tools")}: {meta!.tools_used.join(", ")}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
