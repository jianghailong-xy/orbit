/**
 * What an evidence card reads (docs/orbit-files-design.md §2.6): `GET /tasks/:taskId/evidence/:revision/files`, held against
 * the production apiserver — `build/main.js` and every guard and pipe in front of the route — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/evidence-files.pg.spec.ts
 *
 *   (1) a version's files in the order it cites them: a file, an image with its size, a report with its summary, and a
 *       folder's members by path, each named as the citation names it, with the whole list's count and size;
 *   (2) a file cited twice, or cited beside its folder, is one entry, and an older version answers what it cited;
 *   (3) expired is real: with `expired_at` stamped on a row, a manifest and its members and every byte removed, the list
 *       reads as it did, each file with the date, because nothing here reads the file store;
 *   (4) a row that no longer exists does not 404 the list: it comes back from what the version recorded, marked as gone, and
 *       the list goes on past it;
 *   (5) a page holds at most a whole folder, nothing is cut or repeated across pages, and the count stays the whole list's;
 *   (6) a revision that does not exist, in any spelling, is a 404, and a bad offset is a 400;
 *   (7) another account gets the same 404 as a task that does not exist;
 *   (8) a version citing no file answers an empty list, and reading any of this writes nothing;
 *   (9) `pinnable` says what a client's pin button goes by: what file_upload kept, while its bytes remain.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { EVIDENCE_FILES_PAGE, MAX_BUNDLE_FILES, MAX_BUNDLE_PATH_CHARS, MAX_FILE_LABEL_CHARS } from './files.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `evidence-files-${RUN}`;
const STANDARD = 'the card shows the files the evidence cites';

const b62 = (id: string) => uuidToBase62(id);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The first 24 bytes of a PNG of that size, which is all anything here reads of one, and then some noise. */
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, randomBytes(1000)]);
}

/** A file as this spec holds it. */
interface Kept {
  id: string;
  publicId: string;
  sha256: string;
  bytes: Buffer;
}

const REPORT = JSON.stringify({
  suites: [{
    title: 'menu.spec.ts',
    specs: [
      { title: 'opens', tests: [{ projectName: 'chromium', status: 'expected' }] },
      { title: 'closes', tests: [{ projectName: 'chromium', status: 'unexpected' }] },
      { title: 'scrolls', tests: [{ projectName: 'webkit', status: 'skipped' }] },
    ],
  }],
  errors: [],
  stats: { expected: 1, unexpected: 1, skipped: 1, duration: 38000 },
});

