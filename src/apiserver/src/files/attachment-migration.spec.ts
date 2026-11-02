import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { AttachmentCopyAtBoot } from './attachment-copy-at-boot';
import { AttachmentMigration, type ClearRefusal } from './attachment-migration';
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
