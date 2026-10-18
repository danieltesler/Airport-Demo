/**
 * Re-export of the real guard (lib/spokenGuard.ts) under the name lib/agent.ts imports.
 * guardSpoken({ spoken, toolOutputs, priorContext?, userWords? }) -> { ok, spoken, reasons }.
 */

export { guardSpoken } from "./spokenGuard";
export type { GuardInput, GuardVerdict } from "./spokenGuard";
