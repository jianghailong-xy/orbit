import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { runtimeInitSessionId } from './runtime-init';

test('extracts the runtime session id from a codex app-server init event', () => {
  assert.equal(
    runtimeInitSessionId([
      {
        type: RunEventType.SYSTEM,
        payload: { runtime: 'app-server', subtype: 'init', provider: 'codex', sessionId: 'rt-1' },
      },
    ]),
    'rt-1',
  );
});

test('extracts the runtime session id from the standard OpenCode init event', () => {
  assert.equal(
    runtimeInitSessionId([
      {
        type: RunEventType.SYSTEM,
        payload: {
          runtime: 'opencode-server',
          subtype: 'init',
          provider: 'opencode',
          sessionId: 'opencode-runtime-1',
        },
      },
    ]),
    'opencode-runtime-1',
  );
});

test('extracts the conversation id from the init event the runner makes of agy\'s own', () => {
  // docs/antigravity-runtime-contract.md §2.2: agy's `init` becomes a system init event whose
  // sessionId is its conversation_id — once per process, so again after every restart.
  assert.equal(
    runtimeInitSessionId([
      {
        type: RunEventType.SYSTEM,
        payload: {
          subtype: 'init',
          provider: 'antigravity',
          sessionId: '6b0f8a52-agy-conversation',
        },
      },
    ]),
    '6b0f8a52-agy-conversation',
  );
});

test('also matches a resumed event', () => {
  assert.equal(
    runtimeInitSessionId([{ type: RunEventType.SYSTEM, payload: { subtype: 'resumed', sessionId: 'rt-2' } }]),
    'rt-2',
  );
});

test('returns the first init/resumed id when several are present', () => {
  assert.equal(
    runtimeInitSessionId([
      { type: RunEventType.SYSTEM, payload: { subtype: 'init', sessionId: 'rt-first' } },
      { type: RunEventType.SYSTEM, payload: { subtype: 'resumed', sessionId: 'rt-second' } },
    ]),
    'rt-first',
  );
});

test('ignores non-system events and system events without a session id', () => {
  assert.equal(
    runtimeInitSessionId([
      { type: RunEventType.ASSISTANT, payload: { text: 'hi' } },
      { type: RunEventType.SYSTEM, payload: { subtype: 'init' } },
      { type: RunEventType.SYSTEM, payload: { subtype: 'other', sessionId: 'nope' } },
    ]),
    null,
  );
});

test('returns null for an empty batch', () => {
  assert.equal(runtimeInitSessionId([]), null);
});
