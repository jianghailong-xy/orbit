import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { DEFAULT_MAX_PAYLOAD, parseMaxPayload, truncatePayload } from './truncate-payload';

const long = 'x'.repeat(5000);

test('clips a string tool_result and flags it', () => {
  const r = truncatePayload(RunEventType.TOOL_RESULT, { toolUseId: 't1', content: long }, 100);
  assert.equal(r.truncated, true);
  assert.equal((r.payload as { content: string }).content.length, 100);
  assert.equal((r.payload as { toolUseId: string }).toolUseId, 't1');
});

test('clips the text blocks of a block-array tool_result', () => {
  const r = truncatePayload(
    RunEventType.TOOL_RESULT,
    { content: [{ type: 'text', text: long }, { type: 'text', text: 'short' }] },
    100,
  );
  assert.equal(r.truncated, true);
  const blocks = (r.payload as { content: { text: string }[] }).content;
  assert.equal(blocks[0].text.length, 100);
  assert.equal(blocks[1].text, 'short');
});

test('leaves image blocks whole — half a base64 string is a broken image, not a preview', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: long } };
  const r = truncatePayload(RunEventType.TOOL_RESULT, { content: [image] }, 100);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.payload, { content: [image] });
});

test('clips every string in a tool_use input, however deep', () => {
  const r = truncatePayload(
    RunEventType.TOOL_USE,
    { id: 'tu1', name: 'Write', input: { file_path: '/a.ts', content: long, todos: [{ text: long }] } },
    100,
  );
  assert.equal(r.truncated, true);
  const input = r.payload as { input: { file_path: string; content: string; todos: { text: string }[] } };
  assert.equal(input.input.file_path, '/a.ts');
  assert.equal(input.input.content.length, 100);
  assert.equal(input.input.todos[0].text.length, 100);
  assert.equal((r.payload as { name: string }).name, 'Write');
});

test('never trims the prose the reader came for', () => {
  for (const type of [RunEventType.ASSISTANT, RunEventType.THINKING, RunEventType.USER]) {
    const payload = { text: long };
    const r = truncatePayload(type, payload, 100);
    assert.equal(r.truncated, false);
    assert.equal(r.payload, payload); // same object identity — untouched
  }
});

test('under the cap nothing is copied or flagged', () => {
  const payload = { toolUseId: 't', content: 'small' };
  const r = truncatePayload(RunEventType.TOOL_RESULT, payload, DEFAULT_MAX_PAYLOAD);
  assert.equal(r.truncated, false);
  assert.equal(r.payload, payload);
});

test('tolerates a payload with no content/input at all', () => {
  assert.equal(truncatePayload(RunEventType.TOOL_RESULT, { toolUseId: 't' }, 100).truncated, false);
  assert.equal(truncatePayload(RunEventType.TOOL_USE, { name: 'Bash' }, 100).truncated, false);
  assert.equal(truncatePayload(RunEventType.TOOL_RESULT, null, 100).truncated, false);
});

test('parseMaxPayload: absent/garbage disables trimming, tiny values are floored', () => {
  assert.equal(parseMaxPayload(undefined), undefined);
  assert.equal(parseMaxPayload(''), undefined);
  assert.equal(parseMaxPayload('nope'), undefined);
  assert.equal(parseMaxPayload('0'), undefined);
  assert.equal(parseMaxPayload('-5'), undefined);
  assert.equal(parseMaxPayload('16'), 256);
  assert.equal(parseMaxPayload('4096'), 4096);
});
