import { AgentProvider } from '@orbit/shared';

// The runtimes a configured provider borrows: their names are dispatch keywords, so no row may
// claim one. Treated as taken rather than rejected — the caller never chose this string.
const RESERVED = new Set<string>([AgentProvider.CLAUDE, AgentProvider.CODEX]);
// What a name that survives none of the normalisation below falls back to (a label written
// entirely in a non-Latin script, say).
const FALLBACK = 'provider';

/**
 * The identifier a provider dispatches under, derived from what the user actually chose: the
 * vendor they picked, or the name they typed. It's never asked for and never shown — Agent and
 * Session store it, so it has to exist and has to be stable, but which string it is concerns
 * nobody outside the database.
 */
export function slugBase(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) return FALLBACK;
  // Must start with a letter (the shape Agent.provider has always had).
  return /^[a-z]/.test(s) ? s : `p-${s}`;
}

/**
 * The first free identifier for a base, given what's already taken.
 *
 * Slugs are unique deployment-wide, so with personal (BYOK) providers the second user to connect
 * a vendor collides with the first — and neither can see the other's row to know why. Suffixing
 * is what keeps that from surfacing at all: they both connect Anthropic, one row is `anthropic`
 * and the other `anthropic-2`, and both are Anthropic providers because the preset link, not the
 * slug, says so.
 */
export function pickFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const free = (s: string) => !used.has(s) && !RESERVED.has(s);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (free(candidate)) return candidate;
  }
}
