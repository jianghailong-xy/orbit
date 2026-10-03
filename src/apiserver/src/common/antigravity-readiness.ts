import type { RunnerAntigravityState } from '@orbit/shared';
import { sanitizeRunnerEngines } from './runner-engines';

export function hasGeminiEnvKey(env: unknown): boolean {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const key = (env as Record<string, unknown>).GEMINI_API_KEY;
  return typeof key === 'string' && key.trim() !== '';
}

/** Persisted provider declarations share Runner.capabilities with named protocol capabilities. */
export function antigravityState(runner: { capabilities?: readonly string[]; engines: unknown }): RunnerAntigravityState {
  const health = sanitizeRunnerEngines(runner.engines)?.find((entry) => entry.engine === 'antigravity');
  return {
    supported: runner.capabilities?.includes('provider:antigravity') ?? false,
    installed: health?.installed ?? null,
    version: health?.version ?? null,
    envKeyAvailable: health?.auth === 'yes',
  };
}
