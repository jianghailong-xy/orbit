import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileIntegrity } from './file-integrity';
import { FilesService } from './files.service';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-20T00:00:00Z');

interface Blob { sha256: string; storage: string; bytesDeletedAt: Date | null }

/** A bucket in memory that answers ListObjectsV2 (paged by 2), GET and DELETE of an object. */
async function fakeBucket(t: test.TestContext, objects: Map<string, { bytes: Buffer; modified: Date }>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.searchParams.get('list-type') === '2') {
      assert.equal(url.searchParams.get('prefix'), 'files/');
      const keys = [...objects.keys()].sort();
      const from = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(from, from + 2);
      const more = from + 2 < keys.length;
      res.end(
        `<ListBucketResult>${page.map((k) => `<Contents><Key>files/${k.slice(0, 2)}/${k}</Key><LastModified>${objects.get(k)!.modified.toISOString()}</LastModified><Size>${objects.get(k)!.bytes.length}</Size></Contents>`).join('')}`
          + `<Contents><Key>files/notes.txt</Key><Size>1</Size></Contents>`
          + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
      return;
    }
    const key = url.pathname.split('/').pop()!;
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    const found = objects.get(key);
    if (!found) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(found.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function setup(blobs: Blob[], endpoint: string, dir: string) {
  const prisma = {
    fileBlob: {
      findMany: async (args: { where: { sha256: { in?: string[]; gt?: string } }; take?: number }) => {
        const w = args.where.sha256;
        const rows = blobs.filter((b) => (w.in ? w.in.includes(b.sha256) : true) && (w.gt !== undefined ? b.sha256 > w.gt : true) && (args.where as { bytesDeletedAt?: null }).bytesDeletedAt === undefined || b.bytesDeletedAt === null && (w.gt !== undefined ? b.sha256 > w.gt : true));
        return rows.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)).slice(0, args.take ?? 1e9);
      },
      findUnique: async ({ where }: { where: { sha256: string } }) => blobs.find((b) => b.sha256 === where.sha256) ?? null,
    },
    driveVersionChunk: { findMany: async () => [{ versionId: 'v1' }] },
    attachment: { count: async () => 0 },
  };
  const files = new FilesService(prisma as never, {
    dir,
    storage: 'local',
    s3: { endpoint, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' },
  });
  return new FileIntegrity(prisma as never, files);
}

test('files orphans lists an object no row names only after the grace period, on both stores, and deletes nothing in report mode', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-orphans-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, ageDays: number) => {
    const bytes = Buffer.from(name);
    const id = sha(bytes);
    mkdirSync(path.join(dir, id.slice(0, 2)), { recursive: true });
    const file = path.join(dir, id.slice(0, 2), id);
    writeFileSync(file, bytes);
    const at = new Date(NOW.getTime() - ageDays * DAY);
    utimesSync(file, at, at);
    return { id, file, bytes, modified: at };
  };
  const oldOrphan = put('old orphan', 10);
  const youngOrphan = put('young orphan', 1);
  const named = put('named', 30);
  writeFileSync(path.join(dir, 'stray.txt'), 'not a content');
  const bucket = new Map<string, { bytes: Buffer; modified: Date }>();
  const s3 = (name: string, ageDays: number) => {
    const bytes = Buffer.from(`s3 ${name}`);
    bucket.set(sha(bytes), { bytes, modified: new Date(NOW.getTime() - ageDays * DAY) });
    return sha(bytes);
  };
  const s3Old = s3('old orphan', 10);
  const s3Young = s3('young orphan', 2);
  const s3Named = s3('named', 40);
  const s3Old2 = s3('old orphan two', 9);
  const endpoint = await fakeBucket(t, bucket);
  const integrity = setup(
    [{ sha256: named.id, storage: 'local', bytesDeletedAt: null }, { sha256: s3Named, storage: 's3', bytesDeletedAt: null }],
    endpoint,
    dir,
  );

  const report = await integrity.orphans({ now: NOW });
  const local = report.find((r) => r.storage === 'local')!;
  const remote = report.find((r) => r.storage === 's3')!;
  assert.deepEqual([local.scanned, local.orphans, local.withinGrace, local.removed], [3, 1, 1, 0]);
  assert.deepEqual(local.sample, [oldOrphan.id]);
  assert.equal(local.orphanBytes, oldOrphan.bytes.length);
  assert.deepEqual([remote.scanned, remote.orphans, remote.withinGrace, remote.removed], [4, 2, 1, 0], 'paged listing, and the foreign key skipped');
  assert.deepEqual(new Set(remote.sample), new Set([s3Old, s3Old2]));
  assert.ok(existsSync(oldOrphan.file) && existsSync(youngOrphan.file) && bucket.has(s3Old) && bucket.has(s3Young), 'report mode deletes nothing');

  // The scrub is report mode.
  assert.equal((await integrity.scrub(NOW)).reduce((n, r) => n + r.removed, 0), 0);
  assert.ok(existsSync(oldOrphan.file) && bucket.has(s3Old));

  const deleted = await integrity.orphans({ now: NOW, remove: true });
  assert.deepEqual(deleted.map((r) => r.removed), [1, 2]);
  assert.ok(!existsSync(oldOrphan.file) && !bucket.has(s3Old) && !bucket.has(s3Old2));
  assert.ok(existsSync(youngOrphan.file) && existsSync(named.file) && bucket.has(s3Young) && bucket.has(s3Named), 'only old orphans go');
});

