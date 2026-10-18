/**
 * Typed client for the Airport Investment Intelligence backend.
 * The only I/O boundary in the app lives here — components and hooks call these
 * functions and never touch fetch directly.
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatTurn,
  HealthResponse,
} from "./types";

// Empty default = same-origin: the Next.js app serves /api itself, so requests go
// to a relative "/api/...". Override with NEXT_PUBLIC_API_BASE_URL only if the API
// is hosted elsewhere.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Friendly fallback shown when we can't recover a `reply` from the server. */
const NETWORK_FALLBACK_REPLY =
  "Something went wrong reaching the assistant. Please try again.";

/** A chat turn that has not answered by now is abandoned, so a hung server cannot freeze the app. */
export const CHAT_TIMEOUT_MS = 45_000;

/** The `error` of a request the user stopped on purpose. It is not a failure and never shown as one. */
export const CHAT_CANCELLED = "cancelled";

const TIMEOUT_REPLY = "That took longer than expected, so I stopped waiting. Please try again.";

/**
 * Send a chat turn to the backend.
 *
 * Per the contract, the server returns a `reply` even on 4xx/5xx. We therefore
 * try to parse the JSON body regardless of status and surface its `reply`. Only
 * when there is no usable body (e.g. a network failure) do we fall back to a
 * generic message. This function never throws — callers always get a ChatResponse.
 */
export async function sendChat(
  message: string,
  history: ChatTurn[],
  signal?: AbortSignal
): Promise<ChatResponse> {
  const body: ChatRequest = { message, history };

  // The caller's signal (the Stop button) and our own timeout both cancel the same request.
  const request = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, CHAT_TIMEOUT_MS);
  const onCallerAbort = () => request.abort();
  if (signal?.aborted) request.abort();
  else signal?.addEventListener("abort", onCallerAbort);

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const data = await safeParseJson(response);
    if (timedOut) return { reply: TIMEOUT_REPLY, error: "timeout" };
    if (signal?.aborted) return { reply: "", error: CHAT_CANCELLED };

    // Contract: error responses still carry a `reply`. Prefer it when present.
    if (data && typeof data.reply === "string") {
      return data as unknown as ChatResponse;
    }

    return {
      reply: NETWORK_FALLBACK_REPLY,
      error: `bad_response_${response.status}`,
    };
  } catch (err) {
    if (timedOut) return { reply: TIMEOUT_REPLY, error: "timeout" };
    if (signal?.aborted) return { reply: "", error: CHAT_CANCELLED };
    return {
      reply: NETWORK_FALLBACK_REPLY,
      error: err instanceof Error ? err.name : "network_error",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Lightweight health probe used to confirm the backend is reachable. */
export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`, {
      method: "GET",
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/** Parse a JSON body without throwing on empty/invalid payloads. */
async function safeParseJson(
  response: Response
): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export { API_BASE_URL };
