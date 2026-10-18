import { describe, expect, it, vi } from "vitest";
import { SpeechPlayer, fetchClipFromApi, splitSentences, type AudioLike, type PlayerDeps } from "./voicePlayback";

class FakeAudio implements AudioLike {
  src = "";
  onended: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event | string) => unknown) | null = null;
  playCalls = 0;
  paused = 0;
  rejectNextPlay: Error | null = null;
  play = vi.fn(async () => {
    this.playCalls += 1;
    if (this.rejectNextPlay) {
      const error = this.rejectNextPlay;
      this.rejectNextPlay = null;
      throw error;
    }
  });
  pause = vi.fn(() => {
    this.paused += 1;
  });
}

function setup(options: { failOn?: (text: string) => boolean } = {}) {
  const audio = new FakeAudio();
  const requested: string[] = [];
  const deferred = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const aborted: string[] = [];
  const revoked: string[] = [];
  const deps: PlayerDeps = {
    fetchClip: (text, signal) => {
      requested.push(text);
      signal.addEventListener("abort", () => aborted.push(text));
      return new Promise<Blob>((resolve, reject) => {
        if (options.failOn?.(text)) return reject(new Error("tts 502"));
        deferred.set(text, { resolve: () => resolve(new Blob([text])), reject });
      });
    },
    createAudio: () => audio,
    createObjectUrl: () => `blob:${requested.length}-${audio.src.length}`,
    revokeObjectUrl: (url) => revoked.push(url),
  };
  const player = new SpeechPlayer(deps);
  const finish = (text: string) => deferred.get(text)!.resolve();
  /** Wait until a clip has started playing, then end it as the browser would. */
  const endCurrentClip = async () => {
    await vi.waitFor(() => expect(audio.playCalls).toBeGreaterThan(0));
    audio.onended?.(new Event("ended"));
  };
  return { player, audio, requested, aborted, revoked, finish, endCurrentClip, deferred };
}

const A = "This is the first sentence here.";
const B = "This is the second sentence here.";
const C = "This is the third sentence here.";

