/**
 * The server-executed maintenance run (contracts/wiki.contract.json `jobs.kindRuns.maintain`,
 * `maintenance.job.server`; design §5 and §8, P8), against a real PostgreSQL and a System model played by a
 * local Node http server — the same harness the verify and docs jobs' specs use, with the space's runner
 * played by a poll that settles the `wiki_repo_op` rows the run enqueues:
 *
 *   1. a whole run: the dossiers read, one extract request per dossier through the queue, the entries checked
 *      against their lines and the snapshot (an off-topic case, a foreign anchor, a principle and a quote the
 *      retry corrects), the batches dry-run and proposed with origin maintenance under the run's wiki job,
 *      the cursor advanced past the sessions whose ops were recorded, the run's own ops verified, the anchors
 *      re-checked through a repository operation, no document written without a confirmed plan, the report
 *      with its token spend, and the articles job a successful run owes queued behind it;
 *   2. a run made while the space was catching up skips the documents and the plan proposal whole, and owes
 *      no articles job;
 *   3. the breaker: with a space holding the floor of active entries and two pages of dossiers, the second
 *      page's ops are held back and the cursor stops where that page starts;
 *   4. failure: a repository operation the runner never answers is the platform's — the job goes back to
 *      queued and nothing is counted against the space. A refusal of the run's own ends it failed, counts it
 *      and fails the job as content;
 *   5. the anchors step: a page of two entries whose anchors collide on the per-entry index is checked as
 *      one repository operation, and each entry records only its own checks — a symbol without a baseline
 *      adopts its own region, never a page-mate's (the canary incident: per-entry indexes mapped back
 *      through one Map overwrote each other, and entries took the last entry's verdict for their index);
 *   6. an anchor verdict whose echo names another anchor than the one at its index fails the run as
 *      content: the run refuses to lay a verdict on a guess;
 *   7. the documents step with a confirmed plan: it reads the plan through its read, where a section's projects are
 *      { id, title }, and the section's material is found by the project's id (2026-10-09: 22P02, nothing written);
 *   8. a worker that stops while the documents step waits for a read: the job is handed back (design §5.4) — the
 *      run not settled, no REPO_OP_FAILED, no read asked again, nothing counted, and the health line still reads the
 *      run under way with no failure — and the next worker takes it over;
 *   9. the plan proposal (2026-10-09, run 28ea4f5c): a new design document's sections named as the proposal prompt
 *      lists them, `##` and all, are found in the document as the runner finds them, and the proposal is stored;
 *  10. the anchors' batch (2026-10-10): a page is `listEntriesMax` entries — the most one `anchors` repository
 *      operation carries, four times what the default page sent — so 400 entries are two operations and not
 *      eight, each inside `RepoOps.operationBytes`; and
 *  11. a page of 201 entries: every entry keeps its own check across the page boundary and the report-sized
 *      writes a page this size is recorded in, and the page's tail entry is written like the rest;
 *  12. a second run on the commit an earlier run checked (2026-10-10, `anchorRules.verify.skip`): the same space
 *      run again on the same snapshot sends the runner no anchor at all, writes nothing, and reports the entries
 *      it left alone under `skipped` — the replay after a REPO_OP_WAIT, which used to re-check all ~7,700 anchors;
 *  13. a snapshot that moved, and does not reach the commit the checks were made on, re-checks every entry, and its
 *      checks carry the commit that just moved;
 *  14. a mixed page: only the entries that still owe a check at this commit go out — one checked here, one
 *      unchecked, one that names its own baseline (a Re-confirm's shape, which no rule can prove holds), one whose
 *      check adopted its region;
 *  15. a symbol whose baseline the owner's Re-confirm moved is re-checked, though its check stands on this commit;
 *  15a. a check nothing has moved since owes nothing either (2026-10-10, `anchorRules.verify.skip`, P10's rounds re-checked
 *      all ~11,600 anchors once main moved, every one of them unchanged): a path checked on an earlier commit the
 *      snapshot reaches is checked again when the diff since names it, or a file under it, as anything but a
 *      modification — an A, a D, a T, either side of an R, a C's new side — and left alone, unwritten, when it only
 *      modifies it; a path found missing is checked again; a symbol on any change to its file, and always when it
 *      names its own baseline or was re-confirmed; a commit found verified is left alone while the snapshot reaches it,
 *      and one found missing or no longer reached is checked again; the diffs go to the `anchorDiffsMax` commits most
 *      anchors were checked at, one at a time, and what is checked at any other is checked again; the entries that
 *      still owe a check go out together whichever page they were read on; and a diff the runner could not make
 *      vouches for nothing.
 *  16. the documents step's comparison by commit (2026-10-10, P10's rounds f098cd24 and 54755b7b: ~107 single-file
 *      reads a round, one at a time): eleven written sections on three commits whose files the diffs name, around
 *      them a commit the snapshot does not reach, an empty diff, the head and a section with no file, a file deleted
 *      and one renamed — the same sections are written again and the same paths withdrawn as the reads section by
 *      section gave (the rename by its old path since 18), one `diff` a commit, and the files are read with one
 *      `read` a commit and one at the head instead of one a section at each end, each operation asked once the one
 *      before it has settled;
 *  17. a commit whose files are more than `RepoOps.operationBytes` is read in the fewest operations that limit
 *      allows, at the commit and at the head alike;
 *  18. a rename and a deletion as the runner's comparison takes them (2026-10-10, `wikiGitChanges`), on the repository
 *      of wiki_maintain_docs_test.go's TestWikiMaintainWritesOnlyTheSectionsItsEntriesAndOriginMainTouched: a section
 *      citing only a renamed file's old path, and one citing only a deleted file, are the repository's — each file read
 *      at the section's commit, where it still is — and the rename is withdrawn by its old path, `to` where it went;
 *  19. a rename that changed the file as well, and a deleted file no sentence cites: the sections citing either end of
 *      the rename and the one citing the deleted file are written again, and the old path is withdrawn, the new not;
 *  20. a run's tokens are its own requests, each once (P10 round 93: the documents step's calls were counted twice,
 *      once as each was asked and again from the build's summary): the run's and the documents step's;
 *  21. a worker stopped mid-run hands the run back, and the report the replay ends with is the whole run's (contract
 *      `jobs.carry`): stopped in the documents step, the dossiers the run read, the ops it recorded, the verdicts and
 *      the anchor checks before the stop are counted with the sections written after it — exactly what the same run
 *      reports when nothing stops it; stopped between the run's own verdicts, the verdict recorded before the stop is
 *      counted; stopped between two anchors operations, every entry is counted checked once, none of the first
 *      operation's as skipped.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-maintain-job.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, spaces and sessions, and deletes them
 * afterwards.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, test } from 'node:test';

import type { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { encodeCursorToken, WikiMaintenance } from '../wiki/wiki-maintenance';
import { rebaselinedAnchors } from '../wiki/wiki-anchors';
import { wikiDocsAffected } from '../wiki/wiki-docs-affected';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { WikiDocs } from '../wiki/wiki-docs';
import { WikiHealth } from '../wiki/wiki-health';
import { WikiPlans } from '../wiki/wiki-plan';
import { WikiRefusalError, WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { WikiRepoOps, type WikiRepoOpWake } from './wiki-repo-ops';
import { WIKI_ANCHOR_RULES, WIKI_DOCS_BUILD_JOB, WIKI_JOB, WIKI_LIMITS, WIKI_MAINTAIN_JOB, WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY, WIKI_REPO_OPS } from '@orbit/shared';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, type WikiJobRunner } from './wiki-job-executor';
import { claimWikiJobs, reclaimExpiredWikiJobs, WIKI_JOB_HANDED_BACK } from './wiki-jobs';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';
import { wikiMaintainJobPrincipal, wikiMaintainJobRunner, type WikiMaintainJobDeps } from './wiki-maintain-job';
import { wikiStoredText } from './wiki-stored-text';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

interface Hit {
  prompt: string;
}

interface FakeModel {
  base: string;
  answer: (hit: Hit) => string;
  hits: Hit[];
  /** Waited for before a call is answered: a case holds a call here while it stops the worker. */
  hold: (hit: Hit) => Promise<void>;
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const hits: Hit[] = [];
  const state = {
    base: '',
    answer: (): string => '[]',
    hits,
    hold: async () => undefined,
    close: async () => undefined,
  } as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => void (async () => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let prompt = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        prompt = parsed.messages?.[0]?.content ?? '';
      } catch {
        prompt = '';
      }
      hits.push({ prompt });
      await state.hold({ prompt });
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      const write = (what: string) => {
        try {
          response.write(what);
        } catch {
          /* the call was abandoned */
        }
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } }));
      write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.answer({ prompt }) } }));
      write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }));
      write(event('message_stop', { type: 'message_stop' }));
      try {
        response.end();
      } catch {
        /* the call was abandoned */
      }
    })());
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  service: WikiService;
  docs: WikiDocs;
  plans: WikiPlans;
  maintenance: WikiMaintenance;
  repoOps: WikiRepoOps;
  ownerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const model = await fakeModel();
    const hub = { publishWikiChanged: () => undefined } as unknown as RealtimeService;
    const push = {
      notifyWikiVerificationTripped: async () => undefined,
      notifyWikiReviewModeTripped: async () => undefined,
      notifyWikiMaintenanceFailing: async () => undefined,
    } as unknown as PushService;
    const service = new WikiService(prisma as unknown as PrismaService, hub, push);
    const maintenance = new WikiMaintenance(prisma as unknown as PrismaService, push);
    const docs = new WikiDocs(prisma as unknown as PrismaService, service);
    const plans = new WikiPlans(prisma as unknown as PrismaService, hub);
    const repoOps = new WikiRepoOps(prisma as unknown as PrismaService);
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-maintain-job-${ownerId}@wiki.invalid`, name: 'maintain job spec', passwordHash: 'x' } });
    // The server executes this account's wiki: what makes the executor claim its jobs and the run's end owe
    // the articles job (contract `jobs.executor`, `articles.regeneration`). Cleared in `after`.
    process.env.ORBIT_WIKI_EXECUTOR = 'server';
    return { sql, prisma, model, service, docs, plans, maintenance, repoOps, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, model, ownerId } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

function config(h: Harness, concurrency = 2): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ORBIT_WIKI_MODEL_CONCURRENCY: String(concurrency),
  });
}

/** Where the run reads its repository at: the snapshot's commit, its files and what the gates answer from. */
const REPO = {
  sha: 'a'.repeat(40),
  paths: ['src/app.go', 'docs/README.md', 'README.md'],
  commits: [],
  readme: 'App is the spec\'s own service, small enough to read in a minute.',
};

interface Fixture {
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  sessionId: string;
  callId: string;
  jobId: string;
  runId: string;
  /** The position the page's cursor names, which the cursor row's issued position covers. */
  position: { at: Date; kind: string; ref: string };
  token: string;
}

/**
 * One space of the spec's own, with a machine and a checkout behind it, the snapshot the run reads, a
 * settled session record a dossier line may cite, and the run row and job the trigger would have made.
 */
async function fixture(
  h: Harness,
  over: {
    catchUp?: string | null;
    expect?: boolean;
    activeEntries?: number;
    /** The machine reads whole files (`wiki-repo-op-read/v1`), as production's runners do since 0.1.225. */
    wholeFile?: boolean;
    /** The files the snapshot adds, the commits it reaches, and sizes its index gives where they are not the text's. */
    snapshot?: { files: Record<string, string>; commits: string[]; sizes?: Record<string, number> };
  } = {},
): Promise<Fixture> {
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: {
      id: runnerId, name: `maintain-${runnerId.slice(0, 8)}`, ownerId: h.ownerId, tokenHash: `hash-${runnerId}`,
      capabilities: over.wholeFile === true ? [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY] : [WIKI_REPO_OP_CAPABILITY],
      capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({
    data: { id: workspaceId, ownerId: h.ownerId, name: 'maintain checkout', runnerId, workDir: '/tmp/maintain-spec' },
  });
  const spaceId = randomUUID();
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: h.ownerId, slug: `maintain-${spaceId.slice(0, 8)}`, title: 'app',
      repoUrlNorm: `github.com/example/app-${spaceId.slice(0, 8)}`, rootCommitSha: 'b'.repeat(40),
      settings: { reviewMode: 'automatic', maintenance: { enabled: true, workspaceId, provider: 'local-vllm' } },
    },
  });
  const sessionId = randomUUID();
  await h.prisma.session.create({
    data: {
      id: sessionId, title: '修 fixture 的端口', prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId,
      dispatchOrigin: 'USER', status: 'SUCCEEDED', lastTurnAt: new Date(), workspaceId,
    },
  });
  const callId = randomUUID();
  await h.sql.query(`INSERT INTO "tool_call"("id","session_id","name","output") VALUES ($1,$2,'Bash',$3)`, [
    callId, sessionId, JSON.stringify('$ go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000'),
  ]);
  // The snapshot the run reads: the index the runner would have uploaded, and the sha the op names.
  const extra = Object.entries(over.snapshot?.files ?? {});
  const index = JSON.stringify({
    sha: REPO.sha, date: '2026-09-20',
    files: [
      ...REPO.paths.map((path) => ({ path, size: 100 })),
      ...extra.map(([path, text]) => ({ path, size: over.snapshot?.sizes?.[path] ?? Buffer.byteLength(text, 'utf8') })),
    ],
    docs: [
      { path: 'docs/README.md', title: 'App', headings: [{ level: 1, text: 'App' }] },
      ...extra.filter(([path]) => path.endsWith('.md')).map(([path, text]) => indexedDoc(path, text)),
    ],
    symbols: { 'src/app.go': ['main'] },
    contracts: null,
    commits: over.snapshot?.commits ?? REPO.commits,
    readme: REPO.readme,
  });
  await h.sql.query(
    `INSERT INTO "wiki_repo_snapshot"("space_id","owner_id","sha","digest","size_bytes","fragment_count")
     VALUES ($1,$2,$3,$4,$5,1)`,
    [spaceId, h.ownerId, REPO.sha, 'c'.repeat(64), Buffer.byteLength(index, 'utf8')],
  );
  await h.sql.query(`INSERT INTO "wiki_repo_snapshot_fragment"("space_id","ordinal","content") VALUES ($1,0,$2)`, [spaceId, index]);
  // The cursor: the watermark at the beginning, and the position the page below hands out, issued — the
  // advance the run makes is checked against it, as the real route's would be.
  const position = { at: new Date('2026-09-20T00:00:00.000Z'), kind: 'session_settled', ref: sessionId };
  await h.sql.query(
    `INSERT INTO "wiki_cursor"("id","space_id","owner_id","source","issued_at","issued_kind","issued_ref")
     VALUES ($1,$2,$3,'facts',$4,$5,$6)`,
    [randomUUID(), spaceId, h.ownerId, position.at.toISOString(), position.kind, position.ref],
  );
  for (let i = 0; i < (over.activeEntries ?? 0); i += 1) {
    await h.prisma.wikiEntry.create({
      data: {
        ownerId: h.ownerId, spaceId, kind: 'concept', title: `existing ${i}`, summary: 'a live entry', status: 'active',
        trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [], anchors: [],
      },
    });
  }
  const runId = randomUUID();
  const jobId = randomUUID();
  const token = over.expect === false ? null : encodeCursorToken(spaceId, position as never);
  await h.prisma.wikiMaintenanceRun.create({
    data: {
      id: runId, spaceId, ownerId: h.ownerId, jobId, due: 'backlog', backlog: 1, pendingSessions: 1,
      oldestPendingAt: position.at, catchUp: over.catchUp ?? null,
      ...(token ? { expectAt: position.at, expectKind: position.kind, expectRef: position.ref } : {}),
    },
  });
  await h.prisma.wikiJob.create({ data: { id: jobId, ownerId: h.ownerId, spaceId, kind: 'maintain', input: { runId }, state: 'queued' } });
  return { spaceId, workspaceId, runnerId, sessionId, callId, jobId, runId, position, token: token ?? '' };
}

/**
 * A document as the runner's snapshot indexes it (wiki_plan_repo.go `wikiPlanHeadings`): its ATX headings outside
 * fenced code — a fence closed only by its own kind — none of them empty, and its first level-1 heading as its title.
 */
function indexedDoc(file: string, text: string): { path: string; title: string; headings: Array<{ level: number; text: string }> } {
  const headings: Array<{ level: number; text: string }> = [];
  let fence = '';
  for (const line of text.split('\n')) {
    const opened = /^[\t\n\f\r ]*(```+|~~~+)/u.exec(line);
    if (opened) {
      const token = opened[1].slice(0, 3);
      if (fence === '') fence = token;
      else if (token === fence) fence = '';
      continue;
    }
    if (fence !== '') continue;
    const heading = /^(#{1,6})[\t\n\f\r ]+(.*?)[\t\n\f\r ]*#*[\t\n\f\r ]*$/u.exec(line);
    if (heading && heading[2].trim() !== '') headings.push({ level: heading[1].length, text: heading[2].trim() });
  }
  return { path: file, title: headings.find((one) => one.level === 1)?.text ?? '', headings };
}

/** The workers this case started; a case that fails halfway must not leave one claiming the next one's jobs. */
const live: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];

afterEach(async () => {
  for (const one of live.splice(0)) {
    await one.executor.onModuleDestroy().catch(() => undefined);
    await one.queue.onModuleDestroy().catch(() => undefined);
  }
});

/**
 * The lease this spec's worker claims under: the deployment's own — the same lease and renewal every claim
 * outside a spec gets. No case of this spec is about a lease running out, so the harness must not claim under
 * a shortened one: the 400 ms it used to be is what made these cases red at load 40–65. A stall of the event
 * loop longer than the row's lease leaves the job take-over-able the moment the loop comes back, and the sweep
 * of the next pass runs it a second time — the case then reads the second attempt's work. And the stall a
 * loaded host produces here is not a fraction of a second: a run at load 39 had one of 24 s (2026-10-10).
 * wiki-jobs.pg.spec.ts is the one file that claims under a short lease on purpose: there the lease is the
 * subject. The last two cases of this file pin this margin the deterministic way.
 */
const HARNESS_LEASE_MS = WIKI_JOB.leaseSeconds * 1000;
const HARNESS_RENEW_MS = WIKI_JOB.renewSeconds * 1000;

/**
 * What the runner this spec plays announces as it settles an operation, as the `wiki_repo_op` channel's NOTIFY does:
 * a worker made with `wake` hears it, and its wait for an operation ends at once instead of at the next 2-second poll.
 */
const settledListeners = new Set<(opId: string) => void>();
const REPO_WAKE: WikiRepoOpWake = {
  onChange(listener) {
    settledListeners.add(listener);
    return () => settledListeners.delete(listener);
  },
};

