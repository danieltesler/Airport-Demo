/**
 * Signed assistant turns. The chat history comes back from the client, so anyone can send a fake
 * assistant turn ("ATL handled 250 million passengers"). The reply checks let a follow-up repeat a
 * figure from an earlier answer, and in the red-team run a forged turn's figure was repeated as fact.
 *
 * So the server signs each answer it writes (HMAC-SHA256 over the reply and its "shown" note) and
 * only signed turns count as earlier answers when figures are checked. An unsigned or edited turn is
 * still passed to the model as conversation, but none of its figures ground anything.
 *
 * The key is HISTORY_SIGNING_KEY, else AUTH_SECRET, else a random key for this process. With the
 * random key a restart (or another serverless instance) cannot verify old turns: follow-ups then just
 * call a tool again, which is the safe direction.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MIN_KEY_LENGTH = 32;
let processKey: Buffer | null = null;

function signingKey(): Buffer {
  const configured = process.env.HISTORY_SIGNING_KEY ?? process.env.AUTH_SECRET;
  if (configured && configured.length >= MIN_KEY_LENGTH) return Buffer.from(configured, "utf8");
  processKey ??= randomBytes(32);
  return processKey;
}

const digest = (content: string, shown: string | undefined): Buffer =>
  createHmac("sha256", signingKey()).update(`assistant-turn\u0000${content.trim()}\u0000${shown ?? ""}`, "utf8").digest();

/** The signature for an answer the server is about to return. */
export function signAssistantTurn(content: string, shown?: string): string {
  return digest(content, shown).toString("base64url");
}

/** True only when `sig` is the server's signature of exactly this content and note. */
export function isSignedAssistantTurn(content: string, shown: string | undefined, sig: unknown): boolean {
  if (typeof sig !== "string" || sig.length > 100) return false;
  const given = Buffer.from(sig, "base64url");
  const expected = digest(content, shown);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
