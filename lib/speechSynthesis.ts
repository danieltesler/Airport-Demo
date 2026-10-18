/**
 * Server-side text-to-speech with a provider switch.
 *
 * ElevenLabs speaks when its key and voice are configured; OpenAI is the fallback
 * for any request ElevenLabs cannot or should not serve (error, timeout, out of
 * credits, rate limit, text too long). The caller learns which provider spoke and,
 * when it was the fallback, a coarse reason. Keys are read from the server
 * environment only and never logged or returned.
 */

import { createCharBudget, createSemaphore } from "./limits";

export type SpeechProvider = "elevenlabs" | "openai";
export type FallbackReason = "too-long" | "unavailable";

export interface SpeechResult {
  body: BodyInit;
  provider: SpeechProvider;
  /** Why ElevenLabs was skipped, when it was configured but OpenAI spoke. */
  fallback: FallbackReason | null;
}

/** Neither provider can speak this request. */
export class SpeechUnavailableError extends Error {}

/** The caller's (or the day's) character budget is spent. */
export class SpeechBudgetError extends Error {
  constructor(readonly scope: "client" | "global") {
    super(`speech budget spent (${scope})`);
  }
}

export interface SpeechServiceOptions {
  env: Record<string, string | undefined>;
  /** OpenAI synthesis; absent when no OpenAI key is configured. */
  openai?: (text: string) => Promise<BodyInit>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// Flash v2.5: lowest latency and half the credits per character of the other
// models, so it is the default; ELEVENLABS_MODEL_ID overrides it.
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "mp3_44100_64"; // speech needs no more; the default 128 kbps doubles the bytes
// A healthy Flash clip arrives in about 0.7 s, so waiting longer only delays the fallback.
const ELEVENLABS_TIMEOUT_MS = 2500;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function createSpeechService({ env, openai, fetchImpl = fetch, now = Date.now }: SpeechServiceOptions) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  const elevenLabsConfigured = Boolean(apiKey && voiceId);

  // A 350-character summary is the normal ceiling; anything longer is not worth paid credits.
  // Budgets count characters but ElevenLabs bills credits. Measured on this account:
  // 0.2 credit per character on eleven_flash_v2_5 and 0.4 on eleven_multilingual_v2. So the
  // defaults below are, on Flash, 600 credits per client per hour and 1,600 credits per day
  // (double on Multilingual). The plan's monthly allowance is unverified: the key lacks the
  // user_read permission, so it could not be read back.
  const maxChars = numberFromEnv(env.ELEVENLABS_MAX_CHARS, 600);
  const perClient = createCharBudget({
    limit: numberFromEnv(env.ELEVENLABS_CLIENT_CHARS_PER_HOUR, 3000),
    windowMs: 60 * 60 * 1000,
    now,
  });
  const global = createCharBudget({
    limit: numberFromEnv(env.ELEVENLABS_CHARS_PER_DAY, 8000),
    windowMs: 24 * 60 * 60 * 1000,
    now,
  });
  // Starter allows a handful of simultaneous requests; queueing beats a 429 that would
  // switch the voice mid-answer.
  const slots = createSemaphore(numberFromEnv(env.ELEVENLABS_MAX_CONCURRENT, 3));
  let pausedUntil = 0;

  async function callElevenLabs(text: string): Promise<ArrayBuffer | null> {
    const release = await slots.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId as string)}?output_format=${OUTPUT_FORMAT}`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey as string, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: modelId }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        // Bad key or no credits will not fix itself per request: stop trying for a while.
        if (response.status === 401 || response.status === 402) pausedUntil = now() + CIRCUIT_OPEN_MS;
        console.warn(`ElevenLabs TTS returned ${response.status}; falling back`);
        return null;
      }
      return await response.arrayBuffer();
    } catch {
      console.warn("ElevenLabs TTS failed or timed out; falling back");
      return null;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  async function speak(text: string, clientId: string): Promise<SpeechResult> {
    if (!elevenLabsConfigured && !openai) throw new SpeechUnavailableError("no speech provider available");

    // The budgets cover BOTH providers: OpenAI is paid too, so it is never an unlimited fallback.
    // Once spent, the request is refused (the route answers 429) instead of falling through.
    if (!perClient.tryConsume(clientId, text.length)) throw new SpeechBudgetError("client");
    if (!global.tryConsume("all", text.length)) {
      perClient.refund(clientId, text.length);
      throw new SpeechBudgetError("global");
    }
    const refundBoth = () => {
      perClient.refund(clientId, text.length);
      global.refund("all", text.length);
    };

    let fallback: FallbackReason | null = null;
    if (elevenLabsConfigured) {
      if (now() < pausedUntil) fallback = "unavailable";
      else if (text.length > maxChars) fallback = "too-long";
      else {
        const audio = await callElevenLabs(text);
        if (audio) return { body: audio, provider: "elevenlabs", fallback: null };
        fallback = "unavailable";
      }
    }

    // A failure within budget falls back to OpenAI on the characters already spent.
    if (!openai) {
      refundBoth();
      throw new SpeechUnavailableError("no speech provider available");
    }
    try {
      return { body: await openai(text), provider: "openai", fallback };
    } catch (err) {
      refundBoth(); // nothing was generated
      throw err;
    }
  }

  return { speak, configured: elevenLabsConfigured || Boolean(openai) };
}