/** The worker under test, its kind map the one the worker module builds — with this spec's services. */
function worker(h: Harness, over: { repoWaitMs?: number; wake?: boolean } = {}): { queue: WikiModelRequestQueue; executor: WikiJobExecutor } {
  const options = { leaseMs: HARNESS_LEASE_MS, renewMs: HARNESS_RENEW_MS, partialMs: 40, pollMs: 30 };
  const config_ = config(h);
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config_,
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config_), undefined, options,
  );
  const deps: WikiMaintainJobDeps = {
    prisma: h.prisma as unknown as PrismaService,
    wiki: h.service,
    maintenance: h.maintenance,
    docs: h.docs,
    plans: h.plans,
    repoOps: h.repoOps,
    model: MODEL,
    modelBaseUrl: h.model.base,
    repoWaitMs: over.repoWaitMs ?? 5_000,
    ...(over.wake === true ? { repoWake: REPO_WAKE } : {}),
  };
  const runners: Record<string, WikiJobRunner> = { ...WIKI_JOB_RUNNERS, maintain: wikiMaintainJobRunner(deps) };
  const executor = new WikiJobExecutor(h.prisma as unknown as PrismaService, queue, options, runners);
  live.push({ queue, executor });
  return { queue, executor };
}

async function modelUp(h: Harness): Promise<void> {
  await new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h)).check();
}

/**
 * What one case leaves behind for the next: the jobs and requests of the account, and the fake model's
 * record of the calls.
 */
async function clearWork(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_job" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_request" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_status"');
  h.model.hits.length = 0;
  h.model.answer = () => '[]';
  h.model.hold = async () => undefined;
  await modelUp(h);
}

/** What the runner this spec plays answers besides its defaults. */
interface RunnerPlay {
  failSnapshot?: boolean;
  holdReads?: boolean;
  /** An anchors operation stays queued, as on a runner whose fetch hangs. */
  holdAnchors?: boolean;
  /** The commit the runner says origin/main is at: the spec's own, unless a case has moved it. */
  snapshotSha?: string;
  checkAnchor?: (anchor: Record<string, unknown>) => Record<string, unknown>;
  /** Files whose reads are answered with their text — and cached, as the result route caches a read. */
  files?: Record<string, string>;
  /** What a diff between two commits names. */
  diff?: { files: Array<{ status: string; path: string }>; docs: string[] };
  /**
   * The files at each commit, by commit: a read is answered at the commit it names — a file the commit has with its
   * text, any other as missing — and every item is cached at that commit, as the result route settles a read.
   */
  filesAt?: Record<string, Record<string, string>>;
  /** What the diff from each commit names, by its `from`: a rename names where it came from and where it went. */
  diffs?: Record<string, { files: Array<{ status: string; path: string; from?: string }>; docs: string[] }>;
  /** Every diff fails, as on a checkout git cannot diff in. */
  failDiffs?: boolean;
}

/**
 * The runner this spec plays: every queued repository operation is answered at once, by kind — but a read, under
 * `holdReads`, which stays queued as on a runner whose fetch hangs.
 */
async function runRepoOps(h: Harness, over: RunnerPlay = {}): Promise<number> {
  const rows = await h.sql.query<{ id: string; kind: string; input: Record<string, unknown>; space_id: string }>(
    `SELECT "id", "kind", "input", "space_id" FROM "wiki_repo_op" WHERE "owner_id" = $1 AND "state" = 'queued' ORDER BY "created_at"`,
    [h.ownerId],
  ).then((result) => result.rows);
  for (const row of rows) {
    if (over.holdReads === true && row.kind === 'read') continue;
    if (over.holdAnchors === true && row.kind === 'anchors') continue;
    if (over.failSnapshot === true && row.kind === 'snapshot') {
      await h.sql.query(`UPDATE "wiki_repo_op" SET "state"='failed', "error"='the machine went away', "ended_at"=now() WHERE "id"=$1`, [row.id]);
      continue;
    }
    if (over.failDiffs === true && row.kind === 'diff') {
      await h.sql.query(`UPDATE "wiki_repo_op" SET "state"='failed', "error"='git diff failed', "ended_at"=now() WHERE "id"=$1`, [row.id]);
      for (const listener of [...settledListeners]) listener(row.id);
      continue;
    }
    const input = row.input ?? {};
    const head = over.snapshotSha ?? REPO.sha;
    const from = String(input.from ?? '');
    const result = row.kind === 'snapshot'
      ? { sha: head }
      : row.kind === 'read'
        ? {
            read: over.filesAt
              ? { sha: String(input.sha ?? ''), items: await readItemsAt(h, row.space_id, input, over.filesAt), chars: 12 }
              : { sha: REPO.sha, items: await readItems(h, row.space_id, input, over.files ?? {}), chars: 12 },
          }
        : row.kind === 'diff'
          ? {
              diff: {
                from, to: String(input.to ?? ''),
                ...(over.diffs ? (over.diffs[from] ?? { files: [], docs: [] }) : { files: over.diff?.files ?? [], docs: over.diff?.docs ?? [] }),
              },
            }
          : {
              anchors: {
                sha: head,
                anchors: (Array.isArray(input.anchors) ? input.anchors : []).map(
                  (anchor: Record<string, unknown>) => over.checkAnchor?.(anchor) ?? {
                    ...anchor,
                    state: 'verified',
                    // A symbol's region hash is required of a symbol that was found and of nothing else.
                    ...(anchor.type === 'symbol' ? { regionSha256: 'd'.repeat(64) } : {}),
                  },
                ),
              },
            };
    await h.sql.query(`UPDATE "wiki_repo_op" SET "state"='succeeded', "result"=$2::jsonb, "ended_at"=now() WHERE "id"=$1`, [row.id, JSON.stringify(result)]);
    for (const listener of [...settledListeners]) listener(row.id);
  }
  return rows.length;
}

/** A read's items at the commit it names (`RunnerPlay.filesAt`), each cached there as the result route caches it. */
async function readItemsAt(
  h: Harness,
  spaceId: string,
  input: Record<string, unknown>,
  filesAt: Record<string, Record<string, string>>,
): Promise<Array<Record<string, unknown>>> {
  const sha = String(input.sha ?? '');
  const items: Array<Record<string, unknown>> = [];
  for (const item of (Array.isArray(input.items) ? input.items : []) as Array<{ path?: unknown }>) {
    const path = String(item.path ?? '');
    const text = filesAt[sha]?.[path];
    const stored = wikiStoredText(text ?? '');
    const held = {
      state: text === undefined ? 'missing' : 'found', content: stored.content, contentEncoding: stored.encoding,
      sizeBytes: BigInt(Buffer.byteLength(text ?? '', 'utf8')),
    };
    await h.prisma.wikiRepoFile.upsert({
      where: { spaceId_sha_path: { spaceId, sha, path } },
      create: { ownerId: h.ownerId, spaceId, sha, path, ...held },
      update: held,
    });
    items.push(text === undefined ? { path, found: false, chars: 0 } : { path, found: true, text, chars: [...text].length });
  }
  return items;
}

/** A read's items: a file the case gives is answered with its text, and cached as the result route caches a read; any other with a stub. */
async function readItems(h: Harness, spaceId: string, input: Record<string, unknown>, files: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  for (const item of (Array.isArray(input.items) ? input.items : []) as Array<{ path?: unknown }>) {
    const file = String(item.path ?? '');
    const text = files[file];
    if (text === undefined) {
      items.push({ path: file, found: true, text: 'package app\n', chars: 12 });
      continue;
    }
    const stored = wikiStoredText(text);
    const held = { state: 'found', content: stored.content, contentEncoding: stored.encoding, sizeBytes: BigInt(Buffer.byteLength(text, 'utf8')) };
    await h.prisma.wikiRepoFile.upsert({
      where: { spaceId_sha_path: { spaceId, sha: REPO.sha, path: file } },
      create: { ownerId: h.ownerId, spaceId, sha: REPO.sha, path: file, ...held },
      update: held,
    });
    items.push({ path: file, found: true, text, chars: [...text].length });
  }
  return items;
}

/** Run the workers and the runner until `done`, or fail the case: a job left queued here is the next case's flake. */
async function pass(
  h: Harness,
  which: { queue: WikiModelRequestQueue; executor: WikiJobExecutor },
  done: () => Promise<boolean>,
  over: RunnerPlay = {},
  rounds = 400,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await which.executor.runOnce();
    await which.queue.runOnce();
    await runRepoOps(h, over);
    if (await done()) return;
    await delay(25);
  }
  const ops = await h.sql.query(`SELECT "kind","state","error" FROM "wiki_repo_op" WHERE "owner_id" = $1 ORDER BY "created_at"`, [h.ownerId]);
  assert.fail(`the worker did not finish: ${JSON.stringify(await jobRows(h))} repo ops ${JSON.stringify(ops.rows)}`);
}

/**
 * Block the event loop for `ms` (the loaded host's own stall, here on demand): no timer of this process fires
 * while it runs, which is what a busy machine does to the lease renewals of a worker on it.
 */
function stallEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* the loop is the point */
  }
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  input: { runId?: string } | null;
  report: Record<string, unknown> | null;
  error: string | null;
  failure_kind: string | null;
}

async function jobRows(h: Harness): Promise<JobRow[]> {
  return h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "input", "report", "error", "failure_kind" FROM "wiki_job"
      WHERE "owner_id" = $1 ORDER BY "created_at", "id"`, [h.ownerId],
  ).then((result) => result.rows);
}

async function jobOf(h: Harness, jobId: string): Promise<JobRow> {
  const rows = await h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "input", "report", "error", "failure_kind" FROM "wiki_job" WHERE "id" = $1`, [jobId],
  );
  return rows.rows[0]!;
}

/** The page the run reads: two dossiers — the port case and one about something else — and the position's token. */
function pageOf(fx: Fixture, options: { offTopic?: boolean; entries?: number; extraPage?: boolean } = {}): unknown {
  const port = dossier(fx, 'session-1', options.entries ?? 2);
  const werewolf = dossier(fx, 'session-2', 0, true);
  const dossiers = options.extraPage === true
    ? [port]
    : [port, ...(options.offTopic === false ? [] : [werewolf])].filter((one) => one !== null);
  return {
    spaceId: fx.spaceId,
    from: 'tok-watermark',
    cursor: fx.token || 'tok-expect',
    more: false,
    facts: dossiers.length,
    dossiers,
    batches: [],
    errorClusters: [],
    state: { position: null, backlog: dossiers.length, consecutiveFailures: 0 },
  };
}

/** One dossier, its lines the fixture's record, as the server's dossier route hands it out. */
function dossier(fx: Fixture, sessionId: string, entryCount: number, offTopic = false, page = 1): Record<string, unknown> {
  const command = 'go test ./...';
  const output = 'connect ECONNREFUSED 127.0.0.1:9000';
  const text = `SESSION: p${page} ${offTopic ? '设计狼人杀软件界面' : '修 fixture 的端口'}\n`
    + 'anthropic/claude-opus-5 · started 2026-09-20 · status SUCCEEDED\n\n'
    + 'L1 owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。\n'
    + `L2 tool: $ ${command} → ERR: ${output}\n`
    + 'L3 agent: 根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。\n';
  const sources = [
    { ref: 'L1', kind: 'turn', id: randomUUID(), spans: [{ start: 0, end: 27, text: '以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。' }] },
    {
      ref: 'L2', kind: 'tool_call', id: fx.callId,
      spans: [{ start: 14, end: 14 + command.length, text: command }, { start: 28, end: 28 + output.length, text: output }],
    },
    { ref: 'L3', kind: 'event', id: randomUUID(), spans: [{ start: 0, end: 36, text: '根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。' }] },
  ];
  return { sessionId, taskId: null, title: offTopic ? '狼人杀' : '修 fixture 的端口', text, tokens: 200, truncated: false, tainted: false, sources, hash: 'e'.repeat(64), unchanged: false };
}

/** What the fake model answers: an extraction per case file, a correction for a retry, a verdict otherwise. */
function extractor(fx: Fixture, entryCount: number): (hit: Hit) => string {
  return (hit) => {
    if (hit.prompt.includes('==== CASE FILE ====')) {
      if (hit.prompt.includes('狼人杀')) return '{"offTopic": true}';
      const page = Number(/SESSION: p(\d+)/u.exec(hit.prompt)?.[1] ?? '1');
      if (hit.prompt.includes('SOME ENTRIES IN YOUR ANSWER WERE REJECTED')) {
        return JSON.stringify([pitfall(fx, 'PORT 在导入时读取，fixture 之后再设无效', { quote: 'connect ECONNREFUSED 127.0.0.1:9000' })]);
      }
      const entries: Array<Record<string, unknown>> = [];
      for (let i = 0; i < entryCount; i += 1) {
        entries.push(pitfall(fx, `PORT 在导入时读取 p${page} ${i}`, { quote: 'connect ECONNREFUSED 127.0.0.1:9000' }));
      }
      // One anchored outside the repository, one principle, and one whose quote is not copied from its line —
      // the checks the runner's tests hold: foreign, owner-only and a retry.
      entries.push(pitfall(fx, `游戏面板渲染慢 p${page}`, { anchors: { paths: ['src/components/GameBoard.tsx'], commits: [] }, quote: 'connect ECONNREFUSED 127.0.0.1:9000' }));
      entries.push({ kind: 'principle', title: '一切从简', summary: '越简单越好。', statement: '从简', rationale: '少出错' });
      entries.push(pitfall(fx, `bad quote p${page}`, { quote: 'connection refused' }));
      return JSON.stringify(entries);
    }
    return '{"verdict":"supported","reason":"the cited turn says exactly this"}';
  };
}

/** A valid pitfall of the fixture's own record. */
function pitfall(fx: Fixture, title: string, over: { quote?: string; anchors?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    kind: 'pitfall',
    title,
    summary: 'PORT 必须在导入前设好。',
    topic: 'testing',
    trigger: { paths: ['src/app.go'], commands: ['go test ./...'], errorSignature: 'connect ECONNREFUSED' },
    symptom: '测试报 ECONNREFUSED',
    cause: '导入时读取 PORT',
    fix: 'fixture 返回 url',
    anchors: over.anchors ?? { paths: ['src/app.go'], commits: [] },
    sources: [{ ref: 'L2', quote: over.quote ?? 'connect ECONNREFUSED 127.0.0.1:9000' }],
    verified: true,
  };
}

async function runRow(h: Harness, runId: string) {
  return h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: runId } });
}

// ── A whole run ─────────────────────────────────────────────────────────────────────────────────

test('a server run reads, checks, proposes, advances, verifies and re-checks the anchors, and owes an articles job', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 2);
  // The dossiers read is the server's own reader; this case hands it the pages the spec wrote.
  const page = pageOf(fx);
  h.maintenance.dossierPage = (async () => page) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  // The run row: succeeded, no op refused, the report and the job that ran it.
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded');
  assert.equal(run.opsRefused, 0);
  assert.equal(run.jobId, fx.jobId);
  assert.ok(run.report, 'the report is kept on the run row');
  const report = run.report as Record<string, unknown>;
  assert.equal(report.sessions, 2);
  assert.equal(report.dossiers, 2);
  assert.equal(report.offTopic, 1, 'the werewolf case is taken as off topic and nothing is kept of it');
  const entries = report.entries as Record<string, number>;
  assert.equal(entries.foreign, 1, 'the game-board entry is another repository\'s knowledge');
  assert.equal(entries.principles, 1, 'a principle is counted and set aside');
  assert.equal(entries.dropped, 0, 'the bad quote was corrected by the retry, so nothing stays dropped');
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.refused, 0);
  assert.equal(ops.recorded, 3, 'two ports and the corrected one');
  assert.equal(ops.selfCheckDropped, 0);
  assert.equal(report.cursorAdvanced, true);
  const tokens = report.tokens as Record<string, number>;
  assert.ok(tokens.calls >= 4, `the extraction, the retry and the verdicts are calls: ${JSON.stringify(tokens)}`);
  assert.ok(tokens.input > 0 && tokens.output > 0);

  // The cursor moved to the page's position.
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.positionRef, fx.position.ref);
  assert.equal(cursor.positionKind, fx.position.kind);
  assert.equal(cursor.consecutiveFailures, 0);

  // The model was asked once per dossier through the queue, the retry under its own unit.
  const requests = await h.sql.query<{ step: string; unit: string }>(
    `SELECT "step", "unit" FROM "wiki_model_request" WHERE "owner_id" = $1 ORDER BY "enqueued_at", "id"`, [h.ownerId],
  ).then((result) => result.rows);
  assert.deepEqual(requests.filter((row) => row.step === 'extract').map((row) => row.unit).sort(), ['session-1', 'session-1#retry', 'session-2']);
  assert.ok(requests.some((row) => row.step === 'verify'), 'the run verified its own ops');

  // The changesets are the run's: origin maintenance, under its wiki job, and their ops were applied by the
  // verdicts the run itself asked for.
  const changesets = await h.prisma.wikiChangeset.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId } });
  assert.ok(changesets.length >= 1);
  for (const changeset of changesets) {
    assert.equal(changeset.origin, 'maintenance');
    assert.equal(changeset.jobId, fx.jobId);
    assert.equal(changeset.sessionId, null);
  }
  const opRows = await h.prisma.wikiChangesetOp.findMany({ where: { ownerId: h.ownerId, changeset: { spaceId: fx.spaceId } } });
  assert.equal(opRows.length, 3);
  assert.ok(opRows.every((op) => op.decision !== 'verifying'), 'every op the run recorded was verified by the run');

  // The anchors went through a repository operation, and the entries it checked are recorded.
  const repoOpKinds = await h.sql.query<{ kind: string }>(
    `SELECT "kind" FROM "wiki_repo_op" WHERE "owner_id" = $1 ORDER BY "created_at"`, [h.ownerId],
  ).then((result) => result.rows.map((row) => row.kind));
  assert.ok(repoOpKinds.includes('snapshot'));
  assert.ok(repoOpKinds.includes('anchors'));
  const anchors = report.anchors as Record<string, number>;
  assert.equal(anchors.entries, 3);
  const stored = await h.prisma.wikiEntry.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId, status: 'active' } });
  assert.equal(stored.length, 3);

  // No confirmed plan: no document was written, and the report says so.
  const docs = report.docs as Record<string, unknown>;
  assert.equal(docs.skipped, 'no_confirmed_plan');

  // The articles job the run's end owes: one, queued, at background priority.
  const jobs = await jobRows(h);
  const articles = jobs.filter((job) => job.kind === 'articles');
  assert.equal(articles.length, 1);
  assert.equal(articles[0]!.state, 'queued');
});

// ── The documents step, with a plan the owner confirmed ────────────────────────────────────────

/**
 * A writer's answer to each of the documents' prompts (wiki-docs-build-job.pg.spec.ts's): every piece handed to the
 * merge adopted, every piece the write prompt lists cited in a sentence of its own with a verbatim quote, and the
 * overview citing the first footnote it was given.
 */
