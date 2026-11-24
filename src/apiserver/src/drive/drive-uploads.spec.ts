/** The pieces of the drive's upload and download routes that need no database: the Range header's reading. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRange } from './drive-content.service';

test('parseRange reads one byte range against the content size', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
});

test('parseRange answers unsatisfiable for a start past the end, and none for what is not a single range', () => {
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=9-5', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=0-1', 0), null);
});
