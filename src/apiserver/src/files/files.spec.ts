import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import {
  DEFAULT_FILES_DIR,
  LocalFileStore,
  filesConfigFrom,
  uploadTempDir,
  writeHashedTempFile,
} from './file-store';
import { fileUploadStorage } from './file-upload-storage';
import { sigV4Authorization, sigV4Encode } from './s3-file-store';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-files-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Signature Version 4, against the worked examples AWS publishes for S3 ─────────────────────────
// docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Examples: Signature
// Calculations": the same credentials, the same instant, the signatures printed there.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('the S3 signature is AWS\'s own for its GET Object example', () => {
  const authorization = sigV4Authorization({
    method: 'GET',
    path: '/test.txt',
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY,
      'x-amz-date': '20130524T000000Z',
    },
    payloadSha256: EMPTY,
  }, AWS_EXAMPLE, '20130524T000000Z');
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('the S3 signature is AWS\'s own for its PUT Object example, a key that needs encoding included', () => {
  const body = Buffer.from('Welcome to Amazon S3.');
  const payload = sha256(body);
  assert.equal(payload, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const authorization = sigV4Authorization({
    method: 'PUT',
    path: `/${sigV4Encode('test$file.text')}`,
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      'x-amz-content-sha256': payload,
    },
    payloadSha256: payload,
  }, AWS_EXAMPLE, '20130524T000000Z');
  assert.match(authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
  assert.match(authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('a key is encoded the way the signature reads it: unreserved characters kept, the rest percent-encoded', () => {
  assert.equal(sigV4Encode('test$file.text'), 'test%24file.text');
  assert.equal(sigV4Encode("a b!'()*~-._"), 'a%20b%21%27%28%29%2A~-._');
});

// ── Configuration ──────────────────────────────────────────────────────────────────────────────
test('with nothing set, files are kept in /var/lib/orbit/files', () => {
  assert.deepEqual(filesConfigFrom({}), { dir: DEFAULT_FILES_DIR, storage: 'local' });
  assert.equal(DEFAULT_FILES_DIR, '/var/lib/orbit/files');
  assert.deepEqual(filesConfigFrom({ ORBIT_FILES_DIR: '/srv/files' }), { dir: '/srv/files', storage: 'local' });
});

test('s3 takes the endpoint, bucket, key pair and region, and refuses to start without them', () => {
  assert.deepEqual(filesConfigFrom({
    ORBIT_FILES_BACKEND: 's3',
    ORBIT_FILES_S3_ENDPOINT: 'http://minio:9000',
    ORBIT_FILES_S3_BUCKET: 'orbit',
    ORBIT_FILES_S3_ACCESS_KEY_ID: 'id',
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: 'secret',
  }), {
    dir: DEFAULT_FILES_DIR,
    storage: 's3',
    s3: { endpoint: 'http://minio:9000', bucket: 'orbit', accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' },
  });
  assert.throws(
    () => filesConfigFrom({ ORBIT_FILES_BACKEND: 's3', ORBIT_FILES_S3_ENDPOINT: 'http://minio:9000' }),
    /ORBIT_FILES_BACKEND=s3 needs ORBIT_FILES_S3_BUCKET, ORBIT_FILES_S3_ACCESS_KEY_ID, ORBIT_FILES_S3_SECRET_ACCESS_KEY/,
  );
  assert.throws(() => filesConfigFrom({
    ORBIT_FILES_BACKEND: 's3',
    ORBIT_FILES_S3_ENDPOINT: 'minio:9000',
    ORBIT_FILES_S3_BUCKET: 'orbit',
    ORBIT_FILES_S3_ACCESS_KEY_ID: 'id',
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: 'secret',
  }), /must be an http:\/\/ or https:\/\/ URL/);
  assert.throws(() => filesConfigFrom({ ORBIT_FILES_BACKEND: 'gcs' }), /must be local or s3, not "gcs"/);
});

// ── An upload, on its way to the store ────────────────────────────────────────────────────────
test('an upload is written to a temporary file and hashed as it passes, in pieces, never whole', async (t) => {
  const dir = scratch(t);
  const bytes = randomBytes(3 * 1024 * 1024 + 7);
  // In 64 KiB pieces, as a request body arrives: the writer sees no more than one at a time.
  const pieces = Readable.from(Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) => bytes.subarray(i * 65536, (i + 1) * 65536)));
  let announced: string | undefined;
  const written = await writeHashedTempFile(pieces, dir, (tempPath) => {
    announced = tempPath;
  });
  assert.equal(written.path, announced, 'the path is known before the first byte, for a caller that must remove it');
  assert.equal(path.dirname(written.path), dir);
  assert.deepEqual({ size: written.size, sha256: written.sha256 }, { size: bytes.length, sha256: sha256(bytes) });
  assert.ok(readFileSync(written.path).equals(bytes));
});

test('an upload that fails while it is written leaves no file behind', async (t) => {
  const dir = scratch(t);
  const source = new PassThrough();
  const writing = writeHashedTempFile(source, dir);
  source.write(randomBytes(1024));
  // The first piece reaches the disk, and then the client goes away.
  for (let i = 0; i < 200; i += 1) {
    const [name] = readdirSync(dir);
    if (name && statSync(path.join(dir, name)).size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readdirSync(dir).length, 1, 'the upload was being written');
  source.destroy(new Error('the client went away'));
  await assert.rejects(writing, /the client went away/);
  assert.deepEqual(readdirSync(dir), []);
});

test('the routes\' multer engine hands on a file on disk with its sha256, never a buffer, and removes it on request', async (t) => {
  const dir = scratch(t);
  const engine = fileUploadStorage(() => uploadTempDir(dir));
  const bytes = randomBytes(200_000);
  const file: { stream: Readable; path?: string } = { stream: Readable.from([bytes]) };
  const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
    engine._handleFile({}, file, (error, written) => (error ? reject(error) : resolve({ ...written })));
  });
  assert.deepEqual(Object.keys(info).sort(), ['path', 'sha256', 'size']);
  assert.equal(file.path, info.path, 'multer can clean up a file whose write it aborts');
  assert.equal(path.dirname(info.path as string), path.join(dir, 'tmp'));
  assert.equal(info.sha256, sha256(bytes));
  assert.ok(readFileSync(info.path as string).equals(bytes));
  await new Promise<void>((resolve, reject) => engine._removeFile({}, { path: info.path as string }, (error) => (error ? reject(error) : resolve())));
  assert.deepEqual(readdirSync(path.join(dir, 'tmp')), []);
  // Removing one already gone is no error: multer and the route may both try.
  await new Promise<void>((resolve, reject) => engine._removeFile({}, { path: info.path as string }, (error) => (error ? reject(error) : resolve())));
});

// ── The files directory as a store ─────────────────────────────────────────────────────────────
test('the local store keeps a content once at <sha256[0:2]>/<sha256>, by renaming the temporary file', async (t) => {
  const dir = scratch(t);
  const store = new LocalFileStore(dir);
  const bytes = randomBytes(4096);
  const name = sha256(bytes);
  assert.equal(await store.has(name), false);
  assert.equal(await store.open(name), null);
  for (const _ of [1, 2]) {
    const temp = path.join(dir, 'tmp-upload');
    writeFileSync(temp, bytes);
    await store.put(name, temp);
    assert.deepEqual(readdirSync(dir).sort(), [name.slice(0, 2)], 'the temporary file is gone, renamed into place');
  }
  assert.deepEqual(readdirSync(path.join(dir, name.slice(0, 2))), [name], 'stored twice, kept once');
  assert.equal(store.pathOf(name), path.join(dir, name.slice(0, 2), name));
  assert.equal(await store.has(name), true);
  const chunks: Buffer[] = [];
  for await (const chunk of (await store.open(name))!) chunks.push(chunk as Buffer);
  assert.ok(Buffer.concat(chunks).equals(bytes));
});