function writerAnswer(prompt: string): string {
  if (prompt.includes('the "merge"')) {
    const ids = [...prompt.matchAll(/^\[([A-Z]\d+)\] /gmu)].map(([, id]) => id);
    return `${ids.map((id) => `${id} | adopt | it is just what this section covers`).join('\n')}\nCurrent state:\n- the point of this section [${ids[0] ?? 'S1'}]\n`;
  }
  if (prompt.includes('(the overview, about')) return '### Overview\nThis document covers where a fixture takes its port from[F1].\n';
  if (prompt.includes('give the footnotes below their verbatim quotes')) return '';
  if (!prompt.includes('# Task: write the document')) return '?';
  const materials = prompt.split('## The materials you may use (cite only these, by the ids they have)\n')[1]?.split('\n\n## How to write')[0] ?? '';
  const sentences: string[] = [];
  const quotes: string[] = [];
  for (const block of materials.split(/\n(?=\[[A-Z]\d+\] )/u)) {
    const id = /^\[([A-Z]\d+)\] /u.exec(block)?.[1];
    if (!id) continue;
    const line = block.split('\n').slice(1).map((one) => one.trim()).find((one) => one.length >= 10 && !one.startsWith('```'));
    sentences.push(`This section rests on ${id} in one sentence[${id}]. `);
    if (line) quotes.push(`[${id}] "${Array.from(line).slice(0, 60).join('')}"`);
  }
  if (sentences.length === 0) return '### Conventions\nThis section covers only where the port comes from.\n';
  return `### This section\n${sentences.join('').trim()}\n\nQuotes:\n${quotes.join('\n')}\n`;
}

test('the documents step reads the confirmed plan through its read, and a section whose projects are { id, title } gets its material', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // A project of the owner's whose coordinator heard the owner's words about the fixture's port.
  const coordinator = randomUUID();
  await h.sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","workspace_id","status","dispatch_origin","updated_at")
     VALUES ($1,'the coordinator','p',$2,$2,$3,'RUNNING'::run_status,'USER',now())`,
    [coordinator, h.ownerId, fx.workspaceId],
  );
  const projectId = randomUUID();
  await h.sql.query(`INSERT INTO "project"("id","title","owner_id","coordinator_session_id","updated_at") VALUES ($1,'Fixture 端口',$2,$3,now())`, [projectId, h.ownerId, coordinator]);
  const WORDS = '以后 fixture 里不要写死端口，一律从 fixture 的返回值里取，别的测试也照这样做。';
  await h.sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","content","status","kind","send_intent","created_at")
     VALUES ($1,$2,1,$3,$4,'ANSWERED','message','NEXT_TURN',now())`,
    [randomUUID(), coordinator, randomUUID(), WORDS],
  );
  // The plan its owner confirmed: one document, an overview and the conventions taken from that project. The plan
  // stores the project by its id; the run reads the plan through `WikiPlans.version`, which names it { id, title }.
  const empty = { docs: [], code: [], contracts: [], sessions: null };
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: [{
          position: 0, category: 'dev', slug: 'testing', title: '测试约定', question: '测试的端口怎么取？',
          audience: ['新加入的开发者'], scopeIn: ['fixture 的端口'], lengthMin: 400, lengthMax: 4000,
          sections: {
            create: [
              { position: 0, key: 'overview', title: '总览', kind: 'overview', covers: '这篇讲测试的端口。', length: 300, sources: empty },
              {
                position: 1, key: 'ports', title: '端口', kind: 'conventions', covers: 'fixture 的端口从哪里来。', length: 400,
                sources: {
                  ...empty,
                  sessions: {
                    projects: [projectId], since: null, until: null, keywords: ['fixture'], anchorPaths: [],
                    entryKinds: [], topics: [], evidence: 'the owner on where a test takes its port',
                  },
                },
              },
            ],
          },
        }],
      },
    },
  });
  const view = await h.plans.version(h.ownerId, fx.spaceId, 1);
  assert.deepEqual(view.docs[0].sections[1].sources.sessions?.projects, [{ id: projectId, title: 'Fixture 端口' }], 'the read names the project { id, title }');

  const extract = extractor(fx, 2);
  h.model.answer = (hit) => (hit.prompt.includes('==== CASE FILE ====') ? extract(hit) : writerAnswer(hit.prompt));
  const page = pageOf(fx);
  h.maintenance.dossierPage = (async () => page) as unknown as WikiMaintenance['dossierPage'];
  const which = worker(h);
  await pass(h, which, async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state));

  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  const docs = (run.report as { docs: Record<string, unknown> }).docs;
  assert.equal(docs.error, undefined, `the documents step: ${String(docs.error)}`);
  assert.equal(docs.planVersion, 1);
  assert.deepEqual(docs.sections, { written: 2, unchanged: 0, failed: 0 });
  // The conventions cite the owner's words, which only the condition's project finds.
  const footnotes = await h.sql.query<{ kind: string; quote: string | null }>(
    `SELECT f."kind", f."quote" FROM "wiki_doc_footnote" f JOIN "wiki_doc_sentence" t ON t."id" = f."sentence_id"
       JOIN "wiki_doc_section" x ON x."id" = t."section_id" JOIN "wiki_doc" d ON d."id" = x."doc_id" WHERE d."space_id" = $1`, [fx.spaceId]);
  assert.ok(footnotes.rows.some((note) => note.kind === 'turn' && (note.quote ?? '').includes('fixture')), JSON.stringify(footnotes.rows));
});

// ── The documents step's comparison, read by commit (2026-10-10) ──────────────────────────────

/** A commit of the spec's own, named for what it stands for. */
function commitNamed(name: string): string {
  return createHash('sha1').update(`the commit the documents spec calls ${name}`).digest('hex');
}

const C1 = commitNamed('c1');
const C2 = commitNamed('c2');
const C3 = commitNamed('c3');
/** A commit the snapshot does not reach: its sections are taken as changed, with no diff and no read. */
const FAR = commitNamed('far');
/** A commit origin/main changed nothing since: its diff is empty. */
const STILL = commitNamed('still');
const BIG = commitNamed('big');
/** The commit wiki_maintain_docs_test.go's documents were written at (`f.first`). */
const FIRST = commitNamed('first');
/** A commit origin/main has since renamed a file at, changing it too, and deleted another. */
const RENAMED = commitNamed('renamed');
const COMMIT_NAMES = new Map([
  [C1, 'c1'], [C2, 'c2'], [C3, 'c3'], [FAR, 'far'], [STILL, 'still'], [BIG, 'big'], [FIRST, 'first'], [RENAMED, 'renamed'], [REPO.sha, 'head'],
]);

function commitName(sha: string): string {
  return COMMIT_NAMES.get(sha) ?? sha;
}

/** One section's design document: `Part`, which its section takes, and the rest, which it does not. */
function partDoc(key: string, part: 'written' | 'moved', rest: 'written' | 'moved'): string {
  return `# ${key}\n\n## Part\n\n`
    + (part === 'written' ? `The part of ${key} as it was written at its commit.` : `The part of ${key} as origin/main has it now.`)
    + '\n\n## Rest\n\n'
    + (rest === 'written' ? `The rest of ${key} before origin/main moved.` : `The rest of ${key} after origin/main moved.`)
    + '\n';
}

/** A plan section of a comparison case: the commit it was written at, and the files its sources name. */
interface ComparedSection {
  key: string;
  sha: string;
  docs?: string[];
  /** The section of its design documents it takes: `Part` unless named; null for the whole document. */
  heading?: string | null;
  code?: string[];
  /** A file its written sentence cites in a footnote: a withdrawal of that path takes the sentence back. */
  cites?: string;
}

/** A comparison case: the plan, origin/main and the commits behind it, and what each diff names. */
interface ComparisonCase {
  docs: Array<{ slug: string; sections: ComparedSection[] }>;
  /** The files at origin/main: the snapshot's. */
  head: Record<string, string>;
  /** Sizes the snapshot's index gives, where they are not the text's. */
  sizes?: Record<string, number>;
  /** The files at each commit a section was written at, as a read there answers. */
  at: Record<string, Record<string, string>>;
  /** The commits the snapshot reaches. */
  commits: string[];
  diffs: NonNullable<RunnerPlay['diffs']>;
}

/** What a comparison case's run left: the documents' report, the withdrawal it asked for, what it wrote again, and its operations. */
interface ComparisonSeen {
  outcome: string | null;
  docs: Record<string, unknown>;
  withdrawals: unknown[];
  rewritten: string[];
  ops: Array<{ kind: string; sha: string; from: string; to: string; paths: string[]; createdAt: Date; endedAt: Date | null }>;
}

/**
 * Run a comparison case through a whole maintenance run: the plan confirmed, every section written at its commit
 * through the documents' own writer, no dossiers, and the runner answering at each commit what the case holds there.
 */
async function runComparison(h: Harness, which: ComparisonCase): Promise<ComparisonSeen> {
  await clearWork(h);
  const fx = await fixture(h, { wholeFile: true, snapshot: { files: which.head, commits: which.commits, sizes: which.sizes } });
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: which.docs.map((doc, position) => ({
          position, category: 'dev', slug: doc.slug, title: doc.slug, question: `${doc.slug} 怎么工作？`,
          audience: ['新加入的开发者'], scopeIn: [doc.slug], lengthMin: 400, lengthMax: 4000,
          sections: {
            create: doc.sections.map((section, at) => ({
              position: at, key: section.key, title: section.key, kind: 'flow', covers: `${section.key} 讲什么。`, length: 400,
              sources: {
                docs: (section.docs ?? []).map((path) => ({ path, section: section.heading === undefined ? 'Part' : section.heading })),
                code: (section.code ?? []).map((path) => ({ path, symbols: [] })),
                contracts: [],
                sessions: null,
              },
            })),
          },
        })),
      },
    },
  });
  // Every section written at its own commit, through the writer a run writes with: one write a commit a document.
  const principal = wikiMaintainJobPrincipal(h.ownerId, fx.jobId);
  const writtenAt = new Map<string, string>();
  for (const doc of which.docs) {
    for (const sha of new Set(doc.sections.map((section) => section.sha))) {
      const sections = doc.sections.filter((section) => section.sha === sha);
      for (const section of sections) writtenAt.set(`${doc.slug}#${section.key}`, sha);
      await h.docs.write(principal, fx.spaceId, doc.slug, {
        planVersion: 1,
        repoSha: sha,
        model: MODEL,
        sections: sections.map((section) => ({
          key: section.key,
          materialSha256: '0'.repeat(64),
          markdown: section.cites ? `${section.key} 写在它的提交上，引用了一个文件[1]。` : `${section.key} 写在它的提交上。`,
          footnotes: section.cites
            ? [{ kind: 'design_doc', path: section.cites, sha, lines: { start: 3, end: 5 }, section: 'Part', quote: 'The part', verified: true }]
            : [],
        })),
      });
    }
  }
  // The paths the run withdraws, as it asks the documents' writer to.
  const withdrawals: unknown[] = [];
  const withdrawPaths = h.docs.withdrawPaths;
  h.docs.withdrawPaths = (async (who, spaceId, body) => {
    withdrawals.push(body);
    return withdrawPaths.call(h.docs, who, spaceId, body);
  }) as WikiDocs['withdrawPaths'];
  h.model.answer = (hit) => writerAnswer(hit.prompt);
  try {
    await pass(h, worker(h, { wake: true }), async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state), {
      filesAt: { ...which.at, [REPO.sha]: which.head },
      diffs: which.diffs,
    }, 2_000);
  } finally {
    h.docs.withdrawPaths = withdrawPaths;
  }
  const run = await runRow(h, fx.runId);
  const sections = await h.sql.query<{ slug: string; key: string; repo_sha: string }>(
    `SELECT d."slug", x."key", x."repo_sha" FROM "wiki_doc_section" x JOIN "wiki_doc" d ON d."id" = x."doc_id" WHERE d."space_id" = $1`,
    [fx.spaceId],
  );
  const ops = await h.sql.query<{ kind: string; input: Record<string, unknown>; created_at: Date; ended_at: Date | null }>(
    `SELECT "kind", "input", "created_at", "ended_at" FROM "wiki_repo_op" WHERE "job_id" = $1 ORDER BY "created_at", "id"`,
    [fx.jobId],
  );
  return {
    outcome: run.outcome,
    docs: (run.report as { docs?: Record<string, unknown> } | null)?.docs ?? {},
    withdrawals,
    // Written again: a section the run moved to the head, which it was not written at before.
    rewritten: sections.rows
      .filter((row) => row.repo_sha === REPO.sha && writtenAt.get(`${row.slug}#${row.key}`) !== REPO.sha)
      .map((row) => `${row.slug}#${row.key}`)
      .sort(),
    ops: ops.rows.map((op) => ({
      kind: op.kind,
      sha: String(op.input.sha ?? ''),
      from: String(op.input.from ?? ''),
      to: String(op.input.to ?? ''),
      paths: (Array.isArray(op.input.items) ? (op.input.items as Array<{ path?: unknown }>) : []).map((item) => String(item.path ?? '')),
      createdAt: op.created_at,
      endedAt: op.ended_at,
    })),
  };
}

/** Each commit's reads, by its name: the files each operation asked for, in order. */
function readsByCommit(seen: ComparisonSeen): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  for (const op of seen.ops) {
    if (op.kind !== 'read') continue;
    (out[commitName(op.sha)] ??= []).push([...op.paths].sort());
  }
  return out;
}

/** Every operation of the run asked only once the one before it had settled: none of them ran beside another. */
function assertOneAtATime(seen: ComparisonSeen): void {
  seen.ops.forEach((op, i) => {
    if (i === 0) return;
    const before = seen.ops[i - 1]!;
    assert.ok(
      before.endedAt !== null && op.createdAt.getTime() >= before.endedAt.getTime(),
      `operation ${i} (${op.kind}) was asked at ${op.createdAt.toISOString()}, before operation ${i - 1} (${before.kind}) settled at ${before.endedAt?.toISOString() ?? 'never'}`,
    );
  });
}

/**
 * The documents step's comparison as P10's rounds shape it, made small. Eleven written sections on three commits
 * have a file their commit's diff names: s1, s3, s4, s5, s9 and s11 with their part moved, so they are written
 * again, and the rest moved outside it. s12 has no file the diff names. Around them: u1 and u2 on a commit the
 * snapshot does not reach (taken as changed, with no diff and no read), e1 on a commit whose diff is empty, h1 at
 * the head and n1 citing no file. origin/main deleted docs/c1/gone.md, which s4 cites and a sentence of s2 cites
 * in a footnote, and renamed src/c2/old.go to src/c2/new.go under src/c2/, which s8 cites.
 */
const COMPARISON: ComparisonCase = {
  docs: [
    {
      slug: 'alpha',
      sections: [
        { key: 's1', sha: C1, docs: ['docs/c1/s1.md'] },
        { key: 's5', sha: C2, docs: ['docs/c2/s5.md'] },
        { key: 's9', sha: C3, docs: ['docs/c3/s9.md'] },
        { key: 'u1', sha: FAR, docs: ['docs/c1/s1.md'] },
        { key: 'e1', sha: STILL, docs: ['docs/still/e1.md'] },
      ],
    },
    {
      slug: 'beta',
      sections: [
        { key: 's2', sha: C1, docs: ['docs/c1/s2.md'], cites: 'docs/c1/gone.md' },
        { key: 's6', sha: C2, docs: ['docs/c2/s6.md'] },
        { key: 's10', sha: C3, docs: ['docs/c3/s10.md'] },
        { key: 'h1', sha: REPO.sha, docs: ['docs/head/h1.md'] },
        { key: 'n1', sha: C1 },
      ],
    },
    {
      slug: 'gamma',
      sections: [
        { key: 's3', sha: C1, docs: ['docs/c1/s3.md'] },
        { key: 's4', sha: C1, docs: ['docs/c1/s4.md', 'docs/c1/gone.md'] },
        { key: 's7', sha: C2, docs: ['docs/c2/s7.md'] },
        { key: 's8', sha: C2, docs: ['docs/c2/s8.md'], code: ['src/c2/'] },
        { key: 's11', sha: C3, docs: ['docs/c3/s11.md'] },
        { key: 's12', sha: C3, docs: ['docs/c3/s12.md'] },
        { key: 'u2', sha: FAR, docs: ['docs/c3/s9.md'] },
      ],
    },
  ],
  head: {
    'docs/c1/s1.md': partDoc('s1', 'moved', 'written'),
    'docs/c1/s2.md': partDoc('s2', 'written', 'moved'),
    'docs/c1/s3.md': partDoc('s3', 'moved', 'written'),
    'docs/c1/s4.md': partDoc('s4', 'moved', 'written'),
    'docs/c2/s5.md': partDoc('s5', 'moved', 'written'),
    'docs/c2/s6.md': partDoc('s6', 'written', 'moved'),
    'docs/c2/s7.md': partDoc('s7', 'written', 'moved'),
    'docs/c2/s8.md': partDoc('s8', 'written', 'moved'),
    'docs/c3/s9.md': partDoc('s9', 'moved', 'written'),
    'docs/c3/s10.md': partDoc('s10', 'written', 'moved'),
    'docs/c3/s11.md': partDoc('s11', 'moved', 'written'),
    'docs/c3/s12.md': partDoc('s12', 'written', 'written'),
    'docs/still/e1.md': partDoc('e1', 'written', 'written'),
    'docs/head/h1.md': partDoc('h1', 'written', 'written'),
    'src/c2/new.go': 'package c2\n',
    'src/unrelated.go': 'package unrelated\n',
  },
  at: {
    [C1]: {
      'docs/c1/s1.md': partDoc('s1', 'written', 'written'),
      'docs/c1/s2.md': partDoc('s2', 'written', 'written'),
      'docs/c1/s3.md': partDoc('s3', 'written', 'written'),
      'docs/c1/s4.md': partDoc('s4', 'written', 'written'),
      'docs/c1/gone.md': partDoc('gone', 'written', 'written'),
    },
    [C2]: {
      'docs/c2/s5.md': partDoc('s5', 'written', 'written'),
      'docs/c2/s6.md': partDoc('s6', 'written', 'written'),
      'docs/c2/s7.md': partDoc('s7', 'written', 'written'),
      'docs/c2/s8.md': partDoc('s8', 'written', 'written'),
      'src/c2/old.go': 'package c2\n',
    },
    [C3]: {
      'docs/c3/s9.md': partDoc('s9', 'written', 'written'),
      'docs/c3/s10.md': partDoc('s10', 'written', 'written'),
      'docs/c3/s11.md': partDoc('s11', 'written', 'written'),
      'docs/c3/s12.md': partDoc('s12', 'written', 'written'),
    },
  },
  commits: [C1, C2, C3, STILL, REPO.sha],
  diffs: {
    [C1]: {
      files: [
        { status: 'M', path: 'docs/c1/s1.md' },
        { status: 'M', path: 'docs/c1/s2.md' },
        { status: 'M', path: 'docs/c1/s3.md' },
        { status: 'M', path: 'docs/c1/s4.md' },
        { status: 'D', path: 'docs/c1/gone.md' },
        { status: 'M', path: 'src/unrelated.go' },
      ],
      docs: [],
    },
    [C2]: {
      files: [
        { status: 'M', path: 'docs/c2/s5.md' },
        { status: 'M', path: 'docs/c2/s6.md' },
        { status: 'M', path: 'docs/c2/s7.md' },
        { status: 'M', path: 'docs/c2/s8.md' },
        // The runner's diff operation names a rename's old path `from` and its new one `path`.
        { status: 'R100', from: 'src/c2/old.go', path: 'src/c2/new.go' },
      ],
      docs: [],
    },
    [C3]: {
      files: [
        { status: 'M', path: 'docs/c3/s9.md' },
        { status: 'M', path: 'docs/c3/s10.md' },
        { status: 'M', path: 'docs/c3/s11.md' },
      ],
      docs: [],
    },
    [STILL]: { files: [], docs: [] },
  },
};

