import styles from "./ExampleChips.module.css";

/** The four sample questions from the exam brief. */
export const EXAMPLE_QUESTIONS: string[] = [
  "Which airports in New England are strong candidates for terminal expansion?",
  "Compare LA and Santa Ana airport congestion levels.",
  "What is the percentage of long-haul flights out of Anchorage airport?",
  "What is the unmet flight demand in SFO airport and why?",
];

interface ExampleChipsProps {
  onPick: (question: string) => void;
  disabled?: boolean;
}

/** Clickable starter prompts that submit an example question when picked. */
export function ExampleChips({ onPick, disabled }: ExampleChipsProps) {
  return (
    <div className={styles.wrap}>
      <span className={styles.label}>Try asking</span>
      <div className={styles.chips}>
        {EXAMPLE_QUESTIONS.map((question) => (
          <button
            key={question}
            type="button"
            className={styles.chip}
            onClick={() => onPick(question)}
            disabled={disabled}
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}
