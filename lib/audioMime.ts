const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * Upload filename that matches what the recorder really produced. Safari records
 * audio/mp4; calling that "speech.webm" makes the filename disagree with the bytes,
 * and the transcription service picks its decoder partly from the extension.
 */
export function uploadFilename(mimeType: string | undefined): string {
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return `speech.${EXTENSION_BY_MIME[base] ?? "webm"}`;
}
