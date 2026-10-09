/**
 * A repository read whose file has a raw NUL in it (2026-10-09), and every write of a runner's answer that the
 * database will not take — contracts/wiki.contract.json `repoOps.storedText`, `.unsettled` and `.abandoned`,
 * `modelQueue.requestEncoding` — against a real PostgreSQL, with the runner's answers sent to the runner gate's
 * own routes over HTTP (RunnerApiController, RunnerAuthGuard, the body parser and filters main.ts serves them
 * with):
 *
 *   1. a file with a raw NUL byte, read at a commit and reported through POST /runner/wiki/repo-ops/:id/result,
 *      is read back by the pipelines' reader — the read cache, the documents' build's view of it — byte for byte
 *      as `git show` printed it; the row keeps it as base64 and says so, and a file without a NUL as it is;
 *   2. a result the database refuses to store (a trigger here, 22P05 in the canary) ends the operation failed at
 *      once: the route answers 422, not 500; the reason is on the row; the job waiting on it hears it within a
 *      poll, not at its 300-second limit; and the runner's second copy is answered with the row's state;
 *   3. a result that is not an answer — a diff path with a NUL, a read with a lone surrogate — and a fragment
 *      with a raw NUL end the operation the same way, with 400;
 *   4. the worker's pass settles what no runner will: running operations whose job has ended (the canary's
 *      three reads) and ones whose claim has been silent for `abandonedSeconds`, and leaves the rest;
 *   5. a model call whose prompt carries the file's NUL is queued and claimed byte for byte;
 *   6. and the model's answer to it, which may copy the NUL: the partial written back while it streams, the
 *      partial a stopping worker leaves, and the answer itself are each kept as the model sent them and read back
 *      byte for byte — the call settles, instead of failing its write with 22021 and running until its lease ends.
 *
 * Every case fails on the code before this change (the route answered 500 and the operation stayed running; a
 * queued call with a NUL was refused 22P05), and needs nothing that change added to compile.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-repo-op-nul.pg.spec.ts
 *
 * Not destructive: it writes only rows under the account it creates, and the trigger case drops what it made.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { PrismaClient } from '@prisma/client';
import { WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY, WIKI_REPO_OPS } from '@orbit/shared';
import { json } from 'express';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { wikiDocsShownOf } from './wiki-docs-build-job';
import { WikiJobExecutor } from './wiki-job-executor';
import { enqueueWikiJob } from './wiki-jobs';
import {
  claimWikiModelRequests,
  enqueueWikiModelRequest,
  releaseWikiModelRequestLease,
  succeedWikiModelRequest,
  wikiModelRequestById,
  wikiModelRequestSha256,
  writeWikiModelRequestPartial,
} from './wiki-model-queue';
import type { WikiModelRequestQueue } from './wiki-model-queue.service';
import {
  WikiRepoOps,
  readCachedWikiRepoFiles,
  readWikiRepoFiles,
  waitForWikiRepoOpAsJob,
  wikiRepoFileText,
} from './wiki-repo-ops';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

// Built rather than written, as runner-api/strip-nul.spec.ts builds it: a raw NUL in this source would be the very
// hazard the spec is about, and the editors on the way would each do something different with the others.
const NUL = String.fromCharCode(0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CONTROL = String.fromCharCode(1) + String.fromCharCode(0x1f);

/** The sweep's silence window, read this way so the spec compiles against the code before it too (and fails there). */
const ABANDONED_SECONDS = (WIKI_REPO_OPS as unknown as { abandonedSeconds?: number }).abandonedSeconds ?? 900;

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  ops: WikiRepoOps;
  app: INestApplication;
  base: string;
  ownerId: string;
  spaceId: string;
  runnerId: string;
  token: string;
  repo: string;
}

let harness: Promise<Harness> | undefined;

