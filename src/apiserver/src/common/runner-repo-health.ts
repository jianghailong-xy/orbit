import { MAIN_CHECKOUT_FILE_LIMIT, type MainCheckoutRepoHealth } from '@orbit/shared';

/** Working-tree states a runner may report. Anything past 'dirty' is a half-finished git
 *  operation: nothing can fast-forward into that checkout until someone resolves it. A dirty
 *  checkout is deliberately NOT one of those — git refuses only the files a merge would
 *  overwrite, so merges keep working around a stray edit. */
export const REPO_HEALTH_STATES = [
  'clean',
  'dirty',
  'unmerged',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
] as const;

/** The states that block every merge into the checkout — what the UI warns about. */
const BLOCKING_STATES = new Set(['unmerged', 'merge', 'rebase', 'cherry-pick', 'revert']);

export function isBlockingRepoState(state: string | undefined | null): boolean {
  return !!state && BLOCKING_STATES.has(state);
}

/** Caps mirroring the runner's own: enough to recognize what's in the way, bounded so a runaway
 *  report can't be stored as one. */
const PATH_CAP = 20;
const PATH_MAX = 400;
const ROOT_MAX = 1024;
/** A ref or a fingerprint: `mc1:<40 or 64 hex>:<64 hex>` fits well inside this. */
const TOKEN_MAX = 255;

/**
 * Normalize the shared-checkout health a runner reported.
 *
 * Heartbeat JSON is stored as sent, so every read has to survive a partial report. Entries whose
 * root or state can't be recognized are dropped rather than repaired — this drives a claim that a
 * machine's checkout is wedged, and a half-read one would be shown with the same confidence as a
 * real answer. Returns null when nothing usable is there, which leaves the last snapshot alone
 * instead of asserting every checkout is clean.
 */
export function sanitizeRunnerRepoHealth(value: unknown): MainCheckoutRepoHealth[] | null {
  if (!Array.isArray(value)) return null;
  const byRoot = new Map<string, MainCheckoutRepoHealth>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const root = typeof entry.root === 'string' ? entry.root.trim().slice(0, ROOT_MAX) : '';
    const state = typeof entry.state === 'string' ? entry.state : '';
    if (!root || byRoot.has(root)) continue;
    if (!REPO_HEALTH_STATES.includes(state as (typeof REPO_HEALTH_STATES)[number])) continue;
    const branch =
      typeof entry.branch === 'string' && entry.branch.trim()
        ? entry.branch.trim().slice(0, 255)
        : undefined;
    byRoot.set(root, {
      root,
      state,
      ...(branch ? { branch } : {}),
      ...(stringList(entry.paths, PATH_CAP, PATH_MAX) ?? {}),
      ...(stringList(entry.agentIds, PATH_CAP, 64, 'agentIds') ?? {}),
      ...mainCheckoutFields(entry),
    });
  }
  if (!byRoot.size) return null;
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * The main checkout counts a runner with `main-checkout-git/v1` adds to each entry (contract §4): HEAD, upstream,
 * ahead/behind, the changed-file count and the fingerprint. Counts and the fingerprint only, each kept only when it is
 * the type it claims to be, so an older runner's entry (none of them) and a garbled one read the same: unknown.
 */
function mainCheckoutFields(entry: Record<string, unknown>): Partial<MainCheckoutRepoHealth> {
  const out: Partial<MainCheckoutRepoHealth> = {};
  const token = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TOKEN_MAX) : undefined);
  const count = (v: unknown, cap = Number.MAX_SAFE_INTEGER) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, cap) : undefined;
  const head = token(entry.head);
  if (head) out.head = head;
  const upstream = token(entry.upstream);
  if (upstream) out.upstream = upstream;
  const ahead = count(entry.ahead);
  if (ahead !== undefined) out.ahead = ahead;
  const behind = count(entry.behind);
  if (behind !== undefined) out.behind = behind;
  const fileCount = count(entry.fileCount, MAIN_CHECKOUT_FILE_LIMIT);
  if (fileCount !== undefined) out.fileCount = fileCount;
  if (typeof entry.truncated === 'boolean') out.truncated = entry.truncated;
  const fingerprint = token(entry.fingerprint);
  if (fingerprint) out.fingerprint = fingerprint;
  return out;
}

/** A bounded string array, or nothing when the field is absent/unusable, shaped so it can be
 *  spread into the entry only when it carries something. */
function stringList(
  value: unknown,
  cap: number,
  maxLen: number,
  key: 'paths' | 'agentIds' = 'paths',
): Record<string, string[]> | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((v): v is string => typeof v === 'string' && !!v.trim())
    .slice(0, cap)
    .map((v) => v.trim().slice(0, maxLen));
  return items.length ? { [key]: items } : null;
}

/** The stored snapshot, re-sanitized on read (the column holds whatever was stored, including
 *  rows written by an older shape). */
export function readRunnerRepoHealth(value: unknown): MainCheckoutRepoHealth[] {
  return sanitizeRunnerRepoHealth(value) ?? [];
}

/** The checkout a workspace works in, or null when this runner never reported one for it (an older
 *  runner, or a workDir that isn't a git repo — isolation already reports that per session). */
export function repoHealthForWorkspace(
  reports: MainCheckoutRepoHealth[],
  workspaceId: string,
): MainCheckoutRepoHealth | null {
  return reports.find((r) => r.agentIds?.includes(workspaceId)) ?? null;
}