test('the files of a version of evidence', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-evidence-files-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `evidence-files-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;

  const accountOf = async (name: string) => {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const token = `${runnerId}-${RUN}`;
    const email = `${name}-${RUN}@evidence-files.invalid`;
    await db.user.create({ data: { id: ownerId, email, name, passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name, status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 3_600_000),
        tokenHash: createHash('sha256').update(token).digest('hex'),
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name, enabled: true } });
    return { ownerId, runnerId, workspaceId, token, bearer: await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email }) };
  };
  const owner = await accountOf('owner');
  const stranger = await accountOf('stranger');

  /** A task, and the run that does it. */
  const workOf = async (title: string) => {
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, title, ownerId: owner.ownerId, creatorType: 'USER', creatorId: owner.ownerId, assigneeId: owner.workspaceId,
        status: 'IN_PROGRESS', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
      },
    });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, title, prompt: title, ownerId: owner.ownerId, creatorId: owner.ownerId, workspaceId: owner.workspaceId,
        assignedRunnerId: owner.runnerId, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
        provider: 'claude', taskId, startsTaskWork: true,
      },
    });
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
    return { taskId, sessionId, tool: { kind: 'TOOL_CALL', ref: toolUseId } };
  };
  type Work = Awaited<ReturnType<typeof workOf>>;

  const created = (reply: Reply, what: string) => {
    assert.equal(reply.status, 201, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return reply.json;
  };
  const kept = (answer: { id: string; sha256: string }, bytes: Buffer): Kept => ({
    id: toUuid(answer.id), publicId: b62(toUuid(answer.id)), sha256: answer.sha256, bytes,
  });
  const uploaded = async (work: Work, name: string, type: string, bytes: Buffer, fields: Record<string, string> = {}): Promise<Kept> => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const response = await fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(work.sessionId)}/files`, {
      method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: form,
    });
    const text = await response.text();
    assert.equal(response.status, 201, `${name} answered ${response.status}: ${text.slice(0, 400)}`);
    return kept(JSON.parse(text), bytes);
  };
  const bundled = async (work: Work, name: string, files: { path: string; file: Kept }[]): Promise<Kept> => kept(created(
    await call(api, 'POST', `/api/runner/sessions/${b62(work.sessionId)}/file-bundles`, owner.token, {
      name, files: files.map(({ path: filePath, file }) => ({ path: filePath, id: file.publicId })),
    }),
    'the folder',
  ), Buffer.alloc(0));
  const asFile = (file: { publicId: string }) => ({ kind: 'FILE', ref: file.publicId });
  const submit = async (work: Work, checks: unknown[]): Promise<string> => created(
    await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token, {
      evidence: { claim: 'the files show it', criterion: { key: b62(work.taskId), text: STANDARD }, checks: [work.tool, ...checks], gaps: [] },
    }, { 'x-orbit-session-id': work.sessionId }),
    'the evidence',
  ).revision;
  const filesOf = (taskId: string, revision: string, query = '', bearer = owner.bearer) =>
    call(api, 'GET', `/api/tasks/${b62(taskId)}/evidence/${revision}/files${query}`, bearer);
  const read = async (taskId: string, revision: string, query = '') => {
    const reply = await filesOf(taskId, revision, query);
    assert.equal(reply.status, 200, reply.text.slice(0, 400));
    return reply.json;
  };

  const work = await workOf('a task with files');
  const shot = await uploaded(work, 'alone.png', 'image/png', png(780, 1688));
  const report = await uploaded(work, 'report.json', 'application/json', Buffer.from(REPORT), { as: 'test-report' });
  const open = await uploaded(work, 'open.png', 'image/png', png(390, 844));
  const closed = await uploaded(work, 'closed.png', 'image/png', png(390, 845));
  const page = await uploaded(work, 'page.html', 'text/html', Buffer.from('<p>a page</p>'));
  const folder = await bundled(work, 'menu-shots', [
    { path: 'chromium-light-phone/open.png', file: open },
    { path: 'chromium-dark-phone/closed.png', file: closed },
    { path: 'notes/page.html', file: page },
  ]);
  const revision = await submit(work, [asFile(shot), asFile(report), asFile(folder)]);

  await t.test('(1) what a version cites, in its order, with the whole list\'s count and size', async () => {
    const list = await read(work.taskId, revision);
    assert.equal(list.revision, revision);
    const submitted = await db.taskCompletionEvidence.findFirstOrThrow({ where: { taskId: work.taskId } });
    assert.equal(new Date(list.submittedAt).getTime(), submitted.submittedAt.getTime());
    assert.deepEqual(
      list.files.map((file: { name: string; folder: string | null }) => [file.name, file.folder]),
      [
        ['alone.png', null],
        ['report.json', null],
        ['chromium-dark-phone/closed.png', 'menu-shots'],
        ['chromium-light-phone/open.png', 'menu-shots'],
        ['notes/page.html', 'menu-shots'],
      ],
      'as cited, a folder by path, and the manifest is not a file of the list',
    );
    assert.equal(list.fileCount, 5);
    assert.equal(
      list.totalBytes,
      [shot, report, open, closed, page].reduce((sum, file) => sum + file.bytes.length, 0),
      'every file, and not the manifest',
    );
    assert.equal(list.nextOffset, null);
    const citations = (await call(api, 'GET', `/api/tasks/${b62(work.taskId)}/evidence`, owner.bearer)).json[0].citations;
    assert.equal(list.files[0].id, citations.find((citation: { kind: string }) => citation.kind === 'FILE').ref, 'named as its citation names it');
    assert.deepEqual(
      [list.files[0].width, list.files[0].height, list.files[0].mimeType, list.files[0].sizeBytes, list.files[0].sha256],
      [780, 1688, 'image/png', shot.bytes.length, shot.sha256],
    );
    assert.deepEqual([list.files[3].width, list.files[3].height], [null, null], 'a folder\'s rows do not record a picture\'s size');
    assert.equal(list.files[1].testReport.failed, 1);
    assert.deepEqual(list.files[1].testReport.failedNames, ['[chromium] › menu.spec.ts › closes']);
    for (const file of list.files) {
      assert.equal(file.gone, false);
      assert.equal(file.expiredAt, null);
      assert.equal(file.kind, 'file');
    }
    assert.equal(list.files[3].id, open.publicId, 'a folder\'s file by the id its own bytes are read with');
    const bytes = await fetch(`http://127.0.0.1:${api.port}/api/attachments/${list.files[3].id}`, {
      headers: { authorization: `Bearer ${owner.bearer}` },
    });
    assert.equal(sha256(Buffer.from(await bytes.arrayBuffer())), open.sha256, 'and the id reads those bytes');
  });

  await t.test('(2) one file is one entry, and an older version answers what it cited', async () => {
    const again = await workOf('files cited twice');
    const a = await uploaded(again, 'a.png', 'image/png', png(10, 11));
    const b = await uploaded(again, 'b.png', 'image/png', png(12, 13));
    const inFolder = await bundled(again, 'twice', [{ path: 'a.png', file: a }]);
    const first = await submit(again, [asFile(a), asFile(b), asFile(inFolder)]);
    const list = await read(again.taskId, first);
    assert.deepEqual(list.files.map((file: { id: string }) => file.id), [b.publicId, a.publicId], 'a is cited beside its folder, and is the folder\'s');
    assert.equal(list.fileCount, 2);
    assert.equal(list.files[1].width, 10, 'and it keeps the size its own citation recorded');
    const twice = await workOf('one file cited twice');
    const c = await uploaded(twice, 'c.png', 'image/png', png(14, 15));
    const once = await read(twice.taskId, await submit(twice, [asFile(c), asFile(c)]));
    assert.deepEqual(once.files.map((file: { id: string }) => file.id), [c.publicId]);

    const second = await submit(again, [asFile(b)]);
    assert.equal(second, '2');
    assert.equal((await read(again.taskId, second)).fileCount, 1);
    assert.equal((await read(again.taskId, first)).fileCount, 2, 'the older version still says what it cited');
  });

  await t.test('(3) expired is a date on a row, and nothing here needs the bytes', async () => {
    const before = await read(work.taskId, revision);
    const date = new Date('2026-12-02T09:30:00.000Z');
    await db.attachment.updateMany({
      where: { id: { in: [shot, report, folder, open, closed, page].map((file) => file.id) } },
      data: { expiresAt: date, expiredAt: date },
    });
    for (const file of [shot, report, open, closed, page, folder]) {
      const manifest = await db.attachment.findUniqueOrThrow({ where: { id: file.id }, select: { sha256: true } });
      rmSync(path.join(dir, manifest.sha256!.slice(0, 2), manifest.sha256!));
    }
    assert.deepEqual(readdirSync(path.join(dir, shot.sha256.slice(0, 2))).includes(shot.sha256), false);
    const gone = await fetch(`http://127.0.0.1:${api.port}/api/attachments/${shot.publicId}`, { headers: { authorization: `Bearer ${owner.bearer}` } });
    assert.equal(gone.status, 410, 'the bytes are gone');
    assert.equal((await gone.json() as { expiredAt: string }).expiredAt, date.toISOString(), 'and it says when');
    const after = await read(work.taskId, revision);
    assert.deepEqual(
      after.files.map(({ expiredAt, expiresAt, ...file }: { expiredAt: string; expiresAt: string }) => file),
      before.files.map(({ expiredAt, expiresAt, ...file }: { expiredAt: string | null; expiresAt: string | null }) => file),
      'names, sizes, sha256 and the report read as they did',
    );
    assert.deepEqual([...new Set(after.files.map((file: { expiredAt: string }) => file.expiredAt))], [date.toISOString()]);
    assert.deepEqual(
      [after.fileCount, after.totalBytes, after.files[1].testReport.failedNames],
      [before.fileCount, before.totalBytes, before.files[1].testReport.failedNames],
      'and so does the whole list\'s count',
    );
  });

  await t.test('(9) a pin is offered on what file_upload kept, while its bytes remain', async () => {
    const pins = await workOf('files and pins');
    const held = await uploaded(pins, 'held.png', 'image/png', png(10, 10));
    const tombstoned = await uploaded(pins, 'tombstoned.png', 'image/png', png(11, 11));
    const went = await uploaded(pins, 'went.png', 'image/png', png(12, 12));
    const deleted = await uploaded(pins, 'deleted.png', 'image/png', png(13, 13));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png(14, 14))], { type: 'image/png' }), 'input.png');
    const input = await fetch(`http://127.0.0.1:${api.port}/api/attachments?taskId=${b62(pins.taskId)}`, {
      method: 'POST', headers: { authorization: `Bearer ${owner.bearer}` }, body: form,
    });
    assert.equal(input.status, 201);
    const inputId = (await input.json() as { id: string }).id;
    const version = await submit(pins, [held, tombstoned, went, deleted, { publicId: b62(toUuid(inputId)) }].map(asFile));
    const date = new Date('2026-12-02T09:30:00.000Z');
    await db.attachment.updateMany({ where: { id: { in: [tombstoned.id, went.id] } }, data: { expiresAt: date, expiredAt: date } });
    await db.fileBlob.update({ where: { sha256: went.sha256 }, data: { bytesDeletedAt: date } });
    await db.attachment.delete({ where: { id: deleted.id } });
    const list = await read(pins.taskId, version);
    const offered = Object.fromEntries(list.files.map((file: { name: string | null; pinnable: boolean }) => [file.name ?? 'gone', file.pinnable]));
    assert.deepEqual(offered, {
      'held.png': true,
      'tombstoned.png': true,
      'went.png': false,
      gone: false,
      'input.png': false,
    }, 'a tombstone with its bytes yes; bytes deleted, a row that went, and what file_upload did not keep no');
    for (const file of list.files) {
      assert.equal('retention' in file, false, 'the rule\'s inputs stay on the server');
      assert.equal('blob' in file, false);
    }
    const pinned = await call(api, 'PUT', `/api/attachments/${tombstoned.publicId}/pin`, owner.bearer);
    assert.equal(pinned.status, 200, 'and what is offered can be pinned, which brings it back');
    assert.equal(pinned.json.expiredAt, null);
    assert.ok(pinned.json.pinnedAt);
    assert.equal((await read(pins.taskId, version)).files.find((file: { name: string }) => file.name === 'tombstoned.png').pinnable, true, 'and still can be taken off');
    const bytes = await fetch(`http://127.0.0.1:${api.port}/api/attachments/${tombstoned.publicId}`, { headers: { authorization: `Bearer ${owner.bearer}` } });
    assert.equal(bytes.status, 200);
    assert.equal(sha256(Buffer.from(await bytes.arrayBuffer())), tombstoned.sha256);
  });

  await t.test('(4) a cited row that no longer exists comes back from what the version recorded', async () => {
    const lost = await workOf('a row that went');
    const a = await uploaded(lost, 'a.png', 'image/png', png(20, 21));
    const b = await uploaded(lost, 'b.png', 'image/png', png(22, 23));
    const c = await uploaded(lost, 'c.png', 'image/png', png(24, 25));
    const inFolder = await bundled(lost, 'going', [{ path: 'c.png', file: c }]);
    const version = await submit(lost, [asFile(a), asFile(inFolder), asFile(b)]);
    await db.attachment.deleteMany({ where: { id: { in: [a.id, inFolder.id, c.id] } } });
    const list = await read(lost.taskId, version);
    assert.equal(list.fileCount, 3);
    assert.equal(list.totalBytes, b.bytes.length, 'only what is still known');
    assert.deepEqual(list.files.map((file: { gone: boolean }) => file.gone), [true, true, false]);
    assert.deepEqual(
      list.files[0],
      {
        id: a.publicId, kind: 'file', name: null, label: null, mimeType: null, sizeBytes: null, sha256: a.sha256,
        sessionId: null, taskId: null, fileBundleId: null, testReport: null, createdAt: null, folder: null,
        width: 20, height: 21, expiresAt: null, expiredAt: null, pinnedAt: null, gone: true, pinnable: false,
        // Every id field of an answer has its public spelling beside it.
        sessionPublicId: null, taskPublicId: null, fileBundlePublicId: null,
      },
    );
    assert.equal(list.files[1].id, inFolder.publicId, 'a folder that went is one entry: only its rows knew what was in it');
    assert.equal(list.files[1].sha256, inFolder.sha256);
    assert.equal(list.files[2].id, b.publicId, 'and the list goes on past them');
  });

  await t.test('(5) a page is at most a whole folder, and nothing is cut or repeated', async (sub) => {
    assert.equal(EVIDENCE_FILES_PAGE, MAX_BUNDLE_FILES);
    const large = await workOf('a large version');
    const one = await uploaded(large, 'first.png', 'image/png', png(30, 31));
    const seed = await uploaded(large, 'seed.txt', 'text/plain', Buffer.from('seed'));
    const big = await bundled(large, 'big', [{ path: 'seed.txt', file: seed }]);
    const other = await bundled(large, 'other', [{ path: 'keep.txt', file: await uploaded(large, 'keep.txt', 'text/plain', Buffer.from('keep')) }]);
    const row = (bundle: string, name: string) => ({
      ownerId: owner.ownerId, sessionId: large.sessionId, fileBundleId: bundle, fileName: name, mimeType: 'text/plain',
      sizeBytes: 4, sha256: seed.sha256, retention: 'file_upload',
    });
    // Rows rather than uploads: what this is about is how many there are.
    await db.attachment.createMany({
      data: Array.from({ length: EVIDENCE_FILES_PAGE - 1 }, (_, k) => row(big.id, `dir-${String(k % 7)}/f-${String(k).padStart(4, '0')}.txt`)),
    });
    await db.attachment.createMany({ data: Array.from({ length: 299 }, (_, k) => row(other.id, `g-${String(k).padStart(3, '0')}.txt`)) });
    const version = await submit(large, [asFile(one), asFile(big), asFile(other)]);
    const whole = 1 + EVIDENCE_FILES_PAGE + 300;

    const first = await read(large.taskId, version);
    assert.equal(first.files.length, EVIDENCE_FILES_PAGE);
    assert.equal(first.fileCount, whole, 'the whole list\'s count, on the first page');
    assert.equal(first.nextOffset, EVIDENCE_FILES_PAGE);
    assert.equal(first.totalBytes, one.bytes.length + 4 * (whole - 1));
    await db.attachment.updateMany({ where: { fileBundleId: big.id, NOT: { id: big.id } }, data: { label: 'l'.repeat(MAX_FILE_LABEL_CHARS) } });
    await sql.query(
      `UPDATE attachment SET file_name = rpad(file_name, ${MAX_BUNDLE_PATH_CHARS}, 'x') WHERE file_bundle_id = $1 AND id <> $1`,
      [big.id],
    );
    const longest = Buffer.byteLength((await filesOf(large.taskId, version)).text);
    sub.diagnostic(`the largest page is ${longest} bytes`);
    assert.ok(longest < 1_800_000, `the largest page, every path and label at its limit, is ${longest} bytes`);
    assert.ok(longest > 1_200_000, `and that is what this measured: ${longest} bytes`);
    const second = await read(large.taskId, version, `?offset=${first.nextOffset}`);
    assert.equal(second.files.length, whole - EVIDENCE_FILES_PAGE);
    assert.equal(second.nextOffset, null);
    assert.equal(second.fileCount, whole);
    assert.equal(second.totalBytes, first.totalBytes);
    const ids = [...first.files, ...second.files].map((file: { id: string }) => file.id);
    assert.equal(new Set(ids).size, whole, 'each file once, across the pages');
    assert.equal(first.files[0].id, one.publicId, 'still in the order the version cites');
    assert.equal(second.files.at(-1).folder, 'other');
    const middle = await read(large.taskId, version, '?offset=999');
    assert.deepEqual(
      middle.files.slice(0, 2).map((file: { id: string }) => file.id),
      [first.files[999].id, second.files[0].id],
      'an offset inside a folder picks up where it says, across the folder\'s end',
    );
    const past = await read(large.taskId, version, `?offset=${whole}`);
    assert.deepEqual([past.files, past.nextOffset, past.fileCount], [[], null, whole], 'past the end is an empty page');

    const full = await submit(large, [asFile(big), asFile(one)]);
    const exactly = await read(large.taskId, full);
    assert.equal(exactly.files.length, EVIDENCE_FILES_PAGE, 'a page that fills at a folder\'s end takes nothing after it');
    assert.equal(exactly.nextOffset, EVIDENCE_FILES_PAGE);
    const after = await read(large.taskId, full, `?offset=${exactly.nextOffset}`);
    assert.deepEqual([after.files.map((file: { id: string }) => file.id), after.nextOffset], [[one.publicId], null]);
  });

  await t.test('(6) a revision that does not exist is a 404, in any spelling, and a bad offset a 400', async () => {
    for (const missing of ['2', '0', 'abc', '-1', '1.5', '01', '9223372036854775808', '99999999999999999999999']) {
      const reply = await filesOf(work.taskId, missing);
      assert.equal(reply.status, 404, `${missing} answered ${reply.status}: ${reply.text.slice(0, 200)}`);
      assert.equal(reply.json.message, 'evidence not found');
    }
    for (const bad of ['-1', 'abc', '1.5']) {
      assert.equal((await filesOf(work.taskId, revision, `?offset=${bad}`)).status, 400, bad);
    }
  });

  await t.test('(7) another account gets the same 404 as a task that does not exist', async () => {
    const theirs = await filesOf(work.taskId, revision, '', stranger.bearer);
    const nobody = await filesOf(randomUUID(), revision, '', stranger.bearer);
    assert.equal(theirs.status, 404);
    assert.deepEqual(theirs.json, nobody.json, 'nothing tells them apart');
    assert.equal(theirs.json.message, 'task not found');
    assert.equal((await call(api, 'GET', `/api/tasks/${b62(work.taskId)}/evidence/${revision}/files`, undefined)).status, 401);
  });

  await t.test('(8) a version citing no file has an empty list, and reading writes nothing', async () => {
    const plain = await workOf('no files');
    const version = await submit(plain, []);
    assert.deepEqual(
      (({ submittedAt, ...list }) => list)(await read(plain.taskId, version)),
      { revision: version, fileCount: 0, totalBytes: 0, files: [], nextOffset: null },
    );
    const snapshot = () => db.taskCompletionEvidence.findMany({ where: { taskId: work.taskId }, select: { evidenceDigest: true, evidence: true } });
    const rows = () => db.attachment.findMany({ where: { ownerId: owner.ownerId }, orderBy: { id: 'asc' } });
    const [digests, attachments] = [await snapshot(), await rows()];
    await read(work.taskId, revision);
    assert.deepEqual(await snapshot(), digests, 'the digest is what it was');
    assert.deepEqual(await rows(), attachments, 'and so is every row');
  });
});
