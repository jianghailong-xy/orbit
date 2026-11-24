/**
 * The pieces of the drive's chunked store that need no database (docs/drive-technical-design.md §2.2, §2.3):
 * the ranged read of each store, the byte cap on a chunk's temporary file, and the chunk door's refusals of what it can
 * tell is wrong before it reads a byte. drive-chunk-store.pg.spec.ts holds the rest against a real database and a real S3
 * server.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { LocalFileStore, TempFileTooLargeError, writeHashedTempFile } from '../files/file-store';
import type { FilesService } from '../files/files.service';
import { S3FileStore } from '../files/s3-file-store';
import { DRIVE_CHUNK_INVALID, DRIVE_CHUNK_MAX, DriveChunksService } from './drive-chunks.service';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function readAll(stream: Readable | null): Promise<Buffer> {
  assert.ok(stream, 'the bytes are there');
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

test('the local store reads any range of a content, and refuses one that is not a range or starts past its end', async (t) => {
  const dir = scratch(t);
  const store = new LocalFileStore(dir);
  const bytes = randomBytes(100_000);
  const temp = path.join(dir, 'tmp-upload');
  writeFileSync(temp, bytes);
  await store.put(sha256(bytes), temp);
  for (const [start, end] of [[0, 0], [0, 99_999], [1, 65_537], [99_999, 99_999], [50_000, 10_000_000]]) {
    const got = await readAll(await store.open(sha256(bytes), { start, end }));
    assert.ok(got.equals(bytes.subarray(start, end + 1)), `bytes ${start}-${end}`);
  }
  assert.ok((await readAll(await store.open(sha256(bytes)))).equals(bytes), 'no range is the whole content');
  await assert.rejects(store.open(sha256(bytes), { start: 100_000, end: 100_001 }), RangeError);
  await assert.rejects(store.open(sha256(bytes), { start: 5, end: 4 }), RangeError);
  await assert.rejects(store.open(sha256(bytes), { start: -1, end: 4 }), RangeError);
  assert.equal(await store.open(sha256(Buffer.from('not kept')), { start: 0, end: 1 }), null);
});

test('the S3 store asks for a range with a signed Range header and takes the 206, and a 416 is a RangeError', async (t) => {
  const bytes = randomBytes(1000);
  const seen: Array<{ range?: string; signed: string }> = [];
  const bucket = http.createServer((request, response) => {
    const range = request.headers.range;
    seen.push({ range, signed: /SignedHeaders=([^,]*)/.exec(String(request.headers.authorization))?.[1] ?? '' });
    if (!range) {
      response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
      return;
    }
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!.map(Number);
    if (start >= bytes.length) {
      response.writeHead(416).end();
      return;
    }
    const part = bytes.subarray(start, Math.min(end, bytes.length - 1) + 1);
    response.writeHead(206, { 'content-length': part.length }).end(part);
  });
  t.after(() => {
    bucket.closeAllConnections();
    bucket.close();
  });
  await once(bucket.listen(0, '127.0.0.1'), 'listening');
  const store = new S3FileStore({
    endpoint: `http://127.0.0.1:${(bucket.address() as net.AddressInfo).port}`,
    bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1',
  });
  assert.ok((await readAll(await store.open('ab'.repeat(32), { start: 10, end: 19 }))).equals(bytes.subarray(10, 20)));
  assert.ok((await readAll(await store.open('ab'.repeat(32)))).equals(bytes));
  await assert.rejects(store.open('ab'.repeat(32), { start: 1000, end: 1001 }), RangeError);
  await assert.rejects(store.open('ab'.repeat(32), { start: 3, end: 2 }), RangeError);
  assert.deepEqual(seen.map((request) => request.range), ['bytes=10-19', undefined, 'bytes=1000-1001'], 'a range that is not one is refused unsent');
  assert.ok(seen[0].signed.split(';').includes('range'), 'the Range header is signed');
  assert.ok(!seen[1].signed.split(';').includes('range'));
});

test('a temporary file with a byte cap takes exactly that many bytes and fails at one more, leaving nothing behind', async (t) => {
  const dir = scratch(t);
  const bytes = randomBytes(4096);
  const kept = await writeHashedTempFile(Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]), dir, undefined, 4096);
  assert.equal(kept.size, 4096);
  assert.equal(kept.sha256, sha256(bytes));
  rmSync(kept.path);
  // The cap is crossed in the second piece: the file never gets it.
  let tempPath = '';
  await assert.rejects(
    writeHashedTempFile(Readable.from([bytes, Buffer.from('x')]), dir, (p) => {
      tempPath = p;
    }, 4096),
    (error) => error instanceof TempFileTooLargeError && error.maxBytes === 4096,
  );
  assert.equal(existsSync(tempPath), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('the chunk door refuses an index or a sha256 that is not one before it reads the body or asks the database', async () => {
  const service = new DriveChunksService({} as never, { config: { dir: '/nonexistent' } } as unknown as FilesService);
  const body = () => Readable.from([Buffer.from('chunk')]);
  for (const [idx, hash] of [[-1, 'ab'.repeat(32)], [1.5, 'ab'.repeat(32)], [0, 'AB'.repeat(32)], [0, 'ab'.repeat(31)]] as const) {
    await assert.rejects(
      service.putChunk('owner', 'staging', idx, hash, body()),
      (error) => error instanceof HttpException && error.getStatus() === 400
        && (error.getResponse() as { code: string }).code === DRIVE_CHUNK_INVALID,
      `${idx} ${hash}`,
    );
  }
  assert.equal(DRIVE_CHUNK_MAX, 8 * 1024 * 1024);
});
