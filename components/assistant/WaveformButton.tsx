import { WaveIcon } from "./icons";
import styles from "./voiceOrb.module.css";

interface WaveformButtonProps {
  label: string;
  onClick?: () => void;
  large?: boolean;
  disabled?: boolean;
}

/** Round pastel-gradient waveform button: starts a conversation in the composer, signals "live" in the overlay. */
export function WaveformButton({ label, onClick, large = false, disabled }: WaveformButtonProps) {
  return (
    <button
      type="button"
      className={large ? `${styles.waveButton} ${styles.waveButtonLarge}` : styles.waveButton}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <WaveIcon width={large ? 30 : 20} height={large ? 30 : 20} />
    </button>
  );
}
