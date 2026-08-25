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

/**
 * POST /api/tts — turn text into natural speech with OpenAI TTS.
 * Body: { text }. Returns audio/mpeg. The voice is chosen from the text's language
 * (Hebrew vs English), so read-aloud stays bilingual.
 */
export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response("OPENAI_API_KEY not set", { status: 503 });
  }

  let text = "";
  try {
    const body = (await request.json()) as { text?: string };
    text = body.text ?? "";
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!text || !text.trim()) {
    return new Response("empty text", { status: 400 });
  }

  const voice = VOICE[detectLang(text)];
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const speech = await openai.audio.speech.create({
      model: MODEL,
      voice,
      input: text,
    });
    const audio = Buffer.from(await speech.arrayBuffer());
    return new Response(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("TTS failed:", err);
    return new Response("tts failed", { status: 502 });
  }
}