test('the scrub is report-only whatever it finds', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-scrub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('lonely');
  const id = sha(bytes);
  mkdirSync(path.join(dir, id.slice(0, 2)), { recursive: true });
  const file = path.join(dir, id.slice(0, 2), id);
  writeFileSync(file, bytes);
  const old = new Date(NOW.getTime() - 100 * DAY);
  utimesSync(file, old, old);
  const bucket = new Map<string, { bytes: Buffer; modified: Date }>();
  const integrity = setup([], await fakeBucket(t, bucket), dir);
  const [local] = await integrity.scrub(NOW);
  assert.equal(local!.orphans, 1);
  assert.equal(local!.removed, 0);
  assert.ok(existsSync(file));
});

test('files verify flags a missing blob and a chunk whose bytes do not match its sha256, on both stores', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = Buffer.from('good chunk');
  const goodId = sha(good);
  const corrupt = Buffer.from('corrupt chunk');
  const corruptId = sha(corrupt);
  const put = (id: string, bytes: Buffer) => {
    mkdirSync(path.join(dir, id.slice(0, 2)), { recursive: true });
    writeFileSync(path.join(dir, id.slice(0, 2), id), bytes);
  };
  put(goodId, good);
  put(corruptId, Buffer.from('flipped bytes!'));
  const lostId = sha(Buffer.from('lost'));
  const s3Good = Buffer.from('s3 good');
  const s3Bad = Buffer.from('s3 bad');
  const bucket = new Map([
    [sha(s3Good), { bytes: s3Good, modified: NOW }],
    [sha(s3Bad), { bytes: Buffer.from('s3 BAD'), modified: NOW }],
  ]);
  const gone = sha(Buffer.from('already deleted'));
  const integrity = setup(
    [
      { sha256: goodId, storage: 'local', bytesDeletedAt: null },
      { sha256: corruptId, storage: 'local', bytesDeletedAt: null },
      { sha256: lostId, storage: 'local', bytesDeletedAt: null },
      { sha256: sha(s3Good), storage: 's3', bytesDeletedAt: null },
      { sha256: sha(s3Bad), storage: 's3', bytesDeletedAt: null },
      { sha256: gone, storage: 'local', bytesDeletedAt: NOW },
    ],
    await fakeBucket(t, bucket),
    dir,
  );
  const report = await integrity.verify();
  assert.equal(report.checked, 5, 'a blob whose bytes the sweep deleted is not expected');
  assert.deepEqual(
    report.problems.map((p) => [p.sha256, p.problem, p.driveVersions]).sort(),
    [[corruptId, 'mismatch', 1], [lostId, 'missing', 1], [sha(s3Bad), 'mismatch', 1]].sort(),
  );
  const quick = await integrity.verify({ deep: false });
  assert.deepEqual(quick.problems.map((p) => p.problem), ['missing'], 'without reading back, only absence shows');
});
