import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import { requireUser } from "@/lib/auth/session";
import { MAX_MESSAGE_CHARS, sanitizeHistory } from "@/lib/chatInput";
import { MAX_JSON_BODY_BYTES, declaredTooLarge, rejectCrossSite } from "@/lib/requestGuards";
import type { ChatRequest } from "@/lib/types";

// The OpenAI SDK needs the Node.js runtime (not the Edge runtime).
export const runtime = "nodejs";
// Always run per-request; nothing here is statically cacheable.
export const dynamic = "force-dynamic";
// A turn is at most a few model calls; stop a stuck one instead of paying for it to run on.
export const maxDuration = 30;

/**
 * POST /api/chat — one conversational turn.
 * Always returns a renderable `reply`, even on error (per docs/API_CONTRACT.md).
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  // Signed-in users only, when AUTH_REQUIRED is on (lib/auth/session.ts). Checked before any body is read or paid call made.
  const unauthorized = await requireUser(request);
  if (unauthorized) return unauthorized;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      reply:
        "The agent isn't configured yet: no `OPENAI_API_KEY` was found. Add it to " +
        "`.env.local` (or your Vercel project's environment variables) and restart, then ask again.",
      error: "missing_api_key",
    });
  }

  if (declaredTooLarge(request, MAX_JSON_BODY_BYTES)) {
    return NextResponse.json({ reply: "That message is too long. Please shorten it.", error: "too_long" }, { status: 413 });
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
  if (body.message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { reply: `That message is too long. Please keep it under ${MAX_MESSAGE_CHARS} characters.`, error: "too_long" },
      { status: 413 },
    );
  }

  try {
    const result = await runAgent(body.message, sanitizeHistory(body.history));
    return NextResponse.json(result);
  } catch (err) {
    // Name only: an error message can carry request text or upstream detail.
    console.error("Agent turn failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({
      reply:
        "I hit an error while analyzing that. Please try again in a moment, or rephrase your question.",
      error: "agent_error",
    });
  }
}