/** The comparison case's one run, which the two cases below read: what it wrote, and how it read. */
let comparisonSeen: Promise<ComparisonSeen> | undefined;

test('the documents step writes again the same sections and withdraws the same paths when it reads by commit, one diff a commit', { skip }, async (t) => {
  const h = await boot();
  comparisonSeen ??= runComparison(h, COMPARISON);
  const seen = await comparisonSeen;
  t.diagnostic(`written again: ${seen.rewritten.join(', ')}`);
  t.diagnostic(`withdrawn: ${JSON.stringify(seen.withdrawals)}`);
  t.diagnostic(`docs report: ${JSON.stringify({ affected: seen.docs.affected, withdrawn: seen.docs.withdrawn, sections: seen.docs.sections, error: seen.docs.error ?? null })}`);
  assert.equal(seen.outcome, 'succeeded');
  assert.equal(seen.docs.error, undefined, `the documents step: ${String(seen.docs.error)}`);
  // The sections whose part moved, and the two on a commit the snapshot does not reach, are changed by the
  // repository; s2 is stale once the sentence citing the deleted file is withdrawn. Nothing else is written again.
  assert.deepEqual(
    seen.rewritten,
    ['alpha#s1', 'alpha#s5', 'alpha#s9', 'alpha#u1', 'beta#s2', 'gamma#s11', 'gamma#s3', 'gamma#s4', 'gamma#u2'],
  );
  assert.deepEqual(seen.docs.affected, { byEntries: 0, byRepo: 8, stale: 1, unwritten: 0, total: 9 });
  assert.deepEqual(seen.docs.sections, { written: 9, unchanged: 0, failed: 0 });
  assert.deepEqual(seen.docs.withdrawn, { paths: 2, sentences: 1 });
  assert.deepEqual(seen.withdrawals, [{
    repoSha: REPO.sha,
    paths: [
      { path: 'docs/c1/gone.md', change: 'deleted' },
      // A rename by its old path, where the file went as `to` — the runner's `wikiGitChanges` (2026-10-10). Until then the
      // server withdrew the diff's `path`, where the file went, `to` where it came from.
      { path: 'src/c2/old.go', change: 'renamed', to: 'src/c2/new.go' },
    ],
  }]);
  // One diff a commit the snapshot reaches, in the order of their shas; none at the head and none for the commit the
  // snapshot does not reach.
  assert.deepEqual(
    seen.ops.filter((op) => op.kind === 'diff').map((op) => `${commitName(op.from)}..${commitName(op.to)}`),
    [C1, C2, C3, STILL].sort().map((sha) => `${commitName(sha)}..head`),
  );
});

test('the documents step reads the files it compares with one read a commit and one at the head, not one a section at each end', { skip }, async (t) => {
  const h = await boot();
  comparisonSeen ??= runComparison(h, COMPARISON);
  const seen = await comparisonSeen;
  const reads = readsByCommit(seen);
  t.diagnostic(`read operations: ${seen.ops.filter((op) => op.kind === 'read').length} — `
    + Object.entries(reads).map(([commit, packs]) => `${commit} ${packs.length} (${packs.map((pack) => pack.length).join('+')} files)`).join(', '));
  t.diagnostic(`every operation, in order: ${seen.ops.map((op) => (op.kind === 'diff' ? `diff ${commitName(op.from)}` : op.kind === 'read' ? `read ${commitName(op.sha)}×${op.paths.length}` : op.kind)).join(', ')}`);
  // Eleven sections on three commits: each commit's files in one read there, every file at the head in one read
  // there. s12's file is not in its commit's diff, and the directory has nothing to read. The deleted file is read at
  // c1, where it still is, as the runner reads it there; the head does not have it.
  assert.deepEqual(reads, {
    c1: [['docs/c1/gone.md', 'docs/c1/s1.md', 'docs/c1/s2.md', 'docs/c1/s3.md', 'docs/c1/s4.md']],
    c2: [['docs/c2/s5.md', 'docs/c2/s6.md', 'docs/c2/s7.md', 'docs/c2/s8.md']],
    c3: [['docs/c3/s10.md', 'docs/c3/s11.md', 'docs/c3/s9.md']],
    head: [[
      'docs/c1/s1.md', 'docs/c1/s2.md', 'docs/c1/s3.md', 'docs/c1/s4.md',
      'docs/c2/s5.md', 'docs/c2/s6.md', 'docs/c2/s7.md', 'docs/c2/s8.md',
      'docs/c3/s10.md', 'docs/c3/s11.md', 'docs/c3/s9.md',
    ]],
  });
  assertOneAtATime(seen);
});

test('a commit whose files pass operationBytes is read in the fewest operations the limit allows, at the commit and at the head', { skip }, async (t) => {
  const h = await boot();
  const keys = ['p1', 'p2', 'p3', 'p4', 'p5'];
  // Two of these fit in one operation and three do not; the snapshot's sizes are what a read is packed by.
  const size = Math.floor((WIKI_REPO_OPS.operationBytes * 3) / 8);
  assert.ok(size <= WIKI_REPO_OPS.wholeFileBytes && 2 * size <= WIKI_REPO_OPS.operationBytes && 3 * size > WIKI_REPO_OPS.operationBytes);
  const path = (key: string): string => `docs/big/${key}.md`;
  const seen = await runComparison(h, {
    docs: [{ slug: 'delta', sections: keys.map((key) => ({ key, sha: BIG, docs: [path(key)] })) }],
    head: Object.fromEntries(keys.map((key) => [path(key), partDoc(key, 'written', 'moved')])),
    sizes: Object.fromEntries(keys.map((key) => [path(key), size])),
    at: { [BIG]: Object.fromEntries(keys.map((key) => [path(key), partDoc(key, 'written', 'written')])) },
    commits: [BIG, REPO.sha],
    diffs: { [BIG]: { files: keys.map((key) => ({ status: 'M', path: path(key) })), docs: [] } },
  });
  const reads = readsByCommit(seen);
  t.diagnostic(`read operations: ${Object.entries(reads).map(([commit, packs]) => `${commit} ${packs.length} (${packs.map((pack) => pack.length).join('+')} files)`).join(', ')}`);
  assert.equal(seen.outcome, 'succeeded');
  assert.deepEqual(seen.docs.affected, { byEntries: 0, byRepo: 0, stale: 0, unwritten: 0, total: 0 }, 'only the rest of each file moved');
  assert.deepEqual(reads, {
    big: [[path('p1'), path('p2')], [path('p3'), path('p4')], [path('p5')]],
    head: [[path('p1'), path('p2')], [path('p3'), path('p4')], [path('p5')]],
  });
  assertOneAtATime(seen);
});

// ── A rename and a deletion, as the runner's comparison takes them (2026-10-10) ───────────────

/** What a comparison case's run left, as its diagnostics say it: what it wrote again, withdrew and read. */
function diagnoseComparison(t: { diagnostic: (message: string) => void }, seen: ComparisonSeen): void {
  t.diagnostic(`written again: ${seen.rewritten.join(', ')}`);
  t.diagnostic(`withdrawn: ${JSON.stringify(seen.withdrawals)}`);
  t.diagnostic(`docs report: ${JSON.stringify({ affected: seen.docs.affected, withdrawn: seen.docs.withdrawn, sections: seen.docs.sections, error: seen.docs.error ?? null })}`);
  t.diagnostic(`reads: ${JSON.stringify(readsByCommit(seen))}`);
}

const RUNNER_DESIGN_BEFORE = '# Runner 设计\n\n## 1. 传输\n\nrunner 通过出站 HTTP 轮询服务器，不需要入站端口。\n\n## 2. 投递\n\n一轮 turn 先落库再投递，至少投递一次。\n';
const RUNNER_DESIGN_AFTER = '# Runner 设计\n\n## 1. 传输\n\nrunner 通过出站 HTTP 轮询服务器，不需要入站端口。\n\n## 2. 投递\n\n一轮 turn 先落库再投递，至少投递一次，按 turn id 幂等。\n';
const RUNNER_DISPATCH = '# 派发\n\n## 概要\n\n讲派发怎么把会话交给 runner。\n';

/**
 * The repository's half of wiki_maintain_docs_test.go's TestWikiMaintainWritesOnlyTheSectionsItsEntriesAndOriginMainTouched,
 * its files and sections as they are there: the documents were written at the first commit, and origin/main has since
 * changed the design document's section 2 (section 1 is as it was), deleted docs/old.md and renamed docs/moved.md to
 * docs/dispatch.md, unchanged — the names its diff gives, in git's order. s3 cites only the deleted file and s4 only the
 * renamed one's old path, each with a sentence that cites it in a footnote. The Go test's s5 is its entries' to write,
 * not the repository's, and has no place here.
 */
test('a section citing only a renamed file\'s old path, and one citing a deleted file, are the repository\'s, and the rename is withdrawn by its old path, as the runner has them', { skip }, async (t) => {
  const h = await boot();
  const seen = await runComparison(h, {
    docs: [{
      slug: 'runner',
      sections: [
        { key: 's1', sha: FIRST, docs: ['docs/design.md'], heading: '1. 传输' },
        { key: 's2', sha: FIRST, docs: ['docs/design.md'], heading: '2. 投递' },
        { key: 's3', sha: FIRST, docs: ['docs/old.md'], heading: null, cites: 'docs/old.md' },
        { key: 's4', sha: FIRST, docs: ['docs/moved.md'], heading: null, cites: 'docs/moved.md' },
      ],
    }],
    head: { 'docs/design.md': RUNNER_DESIGN_AFTER, 'docs/dispatch.md': RUNNER_DISPATCH },
    at: {
      [FIRST]: {
        'docs/design.md': RUNNER_DESIGN_BEFORE,
        'docs/old.md': '# 旧设计\n\n## 概要\n\n这份文档讲旧的领取方式。\n',
        'docs/moved.md': RUNNER_DISPATCH,
      },
    },
    commits: [FIRST, REPO.sha],
    diffs: {
      [FIRST]: {
        files: [
          { status: 'M', path: 'docs/design.md' },
          { status: 'R100', from: 'docs/moved.md', path: 'docs/dispatch.md' },
          { status: 'D', path: 'docs/old.md' },
        ],
        docs: ['docs/dispatch.md'],
      },
    },
  });
  diagnoseComparison(t, seen);
  assert.equal(seen.outcome, 'succeeded');
  assert.equal(seen.docs.error, undefined, `the documents step: ${String(seen.docs.error)}`);
  // The Go test's: s2, s3 and s4 by the repository (it writes s5 too, by its entries) — not s1, whose section did not
  // change. s3 and s4 are the repository's, not stale: their file was at their commit and is not at the head.
  assert.deepEqual(seen.rewritten, ['runner#s2', 'runner#s3', 'runner#s4']);
  assert.deepEqual(seen.docs.affected, { byEntries: 0, byRepo: 3, stale: 0, unwritten: 0, total: 3 });
  // Withdrawn once, at the head, deleted and renamed as git says: the Go test's
  // [{"change":"renamed","path":"docs/moved.md","to":"docs/dispatch.md"},{"change":"deleted","path":"docs/old.md"}].
  assert.deepEqual(seen.withdrawals, [{
    repoSha: REPO.sha,
    paths: [
      { path: 'docs/moved.md', change: 'renamed', to: 'docs/dispatch.md' },
      { path: 'docs/old.md', change: 'deleted' },
    ],
  }]);
  assert.deepEqual(seen.docs.withdrawn, { paths: 2, sentences: 2 });
  // The deleted file and the renamed one's old path are read at the first commit, where they still are, in its one
  // read; the head has neither, and its one read is the design document.
  assert.deepEqual(readsByCommit(seen), {
    first: [['docs/design.md', 'docs/moved.md', 'docs/old.md']],
    head: [['docs/design.md']],
  });
  assertOneAtATime(seen);
});

test('a rename that changed the file as well, and a deleted file no sentence cites: either end\'s section and the deleted file\'s are the repository\'s, and only the old path is withdrawn', { skip }, async (t) => {
  const h = await boot();
  const seen = await runComparison(h, {
    docs: [{
      slug: 'epsilon',
      sections: [
        { key: 'm1', sha: RENAMED, code: ['src/m/old.go'] },
        { key: 'm2', sha: RENAMED, code: ['src/m/new.go'] },
        { key: 'd1', sha: RENAMED, docs: ['docs/d/gone.md'] },
      ],
    }],
    head: {
      'src/m/new.go': 'package m\n\n// Serve answers the port the runner polls, and its health check.\nfunc Serve() {}\n\n'
        + '// Port is the port Serve answers.\nfunc Port() int { return 9000 }\n\n// Close stops answering.\nfunc Close() {}\n',
    },
    at: {
      [RENAMED]: {
        'src/m/old.go': 'package m\n\n// Serve answers the port the runner polls.\nfunc Serve() {}\n\n'
          + '// Port is the port Serve answers.\nfunc Port() int { return 9000 }\n\n// Close stops answering.\nfunc Close() {}\n',
        'docs/d/gone.md': partDoc('d1', 'written', 'written'),
      },
    },
    commits: [RENAMED, REPO.sha],
    diffs: {
      [RENAMED]: {
        files: [
          { status: 'D', path: 'docs/d/gone.md' },
          // Changed as it moved: git still pairs the two ends, 67% alike (`git diff --name-status -M` on these two texts).
          { status: 'R067', from: 'src/m/old.go', path: 'src/m/new.go' },
        ],
        docs: [],
      },
    },
  });
  diagnoseComparison(t, seen);
  assert.equal(seen.outcome, 'succeeded');
  assert.equal(seen.docs.error, undefined, `the documents step: ${String(seen.docs.error)}`);
  // m1's file was at its commit, under its old path, and is not at the head under it; m2's was not at its commit and is
  // at the head; d1's was at its commit and is gone. No sentence cites any of them, so none is stale.
  assert.deepEqual(seen.rewritten, ['epsilon#d1', 'epsilon#m1', 'epsilon#m2']);
  assert.deepEqual(seen.docs.affected, { byEntries: 0, byRepo: 3, stale: 0, unwritten: 0, total: 3 });
  assert.deepEqual(seen.withdrawals, [{
    repoSha: REPO.sha,
    paths: [
      { path: 'docs/d/gone.md', change: 'deleted' },
      { path: 'src/m/old.go', change: 'renamed', to: 'src/m/new.go' },
    ],
  }]);
  assert.deepEqual(seen.docs.withdrawn, { paths: 2, sentences: 0 });
  // At the commit, the deleted file and the old path, as they were there; at the head, the new path.
  assert.deepEqual(readsByCommit(seen), {
    renamed: [['docs/d/gone.md', 'src/m/old.go']],
    head: [['src/m/new.go']],
  });
  assertOneAtATime(seen);
});

// ── The plan proposal (2026-10-09, run 28ea4f5c) ──────────────────────────────────────────────

/**
 * What the runner's check of a proposal and the server's are both held to (wiki_maintain_proposal_fixture_test.go,
 * wiki-maintain-proposal-golden.spec.ts). Its first case is production's: docs/wiki-comment-to-session-design.md
 * as origin/main held it at fadc587b0, and an answer naming two of its sections as the proposal prompt lists them.
 */
const PROPOSAL_FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../shared/src/wiki-maintain-proposal.fixture.json'), 'utf8')) as {
  files: Record<string, string>;
  cases: Array<{ name: string; answer: string }>;
};

test('a proposal naming a new design document\'s sections as its prompt lists them, `##` and all, is checked in the document as the runner checks it, and stored', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const DOC = 'docs/wiki-comment-to-session-design.md';
  const text = PROPOSAL_FIXTURE.files[DOC];
  const production = PROPOSAL_FIXTURE.cases[0];
  assert.match(production.name, /^production/u);
  // The commit the plan's references were checked at: origin/main reaches it, and the document landed after it.
  const base = createHash('sha1').update('the commit the plan was checked at').digest('hex');
  const fx = await fixture(h, { snapshot: { files: { [DOC]: text }, commits: [base, REPO.sha] } });
  // No dossiers: the run goes through to the documents step, where the proposal is.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  const empty = { docs: [], code: [], contracts: [], sessions: null };
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      repoSha: base, repoCheck: { sha: base, checked: 0, missing: [] },
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: [{
          position: 0, category: 'dev', slug: 'wiki-pipeline', title: 'Wiki 流水线', question: 'wiki 怎么维护？',
          audience: ['新加入的开发者'], scopeIn: ['维护'], lengthMin: 400, lengthMax: 4000,
          sections: {
            create: [
              { position: 0, key: 'overview', title: '总览', kind: 'overview', covers: '这篇讲 wiki 怎么维护。', length: 300, sources: empty },
              { position: 1, key: 'main', title: '入口', kind: 'flow', covers: 'main 做什么。', length: 400, sources: { ...empty, code: [{ path: 'src/app.go', symbols: ['main'] }] } },
            ],
          },
        }],
      },
    },
  });
  const prompts: string[] = [];
  h.model.answer = (hit) => {
    if (!hit.prompt.includes("# Task: the maintenance run's proposed change to the plan")) return writerAnswer(hit.prompt);
    prompts.push(hit.prompt);
    return production.answer;
  };
  const which = worker(h);
  await pass(h, which, async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state), {
    files: { [DOC]: text },
    diff: { files: [{ status: 'A', path: DOC }], docs: [DOC] },
  });

  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  const docs = (run.report as { docs: { unplaced: unknown; proposal: Record<string, unknown> | null } }).docs;
  assert.deepEqual(docs.unplaced, { designDocs: 1, entries: 0 }, 'the document is new on origin/main, and no section cites it');
  // The model was shown the document's sections with their `##`, and named two of them that way.
  assert.match(prompts[0] ?? '', /Sections: [^\n]*## 4\. wiki 怎么跟上; [^\n]*## 12\. 现在的缺口一起补（owner 10-09）; /u);
  assert.deepEqual(
    { outcome: docs.proposal?.outcome, rounds: docs.proposal?.rounds, error: docs.proposal?.error ?? null },
    { outcome: 'proposed', rounds: 1, error: null },
    'the proposal passes the check in its first round, as it does on the runner',
  );
  const stored = await h.prisma.wikiPlanProposal.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId } });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authorJobId, fx.jobId);
  const sections = (stored[0].change as { doc: { sections: Array<{ sources: { docs: unknown } }> } }).doc.sections;
  assert.deepEqual(sections.slice(-2).map((section) => section.sources.docs), [
    [{ path: DOC, section: '## 4. wiki 怎么跟上' }],
    [{ path: DOC, section: '## 12. 现在的缺口一起补（owner 10-09）' }],
  ], 'the two new sections cite the document\'s sections as the model named them');
});

