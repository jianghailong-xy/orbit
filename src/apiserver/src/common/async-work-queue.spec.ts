import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncWorkQueue } from './async-work-queue';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('AsyncWorkQueue bounds concurrent work and drains every queued job', async () => {
  const queue = new AsyncWorkQueue(3);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const startedOrder: number[] = [];

  const jobs = Array.from({ length: 8 }, (_, index) =>
    queue.run(async () => {
      started += 1;
      startedOrder.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return index;
    }),
  );

  await flush();
  assert.equal(started, 3);
  assert.equal(maxActive, 3);

  release();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(startedOrder, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maxActive, 3);
});

test('AsyncWorkQueue continues after a job rejects', async () => {
  const queue = new AsyncWorkQueue(1);
  const first = queue.run(() => {
    throw new Error('expected failure');
  });
  const second = queue.run(() => 42);

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 42);
});

test('AsyncWorkQueue rejects invalid concurrency', () => {
  assert.throws(() => new AsyncWorkQueue(0), /positive integer/);
  assert.throws(() => new AsyncWorkQueue(1.5), /positive integer/);
});
