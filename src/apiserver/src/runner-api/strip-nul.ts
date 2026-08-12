// Escaped, never written literally: a source file carrying a raw NUL is itself the hazard this
// module exists for — reading one is how an agent's tool_result picks one up.
const NUL = '\u0000';

/**
 * Strip NUL (U+0000) out of anything a runner reports.
 *
 * Postgres accepts no NUL in `text` or `jsonb` — it fails the statement with 22P05
 * ("unsupported Unicode escape sequence"). An agent only has to read one binary file for its
 * tool_result to carry one, and that single event used to fail the whole `run_event` insert.
 * The runner replays a rejected batch in order and treats 5xx as retryable without a ceiling,
 * so every later event for that session queued up behind the poison one — permanently, and
 * without a log line on either side. The transcript froze while the agent kept working.
 *
 * A byte the database cannot store is worth less than the stream it blocks, so it is dropped
 * here, at the edge, before anything derives from the payload.
 *
 * Returns the input itself when there is nothing to strip — the common case allocates nothing,
 * since `String.includes` is a scan rather than a rewrite.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes(NUL) ? value.replaceAll(NUL, '') : value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const clean = stripNul(v);
      if (clean !== v) changed = true;
      return clean;
    });
    return (changed ? out : value) as T;
  }
  // Plain objects only: a Date (or any class instance) must survive as itself, and payloads
  // reaching here are parsed JSON anyway.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = stripNul(k);
      const clean = stripNul(v);
      if (clean !== v || cleanKey !== k) changed = true;
      out[cleanKey] = clean;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