test('a proposal naming a document\'s slug as its topic is refused by the run\'s own check with the space\'s topics listed, and the next round names one of them', { skip }, async () => {
  // Canary, 2026-10-10 (3b2bd5f2): the run's check let «wiki-maintenance», a document's slug, through as a section's
  // topic, and the gate refused it in the last round with no topic to name instead; on 10-09 (54755b7b) two rounds
  // running named the same made-up topics. The model here names a topic only from a list it was given, as a retry can.
  const h = await boot();
  await clearWork(h);
  const DOC = 'docs/wiki-comment-to-session-design.md';
  const text = PROPOSAL_FIXTURE.files[DOC];
  const base = createHash('sha1').update('the commit the plan was checked at').digest('hex');
  const fx = await fixture(h, { snapshot: { files: { [DOC]: text }, commits: [base, REPO.sha] } });
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  await h.prisma.wikiTopic.createMany({
    data: [
      { ownerId: h.ownerId, spaceId: fx.spaceId, slug: 'wiki', title: 'Wiki', createdAt: new Date('2026-09-01T00:00:00Z') },
      { ownerId: h.ownerId, spaceId: fx.spaceId, slug: 'sessions', title: '会话', createdAt: new Date('2026-09-02T00:00:00Z') },
    ],
  });
  const empty = { docs: [], code: [], contracts: [], sessions: null };
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      repoSha: base, repoCheck: { sha: base, checked: 0, missing: [] },
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: [{
          position: 0, category: 'dev', slug: 'wiki-pipeline', title: 'Wiki 流水线', question: 'wiki 怎么维护？',
          audience: ['新加入的开发者'], scopeIn: ['维护'], lengthMin: 400, lengthMax: 4000,
          sections: { create: [{ position: 0, key: 'overview', title: '总览', kind: 'overview', covers: '这篇讲 wiki 怎么维护。', length: 300, sources: empty }] },
        }],
      },
    },
  });
  const answerNaming = (topic: string): string => 'Into: wiki-pipeline\nReason: the pitfalls hit when a comment starts a change have no section in the plan.\nUses: K1\n'
    + '### 1. Pitfalls of a change a comment starts | pitfalls | 300\nCovers: the pitfalls hit when a comment starts a change.\n'
    + `- Sessions: keywords comment, change; kind pitfall; topics ${topic}; look for: the owner's words saying what went wrong when a comment started a change\n`;
  const prompts: string[] = [];
  h.model.answer = (hit) => {
    if (!hit.prompt.includes("# Task: the maintenance run's proposed change to the plan")) return writerAnswer(hit.prompt);
    prompts.push(hit.prompt);
    const listed = /Existing topics \(slug «name» · active entries\): ([a-z0-9-]+) «/u.exec(hit.prompt);
    return answerNaming(listed?.[1] ?? 'wiki-pipeline');
  };
  const which = worker(h);
  await pass(h, which, async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state), {
    files: { [DOC]: text },
    diff: { files: [{ status: 'A', path: DOC }], docs: [DOC] },
  });

  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  const docs = (run.report as { docs: { proposal: Record<string, unknown> | null } }).docs;
  assert.deepEqual(
    { outcome: docs.proposal?.outcome, rounds: docs.proposal?.rounds, error: docs.proposal?.error ?? null },
    { outcome: 'proposed', rounds: 2, error: null },
    'the second round names a topic of the space, and the proposal is stored',
  );
  assert.equal(prompts.length, 2);
  // Round 1 was refused here, before the gate saw it: by its section, with the space's topics as the gate lists them.
  assert.ok(
    prompts[1].includes('\n- section 1: "wiki-pipeline" is not a topic of this space: Existing topics (slug «name» · active entries): wiki «Wiki» · 0; sessions «会话» · 0\n'),
    `round 2 was told: ${prompts[1].slice(prompts[1].indexOf('## The last answer had these problems'))}`,
  );
  assert.ok(!prompts[1].includes('change.doc.'), 'the gate refused nothing: the run\'s own check found it first');
  const stored = await h.prisma.wikiPlanProposal.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId } });
  assert.equal(stored.length, 1);
  const sections = (stored[0].change as { doc: { sections: Array<{ sources: { sessions: { topics: string[] } | null } }> } }).doc.sections;
  assert.deepEqual(sections[sections.length - 1].sources.sessions?.topics, ['wiki']);
});

// ── The anchors of a page: every entry keeps its own checks ─────────────────────────────────────

/**
 * The fake repository the anchor step is checked against: one file, one reachable commit, and a
 * region hash derived from the symbol's name — different symbols hash differently, which is what
 * tells one entry's symbol check from another's.
 */
const ANCHOR_REPO = {
  file: 'src/app.go',
  commit: createHash('sha1').update('the commit the spec keeps').digest('hex'),
  regionOf: (symbol: string): string => createHash('sha256').update(`region of ${symbol}`).digest('hex'),
};

/** What the runner answers for one anchor of the anchors op, checking it against ANCHOR_REPO. */
function checkAnchorAgainstRepo(anchor: Record<string, unknown>): Record<string, unknown> {
  if (anchor.type === 'path') {
    return { ...anchor, state: anchor.path === ANCHOR_REPO.file ? 'verified' : 'missing' };
  }
  if (anchor.type === 'commit') {
    return { ...anchor, state: anchor.sha === ANCHOR_REPO.commit ? 'verified' : 'missing' };
  }
  return { ...anchor, state: 'verified', regionSha256: ANCHOR_REPO.regionOf(String(anchor.symbol ?? '')) };
}

test('the anchors step records each entry\'s checks on its own anchors — a page of entries is never one entry', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // No dossiers: the run proposes nothing, and the anchors step is what this case is about.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // Two live entries whose anchors collide on the per-entry index: each has a path, a symbol and a
  // commit at indexes 0, 1 and 2. The first entry's symbol names no baseline: its first check adopts
  // the region the check found, so a verdict laid on the wrong entry's symbol would stick as a
  // wrong baseline.
  const serveBaseline = createHash('sha256').update('the baseline the serve anchor names').digest('hex');
  const goneCommit = createHash('sha1').update('a commit the repository never held').digest('hex');
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  await h.prisma.wikiEntry.create({
    data: {
      id: first, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the kept entry', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [
        { type: 'path', path: ANCHOR_REPO.file },
        { type: 'symbol', path: ANCHOR_REPO.file, symbol: 'main' },
        { type: 'commit', sha: ANCHOR_REPO.commit },
      ],
    },
  });
  await h.prisma.wikiEntry.create({
    data: {
      id: second, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the broken entry', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [
        { type: 'path', path: 'src/gone.go' },
        { type: 'symbol', path: ANCHOR_REPO.file, symbol: 'serve', regionSha256: serveBaseline },
        { type: 'commit', sha: goneCommit },
      ],
    },
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded' || (await jobOf(h, fx.jobId)).state === 'failed',
    { checkAnchor: checkAnchorAgainstRepo });

  // The job succeeds: every reported check names the anchor it belongs to, so nothing is refused.
  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', `the anchors step must not fail: ${job.error ?? ''}`);

  const kept = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: first } });
  const keptAnchors = kept.anchors as Array<Record<string, unknown> & { check?: Record<string, unknown> }>;
  assert.equal(keptAnchors[0]!.check?.state, 'verified', 'the kept entry\'s path holds');
  assert.equal(keptAnchors[1]!.check?.state, 'verified', 'the kept entry\'s symbol is found');
  assert.equal(keptAnchors[1]!.check?.regionSha256, ANCHOR_REPO.regionOf('main'), 'the kept entry\'s symbol check is its own');
  assert.equal(keptAnchors[1]!.check?.baselineSha256, ANCHOR_REPO.regionOf('main'), 'the baseline the first check adopts is its own region');
  assert.equal(keptAnchors[2]!.check?.state, 'verified', 'the kept entry\'s commit is reachable');
  assert.equal(kept.anchorState, 'verified');
  assert.equal(kept.challenged, false, 'a fully verified entry draws no challenge');

  const broken = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: second } });
  const brokenAnchors = broken.anchors as Array<Record<string, unknown> & { check?: Record<string, unknown> }>;
  assert.equal(brokenAnchors[0]!.check?.state, 'missing', 'the gone path is missing');
  assert.equal(brokenAnchors[1]!.check?.state, 'changed', 'the serve symbol\'s region moved against its own baseline');
  assert.equal(brokenAnchors[1]!.check?.regionSha256, ANCHOR_REPO.regionOf('serve'), 'the changed check carries the region its own symbol holds now');
  assert.equal(brokenAnchors[1]!.check?.baselineSha256, undefined, 'an anchor that names its own baseline is held to it there: the check does not copy it');
  assert.equal(brokenAnchors[1]!.regionSha256, serveBaseline, 'and the baseline the anchor named is untouched by the check');
  assert.equal(brokenAnchors[2]!.check?.state, 'missing', 'the unheld commit is missing');
  assert.equal(broken.anchorState, 'missing');
  assert.equal(broken.challenged, true, 'the broken entry is challenged for the owner');

  const report = (await runRow(h, fx.runId)).report as Record<string, unknown>;
  const anchors = report.anchors as Record<string, number>;
  assert.deepEqual(anchors, { entries: 2, changed: 0, missing: 1, skipped: 0 }, 'one entry verified, the broken one out as missing');
});

/** The `anchors` operations of a run, in the order they were enqueued: how many anchors each carried, how many bytes, and when it ran. */
async function anchorsOps(h: Harness): Promise<Array<{ anchors: number; bytes: number; createdAt: string; endedAt: string }>> {
  return h.sql.query<{ anchors: number; bytes: number; createdAt: string; endedAt: string }>(
    `SELECT jsonb_array_length("input"->'anchors') AS "anchors",
            octet_length("input"::text) AS "bytes",
            "created_at" AS "createdAt", "ended_at" AS "endedAt"
       FROM "wiki_repo_op" WHERE "owner_id" = $1 AND "kind" = 'anchors' AND "state" = 'succeeded'
      ORDER BY "created_at", "id"`, [h.ownerId],
  ).then((result) => result.rows.map((row) => ({ anchors: Number(row.anchors), bytes: Number(row.bytes), createdAt: row.createdAt, endedAt: row.endedAt })));
}

test('the anchors step puts listEntriesMax entries in one repository operation: 400 entries are two operations, not eight', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // No dossiers: the run proposes nothing, and the anchors step is what this case is about.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // 400 live entries, one path anchor each: a page of the list's default size (50) sent these out as
  // eight repository operations, each one a wait for the runner's next heartbeat.
  const count = 400;
  await h.prisma.wikiEntry.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: `anchored ${i}`, summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [{ type: 'path', path: ANCHOR_REPO.file }],
    })),
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', `the anchors step must not fail: ${job.error ?? ''}`);
  const ops = await anchorsOps(h);
  assert.equal(ops.length, Math.ceil(count / WIKI_ANCHOR_RULES.listEntriesMax), 'the page is the batch: 400 entries fill two operations');
  assert.deepEqual(ops.map((op) => op.anchors), [WIKI_ANCHOR_RULES.listEntriesMax, count - WIKI_ANCHOR_RULES.listEntriesMax], 'each operation carries one anchor an entry, in page order');
  for (const op of ops) {
    // What one operation may carry: a page's entries at `listMaxItems` anchors each, and a payload well
    // inside what a read is packed to (`operationBytes`). A page of path anchors is a few hundred
    // milliseconds of git on the runner, far inside the 300 s the run waits for it.
    assert.ok(op.anchors <= WIKI_ANCHOR_RULES.listEntriesMax * WIKI_LIMITS.listMaxItems, `an operation carries at most a page's anchors: ${op.anchors}`);
    assert.ok(op.bytes < WIKI_REPO_OPS.operationBytes, `an operation's payload stays inside operationBytes: ${op.bytes} bytes`);
  }
  // One at a time: the second operation was enqueued only after the first had settled (the runner's
  // concurrent fetches of one checkout take no lock of their own until 97b8de07f ships).
  assert.ok(Date.parse(ops[1]!.createdAt) >= Date.parse(ops[0]!.endedAt), `no second operation while one is in flight: ${ops.map((op) => `${op.createdAt}->${op.endedAt}`).join(', ')}`);
  // Every one of the 400 entries was checked through those two operations.
  const verified = await h.prisma.wikiEntry.count({ where: { ownerId: h.ownerId, spaceId: fx.spaceId, anchorState: 'verified' } });
  assert.equal(verified, count, 'no entry is left out by the page boundary');
  const report = (await runRow(h, fx.runId)).report as Record<string, unknown>;
  assert.deepEqual(report.anchors, { entries: count, changed: 0, missing: 0, skipped: 0 }, 'the report counts every entry once');
});

test('every entry of a page keeps its own check across the page and the report boundaries, and the page\'s tail is written', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // 201 entries: the page boundary falls between the 200th and the 201st, and a page this size is written
  // back in five reports (four of fifty and a tail of one) — each entry's checks must arrive at its own
  // anchors however the page and its writes are split.
  const count = 201;
  // Ids of this case's own (`fade...`, and no other case's): the anchors list orders by id, so the
  // page boundary and every expected verdict below are read off the entries' own order.
  const idOf = (i: number): string => `fade0000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const pathOf = (i: number): string => `src/entry-${String(i).padStart(3, '0')}.go`;
  const symbolOf = (i: number): string => `sym${i}`;
  const ownBaselineOf = (i: number): string => createHash('sha256').update(`a baseline entry ${i} named`).digest('hex');
  const gone = new Set([3, 197]);
  await h.prisma.wikiEntry.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      ownerId: h.ownerId, spaceId: fx.spaceId, id: idOf(i), kind: 'concept', title: `anchored ${i}`, summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [
        { type: 'path', path: pathOf(i) },
        ...(i % 4 === 0 ? [{ type: 'symbol', path: pathOf(i), symbol: symbolOf(i), ...(i % 8 === 0 ? { regionSha256: ownBaselineOf(i) } : {}) }] : []),
      ],
    })),
  });
  // The runner this case plays: a path is there unless it is one of the gone ones, and a symbol's region
  // hashes from its own name — so a verdict laid on a page-mate, or a check written to the wrong entry,
  // shows as the wrong region rather than passing.
  const checkAnchorOf = (anchor: Record<string, unknown>): Record<string, unknown> => {
    if (anchor.type === 'path') return { ...anchor, state: gone.has(Number(/entry-(\d+)\.go/u.exec(String(anchor.path))?.[1] ?? -1)) ? 'missing' : 'verified' };
    return { ...anchor, state: 'verified', regionSha256: ANCHOR_REPO.regionOf(String(anchor.symbol ?? '')) };
  };

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorOf });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', `the anchors step must not fail: ${job.error ?? ''}`);
  const ops = await anchorsOps(h);
  assert.equal(ops.length, 2, '201 entries are two operations');
  assert.equal(ops[0]!.anchors, count - 1 + 50, 'the first operation carries a full page: the 200 entries\' paths and the 50 symbols of those among them that carry one');
  assert.equal(ops[1]!.anchors, 1 + 1, 'the second operation carries the page\'s tail entry and its symbol');

  const entries = await h.prisma.wikiEntry.findMany({ where: { ownerId: h.ownerId, spaceId: fx.spaceId }, orderBy: { id: 'asc' } });
  assert.equal(entries.length, count);
  let changed = 0;
  let missing = 0;
  for (const [i, entry] of entries.entries()) {
    const anchors = entry.anchors as Array<Record<string, unknown> & { check?: Record<string, unknown> }>;
    assert.equal(anchors.length, i % 4 === 0 ? 2 : 1, `entry ${i} keeps its own anchors`);
    assert.equal(anchors[0]!.check?.state, gone.has(i) ? 'missing' : 'verified', `entry ${i}'s path is its own verdict`);
    if (anchors.length === 2) {
      const own = i % 8 === 0;
      assert.equal(anchors[1]!.check?.state, own ? 'changed' : 'verified', `entry ${i}'s symbol is held to ${own ? 'its own' : 'the found'} region`);
      assert.equal(anchors[1]!.check?.regionSha256, ANCHOR_REPO.regionOf(symbolOf(i)), `entry ${i}'s symbol check carries its own region`);
      if (own) assert.equal(anchors[1]!.check?.baselineSha256, undefined, 'an entry that named its own baseline keeps it');
      else assert.equal(anchors[1]!.check?.baselineSha256, ANCHOR_REPO.regionOf(symbolOf(i)), 'an entry with no baseline adopts the region its own check found');
      if (own) changed += 1;
    }
    if (gone.has(i)) missing += 1;
  }
  assert.equal(changed, Math.ceil(count / 8), 'every entry that named its own baseline reads changed');
  assert.equal(missing, gone.size);
  const report = (await runRow(h, fx.runId)).report as Record<string, unknown>;
  assert.deepEqual(report.anchors, { entries: count, changed, missing, skipped: 0 }, 'the counts are the entries\', whatever report a chunk fell in');
});

// ── A commit an earlier run already checked owes nothing (2026-10-10, `anchorRules.verify.skip`) ─

/**
 * A second maintenance run of the same space, as the trigger would make one beside the first: its own run row and
 * its own queued job, over the same entries and the same checkout. A replay after a `REPO_OP_WAIT` is this second
 * run, run again on the same commit — which is the case these run, and what the canary's replayed runs paid for.
 */
async function runAgain(h: Harness, fx: Fixture): Promise<{ runId: string; jobId: string }> {
  const runId = randomUUID();
  const jobId = randomUUID();
  await h.prisma.wikiMaintenanceRun.create({
    data: { id: runId, spaceId: fx.spaceId, ownerId: h.ownerId, jobId, due: 'backlog', backlog: 0, pendingSessions: 0 },
  });
  await h.prisma.wikiJob.create({ data: { id: jobId, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'maintain', input: { runId }, state: 'queued' } });
  return { runId, jobId };
}

/** One entry's anchors as its row holds them, checks and all: what "nothing was written again" is read from. */
async function entryAnchors(h: Harness, entryId: string): Promise<unknown> {
  return (await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: entryId }, select: { anchors: true } })).anchors;
}

/** What one run of a page's entries reports under `anchors`. */
async function anchorsReport(h: Harness, runId: string): Promise<Record<string, number>> {
  return ((await runRow(h, runId)).report as { anchors: Record<string, number> }).anchors;
}

/** The anchors one operation carried, as the runner was handed them. */
async function anchorsSent(h: Harness, jobId: string): Promise<number> {
  return h.sql.query<{ anchors: number }>(
    `SELECT jsonb_array_length("input"->'anchors') AS "anchors" FROM "wiki_repo_op"
      WHERE "job_id" = $1 AND "kind" = 'anchors'`, [jobId],
  ).then((result) => result.rows.reduce((total, row) => total + Number(row.anchors), 0));
}

/** Three entries' ids of one case's own (`feed…`, and no other case's): entries outlive a case, and the anchors
 * list orders by id — so two cases seeding the same anchors need two sets of ids. */
function groupOf(group: string): string[] {
  return [1, 2, 3].map((n) => `${group}-0000-4000-8000-${String(n).padStart(12, '0')}`);
}

/** Three entries whose anchors are the shape a first check leaves them in: a path and a commit, a symbol that
 * named no baseline (its check adopts the region it found), and another path. Nothing names a baseline of its own,
 * which is the one shape a later run on the same commit may leave alone. */
