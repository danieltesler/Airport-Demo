/** The footer text already carries its own label for live and mixed turns ("Live data: ...", "Dataset: ... | Live data: ..."). */
const SELF_LABELLED = /^(Live data|Dataset):/;

/** One label per footer: self-labelled text passes through; a plain dataset vintage gets "Data vintage: ". */
export function vintageLine(vintage: string, vintageLabel: string): string {
  return SELF_LABELLED.test(vintage) ? vintage : `${vintageLabel}: ${vintage}`;
}

/** The card is only worth showing when it has assumptions or caveats; a provenance-only card is noise. */
export function hasPanelContent(assumptions?: string[] | null, uncertainty?: string | null): boolean {
  return (assumptions?.length ?? 0) > 0 || !!uncertainty?.trim();
}
