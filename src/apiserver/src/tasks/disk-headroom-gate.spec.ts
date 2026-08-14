import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diskBelowFloor } from './tasks.service';

const MB = 1024n * 1024n;

test('a filesystem under the floor is short', () => {
  assert.equal(diskBelowFloor(500n * MB, 1024), true);
});

test('a filesystem at or above the floor is not', () => {
  // Exactly at the floor is enough — the floor is the reserve to keep, not to exceed.
  assert.equal(diskBelowFloor(1024n * MB, 1024), false);
  assert.equal(diskBelowFloor(2048n * MB, 1024), false);
});

// Everything below is the fail-open half of the contract. A disk gate that fires on absent
// telemetry would stop a fleet precisely because it knows nothing about it — and the outage it
// guards against cannot be evidenced by its own silence.
test('no reading from the runner means no gate', () => {
  // Old binary, missing work dir, or a platform with no answer: all arrive as null, and none of
  // them is a claim that the disk is full.
  assert.equal(diskBelowFloor(null, 1024), false);
  assert.equal(diskBelowFloor(undefined, 1024), false);
});

test('no floor configured means no gate', () => {
  assert.equal(diskBelowFloor(1n, null), false);
  assert.equal(diskBelowFloor(1n, undefined), false);
});

test('a nonsensical floor is ignored rather than enforced', () => {
  // 0 and negatives would gate nothing or everything; NaN compares false against everything and
  // would silently disable the gate at the comparison instead of here, where it can be seen.
  assert.equal(diskBelowFloor(1n, 0), false);
  assert.equal(diskBelowFloor(1n, -5), false);
  assert.equal(diskBelowFloor(1n, Number.NaN), false);
});

test('a genuinely empty filesystem is short, and is not confused with an absent reading', () => {
  // The one case where zero is a real measurement rather than a missing one.
  assert.equal(diskBelowFloor(0n, 1), true);
});

test('the comparison holds past Number.MAX_SAFE_INTEGER', () => {
  // 9 PB free against a 1 GB floor. Doing this arithmetic in `number` would lose precision at
  // exactly the scale of the archive volumes this gate exists for.
  const ninePetabytes = 9n * 1024n * 1024n * 1024n * MB;
  assert.ok(ninePetabytes > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(diskBelowFloor(ninePetabytes, 1024), false);
  assert.equal(diskBelowFloor(ninePetabytes, 1024 * 1024 * 1024 * 32), true);
});
