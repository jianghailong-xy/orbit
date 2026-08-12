import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { stripNul } from './strip-nul';

// Built rather than written, for the same reason strip-nul.ts escapes it: a raw NUL in a source
// file is the hazard under test.
const NUL = String.fromCharCode(0);

test('a NUL anywhere in an event payload is dropped', () => {
  const events = [
    { seq: 1, type: 'tool_result', payload: { content: `binary${NUL}junk`, nested: [{ t: `a${NUL}` }] } },
  ];
  assert.deepEqual(stripNul(events), [
    { seq: 1, type: 'tool_result', payload: { content: 'binaryjunk', nested: [{ t: 'a' }] } },
  ]);
});

test('a clean batch comes back as the very same array', () => {
  // The hot path: every batch passes through here, so an untouched one must not be rebuilt.
  const events = [{ seq: 1, type: 'assistant', payload: { text: 'hello' } }];
  assert.equal(stripNul(events), events);
});

test('non-string values survive as themselves', () => {
  const at = new Date('2026-08-12T00:00:00Z');
  const clean = stripNul({ n: 1, b: true, nil: null, at, list: [1, 2] });
  // A Date must come back as the Date, not as a walked-over plain object.
  assert.equal(clean.at, at);
  assert.deepEqual(clean, { n: 1, b: true, nil: null, at, list: [1, 2] });
});

test('a NUL in a key is stripped too', () => {
  assert.deepEqual(stripNul({ [`k${NUL}`]: 'v' }), { k: 'v' });
});
