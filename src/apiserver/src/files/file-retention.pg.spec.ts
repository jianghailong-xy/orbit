/**
 * Orbit Files' retention (docs/orbit-files-design.md §2.8, §2.10; migration 0466; files/file-retention.ts,
 * files/file-retention-sweep.ts), walked with a fake clock: uploads, citations, decisions and pins go through the production
 * apiserver — `build/main.js`, every guard and pipe in front of the routes — and the sweep is the real one, over the same
 * database and files directory, told what time it is:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/file-retention.pg.spec.ts
 *
 *   (1) an upload no evidence cites expires 14 days after it was uploaded, to the millisecond, and keeps its row;
 *   (2) its bytes outlast the tombstone by the grace period, to the millisecond, and then go, with the row left whole;
 *   (3) the grace period is seven days, and never less than a retained Postgres backup reaches back, read from the same two
 *       settings the backup sidecar keeps backups by;
 *   (4) a version sent back lets go of what it cites 30 days after the send-back;
 *   (5) a version a newer one replaces lets go of what it cites 30 days after the newer one arrived, and the newer one holds
 *       what it cites;
 *   (6) a confirmed version holds what it cites until the task is deleted, past any later version; then the later of the
 *       deletion and 14 days after the upload;
 *   (7) a pin keeps a file past any date, a pin in the grace period brings it back, taking it away lets the date apply again,
 *       and a pin after the bytes went says so; at both doors, and another account's is not found;
 *   (8) where several versions cite a file the latest wins, and a date stays held while any version holds it;
 *   (9) bytes are never deleted while any row still holds them: another row naming them, of any kind, moves their grace period;
 *  (10) a citation of a folder holds its manifest and its files, and all of them expire together, which the evidence card's
 *       route still answers from their rows, with names, sizes and sha256;
 *  (11) a reply's image, a person's upload and a task's input have no date and never expire;
 *  (12) a row deleted outright lets its bytes go a grace period after the sweep first finds them unnamed;
 *  (13) an upload of bytes that went keeps them again, and one or a pin arriving while the real delete is under way waits for
 *       it: the upload keeps the bytes again, and the pin says they went;
 *  (14) a new version cannot cite an expired file, nor a new task take one as an input; a replay of a version that did is answered;
 *  (15) what expiry leaves: a real sweep takes a test report's bytes and leaves its summary, labels and citations as they
 *       were, with the digest untouched, in task_evidence_list and in what file_list and the card's route answer;
 *  (16) a file row with no date gets its 14 days, and 0466 dates the rows that versions had already let go of;
 *  (17) an account's usage: what it keeps counted once per content, the largest projects and tasks, each week's arrivals, and
 *       no other account's;
 *  (18) past its quota an upload is refused with a code and a sentence, at each door, and leaves nothing behind; bytes it
 *       already keeps are not refused, and expiry makes room;
 *  (19) a session in Trash waits while evidence holds one of its files, and one holding nothing goes;
 *  (20) a pin after a delete cut short says the bytes went, and the next sweep finishes the delete;
 *  (21) a pin keeps its session in Trash, on any kind of row, with everything else in it, until the pin is taken away;
 *  (22) a date ahead of a cited file keeps its session in Trash too, until the tombstone: then the purge takes the row, and
 *       evidence is left with the sha256 it recorded;
 *  (23) a person's act takes the file all the same: emptying Trash by hand, pinned or held, and deleting a task, once the
 *       sweep has dated and tombstoned its rows, though a pin outlasts the task as it outlasts any date.
 *
 * Not destructive: every row belongs to users this run creates. Each case uses bytes of its own, because a sweep looks at
 * every row in the database.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { upload } from '../auth/tenant-isolation-fixtures';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ReaperService } from '../realtime/reaper.service';
import { LET_GO_RETENTION_MS, UPLOAD_RETENTION_MS, citedFileExpiry, fileGraceMs } from './file-retention';
import { FileRetentionSweep } from './file-retention-sweep';
import { filesConfigFrom, writeHashedTempFile, type FileStore } from './file-store';
import { FILE_QUOTA_EXCEEDED, FilesService } from './files.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `file-retention-${RUN}`;
const STANDARD = 'The files say it works.';
const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;

const b62 = (id: string) => uuidToBase62(id);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
const sha256Of = (content: string) => createHash('sha256').update(content).digest('hex');
/** Bytes no other case has. */
const fresh = (name: string) => `${name} ${randomBytes(12).toString('hex')}\n`;

const SAMPLES = path.resolve(__dirname, '../../src/files/test-report-samples');