async function onceEntries(h: Harness, spaceId: string, ids: string[]): Promise<void> {
  await h.prisma.wikiEntry.createMany({
    data: [
      [{ type: 'path', path: ANCHOR_REPO.file }, { type: 'commit', sha: ANCHOR_REPO.commit }],
      [{ type: 'symbol', path: ANCHOR_REPO.file, symbol: 'main' }],
      [{ type: 'path', path: ANCHOR_REPO.file }],
    ].map((anchors, i) => ({
      id: ids[i]!, ownerId: h.ownerId, spaceId, kind: 'concept', title: `once ${i}`, summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [], anchors,
    })),
  });
}

test('a second run on the commit an earlier run checked re-checks nothing: no anchors operation, no write at all', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // No dossiers: the anchors step is what this case is about.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  const once = groupOf('feed0001');
  await onceEntries(h, fx.spaceId, once);

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });
  assert.equal((await jobOf(h, fx.jobId)).state, 'succeeded', (await jobOf(h, fx.jobId)).error ?? '');
  assert.deepEqual((await repoOpsOf(h, fx.jobId)).map((op) => op.kind), ['snapshot', 'anchors'], 'the first run checks them once');
  assert.equal(await anchorsSent(h, fx.jobId), 4, 'every anchor of the three entries went out');
  assert.equal((await anchorsReport(h, fx.runId)).entries, 3, 'nothing was checked at this commit before this run');
  const written = await Promise.all(once.map((id) => entryAnchors(h, id)));

  // The same space, the same snapshot commit: the second run a replay makes, and the round after a round whose
  // origin/main has not moved.
  const again = await runAgain(h, fx);
  const second = worker(h);
  await pass(h, second, async () => (await jobOf(h, again.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });

  const job = await jobOf(h, again.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual((await repoOpsOf(h, again.jobId)).map((op) => op.kind), ['snapshot'],
    'every entry was already checked at this commit: the runner is handed no anchors at all');
  assert.deepEqual(await Promise.all(once.map((id) => entryAnchors(h, id))), written, 'and not one check was written again');
  assert.deepEqual(await anchorsReport(h, again.runId), { entries: 0, changed: 0, missing: 0, skipped: 3 },
    'entries counts what the run wrote; what it left alone is skipped and nothing else');
});

test('a snapshot that moved, and does not reach the commit the checks were made on, re-checks every entry, and the checks carry the commit they were made on', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  const once = groupOf('feed0011');
  await onceEntries(h, fx.spaceId, once);

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });
  const before = await Promise.all(once.map((id) => entryAnchors(h, id)));

  // origin/main moved: the space's snapshot is the new commit, and the runner answers from it.
  const moved = 'f'.repeat(40);
  await h.sql.query('UPDATE "wiki_repo_snapshot" SET "sha" = $2 WHERE "space_id" = $1', [fx.spaceId, moved]);
  const again = await runAgain(h, fx);
  const second = worker(h);
  await pass(h, second, async () => (await jobOf(h, again.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo, snapshotSha: moved });

  const job = await jobOf(h, again.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual((await repoOpsOf(h, again.jobId)).map((op) => op.kind), ['snapshot', 'anchors'],
    'a check made on a commit the snapshot does not reach has no diff to vouch for it: the whole page goes out again');
  assert.equal(await anchorsSent(h, again.jobId), 4, 'every anchor of it');
  assert.deepEqual(await anchorsReport(h, again.runId), { entries: 3, changed: 0, missing: 0, skipped: 0 }, 'nothing was already checked at the moved commit');
  const after = await Promise.all(once.map((id) => entryAnchors(h, id)));
  for (const [i, anchors] of after.entries()) {
    for (const anchor of anchors as Array<{ check?: { ref?: string | null } }>) {
      assert.equal(anchor.check?.ref, moved, `entry ${i}'s check was made on the commit that just moved`);
    }
  }
  assert.notDeepEqual(after, before, 'so what is written moved with it');
});

test('a page is checked entry by entry: only the entries that still owe a check at this commit go out', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // Four entries, in id order: checked at this commit (skipped); never checked (sent); a symbol that names its
  // own baseline, checked at this commit and verified there — the shape a Re-confirm leaves, which no rule can
  // prove still holds, so it goes out too; and a symbol whose check adopted the region it found (skipped).
  const ids = ['feed0002-0000-4000-8000-000000000001', 'feed0002-0000-4000-8000-000000000002', 'feed0002-0000-4000-8000-000000000003', 'feed0002-0000-4000-8000-000000000004'];
  const at = '2026-10-01T00:00:00.000Z';
  const serveRegion = ANCHOR_REPO.regionOf('serve');
  await h.prisma.wikiEntry.createMany({
    data: [
      [{ type: 'path', path: ANCHOR_REPO.file, check: { state: 'verified', ref: REPO.sha, at } }],
      [{ type: 'path', path: ANCHOR_REPO.file }],
      [{ type: 'symbol', path: ANCHOR_REPO.file, symbol: 'serve', regionSha256: serveRegion, check: { state: 'verified', ref: REPO.sha, at, regionSha256: serveRegion } }],
      [{ type: 'symbol', path: ANCHOR_REPO.file, symbol: 'main', check: { state: 'verified', ref: REPO.sha, at, regionSha256: ANCHOR_REPO.regionOf('main'), baselineSha256: ANCHOR_REPO.regionOf('main') } }],
    ].map((anchors, i) => ({
      id: ids[i]!, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: `mixed ${i}`, summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [], anchors,
    })),
  });
  const before = await Promise.all(ids.map((id) => entryAnchors(h, id)));

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.equal(await anchorsSent(h, fx.jobId), 2, 'the unchecked path and the symbol that names its own baseline go out; the two already checked here do not');
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: 2, changed: 0, missing: 0, skipped: 2 },
    'two entries written, two left alone');
  const after = await Promise.all(ids.map((id) => entryAnchors(h, id)));
  assert.deepEqual(after[0], before[0], 'the entry checked at this commit is not written again');
  assert.deepEqual(after[3], before[3], 'and neither is the one whose check adopted its own region');
  assert.notDeepEqual(after[1], before[1], 'the entry that had no check got one');
  assert.notDeepEqual(after[2], before[2], 'and the one that names its own baseline was checked again, though its check stood on this commit');
});

test('a baseline the owner\'s Re-confirm moved is re-checked, though its check stands on this very commit', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // The symbol was found changed at this commit, and the owner re-confirmed: `rebaselinedAnchors` is the
  // transform the service applies for it (wiki.service.ts, the reconfirm answer), and it leaves exactly what a
  // plain check leaves — the anchor naming the region that check found, checked and verified, ref unchanged.
  const serveRegion = ANCHOR_REPO.regionOf('serve');
  const reconfirmed = rebaselinedAnchors([{
    type: 'symbol', path: ANCHOR_REPO.file, symbol: 'serve', regionSha256: 'c'.repeat(64),
    check: { state: 'changed', ref: REPO.sha, at: '2026-10-01T00:00:00.000Z', regionSha256: serveRegion },
  }]);
  assert.equal(reconfirmed.changed, true, 'the re-confirm moved the baseline');
  assert.equal((reconfirmed.anchors[0] as { regionSha256?: string }).regionSha256, serveRegion, 'to the region the check found');
  assert.equal(reconfirmed.anchors[0]!.check?.ref, REPO.sha, 'and its check still stands on this very commit');
  const [id] = ['feed0003-0000-4000-8000-000000000001'];
  await h.prisma.wikiEntry.create({
    data: {
      id, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'reconfirmed', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: reconfirmed.anchors as unknown as Prisma.InputJsonValue,
    },
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: checkAnchorAgainstRepo });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.equal(await anchorsSent(h, fx.jobId), 1, 'the anchor a re-confirm re-baselined is checked again');
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: 1, changed: 0, missing: 0, skipped: 0 }, 'and counted as written, not as skipped');
  const anchors = (await entryAnchors(h, id)) as Array<{ check?: { state?: string; ref?: string | null; at?: string | null; regionSha256?: string } }>;
  assert.equal(anchors[0]!.check?.state, 'verified');
  assert.equal(anchors[0]!.check?.ref, REPO.sha);
  assert.notEqual(anchors[0]!.check?.at, '2026-10-01T00:00:00.000Z', 'the check is this run\'s, not the one the re-confirm kept');
});

// ── A check nothing has moved since owes nothing either (2026-10-10, `anchorRules.verify.skip`) ──────────────────

/**
 * The commit the cases below last checked their entries at: one the snapshot (REPO.sha) reaches — each case's
 * fixture lists it among the snapshot's commits — so the run can ask the runner for a diff from it.
 */
const CHECKED = createHash('sha1').update('the commit the entries were last checked at').digest('hex');
const CHECKED_AT = '2026-10-09T00:00:00.000Z';

/** A last check as an earlier run left it, on CHECKED unless `ref` says otherwise. */
function checkedOn(state: 'verified' | 'missing' | 'changed', extra: Record<string, unknown> = {}, ref: string = CHECKED): Record<string, unknown> {
  return { state, ref, at: CHECKED_AT, ...extra };
}

/** Entries with the anchors given, under ids of one case's own (`prefix`, numbered from 1): the list orders by id, so do these. */
async function anchoredEntries(h: Harness, spaceId: string, prefix: string, anchors: Array<Array<Record<string, unknown>>>): Promise<string[]> {
  const ids = anchors.map((_, i) => `${prefix}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  await h.prisma.wikiEntry.createMany({
    data: anchors.map((list, i) => ({
      id: ids[i]!, ownerId: h.ownerId, spaceId, kind: 'concept', title: `anchored ${prefix} ${i}`, summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: list as unknown as Prisma.InputJsonValue,
    })),
  });
  return ids;
}

/** What the run's `anchors` operations handed the runner, anchor by anchor and in order: its type and what it names. */
async function anchorsAsked(h: Harness, jobId: string): Promise<string[]> {
  const rows = await h.sql.query<{ input: { anchors?: Array<Record<string, unknown>> } }>(
    `SELECT "input" FROM "wiki_repo_op" WHERE "job_id" = $1 AND "kind" = 'anchors' ORDER BY "created_at", "id"`, [jobId],
  );
  return rows.rows.flatMap((row) => (row.input.anchors ?? []).map((anchor) =>
    `${String(anchor.type)} ${String(anchor.path ?? anchor.sha ?? '')}${anchor.symbol === undefined ? '' : `#${String(anchor.symbol)}`}`));
}

/** The diffs the run asked for, in order: from which commit to which, and when each was asked and settled. */
async function diffsAsked(h: Harness, jobId: string): Promise<Array<{ from: string; to: string; createdAt: string; endedAt: string }>> {
  return h.sql.query<{ from: string; to: string; createdAt: string; endedAt: string }>(
    `SELECT "input"->>'from' AS "from", "input"->>'to' AS "to", "created_at" AS "createdAt", "ended_at" AS "endedAt"
       FROM "wiki_repo_op" WHERE "job_id" = $1 AND "kind" = 'diff' ORDER BY "created_at", "id"`, [jobId],
  ).then((result) => result.rows);
}

/** The runner at REPO.sha: a path is there unless `gone` names it, a commit an ancestor when `reached` holds it, and a symbol's region hashes from its name. */
function runnerAt(gone: readonly string[], reached: readonly string[] = []): (anchor: Record<string, unknown>) => Record<string, unknown> {
  return (anchor) => {
    if (anchor.type === 'path') return { ...anchor, state: gone.includes(String(anchor.path)) ? 'missing' : 'verified' };
    if (anchor.type === 'commit') return { ...anchor, state: reached.includes(String(anchor.sha)) ? 'verified' : 'missing' };
    return { ...anchor, state: 'verified', regionSha256: ANCHOR_REPO.regionOf(String(anchor.symbol ?? '')) };
  };
}

/** No dossiers: the run proposes nothing, and the anchors step is what these cases are about. */
function noDossiers(h: Harness, fx: Fixture): void {
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
}

test('a path checked since is checked again when the diff moves it — an A, a D, a T, either side of an R, a C\'s new side — and not when it only modifies it', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { snapshot: { files: {}, commits: [CHECKED] } });
  noDossiers(h, fx);
  // One path an entry, found there on CHECKED but the one found missing there; what the diff since does to each:
  const paths: Array<[string, boolean]> = [
    ['src/kept.go', false], //            nothing (a sibling's A, src/kept.go.orig, names another file)
    ['src/edited.go', false], //          M: it is still there
    ['src/added.go', true], //            A
    ['src/deleted.go', true], //          D
    ['src/moved-away.go', true], //       R, its old side
    ['src/moved-here.go', true], //       R, its new side
    ['src/copied-here.go', true], //      C, its new side
    ['src/copied-from.go', false], //     C, its old side: a copy leaves its source where it was
    ['src/retyped', true], //             T
    ['src/tree-edited', false], //        a directory, a file under which is M
    ['src/tree-grown', true], //          a directory, a file under which is A
    ['src/tree-shrunk', true], //         a directory, a file under which is D
    ['src/tree', false], //               a directory that is a prefix of the ones above but holds nothing they name
    ['./src//deleted-too.go/', true], //  D of src/deleted-too.go: the path as the runner spells it
    ['src/back.go', true], //             found missing on CHECKED, A since: it came back
  ];
  const ids = await anchoredEntries(h, fx.spaceId, 'beef0001', paths.map(([path]) => [
    { type: 'path', path, check: checkedOn(path === 'src/back.go' ? 'missing' : 'verified') },
  ]));
  const diff = [
    { status: 'A', path: 'src/kept.go.orig' },
    { status: 'M', path: 'src/edited.go' },
    { status: 'A', path: 'src/added.go' },
    { status: 'D', path: 'src/deleted.go' },
    { status: 'R100', path: 'lib/moved-away.go', from: 'src/moved-away.go' },
    { status: 'R087', path: 'src/moved-here.go', from: 'lib/moved-here.go' },
    { status: 'C075', path: 'src/copied-here.go', from: 'src/copied-from.go' },
    { status: 'T', path: 'src/retyped' },
    { status: 'M', path: 'src/tree-edited/a.go' },
    { status: 'A', path: 'src/tree-grown/new.go' },
    { status: 'D', path: 'src/tree-shrunk/old.go' },
    { status: 'D', path: 'src/deleted-too.go' },
    { status: 'A', path: 'src/back.go' },
  ];
  const before = await Promise.all(ids.map((id) => entryAnchors(h, id)));

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', {
    checkAnchor: runnerAt(['src/deleted.go', 'src/moved-away.go', './src//deleted-too.go/']),
    diffs: { [CHECKED]: { files: diff, docs: [] } },
  });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual((await repoOpsOf(h, fx.jobId)).map((op) => op.kind), ['snapshot', 'diff', 'anchors'], 'one diff, then one operation for what it did not vouch for');
  assert.deepEqual((await diffsAsked(h, fx.jobId)).map((op) => [op.from, op.to]), [[CHECKED, REPO.sha]], 'from the commit the checks were made on to the snapshot\'s');
  const due = paths.filter(([, again]) => again).map(([path]) => `path ${path}`);
  assert.deepEqual(await anchorsAsked(h, fx.jobId), due, 'exactly the paths the diff may have moved go out');
  const after = await Promise.all(ids.map((id) => entryAnchors(h, id)));
  for (const [i, [path, again]] of paths.entries()) {
    const check = (after[i] as Array<{ check?: { ref?: string } }>)[0]!.check;
    if (again) assert.equal(check?.ref, REPO.sha, `${path} is checked at the snapshot's commit`);
    else assert.deepEqual(after[i], before[i], `${path}: nothing of it is written`);
  }
  const back = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: ids[14]! } });
  assert.equal(back.anchorState, 'verified', 'the path that came back reads verified again');
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: due.length, changed: 0, missing: 3, skipped: paths.length - due.length },
    'what was checked is counted as written, the rest as skipped');
});

test('a symbol checked since is checked again on any change to its file, a modification too; one that names its own baseline, or was re-confirmed, always', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { snapshot: { files: {}, commits: [CHECKED] } });
  noDossiers(h, fx);
  const region = (symbol: string): string => ANCHOR_REPO.regionOf(symbol);
  // The re-confirm of a symbol found changed on CHECKED: it names the region that check found as its own baseline.
  const reconfirmed = rebaselinedAnchors([{
    type: 'symbol', path: 'src/app.go', symbol: 'again', regionSha256: 'c'.repeat(64),
    check: { state: 'changed', ref: CHECKED, at: CHECKED_AT, regionSha256: region('again') },
  }]).anchors;
  const ids = await anchoredEntries(h, fx.spaceId, 'beef0002', [
    // 0: its check adopted its region, and nothing in the diff is its file: left alone.
    [{ type: 'symbol', path: 'src/app.go', symbol: 'main', check: checkedOn('verified', { regionSha256: region('main'), baselineSha256: region('main') }) }],
    // 1: adopted, and its file is modified: its region may have moved.
    [{ type: 'symbol', path: 'src/server.go', symbol: 'serve', check: checkedOn('verified', { regionSha256: region('serve'), baselineSha256: region('serve') }) }],
    // 2: adopted, in a directory a file under which is modified.
    [{ type: 'symbol', path: 'src/tree', symbol: 'walk', check: checkedOn('verified', { regionSha256: region('walk'), baselineSha256: region('walk') }) }],
    // 3: it names its own baseline, a proposer's, and its file did not change: no rule proves it.
    [{ type: 'symbol', path: 'src/app.go', symbol: 'own', regionSha256: region('own'), check: checkedOn('verified', { regionSha256: region('own') }) }],
    // 4: re-confirmed, and its file did not change.
    reconfirmed as unknown as Array<Record<string, unknown>>,
    // 5: a path whose file is modified: a modification does not move a path.
    [{ type: 'path', path: 'src/server.go', check: checkedOn('verified') }],
  ]);
  const before = await Promise.all(ids.map((id) => entryAnchors(h, id)));

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', {
    checkAnchor: runnerAt([]),
    diffs: { [CHECKED]: { files: [{ status: 'M', path: 'src/server.go' }, { status: 'M', path: 'src/tree/leaf.go' }], docs: [] } },
  });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual(await anchorsAsked(h, fx.jobId),
    ['symbol src/server.go#serve', 'symbol src/tree#walk', 'symbol src/app.go#own', 'symbol src/app.go#again'],
    'the modified file\'s symbol, the one under the modified directory, and the two baselines no check can vouch for');
  const after = await Promise.all(ids.map((id) => entryAnchors(h, id)));
  assert.deepEqual(after[0], before[0], 'the symbol whose file did not change is not written');
  assert.deepEqual(after[5], before[5], 'nor is the path whose file was only modified');
  for (const i of [1, 2, 3, 4]) {
    assert.equal((after[i] as Array<{ check?: { ref?: string; state?: string } }>)[0]!.check?.ref, REPO.sha, `symbol ${i} is checked at the snapshot's commit`);
  }
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: 4, changed: 0, missing: 0, skipped: 2 });
});

