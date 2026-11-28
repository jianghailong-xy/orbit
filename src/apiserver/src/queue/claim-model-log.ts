import { AgentProvider } from '@orbit/shared';

/**
 * One claim's model decision, written as `claim-model {json}` by QueueService.buildSession.
 *
 * WHY IT EXISTS. A runner signed in to Antigravity with a Google account reports `agy models` rows
 * whose ids (`claude-sonnet-5-5`, `gpt-oss-120b`) are not Gemini's and are not `gemini-`-prefixed.
 * The control plane decided that model space by the prefix, so such an id was replaced with the
 * provider default — which for Antigravity is the empty string — and the runner sent no `--model`
 * at all: the session silently ran agy's own default while its row still named the picked model.
 * Nothing on the control plane said so (2026-10-05 end-to-end verification): the failure was visible
 * only in agy's argv on the runner, and the two candidate causes — a catalogue that never reached
 * the resolver, and a resolver that dropped an id it had — could not be told apart from outside.
 * This line is that missing half: the catalogue the runner reported, what the resolver was offered,
 * and what the claim actually dispatched.
 *
 * WHAT IT MAY SAY. Exactly the fields below, and nothing else. The observer is never handed a
 * request, a workspace environment, a provider key or a claim — it reads the resolution's own
 * inputs and output — so no credential can reach the line by construction. Every value is checked
 * again anyway: an id by its shape, a provider against the runtimes that exist, the count by being
 * a count. Anything else is written "[redacted]" in place. The lists are capped so a runner cannot
 * make a line unbounded; `catalogCount` is the number it actually reported.
 *
 * TEMPORARY. Diagnostic scaffolding for the Antigravity Google-account rollout
 * (docs/antigravity-runtime-contract.md §16.7): drop it once the end-to-end verification passes
 * with the picked model reaching agy's argv.
 */

export interface ClaimModelTraceFields {
  /** The claimed session. */
  sessionId: string;
  /** The runner-facing runtime the claim resolved to (a configured provider's borrowed runtime). */
  provider: string;
  /** The model the resolution ran on: the session row's own, or a concurrent PATCH's if one won. */
  requestedModel?: string | null;
  /** Every id the assigned runner reported for this provider's space, as reported. */
  catalog?: readonly unknown[] | null;
  /** The usable rows of that catalogue — what the resolver was actually offered. */
  offered?: readonly unknown[] | null;
  /** What the claim dispatched as `agent.model`. Empty means the runner is sent no `--model`. */
  resolvedModel?: string | null;
}

export const CLAIM_MODEL_LOG_REDACTED = '[redacted]';

/** Longest model list an observation may carry. Real catalogues are a handful of rows (the
 *  production Google-mode one is seven); the cap only keeps a hostile or broken heartbeat bounded. */
const CATALOG_LIMIT = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A model id as any runtime spells one: no whitespace, no `@`, no quotes — an address is not one,
 *  and is redacted. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** The credential prefixes this project's leak check searches for (a Google authorization code
 *  `4/0…`, an access token `ya29.…`, a browser refresh token `1//…`). They happen to fit the shape
 *  above — base64 text with a separator — so they are named here: a value carrying one is redacted
 *  even though it looks like an id, like everything else that is not what the field may hold. */
const CREDENTIAL = /^(4\/0|ya29\.|1\/\/)/;
const PROVIDERS: ReadonlySet<string> = new Set(Object.values(AgentProvider));

/** Whether a trimmed value may be written as a model id: of the shape one has, and not a credential. */
function isModelId(value: string): boolean {
  return MODEL.test(value) && !CREDENTIAL.test(value);
}

/** One catalogue row's `value`, whatever the heartbeat actually stored on it. */
function rowValue(row: unknown): unknown {
  return row && typeof row === 'object' ? (row as { value?: unknown }).value : undefined;
}

/** The model ids of `rows` as the line may carry them: trimmed strings of the id shape, at most
 *  CATALOG_LIMIT of them, each redacted on its own rather than dropped. */
function modelIds(rows: readonly unknown[]): string[] {
  return rows.slice(0, CATALOG_LIMIT).map((row) => {
    const value = rowValue(row);
    return typeof value === 'string' && isModelId(value.trim()) ? value.trim() : CLAIM_MODEL_LOG_REDACTED;
  });
}

/** The line for `fields`: `claim-model {json}`, every value checked as the header says. */
export function claimModelLogLine(fields: ClaimModelTraceFields): string {
  const line: Record<string, unknown> = {
    sessionId: UUID.test(fields.sessionId) ? fields.sessionId : CLAIM_MODEL_LOG_REDACTED,
    provider: PROVIDERS.has(fields.provider) ? fields.provider : CLAIM_MODEL_LOG_REDACTED,
    requestedModel: modelId(fields.requestedModel),
    catalogCount: Array.isArray(fields.catalog) ? fields.catalog.length : 0,
    catalogModels: modelIds(Array.isArray(fields.catalog) ? fields.catalog : []),
    offered: modelIds(Array.isArray(fields.offered) ? fields.offered : []),
    resolvedModel: modelId(fields.resolvedModel),
  };
  return `claim-model ${JSON.stringify(line)}`;
}

/** One model id for the line: the id itself, `null` when the session names none, else redacted. The claim's
 *  permission-mode line (claim-permission-mode.ts) writes its model through this too. */
export function modelId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return isModelId(trimmed) ? trimmed : CLAIM_MODEL_LOG_REDACTED;
}
