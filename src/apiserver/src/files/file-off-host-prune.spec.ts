import assert from 'node:assert/strict';
import test from 'node:test';
import { fileGraceMs, offHostPruneAtFor } from './file-retention';
import { filesConfigFrom } from './file-store';

const S3_ENV = {
  ORBIT_DRIVE_BACKEND: 's3',
  ORBIT_DRIVE_S3_ENDPOINT: 'http://minio:9000',
  ORBIT_DRIVE_S3_BUCKET: 'orbit',
  ORBIT_DRIVE_S3_ACCESS_KEY_ID: 'key',
  ORBIT_DRIVE_S3_SECRET_ACCESS_KEY: 'secret',
};
const NOW = new Date('2026-11-20T00:00:00Z');
const GRACE = fileGraceMs({ backupRetentionMs: 0 });

test('ORBIT_DRIVE_S3_MIRROR=1 is the only value that declares a mirror', () => {
  assert.equal(filesConfigFrom({ ...S3_ENV }).s3Mirror, undefined);
  assert.equal(filesConfigFrom({ ...S3_ENV, ORBIT_DRIVE_S3_MIRROR: '0' }).s3Mirror, undefined);
  assert.equal(filesConfigFrom({ ...S3_ENV, ORBIT_DRIVE_S3_MIRROR: 'true' }).s3Mirror, undefined);
  assert.equal(filesConfigFrom({ ...S3_ENV, ORBIT_DRIVE_S3_MIRROR: '1' }).s3Mirror, true);
});

test('an s3 blob gets off_host_prune_at one grace period on only when the bucket is mirrored', () => {
  const mirrored = filesConfigFrom({ ...S3_ENV, ORBIT_DRIVE_S3_MIRROR: '1' });
  const plain = filesConfigFrom({ ...S3_ENV });
  assert.deepEqual(offHostPruneAtFor('s3', mirrored, NOW, GRACE), new Date(NOW.getTime() + GRACE));
  assert.equal(offHostPruneAtFor('s3', plain, NOW, GRACE), null, 'no mirror declared: nothing of it is off host');
});

test('a local blob keeps its off-host date whether or not a bucket is mirrored', () => {
  const expected = new Date(NOW.getTime() + GRACE);
  assert.deepEqual(offHostPruneAtFor('local', filesConfigFrom({}), NOW, GRACE), expected);
  assert.deepEqual(offHostPruneAtFor('local', filesConfigFrom({ ...S3_ENV, ORBIT_DRIVE_S3_MIRROR: '1' }), NOW, GRACE), expected);
});

test('a store the sweep does not know is never dated', () => {
  assert.equal(offHostPruneAtFor('tape', { s3Mirror: true }, NOW, GRACE), null);
});