test('a commit found verified is left alone while the snapshot reaches it; one found missing, or one the snapshot no longer reaches, is checked again', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const sha = (what: string): string => createHash('sha1').update(what).digest('hex');
  const reached = sha('a commit main has had all along');
  const merged = sha('a commit main has merged since it was found missing');
  const absent = sha('a commit main never had');
  const dropped = sha('a commit a rewrite of main dropped');
  const fx = await fixture(h, { snapshot: { files: {}, commits: [CHECKED, reached, merged] } });
  noDossiers(h, fx);
  const ids = await anchoredEntries(h, fx.spaceId, 'beef0003', [
    [{ type: 'commit', sha: reached, check: checkedOn('verified') }], //  0: left alone
    [{ type: 'commit', sha: merged, check: checkedOn('missing') }], //    1: checked again, and found now
    [{ type: 'commit', sha: absent, check: checkedOn('missing') }], //    2: checked again, still missing
    [{ type: 'commit', sha: dropped, check: checkedOn('verified') }], //  3: checked again: the snapshot no longer reaches it
    // 4: every anchor holds — a path nothing moved and a commit reached: left alone.
    [{ type: 'path', path: 'src/kept.go', check: checkedOn('verified') }, { type: 'commit', sha: reached, check: checkedOn('verified') }],
    // 5: one anchor that does not hold re-checks the entry whole, its reached commit too.
    [{ type: 'commit', sha: reached, check: checkedOn('verified') }, { type: 'path', path: 'src/deleted.go', check: checkedOn('verified') }],
  ]);
  const before = await Promise.all(ids.map((id) => entryAnchors(h, id)));

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', {
    checkAnchor: runnerAt(['src/deleted.go'], [reached, merged]),
    diffs: { [CHECKED]: { files: [{ status: 'D', path: 'src/deleted.go' }], docs: [] } },
  });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual(await anchorsAsked(h, fx.jobId), [`commit ${merged}`, `commit ${absent}`, `commit ${dropped}`, `commit ${reached}`, 'path src/deleted.go']);
  const after = await Promise.all(ids.map((id) => entryAnchors(h, id)));
  assert.deepEqual(after[0], before[0], 'the reached commit is not written');
  assert.deepEqual(after[4], before[4], 'nor the entry whose every anchor holds');
  const states = await Promise.all(ids.map((id) => h.prisma.wikiEntry.findFirstOrThrow({ where: { id }, select: { anchorState: true } })));
  assert.deepEqual(states.map((row) => row.anchorState), ['unchecked', 'verified', 'missing', 'missing', 'unchecked', 'missing'],
    'the merged commit reads verified now, the absent one and the dropped one missing, and the entry whose path went with it missing');
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: 4, changed: 0, missing: 3, skipped: 2 });
});

test('the diffs go to the commits most anchors were checked at, anchorDiffsMax of them, one at a time; the entries checked at any other are checked again', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const cap = WIKI_MAINTAIN_JOB.anchorDiffsMax;
  // cap + 2 commits the snapshot reaches, the first with the most entries checked at it and the last with one, and
  // a commit it does not reach with more entries than any: none of their files moved.
  const refs = Array.from({ length: cap + 2 }, (_, i) => createHash('sha1').update(`a commit the space's checks were made on, ${i}`).digest('hex'));
  const far = createHash('sha1').update('a commit the snapshot does not reach').digest('hex');
  const fx = await fixture(h, { snapshot: { files: {}, commits: [...refs].reverse() } });
  noDossiers(h, fx);
  const groups = [...refs.map((ref, i) => ({ ref, count: cap + 2 - i })), { ref: far, count: cap + 3 }];
  const anchors = groups.flatMap((group, g) => Array.from({ length: group.count }, (_, n) => [
    { type: 'path', path: `src/group-${g}/file-${n}.go`, check: checkedOn('verified', {}, group.ref) },
  ]));
  await anchoredEntries(h, fx.spaceId, 'beef0004', anchors);

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: runnerAt([]) });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  const diffs = await diffsAsked(h, fx.jobId);
  assert.deepEqual(diffs.map((op) => op.from), refs.slice(0, cap), `the ${cap} commits most anchors were checked at, the most first`);
  for (const [i, op] of diffs.entries()) {
    assert.equal(op.to, REPO.sha);
    if (i > 0) assert.ok(Date.parse(op.createdAt) >= Date.parse(diffs[i - 1]!.endedAt), 'no diff is asked while another is in flight');
  }
  const again = groups.flatMap((group, g) => (g < cap ? [] : Array.from({ length: group.count }, (_, n) => `path src/group-${g}/file-${n}.go`)));
  assert.deepEqual(await anchorsAsked(h, fx.jobId), again, 'what the cap left without a diff, and what the snapshot does not reach, is checked again');
  const left = groups.slice(0, cap).reduce((total, group) => total + group.count, 0);
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: again.length, changed: 0, missing: 0, skipped: left });
});

test('the entries that still owe a check go out together whichever page they were read on: 450 entries, 12 of them due, are one operation', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { snapshot: { files: {}, commits: [CHECKED] } });
  noDossiers(h, fx);
  const count = 450;
  const pathOf = (i: number): string => `src/e-${String(i).padStart(3, '0')}.go`;
  // Due: every 50th entry from the 7th, whose file the diff deletes; one never checked; one whose check names no commit;
  // one found missing on CHECKED, which is checked again though nothing moved it. Left alone: the rest, checked on
  // CHECKED and not moved since, and one checked on this very commit.
  const deleted = new Set(Array.from({ length: count }, (_, i) => i).filter((i) => i % 50 === 7));
  const due = new Set([...deleted, 100, 200, 300]);
  await anchoredEntries(h, fx.spaceId, 'beef0005', Array.from({ length: count }, (_, i) => [{
    type: 'path',
    path: pathOf(i),
    ...(i === 100 ? {} : { check: i === 200 ? checkedOn('verified', {}, 'main') : i === 300 ? checkedOn('missing') : i === 400 ? checkedOn('verified', {}, REPO.sha) : checkedOn('verified') }),
  }]));

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', {
    checkAnchor: runnerAt([...deleted].map(pathOf)),
    diffs: { [CHECKED]: { files: [...deleted].map((i) => ({ status: 'D', path: pathOf(i) })), docs: [] } },
  });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  const ops = await anchorsOps(h);
  assert.deepEqual(ops.map((op) => op.anchors), [due.size], 'the due entries of three pages are one operation');
  assert.deepEqual(await anchorsAsked(h, fx.jobId), [...due].sort((a, b) => a - b).map((i) => `path ${pathOf(i)}`), 'in the list\'s order');
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: due.size, changed: 0, missing: deleted.size, skipped: count - due.size });
});

test('a diff the runner could not make vouches for nothing: the entries checked at its commit are checked again, and the run goes on', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { snapshot: { files: {}, commits: [CHECKED] } });
  noDossiers(h, fx);
  await anchoredEntries(h, fx.spaceId, 'beef0006', [
    [{ type: 'path', path: 'src/kept.go', check: checkedOn('verified') }],
    [{ type: 'path', path: 'src/also-kept.go', check: checkedOn('verified') }],
  ]);

  const which = worker(h, { wake: true });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded', { checkAnchor: runnerAt([]), failDiffs: true });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'succeeded', job.error ?? '');
  assert.deepEqual((await repoOpsOf(h, fx.jobId)).map((op) => op.kind), ['snapshot', 'diff', 'anchors']);
  assert.deepEqual(await anchorsAsked(h, fx.jobId), ['path src/kept.go', 'path src/also-kept.go']);
  assert.deepEqual(await anchorsReport(h, fx.runId), { entries: 2, changed: 0, missing: 0, skipped: 0 });
});

test('anchor verdicts that name anchors no entry asked for fail the run: nothing is laid on a guess', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  const first = '00000000-0000-4000-8000-000000000010';
  await h.prisma.wikiEntry.create({
    data: {
      id: first, ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: 'the kept entry, again', summary: 'a live entry',
      status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
      anchors: [{ type: 'path', path: ANCHOR_REPO.file }],
    },
  });
  // A runner that answers one check with an echo naming a different type than the anchor at that
  // index: the run cannot tell whose verdict it is, so it fails as content and writes nothing.
  const lying = (anchor: Record<string, unknown>): Record<string, unknown> => ({
    ...checkAnchorAgainstRepo(anchor),
    ...(anchor.type === 'path' ? { type: 'commit' } : {}),
  });

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'failed', { checkAnchor: lying });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'failed');
  assert.equal(job.failure_kind, 'content');
  assert.match(job.error ?? '', /refuses to guess/u);
  const kept = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: first } });
  assert.equal(((kept.anchors as unknown[])[0] as { check?: unknown }).check, undefined, 'no verdict is laid on a guess');
});

test('a run made while the space is catching up writes no document and proposes no plan change, and owes no articles job', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { catchUp: 'active' });
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded');
  const report = run.report as Record<string, unknown>;
  const docs = report.docs as Record<string, unknown>;
  assert.equal(docs.skipped, 'catching_up');
  assert.equal(docs.planVersion, null);
  assert.equal(docs.proposal, null);
  // Nothing of the documents was read: the only repository operation is the snapshot and the anchors.
  const kinds = await h.sql.query<{ kind: string }>(
    `SELECT "kind" FROM "wiki_repo_op" WHERE "owner_id" = $1`, [h.ownerId],
  ).then((result) => result.rows.map((row) => row.kind));
  assert.ok(!kinds.includes('diff'), 'the repository\'s half of the documents is not read');
  assert.equal((await jobRows(h)).filter((job) => job.kind === 'articles').length, 0);
});

// ── The breaker ─────────────────────────────────────────────────────────────────────────────────

test('the breaker holds back the ops of the first page that does not fit and stops the cursor where that page starts', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  // 100 live entries is the breaker's floor: ten of them may change, and the model offers more.
  const fx = await fixture(h, { activeEntries: 100 });
  h.model.answer = extractor(fx, 6);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  const report = run.report as Record<string, unknown>;
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.heldBackByBreaker, 0, 'the page\'s six entries fit in the ten the run may change');
  const stored = await h.prisma.wikiEntry.count({ where: { ownerId: h.ownerId, spaceId: fx.spaceId, status: 'active' } });
  assert.equal(stored, 106, 'the six the run proposed are live');
});

test('a run whose second page does not fit holds it back and stops the cursor there', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h, { activeEntries: 100 });
  h.model.answer = extractor(fx, 6);
  // Two pages: the first fits in the ten the breaker allows, the second's six do not.
  let pages = 0;
  const first = pageOf(fx) as Record<string, unknown>;
  const second = {
    ...(pageOf(fx) as Record<string, unknown>),
    from: fx.token, cursor: fx.token, more: false,
    dossiers: [dossier(fx, 'session-3', 6, false, 2), dossier(fx, 'session-4', 0, true, 2)].filter(() => true),
  };
  h.maintenance.dossierPage = (async () => {
    pages += 1;
    return pages === 1 ? { ...first, more: true, cursor: fx.token } : second;
  }) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const run = await runRow(h, fx.runId);
  const report = run.report as Record<string, unknown>;
  const ops = report.ops as Record<string, number>;
  assert.equal(ops.heldBackByBreaker, 6, 'the second page\'s six ops are held back');
  assert.equal(ops.recorded, 6, 'the first page\'s six ops were proposed');
  // The cursor stops where the held-back page starts: the advance never passed the page it held back.
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  const before = cursor.positionAt;
  assert.ok(before === null || before.getTime() <= fx.position.at.getTime(), 'the cursor did not pass the held-back page');
});

// ── Failure ─────────────────────────────────────────────────────────────────────────────────────

test('a repository operation the runner never answers is the platform\'s: the job is queued again and nothing is counted', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h, { repoWaitMs: 200 });
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'queued' && (await jobOf(h, fx.jobId)).failure_kind === 'infra',
    { failSnapshot: true });

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.state, 'queued', 'the platform\'s failure is tried again');
  assert.equal(job.failure_kind, 'infra');
  assert.match(job.error ?? '', /REPO_OP_FAILED|REPO_OP_WAIT|snapshot of origin\/main/u);
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, null, 'the run is not ended by a failure of the platform');
  assert.equal(run.endedAt, null);
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.consecutiveFailures, 0, 'an infrastructure failure is not counted against the space');
});

test('a refusal of the run\'s own ends it failed, counts it against the space and fails the job as content', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 1);
  h.maintenance.dossierPage = (async () => {
    throw new WikiRefusalError({ code: 'WIKI_CURSOR_INVALID', message: 'the page names no position this space handed out' });
  }) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'failed');

  const job = await jobOf(h, fx.jobId);
  assert.equal(job.failure_kind, 'content');
  assert.match(job.error ?? '', /dossiers could not be read/u);
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureKind, 'content');
  assert.ok(run.endedAt);
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.consecutiveFailures, 1, 'a failure of the work is counted against the space');
});

// ── Stopping (2026-10-09) ───────────────────────────────────────────────────────────────────────

/** The job's row as a stop leaves it: where it is, whether a retry was put off, and what it counted and said. */
async function jobAfterStop(h: Harness, jobId: string): Promise<{ state: string; next_attempt_at: Date | null; attempts: number; failure_kind: string | null; error: string | null }> {
  return (await h.sql.query(
    'SELECT "state", "next_attempt_at", "attempts", "failure_kind", "error" FROM "wiki_job" WHERE "id" = $1', [jobId],
  )).rows[0];
}

async function repoOpsOf(h: Harness, jobId: string): Promise<Array<{ id: string; kind: string }>> {
  return (await h.sql.query<{ id: string; kind: string }>('SELECT "id", "kind" FROM "wiki_repo_op" WHERE "job_id" = $1 ORDER BY "created_at", "id"', [jobId])).rows;
}

test('a worker that stops while the documents step waits for a read hands the job back: the run is not settled, no REPO_OP_FAILED, no read asked again, nothing counted (design §5.4)', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // No dossiers: the run goes through to the documents step, which is where it reads files.
  h.maintenance.dossierPage = (async () => ({ ...(pageOf(fx) as Record<string, unknown>), facts: 0, dossiers: [] })) as unknown as WikiMaintenance['dossierPage'];
  // The plan its owner confirmed: one document, its overview and a section of the code the step reads through the runner.
  const empty = { docs: [], code: [], contracts: [], sessions: null };
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: [{
          position: 0, category: 'dev', slug: 'app', title: '应用', question: '应用怎么启动？',
          audience: ['新加入的开发者'], scopeIn: ['入口'], lengthMin: 400, lengthMax: 4000,
          sections: {
            create: [
              { position: 0, key: 'overview', title: '总览', kind: 'overview', covers: '这篇讲应用怎么启动。', length: 300, sources: empty },
              { position: 1, key: 'main', title: '入口', kind: 'flow', covers: 'main 做什么。', length: 400, sources: { ...empty, code: [{ path: 'src/app.go', symbols: ['main'] }] } },
            ],
          },
        }],
      },
    },
  });
  h.model.answer = (hit) => writerAnswer(hit.prompt);
  const first = worker(h, { repoWaitMs: 60_000 });
  // Run until the documents step waits on its read: the runner answers everything else, and never that.
  await pass(h, first, async () => (await repoOpsOf(h, fx.jobId)).some((op) => op.kind === 'read'), { holdReads: true });
  const before = await repoOpsOf(h, fx.jobId);

  // SIGTERM: the worker stops, and the read's wait is cancelled with it.
  await first.executor.onModuleDestroy();
  await first.queue.onModuleDestroy();
  await delay(300);
  const run = await runRow(h, fx.runId);
  assert.deepEqual(
    {
      ...(await jobAfterStop(h, fx.jobId)),
      run: run.outcome,
      docs: (run.report as { docs?: { error?: string } } | null)?.docs?.error ?? null,
      asked: (await repoOpsOf(h, fx.jobId)).slice(before.length).map((op) => op.kind),
    },
    { state: 'queued', next_attempt_at: null, attempts: 0, failure_kind: null, error: WIKI_JOB_HANDED_BACK, run: null, docs: null, asked: [] },
    'the job is handed back — the run not settled, nothing counted, no REPO_OP_FAILED — and asks the runner for nothing more',
  );
  // What the space's health line reads meanwhile (maintenance.health): the run still under way, no failure and no
  // streak — the hand-back writes no run row and no cursor.
  const { maintenance: health } = await new WikiHealth(h.prisma as unknown as PrismaService).read(h.ownerId, fx.spaceId);
  assert.deepEqual(
    { look: health.look, consecutiveFailures: health.consecutiveFailures, lastFailure: health.lastFailure, running: health.running?.jobId ?? null },
    { look: 'running', consecutiveFailures: 0, lastFailure: null, running: fx.jobId },
    'the health line shows the run under way, and nothing of the stop counts against the space',
  );

  // The next worker takes the job over, and its replay finishes the run. The attempt the stop cut short is not counted
  // (the owner's decision of 2026-10-09).
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state));
  const ended = await jobOf(h, fx.jobId);
  assert.equal(ended.state, 'succeeded', ended.error ?? '');
  assert.equal((await jobAfterStop(h, fx.jobId)).attempts, 0, 'the stop counted nothing');
  assert.equal((await runRow(h, fx.runId)).outcome, 'succeeded');
});

// ── The lease outliving a stall (2026-10-10) ─────────────────────────────────────────────────────

test('the lease this harness claims under outlives a two-second stall: the sweep finds nothing to take over', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // The claim this spec's worker makes, made by hand so the sweep can be run in the same synchronous window
  // the loop resumes in — the call the next pass makes a moment later. Under the 400 ms lease this harness
  // used to claim under, the stall below spent it and that sweep took the job over: the row came back
  // 'queued', its attempt counted, LEASE_EXPIRED. The mechanism's own cases are wiki-jobs.pg.spec.ts's; what
  // this pins is the lease THIS spec's worker claims under.
  const [claimed] = await claimWikiJobs(h.prisma as unknown as PrismaService, {
    workerId: randomUUID(), kinds: ['maintain'], owners: [h.ownerId], limit: 1, leaseMs: HARNESS_LEASE_MS,
  });
  assert.equal(claimed?.id, fx.jobId, 'the fixture\'s job was not the one claimed');
  stallEventLoop(2_000);
  assert.deepEqual(
    await reclaimExpiredWikiJobs(h.prisma as unknown as PrismaService, 4), [],
    'a two-second stall spent the lease: the next pass would take the job over mid-run',
  );
  const { rows: [row] } = await h.sql.query<{ state: string; attempts: number; failure_kind: string | null }>(
    'SELECT "state", "attempts", "failure_kind" FROM "wiki_job" WHERE "id" = $1', [fx.jobId],
  );
  assert.deepEqual(row, { state: 'running', attempts: 0, failure_kind: null }, 'the stall cost the job its attempt');
});