/** The runner gate as main.ts serves it, over `prisma`: collaborators no repository route reaches are empty. */
async function gate(prisma: PrismaClient, ops: WikiRepoOps): Promise<INestApplication> {
  @Module({
    controllers: [RunnerApiController],
    providers: [
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: WikiRepoOps, useValue: ops },
      { provide: QueueService, useValue: {} },
      { provide: RealtimeService, useValue: {} },
      { provide: PushService, useValue: {} },
      { provide: RunnerOrchestrationAuthorizer, useValue: {} },
      { provide: ReferenceExpansionService, useValue: {} },
      { provide: ListEventsService, useValue: {} },
      // Optional in the constructor, but Nest resolves every parameter from the module.
      { provide: AttemptBudgetMeterService, useValue: {} },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
    ],
  })
  class RepoOpRoutes {}

  const app = await NestFactory.create(RepoOpRoutes, { logger: false, abortOnError: false, bodyParser: false });
  // The body as main.ts parses it: JSON up to 10 MB, `\u0000` and all.
  app.use(json({ limit: '10mb' }));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  return app;
}

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const ops = new WikiRepoOps(prisma as unknown as PrismaService);
    const app = await gate(prisma, ops);

    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `repo-op-nul-${ownerId}@wiki.invalid`, name: 'repo op nul spec', passwordHash: 'x' } });
    const runnerId = randomUUID();
    const token = `runner-${randomUUID()}`;
    await prisma.runner.create({
      data: {
        id: runnerId, name: `nul-${runnerId.slice(0, 8)}`, ownerId, tokenHash: sha256(token),
        capabilities: [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const workspaceId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, ownerId, name: 'nul checkout', runnerId, workDir: '/tmp/repo-op-nul-spec' } });
    const spaceId = randomUUID();
    await prisma.wikiSpace.create({
      data: {
        id: spaceId, ownerId, slug: `nul-${spaceId.slice(0, 8)}`, title: 'NUL spec',
        repoUrlNorm: 'github.com/example/orbit', rootCommitSha: 'a'.repeat(40), settings: { maintenance: { workspaceId } },
      },
    });
    const repo = mkdtempSync(path.join(tmpdir(), 'repo-op-nul-'));
    return { sql, prisma, ops, app, base: await app.getUrl(), ownerId, spaceId, runnerId, token, repo };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const h = await harness;
  await h.app.close().catch(() => undefined);
  await h.prisma.wikiSpace.deleteMany({ where: { ownerId: h.ownerId } }).catch(() => undefined);
  await h.prisma.runner.deleteMany({ where: { ownerId: h.ownerId } }).catch(() => undefined);
  await h.prisma.workspace.deleteMany({ where: { ownerId: h.ownerId } }).catch(() => undefined);
  await h.prisma.user.deleteMany({ where: { id: h.ownerId } }).catch(() => undefined);
  await h.prisma.$disconnect().catch(() => undefined);
  await h.sql.end().catch(() => undefined);
  rmSync(h.repo, { recursive: true, force: true });
});

// ── the repository, and the runner ───────────────────────────────────────────────────────────────────

/**
 * The file the canary's read stopped on, in small: integration-job-relay.ts's `clipChecks`, whose regular
 * expression has a raw NUL in it, with searchTerms.ts's NUL join — and around them what a JSON encoder and a
 * database each treat specially: CJK, an emoji, U+2028, CRLF, control characters, a backslash, quotes, `<`.
 */
const NUL_FILE = [
  '/** The runner clips its own output, and this clips it again: a row is not a log file. */',
  'function clipChecks(checks: IntegrationCheckResult[]): IntegrationCheckResult[] {',
  '  return checks.slice(0, 8).map((check) => ({',
  '    ...check,',
  "    outputTail: typeof check.outputTail === 'string'",
  '      // eslint-disable-next-line no-control-regex',
  `      ? check.outputTail.replace(/${NUL}/g, '').slice(-MAX_CHECK_OUTPUT_TAIL)`,
  "      : '',",
  '  }));',
  '}',
  `const key = term.join('${NUL}');`,
  `// 中文 😀 ${LINE_SEPARATOR} CRLF\r`,
  `// ${CONTROL} \\ " ' <script>&</script>`,
  '',
].join('\n');
const PLAIN_FILE = '# Plain\n\nNo NUL here: 中文 and an emoji 😀.\n';

