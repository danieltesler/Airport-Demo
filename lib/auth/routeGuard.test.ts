/** The guard on the paid routes: AUTH_REQUIRED on denies without a valid session, off changes nothing, health stays open. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatCreate, transcribe, speak } = vi.hoisted(() => {
  // The tts route builds its speech service when it is imported, so the key must exist first.
  process.env.OPENAI_API_KEY = "test-key";
  return {
    chatCreate: vi.fn(async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    transcribe: vi.fn(async () => ({ text: "compare LAX and SNA" })),
    speak: vi.fn(async () => ({ body: "audio" })),
  };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: chatCreate } };
    audio = { transcriptions: { create: transcribe }, speech: { create: speak } };
  },
  toFile: async (file: unknown) => file,
}));

import * as chatRoute from "../../app/api/chat/route";
import * as healthRoute from "../../app/api/health/route";
import * as sttRoute from "../../app/api/stt/route";
import * as ttsRoute from "../../app/api/tts/route";
import { SESSION_COOKIE } from "./config";
import { createSessionToken } from "./session";
import { setAuthEnv } from "./testing";

const SAME = { "sec-fetch-site": "same-origin" };
const chatRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }), headers: { "content-type": "application/json", ...SAME, ...headers } });
const sttRequest = (headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("audio", new File(["x"], "a.webm", { type: "audio/webm" }));
  return new Request("http://localhost/api/stt", { method: "POST", body: form, headers: { ...SAME, ...headers } });
};
const ttsRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/tts", { method: "POST", body: JSON.stringify({ text: "hello" }), headers: { "content-type": "application/json", ...SAME, ...headers } });

const routes: [string, (headers?: Record<string, string>) => Request, (request: Request) => Promise<Response>][] = [
  ["/api/chat", chatRequest, chatRoute.POST],
  ["/api/stt", sttRequest, sttRoute.POST],
  ["/api/tts", ttsRequest, ttsRoute.POST],
];

let restoreEnv: () => void;
beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  restoreEnv = setAuthEnv();
  for (const mock of [chatCreate, transcribe, speak]) mock.mockClear();
});
afterEach(() => restoreEnv());

describe("AUTH_REQUIRED=true", () => {
  for (const [path, build, handler] of routes) {
    it(`${path} returns 401 {error: unauthorized} without a session cookie, before reading the body or calling a paid API`, async () => {
      const request = build();
      const response = await handler(request);
      expect(response.status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(chatCreate).not.toHaveBeenCalled();
      expect(transcribe).not.toHaveBeenCalled();
      expect(speak).not.toHaveBeenCalled();
    });

    it(`${path} returns 401 for an invalid session cookie`, async () => {
      const response = await handler(build({ cookie: `${SESSION_COOKIE}=not.a.jwt` }));
      expect(response.status).toBe(401);
    });

    it(`${path} works with a valid session cookie`, async () => {
      const token = await createSessionToken({ sub: "s", email: "a@b.c", name: "A", picture: null });
      const response = await handler(build({ cookie: `${SESSION_COOKIE}=${token}` }));
      expect(response.status).toBe(200);
    });
  }

  it("the same-origin check still comes first", async () => {
    const response = await chatRoute.POST(chatRequest({ "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
  });

  it("/api/health stays open", async () => {
    expect((await healthRoute.GET()).status).toBe(200);
  });
});

describe("AUTH_REQUIRED unset or false: the app behaves as before", () => {
  for (const value of [undefined, "false"]) {
    for (const [path, build, handler] of routes) {
      it(`${path} needs no cookie when AUTH_REQUIRED is ${value ?? "unset"}`, async () => {
        const restore = setAuthEnv({ AUTH_REQUIRED: value, AUTH_SECRET: undefined });
        try {
          expect((await handler(build())).status).toBe(200);
        } finally {
          restore();
        }
      });
    }
  }
});
