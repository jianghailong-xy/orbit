import { AgentProvider } from '@orbit/shared';

export interface ReclaimRuntimeInput {
  provider: AgentProvider;
  sessionId: string;
  runtimeSessionId?: string | null;
}

export interface ReclaimRuntimeIds {
  sessionUuid: string;
  runtimeSessionId?: string;
}

export function reclaimRuntimeIds(input: ReclaimRuntimeInput): ReclaimRuntimeIds | null {
  const runtimeSessionId = input.runtimeSessionId ?? undefined;
  if (input.provider === AgentProvider.CLAUDE) {
    if (!runtimeSessionId) return null;
    return {
      sessionUuid: runtimeSessionId,
      runtimeSessionId,
    };
  }

  // Codex, Kimi and OpenCode create their runtime thread after process initialization. If a
  // runner restarts before that, reclaim with the Orbit session id and start a fresh thread.
  return {
    sessionUuid: runtimeSessionId ?? input.sessionId,
    runtimeSessionId,
  };
}
