/**
 * Evidence that cites a file (docs/orbit-files-design.md §2.4, §2.7), held against the production apiserver — `build/main.js`
 * and every guard and pipe in front of the routes — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/file-evidence.pg.spec.ts
 *
 *   (1) a FILE check of a file, an image and a folder bundle is saved holding the file's public id, its sha256 and an image's
 *       size; the digest is of that, the receipt and `task_evidence_list` say what each file is, and the revision is what
 *       each cited file names, a bundle's files included;
 *   (2) only reformatting replays the revision and keeps the digest, a file's other spelling included; other bytes under the
 *       same name are other evidence;
 *   (3) another task's file is refused as out of scope; a file that is not there, a malformed id and another account's file
 *       are refused alike, whole, beside a citation that resolved; a submitter's own sha256, width or height are refused.
 *       None of them writes anything;
 *   (4) who reads a cited file, at both doors file_fetch calls: the uploading session, the project's coordinator, a judgment
 *       session opened for the project and a verifier of the task. Nobody else: another session of the account, a run of
 *       another task, a verifier of another task, another run of this task, another machine, another account;
 *  (4b) the session that did the work judges nothing, even as the project's coordinator, the session that dispatched the
 *       task or a verifier of it;
 *   (5) a bundle's files come with it, a file cited alone does not bring its neighbours, and an uncited file stays its
 *       session's. What is asked is who judges the task now: a replaced coordinator and a project the task left read nothing;
 *   (6) the coordinator is told each cited file and the call that fetches it, and evidence with no FILE check reads as ever;
 *   (7) in no project the dispatching session judges: it reads the files, and its review block lists them;
 *   (8) `file_list` by evidence version answers what that version cites, for an older version too, and a bundle as one row;
 *   (9) a row from before Orbit Files is given its sha256 when it is cited, and a task's input may be cited;
 *  (10) the app's door saves evidence the same way.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { Prisma, PrismaClient, RunStatus } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { evidenceReviewBlock } from './evidence-review';
import { completionDigest } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `file-evidence-${RUN}`;
const STANDARD = 'the evidence cites the files it is about';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b62 = (id: string) => uuidToBase62(id);

/** The first 24 bytes of a PNG of that size, which is all anything here reads of one, and then some noise. */
function png(width: number, height: number, noise = randomBytes(1000)): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, noise]);
}

/** POST one file as multipart, with fetch, which keeps its bytes apart from any text handling. Its name goes as RFC 5987
 * `filename*`, the way the runner sends one a quoted string cannot carry. */
