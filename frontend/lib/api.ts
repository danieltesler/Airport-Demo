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

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/** Friendly fallback shown when we can't recover a `reply` from the server. */
const NETWORK_FALLBACK_REPLY =
  "I couldn't reach the analysis service just now. Please check that the backend is running and try again.";

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
  history: ChatTurn[]
): Promise<ChatResponse> {
  const body: ChatRequest = { message, history };

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await safeParseJson(response);

    // Contract: error responses still carry a `reply`. Prefer it when present.
    if (data && typeof data.reply === "string") {
      return data as unknown as ChatResponse;
    }

    return {
      reply: NETWORK_FALLBACK_REPLY,
      error: `bad_response_${response.status}`,
    };
  } catch (err) {
    return {
      reply: NETWORK_FALLBACK_REPLY,
      error: err instanceof Error ? err.name : "network_error",
    };
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
