/** Limits on the audio /api/stt will forward to the paid transcription model. */

/**
 * The browser stops recording after 20 s (hooks/useDictation.ts). Compressed speech from
 * MediaRecorder is about 16-64 kbps, so 20 s is roughly 40-160 KB; 1,000,000 bytes is several times
 * more than a real clip and still small enough that a replayed upload cannot run up a bill.
 */
export const MAX_AUDIO_BYTES = 1_000_000;

/** Container types the app records (Chrome/Firefox webm and ogg, Safari mp4) plus common uploads. */
const ALLOWED_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"];

/** True for e.g. "audio/webm;codecs=opus" when its base type is allow-listed. */
export const isAllowedAudioType = (type: string): boolean => {
  const base = type.split(";")[0].trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.includes(base);
};
