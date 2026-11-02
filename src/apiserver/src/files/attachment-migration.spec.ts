import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';

import { AttachmentCopyAtBoot } from './attachment-copy-at-boot';
import { AttachmentMigration, type ClearRefusal } from './attachment-migration';
import type { FilesConfig } from './file-store';
import { FilesService } from './files.service';

// What the merge check holds of attachment-migration.ts, which does not run pg specs: when a start copies, and that the
// clear never writes a row the store has not vouched for. The rest is attachment-migration.pg.spec.ts's, on real stores.

const quiet = { log: () => undefined, warn: () => undefined };

test('a start with no row waiting starts no copy', async () => {
  let walked = 0;
  const prisma = {
    attachment: {
      findFirst: async () => null,
      findMany: async () => {
        walked += 1;
        return [];
      },
    },
  };
  const boot = new AttachmentCopyAtBoot(prisma as never, {} as never);
  await boot.onApplicationBootstrap();
  await boot.onModuleDestroy();
  assert.equal(walked, 0);
});

test('a start does not wait for the copy, and a copy that cannot start does not stop it', async () => {
  let release = (_rows: never[]) => undefined as void;
  let walked = 0;
  const prisma = {
    attachment: {
      findFirst: async () => ({ id: 'waiting' }),
      findMany: () => {
        walked += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      aggregate: async () => ({ _count: { _all: 0 }, _sum: { sizeBytes: null } }),
    },
  };
  const files = { config: { storage: 's3' } };
  const boot = new AttachmentCopyAtBoot(prisma as never, files as never);
  await boot.onApplicationBootstrap();
  await sleep(0);
  assert.equal(walked, 1, 'the copy has started, and the hook has returned with its first read still unanswered');
  release([]);
  await boot.onModuleDestroy();

  const refusing = { attachment: { findFirst: async () => { throw new Error('the database is away'); } } };
  await new AttachmentCopyAtBoot(refusing as never, files as never).onApplicationBootstrap();
});

/** The clear, over `rows` and a store that answers `readBack` for them; says what happened, in order. */
function clearing(
  rows: { id: string; sha256: string }[],
  readBack: (sha256: string) => Promise<{ sha256: string; sizeBytes: number } | null>,
  written: (id: string) => { cleared: number; stillThere: number } = () => ({ cleared: 1, stillThere: 0 }),
  freeBytes = async () => Number.MAX_SAFE_INTEGER,
) {
  const events: string[] = [];
  let id = '';
  let last: { cleared: number; stillThere: number } = { cleared: 0, stillThere: 0 };
  let pages = 0;
  const prisma = {
    attachment: {
      findMany: async () => {
        pages += 1;
        return pages > 1 ? [] : rows.map((row) => ({ ...row, sizeBytes: 5, blob: { storage: 'local', sizeBytes: 5 } }));
      },
      count: async () => last.stillThere,
    },
    // The row is told by the order: the store is read for one row, and only then may its row be written.
    $executeRaw: async () => {
      events.push(`write ${id}`);
      last = written(id);
      return last.cleared;
    },
  };
  const files = {
    freeBytes,
    readBack: async ({ sha256 }: { sha256: string }) => {
      id = rows.find((row) => row.sha256 === sha256)!.id;
      events.push(`read ${id}`);
      return readBack(sha256);
    },
  };
  const migration = new AttachmentMigration(prisma as never, files as never, quiet);
  const refused: ClearRefusal[] = [];
  return { events, refused, run: () => migration.clear((row) => refused.push(row)) };
}

test('the clear writes a row only after the store has given its bytes back whole', async () => {
  const { events, refused, run } = clearing([{ id: 'a', sha256: 'aa' }, { id: 'b', sha256: 'bb' }], async (sha256) => ({ sha256, sizeBytes: 5 }));
  assert.deepEqual(await run(), { cleared: { rows: 2, bytes: 10 }, refused: 0 });
  assert.deepEqual(events, ['read a', 'write a', 'read b', 'write b']);
  assert.deepEqual(refused, []);
});

for (const [what, readBack, reason] of [
  ['it does not hold the bytes', async () => null, 'the local file store does not hold these bytes'],
  ['they hash to something else', async () => ({ sha256: 'cc', sizeBytes: 5 }), 'the local file store holds other bytes under this name: 5 bytes, sha256 cc'],
  ['they are another length', async () => ({ sha256: 'aa', sizeBytes: 4 }), 'the local file store holds other bytes under this name: 4 bytes, sha256 aa'],
  ['it cannot be read', async () => { throw new Error('EIO'); }, 'the local file store could not be read: EIO'],
] as const) {
  test(`the clear leaves a row and reports it when ${what}`, async () => {
    const { events, refused, run } = clearing([{ id: 'a', sha256: 'aa' }], readBack);
    assert.deepEqual(await run(), { cleared: { rows: 0, bytes: 0 }, refused: 1 });
    assert.deepEqual(events, ['read a'], 'the row is not written');
    assert.deepEqual(refused, [{ id: 'a', sha256: 'aa', reason }]);
  });
}

test('a row whose data is not its bytes is reported, and one that went meanwhile is not', async () => {
  const rows = [{ id: 'differs', sha256: 'aa' }, { id: 'gone', sha256: 'bb' }];
  const { refused, run } = clearing(
    rows,
    async (sha256) => ({ sha256, sizeBytes: 5 }),
    (id) => ({ cleared: 0, stillThere: id === 'differs' ? 1 : 0 }),
  );
  assert.deepEqual(await run(), { cleared: { rows: 0, bytes: 0 }, refused: 1 });
  assert.deepEqual(refused, [{ id: 'differs', sha256: 'aa', reason: 'its data in Postgres does not hash to this sha256' }]);
});

test('the clear stops, keeping what it has done, when the disk is short of room, whichever store holds the bytes', async () => {
  let free = 3 * 1024 * 1024 * 1024;
  const rows = [{ id: 'a', sha256: 'aa' }, { id: 'b', sha256: 'bb' }];
  const { events, refused, run } = clearing(
    rows,
    async (sha256) => ({ sha256, sizeBytes: 5 }),
    () => {
      // What the WAL of the row just cleared takes.
      free = 1024;
      return { cleared: 1, stillThere: 0 };
    },
    async () => free,
  );
  assert.deepEqual(await run(), {
    cleared: { rows: 1, bytes: 5 },
    refused: 0,
    stopped: 'the disk under the files directory has 1024 bytes free, and this leaves it 2147483648',
  });
  assert.deepEqual(events, ['read a', 'write a'], 'the next row is not touched');
  assert.deepEqual(refused, []);
});

test('a copied row is read from Postgres while its store fails, and only then does the failure stand', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-store-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s3 = { endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' };
  const opened = (data: Uint8Array | null) => new FilesService({
    attachment: {
      findFirst: async () => ({ id: 'a', mimeType: 'image/png', fileName: null, sha256: 'aa', blob: { storage: 's3', sizeBytes: 5 } }),
      findUnique: async () => ({ data, sha256: 'aa' }),
    },
  } as never, { dir, storage: 's3', s3 }).open({ id: 'a' });
  const bytes = Buffer.from('bytes');
  assert.deepEqual(await opened(bytes), { content: bytes, mimeType: 'image/png', fileName: null, sizeBytes: 5 });
  await assert.rejects(opened(null), /ECONNREFUSED|connect/, 'with nothing else to serve, the store\'s own failure');
});

test('a copied row answered from Postgres says which row, which store and what went wrong, at most once a minute for each store', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (line: string) => {
    warnings.push(line);
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-store-fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Real failures: a bucket nothing listens at, and a file where the local store needs the directory `fa`.
  const s3 = { endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' };
  writeFileSync(path.join(dir, 'fa'), '');
  const bytes = Buffer.from('bytes');
  mkdirSync(path.join(dir, 'he'));
  writeFileSync(path.join(dir, 'he', 'held'), bytes);
  const copied = (storage: string, sha256: string) => ({ sha256, blob: { storage, sizeBytes: bytes.length } });
  const rows: Record<string, { sha256: string | null; blob: { storage: string; sizeBytes: number } | null }> = {
    bucket: copied('s3', 'aa'),
    failing: copied('local', 'failing'),
    lost: copied('local', 'lost'),
    held: copied('local', 'held'),
    waiting: { sha256: null, blob: null },
  };
  const files = new FilesService({
    attachment: {
      findFirst: async ({ where: { id } }: { where: { id: string } }) => ({ id, mimeType: 'image/png', fileName: null, ...rows[id] }),
      findUnique: async () => ({ data: bytes, sha256: null }),
    },
  } as never, { dir, storage: 's3', s3 });
  const answeredFromData = async (id: string) => {
    const opened = await files.open({ id });
    assert.deepEqual(opened?.content, bytes, `${id} is answered with its bytes`);
  };

  await answeredFromData('bucket');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^attachment bucket was answered from Postgres: the s3 file store could not be read: .*(ECONNREFUSED|connect)/);

  await answeredFromData('bucket');
  await answeredFromData('bucket');
  assert.equal(warnings.length, 1, 'the same store, within the minute, says nothing more');

  await answeredFromData('failing');
  assert.equal(warnings.length, 2, 'another store has a limit of its own');
  assert.match(warnings[1], /^attachment failing was answered from Postgres: the local file store could not be read: ENOTDIR/);

  t.mock.timers.tick(59_999);
  await answeredFromData('bucket');
  assert.equal(warnings.length, 2, 'not until the minute is up');

  t.mock.timers.tick(1);
  await answeredFromData('bucket');
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /^attachment bucket was answered from Postgres: the s3 file store could not be read: .* 3 more reads went the same way since the last warning\.$/);

  await answeredFromData('lost');
  assert.equal(warnings.length, 4, 'a store that has lost the bytes counts too');
  assert.equal(warnings[3], 'attachment lost was answered from Postgres: the local file store does not hold these bytes.');

  const told = warnings.length;
  await answeredFromData('waiting');
  const held = await files.open({ id: 'held' });
  assert.ok(held && !Buffer.isBuffer(held.content), 'a store that gives up the bytes is what answers');
  (held.content as Readable).destroy();
  t.mock.timers.tick(60_000);
  await answeredFromData('waiting');
  const heldAgain = await files.open({ id: 'held' });
  (heldAgain!.content as Readable).destroy();
  assert.equal(warnings.length, told, 'neither a row the copy has not reached nor a store that works has anything to warn of');
});

