/**
 * One-file share links (docs/drive-technical-design.md §9), without a database: the owner shares a file and a
 * planted key warns without blocking, the scan reads what a share is pinned to, only the owner's controller makes a link,
 * and a client that does not ask for the new kind still lists its links. The rows themselves are held by
 * share-links-drive-file.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { PAT_FORBIDDEN } from '../auth/pat-scope.decorator';
import { DriveContentService, SHARE_CHECK_MAX_BYTES } from '../drive/drive-content.service';
import { issued } from '../files/file-secret-samples.spec';
import { SHARE_ROOT_KINDS } from './share-link';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

// These specs share drive files, which Drive must be on for (drive/drive-switch.ts).
process.env.ORBIT_DRIVE_ENABLED = 'true';

/** A drive version of `parts`, one chunk each, in a fake store. */
function contentOf(parts: Buffer[]) {
  let offset = 0;
  const chunks = parts.map((bytes, idx) => {
    const chunk = { idx, offset: BigInt(offset), sizeBytes: bytes.length, sha256: `sha-${idx}` };
    offset += bytes.length;
    return chunk;
  });
  const prisma = {
    driveVersion: { findFirst: async () => ({ sizeBytes: BigInt(offset) }) },
    driveVersionChunk: { findMany: async () => chunks },
    fileBlob: { findUnique: async () => ({ storage: 'local' }) },
  };
  const files = {
    storeOf: () => ({
      open: async (sha: string, range?: { start: number; end: number }) => {
        const bytes = parts[Number(sha.slice(4))];
        return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
      },
    }),
  };
  return new DriveContentService(prisma as never, files as never);
}

const KEY = issued('ghp_', 36);

test('the share check names the shape and the line of a planted key, never the key', async () => {
  const check = await contentOf([Buffer.from(`one\ntwo\nTOKEN=${KEY}\n`)]).shareCheck('owner', 'version');
  assert.equal(check.warnings.length, 1);
  assert.equal(check.warnings[0].line, 3);
  assert.ok(check.warnings[0].kind.length > 0);
  assert.ok(!JSON.stringify(check).includes(KEY));
  assert.equal(check.partial, false);
});

test('the share check finds a key that spans two chunks, and answers nothing for a clean or a binary file', async () => {
  const text = `${'x'.repeat(100)}\nTOKEN=${KEY}\n`;
  const cut = text.indexOf(KEY) + 10;
  const split = await contentOf([Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))]).shareCheck('o', 'v');
  assert.equal(split.warnings.length, 1);
  assert.deepEqual((await contentOf([Buffer.from('nothing here\n')]).shareCheck('o', 'v')).warnings, []);
  const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY)]);
  assert.deepEqual((await contentOf([binary]).shareCheck('o', 'v')).warnings, []);
});

test('the share check reads the first 25 MiB only and says the rest was not checked', async () => {
  const filler = Buffer.alloc(8 * 1024 * 1024, 'a');
  const parts = [filler, filler, filler, filler, Buffer.from(`${KEY}\n`)];
  const check = await contentOf(parts).shareCheck('o', 'v');
  assert.deepEqual(check.warnings, []);
  assert.equal(check.checkedBytes, SHARE_CHECK_MAX_BYTES);
  assert.equal(check.partial, true);
});

test('sharing a file with a planted key still creates the link, and returns the warning', async () => {
  const calls: string[] = [];
  const link = { id: 'link', kind: 'DRIVE_FILE' };
  const controller = new ShareLinksController(
    { putDriveFile: async (...args: unknown[]) => (calls.push(`put ${args[1]} ${args[2]}`), link) } as never,
    { shareableVersion: async () => ({ id: 'v1', sizeBytes: 40 }) } as never,
    contentOf([Buffer.from(`TOKEN=${KEY}\n`)]) as never,
  );
  const answer = await controller.shareDriveFile({ userId: 'owner' } as never, { kind: 'DRIVE_FILE', driveEntryId: 'entry' });
  assert.deepEqual(calls, ['put entry v1']);
  assert.equal(answer.link, link);
  assert.equal(answer.warnings.length, 1);
  assert.equal(answer.warnings[0].line, 1);
});

test('GET /share-links without kind never asks for DRIVE_FILE; naming it does', async () => {
  const wheres: unknown[] = [];
  const prisma = { shareLink: { findMany: async (args: { where: unknown }) => (wheres.push(args.where), []) } };
  const service = new ShareLinksService(prisma as never);
  await service.list('owner');
  await service.list('owner', ['DRIVE_FILE', 'NOT_A_KIND']);
  const columns = (where: unknown) => (where as { OR: Record<string, unknown>[] }).OR.map((clause) => Object.keys(clause)[0]);
  assert.deepEqual(columns(wheres[0]), ['sessionId', 'taskId', 'projectId']);
  assert.deepEqual(columns(wheres[1]), ['driveEntryId']);
  assert.ok(SHARE_ROOT_KINDS.includes('DRIVE_FILE'));
});

test('the generic PUT door refuses a drive file', async () => {
  await assert.rejects(new ShareLinksService({} as never).put('owner', 'DRIVE_FILE', 'entry', {}), /POST \/share-links/);
});

test('only the owner\'s controller makes a link: tokens refused, and no runner route or tool reaches the service', () => {
  assert.equal(Reflect.getMetadata(PAT_FORBIDDEN, ShareLinksController), 'SHARE_LINK');
  // Compiled to build/<dir>/, or run from src/<dir>/: either way, the sources are in src/apiserver/src.
  const apiserver = __dirname.includes(`${path.sep}build${path.sep}`) ? __dirname.split(`${path.sep}build${path.sep}`)[0] : path.resolve(__dirname, '../..');
  const src = path.join(apiserver, 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const callers = walk(src)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts') && !file.includes(`${path.sep}test-support${path.sep}`) && !file.endsWith('db-write-inventory.ts'))
    .filter((file) => /putDriveFile|ShareDriveFileDto/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(src, file))
    .sort();
  assert.deepEqual(callers, ['share-links/dto.ts', 'share-links/share-links.controller.ts', 'share-links/share-links.service.ts']);
  const root = path.resolve(apiserver, '../..');
  const runnerGo = walk(path.join(root, 'src/runner-go')).filter((file) => file.endsWith('.go') && !file.endsWith('_test.go'));
  for (const file of [...runnerGo, path.join(root, 'docs/operation-catalog.md')]) {
    assert.ok(!/share-links|DRIVE_FILE/.test(readFileSync(file, 'utf8')), `${path.relative(root, file)} must not reach share links`);
  }
});
