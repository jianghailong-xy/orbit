/**
 * The drive's chunked, streamed store (docs/drive-technical-design.md §2.2–§2.4; migration 1283;
 * drive/drive-chunks.service.ts, files/file-store.ts, files/s3-file-store.ts, files/file-retention-sweep.ts), over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, once with each store:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-chunk-store.pg.spec.ts
 *
 *   local  the files directory, a directory of this run's;
 *   s3     a real S3-compatible server, VersityGW (test-support/s3-test-server.ts), keeping its objects on disk, which
 *          checks every request's signature and every PUT's payload hash.
 *
 * The same cases with each store:
 *   (1) a stream of more than 2 GiB, cut into 8 MiB parts as a writer does, is kept chunk by chunk through the chunk door
 *       and reads back, chunk after chunk, with the sha256 of what was sent;
 *   (2) the files directory's `tmp/` never holds more than one chunk while it is written, so never the whole object, and
 *       is empty afterwards;
 *   (3) appending adds chunks and leaves the earlier ones as they were: their rows unchanged, nothing stored again, and
 *       on the local store the very same files;
 *   (4) a ranged read answers any byte range of a chunk, across a chunk boundary as two ranged reads, and refuses a range
 *       that starts past a chunk's end;
 *   (5) a chunk re-sent for an index replaces it; one too large, one whose sha256 is not the declared one, one for another
 *       account's staging and one for a committed staging are refused, and leave no row, no blob and no temporary file;
 *   (6) the retention sweep holds drive content: a staging chunk holds its bytes while its staging lives, an idle staging
 *       goes after seven days and its bytes one grace period later, a version chunk holds its bytes however old, and
 *       bytes a drive row names again lose their release mark.
 *
 * Not destructive: every row belongs to users this run creates, and each store gets bytes of its own.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { FileRetentionSweep } from '../files/file-retention-sweep';
import { fileGraceMs } from '../files/file-retention';
import { LocalFileStore, uploadTempDir, type FilesConfig, type FileStore } from '../files/file-store';
import { FilesService } from '../files/files.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { startS3 } from '../test-support/s3-test-server';
import {
  DRIVE_CHUNK_EMPTY,
  DRIVE_CHUNK_MAX,
  DRIVE_CHUNK_SHA256_MISMATCH,
  DRIVE_CHUNK_TOO_LARGE,
  DRIVE_STAGING_NOT_FOUND,
  DriveChunksService,
} from './drive-chunks.service';
import { DriveService } from './drive.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
/** More than 2 GiB, and not a whole number of chunks, so the last chunk is a short one. */
const STREAM_BYTES = 2 * 1024 * MIB + 12_345;
/** The pieces the stream arrives in, as a socket hands a request body on. */
const PIECE = MIB;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * The stream's bytes, piece `j` of it, made again on demand so the spec never holds the stream: a random megabyte with the
 * piece's number and the run written into its head, so that no two pieces, and so no two chunks, are the same content.
 */
function streamOf(seed: Buffer, total: number) {
  const pieceAt = (j: number): Buffer => {
    const piece = Buffer.from(seed.subarray(0, Math.min(PIECE, total - j * PIECE)));
    piece.write(`${RUN}:${j}:`, 0, 'latin1');
    return piece;
  };
  /** The stream itself, a piece at a time. */
  const pieces = function* () {
    for (let j = 0; j * PIECE < total; j += 1) yield pieceAt(j);
  };
  /** Bytes `start` to `end` (both included) of the stream. */
  const slice = (start: number, end: number): Buffer => {
    const parts: Buffer[] = [];
    for (let j = Math.floor(start / PIECE); j * PIECE <= end; j += 1) {
      const piece = pieceAt(j);
      parts.push(piece.subarray(Math.max(0, start - j * PIECE), Math.min(piece.length, end - j * PIECE + 1)));
    }
    return Buffer.concat(parts);
  };
  return { pieces, slice };
}

/**
 * A writer of the drive: cuts `pieces` into parts of DRIVE_CHUNK_MAX bytes and sends each to the chunk door as a stream
 * of its own, from index `firstIdx`. Answers the sha256 of everything it sent and how many parts it sent.
 */
