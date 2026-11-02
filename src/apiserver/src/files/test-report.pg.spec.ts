/**
 * `file_upload --as test-report` at its door (docs/orbit-files-design.md §2.5; migration 0465), held against the
 * production apiserver — `build/main.js`, multer and every guard and pipe in front of the route — over a real PostgreSQL
 * that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/test-report.pg.spec.ts
 *
 *   (1) a real Playwright report and a real JUnit report are read: the summary is on the row, in the answer, and in what
 *       `file_list` and `file_fetch` say of the file, and the bytes kept are the bytes sent;
 *   (2) a file that is no report, or only part of one, is kept as a plain file: nothing fails, nothing is claimed, and the
 *       answer says so;
 *   (3) without `as` a report is a file like any other, and nothing reads it;
 *   (4) any other `as` is refused and leaves nothing behind;
 *   (5) whatever a report's names hold, the row can keep them;
 *   (6) the summary is metadata: the file's bytes going does not take it with them.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { upload } from '../auth/tenant-isolation-fixtures';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { NOT_A_TEST_REPORT } from './files.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `test-report-${RUN}`;

const SAMPLES = path.resolve(__dirname, '../../src/files/test-report-samples');
const sample = (name: string) => readFileSync(path.join(SAMPLES, name), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const b62 = (id: string) => uuidToBase62(id);

test('file_upload --as test-report', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-test-report-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  server = await startApiserver(url, `test-report-${randomUUID()}`, {
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;

  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `test-report-${RUN}@orbit-files.invalid`, name: 'test report', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const token = `${runnerId}-${RUN}`;
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'test-report', tokenHash: createHash('sha256').update(token).digest('hex') } });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'test-report', enabled: true } });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, title: 'a run', prompt: 'a run', ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
    },
  });

  const door = `/api/runner/sessions/${b62(sessionId)}/files`;
  const send = (content: string, name: string, fields: Record<string, string> = { as: 'test-report' }): Promise<Reply> =>
    upload(api, 'POST', door, { authorization: `Bearer ${token}` }, { name, type: 'application/octet-stream', content }, fields);
  const kept = async (content: string, name: string, fields?: Record<string, string>) => {
    const reply = await send(content, name, fields);
    assert.equal(reply.status, 201, `${name} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return reply.json;
  };
  const summaryOnRow = async (id: string) =>
    (await db.attachment.findUniqueOrThrow({ where: { id }, select: { testReportSummary: true } })).testReportSummary;
  const bytesOf = (publicId: string) =>
    fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(sessionId)}/attachments/${publicId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const listed = async () =>
    (await call(api, 'GET', `/api/runner/files?sessionId=${b62(sessionId)}`, token)).json.files as { id: string; testReport: unknown }[];
  const notes = (reply: Reply) => reply.json.note as string | undefined;

  await t.test('(1) a real report is read, and every door that describes the file says what it read', async () => {
    const report = sample('playwright-orbit-web.json');
    const file = await kept(report, 'report.json');
    assert.equal(file.sha256, sha256(report), 'the report is kept as it was sent');
    assert.equal(file.note, undefined, 'there is nothing to say');
    const { failedNames, skippedNames, ...numbers } = file.testReport;
    assert.deepEqual(numbers, { format: 'playwright', total: 96, passed: 83, failed: 9, skipped: 4, durationMs: 379027 });
    assert.equal(failedNames.length, 9);
    assert.equal(failedNames[0], '[chromium-dark-phone] › pages.browser.mjs › profile');
    assert.equal(skippedNames.length, 4);
    assert.deepEqual(await summaryOnRow(file.id), file.testReport, 'kept on the row');

    const junit = await kept(sample('junit-gradle.xml'), 'TEST-io.orbitd.sample.PendingQueueTest.xml');
    assert.deepEqual(
      [junit.testReport.format, junit.testReport.total, junit.testReport.passed, junit.testReport.failed, junit.testReport.skipped],
      ['junit', 6, 2, 2, 2],
    );
    assert.deepEqual(junit.testReport.failedNames, [
      'io.orbitd.sample.PendingQueueTest › aDecidedRevisionLeavesTheQueue',
      'io.orbitd.sample.PendingQueueTest › anUnexpectedExceptionIsAnError',
    ]);

    const inList = (await listed()).find((row) => row.id === file.publicId);
    assert.deepEqual(inList?.testReport, file.testReport, 'file_list says it');
    const described = await call(api, 'GET', `${door}/${file.publicId}`, token);
    assert.deepEqual(described.json.testReport, file.testReport, 'and so does what file_fetch reads first');
    assert.equal(await (await bytesOf(file.publicId)).text(), report, 'and the bytes read back whole');
  });

  await t.test('(2) what is not a whole report is kept as a plain file, and the answer says so', async () => {
    const cases: Record<string, string> = {
      'notes.txt': 'all 46 tests passed\n',
      'other.json': '{"numTotalTests": 3, "testResults": []}',
      'page.xml': '<html><body>not a report</body></html>',
      'cut.json': sample('playwright-retries.json').slice(0, 2000),
      'cut.xml': sample('junit-vitest.xml').slice(0, 2000),
    };
    for (const [name, content] of Object.entries(cases)) {
      const reply = await send(content, name);
      assert.equal(reply.status, 201, `${name} answered ${reply.status}: ${reply.text}`);
      assert.equal(notes(reply), NOT_A_TEST_REPORT, `${name} says so`);
      assert.equal(reply.json.testReport, null, `${name} claims nothing`);
      assert.equal(reply.json.sha256, sha256(content), `${name} is kept all the same`);
      assert.equal(await summaryOnRow(reply.json.id), null);
      assert.equal(await (await bytesOf(reply.json.publicId)).text(), content, `${name} reads back`);
    }
    assert.match(NOT_A_TEST_REPORT, /plain file/);
  });

  await t.test('(3) without `as` nothing reads the file', async () => {
    const reply = await send(sample('junit-vitest.xml'), 'junit.xml', {});
    assert.equal(reply.status, 201, reply.text);
    assert.equal(notes(reply), undefined);
    assert.equal(reply.json.testReport, null);
    assert.equal(await summaryOnRow(reply.json.id), null);
  });

  await t.test('(4) any other `as` is refused, and nothing is left behind', async () => {
    const before = await db.attachment.count({ where: { ownerId } });
    const reply = await send(sample('junit-vitest.xml'), 'junit.xml', { as: 'coverage' });
    assert.equal(reply.status, 400, reply.text);
    assert.deepEqual(readdirSync(path.join(dir, 'tmp')), [], 'no temporary file is left');
    assert.equal(await db.attachment.count({ where: { ownerId } }), before, 'and no row');
  });

  await t.test('(5) whatever a report names, the row can keep it', async () => {
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800);
    const report = JSON.stringify({
      suites: [{
        title: 'a.spec.ts',
        specs: [
          { title: `nul${nul}here`, tests: [{ projectName: '', status: 'unexpected' }] },
          { title: `half${loneSurrogate}a pair`, tests: [{ projectName: '', status: 'skipped' }] },
        ],
      }],
      errors: [],
      stats: { expected: 0, unexpected: 1, skipped: 1 },
    });
    const file = await kept(report, 'report.json');
    assert.deepEqual(file.testReport.failedNames, ['a.spec.ts › nul here']);
    assert.deepEqual(file.testReport.skippedNames, ['a.spec.ts › half a pair']);
    const junit = await kept('<testsuite><testcase name="a&#0;b"><failure/></testcase></testsuite>', 'junit.xml');
    assert.deepEqual(junit.testReport.failedNames, ['a b']);
  });

  await t.test('(6) a file past its retention keeps its summary', async () => {
    const report = sample('playwright-retries.json');
    const file = await kept(report, 'report.json');
    // What the retention job does to a row (§2.8): it stamps it and removes the bytes. The row stays.
    await db.attachment.update({ where: { id: file.id }, data: { expiresAt: new Date(), expiredAt: new Date() } });
    rmSync(path.join(dir, file.sha256.slice(0, 2), file.sha256));
    assert.equal((await bytesOf(file.publicId)).status, 404, 'the bytes are gone');
    assert.deepEqual(await summaryOnRow(file.id), file.testReport, 'the summary is not');
    assert.deepEqual((await listed()).find((row) => row.id === file.publicId)?.testReport, file.testReport, 'and it is still answered');
  });
});