test('a fallback is told the same way for a bucket that answers 500 or 404, and for a blob naming a store this deployment lacks', async (t) => {
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (line: string) => {
    warnings.push(line);
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-store-fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let answer = 500;
  const bucket = http.createServer((_request, response) => {
    response.statusCode = answer;
    response.end(answer === 500 ? '<Error><Code>InternalError</Code></Error>' : '');
  });
  await once(bucket.listen(0, '127.0.0.1'), 'listening');
  t.after(() => {
    bucket.closeAllConnections();
    bucket.close();
  });
  const s3 = { endpoint: `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' };
  const bytes = Buffer.from('bytes');
  // A service of its own each time, so that each has its own minute.
  const answeredFromData = async (config: FilesConfig) => {
    const opened = await new FilesService({
      attachment: {
        findFirst: async () => ({ id: 'a', mimeType: 'image/png', fileName: null, sha256: 'aa', blob: { storage: 's3', sizeBytes: 5 } }),
        findUnique: async () => ({ data: bytes, sha256: 'aa' }),
      },
    } as never, config).open({ id: 'a' });
    assert.deepEqual(opened?.content, bytes);
  };

  await answeredFromData({ dir, storage: 's3', s3 });
  answer = 404;
  await answeredFromData({ dir, storage: 's3', s3 });
  await answeredFromData({ dir, storage: 'local' });
  assert.deepEqual(warnings, [
    'attachment a was answered from Postgres: the s3 file store could not be read: S3 GET files/aa/aa answered 500 InternalError.',
    'attachment a was answered from Postgres: the s3 file store does not hold these bytes.',
    'attachment a was answered from Postgres: the s3 file store does not hold these bytes.',
  ]);
});

test('readBack reads the bytes a store holds, and finds none it cannot reach', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-read-back-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = new FilesService({} as never, { dir, storage: 'local' });
  const bytes = Buffer.from('the bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await files.readBack({ sha256, storage: 'local' }), null, 'nothing there yet');
  const temp = path.join(dir, 'temp');
  writeFileSync(temp, bytes);
  const prisma = { fileBlob: { findUnique: async () => null, upsert: async () => undefined } };
  await new FilesService(prisma as never, { dir, storage: 'local' }).store({ path: temp, size: bytes.length, sha256 });
  assert.deepEqual(await files.readBack({ sha256, storage: 'local' }), { sha256, sizeBytes: bytes.length });
  assert.equal(await files.readBack({ sha256, storage: 's3' }), null, 'a store this deployment does not have holds nothing');
});

test('the room left is read off the disk under the files directory, which need not exist yet', async (t) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-free-')), 'not-made-yet');
  t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.ok((await new FilesService({} as never, { dir, storage: 'local' }).freeBytes()) > 0);
});
