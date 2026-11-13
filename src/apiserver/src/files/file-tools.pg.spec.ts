/**
 * The doors behind `file_upload`, `file_fetch` and `file_list` (docs/orbit-files-design.md §2.2, §2.3; migration 0464),
 * held against the production apiserver — `build/main.js`, multer and every guard and pipe in front of the routes — over
 * a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/file-tools.pg.spec.ts
 *
 *   (1) an upload is a row of the session that made it, with its label and the mark the retention rules read, and the
 *       answer says what it is: id, sha256 and size;
 *   (2) `taskId` left out, or the task the session runs, is that same row, which `file_list` finds by the task and the
 *       session can fetch; a row of the task's own would be a template for its later runs. A task lists its inputs once,
 *       not a copy per run;
 *   (3) any other task's id, and an id that names nothing, are refused alike and leave nothing behind, and the refusal
 *       says where a task's inputs go; a malformed one is refused too;
 *   (4) a file's name reaches the row in any script, sent as RFC 5987 `filename*`, the way the runner sends it;
 *   (5) a folder bundle is a manifest kept like any file, naming each file's path, id and sha256: the files are claimed
 *       by it and carry their paths, and it is told from a file by what only the server writes;
 *       A bundle cannot be a task's input, since a copy of its manifest would list files that task cannot read;
 *   (6) a bundle that could not be written back under a folder, or that names anything but this session's own unbundled
 *       uploads, is refused whole, writing nothing;
 *   (7) two bundles racing for one file end with one bundle and no stray manifest row;
 *   (8) `file_list` takes exactly one of task, session and evidence version, refuses an id that names nothing rather
 *       than answering empty, shows a bundle as one row, and says when it stopped short;
 *   (9) a file is read as an attachment is, in the session that holds it: another session of the same owner is told it
 *       is not there, and another runner is refused the session. Who else may read one is tasks/file-evidence.pg.spec.ts;
 *  (10) a text file holding a credential is refused for each shape §2.9 names: the answer and the server's log say what
 *       it looks like and where, and never repeat it, and no row, bytes or temporary file are left. What ordinary test
 *       logs hold and binary files are kept byte for byte, and the bytes, not the declared type, say which is which. A
 *       folder's other files are kept and bundle as usual.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { CREDENTIAL_SAMPLES, ORDINARY_LINES, issued, survivingPiece } from './file-secret-samples.spec';
import { MAX_BUNDLE_FILES, type FileBundleManifest } from './files.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `file-tools-${RUN}`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b62 = (id: string) => uuidToBase62(id);

interface Upload {
  bytes?: Buffer;
  /** The whole of the file part's Content-Disposition, for a name the plain form cannot carry. */
  disposition?: string;
  name?: string;
  type?: string;
  fields?: Record<string, string>;
}

