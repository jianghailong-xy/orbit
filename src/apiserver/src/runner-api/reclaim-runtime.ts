import { AgentProvider } from '@orbit/shared';

export interface ReclaimRuntimeInput {
  provider: AgentProvider;
  sessionId: string;
  runtimeSessionId?: string | null;
  claudeSessionId?: string | null;
}

export interface ReclaimRuntimeIds {
  sessionUuid: string;
  runtimeSessionId?: string;
}

export function reclaimRuntimeIds(input: ReclaimRuntimeInput): ReclaimRuntimeIds | null {
  const runtimeSessionId = input.runtimeSessionId ?? input.claudeSessionId ?? undefined;
  if (input.provider === AgentProvider.CLAUDE) {
    if (!runtimeSessionId) return null;
    return {
      sessionUuid: input.claudeSessionId ?? runtimeSessionId,
      runtimeSessionId,
    };
  }

  // Codex and Kimi create their runtime thread after process initialization. If a runner
  // restarts before that, reclaim with the Orbit session id and start a fresh thread.
  return {
    sessionUuid: runtimeSessionId ?? input.sessionId,
    runtimeSessionId,
  };
}
