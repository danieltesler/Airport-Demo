import OpenAI from "openai";
import { detectLang } from "@/lib/i18n";

// The OpenAI SDK needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
// Two natural voices, chosen per the reply's language. Override via env if desired.
const VOICE: Record<"en" | "he", string> = {
  en: process.env.OPENAI_TTS_VOICE_EN ?? "nova",
  he: process.env.OPENAI_TTS_VOICE_HE ?? "shimmer",
};
const MAX_CHARS = 4000; // safety cap on how much text we read aloud

/**
 * Turn text into natural speech with OpenAI TTS, streaming the audio back so the
 * browser can start playing within ~1s instead of waiting for the whole clip. The
 * voice is chosen from the text's language, so read-aloud stays bilingual.
 *
 * GET  /api/tts?text=...   (used by <audio src> for native progressive playback)
 * POST /api/tts { text }
 */
async function synthesize(text: string): Promise<Response> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const speech = await openai.audio.speech.create({
    model: MODEL,
    voice: VOICE[detectLang(text)],
    input: text.slice(0, MAX_CHARS),
  });
  return new Response(speech.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

function guardKey(): Response | null {
  return process.env.OPENAI_API_KEY ? null : new Response("OPENAI_API_KEY not set", { status: 503 });
}

export async function GET(request: Request) {
  const missing = guardKey();
  if (missing) return missing;
  const text = new URL(request.url).searchParams.get("text")?.trim();
  if (!text) return new Response("empty text", { status: 400 });
  try {
    return await synthesize(text);
  } catch (err) {
    console.error("TTS failed:", err);
    return new Response("tts failed", { status: 502 });
  }
}

export async function POST(request: Request) {
  const missing = guardKey();
  if (missing) return missing;
  let text = "";
  try {
    const body = (await request.json()) as { text?: string };
    text = (body.text ?? "").trim();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!text) return new Response("empty text", { status: 400 });
  try {
    return await synthesize(text);
  } catch (err) {
    console.error("TTS failed:", err);
    return new Response("tts failed", { status: 502 });
  }
}
