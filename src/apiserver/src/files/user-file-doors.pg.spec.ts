/**
 * Every door that answers with a user's file, over real HTTP on the production server (build/main.js, the
 * whole AppModule) against a real, fully migrated PostgreSQL, once with each file store. Each one answers
 * with Content-Security-Policy: sandbox and X-Content-Type-Options: nosniff, and a type off the list
 * (files/user-file-response.ts) is an attachment under the file's own name.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/user-file-doors.pg.spec.ts
 *
 * Not destructive: the server it starts writes to the database run-pg-spec.sh made for it.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { Client } from 'pg';

import { call, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { bootScrubbedApiserver } from '../test-support/managed-runner-apiserver';
import { startS3 } from '../test-support/s3-test-server';

const URL = process.env.COORDINATOR_PG_URL;
const EMAIL = `user-file-doors-${randomUUID().slice(0, 8)}@example.invalid`;
const PASSWORD = 'correct horse battery staple';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGNwwAEYhpYEAMHWMAGbZrqqAAAAAElFTkSuQmCC', 'base64');

interface Kind {
  name: string;
  type: string;
  bytes: Buffer;
  /** May be shown: on the list in files/user-file-response.ts. */
  shown: boolean;
}

const KINDS: Kind[] = [
  { name: 'shot.png', type: 'image/png', bytes: PNG, shown: true },
  { name: 'spec.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), shown: true },
  { name: 'page.html', type: 'text/html', bytes: Buffer.from('<p>a page</p>'), shown: false },
  { name: 'drawing.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), shown: false },
  { name: 'data.xml', type: 'application/xml', bytes: Buffer.from('<a/>'), shown: false },
  { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('notes'), shown: false },
];

/** Held to the rule: the two headers on every answer, and the disposition its type and door call for. */
function assertHeld(reply: Reply, kind: Kind, door: string, saved: 'always' | 'unless shown'): void {
  const where = `${door} ${kind.name}`;
  assert.equal(reply.status, 200, `${where}: ${reply.text}`);
  assert.equal(reply.headers['content-security-policy'], 'sandbox', `${where}: Content-Security-Policy`);
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', `${where}: X-Content-Type-Options`);
  const disposition = String(reply.headers['content-disposition']);
  if (kind.shown && saved === 'unless shown') {
    assert.equal(disposition, 'inline', `${where}: Content-Disposition`);
  } else {
    assert.match(disposition, /^attachment; /, `${where}: Content-Disposition`);
    assert.ok(disposition.includes(`filename="${kind.name}"`), `${where}: the file's own name, in ${disposition}`);
  }
}

/**
 * The doors on one store. Each store's files directory is its own, so that the same bytes are kept again in this
 * leg's store rather than found in the other's.
 */
const doorCases = (sql: Client, scratch: string, storage: 'local' | 's3', env: Record<string, string>) => async (t: TestContext) => {
  const url = URL!;
  let server: Apiserver | undefined;
  t.after(() => server?.stop());
  const api = await bootScrubbedApiserver(scratch, storage, {
    DATABASE_URL: url,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ORBIT_FILES_DIR: path.join(scratch, `${storage}-files`),
    ...env,
  });
  server = api;

  /** A multipart upload of one file, under a bearer or a runner's token. */
  async function send(route: string, bearer: string, kind: Pick<Kind, 'name' | 'type' | 'bytes'>, method = 'POST'): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(kind.bytes)], { type: kind.type }), kind.name);
    return fetch(`http://127.0.0.1:${api.port}${route}`, { method, headers: { authorization: `Bearer ${bearer}` }, body: form });
  }
  async function upload(route: string, bearer: string, kind: Kind): Promise<string> {
    const reply = await send(route, bearer, kind);
    assert.equal(reply.status, 201, `upload ${kind.name}: ${await reply.clone().text()}`);
    return ((await reply.json()) as { id: string }).id;
  }

  // ── the world: an owner, a runner of theirs, a conversation it runs, a task, a link to each ────────
  // The first store's run bootstraps the owner, who signs in on the second's.
  const signIn = storage === 'local'
    ? await call(api, 'POST', '/api/auth/bootstrap', undefined, { email: EMAIL, name: 'Doors', password: PASSWORD })
    : await call(api, 'POST', '/api/auth/login', undefined, { email: EMAIL, password: PASSWORD });
  assert.equal(signIn.status, 201, signIn.text);
  const access: string = signIn.json.accessToken;
  const enrollment = await call(api, 'POST', '/api/runners/enrollment-tokens', access, { label: `doors-${storage}` });
  assert.equal(enrollment.status, 201, enrollment.text);
  const registered = await call(api, 'POST', '/api/runner/register', undefined, { enrollmentToken: enrollment.json.token, name: `doors-${storage}` });
  assert.equal(registered.status, 201, registered.text);
  const runnerToken: string = registered.json.runnerToken;
  const beat = await call(api, 'POST', '/api/runner/heartbeat', runnerToken, {});
  assert.ok(beat.status === 200 || beat.status === 201, beat.text);

  const { rows: [owner] } = await sql.query('SELECT id FROM "user" WHERE email = $1', [EMAIL]);
  const { rows: [runner] } = await sql.query('SELECT id FROM runner WHERE owner_id = $1 AND name = $2', [owner.id, `doors-${storage}`]);
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await sql.query(
    `INSERT INTO workspace (id, owner_id, runner_id, name, enabled) VALUES ($1, $2, $3, $4, true)`,
    [workspaceId, owner.id, runner.id, `doors-${storage}`],
  );
  const changedFiles = KINDS.map((kind) => ({ path: `shots/${kind.name}`, status: 'M' }));
  await sql.query(
    `INSERT INTO session (id, owner_id, creator_id, workspace_id, title, prompt, status, dispatch_origin, assigned_runner_id, changed_files, updated_at)
     VALUES ($1, $2, $2, $3, 'Doors', 'Doors', 'AWAITING_INPUT', 'USER', $4, $5::jsonb, now())`,
    [sessionId, owner.id, workspaceId, runner.id, JSON.stringify(changedFiles)],
  );
  const scratchPath = (kind: Kind) => `/root/.orbit/uploads/${sessionId}/${kind.name}`;
  await sql.query(
    `INSERT INTO run_event (id, session_id, seq, type, payload) VALUES (gen_random_uuid(), $1, 1, 'assistant', $2::jsonb)`,
    [sessionId, JSON.stringify({ text: KINDS.map(scratchPath).join(' ') })],
  );

  const inSession = new Map<Kind, string>();
  for (const kind of KINDS) inSession.set(kind, await upload(`/api/attachments?sessionId=${sessionId}`, access, kind));
  const { rows: stores } = await sql.query(
    'SELECT DISTINCT b.storage FROM attachment a JOIN file_blob b ON b.sha256 = a.sha256 WHERE a.session_id = $1',
    [sessionId],
  );
  assert.deepEqual(stores, [{ storage }], 'the bytes are in the store this run is about');

  const task = await call(api, 'POST', '/api/tasks', access, { title: 'Doors', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
  assert.equal(task.status, 201, task.text);
  const onTask = new Map<Kind, string>();
  for (const kind of KINDS) onTask.set(kind, await upload(`/api/attachments?taskId=${task.json.id}`, access, kind));

  const sessionLink = await call(api, 'PUT', `/api/sessions/${sessionId}/share`, access, {});
  assert.equal(sessionLink.status, 200, sessionLink.text);
  const taskLink = await call(api, 'PUT', `/api/tasks/${task.json.id}/share`, access, { include: { commentsAndFiles: true } });
  assert.equal(taskLink.status, 200, taskLink.text);
  const sessionToken: string = sessionLink.json.token ?? sessionLink.json.link.token;
  const taskToken: string = taskLink.json.token ?? taskLink.json.link.token;

  // ── the doors ─────────────────────────────────────────────────────────────────────────────────
  for (const kind of KINDS) {
    await t.test(`${kind.name}: the attachment doors`, async () => {
      const id = inSession.get(kind)!;
      assertHeld(await call(api, 'GET', `/api/attachments/${id}`, access), kind, 'GET /attachments/:id', 'unless shown');
      assertHeld(await call(api, 'GET', `/api/shared/${sessionToken}/attachments/${id}`), kind, 'GET /shared/:token/attachments/:id (session link)', 'unless shown');
      assertHeld(await call(api, 'GET', `/api/shared/${taskToken}/attachments/${onTask.get(kind)}`), kind, 'GET /shared/:token/attachments/:id (task link)', 'unless shown');
      assertHeld(await call(api, 'GET', `/api/runner/sessions/${sessionId}/attachments/${id}`, runnerToken), kind, 'GET /runner/sessions/:id/attachments/:attId', 'unless shown');
    });

    await t.test(`${kind.name}: the session file doors, which always save`, async () => {
      const artifact = `artifacts?path=${encodeURIComponent(scratchPath(kind))}`;
      assertHeld(await call(api, 'GET', `/api/sessions/${sessionId}/${artifact}`, access), kind, 'GET /sessions/:id/artifacts', 'always');
      assertHeld(await call(api, 'GET', `/api/shared/${sessionToken}/${artifact}`), kind, 'GET /shared/:token/artifacts', 'always');
    });

    await t.test(`${kind.name}: the worktree file door, its runner answering`, async () => {
      const reading = call(api, 'GET', `/api/sessions/${sessionId}/worktree-file?path=${encodeURIComponent(`shots/${kind.name}`)}`, access);
      let request: { id: string } | undefined;
      for (let i = 0; i < 200 && !request; i++) {
        [request] = (await sql.query(`SELECT id FROM conversation_turn WHERE session_id = $1 AND kind = 'artifact' AND status = 'PENDING'`, [sessionId])).rows;
        if (!request) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(request, 'the door asked the runner for the file');
      const sent = await send(`/api/runner/sessions/${sessionId}/attachments`, runnerToken, kind);
      assert.equal(sent.status, 201, await sent.clone().text());
      const { rows: [row] } = await sql.query(
        'SELECT id FROM attachment WHERE session_id = $1 AND turn_id IS NULL ORDER BY created_at DESC LIMIT 1',
        [sessionId],
      );
      const answered = await call(api, 'POST', `/api/runner/sessions/${sessionId}/artifacts/result`, runnerToken, {
        requestId: request!.id, status: 'uploaded', attachmentId: row.id,
      });
      assert.ok(answered.status === 200 || answered.status === 201, answered.text);
      assertHeld(await reading, kind, 'GET /sessions/:id/worktree-file', 'always');
    });
  }

  await t.test('a profile photo, on both of its doors', async () => {
    const put = await send('/api/users/me/avatar', access, { name: 'me.png', type: 'image/png', bytes: PNG }, 'PUT');
    assert.ok(put.status === 200 || put.status === 201, await put.clone().text());
    for (const route of ['/api/users/me/avatar', `/api/admin/users/${owner.id}/avatar`]) {
      const reply = await call(api, 'GET', route, access);
      assert.equal(reply.status, 200, `${route}: ${reply.text}`);
      assert.equal(reply.headers['content-security-policy'], 'sandbox', route);
      assert.equal(reply.headers['x-content-type-options'], 'nosniff', route);
      assert.equal(reply.headers['content-type'], 'image/png', route);
    }
  });

  await t.test('a row from before Orbit Files, whose bytes are in its own column, is held to the same rule', async () => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO attachment (id, owner_id, session_id, mime_type, size_bytes, file_name, data) VALUES ($1, $2, $3, 'text/html', 13, 'old.html', $4)`,
      [id, owner.id, sessionId, Buffer.from('<p>a page</p>')],
    );
    const kind = { name: 'old.html', type: 'text/html', bytes: Buffer.alloc(0), shown: false };
    assertHeld(await call(api, 'GET', `/api/attachments/${id}`, access), kind, 'GET /attachments/:id', 'unless shown');
  });

  await t.test('a stored type is never taken for more than it says', async () => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO attachment (id, owner_id, session_id, mime_type, size_bytes, file_name, data) VALUES ($1, $2, $3, 'IMAGE/PNG;,text/html', $5, 'odd.png', $4)`,
      [id, owner.id, sessionId, PNG, PNG.length],
    );
    const reply = await call(api, 'GET', `/api/attachments/${id}`, access);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.headers['content-type'], 'image/png');
    assert.equal(reply.headers['content-disposition'], 'inline');
  });

  await t.test('a refusal is no file, and an ordinary answer gains nothing', async () => {
    const refused = await call(api, 'GET', `/api/shared/${sessionToken}/attachments/${randomUUID()}`);
    assert.equal(refused.status, 404);
    assert.equal(refused.headers['content-security-policy'], undefined);
    const ordinary = await call(api, 'GET', '/api/users/me', access);
    assert.equal(ordinary.status, 200, ordinary.text);
    assert.equal(ordinary.headers['content-security-policy'], undefined);
  });
};

test('every door that answers with a user file holds it to the rule', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-user-file-doors-'));
  t.after(async () => {
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });
  await t.test('local', doorCases(sql, scratch, 'local', { ORBIT_FILES_BACKEND: 'local' }));
  const s3 = await startS3((fn) => t.after(fn));
  await t.test('s3', doorCases(sql, scratch, 's3', {
    ORBIT_FILES_BACKEND: 's3',
    ORBIT_FILES_S3_ENDPOINT: s3.endpoint,
    ORBIT_FILES_S3_BUCKET: s3.bucket,
    ORBIT_FILES_S3_ACCESS_KEY_ID: s3.accessKeyId,
    ORBIT_FILES_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    ORBIT_FILES_S3_REGION: s3.region,
  }));
});
