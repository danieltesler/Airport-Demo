import OpenAI from "openai";
import { SpeechBudgetError, SpeechUnavailableError, createSpeechService } from "@/lib/speechSynthesis";
import { clientId, rejectCrossSite } from "@/lib/requestGuards";

// The OpenAI SDK needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const VOICE = process.env.OPENAI_TTS_VOICE ?? "nova"; // natural English voice
// The client posts one short sentence at a time (lib/voicePlayback.ts), so 600 characters is
// far above a real request and low enough that one call cannot burn many credits.
const MAX_CHARS = 600;

/**
 * Turn text into natural speech and return the audio. ElevenLabs speaks when
 * ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are set; OpenAI is the fallback for a failed
 * request (see lib/speechSynthesis.ts). Both providers share one per-client and one global
 * character budget; once it is spent the answer is 429. The `X-TTS-Provider` header says who
 * spoke, and `X-TTS-Fallback` says why ElevenLabs was skipped.
 *
 * POST /api/tts { text }  (there is no GET: text never belongs in a URL or an access log)
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

export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  let text = "";
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return new Response("bad request", { status: 400 });
  }
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
    if (err instanceof SpeechBudgetError) return new Response("speech budget used up", { status: 429 });
    if (err instanceof SpeechUnavailableError) return new Response("tts failed", { status: 502 });
    console.error("TTS failed:", err instanceof Error ? err.name : "unknown error");
    return new Response("tts failed", { status: 502 });
  }
}