describe("splitSentences", () => {
  it("splits on sentence ends", () => {
    expect(splitSentences(`${A} ${B}`)).toEqual([A, B]);
  });

  it("does not split inside a decimal number", () => {
    expect(splitSentences("The score is 82.5 out of one hundred points today.")).toEqual([
      "The score is 82.5 out of one hundred points today.",
    ]);
  });

  it("merges short fragments such as U.S. into the next sentence", () => {
    expect(splitSentences("U.S. airports are ranked below, with scores on screen.")).toHaveLength(1);
    expect(splitSentences(`Hi. ${A}`)).toEqual([`Hi. ${A}`]);
  });

  it("keeps a short trailing fragment with the previous sentence", () => {
    expect(splitSentences(`${A} Ok.`)).toEqual([`${A} Ok.`]);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("SpeechPlayer", () => {
  it("plays sentence clips in order even when they arrive out of order", async () => {
    const { player, audio, finish, endCurrentClip, requested } = setup();
    player.speak(`${A} ${B}`);
    expect(player.getSnapshot().status).toBe("loading");
    expect(requested).toEqual([A, B]);

    finish(B); // second clip is ready first
    await Promise.resolve();
    expect(audio.playCalls).toBe(0);

    finish(A);
    await endCurrentClip();
    await vi.waitFor(() => expect(audio.playCalls).toBe(2));
    audio.onended?.(new Event("ended"));
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("idle"));
  });

  it("reports speaking once audio starts and revokes each clip URL", async () => {
    const { player, finish, endCurrentClip, revoked } = setup();
    player.speak(A);
    finish(A);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("speaking"));
    await endCurrentClip();
    await vi.waitFor(() => expect(revoked).toHaveLength(1));
  });

  it("requests at most four clips at once", async () => {
    const sentences = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} is long enough.`);
    const { player, requested, finish } = setup();
    player.speak(sentences.join(" "));
    await Promise.resolve();
    expect(requested).toHaveLength(4);

    finish(sentences[0]);
    await vi.waitFor(() => expect(requested).toHaveLength(5));
  });

  it("cancel aborts in-flight requests, silences audio and ignores late clips", async () => {
    const { player, audio, aborted, finish } = setup();
    player.unlock();
    player.speak(`${A} ${B}`);
    player.cancel();

    expect(aborted).toEqual([A, B]);
    expect(player.getSnapshot()).toEqual({ status: "idle", text: null });
    expect(audio.pause).toHaveBeenCalled();

    finish(A);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.playCalls).toBe(1); // only the unlock clip, never the cancelled answer
  });

  it("a new speak() replaces the previous one", async () => {
    const { player, aborted, requested } = setup();
    player.speak(A);
    player.speak(B);
    expect(aborted).toEqual([A]);
    expect(requested).toEqual([A, B]);
    expect(player.getSnapshot().text).toBe(B);
  });

  it("surfaces a blocked autoplay and continues after resume()", async () => {
    const { player, audio, finish, endCurrentClip } = setup();
    audio.rejectNextPlay = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    player.speak(A);
    finish(A);

    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("blocked"));
    player.resume();
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("speaking"));
    expect(audio.playCalls).toBe(2);
    await endCurrentClip();
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("idle"));
  });

  it("cancelling while blocked does not play afterwards", async () => {
    const { player, audio, finish } = setup();
    audio.rejectNextPlay = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    player.speak(A);
    finish(A);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("blocked"));
    player.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.playCalls).toBe(1);
    expect(player.getSnapshot().status).toBe("idle");
  });

  it("goes to error when a clip fails, and mutes auto-speak after two failures in a row", async () => {
    const { player } = setup({ failOn: () => true });
    expect(player.autoSpeakAllowed).toBe(true);

    player.speak(A);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("error"));
    expect(player.autoSpeakAllowed).toBe(true);

    player.speak(B);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("error"));
    expect(player.autoSpeakAllowed).toBe(false);

    player.dismissError();
    expect(player.getSnapshot().status).toBe("idle");
  });

  it("a successful clip resets the failure count", async () => {
    const { player, finish, endCurrentClip } = setup({ failOn: (text) => text === B });
    player.speak(B);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("error"));

    player.speak(A);
    finish(A);
    await endCurrentClip();
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("idle"));
    expect(player.autoSpeakAllowed).toBe(true);
  });

  it("notifies subscribers only when the snapshot changes", () => {
    const { player } = setup();
    const listener = vi.fn();
    const unsubscribe = player.subscribe(listener);
    player.cancel(); // already idle
    expect(listener).not.toHaveBeenCalled();
    player.speak(A);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    player.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not clobber playing audio when unlock() is called mid-speech", async () => {
    const { player, audio, finish } = setup();
    player.speak(A);
    finish(A);
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe("speaking"));
    const srcBefore = audio.src;
    player.unlock();
    expect(audio.src).toBe(srcBefore);
  });

  it("unlock() plays a silent in-code WAV on the persistent element", () => {
    const { player, audio } = setup();
    player.unlock();
    expect(audio.src.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(audio.playCalls).toBe(1);
  });
});

describe("fetchClipFromApi", () => {
  it("POSTs the text as JSON, never in the URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }));
    await fetchClipFromApi("Hello there", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello there" });
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("tts failed", { status: 502 }));
    await expect(
      fetchClipFromApi("Hello", new AbortController().signal, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("tts 502");
  });

  it("aborts the request when the caller cancels", async () => {
    const outer = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = fetchClipFromApi("Hello", outer.signal, fetchImpl as unknown as typeof fetch);
    outer.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("provider reporting", () => {
  it("passes the server's X-TTS-Provider header to the callback", async () => {
    const onProvider = vi.fn();
    const fetchImpl = vi.fn(
      async () => new Response(new Blob(["x"]), { status: 200, headers: { "X-TTS-Provider": "elevenlabs" } }),
    );
    await fetchClipFromApi("Hello", new AbortController().signal, fetchImpl as unknown as typeof fetch, onProvider);
    expect(onProvider).toHaveBeenCalledWith("elevenlabs");
  });

  it("records the provider on the active answer and clears it when playback ends", () => {
    const { player } = setup();
    player.noteProvider("openai"); // nothing playing: ignored
    expect(player.getSnapshot().provider).toBeUndefined();

    player.speak(A);
    player.noteProvider("openai");
    expect(player.getSnapshot().provider).toBe("openai");
    player.cancel();
    expect(player.getSnapshot().provider).toBeUndefined();
  });
});

describe("clip timeout window", () => {
  it("accepts a slow fallback clip that arrives after 10 s", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            setTimeout(() => resolve(new Response(new Blob(["x"]), { headers: { "X-TTS-Fallback": "unavailable" } })), 10000);
          }),
      );
      const pending = fetchClipFromApi("Hello", new AbortController().signal, fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(10001);
      await expect(pending).resolves.toBeInstanceOf(Blob);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives up on a dead server", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const pending = fetchClipFromApi("Hello", new AbortController().signal, fetchImpl as unknown as typeof fetch);
      const assertion = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(15001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
