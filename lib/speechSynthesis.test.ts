import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechUnavailableError, createSpeechService } from "./speechSynthesis";

const SECRET = "xi-test-secret-value";
const ENV = { ELEVENLABS_API_KEY: SECRET, ELEVENLABS_VOICE_ID: "voice123" };
const TEXT = "Los Angeles leads the ranking.";

const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
const openai = vi.fn(async () => "openai-audio" as unknown as BodyInit);

function service(env: Record<string, string | undefined>, fetchImpl: typeof fetch, withOpenAi = true) {
  return createSpeechService({ env, fetchImpl, openai: withOpenAi ? openai : undefined });
}

beforeEach(() => {
  openai.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("provider choice", () => {
  it("uses ElevenLabs when key and voice are set, with the documented request shape", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const result = await service(ENV, fetchImpl as unknown as typeof fetch).speak(TEXT, "1.1.1.1");

    expect(result.provider).toBe("elevenlabs");
    expect(result.fallback).toBeNull();
    expect(openai).not.toHaveBeenCalled();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_64");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ text: TEXT, model_id: "eleven_flash_v2_5" });
  });

  it("honours ELEVENLABS_MODEL_ID", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await service({ ...ENV, ELEVENLABS_MODEL_ID: "eleven_multilingual_v2" }, fetchImpl as unknown as typeof fetch).speak(TEXT, "a");
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model_id).toBe(
      "eleven_multilingual_v2",
    );
  });

  it.each([{}, { ELEVENLABS_API_KEY: SECRET }, { ELEVENLABS_VOICE_ID: "voice123" }])(
    "uses OpenAI exactly as before when ElevenLabs is not fully configured (%j)",
    async (env) => {
      const fetchImpl = vi.fn();
      const result = await service(env, fetchImpl as unknown as typeof fetch).speak(TEXT, "a");
      expect(result).toMatchObject({ provider: "openai", fallback: null });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("throws when no provider can speak", async () => {
    await expect(service({}, vi.fn() as unknown as typeof fetch, false).speak(TEXT, "a")).rejects.toBeInstanceOf(
      SpeechUnavailableError,
    );
  });
});

describe("fallback to OpenAI", () => {
  it.each([401, 402, 429, 500])("falls back on ElevenLabs status %i without leaking it", async (status) => {
    const fetchImpl = vi.fn(async () => new Response(`secret detail ${SECRET}`, { status }));
    const result = await service(ENV, fetchImpl as unknown as typeof fetch).speak(TEXT, "a");
    expect(result).toMatchObject({ provider: "openai", fallback: "unavailable" });
    const logged = JSON.stringify((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain(String(status));
  });

  it("falls back on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const result = await service(ENV, fetchImpl as unknown as typeof fetch).speak(TEXT, "a");
    expect(result.fallback).toBe("unavailable");
  });

  it("falls back on a timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const pending = service(ENV, fetchImpl as unknown as typeof fetch).speak(TEXT, "a");
      await vi.advanceTimersByTimeAsync(2501);
      expect(await pending).toMatchObject({ provider: "openai", fallback: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops calling ElevenLabs for a while after an auth or credits failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no credits", { status: 402 }));
    const speech = service(ENV, fetchImpl as unknown as typeof fetch);
    await speech.speak(TEXT, "a");
    await speech.speak(TEXT, "a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not pause after a rate-limit (429), which is transient", async () => {
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 }));
    const speech = service(ENV, fetchImpl as unknown as typeof fetch);
    await speech.speak(TEXT, "a");
    await speech.speak(TEXT, "a");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws, rather than hanging, when ElevenLabs fails and OpenAI is not configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 }));
    await expect(service(ENV, fetchImpl as unknown as typeof fetch, false).speak(TEXT, "a")).rejects.toBeInstanceOf(
      SpeechUnavailableError,
    );
  });
});

describe("credit protection", () => {
  it("sends over-long text straight to OpenAI without calling ElevenLabs", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const result = await service(ENV, fetchImpl as unknown as typeof fetch).speak("x".repeat(601), "a");
    expect(result).toMatchObject({ provider: "openai", fallback: "too-long" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("limits each client's characters per hour, then falls back", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const speech = service({ ...ENV, ELEVENLABS_CLIENT_CHARS_PER_HOUR: "100" }, fetchImpl as unknown as typeof fetch);
    expect((await speech.speak("x".repeat(60), "greedy")).provider).toBe("elevenlabs");
    expect(await speech.speak("x".repeat(60), "greedy")).toMatchObject({ provider: "openai", fallback: "rate-limit" });
    expect((await speech.speak("x".repeat(60), "polite")).provider).toBe("elevenlabs");
  });

  it("enforces the global daily budget across clients", async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const speech = service({ ...ENV, ELEVENLABS_CHARS_PER_DAY: "100" }, fetchImpl as unknown as typeof fetch);
    expect((await speech.speak("x".repeat(60), "one")).provider).toBe("elevenlabs");
    expect(await speech.speak("x".repeat(60), "two")).toMatchObject({ provider: "openai", fallback: "rate-limit" });
  });

  it("does not charge a client for a request that never reached ElevenLabs credits", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValue(audioResponse());
    const speech = service({ ...ENV, ELEVENLABS_CLIENT_CHARS_PER_HOUR: "70" }, fetchImpl as unknown as typeof fetch);
    await speech.speak("x".repeat(60), "a"); // fails, refunded
    expect((await speech.speak("x".repeat(60), "a")).provider).toBe("elevenlabs");
  });

  it("queues beyond the concurrency cap instead of switching voice", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return audioResponse();
    });
    const speech = service({ ...ENV, ELEVENLABS_MAX_CONCURRENT: "2" }, fetchImpl as unknown as typeof fetch);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => speech.speak(`Sentence ${i} here.`, `ip${i}`)));
    expect(peak).toBe(2);
    expect(results.every((result) => result.provider === "elevenlabs")).toBe(true);
  });
});
