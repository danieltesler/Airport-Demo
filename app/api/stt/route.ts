import OpenAI, { toFile } from "openai";

// The OpenAI SDK needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
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
    console.error("STT failed:", err);
    return Response.json({ error: "transcription failed" }, { status: 502 });
  }
}