/** A commit with the two files, as a checkout has it; and each file as `git show <sha>:<path>` prints it. */
function commit(h: Harness, files: Record<string, string>): { sha: string; shown: Map<string, Buffer> } {
  const git = (...args: string[]): Buffer => execFileSync('git', args, { cwd: h.repo, maxBuffer: 64 * 1024 * 1024 });
  git('init', '-q');
  git('config', 'user.email', 'spec@wiki.invalid');
  git('config', 'user.name', 'repo op nul spec');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
    writeFileSync(path.join(h.repo, file), Buffer.from(text, 'utf8'));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'files a read answers with');
  const sha = git('rev-parse', 'HEAD').toString().trim();
  const shown = new Map<string, Buffer>();
  for (const file of Object.keys(files)) shown.set(file, git('--literal-pathspecs', 'show', `${sha}:${file}`));
  return { sha, shown };
}

/** What src/runner-go/wiki_repo_ops.go's wikiRepoOpReadOne answers for a file `git show` printed. */
function readItem(file: string, bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8');
  return { path: file, found: true, size: bytes.length, text, chars: [...text].length };
}

/**
 * A request body as Go's encoding/json writes it: JSON.stringify spells a NUL `\u0000` as Go does, and Go also
 * escapes <, > and & (and U+2028, U+2029) inside strings — which is the only place they can be in JSON.
 */
function goJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** POST a body, already JSON, to the runner gate as the space's runner. */
async function send(h: Harness, route: string, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${h.base}/api${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
    body,
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { unparsed: text };
  }
  return { status: response.status, body: parsed };
}

