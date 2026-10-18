import OpenAI, { toFile } from "openai";
import { MAX_AUDIO_BYTES, isAllowedAudioType } from "@/lib/audioUpload";
import { rejectCrossSite } from "@/lib/requestGuards";

// The OpenAI SDK needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = process.env.OPENAI_STT_MODEL ?? "whisper-1";

// A vocabulary hint biases the transcription toward airport terms and names, which
// greatly improves accuracy for accented speech (e.g. "congestion levels" instead of
// "kon sain levels").
const DOMAIN_PROMPT =
  "Aviation and U.S. airports. Likely terms: compare, congestion, expansion, terminal, " +
  "unmet demand, long-haul, load factor, passengers, runways, capacity. Airports: LAX, " +
  "SFO, SNA, Santa Ana, John Wayne, ANC, Anchorage, BOS, Boston, Logan, JFK, New England, " +
  "Providence, Hartford.";

/**
 * POST /api/stt — transcribe recorded audio to text.
 * Body: multipart/form-data with an `audio` file. Returns { text, language? }.
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }

  // Refuse an oversized upload before reading it when the client declared its size.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES + 100_000) {
    return Response.json({ error: "audio too large" }, { status: 413 });
  }

  let audio: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("audio");
    if (value instanceof File) audio = value;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!audio || audio.size === 0) {
    return Response.json({ error: "no audio" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "audio too large" }, { status: 413 });
  }
  if (!isAllowedAudioType(audio.type)) {
    return Response.json({ error: "unsupported audio type" }, { status: 415 });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const file = await toFile(audio, audio.name || "audio.webm", { type: audio.type });
    const result = await openai.audio.transcriptions.create({
      file,
      model: MODEL,
      language: "en", // English-only app: transcribe as English
      prompt: DOMAIN_PROMPT,
    });
    return Response.json({ text: result.text });
  } catch (err) {
    console.error("STT failed:", err instanceof Error ? err.name : "unknown", (err as { status?: number })?.status ?? "");
    return Response.json({ error: "transcription failed" }, { status: 502 });
  }
}
