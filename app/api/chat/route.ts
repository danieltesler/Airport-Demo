import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import type { ChatRequest } from "@/lib/types";

// The OpenAI SDK needs the Node.js runtime (not the Edge runtime).
export const runtime = "nodejs";
// Always run per-request; nothing here is statically cacheable.
export const dynamic = "force-dynamic";

/**
 * POST /api/chat — one conversational turn.
 * Always returns a renderable `reply`, even on error (per docs/API_CONTRACT.md).
 */
export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      reply:
        "The agent isn't configured yet: no `OPENAI_API_KEY` was found. Add it to " +
        "`.env.local` (or your Vercel project's environment variables) and restart, then ask again.",
      error: "missing_api_key",
    });
  }

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ reply: "I couldn't read that request.", error: "bad_request" }, { status: 400 });
  }

  if (!body?.message || typeof body.message !== "string") {
    return NextResponse.json({ reply: "Please include a message.", error: "empty_message" }, { status: 400 });
  }

  try {
    const result = await runAgent(body.message, body.history ?? []);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Agent turn failed:", err);
    return NextResponse.json({
      reply:
        "I hit an error while analyzing that. Please try again in a moment, or rephrase your question.",
      error: err instanceof Error ? err.name : "agent_error",
    });
  }
}