/** The operation a heartbeat of the space's runner is handed next, claimed by a process the spec names. */
async function claimNext(h: Harness, kind: string): Promise<{ id: string; claimGeneration: number; leaseOwner: string; input: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await h.prisma.wikiRepoOp.findFirst({ where: { ownerId: h.ownerId, kind, state: 'queued' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (row) {
      const leaseOwner = randomUUID();
      const claimed = await h.ops.dispatch({
        runnerId: h.runnerId, leaseOwner, draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY],
      });
      const mine = claimed.find((one) => one.id === row.id);
      assert.ok(mine, `the heartbeat did not claim ${row.id}`);
      return { id: mine.id, claimGeneration: mine.claimGeneration, leaseOwner, input: mine.input };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no queued ${kind} operation appeared`);
}

async function job(h: Harness, kind = 'docs_build'): Promise<string> {
  const id = randomUUID();
  await enqueueWikiJob(h.prisma as unknown as PrismaService, { id, ownerId: h.ownerId, spaceId: h.spaceId, kind });
  return id;
}

async function opRow(h: Harness, id: string): Promise<{ state: string; error: string | null; result: unknown; lease_owner: string | null; ended_at: Date | null }> {
  return (await h.sql.query('SELECT "state", "error", "result", "lease_owner", "ended_at" FROM "wiki_repo_op" WHERE "id" = $1', [id])).rows[0];
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── 1. the file with a NUL ───────────────────────────────────────────────────────────────────────────

test('a file with a raw NUL byte, reported through the result route, is read back byte for byte as git show printed it', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const { sha, shown } = commit(h, { 'src/runner-api/integration-job-relay.ts': NUL_FILE, 'docs/plain.md': PLAIN_FILE });
  const nulBytes = shown.get('src/runner-api/integration-job-relay.ts')!;
  assert.ok(nulBytes.includes(0), 'git show prints the NUL byte the file has');
  const jobId = await job(h);
  const service = h.prisma as unknown as PrismaService;
  const stop = new AbortController();
  const paths = ['src/runner-api/integration-job-relay.ts', 'docs/plain.md'];
  // The documents' build asks for the files, as `readFiles` does: cache first, the rest a `read` it waits for.
  const reading = readWikiRepoFiles({
    prisma: service, repoOps: h.ops, jobId, ownerId: h.ownerId, spaceId: h.spaceId, sha, paths, wholeFile: true,
    sizeOf: (file) => shown.get(file)!.length, waitMs: 60_000, signal: stop.signal,
  });
  reading.catch(() => undefined);
  try {
    const op = await claimNext(h, 'read');
    assert.deepEqual(op.input, { sha, items: paths.map((file) => ({ path: file })) });
    const items = paths.map((file) => readItem(file, shown.get(file)!));
    const body = goJson({
      claimGeneration: op.claimGeneration, leaseOwner: op.leaseOwner, state: 'succeeded',
      result: { read: { sha, items, chars: items.reduce((n, item) => n + (item.chars as number), 0) } },
    });
    assert.ok(body.includes('\\u0000'), 'the runner sends the NUL as JSON spells it — the escape jsonb refused');
    const answer = await send(h, `/runner/wiki/repo-ops/${op.id}/result`, body);
    assert.equal(answer.status, 200, `the result route stores the answer: ${answer.status} ${JSON.stringify(answer.body).slice(0, 600)}`);
    assert.deepEqual(answer.body, { accepted: true, state: 'succeeded' });

    const files = await reading;
    for (const file of paths) {
      const read = Buffer.from(wikiRepoFileText(files.get(file)), 'utf8');
      assert.equal(digest(read), digest(shown.get(file)!), `${file}: what the pipeline reads is what git show printed (sha256)`);
      assert.ok(read.equals(shown.get(file)!), `${file}: byte for byte`);
    }
    // The documents' build shows the file whole, as the runner's writer did with git show.
    const view = wikiDocsShownOf(files.get('src/runner-api/integration-job-relay.ts')!, nulBytes.length);
    assert.ok(view && Buffer.from(view.text, 'utf8').equals(nulBytes), 'the build\'s view of the file is git show\'s, byte for byte');
    assert.equal(view?.cut, false);

    // Asked again, the cache answers — the same bytes, and no second operation.
    const before = await h.prisma.wikiRepoOp.count({ where: { jobId } });
    const cached = await readCachedWikiRepoFiles(service, { ownerId: h.ownerId, spaceId: h.spaceId, sha, paths, wholeFile: true });
    assert.ok(Buffer.from(cached.get('src/runner-api/integration-job-relay.ts')!.text, 'utf8').equals(nulBytes));
    assert.equal(await h.prisma.wikiRepoOp.count({ where: { jobId } }), before);

    // How the rows keep it: the file with a NUL as its bytes in base64, the other as it is; the operation's own
    // result names what became of each item and carries no text at all.
    const { rows } = await h.sql.query<{ path: string; content: string; content_encoding: string; size_bytes: string }>(
      'SELECT "path", "content", "content_encoding", "size_bytes" FROM "wiki_repo_file" WHERE "space_id" = $1 AND "sha" = $2 ORDER BY "path"',
      [h.spaceId, sha],
    );
    assert.deepEqual(rows.map((row) => [row.path, row.content_encoding, Number(row.size_bytes)]), [
      ['docs/plain.md', 'text', shown.get('docs/plain.md')!.length],
      ['src/runner-api/integration-job-relay.ts', 'base64', nulBytes.length],
    ]);
    assert.equal(rows[0].content, PLAIN_FILE);
    assert.equal(rows[1].content, nulBytes.toString('base64'));
    const settled = await opRow(h, op.id);
    assert.equal(settled.state, 'succeeded');
    assert.deepEqual(settled.result, { read: { sha, items: [
      { path: 'src/runner-api/integration-job-relay.ts', state: 'found', chars: [...nulBytes.toString('utf8')].length },
      { path: 'docs/plain.md', state: 'found', chars: [...PLAIN_FILE].length },
    ] } });
  } finally {
    stop.abort();
    await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
  }
});

// ── 2. a result the database will not store ──────────────────────────────────────────────────────────

test('a result the database refuses ends the operation failed at once: 422, the reason on the row, and the waiting job told within a poll', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const sha = 'c'.repeat(40);
  // Any refusal the data earns: here a trigger refuses one path, as the canary's jsonb refused a NUL (22P05).
  await h.sql.query(`
    CREATE OR REPLACE FUNCTION "repo_op_nul_spec_refuse"() RETURNS trigger AS $$
    BEGIN
      IF NEW."path" = 'docs/refused-by-the-spec.md' THEN
        RAISE EXCEPTION 'the spec refuses to store %', NEW."path";
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await h.sql.query(`CREATE TRIGGER "repo_op_nul_spec_refuse" BEFORE INSERT OR UPDATE ON "wiki_repo_file"
    FOR EACH ROW EXECUTE FUNCTION "repo_op_nul_spec_refuse"()`);
  const jobId = await job(h, 'maintain');
  const stop = new AbortController();
  try {
    // The job is parked on its read with the documents' own limit: 300 seconds.
    const generation = randomUUID();
    const reading = readWikiRepoFiles({
      prisma: h.prisma as unknown as PrismaService, repoOps: h.ops, jobId, ownerId: h.ownerId, spaceId: h.spaceId, sha,
      paths: ['docs/refused-by-the-spec.md'], wholeFile: true, waitMs: 300_000, signal: stop.signal,
    });
    reading.catch(() => undefined);
    const op = await claimNext(h, 'read');
    const result = { read: { sha, items: [{ path: 'docs/refused-by-the-spec.md', found: true, size: 6, text: 'hello\n', chars: 6 }], chars: 6 } };
    const body = goJson({ claimGeneration: op.claimGeneration, leaseOwner: op.leaseOwner, state: 'succeeded', result });
    const started = Date.now();
    const answer = await send(h, `/runner/wiki/repo-ops/${op.id}/result`, body);
    assert.equal(answer.status, 422, `a result the database refused is answered with a final 4xx: ${answer.status} ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'UNSTORABLE_RESULT');
    assert.match(String(answer.body.message), /the spec refuses to store docs\/refused-by-the-spec\.md.*the operation is failed/u);

    const row = await opRow(h, op.id);
    assert.equal(row.state, 'failed', 'the operation is settled, not left running');
    assert.equal(row.lease_owner, null, 'and its claim is cleared');
    assert.ok(row.ended_at);
    assert.match(row.error ?? '', /^the server could not store the runner's result: .*the spec refuses to store docs\/refused-by-the-spec\.md/u);

    // The job hears it within a poll, and says why.
    await assert.rejects(reading, (error: unknown) => /docs\/refused-by-the-spec\.md failed: the server could not store/u.test((error as Error).message));
    assert.ok(Date.now() - started < 15_000, `the waiting read ended in ${Date.now() - started} ms, not at its 300-second limit`);

    // The runner's second copy of the same result — a response it never got — is answered with the row's state.
    const again = await send(h, `/runner/wiki/repo-ops/${op.id}/result`, body);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { accepted: false, state: 'failed' });

    // A job parked on such an operation (waitForWikiRepoOpAsJob) is back in the queue with the reason, at once.
    const parkedJob = await job(h, 'maintain');
    await h.sql.query(
      `UPDATE "wiki_job" SET "state" = 'running', "lease_owner" = $2::uuid, "lease_generation" = $3::uuid,
         "lease_deadline_at" = now() + interval '60 seconds' WHERE "id" = $1`,
      [parkedJob, randomUUID(), generation],
    );
    const { id: parkedOp } = await h.ops.enqueueWikiRepoOp({ jobId: parkedJob, kind: 'read', input: { sha, items: [{ path: 'docs/refused-by-the-spec.md' }] } });
    const parked = waitForWikiRepoOpAsJob(h.prisma as unknown as PrismaService, { jobId: parkedJob, generation, opId: parkedOp, timeoutMs: 300_000, signal: stop.signal });
    const claimed = await claimNext(h, 'read');
    const parkedAt = Date.now();
    const second = await send(h, `/runner/wiki/repo-ops/${claimed.id}/result`, goJson({
      claimGeneration: claimed.claimGeneration, leaseOwner: claimed.leaseOwner, state: 'succeeded', result,
    }));
    assert.equal(second.status, 422);
    const waited = await parked;
    assert.equal(waited.state, 'failed');
    assert.ok(Date.now() - parkedAt < 15_000, 'the parked job is woken by the failure, not by its limit');
    const { rows: [requeued] } = await h.sql.query<{ state: string; failure_kind: string; error: string }>(
      'SELECT "state", "failure_kind", "error" FROM "wiki_job" WHERE "id" = $1', [parkedJob]);
    assert.equal(requeued.state, 'queued');
    assert.equal(requeued.failure_kind, 'infra');
    assert.match(requeued.error, /^REPO_OP_FAILED: read failed: the server could not store the runner's result/u);
    await h.prisma.wikiJob.deleteMany({ where: { id: parkedJob } });
  } finally {
    stop.abort();
    await h.sql.query('DROP TRIGGER IF EXISTS "repo_op_nul_spec_refuse" ON "wiki_repo_file"');
    await h.sql.query('DROP FUNCTION IF EXISTS "repo_op_nul_spec_refuse"()');
    await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
  }
});

// ── 3. answers that are not answers ──────────────────────────────────────────────────────────────────

test('a diff with a NUL in a path, a read with a lone surrogate and a fragment with a raw NUL each end their operation, 400', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const jobId = await job(h, 'maintain');
  try {
    // A diff's paths go into the row as they are, and a path in a tree has no NUL: this is not an answer.
    await h.ops.enqueueWikiRepoOp({ jobId, kind: 'diff', input: { from: 'd'.repeat(40), to: 'e'.repeat(40) } });
    const diff = await claimNext(h, 'diff');
    const refusedDiff = await send(h, `/runner/wiki/repo-ops/${diff.id}/result`, goJson({
      claimGeneration: diff.claimGeneration, leaseOwner: diff.leaseOwner, state: 'succeeded',
      result: { diff: { from: 'd'.repeat(40), to: 'e'.repeat(40), files: [{ status: 'M', path: `src/a${NUL}b.ts` }], docs: [] } },
    }));
    assert.equal(refusedDiff.status, 400, `${refusedDiff.status} ${JSON.stringify(refusedDiff.body)}`);
    assert.equal(refusedDiff.body.code, 'INVALID_RESULT');
    const diffRow = await opRow(h, diff.id);
    assert.equal(diffRow.state, 'failed');
    assert.match(diffRow.error ?? '', /^the server refused the runner's result: the diff result has a U\+0000 or a lone surrogate in it/u);

    // A read whose text JSON spells with an unpaired surrogate (`\ud800`): no bytes decode to it, so no file has it.
    const sha = 'f'.repeat(40);
    await h.ops.enqueueWikiRepoOp({ jobId, kind: 'read', input: { sha, items: [{ path: 'docs/half.md' }] } });
    const half = await claimNext(h, 'read');
    const body = goJson({
      claimGeneration: half.claimGeneration, leaseOwner: half.leaseOwner, state: 'succeeded',
      result: { read: { sha, items: [{ path: 'docs/half.md', found: true, size: 4, text: 'a-LONE-b', chars: 3 }], chars: 3 } },
    }).replace('-LONE-', '\\ud800');
    const refusedRead = await send(h, `/runner/wiki/repo-ops/${half.id}/result`, body);
    assert.equal(refusedRead.status, 400, `${refusedRead.status} ${JSON.stringify(refusedRead.body)}`);
    const halfRow = await opRow(h, half.id);
    assert.equal(halfRow.state, 'failed');
    assert.match(halfRow.error ?? '', /docs\/half\.md answers with a lone surrogate/u);
    assert.equal(await h.prisma.wikiRepoFile.count({ where: { spaceId: h.spaceId, path: 'docs/half.md' } }), 0, 'nothing of it is cached');

    // A fragment is a piece of JSON text, which spells a NUL `\u0000`: a raw one is refused, and ends the upload.
    await h.ops.enqueueWikiRepoOp({ jobId, kind: 'snapshot', input: {} });
    const snapshot = await claimNext(h, 'snapshot');
    const fragment = await send(h, `/runner/wiki/repo-ops/${snapshot.id}/fragments`, JSON.stringify({
      claimGeneration: snapshot.claimGeneration, leaseOwner: snapshot.leaseOwner, sha, index: 0, total: 2, content: `{"readme":"a${NUL}b`,
    }));
    assert.equal(fragment.status, 400, `${fragment.status} ${JSON.stringify(fragment.body)}`);
    const snapshotRow = await opRow(h, snapshot.id);
    assert.equal(snapshotRow.state, 'failed');
    assert.match(snapshotRow.error ?? '', /^the server refused the runner's fragment: a fragment with a raw U\+0000/u);
    assert.equal(await h.prisma.wikiRepoOpFragment.count({ where: { opId: snapshot.id } }), 0);
    // The runner then reports the upload's failure, and is answered with what the row already says.
    const report = await send(h, `/runner/wiki/repo-ops/${snapshot.id}/result`, JSON.stringify({
      claimGeneration: snapshot.claimGeneration, leaseOwner: snapshot.leaseOwner, state: 'failed', error: 'the snapshot payload could not be uploaded: 400',
    }));
    assert.equal(report.status, 200);
    assert.deepEqual(report.body, { accepted: false, state: 'failed' });
  } finally {
    await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
  }
});

// ── 4. what no runner will settle ────────────────────────────────────────────────────────────────────

test('the worker\'s pass settles failed the running operations whose job ended or whose claim went silent, and nothing else', { skip, timeout: 120_000 }, async () => {
  const h = await boot();
  const service = h.prisma as unknown as PrismaService;
  const ended = await job(h, 'maintain');
  await h.sql.query(`UPDATE "wiki_job" SET "state" = 'succeeded', "ended_at" = now() - interval '2 hours' WHERE "id" = $1`, [ended]);
  const live = await job(h, 'docs_build');
  await h.sql.query(`UPDATE "wiki_job" SET "state" = 'waiting', "waiting_for" = 'repo' WHERE "id" = $1`, [live]);

  /** A running operation of the job, claimed `ago` seconds since its last heartbeat. */
  const running = async (jobId: string, ago: number, kind = 'read'): Promise<string> => {
    const { id } = await h.ops.enqueueWikiRepoOp({ jobId, kind: kind as 'read', input: { sha: 'b'.repeat(40), items: [{ path: 'x.md' }] } });
    await h.sql.query(
      `UPDATE "wiki_repo_op" SET "state" = 'running', "runner_id" = $2::uuid, "lease_owner" = $3::uuid, "claim_generation" = 1,
         "claimed_at" = now() - $4::int * interval '1 second', "heartbeat_at" = now() - $4::int * interval '1 second' WHERE "id" = $1`,
      [id, h.runnerId, randomUUID(), ago],
    );
    return id;
  };
  try {
    // The canary's three: reads whose results were refused, still running hours after their maintain job ended.
    const leftovers = [await running(ended, 3 * 3600), await running(ended, 3 * 3600), await running(ended, 3 * 3600)];
    const silent = await running(live, ABANDONED_SECONDS + 60);
    const working = await running(live, 120);
    const justClaimed = await running(ended, 5);
    const { id: stillQueued } = await h.ops.enqueueWikiRepoOp({ jobId: ended, kind: 'read', input: { sha: 'b'.repeat(40), items: [{ path: 'y.md' }] } });

    // The worker's pass — the one it runs every few seconds, under any switch (here: none, the runner path's).
    const worker = new WikiJobExecutor(service, {} as unknown as WikiModelRequestQueue, {}, {});
    await worker.runOnce();

    for (const id of leftovers) {
      const row = await opRow(h, id);
      assert.equal(row.state, 'failed', `${id} is settled`);
      assert.equal(row.lease_owner, null);
      assert.ok(row.ended_at);
      assert.equal(row.error, `the job (maintain ${ended}) ended succeeded with this read still running: nobody waits for its answer, so it is closed`);
    }
    const silentRow = await opRow(h, silent);
    assert.equal(silentRow.state, 'failed');
    assert.match(silentRow.error ?? '', /^the runner's claim has been silent since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ and no answer came/u);
    assert.equal((await opRow(h, working)).state, 'running', 'a claim that is merely slow is left to its runner');
    assert.equal((await opRow(h, justClaimed)).state, 'running', 'a result about to arrive is not raced: the takeover window first');
    assert.equal((await opRow(h, stillQueued)).state, 'queued', 'a queued operation is not running anything');

    // A late result of a settled one is answered with its state, and a second pass changes nothing.
    await worker.runOnce();
    assert.equal((await opRow(h, working)).state, 'running');
  } finally {
    await h.prisma.wikiJob.deleteMany({ where: { id: { in: [ended, live] } } });
  }
});

// ── 5. the model call that carries the file ──────────────────────────────────────────────────────────

test('a model call whose prompt has the file\'s NUL in it is queued and claimed byte for byte', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const service = h.prisma as unknown as PrismaService;
  const jobId = await job(h, 'docs_build');
  try {
    const call = { system: `system ${LINE_SEPARATOR}`, prompt: `## 可用材料\n[C1] src/runner-api/integration-job-relay.ts\n${NUL_FILE}`, maxTokens: 4096 };
    const { id, inserted } = await enqueueWikiModelRequest(service, {
      id: randomUUID(), jobId, ownerId: h.ownerId, spaceId: h.spaceId, step: 'docs_write', unit: 'nul#s1', request: call,
    });
    assert.equal(inserted, true, 'the call is queued: jsonb refused its NUL before');
    const { rows: [stored] } = await h.sql.query<{ request: Record<string, unknown>; request_sha256: string }>(
      'SELECT "request", "request_sha256" FROM "wiki_model_request" WHERE "id" = $1', [id]);
    assert.equal(stored.request.encoding, 'base64', 'the row says how it keeps the call');
    assert.equal(stored.request_sha256, wikiModelRequestSha256(call), 'the digest is the call\'s');
    const claimed = await claimWikiModelRequests(service, { workerId: randomUUID(), concurrency: 4, owners: [h.ownerId] });
    const mine = claimed.find((one) => one.id === id);
    assert.ok(mine, 'the call is claimed');
    assert.ok(Buffer.from(mine.request.prompt, 'utf8').equals(Buffer.from(call.prompt, 'utf8')), 'the prompt the model is sent is the one the pipeline made');
    assert.equal(mine.request.system, call.system);
    assert.equal(mine.request.maxTokens, call.maxTokens);
  } finally {
    await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
  }
});

// ── 6. the answer that carries it back ───────────────────────────────────────────────────────────────

test('the model\'s answer with the NUL copied into it — partial, released partial, answer — is kept and read back byte for byte', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const service = h.prisma as unknown as PrismaService;
  const jobId = await job(h, 'docs_build');
  try {
    const call = { system: 'system', prompt: `[C1]\n${NUL_FILE}`, maxTokens: 4096 };
    const queued = async (unit: string) => (await enqueueWikiModelRequest(service, {
      id: randomUUID(), jobId, ownerId: h.ownerId, spaceId: h.spaceId, step: 'docs_write', unit, request: { ...call, prompt: `${call.prompt}${unit}` },
    })).id;
    const first = await queued('nul#answer');
    const second = await queued('nul#released');
    const claimed = await claimWikiModelRequests(service, { workerId: randomUUID(), concurrency: 4, owners: [h.ownerId] });
    const generation = (id: string) => claimed.find((one) => one.id === id)?.leaseGeneration ?? '';
    const answer = `### 本节\n本节依据 C1 写成一句话[C1]。\n\n引文：\n[C1] 「? check.outputTail.replace(/${NUL}/g, '')」\n`;
    const partial = answer.slice(0, answer.indexOf(NUL) + 2);

    // While it streams, the text so far is written back with its NUL ...
    assert.equal(await writeWikiModelRequestPartial(service, { id: first, generation: generation(first), partial }), true);
    assert.ok(Buffer.from((await wikiModelRequestById(service, first))?.partial ?? '', 'utf8').equals(Buffer.from(partial, 'utf8')));
    // ... and the answer it ends with is written once, the call settled.
    assert.equal(await succeedWikiModelRequest(service, { id: first, generation: generation(first), answer, inputTokens: 10, outputTokens: 20, httpStatus: 200 }), true);
    const settled = await wikiModelRequestById(service, first);
    assert.equal(settled?.state, 'succeeded');
    assert.ok(Buffer.from(settled?.answer ?? '', 'utf8').equals(Buffer.from(answer, 'utf8')), 'the answer the job reads is the one the model sent');
    const { rows: [row] } = await h.sql.query<{ answer: string; answer_encoding: string; partial_encoding: string }>(
      'SELECT "answer", "answer_encoding", "partial_encoding" FROM "wiki_model_request" WHERE "id" = $1', [first]);
    assert.deepEqual([row.answer_encoding, row.partial_encoding], ['base64', 'base64'], 'each kept as its bytes, and saying so');
    assert.equal(row.answer, Buffer.from(answer, 'utf8').toString('base64'));

    // A stopping worker leaves the partial it had, and the next claim is handed it back as it came.
    assert.equal(await releaseWikiModelRequestLease(service, { id: second, generation: generation(second), partial }), true);
    await h.sql.query(`UPDATE "wiki_model_request" SET "state" = 'queued', "lease_owner" = NULL, "lease_generation" = NULL,
      "lease_deadline_at" = NULL WHERE "id" = $1`, [second]);
    const again = await claimWikiModelRequests(service, { workerId: randomUUID(), concurrency: 4, owners: [h.ownerId] });
    const resumed = again.find((one) => one.id === second);
    assert.ok(resumed, 'the call is claimed again');
    assert.ok(Buffer.from(resumed.partial ?? '', 'utf8').equals(Buffer.from(partial, 'utf8')), 'with the partial it had, NUL and all');
  } finally {
    await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
  }
});
