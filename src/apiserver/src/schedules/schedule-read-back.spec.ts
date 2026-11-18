import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scheduleReadBack } from './schedule-views';

const schedule = {
  readBack: null,
  rule: { kind: 'DAILY', time: '23:46' },
  timezone: 'Asia/Shanghai',
  title: 'Version check',
  prompt: 'Check watched.txt and tell me only when its version line changes. Read the version line first.',
};

test('a missing read-back combines current timing with the first prompt sentence', () => {
  assert.equal(scheduleReadBack(schedule),
    'Every day at 23:46 · Asia/Shanghai · Check watched.txt and tell me only when its version line changes.');
});

test('a supplied read-back is kept verbatim', () => {
  const readBack = 'Every day at 23:46 Beijing time, check X and tell me only when Y changes.';
  assert.equal(scheduleReadBack({ ...schedule, readBack }), readBack);
});

test('a multiline prompt uses its first line and an empty prompt falls back to the title', () => {
  assert.equal(scheduleReadBack({ ...schedule, prompt: 'Check watched.txt\nCompare its version line.' }),
    'Every day at 23:46 · Asia/Shanghai · Check watched.txt');
  assert.equal(scheduleReadBack({ ...schedule, prompt: '  ' }),
    'Every day at 23:46 · Asia/Shanghai · Version check');
});
