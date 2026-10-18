/**
 * When a Cursor CLI session may move to another account or key (project P6b; D5, owner 2026-10-17;
 * docs/cursor-runtime-contract.md §13): one that has talked only on a runner that declares
 * cursor-account-move/v1 — none does yet — and one that has not on any. Named in
 * scripts/test-cursor-account-move.mjs; sessions/cursor-account-move.pg.spec.ts holds the doors to it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunStatus } from '@prisma/client';

import {
  ACCOUNT_MOVE_CAPABILITY,
  CURSOR_ACCOUNT_MOVE_V1,
  CURSOR_CONVERSATION_MOVE_REFUSAL,
  cursorConversationStarted,
  cursorMoveRefusal,
} from './account-move-capability';

const REFUSAL = "Cursor CLI can't carry a conversation to another account or key yet. Start a new session to use a different one.";

type Facts = Parameters<typeof cursorConversationStarted>[0];
/** A Cursor CLI session waiting for its first claim, unless `over` says otherwise. */
const session = (over: Partial<Facts> = {}): Facts => ({
  numTurns: 0, runtimeSessionId: null, status: RunStatus.PENDING, engineTurnActive: false, ...over,
});

test('P6b a Cursor CLI session has talked once a turn settled, once Cursor opened its conversation, or while a turn runs', () => {
  const talked: Array<[string, Facts]> = [
    ['idle after a turn', session({ status: RunStatus.AWAITING_INPUT, numTurns: 1, runtimeSessionId: 'conversation' })],
    ['ended after turns', session({ status: RunStatus.FAILED, numTurns: 3, runtimeSessionId: 'conversation' })],
    ['a settled turn without the id', session({ status: RunStatus.SUCCEEDED, numTurns: 1 })],
    // No turn settled, but Cursor opened its conversation, and the first prompt went out right after.
    ['ended in the middle of its first turn', session({ status: RunStatus.CANCELLED, runtimeSessionId: 'conversation' })],
    // A switch takes effect only once the turn is over, when the conversation is there.
    ['its first turn running', session({ status: RunStatus.RUNNING })],
    ['a turn the engine started itself', session({ status: RunStatus.AWAITING_INPUT, engineTurnActive: true })],
  ];
  for (const [state, facts] of talked) assert.equal(cursorConversationStarted(facts), true, state);
  const unspoken: Array<[string, Facts]> = [
    ['waiting for its first claim', session()],
    ['ended before Cursor opened a conversation', session({ status: RunStatus.FAILED })],
    ['live with nothing said', session({ status: RunStatus.AWAITING_INPUT })],
  ];
  for (const [state, facts] of unspoken) assert.equal(cursorConversationStarted(facts), false, state);
});

test('P6b a talked Cursor CLI session moves only on a runner that declares cursor-account-move/v1, and is told why anywhere else', () => {
  assert.equal(CURSOR_CONVERSATION_MOVE_REFUSAL, REFUSAL);
  assert.equal(CURSOR_ACCOUNT_MOVE_V1, 'cursor-account-move/v1');
  const talked = session({ status: RunStatus.AWAITING_INPUT, numTurns: 1, runtimeSessionId: 'conversation' });
  const unspoken = session();
  // Every runner in the field: none at all, one that runs Cursor CLI alone, one that keeps its accounts,
  // and one that carries every other engine's conversations.
  for (const capabilities of [
    [],
    ['provider:cursor'],
    ['provider:cursor', 'cursor-account-login/v1', 'cursor-account-remove/v1'],
    ['provider:cursor', 'codex-account-move/v1', 'claude-account-move/v1', 'kimi-account-move/v1', 'antigravity-account-login/v1'],
  ]) {
    assert.equal(cursorMoveRefusal(talked, { capabilities }), REFUSAL, capabilities.join(','));
    assert.equal(cursorMoveRefusal(unspoken, { capabilities }), null, capabilities.join(','));
  }
  assert.equal(cursorMoveRefusal(talked, null), REFUSAL, 'no runner at all');
  assert.equal(cursorMoveRefusal(unspoken, null), null, 'no runner at all');
  assert.equal(cursorMoveRefusal(talked, { capabilities: ['provider:cursor', CURSOR_ACCOUNT_MOVE_V1] }), null);
  // Every other engine's capability is the one it always was.
  assert.deepEqual(ACCOUNT_MOVE_CAPABILITY, {
    codex: 'codex-account-move/v1',
    claude: 'claude-account-move/v1',
    antigravity: 'antigravity-account-login/v1',
    kimi: 'kimi-account-move/v1',
    cursor: 'cursor-account-move/v1',
  });
});
