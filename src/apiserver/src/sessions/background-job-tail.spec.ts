import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { backgroundJobTailRequestMessage, decodeBackgroundJobTailResponse } from '../realtime/runner-hints';
import { boundTailLines, parseTailLines } from './background-job-tail';

test('lines: absent is 40, more is capped to 40, anything but a whole N >= 1 is refused', () => {
  assert.equal(parseTailLines(undefined), 40);
  assert.equal(parseTailLines(''), 40);
  assert.equal(parseTailLines('7'), 7);
  assert.equal(parseTailLines('400'), 40);
  for (const bad of ['0', '-1', '2.5', 'abc', '1e3']) {
    assert.throws(() => parseTailLines(bad), BadRequestException, bad);
  }
});

test('the runner\'s text becomes at most N lines and 8 KB, without colour codes or NUL bytes', () => {
  assert.deepEqual(boundTailLines('', 40), { lines: [], cut: false });
  assert.deepEqual(boundTailLines('\x1b[31mred\x1b[0m\r\nplain\0 arr[0]\nlast, still being written', 40), {
    lines: ['red', 'plain arr[0]', 'last, still being written'], cut: false,
  });
  assert.deepEqual(boundTailLines('a\nb\nc\nd\n', 2), { lines: ['c', 'd'], cut: true });
  // Whole lines are dropped from the front until the rest fits; each newline between two lines counts.
  assert.deepEqual(boundTailLines('aaaa\nbbbb\ncccc\n', 40, 9), { lines: ['bbbb', 'cccc'], cut: true });
  // A last line longer than the cap keeps its end, cut on a character boundary.
  const wide = boundTailLines(`${'é'.repeat(10)}\n`, 40, 5);
  assert.equal(wide.cut, true);
  assert.deepEqual(wide.lines, ['éé']);
  assert.ok(Buffer.byteLength(wide.lines[0], 'utf8') <= 5);
});

test('a tail request and its answer read as the link protocol spells them', () => {
  assert.deepEqual(JSON.parse(backgroundJobTailRequestMessage('r-1', 's-1', 'bgj_1', 40, 8192)), {
    backgroundJobTailRequest: { requestId: 'r-1', sessionId: 's-1', jobId: 'bgj_1', maxLines: 40, maxBytes: 8192 },
  });
  const ok = JSON.stringify({ backgroundJobTailResponse: {
    requestId: 'r-1', sessionId: 's-1', jobId: 'bgj_1', outcome: 'BACKGROUND_JOB_TAIL_OUTCOME_OK', status: 'failed',
    exited: true, exitCode: 3, text: 'boom\n', truncated: true, outputBytes: '123',
  } });
  assert.deepEqual(decodeBackgroundJobTailResponse(ok, 'r-1'), {
    outcome: 'OK', status: 'failed', exitCode: 3, text: 'boom\n', truncated: true, outputBytes: 123,
  });
  assert.equal(decodeBackgroundJobTailResponse(ok, 'r-2'), null, 'an answer to another request');
  assert.equal(decodeBackgroundJobTailResponse('{"turnPrefixResponse":{}}', 'r-1'), null);
  // protojson leaves defaults out: exit code 0 without `exited` is no exit, and no outcome reads as NOT_FOUND.
  assert.deepEqual(decodeBackgroundJobTailResponse(JSON.stringify({ backgroundJobTailResponse: { requestId: 'r-1' } }), 'r-1'), {
    outcome: 'NOT_FOUND', status: '', exitCode: null, text: '', truncated: false, outputBytes: 0,
  });
  const exitedZero = JSON.stringify({ backgroundJobTailResponse: {
    requestId: 'r-1', outcome: 'BACKGROUND_JOB_TAIL_OUTCOME_OK', status: 'completed', exited: true,
  } });
  assert.equal(decodeBackgroundJobTailResponse(exitedZero, 'r-1')?.exitCode, 0);
});