test('Orbit Files retention', { skip: !URL, concurrency: 1, timeout: 900_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-file-retention-'));
  const db: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `file-retention-${randomUUID()}`;
  const QUOTA = 1000;
  const environment = { PROVIDER_SECRET_KEY, MODEL_CATALOG_URL: 'http://127.0.0.1:9/', ORBIT_FILES_BACKEND: 'local', ORBIT_FILES_DIR: dir };
  const api = await startApiserver(url, jwtSecret, environment);
  servers.push(api);

  const config = filesConfigFrom({ ORBIT_FILES_DIR: dir });
  const files = new FilesService(db as never, config);
  const sweep = new FileRetentionSweep(db as never, files);
  /** The real sweep, told the time. */
  const sweepAt = (now: Date) => sweep.sweep(now);

  const accountOf = async (name: string) => {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const token = `${runnerId}-${RUN}`;
    const email = `${name}-${RUN}@orbit-files.invalid`;
    await db.user.create({ data: { id: ownerId, email, name, passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name, status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 3_600_000),
        tokenHash: createHash('sha256').update(token).digest('hex'),
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name, enabled: true } });
    return {
      ownerId, runnerId, workspaceId, token,
      bearer: await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email }),
    };
  };
  type Account = Awaited<ReturnType<typeof accountOf>>;
  const owner = await accountOf('owner');
  const stranger = await accountOf('stranger');

  const sessionOf = async (title: string, taskId?: string, who: Account = owner) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId: who.ownerId, creatorId: who.ownerId, workspaceId: who.workspaceId,
        assignedRunnerId: who.runnerId, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
        provider: 'claude', taskId, startsTaskWork: taskId !== undefined,
      },
    });
    return id;
  };
  const dispatcher = await sessionOf('the session that files the tasks');
  /** A task in no project: its dispatching session decides its evidence. And a run of it. */
  const workOf = async (title: string, who: Account = owner, extra: { projectId?: string } = {}) => {
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, title, ownerId: who.ownerId, creatorType: 'AGENT', creatorId: who.workspaceId,
        creatorSessionId: who === owner ? dispatcher : undefined, assigneeId: who.workspaceId, status: 'IN_PROGRESS',
        completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD, ...extra,
      },
    });
    return { taskId, runId: await sessionOf(`a run of ${title}`, taskId, who), who };
  };
  type Work = Awaited<ReturnType<typeof workOf>>;

  interface Kept { id: string; publicId: string; sha256: string; content: string; testReport?: unknown }
  const keptFile = (reply: Reply, content: string): Kept => {
    assert.equal(reply.status, 201, `the upload answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return { ...reply.json, id: toUuid(reply.json.id), publicId: b62(toUuid(reply.json.id)), sha256: reply.json.sha256, content };
  };
  /** `file_upload`, from `sessionId`. */
  const kept = async (sessionId: string, content = fresh('a file'), name = 'file.txt', who: Account = owner, fields: Record<string, string> = {}) =>
    keptFile(
      await upload(api, 'POST', `/api/runner/sessions/${b62(sessionId)}/files`, { authorization: `Bearer ${who.token}` }, { name, type: 'text/plain', content }, fields),
      content,
    );
  const asRun = (work: Work) => ({ 'x-orbit-session-id': b62(work.runId) });
  /** One new version of the task's evidence, citing these. */
  const cite = async (work: Work, ...refs: string[]) => {
    const evidence = {
      claim: `this much is true ${randomUUID()}`,
      criterion: { key: b62(work.taskId), text: STANDARD },
      checks: refs.map((ref) => ({ kind: 'FILE', ref })),
      gaps: [],
    };
    const reply = await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, work.who.token, { evidence }, asRun(work));
    assert.equal(reply.status, 201, `the version answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return { id: toUuid(reply.json.id), revision: reply.json.revision as string, submittedAt: new Date(reply.json.submittedAt), evidence };
  };
  const decide = async (work: Work, revision: string, decision: 'CONFIRM' | 'SEND_BACK') => {
    const reply = await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence/decision`, work.who.token, {
      evidenceRevision: revision, decision, ...(decision === 'SEND_BACK' ? { note: 'not yet' } : {}),
    }, { 'x-orbit-session-id': b62(dispatcher) });
    assert.equal(reply.status, 201, `the decision answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return new Date(reply.json.decidedAt);
  };
  const row = (id: string) => db.attachment.findUniqueOrThrow({ where: { id } });
  const blob = (sha256: string) => db.fileBlob.findUniqueOrThrow({ where: { sha256 } });
  const onDisk = (sha256: string) => existsSync(path.join(dir, sha256.slice(0, 2), sha256));
  const pin = async (file: Pick<Kept, 'publicId'>) => {
    const reply = await call(api, 'PUT', `/api/attachments/${file.publicId}/pin`, owner.bearer);
    assert.equal(reply.status, 200, reply.text.slice(0, 300));
  };
  const unpin = async (file: Pick<Kept, 'publicId'>) => {
    const reply = await call(api, 'DELETE', `/api/attachments/${file.publicId}/pin`, owner.bearer);
    assert.equal(reply.status, 200, reply.text.slice(0, 300));
  };
  const reaper = new ReaperService(db as never, {} as never);
  /** The real hourly purge. It reads the real clock, so a session's 30 days are in the row `toTrash` writes. */
  const purgeTrash = () => (reaper as unknown as { purgeTrash(): Promise<void> }).purgeTrash();
  const toTrash = (sessionId: string) => db.session.update({ where: { id: sessionId }, data: { deletedAt: later(new Date(), -40 * DAY) } });
  const sessionStays = async (sessionId: string) => (await db.session.count({ where: { id: sessionId } })) === 1;
  const rowStays = async (id: string) => (await db.attachment.count({ where: { id } })) === 1;
  /** The evidence card's route, for one version. */
  const cardOf = async (work: Work, revision: string) => {
    const card = await call(api, 'GET', `/api/tasks/${b62(work.taskId)}/evidence/${revision}/files`, owner.bearer);
    assert.equal(card.status, 200, card.text.slice(0, 300));
    return card.json;
  };
  /** Answered at the door `file_fetch` calls, with a status that says whether the bytes are there. */
  const bytesOf = async (file: Kept, sessionId: string, who: Account = owner) => {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(sessionId)}/attachments/${file.publicId}`, {
      headers: { authorization: `Bearer ${who.token}` },
    });
    return { status: response.status, text: await response.text() };
  };
  /** A row as it stands, with what it should never lose. */
  const describedAsItWas = async (id: string, before: Awaited<ReturnType<typeof row>>) => {
    const now = await row(id);
    for (const key of ['fileName', 'sizeBytes', 'mimeType', 'sha256', 'label', 'createdAt', 'sessionId', 'taskId', 'evidenceId', 'fileBundleId'] as const) {
      assert.deepEqual(now[key], before[key], `${key} stays when a file expires`);
    }
    assert.deepEqual(now.testReportSummary, before.testReportSummary, 'and so does its test summary');
    return now;
  };

  await t.test('(1) an upload no evidence cites expires 14 days after it was uploaded', async () => {
    const session = await sessionOf('a conversation');
    const file = await kept(session);
    const before = await row(file.id);
    assert.equal(before.retention, 'file_upload');
    assert.deepEqual(before.expiresAt, later(before.createdAt, UPLOAD_RETENTION_MS), 'the date is written with the row');
    assert.equal(UPLOAD_RETENTION_MS, 14 * DAY);
    await sweepAt(later(before.expiresAt!, -1));
    assert.equal((await row(file.id)).expiredAt, null, 'a millisecond before: nothing');
    await sweepAt(before.expiresAt!);
    const after = await describedAsItWas(file.id, before);
    assert.deepEqual(after.expiredAt, before.expiresAt, 'at its date it has a tombstone');
    assert.equal((await bytesOf(file, session)).text, file.content, 'and its bytes are still read, in the grace period');
  });

  await t.test('(2) the bytes outlast the tombstone by the grace period, and the row outlasts the bytes', async () => {
    const session = await sessionOf('a conversation');
    const file = await kept(session);
    const before = await row(file.id);
    const tombstone = before.expiresAt!;
    await sweepAt(tombstone);
    const released = (await blob(file.sha256)).releasedAt!;
    assert.deepEqual(released <= tombstone, true, 'its grace period has started');

    const almost = later(released, GRACE - 1);
    await sweepAt(almost);
    assert.ok(onDisk(file.sha256), 'a millisecond short of it, the bytes stay');
    assert.equal((await bytesOf(file, session)).status, 200);

    const end = later(released, GRACE);
    const swept = await sweepAt(end);
    assert.ok(swept.deleted >= 1, 'at the end of it, they go');
    assert.equal(onDisk(file.sha256), false, 'from the store');
    const gone = await blob(file.sha256);
    assert.deepEqual(gone.bytesDeletedAt, end);
    assert.deepEqual(gone.offHostPruneAt, later(end, GRACE), 'the off-host copy may follow a whole grace period later');
    await describedAsItWas(file.id, before);
    const read = await bytesOf(file, session);
    assert.equal(read.status, 410, 'a read says they went');
    assert.match(read.text, /expired on \d{4}-\d{2}-\d{2} and its bytes have been deleted/);
    assert.equal(JSON.parse(read.text).expiredAt, tombstone.toISOString(), 'and when, for a client\'s placeholder');
    const described = await call(api, 'GET', `/api/runner/sessions/${b62(session)}/files/${file.publicId}`, owner.token);
    assert.equal(described.status, 200, 'what describes the file is all still there');
    assert.equal(described.json.sha256, file.sha256);
    assert.equal(new Date(described.json.expiredAt).getTime(), tombstone.getTime());
    await sweepAt(later(end, GRACE));
    assert.deepEqual((await blob(file.sha256)).bytesDeletedAt, end, 'and nothing goes twice');
  });

  await t.test('(3) the grace period is never shorter than a retained backup reaches back', async () => {
    assert.equal(fileGraceMs(filesConfigFrom({})), GRACE, 'the defaults, a day between backups and two kept, are under seven days');
    assert.equal(fileGraceMs(filesConfigFrom({ ORBIT_BASE_BACKUP_KEEP: '6' })), GRACE);
    // A backup stays until that many newer ones have finished, each a little over the interval later: one more covers it.
    assert.equal(fileGraceMs(filesConfigFrom({ ORBIT_BASE_BACKUP_KEEP: '7' })), 8 * DAY);
    assert.equal(fileGraceMs(filesConfigFrom({ ORBIT_BASE_BACKUP_KEEP: '10' })), 11 * DAY);
    assert.equal(fileGraceMs(filesConfigFrom({ ORBIT_BASE_BACKUP_INTERVAL: '604800', ORBIT_BASE_BACKUP_KEEP: '4' })), 35 * DAY);
    assert.throws(() => filesConfigFrom({ ORBIT_BASE_BACKUP_KEEP: 'two' }), /ORBIT_BASE_BACKUP_KEEP must be a whole number/);
    assert.throws(() => filesConfigFrom({ ORBIT_FILES_QUOTA_BYTES: '-1' }), /ORBIT_FILES_QUOTA_BYTES must be a whole number/);

    const session = await sessionOf('a conversation');
    const file = await kept(session);
    const longer = new FileRetentionSweep(db as never, new FilesService(db as never, filesConfigFrom({ ORBIT_FILES_DIR: dir, ORBIT_BASE_BACKUP_KEEP: '10' })));
    const tombstone = (await row(file.id)).expiresAt!;
    await longer.sweep(tombstone);
    const released = (await blob(file.sha256)).releasedAt!;
    await longer.sweep(later(released, GRACE));
    assert.ok(onDisk(file.sha256), 'seven days is not enough while a backup reaches back more than ten');
    await longer.sweep(later(released, 11 * DAY - 1));
    assert.ok(onDisk(file.sha256), 'nor is a millisecond short of eleven');
    await longer.sweep(later(released, 11 * DAY));
    assert.equal(onDisk(file.sha256), false, 'eleven is');
    assert.deepEqual((await blob(file.sha256)).offHostPruneAt, later(released, 22 * DAY), 'and the off-host copy waits as long again');
  });

  await t.test('(4) a version sent back lets go of what it cites 30 days after the send-back', async () => {
    const work = await workOf('sent back');
    const file = await kept(work.runId);
    const version = await cite(work, file.publicId);
    assert.equal((await row(file.id)).expiresAt, null, 'a version waiting for a decision holds it');
    await sweepAt(later(new Date(), 400 * DAY));
    assert.equal((await row(file.id)).expiredAt, null, 'however long that takes');

    const decidedAt = await decide(work, version.revision, 'SEND_BACK');
    const dated = await row(file.id);
    assert.deepEqual(dated.expiresAt, later(decidedAt, LET_GO_RETENTION_MS));
    assert.equal(LET_GO_RETENTION_MS, 30 * DAY);
    await sweepAt(later(dated.expiresAt!, -1));
    assert.equal((await row(file.id)).expiredAt, null);
    await sweepAt(dated.expiresAt!);
    assert.deepEqual((await describedAsItWas(file.id, dated)).expiredAt, dated.expiresAt);
  });

  await t.test('(5) a version a newer one replaces lets go of what it cites, and the newer one holds its own', async () => {
    const work = await workOf('superseded');
    const first = await kept(work.runId);
    const second = await kept(work.runId);
    await cite(work, first.publicId);
    const newer = await cite(work, second.publicId);
    const dated = await row(first.id);
    assert.deepEqual(dated.expiresAt, later(newer.submittedAt, LET_GO_RETENTION_MS), '30 days after the newer one arrived');
    assert.equal((await row(second.id)).expiresAt, null);
    await sweepAt(dated.expiresAt!);
    assert.deepEqual((await row(first.id)).expiredAt, dated.expiresAt);
    assert.equal((await row(second.id)).expiredAt, null, 'the newest version holds what it cites past that');

    // A version with no file in it replaces one all the same.
    const plain = await workOf('superseded by a version citing no file');
    const cited = await kept(plain.runId);
    await cite(plain, cited.publicId);
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId: plain.runId, name: 'Bash', toolUseId, input: { command: 'true' }, isError: false } });
    const reply = await call(api, 'POST', `/api/runner/tasks/${b62(plain.taskId)}/evidence`, owner.token, {
      evidence: { claim: 'no file', criterion: { key: b62(plain.taskId), text: STANDARD }, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: [] },
    }, asRun(plain));
    assert.equal(reply.status, 201, reply.text.slice(0, 400));
    assert.deepEqual((await row(cited.id)).expiresAt, later(new Date(reply.json.submittedAt), LET_GO_RETENTION_MS));
  });

  await t.test('(6) a confirmed version holds what it cites until the task is deleted', async () => {
    const work = await workOf('confirmed');
    const old = await kept(work.runId);
    const young = await kept(work.runId);
    await db.attachment.update({ where: { id: old.id }, data: { createdAt: later(new Date(), -100 * DAY) } });
    const version = await cite(work, old.publicId, young.publicId);
    await decide(work, version.revision, 'CONFIRM');
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: work.taskId } })).status, 'DONE');
    assert.equal((await row(old.id)).expiresAt, null);
    const decades = later(new Date(), 3650 * DAY);
    await sweepAt(decades);
    assert.equal((await row(old.id)).expiredAt, null, 'however long the task stays');
    await cite(work, young.publicId);
    await sweepAt(decades);
    assert.equal((await row(old.id)).expiresAt, null, 'and a later version does not take that from it');
    assert.equal((await row(old.id)).expiredAt, null);

    const removed = await call(api, 'DELETE', `/api/tasks/${b62(work.taskId)}`, owner.bearer);
    assert.ok(removed.status < 300, `the delete answered ${removed.status}: ${removed.text.slice(0, 300)}`);
    const deletedAt = new Date();
    assert.equal((await row(old.id)).expiresAt, null, 'the next sweep is what notices');
    await sweepAt(deletedAt);
    const youngNow = await row(young.id);
    assert.deepEqual(youngNow.expiresAt, later(youngNow.createdAt, UPLOAD_RETENTION_MS), 'one younger than 14 days keeps the rest of them');
    assert.equal(youngNow.expiredAt, null);
    const oldNow = await row(old.id);
    assert.deepEqual(oldNow.expiresAt, deletedAt, 'one older expires with the task');
    assert.deepEqual(oldNow.expiredAt, deletedAt);
    await sweepAt(later(deletedAt, GRACE - 1));
    assert.ok(onDisk(old.sha256), 'its bytes have their grace period like any others');
    await sweepAt(later((await blob(old.sha256)).releasedAt!, GRACE));
    assert.equal(onDisk(old.sha256), false);
    await sweepAt(later(youngNow.expiresAt!, 0));
    assert.deepEqual((await row(young.id)).expiredAt, youngNow.expiresAt);
  });

  await t.test('(7) a pin keeps a file past any date, and taking it away lets the date apply', async () => {
    const session = await sessionOf('a conversation');
    const file = await kept(session);
    const pin = await call(api, 'PUT', `/api/attachments/${file.publicId}/pin`, owner.bearer);
    assert.equal(pin.status, 200, pin.text.slice(0, 300));
    assert.ok(pin.json.pinnedAt, 'the answer says so');
    const date = (await row(file.id)).expiresAt!;
    const decades = later(date, 3650 * DAY);
    await sweepAt(decades);
    await sweepAt(later(decades, GRACE));
    assert.equal((await row(file.id)).expiredAt, null, 'a pinned file does not expire');
    assert.ok(onDisk(file.sha256));

    const foreign = await call(api, 'PUT', `/api/attachments/${file.publicId}/pin`, stranger.bearer);
    assert.equal(foreign.status, 404, 'another account gets what an id that names nothing gets');
    assert.equal((await call(api, 'DELETE', `/api/attachments/${file.publicId}/pin`, stranger.bearer)).status, 404);
    assert.ok((await row(file.id)).pinnedAt, 'and changes nothing');

    assert.equal((await call(api, 'DELETE', `/api/attachments/${file.publicId}/pin`, owner.bearer)).status, 200);
    assert.deepEqual((await row(file.id)).expiresAt, date, 'its date never moved');
    await sweepAt(later(date, 1));
    assert.deepEqual((await row(file.id)).expiredAt, later(date, 1), 'so the next sweep gives it a tombstone');

    // Within the grace period a pin brings it back, at the runner's door this time.
    const door = `/api/runner/sessions/${b62(session)}/files/${file.publicId}/pin`;
    const back = await call(api, 'PUT', door, owner.token);
    assert.equal(back.status, 200, back.text.slice(0, 300));
    assert.equal(back.json.expiredAt, null);
    const released = (await blob(file.sha256)).releasedAt;
    await sweepAt(later(date, GRACE * 2));
    assert.ok(onDisk(file.sha256), 'a pin in the grace period keeps the bytes');
    assert.equal((await blob(file.sha256)).releasedAt, null, `no longer released, as it was at ${released?.toISOString()}`);
    assert.equal((await call(api, 'PUT', door, stranger.token)).status, 403, 'another account\'s machine hosts no such session');

    // Once the bytes have gone a pin can only say so.
    assert.equal((await call(api, 'DELETE', door, owner.token)).status, 200);
    const end = later(date, GRACE * 3);
    await sweepAt(end);
    await sweepAt(later((await blob(file.sha256)).releasedAt!, GRACE));
    assert.equal(onDisk(file.sha256), false);
    const late = await call(api, 'PUT', `/api/attachments/${file.publicId}/pin`, owner.bearer);
    assert.equal(late.status, 410);
    assert.match(late.text, /its bytes have been deleted, so it cannot be pinned/);
    assert.ok((await row(file.id)).expiredAt, 'and it stays expired');
  });

  await t.test('(8) where several versions cite a file, the latest wins', async () => {
    assert.deepEqual(citedFileExpiry(new Date(0), []), new Date(UPLOAD_RETENTION_MS));
    assert.deepEqual(citedFileExpiry(new Date(0), [new Date(1), new Date(2)]), new Date(2 + LET_GO_RETENTION_MS));
    assert.equal(citedFileExpiry(new Date(0), [new Date(1), null]), null, 'any version holding it holds it');
    assert.deepEqual(citedFileExpiry(new Date(100 * DAY), [new Date(1)]), new Date(114 * DAY), 'a later upload date is later');

    const work = await workOf('cited twice');
    const file = await kept(work.runId);
    const first = await cite(work, file.publicId);
    const firstBack = await decide(work, first.revision, 'SEND_BACK');
    assert.deepEqual((await row(file.id)).expiresAt, later(firstBack, LET_GO_RETENTION_MS));
    const second = await cite(work, file.publicId);
    assert.equal((await row(file.id)).expiresAt, null, 'the newest version holds it again');
    assert.equal((await row(file.id)).evidenceId, second.id);
    const secondBack = await decide(work, second.revision, 'SEND_BACK');
    assert.deepEqual((await row(file.id)).expiresAt, later(secondBack, LET_GO_RETENTION_MS), 'and its send-back is the later one');

    const held = await workOf('held by an older confirmed version');
    const kept2 = await kept(held.runId);
    const confirmed = await cite(held, kept2.publicId);
    await decide(held, confirmed.revision, 'CONFIRM');
    const after = await cite(held, kept2.publicId);
    await decide(held, after.revision, 'SEND_BACK');
    assert.equal((await row(kept2.id)).expiresAt, null, 'a confirmed version outlasts a later one sent back');
  });

  await t.test('(9) bytes are never deleted while any row still holds them', async () => {
    const one = await sessionOf('one conversation');
    const other = await sessionOf('another conversation');
    const content = fresh('the same bytes');
    const first = await kept(one, content);
    const second = await kept(other, content);
    assert.equal(second.sha256, first.sha256);
    await db.attachment.update({ where: { id: second.id }, data: { expiresAt: later((await row(second.id)).expiresAt!, 20 * DAY) } });
    const firstDate = (await row(first.id)).expiresAt!;
    const secondDate = (await row(second.id)).expiresAt!;
    await sweepAt(firstDate);
    assert.ok((await row(first.id)).expiredAt);
    assert.equal((await row(second.id)).expiredAt, null);
    assert.equal((await blob(first.sha256)).releasedAt, null, 'the other row still holds them');
    await sweepAt(later(firstDate, GRACE + DAY));
    assert.ok(onDisk(first.sha256), 'past the first row\'s grace period');
    assert.equal((await bytesOf(first, one)).text, content, 'and the row with a tombstone still reads them');
    await sweepAt(secondDate);
    const released = (await blob(first.sha256)).releasedAt!;
    assert.deepEqual(released, secondDate, 'the grace period starts with the last row');
    await sweepAt(later(released, GRACE - 1));
    assert.ok(onDisk(first.sha256));
    await sweepAt(later(released, GRACE));
    assert.equal(onDisk(first.sha256), false);

    // A row that never expires holds its bytes for good, a person's upload here.
    const shared = fresh('bytes a person uploaded too');
    const agents = await kept(one, shared);
    const persons = await upload(api, 'POST', '/api/attachments', { authorization: `Bearer ${owner.bearer}` }, { name: 'mine.txt', type: 'text/plain', content: shared });
    assert.equal(persons.status, 201, persons.text.slice(0, 300));
    const date = (await row(agents.id)).expiresAt!;
    await sweepAt(date);
    await sweepAt(later(date, 3650 * DAY));
    assert.ok((await row(agents.id)).expiredAt);
    assert.ok(onDisk(agents.sha256), 'a person\'s upload of the same content keeps them');
    const download = await fetch(`http://127.0.0.1:${api.port}/api/attachments/${b62(toUuid(persons.json.id))}`, { headers: { authorization: `Bearer ${owner.bearer}` } });
    assert.equal(await download.text(), shared);
  });

  await t.test('(10) a citation of a folder holds all of it, and the card\'s route answers it once it has expired', async () => {
    const work = await workOf('a folder');
    const a = await kept(work.runId, fresh('a'), 'a.txt');
    const b = await kept(work.runId, fresh('b'), 'b.txt');
    const made = await call(api, 'POST', `/api/runner/sessions/${b62(work.runId)}/file-bundles`, owner.token, {
      name: 'shots', files: [{ path: 'dir/a.txt', id: a.publicId }, { path: 'b.txt', id: b.publicId }],
    });
    assert.equal(made.status, 201, made.text.slice(0, 300));
    const manifest = toUuid(made.json.id);
    assert.deepEqual((await row(manifest)).expiresAt, later((await row(manifest)).createdAt, UPLOAD_RETENTION_MS), 'a manifest starts with 14 days too');
    const version = await cite(work, b62(manifest));
    for (const id of [manifest, a.id, b.id]) assert.equal((await row(id)).expiresAt, null, 'the manifest and each of its files are held');

    const decidedAt = await decide(work, version.revision, 'SEND_BACK');
    const date = later(decidedAt, LET_GO_RETENTION_MS);
    for (const id of [manifest, a.id, b.id]) assert.deepEqual((await row(id)).expiresAt, date, 'and let go of together');
    await sweepAt(date);
    for (const id of [manifest, a.id, b.id]) assert.deepEqual((await row(id)).expiredAt, date, 'every row gets its tombstone, the manifest\'s included');
    await sweepAt(later(date, GRACE));
    for (const sha256 of [a.sha256, b.sha256, (await row(manifest)).sha256!]) assert.equal(onDisk(sha256), false, 'and all the bytes go');

    const card = await call(api, 'GET', `/api/tasks/${b62(work.taskId)}/evidence/${version.revision}/files`, owner.bearer);
    assert.equal(card.status, 200, card.text.slice(0, 300));
    assert.equal(card.json.fileCount, 2);
    assert.deepEqual(
      card.json.files.map((file: { name: string; sizeBytes: number; sha256: string; folder: string; expiredAt: string; gone: boolean }) => (
        [file.name, file.sizeBytes, file.sha256, file.folder, new Date(file.expiredAt).getTime(), file.gone]
      )),
      [
        ['b.txt', b.content.length, b.sha256, 'shots', date.getTime(), false],
        ['dir/a.txt', a.content.length, a.sha256, 'shots', date.getTime(), false],
      ],
      'the card reads names, sizes and sha256 off the rows, with the date they expired',
    );
    const fetched = await call(api, 'GET', `/api/runner/sessions/${b62(work.runId)}/files/${b62(manifest)}`, owner.token);
    assert.equal(fetched.json.kind, 'bundle');

    // A pin on the folder is a pin on what is in it.
    const pinned = await workOf('a pinned folder');
    const c = await kept(pinned.runId, fresh('c'), 'c.txt');
    const folder = await call(api, 'POST', `/api/runner/sessions/${b62(pinned.runId)}/file-bundles`, owner.token, { name: 'kept', files: [{ path: 'c.txt', id: c.publicId }] });
    assert.equal((await call(api, 'PUT', `/api/runner/sessions/${b62(pinned.runId)}/files/${folder.json.id}/pin`, owner.token)).status, 200);
    assert.ok((await row(c.id)).pinnedAt);
    assert.equal((await call(api, 'DELETE', `/api/runner/sessions/${b62(pinned.runId)}/files/${folder.json.id}/pin`, owner.token)).status, 200);
    assert.equal((await row(c.id)).pinnedAt, null);
  });

  await t.test('(11) a reply\'s image, a person\'s upload and a task\'s input never expire', async () => {
    const work = await workOf('with an input');
    const replyImage = await upload(api, 'POST', `/api/runner/sessions/${b62(work.runId)}/attachments`, { authorization: `Bearer ${owner.token}` }, { name: 'shot.txt', type: 'text/plain', content: fresh('a reply') });
    const personal = await upload(api, 'POST', `/api/attachments?sessionId=${b62(work.runId)}`, { authorization: `Bearer ${owner.bearer}` }, { name: 'mine.txt', type: 'text/plain', content: fresh('a person') });
    const input = await upload(api, 'POST', `/api/attachments?taskId=${b62(work.taskId)}`, { authorization: `Bearer ${owner.bearer}` }, { name: 'spec.txt', type: 'text/plain', content: fresh('an input') });
    const ids = [replyImage, personal, input].map((reply) => {
      assert.equal(reply.status, 201, reply.text.slice(0, 300));
      return toUuid(reply.json.id);
    });
    for (const id of ids) {
      const stored = await row(id);
      assert.equal(stored.retention, null);
      assert.equal(stored.expiresAt, null);
    }
    const decades = later(new Date(), 3650 * DAY);
    await sweepAt(decades);
    await sweepAt(later(decades, GRACE));
    for (const id of ids) {
      const stored = await row(id);
      assert.equal(stored.expiredAt, null);
      assert.ok(onDisk(stored.sha256!));
    }
  });

  await t.test('(12) a row deleted outright lets its bytes go a grace period after they are found unnamed', async () => {
    const work = await workOf('an input removed');
    const content = fresh('an input removed');
    const input = await upload(api, 'POST', `/api/attachments?taskId=${b62(work.taskId)}`, { authorization: `Bearer ${owner.bearer}` }, { name: 'gone.txt', type: 'text/plain', content });
    assert.equal(input.status, 201);
    const sha256 = sha256Of(content);
    await db.fileBlob.update({ where: { sha256 }, data: { lastReferencedAt: later(new Date(), -100 * DAY) } });
    assert.equal((await call(api, 'DELETE', `/api/attachments/${input.json.id}`, owner.bearer)).status, 204);
    const noticed = new Date();
    await sweepAt(noticed);
    const released = (await blob(sha256)).releasedAt!;
    assert.ok(released, 'the first sweep to see it starts the grace period');
    assert.ok(onDisk(sha256), 'however long ago they were last uploaded');
    await sweepAt(later(released, GRACE - 1));
    assert.ok(onDisk(sha256));
    await sweepAt(later(released, GRACE));
    assert.equal(onDisk(sha256), false);

    // Named again before then, it starts over.
    const again = fresh('named again');
    const session = await sessionOf('a conversation');
    const firstRow = await kept(session, again);
    await db.attachment.delete({ where: { id: firstRow.id } });
    await sweepAt(new Date());
    assert.ok((await blob(firstRow.sha256)).releasedAt);
    const secondRow = await kept(session, again);
    assert.equal((await blob(firstRow.sha256)).releasedAt, null, 'an upload ends it');
    assert.equal((await bytesOf(secondRow, session)).text, again);
  });

  await t.test('(13) an upload of bytes that went keeps them again', async () => {
    const session = await sessionOf('a conversation');
    const content = fresh('kept twice');
    const first = await kept(session, content);
    const date = (await row(first.id)).expiresAt!;
    await sweepAt(date);
    await sweepAt(later((await blob(first.sha256)).releasedAt!, GRACE));
    assert.equal(onDisk(first.sha256), false);
    assert.ok((await blob(first.sha256)).bytesDeletedAt);

    const second = await kept(session, content);
    assert.ok(onDisk(first.sha256), 'they are back');
    const stored = await blob(first.sha256);
    assert.equal(stored.bytesDeletedAt, null);
    assert.equal(stored.offHostPruneAt, null, 'and the off-host copy keeps them');
    assert.equal(stored.releasedAt, null);
    assert.equal((await bytesOf(second, session)).text, content);

    // The real delete, stopped just before it removes the bytes, which it has by then decided to do. An upload of the same
    // content, or a pin, arriving now finds the bytes still there, and either would be wrong to believe it.
    const stoppedDelete = (target: string) => {
      const stopped = new FilesService(db as never, config);
      const realStoreOf = stopped.storeOf.bind(stopped);
      let reached!: () => void;
      let release!: () => void;
      const atRemove = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      stopped.storeOf = (storage: string) => {
        const store = realStoreOf(storage);
        if (!store) return store;
        return Object.assign(Object.create(store) as FileStore, {
          remove: async (sha256: string) => {
            // Other cases' bytes are due by this clock too.
            if (sha256 === target) {
              reached();
              await released;
            }
            await store.remove(sha256);
          },
        });
      };
      return { sweep: new FileRetentionSweep(db as never, stopped), atRemove, release };
    };
    const settledWithin = async (work: Promise<unknown>, ms: number) => {
      let settled = false;
      const watched = work.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { settled, watched };
    };
    const dueForDeleting = async (content: string) => {
      const file = await kept(session, content);
      await sweepAt((await row(file.id)).expiresAt!);
      return { file, due: later((await blob(file.sha256)).releasedAt!, GRACE) };
    };

    const racing = fresh('raced');
    const raced = await dueForDeleting(racing);
    const uploadDuring = stoppedDelete(raced.file.sha256);
    const sweeping = uploadDuring.sweep.sweep(raced.due);
    await uploadDuring.atRemove;
    const temp = await writeHashedTempFile(Readable.from([Buffer.from(racing)]), path.join(dir, 'tmp'));
    const storing = await settledWithin(files.store(temp), 300);
    assert.equal(storing.settled, false, 'the upload waits for the delete, rather than trusting bytes it can still see');
    uploadDuring.release();
    await sweeping;
    await storing.watched;
    assert.equal(readFileSync(path.join(dir, raced.file.sha256.slice(0, 2), raced.file.sha256), 'utf8'), racing, 'and then keeps them');
    assert.equal((await blob(raced.file.sha256)).bytesDeletedAt, null);

    const pinnedDuring = await dueForDeleting(fresh('pinned while going'));
    const pinDuring = stoppedDelete(pinnedDuring.file.sha256);
    const sweepingAgain = pinDuring.sweep.sweep(pinnedDuring.due);
    await pinDuring.atRemove;
    const pinning = await settledWithin(call(api, 'PUT', `/api/attachments/${pinnedDuring.file.publicId}/pin`, owner.bearer), 300);
    assert.equal(pinning.settled, false, 'a pin waits for the delete too, rather than lifting a tombstone from bytes about to go');
    pinDuring.release();
    await sweepingAgain;
    await pinning.watched;
    assert.equal(onDisk(pinnedDuring.file.sha256), false);
    assert.ok((await row(pinnedDuring.file.id)).expiredAt, 'and then says they went');
    assert.equal((await row(pinnedDuring.file.id)).pinnedAt, null);

    // A blob an upload stamped within the grace period is not deleted, whatever else is true of it.
    const stamped = fresh('stamped');
    const third = await kept(session, stamped);
    const thirdDate = (await row(third.id)).expiresAt!;
    await sweepAt(thirdDate);
    const releasedAt = (await blob(third.sha256)).releasedAt!;
    await db.fileBlob.update({ where: { sha256: third.sha256 }, data: { lastReferencedAt: later(releasedAt, GRACE) } });
    await sweepAt(later(releasedAt, GRACE));
    assert.ok(onDisk(third.sha256), 'an upload that found them may be about to write the row naming them');
  });

  await t.test('(14) a new version cannot cite an expired file, nor a new task take one as an input', async () => {
    const work = await workOf('citing an expired file');
    const file = await kept(work.runId);
    const version = await cite(work, file.publicId);
    await decide(work, version.revision, 'SEND_BACK');
    const date = (await row(file.id)).expiresAt!;
    await sweepAt(date);
    const refused = await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token, {
      evidence: { claim: 'again', criterion: { key: b62(work.taskId), text: STANDARD }, checks: [{ kind: 'FILE', ref: file.publicId }], gaps: [] },
    }, asRun(work));
    assert.equal(refused.status, 409, refused.text.slice(0, 300));
    assert.equal(refused.json.code, 'EVIDENCE_FILE_EXPIRED');
    assert.match(refused.json.message, /file\.txt/);
    assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: work.taskId } }), 1, 'nothing was written');

    const input = await call(api, 'POST', '/api/tasks', owner.bearer, {
      title: 'a task', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, attachmentIds: [file.publicId],
    });
    assert.equal(input.status, 400, input.text.slice(0, 300));
    assert.match(input.text, /expired file cannot be a task input/);

    // A citation in flight holds its rows, and the sweep goes round it: it does not wait, and it does not stamp a row that
    // may be about to have no date at all. Once the citation is in, there is nothing due to stamp.
    const racing = await workOf('citing while the sweep runs');
    const inFlight = await kept(racing.runId);
    const dueAt = (await row(inFlight.id)).expiresAt!;
    await sql.query('BEGIN');
    await sql.query('SELECT id FROM attachment WHERE id = $1 FOR UPDATE', [inFlight.id]);
    try {
      await sweepAt(dueAt);
    } finally {
      await sql.query('ROLLBACK');
    }
    assert.equal((await row(inFlight.id)).expiredAt, null, 'it went round the locked row');
    await cite(racing, inFlight.publicId);
    await sweepAt(dueAt);
    assert.equal((await row(inFlight.id)).expiredAt, null, 'and next time the row is no longer due');

    // Nor can a message send one again, or a retry carry a copy of it: a copy holds the bytes it names.
    const resent = await call(api, 'POST', `/api/sessions/${b62(work.runId)}/turns`, owner.bearer, {
      content: 'again', clientTurnId: randomUUID(), attachmentIds: [file.publicId],
    });
    assert.equal(resent.status, 400, resent.text.slice(0, 300));
    assert.match(resent.text, /unknown or not yours/);

    // The same evidence again is its own replay, whatever has happened to the file since.
    const replayed = await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token, { evidence: version.evidence }, asRun(work));
    assert.equal(replayed.status, 201, replayed.text.slice(0, 300));
    assert.equal(toUuid(replayed.json.id), version.id);
  });

  await t.test('(15) a real sweep takes a report\'s bytes and leaves its summary, labels and citations as they were', async () => {
    const work = await workOf('a test report');
    const report = readFileSync(path.join(SAMPLES, 'playwright-retries.json'), 'utf8');
    const file = await kept(work.runId, report, 'report.json', owner, { as: 'test-report', label: 'the suite' });
    assert.ok(file.testReport, 'the upload read it');
    const version = await cite(work, file.publicId);
    const line = 'Playwright · 6 passed · 2 failed · 6 skipped';
    const citation = async (revision: string) => {
      const ledger = await call(api, 'GET', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token);
      assert.equal(ledger.status, 200, ledger.text.slice(0, 300));
      const stored = ledger.json.find((entry: { revision: string }) => entry.revision === revision);
      return { ...stored.citations[0], digest: stored.evidenceDigest as string, refs: stored.evidence.checks };
    };
    const before = await citation(version.revision);
    assert.ok(before.label.endsWith(line), before.label);
    assert.equal(before.resolved, true);
    const beforeRow = await row(file.id);

    const decidedAt = await decide(work, version.revision, 'SEND_BACK');
    const date = later(decidedAt, LET_GO_RETENTION_MS);
    await sweepAt(date);
    await sweepAt(later((await blob(file.sha256)).releasedAt!, GRACE));
    assert.equal(onDisk(file.sha256), false, 'the sweep took the bytes');
    assert.equal((await bytesOf(file, work.runId)).status, 410);

    const after = await describedAsItWas(file.id, beforeRow);
    assert.deepEqual(after.expiredAt, date);
    assert.deepEqual(after.testReportSummary, file.testReport, 'test_report_summary is not cleared');
    assert.deepEqual(await citation(version.revision), before, 'task_evidence_list reads as it did: resolved, the same label and summary, the same digest');
    const listed = await call(api, 'GET', `/api/runner/files?evidenceId=${b62(version.id)}`, owner.token);
    assert.equal(listed.status, 200, listed.text.slice(0, 300));
    const inVersion = listed.json.files.find((entry: { publicId: string }) => entry.publicId === file.publicId);
    assert.deepEqual(inVersion.testReport, file.testReport, 'file_list of the version');
    assert.ok(inVersion.expiredAt, 'says it expired');
    const card = await call(api, 'GET', `/api/tasks/${b62(work.taskId)}/evidence/${version.revision}/files`, owner.bearer);
    assert.deepEqual(card.json.files[0].testReport, file.testReport, 'and so does the card\'s route');
    assert.equal(card.json.files[0].label, 'the suite');
  });

  await t.test('(16) a row with no date gets its 14 days, and 0466 dates what versions had already let go of', async () => {
    // What an older apiserver writes during a rolling upgrade, and what 0466 found on rows from before it.
    const session = await sessionOf('a conversation');
    const undated = await kept(session);
    await db.attachment.update({ where: { id: undated.id }, data: { expiresAt: null } });
    await sweepAt(new Date());
    const dated = await row(undated.id);
    assert.deepEqual(dated.expiresAt, later(dated.createdAt, UPLOAD_RETENTION_MS));

    const migration = readFileSync(path.resolve(__dirname, '../../prisma/migrations/0466_file_retention/migration.sql'), 'utf8');
    const backfill = migration.slice(migration.indexOf('UPDATE "attachment" AS a'));
    assert.match(backfill, /^UPDATE "attachment" AS a[\s\S]*;\s*$/, 'the statement that dates them is the last thing it does');

    const sentBack = await workOf('from before 0466, sent back');
    const a = await kept(sentBack.runId);
    const versionA = await cite(sentBack, a.publicId);
    const backAt = await decide(sentBack, versionA.revision, 'SEND_BACK');
    const replaced = await workOf('from before 0466, replaced');
    const b = await kept(replaced.runId);
    await cite(replaced, b.publicId);
    const newer = await cite(replaced, (await kept(replaced.runId)).publicId);
    const waiting = await workOf('from before 0466, waiting');
    const c = await kept(waiting.runId);
    await cite(waiting, c.publicId);
    const confirmed = await workOf('from before 0466, with a confirmed version');
    const d = await kept(confirmed.runId);
    const versionD = await cite(confirmed, d.publicId);
    await decide(confirmed, versionD.revision, 'CONFIRM');
    await cite(confirmed, (await kept(confirmed.runId)).publicId);
    const ids = [a.id, b.id, c.id, d.id];
    await db.attachment.updateMany({ where: { id: { in: ids } }, data: { expiresAt: null } });

    await sql.query(backfill);
    assert.deepEqual((await row(a.id)).expiresAt, later(backAt, LET_GO_RETENTION_MS), 'sent back');
    assert.deepEqual((await row(b.id)).expiresAt, later(newer.submittedAt, LET_GO_RETENTION_MS), 'replaced');
    assert.equal((await row(c.id)).expiresAt, null, 'still waiting for a decision: held');
    assert.equal((await row(d.id)).expiresAt, null, 'a task with a confirmed version: held, until its next decision says more');
    const ownUpload = await kept(session);
    await sql.query(backfill);
    assert.notEqual((await row(ownUpload.id)).expiresAt, null, 'it writes no row that already has a date');
  });

  await t.test('(17) an account\'s usage', async () => {
    const who = await accountOf('usage');
    const now = new Date();
    const project = randomUUID();
    await db.project.create({ data: { id: project, ownerId: who.ownerId, title: 'a project with files' } });
    const big = await workOf('a large task', who, { projectId: project });
    const small = await workOf('a small task', who);
    const loose = await sessionOf('a conversation', undefined, who);
    const sized = (length: number) => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    const inBig = sized(1000);
    await kept(big.runId, inBig, 'big.txt', who);
    await kept(big.runId, inBig, 'big-again.txt', who); // The same bytes: one content.
    await kept(big.runId, sized(500), 'more.txt', who);
    const inSmall = await kept(small.runId, sized(100), 'small.txt', who);
    await kept(loose, sized(10), 'loose.txt', who);
    await kept(small.runId, inBig, 'shared.txt', who); // Counted under both tasks, and once in the total.

    const read = async () => {
      const reply = await call(api, 'GET', '/api/attachments/usage', who.bearer);
      assert.equal(reply.status, 200, reply.text.slice(0, 300));
      return reply.json;
    };
    const usage = await read();
    assert.equal(usage.totalBytes, 1000 + 500 + 100 + 10, 'each content once');
    assert.equal(usage.fileCount, 4);
    assert.equal(usage.quotaBytes, null, 'no quota unless the deployment sets one');
    assert.deepEqual(
      usage.tasks.map(({ title, bytes, fileCount }: { title: string; bytes: number; fileCount: number }) => [title, bytes, fileCount]),
      [['a large task', 1500, 2], ['a small task', 1100, 2]],
      'tasks, largest first',
    );
    assert.equal(toUuid(usage.tasks[0].taskId), big.taskId);
    assert.deepEqual(
      usage.projects.map(({ title, bytes }: { title: string; bytes: number }) => [title, bytes]),
      [['a project with files', 1500]],
      'and projects',
    );
    assert.equal(usage.weeks.length, 8, 'eight weeks, ending with this one');
    assert.equal(usage.weeks[7].bytes, 1610, 'whatever arrived this week');
    assert.equal(usage.weeks[0].bytes, 0);
    const monday = new Date(usage.weeks[7].weekStart);
    assert.equal(monday.getUTCDay(), 1, 'a week starts on a Monday');
    assert.ok(now.getTime() - monday.getTime() < 8 * DAY);

    const old = await kept(loose, sized(70), 'old.txt', who);
    await db.attachment.update({ where: { id: old.id }, data: { createdAt: later(now, -21 * DAY) } });
    const again = await read();
    const threeWeeksAgo = new Date(again.weeks[7].weekStart).getTime() - 21 * DAY;
    assert.equal(again.weeks.find((week: { weekStart: string }) => new Date(week.weekStart).getTime() === threeWeeksAgo).bytes, 70, 'and in the week it first arrived');

    await db.attachment.update({ where: { id: inSmall.id }, data: { expiredAt: new Date() } });
    const after = await read();
    assert.equal(after.totalBytes, 1000 + 500 + 10 + 70, 'an expired file no longer counts');
    assert.equal(after.weeks[7].bytes, 1610, 'though it arrived');
    assert.equal((await call(api, 'GET', '/api/attachments/usage', stranger.bearer)).json.tasks.length, 0, 'and another account sees none of it');
  });

  await t.test('(18) past its quota an upload is refused, with a code and a sentence', async () => {
    const limited = await startApiserver(url, jwtSecret, { ...environment, ORBIT_FILES_QUOTA_BYTES: String(QUOTA) });
    servers.push(limited);
    const who = await accountOf('limited');
    const session = await sessionOf('a conversation', undefined, who);
    const sized = (length: number) => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    const inTmp = () => (existsSync(path.join(dir, 'tmp')) ? readdirSync(path.join(dir, 'tmp')).length : 0);
    const doors: Array<[string, string, Record<string, string>]> = [
      ['file_upload', `/api/runner/sessions/${b62(session)}/files`, { authorization: `Bearer ${who.token}` }],
      ['a reply\'s file', `/api/runner/sessions/${b62(session)}/attachments`, { authorization: `Bearer ${who.token}` }],
      ['a person\'s upload', '/api/attachments', { authorization: `Bearer ${who.bearer}` }],
    ];
    const content = sized(800);
    const first = await upload(limited, 'POST', doors[0][1], doors[0][2], { name: 'first.txt', type: 'text/plain', content });
    assert.equal(first.status, 201, first.text.slice(0, 300));
    const usage = await call(limited, 'GET', '/api/attachments/usage', who.bearer);
    assert.equal(usage.json.quotaBytes, QUOTA, 'Settings is told the quota');
    assert.equal(usage.json.totalBytes, 800);

    const rows = await db.attachment.count({ where: { ownerId: who.ownerId } });
    for (const [name, route, headers] of doors) {
      const before = inTmp();
      const extra = sized(201);
      const refused = await upload(limited, 'POST', route, headers, { name: 'over.txt', type: 'text/plain', content: extra });
      assert.equal(refused.status, 413, `${name} answered ${refused.status}: ${refused.text.slice(0, 300)}`);
      assert.equal(refused.json.code, FILE_QUOTA_EXCEEDED, name);
      assert.match(refused.json.message, /This account's file storage is full: 800 B of 1000 B is in use and this file is 201 B, so nothing was kept/);
      assert.equal(refused.json.usedBytes, 800);
      assert.equal(refused.json.quotaBytes, QUOTA);
      assert.equal(onDisk(sha256Of(extra)), false, 'no bytes kept');
      assert.equal(await db.fileBlob.count({ where: { sha256: sha256Of(extra) } }), 0, 'no file_blob row');
      assert.ok(inTmp() <= before, 'and no temporary file');
    }
    assert.equal(await db.attachment.count({ where: { ownerId: who.ownerId } }), rows, 'and no row');

    const exact = await upload(limited, 'POST', doors[0][1], doors[0][2], { name: 'exact.txt', type: 'text/plain', content: sized(200) });
    assert.equal(exact.status, 201, 'up to the quota itself is allowed');
    const same = await upload(limited, 'POST', doors[0][1], doors[0][2], { name: 'same.txt', type: 'text/plain', content });
    assert.equal(same.status, 201, 'bytes it already keeps cost nothing');

    // Another account has a quota of its own.
    const other = await accountOf('limited-other');
    const room = await upload(limited, 'POST', '/api/attachments', { authorization: `Bearer ${other.bearer}` }, { name: 'own.txt', type: 'text/plain', content: sized(900) });
    assert.equal(room.status, 201);

    // Expiry makes room.
    const firstRow = toUuid(first.json.id);
    await db.attachment.updateMany({ where: { ownerId: who.ownerId, sha256: (await row(firstRow)).sha256 }, data: { expiredAt: new Date() } });
    const after = await upload(limited, 'POST', doors[0][1], doors[0][2], { name: 'after.txt', type: 'text/plain', content: sized(800) });
    assert.equal(after.status, 201, after.text.slice(0, 300));
  });

  await t.test('(19) a session in Trash waits while evidence holds one of its files', async () => {
    const held = await workOf('its run went to Trash, and its evidence was confirmed');
    const file = await kept(held.runId);
    const version = await cite(held, file.publicId);
    await decide(held, version.revision, 'CONFIRM');
    await toTrash(held.runId);
    const loose = await sessionOf('nothing holds what is in this one');
    const uncited = await kept(loose);
    await toTrash(loose);

    await purgeTrash();
    assert.equal(await sessionStays(loose), false, 'past its 30 days a session goes');
    assert.equal(await rowStays(uncited.id), false, 'and what is in it, a date ahead of it or not');
    assert.equal(await sessionStays(held.runId), true, 'but not one holding a file the evidence holds');
    assert.equal((await row(file.id)).expiresAt, null);

    // A reply's image follows its session, cited or not: only what `file_upload` kept has a fate of its own.
    const replied = await workOf('its run went to Trash, and its evidence cites a reply\'s image');
    const image = await upload(api, 'POST', `/api/runner/sessions/${b62(replied.runId)}/attachments`, { authorization: `Bearer ${owner.token}` }, { name: 'shot.txt', type: 'text/plain', content: fresh('a reply') });
    assert.equal(image.status, 201, image.text.slice(0, 300));
    await cite(replied, image.json.id);
    const imageRow = await row(toUuid(image.json.id));
    assert.ok(imageRow.evidenceId, 'evidence cites it');
    assert.equal(imageRow.retention, null);
    await toTrash(replied.runId);
    await purgeTrash();
    assert.equal(await sessionStays(replied.runId), false);
  });

  await t.test('(20) a pin after a delete cut short says the bytes went, and the next sweep finishes it', async () => {
    const session = await sessionOf('a conversation');
    const file = await kept(session);
    await sweepAt((await row(file.id)).expiresAt!);
    assert.ok((await row(file.id)).expiredAt);
    // A process killed between removing the bytes and saying so.
    rmSync(path.join(dir, file.sha256.slice(0, 2), file.sha256));
    assert.equal((await blob(file.sha256)).bytesDeletedAt, null);
    const pinned = await call(api, 'PUT', `/api/attachments/${file.publicId}/pin`, owner.bearer);
    assert.equal(pinned.status, 410, pinned.text.slice(0, 300));
    assert.ok((await row(file.id)).expiredAt, 'the tombstone stays');
    assert.equal((await row(file.id)).pinnedAt, null);
    await sweepAt(later((await blob(file.sha256)).releasedAt!, GRACE));
    assert.ok((await blob(file.sha256)).bytesDeletedAt, 'the next sweep finishes what was cut short');
  });

  await t.test('(21) a pin keeps its session in Trash, on any kind of row, with everything else in it, until the pin is taken away', async () => {
    // Cited, pinned, replaced, and the replacement sent back: every date has passed, and only the pin is left holding.
    const work = await workOf('pinned, replaced, and the replacement sent back');
    const file = await kept(work.runId);
    const version = await cite(work, file.publicId);
    await pin(file);
    const replacement = await kept(work.runId);
    const newer = await cite(work, replacement.publicId);
    const decidedAt = await decide(work, newer.revision, 'SEND_BACK');
    const date = (await row(file.id)).expiresAt!;
    assert.ok(date, 'there is a date under the pin');
    const uncited = await kept(work.runId);
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId: work.runId, name: 'Bash', toolUseId, input: { command: 'true' }, isError: false } });
    await toTrash(work.runId);

    const pastAll = later(decidedAt, LET_GO_RETENTION_MS + 1);
    await sweepAt(pastAll);
    assert.ok((await row(replacement.id)).expiredAt, 'the replacement has its tombstone, so it holds nothing');
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), true, 'the session waits for the pin');
    assert.ok((await row(file.id)).pinnedAt);
    assert.equal(await db.toolCall.count({ where: { sessionId: work.runId, toolUseId } }), 1, 'with what else is in it');

    await sweepAt(later(pastAll, 2 * GRACE));
    assert.ok(onDisk(file.sha256), 'and the bytes stay, past any grace period');
    assert.equal((await bytesOf(file, work.runId)).text, file.content);
    assert.equal(onDisk(replacement.sha256), false, 'but a file nothing keeps still goes on its own date, though its session stays');
    assert.equal(onDisk(uncited.sha256), false);
    assert.equal(await rowStays(replacement.id), true, 'and keeps its row, with the session');
    const card = await cardOf(work, version.revision);
    assert.deepEqual(card.files.map((listed: { id: string; gone: boolean; expiredAt: string | null }) => [listed.id, listed.gone, listed.expiredAt]), [[file.publicId, false, null]]);

    // Taken away, its date applies at the next sweep, and then the hour's purge has nothing to wait for.
    await unpin(file);
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), true, 'cited, and with no tombstone yet, it still holds');
    const tombstone = later(pastAll, 2 * GRACE + 1);
    await sweepAt(tombstone);
    assert.deepEqual((await row(file.id)).expiredAt, tombstone);
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), false, 'then the session goes');
    assert.equal(await rowStays(file.id), false);
    assert.ok(onDisk(file.sha256), 'and the bytes have their grace period from the tombstone');
    await sweepAt(later(tombstone, GRACE - 1));
    assert.ok(onDisk(file.sha256));
    await sweepAt(later(tombstone, GRACE));
    assert.equal(onDisk(file.sha256), false);

    // Nothing has to cite it: an upload in a conversation, whose date is ahead of it or behind it.
    const conversation = await sessionOf('a conversation');
    const note = await kept(conversation);
    await pin(note);
    await toTrash(conversation);
    await purgeTrash();
    assert.equal(await sessionStays(conversation), true, 'a pinned upload no evidence cites');
    await unpin(note);
    await purgeTrash();
    assert.equal(await sessionStays(conversation), false, 'and without the pin nothing keeps it');

    // A row with no date to pass: a reply's image, and a person's own upload.
    for (const door of ['attachments', 'person'] as const) {
      const replied = await sessionOf('a conversation with a file that never expires');
      const uploaded = door === 'attachments'
        ? await upload(api, 'POST', `/api/runner/sessions/${b62(replied)}/attachments`, { authorization: `Bearer ${owner.token}` }, { name: 'shot.txt', type: 'text/plain', content: fresh('a reply') })
        : await upload(api, 'POST', `/api/attachments?sessionId=${b62(replied)}`, { authorization: `Bearer ${owner.bearer}` }, { name: 'mine.txt', type: 'text/plain', content: fresh('a person') });
      assert.equal(uploaded.status, 201, uploaded.text.slice(0, 300));
      const stored = await row(toUuid(uploaded.json.id));
      assert.equal(stored.retention, null);
      await pin({ publicId: b62(stored.id) });
      await toTrash(replied);
      await purgeTrash();
      assert.equal(await sessionStays(replied), true, door);
      await unpin({ publicId: b62(stored.id) });
      await purgeTrash();
      assert.equal(await sessionStays(replied), false, door);
    }

    // A pin on a folder is on each file in it, and one on a single file in it is enough.
    const foldered = await sessionOf('a conversation with a folder');
    const a = await kept(foldered, fresh('a'), 'a.txt');
    const b = await kept(foldered, fresh('b'), 'b.txt');
    const made = await call(api, 'POST', `/api/runner/sessions/${b62(foldered)}/file-bundles`, owner.token, { name: 'kept', files: [{ path: 'a.txt', id: a.publicId }, { path: 'b.txt', id: b.publicId }] });
    assert.equal(made.status, 201, made.text.slice(0, 300));
    await pin({ publicId: made.json.id });
    await toTrash(foldered);
    await purgeTrash();
    assert.equal(await sessionStays(foldered), true, 'a pinned folder');
    await unpin({ publicId: made.json.id });
    await pin(b);
    await purgeTrash();
    assert.equal(await sessionStays(foldered), true, 'a pinned file of it');
    await unpin(b);
    await purgeTrash();
    assert.equal(await sessionStays(foldered), false);
  });

  await t.test('(22) a date ahead of a cited file keeps its session in Trash until the tombstone, and then the row goes with it', async () => {
    const report = readFileSync(path.join(SAMPLES, 'playwright-retries.json'), 'utf8');
    const cases: Array<[string, (work: Work, revision: string) => Promise<void>]> = [
      ['sent back', async (work, revision) => { await decide(work, revision, 'SEND_BACK'); }],
      // By a version citing no file, so that nothing else in this session holds it.
      ['replaced', async (work) => {
        const toolUseId = `toolu_${randomUUID()}`;
        await db.toolCall.create({ data: { sessionId: work.runId, name: 'Bash', toolUseId, input: { command: 'true' }, isError: false } });
        const reply = await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token, {
          evidence: { claim: 'no file', criterion: { key: b62(work.taskId), text: STANDARD }, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: [] },
        }, asRun(work));
        assert.equal(reply.status, 201, reply.text.slice(0, 300));
      }],
    ];
    for (const [how, letGo] of cases) {
      const work = await workOf(`a session in Trash, whose file was ${how}`);
      // Bytes of its own: the same JSON, and a different number of newlines after it.
      const file = await kept(work.runId, report + '\n'.repeat(1 + cases.findIndex(([name]) => name === how)), 'report.json', owner, { as: 'test-report', label: 'the suite' });
      assert.ok(file.testReport, how);
      const version = await cite(work, file.publicId);
      const before = await call(api, 'GET', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token);
      const digest = before.json.find((entry: { revision: string }) => entry.revision === version.revision).evidenceDigest;
      await letGo(work, version.revision);
      const date = (await row(file.id)).expiresAt!;
      assert.ok(date.getTime() > Date.now() + 29 * DAY, `${how}: it has its 30 days`);
      await toTrash(work.runId);

      await purgeTrash();
      assert.equal(await sessionStays(work.runId), true, `${how}: the 30 days are the file's, though the session's 30 are up`);
      await sweepAt(later(date, -1));
      await purgeTrash();
      assert.equal(await sessionStays(work.runId), true, `${how}: to the last millisecond`);
      assert.equal((await cardOf(work, version.revision)).files[0].gone, false);

      await sweepAt(date);
      assert.deepEqual((await row(file.id)).expiredAt, date, `${how}: a tombstone on its date`);
      const released = (await blob(file.sha256)).releasedAt!;
      await purgeTrash();
      assert.equal(await sessionStays(work.runId), false, `${how}: then the session goes`);
      assert.equal(await rowStays(file.id), false, `${how}: and the row with it, its name and test summary too`);

      // What that leaves evidence that cited it: the version as it was, and the sha256 it recorded.
      const after = await call(api, 'GET', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token);
      const stored = after.json.find((entry: { revision: string }) => entry.revision === version.revision);
      assert.equal(stored.evidenceDigest, digest, how);
      assert.equal(stored.evidence.checks[0].sha256, file.sha256, how);
      assert.equal(stored.citations[0].resolved, false, how);
      const [gone] = (await cardOf(work, version.revision)).files;
      assert.deepEqual([gone.id, gone.gone, gone.sha256, gone.name, gone.testReport], [file.publicId, true, file.sha256, null, null], how);

      await sweepAt(later(released, GRACE - 1));
      assert.ok(onDisk(file.sha256), `${how}: the bytes keep their grace period, though no row names them`);
      await sweepAt(later(released, GRACE));
      assert.equal(onDisk(file.sha256), false, how);
      assert.ok((await blob(file.sha256)).bytesDeletedAt, how);
    }

    // A cited folder holds it the same way.
    const work = await workOf('a session in Trash, with a cited folder');
    const member = await kept(work.runId, fresh('a member'), 'member.txt');
    const made = await call(api, 'POST', `/api/runner/sessions/${b62(work.runId)}/file-bundles`, owner.token, { name: 'shots', files: [{ path: 'member.txt', id: member.publicId }] });
    assert.equal(made.status, 201, made.text.slice(0, 300));
    const version = await cite(work, made.json.id);
    await decide(work, version.revision, 'SEND_BACK');
    await toTrash(work.runId);
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), true, 'a cited folder');
    await sweepAt((await row(member.id)).expiresAt!);
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), false);
  });

  await t.test('(24) a Trash note is told what the purge goes by, and only in Trash', async () => {
    const noteOf = async (sessionId: string) => {
      const reply = await call(api, 'GET', `/api/sessions/${b62(sessionId)}`, owner.bearer);
      assert.equal(reply.status, 200, reply.text.slice(0, 300));
      return reply.json.trashHold;
    };
    // Both rows of the rule at once, and each going in turn: the note and the purge read the same thing at every step.
    const work = await workOf('a pin and a citation in one session');
    const pinned = await kept(work.runId);
    const cited = await kept(work.runId);
    const version = await cite(work, cited.publicId);
    await pin(pinned);
    assert.equal(await noteOf(work.runId), null, 'not in Trash, nothing to say');
    await toTrash(work.runId);
    assert.equal(await noteOf(work.runId), 'PINNED_FILE', 'with both, the one only a person can end');
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), true);

    await unpin(pinned);
    assert.equal(await noteOf(work.runId), 'CITED_FILE', 'the pin gone, evidence still holds it');
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), true);

    const decidedAt = await decide(work, version.revision, 'SEND_BACK');
    await sweepAt(later(decidedAt, LET_GO_RETENTION_MS + 1));
    assert.ok((await row(cited.id)).expiredAt, 'the citation\'s date has passed');
    assert.equal(await noteOf(work.runId), null, 'a tombstone holds nothing');
    await purgeTrash();
    assert.equal(await sessionStays(work.runId), false, 'and the purge agrees');

    // A pin on a row that is no agent's file holds as well.
    const replied = await sessionOf('a reply\'s image, pinned');
    const image = await upload(api, 'POST', `/api/runner/sessions/${b62(replied)}/attachments`, { authorization: `Bearer ${owner.token}` }, { name: 'shot.txt', type: 'text/plain', content: fresh('a reply') });
    assert.equal(image.status, 201, image.text.slice(0, 300));
    await pin({ publicId: b62(toUuid(image.json.id)) });
    await toTrash(replied);
    assert.equal(await noteOf(replied), 'PINNED_FILE');

    const loose = await sessionOf('nothing holds this one');
    await kept(loose);
    await toTrash(loose);
    assert.equal(await noteOf(loose), null);
    assert.equal((await call(api, 'GET', `/api/sessions/${b62(loose)}`, stranger.bearer)).status, 404, 'and another account is told nothing');
  });

  await t.test('(25) a receipt says whether the version it answered cites a file, and nothing more', async () => {
    const withFile = await workOf('its evidence cites a file');
    const file = await kept(withFile.runId);
    const version = await cite(withFile, file.publicId);
    await decide(withFile, version.revision, 'SEND_BACK');
    const withoutFile = await workOf('its evidence cites a tool call');
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId: withoutFile.runId, name: 'Bash', toolUseId, input: { command: 'true' }, isError: false } });
    const submitted = await call(api, 'POST', `/api/runner/tasks/${b62(withoutFile.taskId)}/evidence`, owner.token, {
      evidence: { claim: 'ran', criterion: { key: b62(withoutFile.taskId), text: STANDARD }, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: [] },
    }, asRun(withoutFile));
    assert.equal(submitted.status, 201, submitted.text.slice(0, 300));
    await decide(withoutFile, submitted.json.revision, 'CONFIRM');

    const queue = await call(api, 'GET', `/api/tasks/evidence-decisions/pending?decidingSessionId=${b62(dispatcher)}`, owner.bearer);
    assert.equal(queue.status, 200, queue.text.slice(0, 300));
    const receipt = (work: Work) => queue.json.decided.find((row: { taskId: string }) => row.taskId === b62(work.taskId));
    assert.equal(receipt(withFile).citesFiles, true);
    assert.equal(receipt(withoutFile).citesFiles, false);
    assert.deepEqual(Object.keys(receipt(withFile)).sort(), [
      'citesFiles', 'decidedAt', 'decidedByType', 'decision', 'evidenceRevision', 'note', 'projectId', 'projectPublicId', 'taskId', 'taskPublicId', 'title',
    ], 'no citation, no envelope');
  });

  await t.test('(23) a person\'s act takes the file: emptying Trash by hand, and deleting a task', async () => {
    const byHand = async (sessionId: string) => {
      const reply = await call(api, 'DELETE', `/api/sessions/${b62(sessionId)}/purge`, owner.bearer);
      assert.ok(reply.status < 300, `the purge answered ${reply.status}: ${reply.text.slice(0, 300)}`);
    };
    const shows = async (work: Work, revision: string, file: Kept) => {
      const [gone] = (await cardOf(work, revision)).files;
      assert.deepEqual([gone.id, gone.gone, gone.sha256], [file.publicId, true, file.sha256]);
    };
    const bytesGoAfterGrace = async (file: Kept) => {
      const noticed = new Date();
      await sweepAt(noticed);
      const released = (await blob(file.sha256)).releasedAt!;
      assert.ok(released, 'the next sweep starts their grace period');
      await sweepAt(later(released, GRACE - 1));
      assert.ok(onDisk(file.sha256));
      await sweepAt(later(released, GRACE));
      assert.equal(onDisk(file.sha256), false);
    };

    const pinned = await workOf('emptied by hand, a pinned file');
    const pinnedFile = await kept(pinned.runId);
    const pinnedVersion = await cite(pinned, pinnedFile.publicId);
    await pin(pinnedFile);
    const dated = await workOf('emptied by hand, a date ahead');
    const datedFile = await kept(dated.runId);
    const datedVersion = await cite(dated, datedFile.publicId);
    await decide(dated, datedVersion.revision, 'SEND_BACK');
    const confirmed = await workOf('emptied by hand, a confirmed version');
    const confirmedFile = await kept(confirmed.runId);
    const confirmedVersion = await cite(confirmed, confirmedFile.publicId);
    await decide(confirmed, confirmedVersion.revision, 'CONFIRM');
    for (const [work, version, file] of [[pinned, pinnedVersion, pinnedFile], [dated, datedVersion, datedFile], [confirmed, confirmedVersion, confirmedFile]] as const) {
      await toTrash(work.runId);
      await purgeTrash();
      assert.equal(await sessionStays(work.runId), true, 'the hour\'s purge leaves it');
      await byHand(work.runId);
      assert.equal(await sessionStays(work.runId), false, 'and a person does not');
      assert.equal(await rowStays(file.id), false, 'with the file');
      await shows(work, version.revision, file);
      await bytesGoAfterGrace(file);
    }

    // Deleting a task: an old file's date is the deletion, so the first sweep tombstones it and the next purge takes it.
    const aged = await workOf('a task deleted, its old file in Trash');
    const agedFile = await kept(aged.runId);
    await db.attachment.update({ where: { id: agedFile.id }, data: { createdAt: later(new Date(), -60 * DAY) } });
    const agedVersion = await cite(aged, agedFile.publicId);
    await decide(aged, agedVersion.revision, 'CONFIRM');
    await toTrash(aged.runId);
    await purgeTrash();
    assert.equal(await sessionStays(aged.runId), true, 'until the task is deleted');
    const removeTask = async (work: Work) => {
      const removed = await call(api, 'DELETE', `/api/tasks/${b62(work.taskId)}`, owner.bearer);
      assert.ok(removed.status < 300, `the delete answered ${removed.status}: ${removed.text.slice(0, 300)}`);
    };
    await removeTask(aged);
    await purgeTrash();
    assert.equal(await sessionStays(aged.runId), true, 'the sweep has not seen it yet');
    const deletedAt = new Date();
    await sweepAt(deletedAt);
    assert.deepEqual((await row(agedFile.id)).expiredAt, deletedAt, 'the sweep dates it and gives it a tombstone at once');
    await purgeTrash();
    assert.equal(await sessionStays(aged.runId), false, 'and then the session goes');
    assert.equal(await rowStays(agedFile.id), false);
    await sweepAt(later(deletedAt, GRACE));
    assert.equal(onDisk(agedFile.sha256), false, 'and the bytes a grace period on');

    // A file younger than 14 days keeps what is left of them first, as it does outside Trash.
    const young = await workOf('a task deleted, its young file in Trash');
    const youngFile = await kept(young.runId);
    const youngVersion = await cite(young, youngFile.publicId);
    await decide(young, youngVersion.revision, 'CONFIRM');
    await toTrash(young.runId);
    await removeTask(young);
    await sweepAt(new Date());
    const youngDate = (await row(youngFile.id)).expiresAt!;
    assert.deepEqual(youngDate, later((await row(youngFile.id)).createdAt, UPLOAD_RETENTION_MS));
    await purgeTrash();
    assert.equal(await sessionStays(young.runId), true, 'a date ahead of it');
    await sweepAt(youngDate);
    await purgeTrash();
    assert.equal(await sessionStays(young.runId), false);

    // A pin outlasts its task, as it outlasts any date: it takes the person who put it there, or who empties Trash.
    const kept2 = await workOf('a task deleted, its file pinned');
    const keptFile = await kept(kept2.runId);
    const keptVersion = await cite(kept2, keptFile.publicId);
    await decide(kept2, keptVersion.revision, 'CONFIRM');
    await pin(keptFile);
    await toTrash(kept2.runId);
    await removeTask(kept2);
    const decades = later(new Date(), 3650 * DAY);
    await sweepAt(decades);
    await purgeTrash();
    assert.equal(await sessionStays(kept2.runId), true);
    assert.equal((await row(keptFile.id)).expiredAt, null);
    assert.ok(onDisk(keptFile.sha256));
    await unpin(keptFile);
    await sweepAt(later(decades, 1));
    await purgeTrash();
    assert.equal(await sessionStays(kept2.runId), false);
  });
});
