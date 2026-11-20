import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resourceSampleOf, runnerResourcesAnswerOf, sanitizeRunnerResources } from './runner-resources';

test('a reading keeps finite non-negative figures only, bytes whole and CPU at most 100', () => {
  assert.equal(sanitizeRunnerResources(null), null);
  assert.equal(sanitizeRunnerResources([1]), null);
  assert.deepEqual(
    sanitizeRunnerResources({
      cpuPercent: 140, cpuCores: 8.5, load1: -1, memTotalBytes: 32e9 + 0.5, memAvailableBytes: 'x', diskTotalBytes: 100,
      diskFreeBytes: 200, extra: 1,
    }),
    { cpuPercent: 100, cpuCores: 8, memTotalBytes: 32e9, diskTotalBytes: 100 },
    'free above total is no figure',
  );
});

test('a sample is the share in use of each, a figure missing a null', () => {
  assert.deepEqual(resourceSampleOf({ cpuPercent: 38.04, memTotalBytes: 32, memAvailableBytes: 8, diskTotalBytes: 926, diskFreeBytes: 198 }), [
    38, 75, 78.6,
  ]);
  assert.deepEqual(resourceSampleOf({ memTotalBytes: 32 }), [null, null, null]);
});

test('the stored column reads back as the page’s answer, and anything else as nothing kept', () => {
  assert.deepEqual(runnerResourcesAnswerOf(null), { at: null, latest: null, samples: [] });
  assert.deepEqual(runnerResourcesAnswerOf({ latest: {} }), { at: null, latest: null, samples: [] });
  const at = Date.parse('2026-11-14T10:00:00.000Z');
  assert.deepEqual(
    runnerResourcesAnswerOf({ at, latest: { cpuPercent: 12 }, samples: [[at - 30_000, 10, null, 50], ['bad'], [at, 12, 40, 50]] }),
    {
      at: '2026-11-14T10:00:00.000Z',
      latest: { cpuPercent: 12 },
      samples: [
        { at: '2026-11-14T09:59:30.000Z', cpu: 10, mem: null, disk: 50 },
        { at: '2026-11-14T10:00:00.000Z', cpu: 12, mem: 40, disk: 50 },
      ],
    },
  );
});
