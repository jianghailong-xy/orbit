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
    }),
    { sessionUuid: 'kimi-thread-1', runtimeSessionId: 'kimi-thread-1' },
  );
});

test('opencode sessions without a runtime id are reclaimable using the Orbit session id', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.OPENCODE,
      sessionId: 'session-1',
      runtimeSessionId: null,
    }),
    { sessionUuid: 'session-1', runtimeSessionId: undefined },
  );
});

test('opencode sessions with a runtime id reclaim that runtime session', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.OPENCODE,
      sessionId: 'session-1',
      runtimeSessionId: 'opencode-session-1',
    }),
    { sessionUuid: 'opencode-session-1', runtimeSessionId: 'opencode-session-1' },
  );
});

test('antigravity sessions without a conversation id are reclaimable using the Orbit session id', () => {
  // agy reports its conversation id in its init event; a runner that restarts before that starts a
  // fresh conversation rather than `--conversation` with an id agy never minted.
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.ANTIGRAVITY,
      sessionId: 'session-agy',
      runtimeSessionId: null,
    }),
    { sessionUuid: 'session-agy', runtimeSessionId: undefined },
  );
});

test('antigravity sessions with a conversation id reclaim that conversation', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.ANTIGRAVITY,
      sessionId: 'session-agy',
      runtimeSessionId: 'agy-conversation-1',
    }),
    { sessionUuid: 'agy-conversation-1', runtimeSessionId: 'agy-conversation-1' },
  );
});

test('claude sessions without a runtime id are not reclaimable', () => {
  assert.equal(
    reclaimRuntimeIds({
      provider: AgentProvider.CLAUDE,
      sessionId: 'session-1',
      runtimeSessionId: null,
    }),
    null,
  );
});

test('claude sessions resume with the runtime session id', () => {
  assert.deepEqual(
    reclaimRuntimeIds({
      provider: AgentProvider.CLAUDE,
      sessionId: 'session-1',
      runtimeSessionId: 'runtime-1',
    }),
    { sessionUuid: 'runtime-1', runtimeSessionId: 'runtime-1' },
  );
});