test('a run whose event loop is blocked for two seconds keeps its lease: nothing is taken over and one attempt does all the writing', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.model.answer = extractor(fx, 2);
  h.maintenance.dossierPage = (async () => pageOf(fx)) as unknown as WikiMaintenance['dossierPage'];

  const which = worker(h);
  // The stall a loaded host produces by itself, here on demand: the run is claimed and under way — its lease
  // is held and its renewal is armed — and for two seconds no timer of this process fires. Spent right after
  // the claim, before the loop's next pass, nothing else of this process is waiting on a database answer
  // either, so what the block can spend is the lease and nothing else. Under the 400 ms lease this spec used
  // to claim with, the lease was spent by the time the loop came back and the pass that followed could take
  // the job over mid-run — the case above runs that sweep by hand and shows the row it leaves (queued,
  // attempts 1, LEASE_EXPIRED); here the lease outlasts the stall, so one attempt does all of it.
  await which.executor.runOnce();
  stallEventLoop(2_000);
  await pass(h, which, async () => (await jobOf(h, fx.jobId)).state === 'succeeded');

  const { rows: [job] } = await h.sql.query<{ attempts: number; failure_kind: string | null; error: string | null }>(
    'SELECT "attempts", "failure_kind", "error" FROM "wiki_job" WHERE "id" = $1', [fx.jobId],
  );
  assert.deepEqual(job, { attempts: 0, failure_kind: null, error: null }, 'the lease did not outlive the stall: the job was taken over');
  // And the one attempt is the whole run: its cursor advanced and nothing counted against the space.
  const run = await runRow(h, fx.runId);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.positionRef, fx.position.ref);
  assert.equal(cursor.consecutiveFailures, 0);
});

// ── A worker stopped mid-run: the report is the whole run's (contract `jobs.carry`) ─────────────

/**
 * The dossiers' reader as the server's own answers a run that is taken over: the fixture's page while the space's cursor
 * stands before it, and an empty page at the cursor once a run has moved it past — `dossierPage` starts at the
 * watermark, so a replay reads no dossier the attempt before it recorded.
 */
function readerAt(h: Harness, fixtures: readonly Fixture[]): WikiMaintenance['dossierPage'] {
  return (async (_ownerId: string, spaceId: string) => {
    const fx = fixtures.find((one) => one.spaceId === spaceId);
    assert.ok(fx, `no fixture holds space ${spaceId}`);
    const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId, source: 'facts' } });
    if (cursor.positionRef !== fx.position.ref) return pageOf(fx);
    return { ...(pageOf(fx) as Record<string, unknown>), from: fx.token, cursor: fx.token, more: false, facts: 0, dossiers: [] };
  }) as unknown as WikiMaintenance['dossierPage'];
}

/** The entry point's file at the snapshot's commit, as the runner reads it. */
const APP_GO = 'package app\n\n// main starts the service on the port its fixture hands it.\nfunc main() {\n\tserve(portFromFixture())\n}\n';

/**
 * The plan its owner confirmed for a hand-back case: an overview; the conventions, read from a project's records — the
 * owner's words about the fixture's port, which its coordinator heard; and the entry point, read from the repository.
 */
async function handBackPlan(h: Harness, fx: Fixture): Promise<void> {
  const coordinator = randomUUID();
  await h.sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","workspace_id","status","dispatch_origin","updated_at")
     VALUES ($1,'the coordinator','p',$2,$2,$3,'RUNNING'::run_status,'USER',now())`,
    [coordinator, h.ownerId, fx.workspaceId],
  );
  const projectId = randomUUID();
  await h.sql.query(`INSERT INTO "project"("id","title","owner_id","coordinator_session_id","updated_at") VALUES ($1,'Fixture 端口',$2,$3,now())`, [projectId, h.ownerId, coordinator]);
  await h.sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","content","status","kind","send_intent","created_at")
     VALUES ($1,$2,1,$3,$4,'ANSWERED','message','NEXT_TURN',now())`,
    [randomUUID(), coordinator, randomUUID(), '以后 fixture 里不要写死端口，一律从 fixture 的返回值里取，别的测试也照这样做。'],
  );
  const empty = { docs: [], code: [], contracts: [], sessions: null };
  await h.prisma.wikiPlan.create({
    data: {
      spaceId: fx.spaceId, ownerId: h.ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: h.ownerId,
      confirmedByUserId: h.ownerId, confirmedAt: new Date(), docsMin: 1, docsMax: 10, gate: {},
      categories: [{ key: 'dev', title: 'Development', question: 'How it works', forAgents: true }],
      docs: {
        create: [{
          position: 0, category: 'dev', slug: 'testing', title: '测试约定', question: '测试的端口怎么取？',
          audience: ['新加入的开发者'], scopeIn: ['fixture 的端口'], lengthMin: 400, lengthMax: 4000,
          sections: {
            create: [
              { position: 0, key: 'overview', title: '总览', kind: 'overview', covers: '这篇讲测试的端口。', length: 300, sources: empty },
              {
                position: 1, key: 'ports', title: '端口', kind: 'conventions', covers: 'fixture 的端口从哪里来。', length: 400,
                sources: {
                  ...empty,
                  sessions: {
                    projects: [projectId], since: null, until: null, keywords: ['fixture'], anchorPaths: [],
                    entryKinds: [], topics: [], evidence: 'the owner on where a test takes its port',
                  },
                },
              },
              { position: 2, key: 'main', title: '入口', kind: 'flow', covers: 'main 做什么。', length: 400, sources: { ...empty, code: [{ path: 'src/app.go', symbols: ['main'] }] } },
            ],
          },
        }],
      },
    },
  });
}

/** A run's report with its clock readings left out: what two runs of the same work on two spaces must agree on. */
function runTotals(report: unknown): Record<string, unknown> {
  const { seconds: _seconds, docs, ...rest } = (report ?? {}) as Record<string, unknown> & { docs?: Record<string, unknown> };
  if (!docs) return rest;
  const { seconds: _docSeconds, ...docRest } = docs;
  return { ...rest, docs: docRest };
}

/** The sections written in a space. */
async function writtenSections(h: Harness, spaceId: string): Promise<number> {
  return (await h.sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "wiki_doc_section" x JOIN "wiki_doc" d ON d."id" = x."doc_id" WHERE d."space_id" = $1`, [spaceId])).rows[0].n;
}

/**
 * The calls a job made: its requests — of the steps named, or every one — each once, with the tokens they reported. Every
 * request of these cases answers, so each is a call.
 */
async function callsOf(h: Harness, jobId: string, steps?: readonly string[]): Promise<{ calls: number; input: number; output: number }> {
  const { rows: [row] } = await h.sql.query<{ calls: number; input: number; output: number }>(
    `SELECT count(*)::int AS "calls", COALESCE(sum("input_tokens"), 0)::int AS "input", COALESCE(sum("output_tokens"), 0)::int AS "output"
       FROM "wiki_model_request" WHERE "job_id" = $1 AND "state" = 'succeeded' AND ($2::text[] IS NULL OR "step" = ANY($2::text[]))`,
    [jobId, steps ? [...steps] : null]);
  return row;
}

test('a run\'s tokens are its own requests, each once: the documents\' calls are counted once, in the run\'s tokens and the step\'s (P10 round 93)', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  h.maintenance.dossierPage = readerAt(h, [fx]);
  await handBackPlan(h, fx);
  const extract = extractor(fx, 2);
  h.model.answer = (hit) => (hit.prompt.includes('==== CASE FILE ====') || hit.prompt.includes('## Your answer') ? extract(hit) : writerAnswer(hit.prompt));
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, fx.jobId)).state), { files: { 'src/app.go': APP_GO } });
  assert.equal((await jobOf(h, fx.jobId)).state, 'succeeded');
  const report = (await runRow(h, fx.runId)).report as { tokens: Record<string, number>; docs: { tokens: Record<string, number>; sections: Record<string, number> } };
  assert.deepEqual(report.docs.sections, { written: 3, unchanged: 0, failed: 0 }, 'the documents step made calls of its own');
  // The run's tokens: every request of the job, once — extraction, verification, the documents' sections.
  const all = await callsOf(h, fx.jobId);
  assert.deepEqual(report.tokens, { input: all.input, output: all.output, calls: all.calls }, 'the run\'s tokens are its requests\', each once');
  // The documents step's: its sections' requests and the plan proposal's, once — not again on top of the run's.
  const docs = await callsOf(h, fx.jobId, [...Object.values(WIKI_DOCS_BUILD_JOB.steps), WIKI_MAINTAIN_JOB.steps.planProposal]);
  assert.ok(docs.calls > 0);
  assert.deepEqual(report.docs.tokens, { input: docs.input, output: docs.output, calls: docs.calls }, 'the step\'s tokens are its requests\', each once');
});

test('a worker stopped in the documents step hands the run back, and the report the replay ends with is the whole run\'s', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fixtures: Fixture[] = [];
  h.maintenance.dossierPage = readerAt(h, fixtures);
  const play: RunnerPlay = { files: { 'src/app.go': APP_GO } };

  // What the run reports when nothing stops it.
  const straight = await fixture(h);
  fixtures.push(straight);
  await handBackPlan(h, straight);
  // The extraction and the verdicts the extractor's, every documents' prompt the writer's.
  const extract = extractor(straight, 2);
  h.model.answer = (hit) => (hit.prompt.includes('==== CASE FILE ====') || hit.prompt.includes('## Your answer') ? extract(hit) : writerAnswer(hit.prompt));
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, straight.jobId)).state), play);
  const whole = await jobOf(h, straight.jobId);
  assert.equal(whole.state, 'succeeded', whole.error ?? '');

  // The same run in a space of the same shape: every step up to the documents, the conventions written, and the entry
  // point's read of the repository held while the worker stops.
  const stopped = await fixture(h);
  fixtures.push(stopped);
  await handBackPlan(h, stopped);
  const first = worker(h);
  await pass(h, first, async () => (await writtenSections(h, stopped.spaceId)) === 1
    && (await repoOpsOf(h, stopped.jobId)).some((op) => op.kind === 'read'), { ...play, holdReads: true });
  // SIGTERM: the read's wait is cancelled with the worker, and the job is handed back.
  await first.executor.onModuleDestroy();
  await first.queue.onModuleDestroy();
  assert.deepEqual(await jobAfterStop(h, stopped.jobId), { state: 'queued', next_attempt_at: null, attempts: 0, failure_kind: null, error: WIKI_JOB_HANDED_BACK });

  // The next worker takes it over: it reads no dossier — the cursor stands past them — re-checks no anchor — each was
  // checked at this commit — and writes the entry point and the overview.
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, stopped.jobId)).state), play);
  const done = await jobOf(h, stopped.jobId);
  assert.equal(done.state, 'succeeded', done.error ?? '');
  assert.equal(await writtenSections(h, stopped.spaceId), 3);
  const report = (await runRow(h, stopped.runId)).report as Record<string, unknown>;
  // What the same run reports when nothing stops it, to the dossier, the op, the verdict, the anchor, the section and the call.
  assert.deepEqual(runTotals(report), runTotals((await runRow(h, straight.runId)).report), 'the stopped run reports what the straight one does');
  const job = (row: JobRow) => row.report as { advanced?: boolean; refused?: unknown[]; report?: unknown };
  assert.deepEqual([job(done).advanced, job(done).refused], [job(whole).advanced, job(whole).refused], 'the cursor the run moved, and what it had refused');
  assert.deepEqual(runTotals(job(done).report), runTotals(report), 'the job\'s report holds the run\'s');

  // The parts the attempt before the stop did, counted once each.
  assert.deepEqual([report.sessions, report.dossiers, report.offTopic, (report.ops as Record<string, number>).recorded, report.cursorAdvanced], [2, 2, 1, 3, true]);
  assert.equal((report.verification as Record<string, number>).verified, 3, 'the run\'s own verdicts, recorded before the stop');
  assert.deepEqual(report.anchors, { entries: 3, changed: 0, missing: 0, skipped: 0 }, 'the anchors checked before the stop are checked, not skipped');
  const docs = report.docs as { sections: Record<string, number>; affected: Record<string, number>; tokens: Record<string, number> };
  assert.deepEqual(docs.sections, { written: 3, unchanged: 0, failed: 0 }, 'the conventions written before the stop are written, once');
  assert.deepEqual([docs.affected.unwritten, docs.affected.total], [3, 3], 'every section the step took up, once');
  // Every call the run made, once: the requests of the job's attempts, the read the stop cut off asked again.
  const calls = await callsOf(h, stopped.jobId);
  assert.deepEqual(report.tokens, { input: calls.input, output: calls.output, calls: calls.calls });
  assert.equal(report.tokens && (report.tokens as Record<string, number>).calls, (await callsOf(h, straight.jobId)).calls);
  // The articles a run that recorded ops owes are asked by the whole run's report: the stopped run, whose ops were all
  // recorded before the stop, owes its space the articles job the straight run's end queued for its own.
  const articles = async (spaceId: string): Promise<number> => (await h.sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "wiki_job" WHERE "space_id" = $1 AND "kind" = 'articles'`, [spaceId])).rows[0].n;
  assert.deepEqual([await articles(straight.spaceId), await articles(stopped.spaceId)], [1, 1]);
});

test('a worker stopped between the run\'s own verdicts hands the run back, and the report the replay ends with counts the verdict recorded before the stop', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fixtures: Fixture[] = [];
  h.maintenance.dossierPage = readerAt(h, fixtures);
  const verdicts = async (jobId: string): Promise<number> => (await h.sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "wiki_changeset_op" o JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
      WHERE c."job_id" = $1 AND o."verification_verdict" IS NOT NULL`, [jobId])).rows[0].n;

  // What the run reports when nothing stops it.
  const straight = await fixture(h);
  fixtures.push(straight);
  h.model.answer = extractor(straight, 2);
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, straight.jobId)).state));
  assert.equal((await jobOf(h, straight.jobId)).state, 'succeeded');
  const whole = (await runRow(h, straight.runId)).report as Record<string, unknown>;

  // The same run in a space of the same shape: its ops recorded and the cursor moved, the first verdict recorded, and the
  // second verdict's call held while the worker stops.
  const stopped = await fixture(h);
  fixtures.push(stopped);
  let asked = 0;
  let holding = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.model.hold = async (hit) => {
    if (!hit.prompt.includes('## Your answer')) return;
    asked += 1;
    if (asked < 2) return;
    holding = true;
    await released;
  };
  const first = worker(h);
  await pass(h, first, async () => holding && (await verdicts(stopped.jobId)) === 1);
  await first.executor.onModuleDestroy();
  await first.queue.onModuleDestroy();
  release();
  h.model.hold = async () => undefined;
  assert.deepEqual(await jobAfterStop(h, stopped.jobId), { state: 'queued', next_attempt_at: null, attempts: 0, failure_kind: null, error: WIKI_JOB_HANDED_BACK });

  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, stopped.jobId)).state));
  assert.equal((await jobOf(h, stopped.jobId)).state, 'succeeded');
  const report = (await runRow(h, stopped.runId)).report as Record<string, unknown>;
  // The dossiers it read, the ops it recorded and the cursor it moved before the stop: the run's, as the straight run's.
  // (Its anchors are not: only the op whose verdict was recorded went live, so the replay has one entry to check.)
  const pipeline = (r: Record<string, unknown>) => ({
    sessions: r.sessions, dossiers: r.dossiers, unchanged: r.unchanged, offTopic: r.offTopic, entries: r.entries, ops: r.ops,
    cursorAdvanced: r.cursorAdvanced, docs: runTotals({ docs: r.docs }).docs,
  });
  assert.deepEqual(pipeline(report), pipeline(whole), 'the pipeline before the stop is the run\'s');
  // The verdict recorded before the stop is the run's; the replay records none of the run's own (it verifies only the
  // ops it recorded itself, and its page held none).
  assert.equal(await verdicts(stopped.jobId), 1);
  assert.equal((report.verification as Record<string, number>).verified, 1, 'the verdict recorded before the stop');
  const calls = await callsOf(h, stopped.jobId);
  assert.deepEqual(report.tokens, { input: calls.input, output: calls.output, calls: calls.calls });
});

test('a worker stopped between two anchors operations hands the run back, and the report the replay ends with counts every entry checked once', { skip }, async () => {
  const h = await boot();
  await clearWork(h);
  const fixtures: Fixture[] = [];
  h.maintenance.dossierPage = readerAt(h, fixtures);
  // Two operations' worth of entries: listEntriesMax in the first, the rest in the second.
  const count = WIKI_ANCHOR_RULES.listEntriesMax + 50;
  const anchored = async (fx: Fixture): Promise<void> => {
    await h.prisma.wikiEntry.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        ownerId: h.ownerId, spaceId: fx.spaceId, kind: 'concept', title: `anchored ${i}`, summary: 'a live entry',
        status: 'active', trust: 'auto', currentRevision: 1, fields: { definition: 'x', boundaries: 'y' }, topics: [],
        anchors: [{ type: 'path', path: ANCHOR_REPO.file }],
      })),
    });
  };
  const anchorsOpsOf = async (jobId: string): Promise<string[]> => (await h.sql.query<{ state: string }>(
    `SELECT "state" FROM "wiki_repo_op" WHERE "job_id" = $1 AND "kind" = 'anchors' ORDER BY "created_at", "id"`, [jobId])).rows.map((row) => row.state);

  // What the run reports when nothing stops it.
  const straight = await fixture(h);
  fixtures.push(straight);
  await anchored(straight);
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, straight.jobId)).state), { checkAnchor: checkAnchorAgainstRepo });
  assert.equal((await jobOf(h, straight.jobId)).state, 'succeeded');
  const whole = (await runRow(h, straight.runId)).report as Record<string, unknown>;
  assert.deepEqual(whole.anchors, { entries: count, changed: 0, missing: 0, skipped: 0 });

  // The same run in a space of the same shape: the first operation answered and recorded, the second held while the
  // worker stops.
  const stopped = await fixture(h);
  fixtures.push(stopped);
  await anchored(stopped);
  const play: RunnerPlay = { checkAnchor: checkAnchorAgainstRepo };
  const first = worker(h);
  await pass(h, first, async () => {
    const ops = await anchorsOpsOf(stopped.jobId);
    if (ops[0] === 'succeeded') play.holdAnchors = true;
    return ops.length === 2 && ops[1] === 'queued';
  }, play);
  await first.executor.onModuleDestroy();
  await first.queue.onModuleDestroy();
  assert.deepEqual(await jobAfterStop(h, stopped.jobId), { state: 'queued', next_attempt_at: null, attempts: 0, failure_kind: null, error: WIKI_JOB_HANDED_BACK });
  const checkedBefore = await h.prisma.wikiEntry.count({ where: { ownerId: h.ownerId, spaceId: stopped.spaceId, anchorState: 'verified' } });
  assert.equal(checkedBefore, WIKI_ANCHOR_RULES.listEntriesMax, 'the first operation\'s entries were checked before the stop');

  // The next worker takes it over: the first operation's entries stand checked at this commit and are left alone; the
  // rest are checked.
  await pass(h, worker(h), async () => ['succeeded', 'failed'].includes((await jobOf(h, stopped.jobId)).state), { checkAnchor: checkAnchorAgainstRepo });
  assert.equal((await jobOf(h, stopped.jobId)).state, 'succeeded');
  assert.equal(await h.prisma.wikiEntry.count({ where: { ownerId: h.ownerId, spaceId: stopped.spaceId, anchorState: 'verified' } }), count);
  const report = (await runRow(h, stopped.runId)).report as Record<string, unknown>;
  assert.deepEqual(runTotals(report), runTotals(whole), 'the stopped run reports what the straight one does');
  assert.deepEqual(report.anchors, { entries: count, changed: 0, missing: 0, skipped: 0 }, 'every entry checked once, none of the first operation\'s skipped');
});
