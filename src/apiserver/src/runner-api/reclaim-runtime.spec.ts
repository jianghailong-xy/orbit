import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { reclaimRuntimeIds } from './reclaim-runtime';

test('codex sessions without a runtime id are reclaimable using the session id', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.CODEX,
      sessionId: 'session-1',
      runtimeSessionId: null,
      claudeSessionId: null,
    }),
    { sessionUuid: 'session-1', runtimeSessionId: undefined },
  );
});

test('codex sessions with a runtime id reclaim that runtime thread', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.CODEX,
      sessionId: 'session-1',
      runtimeSessionId: 'thread-1',
      claudeSessionId: null,
    }),
    { sessionUuid: 'thread-1', runtimeSessionId: 'thread-1' },
  );
});

test('kimi sessions without a runtime id are reclaimable using the session id', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.KIMI,
      sessionId: 'session-kimi',
      runtimeSessionId: null,
      claudeSessionId: null,
    }),
    { sessionUuid: 'session-kimi', runtimeSessionId: undefined },
  );
});

test('kimi sessions with a runtime id reclaim that runtime thread', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.KIMI,
      sessionId: 'session-kimi',
      runtimeSessionId: 'kimi-thread-1',
      claudeSessionId: null,
    }),
    { sessionUuid: 'kimi-thread-1', runtimeSessionId: 'kimi-thread-1' },
  );
});

test('claude sessions without a runtime id are not reclaimable', () => {
  assert.equal(
    reclaimRuntimeIds({
      provider: AgentProvider.CLAUDE,
      sessionId: 'session-1',
      runtimeSessionId: null,
      claudeSessionId: null,
    }),
    null,
  );
});

test('claude sessions prefer the claude session id as the resume key', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.CLAUDE,
      sessionId: 'session-1',
      runtimeSessionId: 'runtime-1',
      claudeSessionId: 'claude-1',
    }),
    { sessionUuid: 'claude-1', runtimeSessionId: 'runtime-1' },
  );
});
