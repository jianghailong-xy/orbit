import type { LoginEngine, RunnerEngineHealth } from '@orbit/shared';

/** The engines a runner can sign into (LoginEngine's full set), in the order they're shown. */
export const LOGIN_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'kimi'];

export function isLoginEngine(value: unknown): value is LoginEngine {
  return typeof value === 'string' && LOGIN_ENGINES.includes(value as LoginEngine);
}

/**
 * Normalize the per-engine health a runner reported.
 *
 * Heartbeat JSON is stored as sent, so every read has to survive a partial report or a runner
 * that sent something unexpected. Unrecognizable entries are dropped rather than repaired: a
 * half-parsed one would render as a confident claim about someone else's machine. Returns null
 * when nothing usable is there — which the UI shows as "not reported", not as "nothing installed".
 */
export function sanitizeRunnerEngines(value: unknown): RunnerEngineHealth[] | null {
  if (!Array.isArray(value)) return null;
  const byEngine = new Map<LoginEngine, RunnerEngineHealth>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (!isLoginEngine(entry.engine) || byEngine.has(entry.engine)) continue;
    const version =
      typeof entry.version === 'string' && entry.version.trim()
        ? entry.version.trim().slice(0, 120)
        : undefined;
    byEngine.set(entry.engine, {
      engine: entry.engine,
      installed: entry.installed === true,
      ...(version ? { version } : {}),
      // Only the CLI's own yes/no counts; everything else is the third state, which exists so
      // an engine that wouldn't answer is never shown as signed in.
      auth: entry.auth === 'yes' || entry.auth === 'no' ? entry.auth : 'unknown',
    });
  }
  if (!byEngine.size) return null;
  return LOGIN_ENGINES.map((engine) => byEngine.get(engine)).filter(
    (entry): entry is RunnerEngineHealth => !!entry,
  );
}
