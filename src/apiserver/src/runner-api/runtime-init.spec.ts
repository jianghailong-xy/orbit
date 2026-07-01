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
