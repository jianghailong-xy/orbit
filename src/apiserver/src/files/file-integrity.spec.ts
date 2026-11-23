import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '@nestjs/common';
import { FileIntegrity, scrubSlotAtOrBefore } from './file-integrity';
import { sigV4Authorization } from './s3-file-store';
import { FilesService } from './files.service';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-20T00:00:00Z');

interface Blob { sha256: string; storage: string; bytesDeletedAt: Date | null }

/** A bucket in memory that answers ListObjectsV2 (paged by 2), GET and DELETE of an object. */
let listedWithToken = 0;

async function fakeBucket(t: test.TestContext, objects: Map<string, { bytes: Buffer; modified: Date }>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    // Every request must carry the signature AWS would compute for it, query string included.
    const auth = req.headers.authorization ?? '';
    const signedNames = /SignedHeaders=([^,]*)/.exec(auth)?.[1]?.split(';') ?? [];
    const expected = sigV4Authorization(
      {
        method: req.method!,
        path: url.pathname,
        query: url.search.slice(1),
        headers: Object.fromEntries(signedNames.map((n) => [n, String(req.headers[n])])),
        payloadSha256: String(req.headers['x-amz-content-sha256']),
      },
      { accessKeyId: 'a', secretAccessKey: 's', region: 'r', service: 's3' },
      String(req.headers['x-amz-date']),
    );
    if (expected !== auth) {
      res.statusCode = 403;
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    if (url.searchParams.get('list-type') === '2') {
      assert.equal(url.searchParams.get('prefix'), 'files/');
      const keys = [...objects.keys()].sort();
      const from = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(from, from + 2);
      const more = from + 2 < keys.length;
      if (from > 0) listedWithToken += 1;
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

function setup(blobs: Blob[], endpoint: string, dir: string, driveChunks: ReadonlyMap<string, string> = new Map()) {
  const prisma = {
    fileBlob: {
      findMany: async ({ where, take }: { where: { sha256: { in?: string[]; gt?: string }; bytesDeletedAt?: null }; take?: number }) => {
        const { in: hashes, gt: after } = where.sha256;
        const rows = blobs.filter((b) =>
          (hashes === undefined || hashes.includes(b.sha256))
          && (after === undefined || b.sha256 > after)
          && (where.bytesDeletedAt === undefined || b.bytesDeletedAt === where.bytesDeletedAt),
        );
        return rows.sort((a, b) => a.sha256.localeCompare(b.sha256)).slice(0, take ?? rows.length);
      },
      findUnique: async ({ where }: { where: { sha256: string } }) => blobs.find((b) => b.sha256 === where.sha256) ?? null,
    },
    driveVersionChunk: {
      findMany: async ({ where }: { where: { sha256: string } }) => {
        const versionId = driveChunks.get(where.sha256);
        return versionId === undefined ? [] : [{ versionId }];
      },
    },
    attachment: { count: async () => 0 },
  };
  const files = new FilesService(prisma as never, {
    dir,
    storage: 'local',
    s3: { endpoint, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'r' },
  });
  return new FileIntegrity(prisma as never, files);
}

test('files orphans finds unreferenced drive bytes after grace and protects drive-only references on local and S3', async (t) => {
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
  const oldOrphan = put('old uncommitted drive chunk', 10);
  const youngOrphan = put('young orphan', 1);
  const named = put('committed drive chunk', 30);
  writeFileSync(path.join(dir, 'stray.txt'), 'not a content');
  const bucket = new Map<string, { bytes: Buffer; modified: Date }>();
  const s3 = (name: string, ageDays: number) => {
    const bytes = Buffer.from(`s3 ${name}`);
    bucket.set(sha(bytes), { bytes, modified: new Date(NOW.getTime() - ageDays * DAY) });
    return sha(bytes);
  };
  const s3Old = s3('old uncommitted drive chunk', 10);
  const s3Young = s3('young orphan', 2);
  const s3Named = s3('committed drive chunk', 40);
  const s3Old2 = s3('old orphan two', 9);
  const endpoint = await fakeBucket(t, bucket);
  const integrity = setup(
    [{ sha256: named.id, storage: 'local', bytesDeletedAt: null }, { sha256: s3Named, storage: 's3', bytesDeletedAt: null }],
    endpoint,
    dir,
    new Map([[named.id, 'local-version'], [s3Named, 's3-version']]),
  );

  const report = await integrity.orphans({ now: NOW });
  const local = report.find((r) => r.storage === 'local')!;
  const remote = report.find((r) => r.storage === 's3')!;
  assert.deepEqual([local.scanned, local.orphans, local.withinGrace, local.removed], [3, 1, 1, 0]);
  assert.deepEqual(local.sample, [oldOrphan.id]);
  assert.equal(local.orphanBytes, oldOrphan.bytes.length);
  assert.ok(listedWithToken >= 1, 'a second page was asked for with a continuation token, and its signature held');
  assert.deepEqual([remote.scanned, remote.orphans, remote.withinGrace, remote.removed], [4, 2, 1, 0], 'paged listing, and the foreign key skipped');
  assert.deepEqual(new Set(remote.sample), new Set([s3Old, s3Old2]));
  assert.ok(existsSync(oldOrphan.file) && existsSync(youngOrphan.file) && bucket.has(s3Old) && bucket.has(s3Young), 'report mode deletes nothing');

  const deleted = await integrity.orphans({ now: NOW, remove: true });
  assert.deepEqual(deleted.map((r) => r.removed), [1, 2]);
  assert.ok(!existsSync(oldOrphan.file) && !bucket.has(s3Old) && !bucket.has(s3Old2));
  assert.ok(existsSync(youngOrphan.file) && existsSync(named.file) && bucket.has(s3Young) && bucket.has(s3Named), 'only old orphans go');
});

test('files verify reports missing and mismatched drive-only chunks on local and S3, and the scheduled scrub logs them without deletion', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = Buffer.from('good chunk');
  const goodId = sha(good);
  const corrupt = Buffer.from('corrupt chunk');
  const corruptId = sha(corrupt);
  const put = (id: string, bytes: Buffer) => {
    mkdirSync(path.join(dir, id.slice(0, 2)), { recursive: true });
    const file = path.join(dir, id.slice(0, 2), id);
    writeFileSync(file, bytes);
    return file;
  };
  put(goodId, good);
  const corruptFile = put(corruptId, Buffer.from('flipped bytes!'));
  const lostId = sha(Buffer.from('lost'));
  const s3Good = Buffer.from('s3 good');
  const s3Bad = Buffer.from('s3 bad');
  const s3Lost = sha(Buffer.from('s3 lost'));
  const orphanBytes = Buffer.from('old orphan');
  const orphanId = sha(orphanBytes);
  const old = new Date(NOW.getTime() - 100 * DAY);
  const orphanFile = put(orphanId, orphanBytes);
  utimesSync(orphanFile, old, old);
  const bucket = new Map([
    [sha(s3Good), { bytes: s3Good, modified: NOW }],
    [sha(s3Bad), { bytes: Buffer.from('s3 BAD'), modified: NOW }],
    [orphanId, { bytes: orphanBytes, modified: old }],
  ]);
  const gone = sha(Buffer.from('already deleted'));
  const integrity = setup(
    [
      { sha256: goodId, storage: 'local', bytesDeletedAt: null },
      { sha256: corruptId, storage: 'local', bytesDeletedAt: null },
      { sha256: lostId, storage: 'local', bytesDeletedAt: null },
      { sha256: sha(s3Good), storage: 's3', bytesDeletedAt: null },
      { sha256: sha(s3Bad), storage: 's3', bytesDeletedAt: null },
      { sha256: s3Lost, storage: 's3', bytesDeletedAt: null },
      { sha256: gone, storage: 'local', bytesDeletedAt: NOW },
    ],
    await fakeBucket(t, bucket),
    dir,
    new Map([
      [goodId, 'local-version'], [corruptId, 'local-version'], [lostId, 'local-version'],
      [sha(s3Good), 's3-version'], [sha(s3Bad), 's3-version'], [s3Lost, 's3-version'],
    ]),
  );
  const report = await integrity.verify();
  assert.equal(report.checked, 6, 'a blob whose bytes the sweep deleted is not expected');
  assert.equal(report.hashed, 4);
  assert.deepEqual(
    report.problems.map((p) => [p.sha256, p.storage, p.problem, p.driveVersions, p.attachments]).sort(),
    [
      [corruptId, 'local', 'mismatch', 1, 0], [lostId, 'local', 'missing', 1, 0],
      [sha(s3Bad), 's3', 'mismatch', 1, 0], [s3Lost, 's3', 'missing', 1, 0],
    ].sort(),
  );
  const quick = await integrity.verify({ deep: false });
  assert.deepEqual(quick.problems.map((p) => p.problem), ['missing', 'missing'], 'without reading back, only absence shows');

  const warnings = t.mock.method(Logger.prototype, 'warn', (_message: unknown) => {});
  const logs = t.mock.method(Logger.prototype, 'log', (_message: unknown) => {});
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-11-22T02:00:00Z').getTime() });
  integrity.onApplicationBootstrap();
  t.after(() => integrity.onModuleDestroy());
  assert.equal(warnings.mock.callCount(), 0);
  t.mock.timers.tick(60 * 60 * 1000);
  await integrity.settled();
  assert.deepEqual(
    warnings.mock.calls.map((call) => call.arguments[0]),
    report.problems.map((p) => `scrub: ${p.problem} ${p.sha256} (${p.storage}): 1 drive version(s), 0 attachment(s)`),
  );
  assert.ok(logs.mock.calls.some((call) => call.arguments[0] === 'scrub verify: checked 6, read back 4, problems 4; report only'));
  assert.ok(existsSync(corruptFile) && bucket.has(sha(s3Bad)), 'the scrub keeps mismatched bytes');
  assert.ok(existsSync(orphanFile) && bucket.has(orphanId), 'the scrub keeps even orphans past grace');
});

test('the weekly slot is Sunday 03:00 UTC, and a restart neither scrubs nor delays it', async (t) => {
  assert.equal(scrubSlotAtOrBefore(new Date('2026-11-22T03:00:00Z')).toISOString(), '2026-11-22T03:00:00.000Z');
  assert.equal(scrubSlotAtOrBefore(new Date('2026-11-22T02:59:59Z')).toISOString(), '2026-11-15T03:00:00.000Z');
  assert.equal(scrubSlotAtOrBefore(new Date('2026-11-25T12:00:00Z')).toISOString(), '2026-11-22T03:00:00.000Z');

  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-slot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const integrity = setup([], await fakeBucket(t, new Map()), dir);
  let scrubs = 0;
  integrity.scrub = async () => {
    scrubs += 1;
    return { checked: 0, hashed: 0, problems: [] };
  };
  // Boot on Saturday: the timer is armed, but nothing is owed.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-11-21T10:00:00Z').getTime() });
  integrity.onApplicationBootstrap();
  t.after(() => integrity.onModuleDestroy());
  assert.equal(scrubs, 0, 'a boot does not scrub');
  assert.equal(integrity.tick(new Date('2026-11-21T11:00:00Z')), false);
  assert.equal(integrity.tick(new Date('2026-11-22T02:59:00Z')), false, 'a tick before the slot does not scrub');
  assert.equal(integrity.tick(new Date('2026-11-22T03:00:00Z')), true, 'a tick at the slot does');
  await integrity.settled();
  assert.equal(integrity.tick(new Date('2026-11-22T04:00:00Z')), false, 'and only once');
  assert.equal(integrity.tick(new Date('2026-11-23T04:00:00Z')), false);
  assert.equal(scrubs, 1);
  // A process restarted on Sunday after the slot owes nothing either.
  const rebooted = setup([], await fakeBucket(t, new Map()), dir);
  rebooted.scrub = async () => {
    scrubs += 1;
    return { checked: 0, hashed: 0, problems: [] };
  };
  t.mock.timers.setTime(new Date('2026-11-22T09:00:00Z').getTime());
  rebooted.onApplicationBootstrap();
  t.after(() => rebooted.onModuleDestroy());
  assert.equal(rebooted.tick(new Date('2026-11-22T10:00:00Z')), false);
  assert.equal(rebooted.tick(new Date('2026-11-29T03:00:00Z')), true, 'the next Sunday it does');
  await rebooted.settled();
  assert.equal(scrubs, 2);
});