/** POST a multipart body to `route`, with fetch, which is what keeps this file's bytes apart from any text handling. */
async function upload(server: Apiserver, route: string, token: string, file: Upload = {}): Promise<Reply> {
  const boundary = `file-tools-${randomUUID()}`;
  const bytes = file.bytes ?? randomBytes(64);
  const disposition = file.disposition ?? `form-data; name="file"; filename="${file.name ?? 'shot.png'}"`;
  const text = Object.entries(file.fields ?? {}).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  const body = Buffer.concat([
    Buffer.from(`${text.join('')}--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${file.type ?? 'image/png'}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const reply = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(reply);
  } catch {
    json = null;
  }
  return { status: response.status, json, text: reply, headers: {} };
}

/** The bytes the attachment route answers, as `file_fetch` reads them. */
async function bytesOf(server: Apiserver, sessionId: string, fileId: string, token: string): Promise<Buffer> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/runner/sessions/${b62(sessionId)}/attachments/${fileId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `the bytes of ${fileId} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

test('the doors behind file_upload, file_fetch and file_list', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-file-tools-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `file-tools-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;
  const tempFiles = () => {
    try {
      return readdirSync(path.join(dir, 'tmp'));
    } catch {
      return [];
    }
  };

  // An owner with two machines, and on the first a session with no task, one running a task, and one that has ended
  // its share of a task but stays the owner's; a task nobody here runs; and a stranger.
  const ownerId = randomUUID();
  const email = `file-tools-${RUN}@orbit-files.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'file tools', passwordHash: 'x' } });
  const bearer = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
  const machineOf = async (name: string, owner = ownerId) => {
    const id = randomUUID();
    const token = `${id}-${RUN}`;
    await db.runner.create({ data: { id, ownerId: owner, name, tokenHash: createHash('sha256').update(token).digest('hex') } });
    return { id, token };
  };
  const machine = await machineOf('file-tools');
  const otherMachine = await machineOf('file-tools-other');
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: machine.id, name: 'file-tools', enabled: true } });
  const taskOf = async (title: string) => {
    const id = randomUUID();
    await db.task.create({ data: { id, title, ownerId, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' } });
    return id;
  };
  const sessionOf = async (title: string, taskId?: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id,
        status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${id}`, taskId,
      },
    });
    return id;
  };
  const taskId = await taskOf('the task a session runs');
  const otherTaskId = await taskOf('a task nobody here runs');
  const sessionId = await sessionOf('a conversation');
  const taskSessionId = await sessionOf('a run of the task', taskId);
  const otherSessionId = await sessionOf('another conversation');

  const door = (id: string) => `/api/runner/sessions/${b62(id)}/files`;
  const bundleDoor = (id: string) => `/api/runner/sessions/${b62(id)}/file-bundles`;
  const created = (reply: Reply, what: string) => {
    assert.equal(reply.status, 201, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return reply.json;
  };
  const list = (query: string) => call(api, 'GET', `/api/runner/files${query}`, machine.token);
  const rowsOf = (where: Record<string, unknown>) => db.attachment.count({ where: { ownerId, ...where } });

  await t.test('(1) an upload is a row of its session, labelled and marked, and answers what it is', async () => {
    const bytes = randomBytes(2048);
    const file = created(await upload(api, door(sessionId), machine.token, { bytes, name: 'report.json', type: 'application/json', fields: { label: '  the run  ' } }), 'the upload');
    assert.equal(file.sha256, sha256(bytes));
    assert.equal(file.sizeBytes, 2048);
    assert.equal(file.name, 'report.json');
    assert.equal(file.label, 'the run', 'trimmed');
    assert.equal(file.mimeType, 'application/json');
    assert.equal(file.kind, 'file');
    assert.equal(file.publicId, b62(file.id), 'the machine door answers the UUID, and the id an agent is shown beside it');
    const row = await db.attachment.findUniqueOrThrow({ where: { id: file.id } });
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.taskId, null);
    assert.equal(row.retention, 'file_upload', 'what tells it from a reply\'s image');
    assert.equal(row.data, null);
    assert.ok((await bytesOf(api, sessionId, file.publicId, machine.token)).equals(bytes), 'read back through the attachment route');
    const beside = await upload(api, `/api/runner/sessions/${b62(sessionId)}/attachments`, machine.token, { bytes });
    const reply = await db.attachment.findUniqueOrThrow({ where: { id: created(beside, 'the reply image door').id } });
    assert.equal(reply.retention, null, 'a reply\'s image stays what it was');
    assert.equal(await db.fileBlob.count({ where: { sha256: file.sha256 } }), 1, 'and the same bytes are kept once');
  });

  await t.test('(2) the task the session runs, named or left out, is a row of the session that list by task finds', async () => {
    const named = created(await upload(api, door(taskSessionId), machine.token, { name: 'named.txt', type: 'text/plain', fields: { taskId: b62(taskId) } }), 'taskId named');
    const left = created(await upload(api, door(taskSessionId), machine.token, { name: 'left.txt', type: 'text/plain' }), 'taskId left out');
    for (const file of [named, left]) {
      const row = await db.attachment.findUniqueOrThrow({ where: { id: file.id } });
      assert.deepEqual({ sessionId: row.sessionId, taskId: row.taskId }, { sessionId: taskSessionId, taskId: null });
    }
    assert.equal((await db.attachment.count({ where: { taskId } })), 0, 'no template: nothing the next run would be handed');
    const { status, json } = await list(`?taskId=${b62(taskId)}`);
    assert.equal(status, 200);
    assert.deepEqual(json.files.map((file: { publicId: string }) => file.publicId).sort(), [named.publicId, left.publicId].sort());
    assert.equal(json.truncated, false);
  });

  await t.test('(2b) a task\'s input is listed once, not once per run, and a reply\'s image in its session is not listed', async () => {
    const inputTaskId = await taskOf('a task with an input');
    const firstRun = await sessionOf('the first run', inputTaskId);
    const blob = sha256(Buffer.from('an input'));
    await db.fileBlob.create({ data: { sha256: blob, sizeBytes: 8, storage: 'local' } });
    const input = await db.attachment.create({
      data: { ownerId, taskId: inputTaskId, mimeType: 'text/plain', sizeBytes: 8, fileName: 'input.txt', sha256: blob },
    });
    // What copyTaskAttachments writes into each run: another row, another id, the same bytes.
    const copyInto = (session: string) =>
      db.attachment.create({ data: { ownerId, sessionId: session, mimeType: 'text/plain', sizeBytes: 8, fileName: 'input.txt', sha256: blob } });
    await copyInto(firstRun);
    created(await upload(api, `/api/runner/sessions/${b62(firstRun)}/attachments`, machine.token, { name: 'reply.png' }), 'a reply image');
    const kept = created(await upload(api, door(firstRun), machine.token, { name: 'kept.png' }), 'a file_upload');
    // One run of a task at a time: the second starts when the first has ended.
    await db.session.update({ where: { id: firstRun }, data: { status: 'SUCCEEDED' } });
    await copyInto(await sessionOf('the second run', inputTaskId));
    const { json } = await list(`?taskId=${b62(inputTaskId)}`);
    assert.deepEqual(
      json.files.map((file: { name: string }) => file.name).sort(),
      ['input.txt', 'kept.png'],
      'the input, and what its runs kept',
    );
    assert.deepEqual(json.files.map((file: { publicId: string }) => file.publicId).sort(), [b62(input.id), kept.publicId].sort());
    const session = await list(`?sessionId=${b62(firstRun)}`);
    assert.deepEqual(
      session.json.files.map((file: { name: string }) => file.name).sort(),
      ['input.txt', 'kept.png', 'reply.png'],
      'a session\'s list still holds everything in it',
    );
  });

  await t.test('(3) any other task is refused as an id that names nothing, says where inputs go, and leaves nothing', async () => {
    const before = { rows: await rowsOf({}), blobs: await db.fileBlob.count() };
    const bytes = randomBytes(128);
    const answers: Reply[] = [];
    for (const named of [otherTaskId, randomUUID()]) {
      answers.push(await upload(api, door(taskSessionId), machine.token, { bytes, fields: { taskId: b62(named) } }));
    }
    answers.push(await upload(api, door(sessionId), machine.token, { bytes, fields: { taskId: b62(taskId) } }));
    for (const answer of answers) {
      assert.equal(answer.status, 400, answer.text);
      assert.match(answer.json.message, /task_create's attachmentIds/);
      assert.equal(answer.json.message, answers[0].json.message, 'one refusal, whoever\'s id it was');
    }
    const malformed = await upload(api, door(taskSessionId), machine.token, { bytes, fields: { taskId: 'not-a-public-id!' } });
    assert.equal(malformed.status, 400, malformed.text);
    const nul = await upload(api, door(taskSessionId), machine.token, { bytes, fields: { label: 'a\u0000b' } });
    assert.equal(nul.status, 400, `a NUL in a label answered ${nul.status}: ${nul.text}`);
    const longLabel = await upload(api, door(taskSessionId), machine.token, { bytes, fields: { label: 'x'.repeat(201) } });
    assert.equal(longLabel.status, 400, longLabel.text);
    assert.deepEqual(tempFiles(), [], 'no temporary file is left, however it was refused');
    assert.deepEqual({ rows: await rowsOf({}), blobs: await db.fileBlob.count() }, before, 'no row, no bytes kept');
  });

  await t.test('(4) a name in any script reaches the row, sent as filename*', async () => {
    // Byte for byte what Go's mime.FormatMediaType writes, which is what the runner sends (file_tools.go uploadFile).
    const name = '报告 ü.json';
    const file = created(await upload(api, door(sessionId), machine.token, { disposition: `form-data; filename*=utf-8''${encodeURIComponent(name)}; name=file` }), 'the upload');
    assert.equal(file.name, name);
    const plain = created(await upload(api, door(sessionId), machine.token, { disposition: 'form-data; filename=report.json; name=file' }), 'a plain name');
    assert.equal(plain.name, 'report.json');
    const spaced = created(await upload(api, door(sessionId), machine.token, { disposition: 'form-data; filename="a b.png"; name=file' }), 'a name with a space');
    assert.equal(spaced.name, 'a b.png');
  });

  const uploaded = async (session: string, name: string, bytes = randomBytes(256)) =>
    ({ ...created(await upload(api, door(session), machine.token, { bytes, name }), name), bytes });
  const bundle = (session: string, files: { path: string; id: string }[], extra: Record<string, unknown> = {}, token = machine.token) =>
    call(api, 'POST', bundleDoor(session), token, { name: 'shots', files, ...extra });

  await t.test('(5) a bundle is a manifest kept like a file, and its files are claimed by it and carry their paths', async () => {
    const files = [await uploaded(sessionId, 'one.png'), await uploaded(sessionId, 'two.png'), await uploaded(sessionId, 'three.png')];
    const paths = ['phone/light/one.png', 'phone/dark/two.png', '截图/三.png'];
    const reply = await bundle(sessionId, files.map((file, i) => ({ path: paths[i], id: file.publicId })), { label: ' viewport matrix ' });
    const made = created(reply, 'the bundle');
    assert.equal(made.kind, 'bundle');
    assert.equal(made.fileBundleId, made.id, 'what makes it a bundle is a column no request writes');
    assert.equal(made.name, 'shots.json');
    assert.equal(made.label, 'viewport matrix');
    assert.equal(made.mimeType, 'application/vnd.orbit.file-bundle+json');
    const bytes = await bytesOf(api, sessionId, made.id, machine.token);
    assert.equal(sha256(bytes), made.sha256, 'kept under its own sha256');
    assert.equal(made.sizeBytes, bytes.length);
    const manifest = JSON.parse(bytes.toString('utf8')) as FileBundleManifest;
    assert.deepEqual(
      { kind: manifest.kind, version: manifest.version, name: manifest.name, label: manifest.label, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes },
      { kind: 'orbit-file-bundle', version: 1, name: 'shots', label: 'viewport matrix', fileCount: 3, totalBytes: 768 },
    );
    assert.deepEqual(manifest.files.map((entry) => entry.path), [...paths].sort(), 'by path');
    for (const entry of manifest.files) {
      const file = files[paths.indexOf(entry.path)];
      assert.deepEqual(entry, { path: entry.path, id: file.publicId, sha256: sha256(file.bytes), sizeBytes: 256, mimeType: 'image/png' });
      const row = await db.attachment.findUniqueOrThrow({ where: { id: toUuid(entry.id) } });
      assert.deepEqual({ fileBundleId: row.fileBundleId, fileName: row.fileName }, { fileBundleId: toUuid(made.id), fileName: entry.path });
      assert.ok((await bytesOf(api, sessionId, entry.id, machine.token)).equals(file.bytes), `${entry.path} reads back`);
    }
  });

  await t.test('(5a) a bundle cannot be a task input, and the files in it can, each by its own id', async () => {
    const file = await uploaded(sessionId, 'input.png');
    const made = created(await bundle(sessionId, [{ path: 'dir/input.png', id: file.publicId }]), 'the bundle');
    const taskBody = (attachmentIds: string[]) => ({
      title: `a task from a folder ${randomUUID()}`, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0, autoRunWhenReady: false, attachmentIds,
    });
    const tasksBefore = await db.task.count({ where: { ownerId } });
    // The runner door is carded by caller now: this spec's subject is what a create does with the
    // ids it is given, so it files the card the session would have asked for and writes under it.
    const asSession = { 'x-orbit-session-id': b62(sessionId) };
    const cardFor = (input: Record<string, unknown>) => db.approval.create({
      data: { sessionId, toolName: 'orbit_task_create', input: input as never, status: 'ALLOWED', decidedById: ownerId, decidedAt: new Date() },
    });
    const bundleBody = taskBody([made.id]);
    await cardFor(bundleBody);
    const refused = await call(api, 'POST', '/api/runner/tasks', machine.token, bundleBody, asSession);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.json.message, /pass the ids of the files in it, individually/);
    assert.equal(await db.task.count({ where: { ownerId } }), tasksBefore, 'no task from a refused bundle');
    const fileBody = taskBody([file.publicId]);
    await cardFor(fileBody);
    const accepted = await call(api, 'POST', '/api/runner/tasks', machine.token, fileBody, asSession);
    assert.equal(accepted.status, 201, accepted.text);
    assert.equal(await db.attachment.count({ where: { taskId: toUuid(accepted.json.id) } }), 1, 'the file is copied');
  });

  await t.test('(5b) a client cannot make a bundle by naming the type', async () => {
    const file = created(await upload(api, door(sessionId), machine.token, { name: 'forged.json', type: 'application/vnd.orbit.file-bundle+json' }), 'the forged upload');
    assert.equal(file.kind, 'file');
    assert.equal(file.fileBundleId, null);
  });

  await t.test('(6) a bundle that is not a folder of this session\'s own unbundled uploads is refused whole', async () => {
    const first = await uploaded(sessionId, 'a.png');
    const second = await uploaded(sessionId, 'b.png');
    const elsewhere = await uploaded(otherSessionId, 'c.png');
    const attachment = created(await upload(api, `/api/runner/sessions/${b62(sessionId)}/attachments`, machine.token, { name: 'reply.png' }), 'a reply image');
    const before = await rowsOf({});
    for (const badPath of ['/etc/passwd', '../outside.png', 'a/../../outside.png', 'a//b.png', './a.png', 'a/', 'back\\slash.png', 'new\nline.png', '']) {
      const refused = await bundle(sessionId, [{ path: badPath, id: first.publicId }]);
      assert.equal(refused.status, 400, `${JSON.stringify(badPath)} answered ${refused.status}: ${refused.text}`);
    }
    assert.equal((await bundle(sessionId, [{ path: 'x.png', id: first.publicId }, { path: 'x.png', id: second.publicId }])).status, 400, 'one file at each path');
    assert.equal((await bundle(sessionId, [{ path: 'x.png', id: first.publicId }, { path: 'y.png', id: first.publicId }])).status, 400, 'each file once');
    const tooMany = Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, i) => ({ path: `${i}.png`, id: first.publicId }));
    assert.equal((await bundle(sessionId, tooMany)).status, 400, `more than ${MAX_BUNDLE_FILES} files`);
    assert.equal((await bundle(sessionId, [])).status, 400, 'an empty folder');
    for (const name of ['a/b', 'a\\b', 'a\u0000b', '']) {
      assert.equal((await call(api, 'POST', bundleDoor(sessionId), machine.token, { name, files: [{ path: 'x.png', id: first.publicId }] })).status, 400, JSON.stringify(name));
    }
    assert.equal((await bundle(sessionId, [{ path: 'x.png', id: first.publicId }], { label: 'a\u0000b' })).status, 400, 'a NUL in a label');
    for (const [what, id] of [
      ['another session\'s file', elsewhere.publicId],
      ['a reply\'s image', attachment.id],
      ['an id that names nothing', randomUUID()],
    ] as const) {
      const refused = await bundle(sessionId, [{ path: 'x.png', id: first.publicId }, { path: 'y.png', id }]);
      assert.equal(refused.status, 404, `${what} answered ${refused.status}: ${refused.text}`);
      assert.match(refused.json.message, /"y\.png"/, 'by path');
    }
    assert.equal(await rowsOf({}), before, 'no manifest row from any of them');
    assert.equal(
      await rowsOf({ id: { in: [first.id, second.id, elsewhere.id] }, fileBundleId: { not: null } }),
      0,
      'and no file claimed',
    );
    created(await bundle(sessionId, [{ path: 'x.png', id: first.publicId }]), 'the first bundle');
    const again = await bundle(sessionId, [{ path: 'y.png', id: first.publicId }]);
    assert.equal(again.status, 404, `a file already in a bundle answered ${again.status}: ${again.text}`);
  });

  await t.test('(7) two bundles racing for one file end with one bundle and no stray manifest', async () => {
    const shared = await uploaded(sessionId, 'shared.png');
    const rowsBefore = await rowsOf({ sessionId });
    const answers = await Promise.all([1, 2, 3, 4].map((i) => bundle(sessionId, [{ path: `${i}/shared.png`, id: shared.publicId }])));
    const statuses = answers.map((answer) => answer.status).sort();
    assert.equal(statuses.filter((status) => status === 201).length, 1, `one bundle takes it, not ${statuses.join(' ')}`);
    assert.ok(statuses.every((status) => [201, 404, 409].includes(status)), statuses.join(' '));
    assert.equal(await rowsOf({ sessionId }), rowsBefore + 1, 'the losers\' manifests rolled back');
  });

  await t.test('(8) a list takes exactly one scope, refuses a stranger\'s id, shows a bundle once and says when it stops', async () => {
    for (const query of ['', `?taskId=${b62(taskId)}&sessionId=${b62(sessionId)}`]) {
      assert.equal((await list(query)).status, 400, query);
    }
    assert.equal((await list(`?taskId=${b62(randomUUID())}`)).status, 404, 'a task that is nobody\'s');
    assert.equal((await list(`?sessionId=${b62(randomUUID())}`)).status, 404, 'a session that is nobody\'s');
    assert.equal((await list(`?evidenceId=${b62(randomUUID())}`)).status, 404, 'an evidence version that is nobody\'s');
    assert.equal((await list('?taskId=not-a-public-id!')).status, 400, 'a malformed one');

    const listSession = await sessionOf('a session with a folder');
    const single = await uploaded(listSession, 'single.png');
    const inFolder = await uploaded(listSession, 'in-folder.png');
    const folder = created(await bundle(listSession, [{ path: 'dir/in-folder.png', id: inFolder.publicId }]), 'the folder');
    const { json } = await list(`?sessionId=${b62(listSession)}`);
    assert.deepEqual(json.files.map((file: { id: string; kind: string }) => [file.id, file.kind]), [[folder.id, 'bundle'], [single.publicId, 'file']], 'newest first');

    const evidenceTaskId = await taskOf('a task with evidence');
    const evidence = await db.taskCompletionEvidence.create({
      data: {
        taskId: evidenceTaskId, ownerId, actorType: 'USER', actorId: ownerId, sourceSessionId: sessionId,
        criterionRevision: 'a'.repeat(64), criterion: {}, evidence: {}, evidenceDigest: 'b'.repeat(64), revision: 1n,
      },
    });
    const empty = await list(`?evidenceId=${b62(evidence.id)}`);
    assert.deepEqual({ status: empty.status, files: empty.json.files }, { status: 200, files: [] }, 'a version with no files');
    const citing = await db.taskCompletionEvidence.create({
      data: {
        taskId: evidenceTaskId, ownerId, actorType: 'USER', actorId: ownerId, sourceSessionId: sessionId,
        criterionRevision: 'a'.repeat(64), criterion: {}, evidenceDigest: 'c'.repeat(64), revision: 2n,
        evidence: { claim: 'a', criterion: { key: 'k', text: 't' }, checks: [{ kind: 'FILE', ref: single.publicId, sha256: single.sha256 }], gaps: [] },
      },
    });
    const cited = await list(`?evidenceId=${b62(citing.id)}`);
    assert.deepEqual(cited.json.files.map((file: { id: string }) => file.id), [single.publicId]);

    const crowded = await sessionOf('a crowded session');
    const row = await db.attachment.findUniqueOrThrow({ where: { id: single.id }, select: { sha256: true } });
    await db.attachment.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({ ownerId, sessionId: crowded, mimeType: 'text/plain', sizeBytes: 1, fileName: `${i}.txt`, sha256: row.sha256 })),
    });
    const full = await list(`?sessionId=${b62(crowded)}`);
    assert.deepEqual({ count: full.json.files.length, truncated: full.json.truncated }, { count: 200, truncated: true });
  });

  await t.test('(9) a file is read in the session that holds it, on the runner that hosts it', async () => {
    const file = await uploaded(sessionId, 'mine.png');
    const describe = (session: string, id: string, token = machine.token) =>
      call(api, 'GET', `${door(session)}/${id}`, token);
    const own = await describe(sessionId, file.publicId);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.id, file.publicId, 'this door speaks public ids');
    assert.equal(own.json.sha256, sha256(file.bytes));
    assert.equal((await describe(otherSessionId, file.publicId)).status, 404, 'another session of the same owner');
    assert.equal((await describe(sessionId, randomUUID())).status, 404);
    assert.equal((await describe(sessionId, file.publicId, otherMachine.token)).status, 403, 'another runner');
    const stranger = await upload(api, door(sessionId), otherMachine.token);
    assert.equal(stranger.status, 403, 'and it cannot upload into it');
    assert.equal((await call(api, 'POST', bundleDoor(sessionId), otherMachine.token, { name: 'x', files: [{ path: 'x', id: file.publicId }] })).status, 403);
    assert.equal((await call(api, 'GET', `/api/runner/files?sessionId=${b62(sessionId)}`, bearer)).status, 401, 'a person\'s sign-in is not a runner');
  });

  const kept = (bytes: Buffer, reply: Reply, what: string) => {
    const file = created(reply, what);
    assert.equal(file.sha256, sha256(bytes), `${what} is kept as it was sent`);
    return file;
  };

  await t.test('(10) a file holding a credential is refused for every shape, says what and where, and leaves nothing', async () => {
    const before = { rows: await rowsOf({}), blobs: await db.fileBlob.count() };
    for (const { kind, shape, text, secret } of CREDENTIAL_SAMPLES) {
      const bytes = Buffer.from(`the run\nthe value was ${text}\n`);
      const refused = await upload(api, door(sessionId), machine.token, { bytes, name: 'run.log', type: 'text/plain' });
      assert.equal(refused.status, 422, `${shape} answered ${refused.status}: ${refused.json?.code}`);
      assert.equal(refused.json.code, 'FILE_HOLDS_SECRET', shape);
      assert.ok(refused.json.message.startsWith(`run.log holds what looks like ${kind} on line 2,`), refused.json.message);
      for (const piece of secret) assert.equal(survivingPiece(refused.text, piece), undefined, `the answer repeats ${shape}`);
      const hash = sha256(bytes);
      assert.equal(existsSync(path.join(dir, hash.slice(0, 2), hash)), false, `the bytes of ${shape} are not in the store`);
    }
    assert.deepEqual(tempFiles(), [], 'no temporary file is left');
    assert.deepEqual({ rows: await rowsOf({}), blobs: await db.fileBlob.count() }, before, 'no row, no bytes kept');
    for (const { shape, secret } of CREDENTIAL_SAMPLES) {
      for (const piece of secret) assert.equal(survivingPiece(api.output(), piece), undefined, `the server's log repeats ${shape}`);
    }
  });

  await t.test('(10a) what ordinary test logs hold is kept, byte for byte', async () => {
    const bytes = Buffer.from(ORDINARY_LINES.map(([, line]) => line).join('\n'));
    const file = kept(bytes, await upload(api, door(sessionId), machine.token, { bytes, name: 'test.log', type: 'text/plain' }), 'an ordinary test log');
    assert.ok((await bytesOf(api, sessionId, file.publicId, machine.token)).equals(bytes), 'read back as it was sent');
  });

  await t.test('(10b) a binary file is not scanned, and the bytes, not the declared type, say what is text', async () => {
    const key = issued('ghp_', 36);
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(key), randomBytes(64)]);
    kept(png, await upload(api, door(sessionId), machine.token, { bytes: png, name: 'shot.png', type: 'image/png' }), 'a PNG with a key in it');
    const gzip = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(key)]);
    kept(gzip, await upload(api, door(sessionId), machine.token, { bytes: gzip, name: 'trace.gz', type: 'application/octet-stream' }), 'a gzip with a key in it');
    for (const [name, type] of [['notes.png', 'image/png'], ['client.ts', 'video/mp2t'], ['id_rsa', 'application/octet-stream']]) {
      const refused = await upload(api, door(sessionId), machine.token, { bytes: Buffer.from(`the key ${key}\n`), name, type });
      assert.equal(refused.status, 422, `text declared ${type} answered ${refused.status}`);
    }
  });

  await t.test('(10c) a folder keeps its other files: one refused, the rest uploaded and bundled', async () => {
    const folderSession = await sessionOf('a session with a folder that holds a key');
    const first = randomBytes(256);
    const last = randomBytes(256);
    const a = kept(first, await upload(api, door(folderSession), machine.token, { bytes: first, name: 'a.png' }), 'a.png');
    const refused = await upload(api, door(folderSession), machine.token, { bytes: Buffer.from(`the key ${issued('ghp_', 36)}\n`), name: 'run.log', type: 'text/plain' });
    assert.equal(refused.status, 422);
    const z = kept(last, await upload(api, door(folderSession), machine.token, { bytes: last, name: 'z.png' }), 'z.png');
    const made = created(await call(api, 'POST', bundleDoor(folderSession), machine.token, {
      name: 'evidence',
      files: [{ path: 'a.png', id: a.publicId }, { path: 'shots/z.png', id: z.publicId }],
    }), 'the bundle of the rest');
    const manifest = JSON.parse((await bytesOf(api, folderSession, made.id, machine.token)).toString('utf8')) as FileBundleManifest;
    assert.deepEqual(manifest.files.map((entry) => entry.path), ['a.png', 'shots/z.png']);
    assert.equal(await rowsOf({ sessionId: folderSession }), 3, 'two files and the manifest, and nothing of the refused one');
  });
});