async function upload(server: Apiserver, route: string, token: string, name: string, type: string, bytes: Buffer): Promise<Reply> {
  const boundary = `file-evidence-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename*=utf-8''${encodeURIComponent(name)}; name=file\r\nContent-Type: ${type}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text), text, headers: {} };
}

/** A file as this spec holds it: its row's id, and the id an agent is shown. */
interface Kept {
  id: string;
  publicId: string;
  sha256: string;
  bytes: Buffer;
}

/** The doors spell `id` differently (the upload door is the machine protocol, the bundle door the tool API). */
const kept = (answer: { id: string; sha256: string }, bytes: Buffer): Kept => ({
  id: toUuid(answer.id),
  publicId: b62(toUuid(answer.id)),
  sha256: answer.sha256,
  bytes,
});

test('evidence that cites a file', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-file-evidence-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `file-evidence-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;

  /** An account, with a machine that stays online and a workspace on it. */
  const accountOf = async (name: string) => {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const token = `${runnerId}-${RUN}`;
    const email = `${name}-${RUN}@file-evidence.invalid`;
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
  const secondMachine = await accountOf('second-machine');
  await db.runner.update({ where: { id: secondMachine.runnerId }, data: { ownerId: owner.ownerId } });

  const sessionOf = async (title: string, taskId?: string, who: Account = owner, status: RunStatus = 'AWAITING_INPUT') => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId: who.ownerId, creatorId: who.ownerId, workspaceId: who.workspaceId,
        assignedRunnerId: who.runnerId, status, startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
        provider: 'claude', taskId, startsTaskWork: taskId !== undefined,
      },
    });
    return id;
  };
  /** A project with Automatic on, coordinated from a live conversation, and the one criterion its tasks declare. */
  const projectOf = async (title: string, who: Account = owner) => {
    const id = randomUUID();
    const coordinator = await sessionOf(`coordinating ${title}`, undefined, who);
    await db.project.create({
      data: {
        id, ownerId: who.ownerId, title, coordinatorEnabled: true, coordinatorWorkspaceId: who.workspaceId,
        coordinatorSessionId: coordinator,
      },
    });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    const definitionId = randomUUID();
    await db.projectAcceptanceCriterionDefinition.create({
      data: { id: definitionId, projectId: id, ordinal: 1, text: STANDARD, verificationMethod: 'read it', contentHash: '0'.repeat(64) },
    });
    return { id, coordinator, definitionId };
  };
  type Project = Awaited<ReturnType<typeof projectOf>>;
  const taskOf = async (title: string, on: Project | null, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}, who: Account = owner) => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, title, ownerId: who.ownerId, creatorType: 'USER', creatorId: who.ownerId, assigneeId: who.workspaceId,
        status: 'IN_PROGRESS', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
        ...(on ? { projectId: on.id, criterionDefinitionId: on.definitionId, criterionRevision: 1 } : {}),
        ...extra,
      },
    });
    return id;
  };
  /** A task, its run, and a tool call of the run's to cite beside a file. */
  const workOf = async (title: string, on: Project | null, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}, who: Account = owner) => {
    const taskId = await taskOf(title, on, extra, who);
    const sessionId = await sessionOf(`a run of ${title}`, taskId, who);
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
    const key = on ? b62(on.definitionId) : b62(taskId);
    return { taskId, sessionId, who, key, tool: { kind: 'TOOL_CALL', ref: toolUseId } };
  };
  type Work = Awaited<ReturnType<typeof workOf>>;

  /** What a session is answered for a file, at the two doors `file_fetch` calls in turn. */
  const read = async (sessionId: string, fileId: string, token = owner.token) => {
    const described = await call(api, 'GET', `/api/runner/sessions/${b62(sessionId)}/files/${fileId}`, token);
    const bytes = await fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(sessionId)}/attachments/${fileId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { described, status: bytes.status, data: Buffer.from(await bytes.arrayBuffer()) };
  };
  const created = (reply: Reply, what: string) => {
    assert.equal(reply.status, 201, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return reply.json;
  };
  const uploaded = async (sessionId: string, name: string, bytes: Buffer = randomBytes(300), type = 'application/octet-stream', who = owner): Promise<Kept> => (
    kept(created(await upload(api, `/api/runner/sessions/${b62(sessionId)}/files`, who.token, name, type, bytes), name), bytes)
  );
  /** A folder of these files. Its bytes are its manifest, read back so that they can be held to its sha256. */
  const bundled = async (sessionId: string, files: { path: string; file: Kept }[]): Promise<Kept> => {
    const made = created(await call(api, 'POST', `/api/runner/sessions/${b62(sessionId)}/file-bundles`, owner.token, {
      name: 'shots', files: files.map(({ path: filePath, file }) => ({ path: filePath, id: file.publicId })),
    }), 'the bundle');
    return kept(made, (await read(sessionId, b62(toUuid(made.id)))).data);
  };
  const envelope = (work: Work, checks: unknown[], claim = 'the files show it') => ({
    claim, criterion: { key: work.key, text: STANDARD }, checks, gaps: [],
  });
  const asFile = (file: { publicId: string }) => ({ kind: 'FILE', ref: file.publicId });
  /** A submission at the runner's door, from the run. */
  const submit = (work: Work, checks: unknown[], claim?: string) =>
    call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, work.who.token, { evidence: envelope(work, checks, claim) }, {
      'x-orbit-session-id': work.sessionId,
    });
  const revisions = (taskId: string) => db.taskCompletionEvidence.count({ where: { taskId } });
  /** The revision each file names as the newest to cite it. */
  const citingRevisions = async (files: Kept[]) => Object.fromEntries((await db.attachment.findMany({
    where: { id: { in: files.map((file) => file.id) } },
    select: { id: true, evidenceId: true },
  })).map(({ id, evidenceId }) => [id, evidenceId]));

  const reads = async (sessionId: string, file: Kept, who: string) => {
    const answer = await read(sessionId, file.publicId);
    assert.equal(answer.described.status, 200, `${who} describing it: ${answer.described.text}`);
    assert.equal(answer.described.json.sha256, sha256(file.bytes), who);
    assert.equal(answer.status, 200, `${who} reading it`);
    assert.ok(answer.data.equals(file.bytes), `${who} reads the bytes the citation binds`);
  };
  const readsNothing = async (sessionId: string, file: Kept, who: string, token = owner.token, status = 404) => {
    const answer = await read(sessionId, file.publicId, token);
    assert.deepEqual([answer.described.status, answer.status], [status, status], who);
  };

  const project = await projectOf('the project');
  const work = await workOf('the work', project);
  const neighbour = await workOf('a neighbour', project);

  const shot = await uploaded(work.sessionId, 'shot.png', png(1280, 800), 'image/png');
  const report = await uploaded(work.sessionId, 'report.json', randomBytes(3 * 1024 * 1024), 'application/json');
  const one = await uploaded(work.sessionId, 'one.png', png(10, 20), 'image/png');
  const two = await uploaded(work.sessionId, 'two.png', png(30, 40), 'image/png');
  const folder = await bundled(work.sessionId, [{ path: 'phone/one.png', file: one }, { path: 'phone/two.png', file: two }]);
  const uncited = await uploaded(work.sessionId, 'uncited.txt');
  const cited = [work.tool, asFile(shot), asFile(report), asFile(folder)];
  let first: { id: string; revision: string; evidenceDigest: string };

  await t.test('(1) a FILE check is saved holding its sha256, and the digest is of that', async () => {
    const receipt = created(await submit(work, cited), 'the evidence');
    first = receipt;
    assert.deepEqual(receipt.evidence.checks, [
      work.tool,
      { kind: 'FILE', ref: shot.publicId, sha256: sha256(shot.bytes), width: 1280, height: 800 },
      { kind: 'FILE', ref: report.publicId, sha256: sha256(report.bytes) },
      { kind: 'FILE', ref: folder.publicId, sha256: folder.sha256 },
    ]);
    const row = await db.taskCompletionEvidence.findFirstOrThrow({ where: { taskId: work.taskId } });
    assert.equal(row.evidenceDigest, completionDigest(row.evidence), 'the digest is of what is stored');
    assert.deepEqual(row.evidence, receipt.evidence);

    const files = receipt.citations.filter((citation: { kind: string }) => citation.kind === 'FILE');
    assert.deepEqual(
      files.map(({ label, resolved }: { label: string; resolved: boolean }) => [label, resolved]),
      [
        ['shot.png · 1 KB · image/png · 1280×800', true],
        ['report.json · 3.0 MB · application/json', true],
        ['2 files · 2 KB', true],
      ],
    );
    assert.equal(files[0].sha256, sha256(shot.bytes));
    assert.deepEqual([files[0].width, files[0].height], [1280, 800]);

    const ledger = await call(api, 'GET', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token);
    assert.deepEqual(
      ledger.json[0].citations.map(({ label }: { label: string }) => label).slice(1),
      files.map(({ label }: { label: string }) => label),
      'task_evidence_list says what each file is',
    );

    const revision = toUuid(first.id);
    assert.deepEqual(
      await citingRevisions([shot, report, folder, one, two, uncited]),
      {
        [shot.id]: revision, [report.id]: revision, [folder.id]: revision, [one.id]: revision, [two.id]: revision,
        [uncited.id]: null,
      },
      'what cites each file, a bundle\'s files with it, and nothing for a file it does not cite',
    );
  });

  await t.test('(1b) a revision that cites no file reads as it always did', async () => {
    const plain = created(await submit(neighbour, [neighbour.tool]), 'evidence with no file');
    assert.deepEqual(plain.evidence.checks, [neighbour.tool]);
    assert.equal(plain.evidenceDigest, completionDigest(envelope(neighbour, [neighbour.tool])), 'the digest of what was sent');
    const ledger = await call(api, 'GET', `/api/runner/tasks/${b62(neighbour.taskId)}/evidence`, owner.token);
    assert.deepEqual(
      ledger.json[0].citations.map(({ kind, resolved }: { kind: string; resolved: boolean }) => [kind, resolved]),
      [['TOOL_CALL', true]],
      'its citations are told as of the read, a tool call\'s as much as a file\'s',
    );
  });

  await t.test('(2) only reformatting keeps the digest, and other bytes do not', async () => {
    const decomposed = 'café';
    const composed = 'café';
    const asFirst = created(await submit(work, cited, `one\r\ntwo ${decomposed}`), 'a claim with a line ending and a composition');
    const reformatted = envelope(work, [
      work.tool,
      { ref: shot.id, kind: 'FILE' },
      { ref: report.publicId, kind: 'FILE' },
      { ref: folder.id.toUpperCase(), kind: 'FILE' },
    ], `one\ntwo ${composed}`);
    const reordered = { gaps: reformatted.gaps, checks: reformatted.checks, criterion: reformatted.criterion, claim: reformatted.claim };
    const again = created(
      await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, owner.token, { evidence: reordered }, {
        'x-orbit-session-id': work.sessionId,
      }),
      'the same evidence, laid out otherwise',
    );
    assert.equal(again.id, asFirst.id, 'the same revision');
    assert.equal(again.evidenceDigest, asFirst.evidenceDigest);
    assert.notEqual(asFirst.evidenceDigest, first.evidenceDigest, 'a different claim is different evidence');

    const replaced = await uploaded(work.sessionId, 'shot.png', png(1280, 800), 'image/png');
    const other = created(await submit(work, [work.tool, asFile(replaced), asFile(report), asFile(folder)], `one\ntwo ${composed}`), 'the same words over other bytes');
    assert.notEqual(other.evidenceDigest, asFirst.evidenceDigest, 'other bytes under the same name are other evidence');
    assert.notEqual(other.id, asFirst.id);
    const reread = created(await submit(work, [work.tool, asFile(replaced), asFile(report), asFile(folder)], `one\ntwo ${composed}`), 'that again');
    assert.equal(reread.id, other.id);
  });

  await t.test('(3) a citation that is not this task\'s is refused whole, and writes nothing', async () => {
    const foreign = await uploaded(neighbour.sessionId, 'theirs.png');
    const looseSession = await sessionOf('a conversation of no task');
    const loose = await uploaded(looseSession, 'loose.png');
    const strangersWork = await workOf('a stranger\'s work', null, {}, stranger);
    const strangers = await uploaded(strangersWork.sessionId, 'secret.png', randomBytes(64), 'image/png', stranger);
    const before = { revisions: await revisions(work.taskId), stamped: await db.attachment.count({ where: { ownerId: owner.ownerId, evidenceId: { not: null } } }) };

    for (const [what, file] of [['a file of another task', foreign], ['a file of no task', loose]] as const) {
      const answer = await submit(work, [work.tool, asFile(file)]);
      assert.equal(answer.status, 400, `${what}: ${answer.text}`);
      assert.equal(answer.json.code, 'EVIDENCE_CITATION_OUT_OF_SCOPE', what);
      assert.equal(answer.json.requiredAction, 'CITE_THIS_TASKS_OWN_ROWS', what);
    }
    const nothing = await submit(work, [work.tool, { kind: 'FILE', ref: b62(randomUUID()) }]);
    assert.equal(nothing.status, 400, nothing.text);
    assert.equal(nothing.json.code, 'EVIDENCE_FILE_NOT_FOUND', 'a citation that resolved beside it does not save it');
    const theirs = await submit(work, [work.tool, asFile(strangers)]);
    assert.deepEqual({ status: theirs.status, json: theirs.json }, { status: nothing.status, json: nothing.json }, 'another account\'s file is a file that is not there');
    const malformed = await submit(work, [work.tool, { kind: 'FILE', ref: 'not an id' }]);
    assert.deepEqual({ status: malformed.status, json: malformed.json }, { status: nothing.status, json: nothing.json });

    for (const field of [{ sha256: 'a'.repeat(64) }, { width: 1, height: 1 }]) {
      const written = await submit(work, [work.tool, { ...asFile(shot), ...field }]);
      assert.equal(written.status, 400, written.text);
      assert.equal(written.json.code, 'EVIDENCE_ENVELOPE_INVALID', 'only the server writes these');
    }
    const onAToolCall = await submit(work, [{ ...work.tool, sha256: 'a'.repeat(64) }]);
    assert.equal(onAToolCall.json.code, 'EVIDENCE_ENVELOPE_INVALID');

    assert.deepEqual(
      { revisions: await revisions(work.taskId), stamped: await db.attachment.count({ where: { ownerId: owner.ownerId, evidenceId: { not: null } } }) },
      before,
    );
    assert.equal(await db.attachment.count({ where: { id: strangers.id, evidenceId: { not: null } } }), 0);
  });

  // Over, because the database gives a task one live session at a time.
  const earlierRun = await sessionOf('an earlier run of the work', work.taskId, owner, 'SUCCEEDED');
  const plainSession = await sessionOf('a conversation of the same account');
  const judgment = await sessionOf('a judgment session of the project');
  await db.projectCoordinatorWake.create({
    data: {
      id: randomUUID(), projectId: project.id, event: 'CRITERION_READY', subjectType: 'CRITERION', subjectId: `${project.id}:judged`,
      subjectVersion: '1', idempotencyKey: `file-evidence-${RUN}`, status: 'SESSION_OPENED', sessionId: judgment,
    },
  });
  const verifier = await workOf('verifying the work', project, { completionCriterion: 'VERIFICATION', verifiesTaskId: work.taskId, criterionDefinitionId: null, criterionRevision: null });
  const verifierOfAnother = await workOf('verifying a neighbour', project, { completionCriterion: 'VERIFICATION', verifiesTaskId: neighbour.taskId, criterionDefinitionId: null, criterionRevision: null });

  await t.test('(4) the sessions that judge the task read a cited file, and nobody else does', async () => {
    await reads(work.sessionId, shot, 'the run that uploaded it');
    await reads(project.coordinator, shot, 'the project\'s coordinator');
    await reads(judgment, shot, 'a judgment session of the project');
    await reads(verifier.sessionId, shot, 'a verifier of the task');

    await readsNothing(plainSession, shot, 'another session of the same account');
    await readsNothing(neighbour.sessionId, shot, 'a run of another task of the same project');
    await readsNothing(verifierOfAnother.sessionId, shot, 'a verifier of another task');
    await readsNothing(earlierRun, shot, 'another run of the task, which did the work and did not upload this');

    await readsNothing(project.coordinator, shot, 'the coordinator, from a machine that does not host it', secondMachine.token, 403);
    const strangersCoordinator = (await projectOf('a stranger\'s project', stranger)).coordinator;
    await readsNothing(strangersCoordinator, shot, 'another account\'s coordinator, on its own machine', stranger.token);
    const nothing = await read(strangersCoordinator, b62(randomUUID()), stranger.token);
    const theirs = await read(strangersCoordinator, shot.publicId, stranger.token);
    assert.equal(theirs.described.text, nothing.described.text, 'answered exactly as an id that names nothing');
  });

  await t.test('(4b) the session that did the work judges nothing, whatever else it is', async () => {
    await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: earlierRun } });
    await readsNothing(earlierRun, shot, 'a coordinator conversation that is a run of the task');
    await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: project.coordinator } });

    const dispatcher = await sessionOf('a run of its own dispatch', undefined, owner);
    const alone = await workOf('a task with no project', null, { creatorType: 'AGENT', creatorSessionId: dispatcher });
    const log = await uploaded(alone.sessionId, 'alone.log');
    created(await submit(alone, [asFile(log)]), 'the evidence');
    await reads(dispatcher, log, 'the session that dispatched it, which took no part');
    await db.taskCompletionEvidence.create({
      data: {
        taskId: alone.taskId, ownerId: owner.ownerId, actorType: 'USER', actorId: owner.ownerId, sourceSessionId: dispatcher,
        criterionRevision: 'a'.repeat(64), criterion: {}, evidence: {}, evidenceDigest: 'b'.repeat(64), revision: 2n,
      },
    });
    await readsNothing(dispatcher, log, 'the session that dispatched it, once it has submitted evidence for the task');

    const checked = await workOf('work its verifier had a hand in', project);
    const notes = await uploaded(checked.sessionId, 'notes.txt');
    created(await submit(checked, [asFile(notes)]), 'the evidence');
    const hand = await workOf('verifying it', project, { completionCriterion: 'VERIFICATION', verifiesTaskId: checked.taskId, criterionDefinitionId: null, criterionRevision: null });
    await reads(hand.sessionId, notes, 'a verifier that took no part');
    await db.taskCompletionEvidence.create({
      data: {
        taskId: checked.taskId, ownerId: owner.ownerId, actorType: 'USER', actorId: owner.ownerId, sourceSessionId: hand.sessionId,
        criterionRevision: 'a'.repeat(64), criterion: {}, evidence: {}, evidenceDigest: 'b'.repeat(64), revision: 2n,
      },
    });
    await readsNothing(hand.sessionId, notes, 'a verifier that submitted evidence for the task');
  });

  await t.test('(5) a bundle\'s files come with it, and a judge reads what the evidence cites and no more', async () => {
    await reads(project.coordinator, folder, 'the bundle\'s manifest');
    await reads(project.coordinator, one, 'a file the manifest lists');
    await reads(verifier.sessionId, two, 'a file the manifest lists');
    await readsNothing(plainSession, one, 'a file of a bundle, for a session that does not judge');
    await readsNothing(project.coordinator, uncited, 'a file of the same run that nothing cites');

    const alone = await workOf('a bundle cited in part', project);
    const inPart = await uploaded(alone.sessionId, 'cited.png');
    const beside = await uploaded(alone.sessionId, 'beside.png');
    await bundled(alone.sessionId, [{ path: 'cited.png', file: inPart }, { path: 'beside.png', file: beside }]);
    const ledger = created(await submit(alone, [asFile(inPart)]), 'one file of a bundle');
    assert.equal(ledger.citations[0].label, `cited.png · ${inPart.bytes.length} B · application/octet-stream`);
    await reads(project.coordinator, inPart, 'the cited file');
    await readsNothing(project.coordinator, beside, 'the file beside it');
  });

  await t.test('(5b) what is asked is who judges the task now', async () => {
    const replacement = await sessionOf('the new coordinator');
    await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: replacement } });
    await readsNothing(project.coordinator, shot, 'the coordinator it replaced');
    await reads(replacement, shot, 'the conversation the project is coordinated from now');
    await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: project.coordinator } });

    const moving = await workOf('a task that moves', project);
    const picture = await uploaded(moving.sessionId, 'moved.png');
    created(await submit(moving, [asFile(picture)]), 'the evidence');
    await reads(project.coordinator, picture, 'its coordinator, before it moves');
    // A task moves once its run has ended: a live claim holds it where it is.
    await db.session.update({ where: { id: moving.sessionId }, data: { status: 'SUCCEEDED' } });
    const elsewhere = await projectOf('the project it moved to');
    await db.task.update({ where: { id: moving.taskId }, data: { projectId: elsewhere.id, criterionDefinitionId: elsewhere.definitionId } });
    await readsNothing(project.coordinator, picture, 'the coordinator of the project it left');
    await readsNothing(judgment, picture, 'a judgment session of the project it left');
    await reads(elsewhere.coordinator, picture, 'the coordinator of the project it is in');
  });

  /** The message the project's coordinator was queued that names this task. */
  const toldCoordinator = async (title: string): Promise<string> => {
    const turn = await db.conversationTurn.findFirstOrThrow({
      where: { sessionId: project.coordinator, content: { contains: title } },
      select: { content: true },
    });
    return turn.content ?? '';
  };

  await t.test('(6) the coordinator is told each cited file and the call that fetches it', async () => {
    const delivered = await workOf('work with files to deliver', project);
    const picture = await uploaded(delivered.sessionId, 'multi\nline.png', png(640, 480), 'image/png');
    const notes = await uploaded(delivered.sessionId, 'notes.txt', randomBytes(50), 'text/plain');
    const a = await uploaded(delivered.sessionId, 'a.png');
    const b = await uploaded(delivered.sessionId, 'b.png');
    const shots = await bundled(delivered.sessionId, [{ path: 'a.png', file: a }, { path: 'b.png', file: b }]);
    created(await submit(delivered, [delivered.tool, asFile(picture), asFile(notes), asFile(shots)]), 'the evidence');
    const message = await toldCoordinator('work with files to deliver');
    const lines = message.split('\n');
    assert.ok(lines.includes(`- multi line.png · 1 KB · image/png · 640×480: file_fetch (id: ${picture.publicId})`), message);
    assert.ok(lines.includes(`- notes.txt · 50 B · text/plain: file_fetch (id: ${notes.publicId})`), message);
    assert.ok(lines.includes(`- 2 files · 600 B: file_fetch (id: ${shots.publicId})`), message);
    assert.match(message, /The files this revision cites\. file_fetch saves one into your uploads directory, outside the repository/);
    assert.ok(!message.includes(delivered.tool.ref), 'the tool call is not a file');

    const plain = await workOf('work with nothing to fetch', project);
    created(await submit(plain, [plain.tool]), 'evidence with no file');
    const told = await toldCoordinator('work with nothing to fetch');
    assert.ok(!told.includes('file_fetch'), told);
    const wake = await db.projectCoordinatorWake.findFirstOrThrow({ where: { projectId: project.id, subjectId: plain.taskId } });
    assert.ok(!('files' in (wake.detail as object)), 'and nothing new on the wake');
  });

  await t.test('(7) in no project the dispatching session judges: it reads the files and its review lists them', async () => {
    const dispatching = await sessionOf('the session that filed the task');
    const alone = await workOf('work of no project', null, { creatorType: 'AGENT', creatorSessionId: dispatching });
    const log = await uploaded(alone.sessionId, 'run.log', randomBytes(70), 'text/plain');
    const receipt = created(await submit(alone, [alone.tool, asFile(log)]), 'the evidence');
    await reads(dispatching, log, 'the session that dispatched it');
    await readsNothing(plainSession, log, 'another session of the same account');
    await readsNothing(project.coordinator, log, 'a coordinator of a project it is not in');
    const block = await evidenceReviewBlock(db as unknown as Prisma.TransactionClient, toUuid(receipt.id));
    assert.ok(block?.split('\n').includes(`- run.log · 70 B · text/plain: file_fetch (id: ${log.publicId})`), block ?? 'no block');
  });

  await t.test('(8) file_list by evidence version answers what that version cites', async () => {
    const versions = await workOf('work of two versions', project);
    const keeps = await uploaded(versions.sessionId, 'kept.png');
    const dropped = await uploaded(versions.sessionId, 'dropped.png');
    const member = await uploaded(versions.sessionId, 'member.png');
    const dir = await bundled(versions.sessionId, [{ path: 'member.png', file: member }]);
    const older = created(await submit(versions, [asFile(keeps), asFile(dropped), asFile(dir)]), 'the first version');
    const newer = created(await submit(versions, [asFile(keeps)], 'the second version'), 'the second version');
    const list = async (id: string) => {
      const { status, json } = await call(api, 'GET', `/api/runner/files?evidenceId=${id}`, owner.token);
      assert.equal(status, 200);
      return json.files.map((file: { id: string }) => file.id).sort();
    };
    assert.deepEqual(await list(older.id), [keeps.publicId, dropped.publicId, dir.publicId].sort(), 'the older version still lists what it cited, a bundle as one row');
    assert.deepEqual(await list(newer.id), [keeps.publicId]);
    assert.deepEqual(
      await citingRevisions([keeps, dropped, member]),
      { [keeps.id]: toUuid(newer.id), [dropped.id]: toUuid(older.id), [member.id]: toUuid(older.id) },
      'a file names the newest version citing it',
    );
    const ownReads = await call(api, 'GET', `/api/runner/files?evidenceId=${first.id}`, stranger.token);
    assert.equal(ownReads.status, 404, 'another account\'s version names nothing');
  });

  await t.test('(9) a row from before Orbit Files is hashed when it is cited, and a task\'s input may be cited', async () => {
    const old = await workOf('work citing an old file', project);
    const bytes = png(320, 200);
    const legacy = await db.attachment.create({
      data: { ownerId: owner.ownerId, sessionId: old.sessionId, mimeType: 'image/png', sizeBytes: bytes.length, fileName: 'old.png', data: new Uint8Array(bytes) },
    });
    const inputBytes = randomBytes(90);
    const blob = sha256(inputBytes);
    await db.fileBlob.create({ data: { sha256: blob, sizeBytes: inputBytes.length, storage: 'local' } });
    const input = await db.attachment.create({
      data: { ownerId: owner.ownerId, taskId: old.taskId, mimeType: 'text/plain', sizeBytes: inputBytes.length, fileName: 'input.txt', sha256: blob },
    });
    const receipt = created(await submit(old, [{ kind: 'FILE', ref: b62(legacy.id) }, { kind: 'FILE', ref: b62(input.id) }]), 'the evidence');
    assert.deepEqual(receipt.evidence.checks, [
      { kind: 'FILE', ref: b62(legacy.id), sha256: sha256(bytes), width: 320, height: 200 },
      { kind: 'FILE', ref: b62(input.id), sha256: blob },
    ]);
    const row = await db.attachment.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(row.sha256, sha256(bytes), 'the bytes are kept and the row names them');
    assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: input.id } })).evidenceId, toUuid(receipt.id));
  });

  await t.test('(10) the app\'s door saves it the same way', async () => {
    const fromApp = await workOf('evidence from the app', project);
    const file = await uploaded(fromApp.sessionId, 'app.png', png(2, 2), 'image/png');
    const reply = await call(api, 'POST', `/api/tasks/${b62(fromApp.taskId)}/evidence`, owner.bearer, {
      sourceSessionId: b62(fromApp.sessionId),
      evidence: envelope(fromApp, [asFile(file)]),
    });
    const receipt = created(reply, 'the evidence');
    assert.deepEqual(receipt.evidence.checks, [{ kind: 'FILE', ref: file.publicId, sha256: sha256(file.bytes), width: 2, height: 2 }]);
    const stray = await call(api, 'POST', `/api/tasks/${b62(fromApp.taskId)}/evidence`, stranger.bearer, {
      sourceSessionId: b62(fromApp.sessionId),
      evidence: envelope(fromApp, [asFile(file)]),
    });
    assert.equal(stray.status, 404, 'another account does not reach the task at all');
  });
});