async function writeInParts(
  chunks: DriveChunksService,
  ownerId: string,
  stagingId: string,
  pieces: Iterable<Buffer>,
  firstIdx = 0,
  whole = createHash('sha256'),
): Promise<{ whole: ReturnType<typeof createHash>; parts: number }> {
  let part: Buffer[] = [];
  let partBytes = 0;
  let idx = firstIdx;
  const send = async () => {
    const hash = createHash('sha256');
    for (const piece of part) hash.update(piece);
    const answer = await chunks.putChunk(ownerId, stagingId, idx, hash.digest('hex'), Readable.from(part));
    assert.equal(answer.sizeBytes, partBytes);
    idx += 1;
    part = [];
    partBytes = 0;
  };
  for (const piece of pieces) {
    whole.update(piece);
    for (let at = 0; at < piece.length;) {
      const take = Math.min(DRIVE_CHUNK_MAX - partBytes, piece.length - at);
      part.push(piece.subarray(at, at + take));
      partBytes += take;
      at += take;
      if (partBytes === DRIVE_CHUNK_MAX) await send();
    }
  }
  if (partBytes > 0) await send();
  return { whole, parts: idx - firstIdx };
}

async function readAll(stream: Readable | null): Promise<Buffer> {
  assert.ok(stream, 'the bytes are there');
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

async function refusedWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpException, `an HttpException, not ${String(error)}`);
    assert.equal(error.getStatus(), status);
    assert.equal((error.getResponse() as { code: string }).code, code);
    return true;
  });
}

interface Leg {
  storage: 'local' | 's3';
  config: FilesConfig;
}

