import OpenAI from "openai";
import { SpeechUnavailableError, createSpeechService } from "@/lib/speechSynthesis";

// The OpenAI SDK needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const VOICE = process.env.OPENAI_TTS_VOICE ?? "nova"; // natural English voice
const MAX_CHARS = 4000; // safety cap on how much text we read aloud

/**
 * Turn text into natural speech and return the audio. ElevenLabs speaks when
 * ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are set; OpenAI is the fallback for any
 * request ElevenLabs cannot serve (see lib/speechSynthesis.ts). The `X-TTS-Provider`
 * header says who spoke, and `X-TTS-Fallback` says why ElevenLabs was skipped.
 *
 * GET  /api/tts?text=...   (kept for existing clients)
 * POST /api/tts { text }
 */
const speech = createSpeechService({
  env: process.env,
  openai: process.env.OPENAI_API_KEY
    ? async (text) => {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const result = await openai.audio.speech.create({ model: MODEL, voice: VOICE, input: text });
        return result.body as unknown as BodyInit;
      }
    : undefined,
});

/** First hop of x-forwarded-for (set by the hosting proxy), used only as a rate-limit key. */
function clientId(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

async function respond(request: Request, text: string): Promise<Response> {
  if (!speech.configured) return new Response("no speech provider configured", { status: 503 });
  if (!text) return new Response("empty text", { status: 400 });

  try {
    const result = await speech.speak(text.slice(0, MAX_CHARS), clientId(request));
    const headers: Record<string, string> = {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Provider": result.provider,
    };
    if (result.fallback) headers["X-TTS-Fallback"] = result.fallback;
    return new Response(result.body, { headers });
  } catch (err) {
    if (err instanceof SpeechUnavailableError) return new Response("tts failed", { status: 502 });
    console.error("TTS failed:", err instanceof Error ? err.name : "unknown error");
    return new Response("tts failed", { status: 502 });
  }
}

export async function GET(request: Request) {
  const text = new URL(request.url).searchParams.get("text")?.trim() ?? "";
  return respond(request, text);
}

export async function POST(request: Request) {
  let text = "";
  try {
    const body = (await request.json()) as { text?: string };
    text = (body.text ?? "").trim();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  return respond(request, text);
}
