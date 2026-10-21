import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TIMEOUT_MS, SESSION_ENDED_EVENT, SIGN_IN_AGAIN_REPLY, fetchAuthStatus, sendChat } from "./api";

/** A fetch that never answers, but rejects the way a real one does when its signal aborts. */
function hangingFetch() {
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) return reject(new DOMException("aborted", "AbortError")); // a real fetch rejects at once
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sendChat timeout and cancel", () => {
  it("gives up after 45 seconds with the friendly error reply (which shows Try again)", async () => {
    hangingFetch();
    const pending = sendChat("hello", []);
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const response = await pending;
    expect(response.error).toBe("timeout");
    expect(response.reply).toMatch(/stopped waiting/);
  });

  it("the Stop button's signal cancels the request at once and returns", async () => {
    const fetchMock = hangingFetch();
    const caller = new AbortController();
    const pending = sendChat("hello", [], caller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    caller.abort();
    const response = await pending; // does not wait for the timeout
    expect(response.error).toBe("cancelled"); // a deliberate Stop is not a failure
    expect(response.reply).toBe("");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("a signal that is already aborted never waits", async () => {
    hangingFetch();
    const caller = new AbortController();
    caller.abort();
    expect((await sendChat("hello", [], caller.signal)).error).toBe("cancelled");
  });

  it("a hang while reading the body is also cut off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => ({
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      })),
    );
    const pending = sendChat("hello", []);
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS + 10);
    expect((await pending).error).toBe("timeout");
  });

  it("a normal answer is returned untouched and leaves no timer running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reply: "Hi" }))));
    expect(await sendChat("hello", [])).toEqual({ reply: "Hi" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an error body from the server still wins over the timeout wording", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reply: "Server says no", error: "x" }), { status: 500 })));
    expect((await sendChat("hello", [])).reply).toBe("Server says no");
  });
});

describe("401 from the server means the session is gone", () => {
  it("shows 'Please sign in again.' and tells the page to re-check who is signed in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    const dispatched = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatched });
    const response = await sendChat("hello", []);
    expect(response).toEqual({ reply: "Please sign in again.", error: "unauthorized" });
    expect(SIGN_IN_AGAIN_REPLY).toBe("Please sign in again.");
    expect(dispatched).toHaveBeenCalledOnce();
    expect((dispatched.mock.calls[0][0] as Event).type).toBe(SESSION_ENDED_EVENT);
  });

  it("fetchAuthStatus reads /api/auth/me and falls back to 'not required, nobody' when the check fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ required: true, signedIn: false })));
    expect(await fetchAuthStatus()).toEqual({ required: true, signedIn: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchAuthStatus()).toEqual({ required: false, signedIn: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchAuthStatus()).toEqual({ required: false, signedIn: false });
  });
});

describe("a deliberate Stop is told apart from a failure", () => {
  it("Stop is 'cancelled', the 45 s hang is 'timeout', and a network failure keeps its error name", async () => {
    // Stop
    hangingFetch();
    const caller = new AbortController();
    const stopped = sendChat("hello", [], caller.signal);
    caller.abort();
    expect((await stopped).error).toBe("cancelled");

    // Hang
    hangingFetch();
    const hung = sendChat("hello", []);
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS + 1);
    expect((await hung).error).toBe("timeout");

    // The network is down
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const failed = await sendChat("hello", []);
    expect(failed.error).toBe("TypeError");
    expect(failed.reply).toMatch(/Something went wrong reaching the assistant/);
  });

  it("a failure that happens after Stop was pressed is still just a Stop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const caller = new AbortController();
    caller.abort();
    expect((await sendChat("hello", [], caller.signal)).error).toBe("cancelled");
  });
});