function storeCases(leg: Leg) {
  return async (t: TestContext) => {
    const db: PrismaClient = prismaClientFor(URL!);
    t.after(() => db.$disconnect().catch(() => undefined));
    const files = new FilesService(db as never, leg.config);
    const chunks = new DriveChunksService(db as never, files);
    const sweep = new FileRetentionSweep(db as never, files);
    const grace = fileGraceMs(leg.config);
    const store: FileStore = files.storeOf(leg.storage)!;
    const tempDir = uploadTempDir(leg.config.dir);
    const tempBytes = () => {
      let names: string[];
      try {
        names = readdirSync(tempDir);
      } catch {
        return 0;
      }
      let bytes = 0;
      for (const name of names) {
        try {
          bytes += statSync(path.join(tempDir, name)).size;
        } catch {
          // Gone into the store between the listing and the look.
        }
      }
      return bytes;
    };

    // What the temporary directory holds: looked at every few milliseconds, and at the one moment it holds the most,
    // when a chunk has arrived whole and is handed to the store.
    let tempMax = 0;
    let tempLooks = 0;
    const look = () => {
      tempMax = Math.max(tempMax, tempBytes());
      tempLooks += 1;
    };
    const poller = setInterval(look, 5);
    t.after(() => clearInterval(poller));
    const keep = files.store.bind(files);
    files.store = async (temp) => {
      look();
      return keep(temp);
    };
    // What the store is asked to keep, by name.
    const stored: string[] = [];
    const put = store.put.bind(store);
    store.put = async (sha, tempPath, size) => {
      stored.push(sha);
      return put(sha, tempPath, size);
    };

    const accountOf = async (name: string) => {
      const id = randomUUID();
      await db.user.create({ data: { id, email: `${name}-${leg.storage}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
      return id;
    };
    const owner = await accountOf('drive-owner');
    const stranger = await accountOf('drive-stranger');
    const stagingRows = (stagingId: string) => db.driveStagingChunk.findMany({ where: { stagingId }, orderBy: { idx: 'asc' } });
    /** The bytes of a staging, chunk after chunk in index order, hashed as they are read. */
    const readBack = async (stagingId: string) => {
      const hash = createHash('sha256');
      let bytes = 0;
      for (const row of await stagingRows(stagingId)) {
        const blob = await db.fileBlob.findUniqueOrThrow({ where: { sha256: row.sha256 } });
        assert.equal(blob.storage, leg.storage, 'kept where new bytes go');
        assert.equal(blob.sizeBytes, row.sizeBytes);
        const content = await files.storeOf(blob.storage)!.open(row.sha256);
        assert.ok(content, `chunk ${row.idx} is in the store`);
        for await (const part of content) {
          hash.update(part as Buffer);
          bytes += (part as Buffer).length;
        }
      }
      return { sha256: hash.digest('hex'), bytes };
    };

    const seed = randomBytes(PIECE);
    const stream = streamOf(seed, STREAM_BYTES);
    const big = await chunks.openStaging(owner, { source: 'TOOL' });
    const expectedParts = Math.ceil(STREAM_BYTES / DRIVE_CHUNK_MAX);

    await t.test('(1)(2) a stream of more than 2 GiB written in 8 MiB parts reads back with its sha256, and tmp/ never holds more than a chunk', async () => {
      const startedAt = Date.now();
      const { whole, parts } = await writeInParts(chunks, owner, big.id, stream.pieces());
      const sent = whole.digest('hex');
      const wroteMs = Date.now() - startedAt;
      assert.equal(parts, expectedParts);
      const rows = await stagingRows(big.id);
      assert.equal(rows.length, expectedParts);
      assert.deepEqual(rows.map((row) => row.idx), [...Array(expectedParts).keys()]);
      assert.ok(rows.slice(0, -1).every((row) => row.sizeBytes === DRIVE_CHUNK_MAX), 'every chunk but the last is 8 MiB');
      assert.equal(rows.at(-1)!.sizeBytes, STREAM_BYTES % DRIVE_CHUNK_MAX);
      assert.equal(new Set(rows.map((row) => row.sha256)).size, expectedParts, 'every chunk is a content of its own');
      assert.equal(stored.length, expectedParts, 'each chunk was put in the store once');
      const readStartedAt = Date.now();
      const back = await readBack(big.id);
      assert.equal(back.bytes, STREAM_BYTES);
      assert.equal(back.sha256, sent, 'read back chunk after chunk, the stream has the sha256 it was sent with');
      assert.ok(tempLooks > expectedParts, 'the temporary directory was looked at all along');
      assert.ok(tempMax > 0 && tempMax <= DRIVE_CHUNK_MAX, `tmp/ held at most one chunk (${tempMax} bytes)`);
      assert.equal(tempBytes(), 0, 'and nothing once the stream is written');
      t.diagnostic(
        `${leg.storage}: ${STREAM_BYTES} bytes in ${parts} chunks, sha256 ${sent}; written in ${wroteMs} ms, read back in `
          + `${Date.now() - readStartedAt} ms; tmp/ held at most ${tempMax} bytes over ${tempLooks} looks`,
      );
    });

    await t.test('(3) an append adds chunks and leaves every earlier one as it was', async () => {
      const before = await stagingRows(big.id);
      const files0 = leg.storage === 'local'
        ? before.map((row) => statSync((store as LocalFileStore).pathOf(row.sha256), { bigint: true }))
        : [];
      stored.length = 0;
      const appendBytes = DRIVE_CHUNK_MAX + 777;
      const appended = streamOf(randomBytes(PIECE), appendBytes);
      // The whole of what the file is after the append: the stream, then the appended bytes.
      const whole = createHash('sha256');
      for (const piece of stream.pieces()) whole.update(piece);
      const { parts } = await writeInParts(chunks, owner, big.id, appended.pieces(), before.length, whole);
      assert.equal(parts, 2);
      const after = await stagingRows(big.id);
      assert.equal(after.length, before.length + 2);
      assert.deepEqual(after.slice(0, before.length), before, 'the earlier chunk rows are unchanged');
      assert.deepEqual(stored, after.slice(before.length).map((row) => row.sha256), 'only the new chunks were stored');
      if (leg.storage === 'local') {
        after.slice(0, before.length).forEach((row, i) => {
          const now = statSync((store as LocalFileStore).pathOf(row.sha256), { bigint: true });
          assert.equal(now.ino, files0[i].ino, `chunk ${i} is the same file`);
          assert.equal(now.mtimeNs, files0[i].mtimeNs, `chunk ${i} was not written again`);
        });
      }
      const back = await readBack(big.id);
      assert.equal(back.bytes, STREAM_BYTES + appendBytes);
      assert.equal(back.sha256, whole.digest('hex'));
      assert.ok(tempMax <= DRIVE_CHUNK_MAX);
      assert.equal(tempBytes(), 0);
    });

    await t.test('(4) a ranged read answers any range of a chunk, and across a chunk boundary as two', async () => {
      const rows = await stagingRows(big.id);
      const open = (idx: number, start: number, end: number) => store.open(rows[idx].sha256, { start, end });
      for (const [idx, start, end] of [[0, 0, 0], [0, 0, DRIVE_CHUNK_MAX - 1], [1, 4096, 1_000_000], [2, DRIVE_CHUNK_MAX - 1, DRIVE_CHUNK_MAX - 1]]) {
        const got = await readAll(await open(idx, start, end));
        assert.ok(got.equals(stream.slice(idx * DRIVE_CHUNK_MAX + start, idx * DRIVE_CHUNK_MAX + end)), `chunk ${idx} bytes ${start}-${end}`);
      }
      // Bytes 8 MiB - 100 to 8 MiB + 99 of the file: the last 100 of chunk 0 and the first 100 of chunk 1.
      const across = Buffer.concat([
        await readAll(await open(0, DRIVE_CHUNK_MAX - 100, DRIVE_CHUNK_MAX - 1)),
        await readAll(await open(1, 0, 99)),
      ]);
      assert.ok(across.equals(stream.slice(DRIVE_CHUNK_MAX - 100, DRIVE_CHUNK_MAX + 99)));
      // The short last chunk of the stream: a range past its end reads to its end, and one starting past it is refused.
      const last = expectedParts - 1;
      const lastSize = rows[last].sizeBytes;
      const tail = await readAll(await open(last, lastSize - 10, lastSize + 1000));
      assert.ok(tail.equals(stream.slice(STREAM_BYTES - 10, STREAM_BYTES - 1)));
      await assert.rejects(open(last, lastSize, lastSize + 10), RangeError);
    });

    await t.test('(5) a chunk sent again replaces it; a refused one leaves nothing behind', async () => {
      const staging = await chunks.openStaging(owner, { source: 'OWNER_UPLOAD', name: 'a.bin', declaredSize: 20 });
      const first = randomBytes(10);
      const second = randomBytes(20);
      await chunks.putChunk(owner, staging.id, 0, sha256(first), Readable.from([first]));
      await chunks.putChunk(owner, staging.id, 0, sha256(second), Readable.from([second]));
      assert.deepEqual((await stagingRows(staging.id)).map((row) => [row.idx, row.sha256, row.sizeBytes]), [[0, sha256(second), 20]]);

      const blobs = async (bytes: Buffer) => db.fileBlob.count({ where: { sha256: sha256(bytes) } });
      const tooLarge = randomBytes(DRIVE_CHUNK_MAX + 1);
      await refusedWith(
        chunks.putChunk(owner, staging.id, 1, sha256(tooLarge), Readable.from([tooLarge.subarray(0, MIB), tooLarge.subarray(MIB)])),
        413, DRIVE_CHUNK_TOO_LARGE,
      );
      assert.equal(await blobs(tooLarge), 0);
      const sent = randomBytes(1000);
      await refusedWith(chunks.putChunk(owner, staging.id, 1, sha256(randomBytes(1000)), Readable.from([sent])), 400, DRIVE_CHUNK_SHA256_MISMATCH);
      assert.equal(await blobs(sent), 0);
      await refusedWith(chunks.putChunk(owner, staging.id, 1, sha256(Buffer.alloc(0)), Readable.from([])), 400, DRIVE_CHUNK_EMPTY);
      // Another account's staging is not found, whatever its id: nothing is read into tmp/, nothing kept.
      const theirs = randomBytes(1000);
      await refusedWith(chunks.putChunk(stranger, staging.id, 1, sha256(theirs), Readable.from([theirs])), 404, DRIVE_STAGING_NOT_FOUND);
      await refusedWith(chunks.putChunk(owner, randomUUID(), 1, sha256(theirs), Readable.from([theirs])), 404, DRIVE_STAGING_NOT_FOUND);
      assert.equal(await blobs(theirs), 0);
      await db.driveStaging.update({ where: { id: staging.id }, data: { committedAt: new Date() } });
      await refusedWith(chunks.putChunk(owner, staging.id, 1, sha256(theirs), Readable.from([theirs])), 404, DRIVE_STAGING_NOT_FOUND);
      assert.equal(await blobs(theirs), 0);
      assert.deepEqual((await stagingRows(staging.id)).map((row) => row.idx), [0], 'no refused chunk left a row');
      assert.equal(tempBytes(), 0, 'nor a temporary file');
    });

    await t.test('(6) the retention sweep holds drive content as held', async () => {
      const now = new Date();
      const at = (ms: number) => new Date(now.getTime() + ms);
      const blobOf = (sha: string) => db.fileBlob.findUniqueOrThrow({ where: { sha256: sha } });

      // A staging chunk holds its bytes while its staging lives.
      const staging = await chunks.openStaging(owner, { source: 'MOUNT', runnerId: randomUUID(), generation: 3 });
      const held = randomBytes(5000);
      await chunks.putChunk(owner, staging.id, 0, sha256(held), Readable.from([held]));
      // A version chunk holds its bytes however old (drive content never expires).
      const versioned = randomBytes(5000);
      const versionStaging = await chunks.openStaging(owner, { source: 'TOOL' });
      await chunks.putChunk(owner, versionStaging.id, 0, sha256(versioned), Readable.from([versioned]));
      // A file's version for the chunk row to belong to (its foreign key, migration 1327).
      const versionId = (await new DriveService(db as never).createFile(owner, { name: `held-${leg.storage}-${RUN}.bin` })).currentVersionId!;
      await db.driveVersionChunk.create({
        data: { versionId, idx: 0, ownerId: owner, offset: 0n, sizeBytes: versioned.length, sha256: sha256(versioned) },
      });
      // The big stream's staging, committed: its chunks are named by nothing else once its rows go.
      const bigRows = await stagingRows(big.id);

      let done = await sweep.sweep(at(3 * DAY));
      assert.equal((await blobOf(sha256(held))).releasedAt, null, 'held by its staging');
      assert.equal(await db.driveStaging.count({ where: { id: staging.id } }), 1, 'touched three days ago, the staging stays');

      // Eight days untouched: step 0 removes the stagings (the big one too), and step 3 releases what only they held.
      done = await sweep.sweep(at(8 * DAY));
      assert.ok(done.stagingsRemoved >= 3, `removed ${done.stagingsRemoved}`);
      assert.equal(await db.driveStaging.count({ where: { id: { in: [staging.id, versionStaging.id, big.id] } } }), 0);
      assert.deepEqual((await blobOf(sha256(held))).releasedAt, at(8 * DAY));
      assert.equal((await blobOf(sha256(versioned))).releasedAt, null, 'held by its version chunk');
      assert.deepEqual((await blobOf(bigRows[0].sha256)).releasedAt, at(8 * DAY));
      assert.equal(await store.has(sha256(held)), true, 'released bytes stay for the grace period');

      // Named again by a new staging: the release mark goes.
      const again = await chunks.openStaging(owner, { source: 'TOOL' });
      await chunks.putChunk(owner, again.id, 0, sha256(held), Readable.from([held]));
      // Touched as of the spec's clock, or step 0 would find it idle and remove it first.
      await db.driveStaging.update({ where: { id: again.id }, data: { touchedAt: at(8 * DAY) } });
      await sweep.sweep(at(8 * DAY + 1000));
      assert.equal((await blobOf(sha256(held))).releasedAt, null, 'held again');
      await db.driveStaging.delete({ where: { id: again.id } });
      await sweep.sweep(at(8 * DAY + 2000));
      assert.deepEqual((await blobOf(sha256(held))).releasedAt, at(8 * DAY + 2000));

      // A grace period later the bytes nothing holds go; the version's stay.
      done = await sweep.sweep(at(8 * DAY + 2000 + grace + 1000));
      assert.ok(done.deleted >= bigRows.length + 1, `deleted ${done.deleted}`);
      assert.notEqual((await blobOf(sha256(held))).bytesDeletedAt, null);
      assert.equal(await store.has(sha256(held)), false);
      assert.equal(await store.has(bigRows[0].sha256), false, 'the stream\'s chunks went too');
      assert.equal((await blobOf(sha256(versioned))).bytesDeletedAt, null);
      assert.equal(await store.has(sha256(versioned)), true, 'a version chunk holds its bytes past any grace period');
      await sweep.sweep(at(400 * DAY));
      assert.equal(await store.has(sha256(versioned)), true, 'a year on, too');

      // Deleted for good, the version chunk row lets them go a grace period later.
      await db.driveVersionChunk.deleteMany({ where: { versionId } });
      await sweep.sweep(at(401 * DAY));
      await sweep.sweep(at(401 * DAY + grace + 1000));
      assert.equal(await store.has(sha256(versioned)), false);
    });
  };
}

test('Documents drive: the chunked streamed store, on the local files directory and on an S3-compatible server', {
  skip: !URL, concurrency: 1, timeout: 3_600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }
  const localDir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-local-'));
  const s3Dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-s3-'));
  const s3Data = mkdtempSync(path.join(tmpdir(), 'orbit-drive-s3-data-'));
  t.after(() => {
    for (const dir of [localDir, s3Dir, s3Data]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // The S3 server's container writes s3Data as its own root user, which a CI runner's unprivileged user
        // cannot remove (EACCES). The runner is thrown away after the job, so the leftover is not kept.
        if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
      }
    }
  });

  await t.test('local', storeCases({ storage: 'local', config: { dir: localDir, storage: 'local' } }));

  // On disk: the stream is more than the memory a tmpfs could spare.
  const s3 = await startS3((fn) => t.after(fn), s3Data);
  await t.test('s3', storeCases({ storage: 's3', config: { dir: s3Dir, storage: 's3', s3 } }));
});
