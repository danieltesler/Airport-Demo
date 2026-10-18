import { DATA_DISCLOSURE } from "./disclosure";
import styles from "./chat.module.css";

/** Always-visible privacy line under the composer: small, non-blocking, no dismissal state to explain. */
export function VoiceDisclosure() {
  return <p className={styles.disclosure}>{DATA_DISCLOSURE}</p>;
}
