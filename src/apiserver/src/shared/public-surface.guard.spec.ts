import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SharedRateLimiter } from './public-surface.guard';

const refused = (take: () => void) =>
  assert.throws(
    take,
    (e: unknown) => e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
  );

test('a key spends its budget inside a window and gets it back as the window slides', () => {
  const limiter = new SharedRateLimiter({ max: 2, windowMs: 1_000 });
  limiter.take('a', 0);
  limiter.take('a', 500);
  refused(() => limiter.take('a', 999));
  limiter.take('b', 999); // another key is a budget of its own
  limiter.take('a', 1_000); // the request at 0 has left the window
  refused(() => limiter.take('a', 1_400));
});

test('keys whose window has ended are dropped, so made-up keys cannot pile up', () => {
  const limiter = new SharedRateLimiter({ max: 2, windowMs: 1_000 });
  for (let i = 0; i < 100; i += 1) limiter.take(`10.0.0.${i} token-${i}`, 10);
  assert.equal(limiter.size, 100);
  limiter.take('10.0.0.200 token-late', 1_010);
  assert.equal(limiter.size, 1);
});
