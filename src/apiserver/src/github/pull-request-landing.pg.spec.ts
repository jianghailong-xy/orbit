/**
 * Landing through a pull request, on real PostgreSQL (docs/design/protected-branch-landing.md §3, §4, §13). GitHub is
 * faked through `GithubClient`'s injected fetch, as the GitHub specs do; every row is written by the code under test
 * except the fixture's project, task, sessions and the App's saved configuration.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/github/pull-request-landing.pg.spec.ts
 *
 * What it is held to:
 *   The landings into main are what a protected main refuses: a MAIN line's task-branch candidate, checked clean and
 *   confirmed by the owner, whose LAND_PROMOTION the runner claims (design §3's table). A LAND_TASK lands on the
 *   project's own branch.
 *
 *   (1) §3 at the hand-out: a runner without integration-pull-request/v1 is handed today's command and nothing is
 *       recorded; with it, an installation that has not accepted the permissions, an Orbit branch and a workspace not
 *       cloned from GitHub land PUSH; a GitHub workspace whose installation granted them lands PULL_REQUEST, its
 *       landing branch named after the landing session, both recorded on the job.
 *   (2) J-T14: the runner's PULL_REQUEST result moves the job to PULL_REQUEST and writes the subject's pull request
 *       row (OPENING, head, base, tested tree, GitHub's refusal); no runner holds it (a late report is STALE_CLAIM); it
 *       is in flight (no second landing is queued for the task's branch, the in-flight read says PULL_REQUEST, never
 *       timed out, waiting for checks; the landing view carries the pull request); a PULL_REQUEST from an attempt
 *       handed out PUSH is refused.
 *   (3) The door opens the pull request as the App (head orbit/land/<id>, base main, the task's title), waits while
 *       the required checks run and while a review is required, merges with sha = the pushed head once GitHub allows,
 *       and on GitHub's merged answer lands the job (J-T15): LANDED with GitHub's commit, a receipt recorded by SERVER
 *       naming the pull request, the pull request MERGED, the landing branch deleted, the landing settled, and the
 *       task reading as on main.
 *   (4) The merge method: a method the repository refuses is replaced by the next it allows.
 *   (5) §4.4's recorded exception: a merge whose tree is not the tested tree lands with the real tree and opens the
 *       INTEGRATION_ERROR item that asks for the project's check on main.
 *   (6) A stop fact on a waiting job ends it CANCELLED, and the door merges no pull request nobody waits on.
 *   (7) A session's Merge (§4.6): its command is handed the session's landing branch, and GitHub's merge records
 *       `merged` and a MERGED receipt by SERVER whose target_sha_after is GitHub's commit.
 *   (8) The webhook: the signature over the raw bytes, a redelivery de-duplicated, an unknown repository dropped, and
 *       the pull requests a delivery is about read again.
 *   (9) The re-read's cadence with a fake clock: every minute when no delivery arrived in the last hour, every ten
 *       minutes while deliveries arrive.
 *
 * The failure paths (design §4.2 J-T16 to J-T20, §4.5, §4.6 under D5):
 *  (10) J-T16: a required check that fails on the pull request ends the landing CHECK_FAILED with the GitHub check and
 *       its Actions log (redacted) in its checks; the item goes to the task's own work session (W4), whose landing-fix
 *       turn names the check, its failure lines, the log and the pull request that stays open (W6); the fix — the
 *       candidate W7 queues — is handed the open pull request, pushes to the same landing branch, and that same pull
 *       request merges.
 *  (11) J-T17: a pull request GitHub reports behind ends its attempt ERROR / TARGET_MOVED and queues the next
 *       generation under the same confirmation, into the same pull request, with no item and not counted (three
 *       catch-ups in a row block nothing); a merge GitHub refuses because the base moved is counted, and the third
 *       blocks the candidate.
 *  (12) J-T19 and J-T20: closed on GitHub ends the landing ERROR / PULL_REQUEST_CLOSED naming who closed it, the row
 *       CLOSED; a head Orbit did not push ends it ERROR / PULL_REQUEST_HEAD_CHANGED and nothing is merged. Each opens
 *       its item.
 *  (13) A required review: the landing waits, reads WAITING_FOR_REVIEW with the pull request's link, the owner is told
 *       once with the link however often it is read, and the approval merges it.
 *  (14) A session's Merge (§4.6, D5): a failing check records `error` naming it and hands the log to the session as
 *       one turn per head, whose own transaction owes the merge after the turn, at most two rounds; a moved target
 *       queues the merge again; closed records `error` with who closed it.
 */
process.env.PROVIDER_SECRET_KEY = process.env.PROVIDER_SECRET_KEY || `pull-request-landing-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import {
  INTEGRATION_PULL_REQUEST_CAPABILITY, PUSH_AS_ME_CAPABILITY, SESSION_MERGE_PULL_REQUEST_CAPABILITY, type IntegrationCheckResult,
  type IntegrationJobCommand,
} from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { TasksService } from '../tasks/tasks.service';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  applyIntegrationJobResult,
  receiveIntegrationJobProgress,
} from '../runner-api/integration-job-relay';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2, enqueueForDoneTask } from '../projects/project-integration-job';
import { readInFlightJobs, stopInFlightJob } from '../projects/project-integration-line';
import { readLandingView } from '../projects/landing-view';
import { readTaskIntegrationViews } from '../projects/project-task-integration';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import { recordSessionMergePullRequest } from '../projects/pull-request-landing';
import { landingFixMessage, readLandingFixFacts } from '../projects/landing-fix-turn';
import { queueTaskBranchCandidate } from '../projects/project-integration-job';
import { supersedeLiveCandidates } from '../projects/project-promotion.service';
import { pullRequestFixTurnId } from '../sessions/pull-request-fix-turn';
import { GITHUB_API, GITHUB_WEB, GithubClient } from './github-api.client';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubConnectionService } from './github-connection.service';
import { FIRST_REFUSAL_ALERT, PushAsMeService, SECOND_REQUEST_ALERT } from './push-as-me.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspacesController } from '../workspaces/workspaces.controller';
import { hashPassword } from '../common/crypto.util';
import { sanitizeWorkspaceWrite } from '../runner-api/runner-agents.controller';
import { GithubInstallationGrants } from './github-installation-grants';
import { GithubWebhookService } from './github-webhook';
import { PullRequestDoorService, REREAD_WITHOUT_DELIVERIES_MS, REREAD_WITH_DELIVERIES_MS } from './pull-request-door.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const SHA = (seed: string) => createHmac('sha1', 'pr').update(seed).digest('hex');
const WORK_REPORTED = [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }];
/** The task branch's tip the owner confirms, and main's tip it was checked and pushed on. */
const WORK_TIP = SHA('the task branch tip');
const UPSTREAM_TIP = SHA('main before the landing');
const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1_200, outputTail: 'ok\n',
};

// ── GitHub, faked ─────────────────────────────────────────────────────────────────────────────────────────────────

interface FakePull {
  number: number;
  head: string;
  base: string;
  headSha: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedBy: string | null;
  mergeCommit: { oid: string; tree: string } | null;
  closedBy?: string | null;
}

/** What GitHub says about a pull request's merge: one scenario a case sets. */
interface Scenario {
  mergeStateStatus: string;
  reviewDecision: string | null;
  checks: Array<{ name: string; required: boolean; status: string; conclusion: string | null; jobId?: number; summary?: string }>;
  baseSha: string | null;
  /** GitHub's `mergeable`; MERGEABLE unless a case says otherwise. */
  mergeable?: string;
  /** The merge call answers 405 "Base branch was modified" (J-T17, counted). */
  baseModified?: boolean;
  allowed: { merge: boolean; rebase: boolean; squash: boolean };
  /** Methods the merge call answers 405 "… not allowed" for. */
  refuses: string[];
  /** The tree GitHub's merge commit holds; the tested tree unless a case says otherwise. */
  mergeTree: (pull: FakePull) => string;
}

class PullRequestGithub {
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  readonly pulls: FakePull[] = [];
  readonly granted = new Map<number, Record<string, string>>();
  readonly repos = new Map<number, string>();
  readonly scenarios = new Map<string, Scenario>();
  readonly deleted: string[] = [];
  /** The GitHub Actions jobs' logs, by job id. */
  readonly logs = new Map<number, string>();
  private nextNumber = 100;
  /** §16 Q1: the user-token refreshes and revokes GitHub was asked for, in order, and how it answers them. */
  readonly tokenCalls: Array<{ kind: 'REFRESH'; refreshToken: string } | { kind: 'REVOKE'; accessToken: string; basic: string }> = [];
  refreshFails = false;
  revokeFails = false;
  private nextToken = 1;

  scenario(fullName: string): Scenario {
    let held = this.scenarios.get(fullName);
    if (!held) {
      held = {
        mergeStateStatus: 'BLOCKED', reviewDecision: null, checks: [], baseSha: null,
        allowed: { merge: true, rebase: true, squash: true }, refuses: [], mergeTree: () => '',
      };
      this.scenarios.set(fullName, held);
    }
    return held;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.origin === GITHUB_WEB && url.pathname === '/login/oauth/access_token' && method === 'POST') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(form.get('grant_type'), 'refresh_token');
      this.tokenCalls.push({ kind: 'REFRESH', refreshToken: form.get('refresh_token') ?? '' });
      if (this.refreshFails) {
        return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const n = this.nextToken++;
      return new Response(JSON.stringify({
        access_token: `ghu_rotated${n}${'x'.repeat(26)}`, expires_in: 28_800,
        refresh_token: `ghr_rotated${n}${'y'.repeat(26)}`, refresh_token_expires_in: 15_638_400, token_type: 'bearer', scope: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(url.origin, GITHUB_API, `the door reached ${url.origin}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });
    const json = (status: number, value: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    let match: RegExpMatchArray | null;
    if (method === 'DELETE' && /^\/applications\/[^/]+\/token$/.test(url.pathname)) {
      const headers = new Headers(init?.headers);
      this.tokenCalls.push({ kind: 'REVOKE', accessToken: body.access_token, basic: headers.get('authorization') ?? '' });
      return this.revokeFails ? json(500, { message: 'Server Error' }) : new Response(null, { status: 204 });
    }
    if (method === 'GET' && (match = url.pathname.match(/^\/app\/installations\/(\d+)$/))) {
      const id = Number(match[1]);
      return json(200, { id, account: { login: 'owner', type: 'User' }, permissions: this.granted.get(id) ?? { contents: 'write', metadata: 'read' } });
    }
    if (method === 'POST' && (match = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      return json(201, { token: `ghs_${randomBytes(8).toString('hex')}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (method === 'GET' && (match = url.pathname.match(/^\/repositories\/(\d+)$/))) {
      const fullName = this.repos.get(Number(match[1]));
      return fullName ? json(200, { full_name: fullName, default_branch: 'main' }) : json(404, { message: 'Not Found' });
    }
    if ((match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/))) {
      const fullName = match[1];
      if (method === 'GET') {
        const head = (url.searchParams.get('head') ?? '').split(':')[1];
        return json(200, this.pulls.filter((pull) => pull.state === 'OPEN' && pull.head === head && `${fullName}` !== '')
          .map((pull) => ({ number: pull.number, html_url: `https://github.com/${fullName}/pull/${pull.number}`, head: { sha: pull.headSha } })));
      }
      if (method === 'POST') {
        const pull: FakePull = {
          number: this.nextNumber++, head: body.head, base: body.base, headSha: this.headOf(body.head), title: body.title,
          body: body.body, state: 'OPEN', mergedBy: null, mergeCommit: null,
        };
        this.pulls.push(pull);
        return json(201, { number: pull.number, html_url: `https://github.com/${fullName}/pull/${pull.number}`, head: { sha: pull.headSha } });
      }
    }
    if (method === 'PUT' && (match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/))) {
      const scenario = this.scenario(match[1]);
      const pull = this.pulls.find((row) => row.number === Number(match![2]))!;
      if (scenario.baseModified) return json(405, { message: 'Base branch was modified. Review and try the merge again.' });
      if (scenario.refuses.includes(body.merge_method)) {
        return json(405, { message: `${body.merge_method[0].toUpperCase()}${body.merge_method.slice(1)} merges are not allowed on this repository.` });
      }
      if (body.sha !== pull.headSha) return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      pull.state = 'MERGED';
      pull.mergedBy = 'orbitd-cloud[bot]';
      pull.mergeCommit = { oid: SHA(`merge-${pull.number}`), tree: scenario.mergeTree(pull) };
      return json(200, { sha: pull.mergeCommit.oid, merged: true, message: 'Pull Request successfully merged' });
    }
    if (method === 'GET' && (match = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/))) {
      const log = this.logs.get(Number(match[1]));
      return log === undefined ? json(404, { message: 'Not Found' }) : new Response(log, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (method === 'DELETE' && (match = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/))) {
      this.deleted.push(decodeURIComponent(match[1]));
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.pathname === '/graphql') {
      const { owner, name, number } = body.variables as { owner: string; name: string; number: number };
      const fullName = `${owner}/${name}`;
      const pull = this.pulls.find((row) => row.number === number);
      if (!pull) return json(200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'no pull request' }] });
      const scenario = this.scenario(fullName);
      return json(200, {
        data: {
          repository: {
            mergeCommitAllowed: scenario.allowed.merge, rebaseMergeAllowed: scenario.allowed.rebase, squashMergeAllowed: scenario.allowed.squash,
            pullRequest: {
              number: pull.number, url: `https://github.com/${fullName}/pull/${pull.number}`, state: pull.state,
              merged: pull.state === 'MERGED', mergedBy: pull.mergedBy ? { login: pull.mergedBy } : null,
              mergeCommit: pull.mergeCommit ? { oid: pull.mergeCommit.oid, tree: { oid: pull.mergeCommit.tree } } : null,
              headRefOid: pull.headSha, baseRefName: pull.base, baseRef: { target: { oid: scenario.baseSha } },
              mergeable: scenario.mergeable ?? 'MERGEABLE', mergeStateStatus: pull.state === 'MERGED' ? 'UNKNOWN' : scenario.mergeStateStatus,
              reviewDecision: scenario.reviewDecision, isInMergeQueue: false, isMergeQueueEnabled: false,
              timelineItems: { nodes: pull.closedBy ? [{ actor: { login: pull.closedBy } }] : [] },
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: scenario.checks.map((check) => ({
                __typename: 'CheckRun', name: check.name, status: check.status, conclusion: check.conclusion,
                detailsUrl: `https://github.com/${fullName}/actions/runs/1${check.jobId ? `/job/${check.jobId}` : ''}`, isRequired: check.required,
                databaseId: check.jobId ?? null, title: null, summary: check.summary ?? null, text: null,
                checkSuite: { app: { slug: check.jobId ? 'github-actions' : 'some-ci' } },
              })) } } } }] },
            },
          },
        },
      });
    }
    return json(404, { message: `the fake has no ${method} ${url.pathname}` });
  }) as typeof fetch;

  /** What the landing branch holds, as the runner pushed it: the spec says so through `pushed`. */
  readonly pushed = new Map<string, string>();
  private headOf(branch: string): string {
    return this.pushed.get(branch) ?? '';
  }
}

// ── the harness ───────────────────────────────────────────────────────────────────────────────────────────────────

async function harness(t: { after(fn: () => Promise<void> | void): void }) {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const github = new PullRequestGithub();
  const client = new GithubClient(github.fetch);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const webhookSecret = `whsec-${randomBytes(12).toString('hex')}`;
  await prisma.githubAppConfig.upsert({
    where: { id: 'github' },
    create: {
      id: 'github', enabled: true, appId: 4243n, slug: 'orbit-pr-fake', clientId: 'Iv1.prfake',
      clientSecretEnc: encryptSecret('client-secret'), privateKeyEnc: encryptSecret(privateKey), webhookSecretEnc: encryptSecret(webhookSecret),
    },
    update: {
      enabled: true, appId: 4243n, slug: 'orbit-pr-fake', clientId: 'Iv1.prfake',
      clientSecretEnc: encryptSecret('client-secret'), privateKeyEnc: encryptSecret(privateKey), webhookSecretEnc: encryptSecret(webhookSecret),
    },
  });
  const config = new GithubAppConfigService(prisma as never, client);
  const grants = new GithubInstallationGrants(config, client);
  const relay = new IntegrationJobRelay(prisma as never, undefined, grants);
  const door = new PullRequestDoorService(prisma as never, config, client, grants);
  const webhooks = new GithubWebhookService(prisma as never, config, grants, door);
  const tasks = new TasksService(prisma as never, {} as never, { publishTaskChanged() {}, publishForUser() {} } as never);
  const promotions = new ProjectPromotionService(prisma as never);

  async function newOwner(label: string): Promise<string> {
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@pull-request-landing.invalid`, name: label, passwordHash: 'x' } });
    return ownerId;
  }

  /** A runner and a workspace on it, cloned from GitHub unless `github` is false. */
  async function newWorkspace(ownerId: string, name: string, options: { github: boolean; repoId?: number; installationId?: number }) {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId, ownerId, name, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
        capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const workspaceId = randomUUID();
    const repoId = options.repoId ?? 800_000_000 + Math.floor(Math.random() * 1_000_000);
    const installationId = options.installationId ?? 7_000_000 + Math.floor(Math.random() * 1_000_000);
    const fullName = `owner/${name}`;
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name, enabled: true, repoUrl: `https://github.com/${fullName}.git`, workDir: `/srv/${name}`,
        ...(options.github ? { githubRepoId: BigInt(repoId), githubInstallationId: BigInt(installationId), cloneState: 'READY' } : {}),
      },
    });
    github.repos.set(repoId, fullName);
    return { runnerId, workspaceId, repoId, installationId, fullName };
  }

  /**
   * A DONE task's landing, queued as design §3's table has it. On a `MAIN` line the task's branch is a candidate: its
   * check comes back clean on main and the owner confirms it, which queues the LAND_PROMOTION into main — the push a
   * protected main refuses. On a `PROJECT_BRANCH` line, a LAND_TASK onto the project's own branch.
   */
  async function queuedLanding(ownerId: string, workspace: { runnerId: string; workspaceId: string; fullName: string }, label: string, line: 'MAIN' | 'PROJECT_BRANCH' = 'MAIN') {
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `The project ${label} lands into` } });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    await prisma.projectCodebase.create({
      data: {
        ownerId, projectId, canonicalRepoUrl: `https://github.com/${workspace.fullName}`, upstreamRef: 'refs/heads/main',
        integrationRef: line === 'MAIN' ? 'refs/heads/main' : `refs/heads/project/${projectId}`,
        refAuthority: 'REMOTE', integrationRefSource: 'EXPLICIT', integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    const task = await tasks.create(ownerId, {
      title: label, projectId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    const done = await sql.query(
      `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`, [task.id]);
    assert.equal(done.rowCount, 1);
    // Not off the task id: a v7 id's first characters are its clock, shared by tasks made together.
    const branch = `orbit/work-${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        id: randomUUID(), ownerId, creatorId: ownerId, taskId: task.id, workspaceId: workspace.workspaceId,
        assignedRunnerId: workspace.runnerId, title: `ran ${label}`, prompt: 'do the work', branch,
        isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, baseSha: SHA(`base-${label}`), startsTaskWork: true,
        worktreeBranch: branch, worktreeDirty: false,
        changedFiles: WORK_REPORTED as never, createdAt: new Date(Date.now() - 2 * 86_400_000), finishedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    if (line === 'PROJECT_BRANCH') {
      assert.ok(queued.enqueued, `no landing was queued: ${JSON.stringify(queued)}`);
      const landTask = await prisma.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: task.id, kind: 'LAND_TASK' }, select: { id: true, landingId: true },
      });
      return { projectId, taskId: task.id, jobId: landTask.id, landingId: landTask.landingId as string };
    }
    assert.ok(queued.enqueued && queued.kind === 'PROMOTION', `no candidate was queued: ${JSON.stringify(queued)}`);
    // The candidate's check, by a runner process that lands nothing yet: clean on main, so the owner is asked.
    const handed = await relay.dispatch({
      runnerId: workspace.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const check = handed.find((command) => command.kind === 'CHECK_PROMOTION');
    assert.ok(check, `the candidate's check was not handed out: ${JSON.stringify(handed.map((command) => command.kind))}`);
    const checked = await applyIntegrationJobResult(prisma as never, {
      jobId: check.jobId, runnerId: workspace.runnerId, ownerId,
      body: {
        claimGeneration: check.claimGeneration, leaseOwner: check.leaseOwner, state: 'READY', phase: 'CHECK',
        sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP, testedSha: SHA(`tested-${label}`),
        testedTreeSha: SHA(`tested-tree-${label}`), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
      },
    });
    assert.ok(checked.answer.accepted, `the check was refused: ${JSON.stringify(checked.answer)}`);
    await promotions.confirm({ userId: ownerId }, projectId, queued.promotionId, WORK_TIP);
    const landPromotion = await prisma.projectIntegrationJob.findFirstOrThrow({
      where: { promotionId: queued.promotionId, kind: 'LAND_PROMOTION' }, select: { id: true, landingId: true },
    });
    return { projectId, taskId: task.id, jobId: landPromotion.id, landingId: landPromotion.landingId as string };
  }

  /** One heartbeat of a runner process, with or without the pull request capability. */
  async function beat(runnerId: string, pullRequests: boolean): Promise<IntegrationJobCommand[]> {
    return relay.dispatch({
      runnerId, leaseOwner: randomUUID(), draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM, ...(pullRequests ? [INTEGRATION_PULL_REQUEST_CAPABILITY] : [])],
    });
  }

  /** The runner's PULL_REQUEST answer for a claim: it pushed `head` to the landing branch after GitHub refused main. */
  function pullRequestResult(command: IntegrationJobCommand, head: string, tree: string) {
    github.pushed.set((command.landingRef ?? '').replace('refs/heads/', ''), head);
    return {
      claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'PULL_REQUEST' as const, phase: 'PUSH' as const,
      sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP, testedSha: head, testedTreeSha: tree, landingRefSha: head,
      pushRefusal: 'GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.',
      // An upstream that has not moved since the check reproduces the tree that passed and runs nothing again (M5).
      checks: [],
    };
  }

  const job = (jobId: string) => prisma.projectIntegrationJob.findUniqueOrThrow({ where: { id: jobId } });

  /** A door with the owner's devices and the sessions service faked: what it told the owner, and asked of sessions. */
  function doorWith(fakes: { push?: unknown; sessions?: unknown }): PullRequestDoorService {
    return new PullRequestDoorService(
      prisma as never, config, client, grants, promotions, undefined, undefined, fakes.push as never, undefined, undefined, fakes.sessions as never,
    );
  }

  return { prisma, sql, github, client, grants, relay, door, doorWith, promotions, webhooks, webhookSecret, tasks, newOwner, newWorkspace, queuedLanding, beat, pullRequestResult, job };
}

const GRANTED = { contents: 'write', metadata: 'read', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', workflows: 'write' };

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IntegrationJobRefused) return error.refusal;
    throw error;
  }
  return 'ACCEPTED';
}

test('§3: how a landing reaches main is decided at the hand-out and recorded on the job', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('modes');

  // A runner without the capability is handed today's command, and nothing is recorded.
  const old = await h.newWorkspace(ownerId, 'old-runner', { github: true });
  h.github.granted.set(old.installationId, GRANTED);
  const plain = await h.queuedLanding(ownerId, old, 'an old runner lands as before');
  const [legacy] = await h.beat(old.runnerId, false);
  assert.equal(legacy?.jobId, plain.jobId);
  assert.equal(legacy.landVia, undefined);
  assert.equal(legacy.landingRef, undefined);
  assert.equal((await h.job(plain.jobId)).landVia, null);

  // The capability, and an installation that has not accepted the new permissions (§3 rule 3): PUSH.
  const pending = await h.newWorkspace(ownerId, 'pending-installation', { github: true });
  const waiting = await h.queuedLanding(ownerId, pending, 'the installation has not accepted yet');
  const [pushed] = await h.beat(pending.runnerId, true);
  assert.equal(pushed?.landVia, 'PUSH');
  assert.equal(pushed.landingRef, undefined);
  assert.equal((await h.job(waiting.jobId)).landVia, 'PUSH');

  // An Orbit branch (rule 1): PUSH, whatever the installation granted.
  const lined = await h.newWorkspace(ownerId, 'project-line', { github: true });
  h.github.granted.set(lined.installationId, GRANTED);
  await h.queuedLanding(ownerId, lined, 'a task onto its project branch', 'PROJECT_BRANCH');
  const [onLine] = await h.beat(lined.runnerId, true);
  assert.equal(onLine?.landVia, 'PUSH');
  assert.match(onLine.targetRef, /^refs\/heads\/project\//);

  // A workspace not cloned from GitHub (rule 2): PUSH.
  const local = await h.newWorkspace(ownerId, 'not-from-github', { github: false });
  await h.queuedLanding(ownerId, local, 'a machine checkout');
  const [machine] = await h.beat(local.runnerId, true);
  assert.equal(machine?.landVia, 'PUSH');

  // A GitHub workspace whose installation granted them (rule 5): PULL_REQUEST, named after the landing session.
  const cloud = await h.newWorkspace(ownerId, 'orbit-cloud', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const landing = await h.queuedLanding(ownerId, cloud, 'a protected main');
  const [command] = await h.beat(cloud.runnerId, true);
  const landingSession = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: landing.landingId } });
  assert.equal(command?.landVia, 'PULL_REQUEST');
  assert.equal(command.landingRef, `refs/heads/orbit/land/${landingSession.sessionId}`);
  assert.equal(command.pullRequestOpen, undefined);
  const recorded = await h.job(landing.jobId);
  assert.equal(recorded.landVia, 'PULL_REQUEST');
  assert.equal(recorded.landingRef, command.landingRef);

  // A subject whose pull request is open finishes through it (§3): the next attempt is handed the landing branch's
  // head for its lease and told to push only the landing branch — even once the installation's grant no longer reads.
  const reopened = await h.newWorkspace(ownerId, 'open-pull-request', { github: true });
  const again = await h.queuedLanding(ownerId, reopened, 'its pull request is already open');
  const subject = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: again.landingId } });
  const openHead = SHA('the head Orbit pushed before');
  await h.prisma.githubPullRequest.create({
    data: {
      ownerId, workspaceId: reopened.workspaceId, githubRepoId: BigInt(reopened.repoId), installationId: BigInt(reopened.installationId),
      landingId: subject.id, baseRef: 'refs/heads/main', headRef: `refs/heads/orbit/land/${subject.sessionId}`, state: 'OPEN',
      number: 77, url: `https://github.com/${reopened.fullName}/pull/77`, headSha: openHead, baseSha: SHA('old base'),
    },
  });
  const [finishing] = await h.beat(reopened.runnerId, true);
  assert.equal(finishing?.landVia, 'PULL_REQUEST');
  assert.equal(finishing.pullRequestOpen, true);
  assert.equal(finishing.landingRefSha, openHead);
  assert.equal(finishing.landingRef, `refs/heads/orbit/land/${subject.sessionId}`);
});

test('J-T14, the door and J-T15: a protected main lands through a pull request', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('lands');
  const cloud = await h.newWorkspace(ownerId, 'protected-main', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const landing = await h.queuedLanding(ownerId, cloud, 'Add the release notes page');
  const [command] = await h.beat(cloud.runnerId, true);
  assert.equal(command?.landVia, 'PULL_REQUEST');
  const head = SHA('tested-head');
  const tree = SHA('tested-tree');

  // J-T14.
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body: h.pullRequestResult(command, head, tree),
  });
  assert.equal(answered.answer.state, 'PULL_REQUEST');
  assert.equal(answered.after?.pullRequestIds?.length, 1);
  const waitingJob = await h.job(command.jobId);
  assert.equal(waitingJob.state, 'PULL_REQUEST');
  assert.equal(waitingJob.claimLeaseOwner, null, 'no runner holds a landing that waits on GitHub');
  assert.equal(waitingJob.testedSha, head);
  assert.equal(waitingJob.finishedAt, null);
  let pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: waitingJob.pullRequestId! } });
  assert.equal(pr.state, 'OPENING');
  assert.equal(pr.headSha, head);
  assert.equal(pr.testedTreeSha, tree);
  assert.equal(pr.headRef, command.landingRef);
  assert.equal(pr.baseRef, 'refs/heads/main');
  assert.equal(pr.workspaceId, cloud.workspaceId);
  assert.match(String((pr.refusal as { message?: string }).message), /GH006/);
  const pushedEvent = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: command.jobId, kind: 'PULL_REQUEST' } });
  assert.equal(pushedEvent?.text, `Pushed ${head.slice(0, 7)} for a pull request`);

  // No runner holds it: its late report is a stop signal.
  assert.equal(await refusal(receiveIntegrationJobProgress(h.prisma as never, cloud.runnerId, command.jobId, {
    claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, phase: 'VERIFY',
  }, ownerId)), 'STALE_CLAIM');
  // It is in flight: never timed out, waiting for checks, and the task's branch queues no second landing meanwhile.
  const [inFlight] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(inFlight?.state, 'PULL_REQUEST');
  assert.equal(inFlight.timedOut, false);
  assert.equal(inFlight.blockingReason?.code, 'WAITING_FOR_CHECKS');
  const again = await h.prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, landing.taskId));
  assert.equal(again.enqueued, false, 'one landing in flight for the task\'s branch, a pull request included');

  // The door opens it as the App; GitHub's required checks run: it waits.
  h.github.scenario(cloud.fullName).mergeStateStatus = 'BLOCKED';
  h.github.scenario(cloud.fullName).checks = [
    { name: 'ci / unit', required: true, status: 'IN_PROGRESS', conclusion: null },
    { name: 'ci / lint', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'labeler', required: false, status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  await h.door.advance(answered.after!.pullRequestIds!);
  const opened = h.github.calls.find((call) => call.method === 'POST' && call.path === `/repos/${cloud.fullName}/pulls`);
  assert.ok(opened, 'the pull request was opened');
  assert.equal((opened.body as { head: string }).head, command.landingRef!.replace('refs/heads/', ''));
  assert.equal((opened.body as { base: string }).base, 'main');
  assert.equal((opened.body as { title: string }).title, 'Add the release notes page');
  assert.match((opened.body as { body: string }).body, /Orbit updates this branch/);
  // This landing ran nothing again (M5): the body says what the candidate's check ran on the same tree.
  assert.match((opened.body as { body: string }).body, /Before the push Orbit ran .+, and it passed\./);
  assert.doesNotMatch((opened.body as { body: string }).body, /ran no checks/);
  assert.doesNotMatch((opened.body as { body: string }).body, /Push as me/, 'a pull request that is no fallback quotes no refusal');
  pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.equal(pr.state, 'OPEN');
  assert.equal(pr.number, h.github.pulls[0]!.number);
  assert.equal(pr.condition, 'CHECKS_PENDING');
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'nothing was merged while the required checks ran');
  const [checking] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(checking?.pullRequest?.number, pr.number);
  assert.deepEqual(checking.pullRequest?.checks, { passed: 1, required: 2, failed: [] });
  // The landing's own view, which a client opens from the landing card, carries the pull request and its checks (§8).
  const landingSession = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: landing.landingId } });
  const view = await readLandingView(h.prisma as never, ownerId, landingSession.sessionId);
  assert.ok(view, 'the landing has its view');
  assert.equal(view.pullRequest?.number, pr.number);
  assert.equal(view.pullRequest?.state, 'OPEN');
  assert.equal(view.pullRequest?.condition, 'CHECKS_PENDING');
  assert.deepEqual(view.pullRequest?.checks, { passed: 1, required: 2, failed: [] });
  assert.match(String(view.pullRequest?.refusal?.message), /GH006/);

  // A review is required: it waits for it.
  h.github.scenario(cloud.fullName).checks = [
    { name: 'ci / unit', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'ci / lint', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  h.github.scenario(cloud.fullName).reviewDecision = 'REVIEW_REQUIRED';
  await h.door.reread(pr.id);
  pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.equal(pr.condition, 'REVIEW_REQUIRED');
  const [reviewing] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(reviewing?.blockingReason?.code, 'WAITING_FOR_REVIEW');
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'nothing was merged while a review was required');

  // Approved and clean, on the base the head was built on: merged with sha = the pushed head, by rebase (a task).
  h.github.scenario(cloud.fullName).reviewDecision = 'APPROVED';
  h.github.scenario(cloud.fullName).mergeStateStatus = 'CLEAN';
  h.github.scenario(cloud.fullName).baseSha = waitingJob.targetShaBefore;
  h.github.scenario(cloud.fullName).mergeTree = () => tree;
  await h.door.reread(pr.id);
  const merge = h.github.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(merge?.body, { sha: head, merge_method: 'rebase' });

  // J-T15: GitHub's merged answer lands the job.
  const landed = await h.job(command.jobId);
  assert.equal(landed.state, 'LANDED');
  assert.equal(landed.landedSha, h.github.pulls[0]!.mergeCommit!.oid);
  assert.equal(landed.landedTreeSha, tree);
  assert.ok(landed.finishedAt);
  pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.equal(pr.state, 'MERGED');
  assert.equal(pr.mergedSha, landed.landedSha);
  assert.equal(pr.mergeMethod, 'rebase');
  const [receipt] = await h.prisma.sessionMergeReceipt.findMany({ where: { id: { in: landed.receiptIds } } });
  assert.equal(receipt?.recordedBy, 'SERVER');
  assert.equal(receipt.result, 'MERGED');
  assert.equal(receipt.targetShaAfter, landed.landedSha);
  assert.equal((receipt.detail as { pullRequest?: { number?: number } }).pullRequest?.number, pr.number);
  assert.deepEqual(h.github.deleted, [command.landingRef!.replace('refs/heads/', '')]);
  const settled = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: landing.landingId } });
  assert.equal(settled.settledAs, 'LANDED');
  // And the task reads as landed: on main, by the receipt the server wrote.
  const taskRow = (await readTaskIntegrationViews(h.prisma as never, ownerId, landing.projectId, [landing.taskId])).get(landing.taskId);
  assert.ok(taskRow, 'the task has its row');
  assert.equal(taskRow.state, 'ON_UPSTREAM');
  const merged = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: command.jobId, key: 'pull-request:merged' } });
  assert.match(String(merged?.text), new RegExp(`^Merged pull request #${pr.number}`));
  const [after] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(after, undefined, 'a landed job is not in flight');

  // A PULL_REQUEST from an attempt handed out PUSH is refused.
  const pushOnly = await h.newWorkspace(ownerId, 'push-only', { github: true });
  await h.queuedLanding(ownerId, pushOnly, 'handed out PUSH');
  const [plain] = await h.beat(pushOnly.runnerId, true);
  assert.equal(plain?.landVia, 'PUSH');
  assert.equal(await refusal(applyIntegrationJobResult(h.prisma as never, {
    jobId: plain.jobId, runnerId: pushOnly.runnerId, ownerId,
    body: { ...h.pullRequestResult({ ...plain, landingRef: 'refs/heads/orbit/land/x' }, SHA('x'), SHA('y')) },
  })), 'INVALID_RESULT');
});

test('§4.4: a refused merge method is replaced, and a merge onto a moved main is recorded with its item', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('methods');
  const cloud = await h.newWorkspace(ownerId, 'linear-history', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const landing = await h.queuedLanding(ownerId, cloud, 'Fix the flaky export');
  const [command] = await h.beat(cloud.runnerId, true);
  const head = SHA('mismatch-head');
  const tested = SHA('mismatch-tested-tree');
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body: h.pullRequestResult(command, head, tested),
  });
  const scenario = h.github.scenario(cloud.fullName);
  scenario.mergeStateStatus = 'CLEAN';
  scenario.baseSha = (await h.job(command.jobId)).targetShaBefore;
  // The repository's settings refuse rebase merges: the door takes the next method it allows.
  scenario.refuses = ['rebase'];
  // And main moved in the second between Orbit's read and GitHub's merge: the merge's tree is not the tested tree.
  const moved = SHA('the tree main moved to');
  scenario.mergeTree = () => moved;
  await h.door.advance(answered.after!.pullRequestIds!);
  const merges = h.github.calls.filter((call) => call.method === 'PUT').map((call) => (call.body as { merge_method: string }).merge_method);
  assert.deepEqual(merges, ['rebase', 'merge']);
  const landed = await h.job(command.jobId);
  assert.equal(landed.state, 'LANDED', 'the work is on main: the job is LANDED with the real tree');
  assert.equal(landed.landedTreeSha, moved);
  assert.equal(landed.testedTreeSha, tested);
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: landed.pullRequestId! } });
  assert.equal(pr.mergeMethod, 'merge');
  const item = await h.prisma.projectOpenItem.findFirst({ where: { projectId: landing.projectId, integrationJobId: command.jobId } });
  assert.equal(item?.kind, 'INTEGRATION_ERROR');
  assert.equal(item.state, 'OPEN');
  assert.match(item.title, /Run the project's check on main/);
  assert.equal((item.payload as { errorCode?: string }).errorCode, 'LANDED_TREE_MISMATCH');
});

test('J-T18: a stop on a waiting landing ends it, and the door merges no pull request nobody waits on', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('stopped');
  const cloud = await h.newWorkspace(ownerId, 'stopped-landing', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const landing = await h.queuedLanding(ownerId, cloud, 'Reworked after review');
  const [command] = await h.beat(cloud.runnerId, true);
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body: h.pullRequestResult(command, SHA('stop-head'), SHA('stop-tree')),
  });
  h.github.scenario(cloud.fullName).mergeStateStatus = 'BLOCKED';
  await h.door.advance(answered.after!.pullRequestIds!);
  const stopped = await h.prisma.$transaction((tx) => stopInFlightJob(tx, {
    projectId: landing.projectId, jobId: command.jobId, now: new Date(), cause: 'TASK_REOPEN',
  }));
  assert.equal(stopped.outcome, 'CANCELLED');
  assert.equal((await h.job(command.jobId)).state, 'CANCELLED');
  const pr = await h.prisma.githubPullRequest.findFirstOrThrow({ where: { landingId: { not: null }, headSha: SHA('stop-head') } });
  assert.equal(pr.state, 'OPEN', 'the pull request stays open for the next attempt');
  // GitHub would merge it now; nobody waits on it, so the door does not.
  h.github.scenario(cloud.fullName).mergeStateStatus = 'CLEAN';
  h.github.scenario(cloud.fullName).baseSha = pr.baseSha;
  await h.door.reread(pr.id);
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'));
});

test('§4.6: a session\'s Merge lands through its pull request', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('session');
  const cloud = await h.newWorkspace(ownerId, 'session-merge', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const sessionId = randomUUID();
  await h.prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId: cloud.workspaceId, assignedRunnerId: cloud.runnerId,
      title: 'Tidy the settings page', prompt: 'tidy it', branch: `orbit/tidy-${sessionId.slice(0, 6)}`, isolationStatus: 'worktree',
      status: RunStatus.SUCCEEDED, finishedAt: new Date(Date.now() - 60_000),
      mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeTarget: 'main',
    },
  });

  // The command is handed the session's landing branch, for a runner that declared the capability.
  const [withMode] = await h.door.withMergeLanding([{
    sessionId, operationId: randomUUID(), leaseOwner: 'x', branch: 'orbit/tidy', workDir: '/srv/session-merge', targetBranch: 'main',
  }], true);
  assert.equal(withMode?.landVia, 'PULL_REQUEST');
  assert.equal(withMode.landingRef, `refs/heads/orbit/land/${sessionId}`);
  const [withoutMode] = await h.door.withMergeLanding([{
    sessionId, operationId: randomUUID(), leaseOwner: 'x', branch: 'orbit/tidy', workDir: '/srv/session-merge', targetBranch: 'main',
  }], false);
  assert.equal(withoutMode?.landVia, undefined, 'a runner without the capability is handed today\'s command');
  void SESSION_MERGE_PULL_REQUEST_CAPABILITY;

  // The runner's `pull_request` result leaves the Merge waiting: the merge result's own write, under the session lock.
  const head = SHA('session-head');
  const base = SHA('session-base');
  h.github.pushed.set(`orbit/land/${sessionId}`, head);
  const current = { ownerId, taskId: null, mergeCheckpointId: null, mergeRecoveryAction: null };
  const dto = {
    operationId: randomUUID(), leaseOwner: 'x', status: 'pull_request' as const, sourceSha: SHA('session-source'),
    pushedSha: head, rebaseBaseSha: base, targetBranch: 'main',
    pushRefusal: 'GH013: Repository rule violations found for refs/heads/main. Changes must be made through a pull request.',
  };
  const within = <T>(write: (tx: never) => Promise<T>) => h.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
    return write(tx as never);
  });
  // A result that names no claim, or no pushed commit, is refused and writes nothing.
  await assert.rejects(within((tx) => recordSessionMergePullRequest(tx, { sessionId, current, dto, modern: false })),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 400);
  await assert.rejects(within((tx) => recordSessionMergePullRequest(tx, { sessionId, current, dto: { ...dto, pushedSha: 'nope' }, modern: true })),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 400);
  const prId = await within((tx) => recordSessionMergePullRequest(tx, { sessionId, current, dto, modern: true }));
  const waiting = await h.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(waiting.mergeStatus, 'pull_request');
  assert.equal(waiting.mergePullRequestId, prId);
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } });
  assert.equal(pr.state, 'OPENING');
  assert.equal(pr.headRef, `refs/heads/orbit/land/${sessionId}`);
  assert.equal(pr.baseRef, 'refs/heads/main');
  assert.equal(pr.headSha, head);
  assert.equal(pr.sourceSha, SHA('session-source'));
  assert.match(String((pr.refusal as { message?: string }).message), /GH013/);
  assert.equal(await h.prisma.sessionMergeReceipt.count({ where: { sessionId } }), 0, 'nothing has landed yet');
  // A second report (Merge pressed again) updates the same pull request with the new head.
  const head2 = SHA('session-head-2');
  h.github.pushed.set(`orbit/land/${sessionId}`, head2);
  await h.prisma.session.update({ where: { id: sessionId }, data: { mergeStatus: 'pending' } });
  assert.equal(await within((tx) => recordSessionMergePullRequest(tx, {
    sessionId, current, dto: { ...dto, pushedSha: head2 }, modern: true,
  })), prId);
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } })).headSha, head2);
  const scenario = h.github.scenario(cloud.fullName);
  scenario.mergeStateStatus = 'CLEAN';
  scenario.baseSha = base;
  scenario.mergeTree = () => SHA('session-tree');
  await h.door.advance([prId]);
  const opened = h.github.calls.find((call) => call.method === 'POST' && call.path === `/repos/${cloud.fullName}/pulls`);
  assert.equal((opened?.body as { title?: string })?.title, 'Tidy the settings page');
  const session = await h.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(session.mergeStatus, 'merged');
  assert.equal(session.branchMerged, true);
  const pull = h.github.pulls.find((row) => row.head === `orbit/land/${sessionId}`)!;
  const receipt = await h.prisma.sessionMergeReceipt.findFirstOrThrow({ where: { sessionId } });
  assert.equal(receipt.recordedBy, 'SERVER');
  assert.equal(receipt.result, 'MERGED');
  assert.equal(receipt.targetShaAfter, pull.mergeCommit!.oid);
  assert.equal(receipt.sourceSha, SHA('session-source'));
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } })).state, 'MERGED');
  // A merge PUT carried the head Orbit pushed last.
  assert.deepEqual(h.github.calls.find((call) => call.method === 'PUT')?.body, { sha: head2, merge_method: 'rebase' });
});

test('§4.7: the webhook is checked, de-duplicated and read again; the re-read keeps its cadence', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('webhook');
  const cloud = await h.newWorkspace(ownerId, 'webhook-repo', { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  await h.queuedLanding(ownerId, cloud, 'Webhook landing');
  const [command] = await h.beat(cloud.runnerId, true);
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body: h.pullRequestResult(command, SHA('hook-head'), SHA('hook-tree')),
  });
  h.github.scenario(cloud.fullName).mergeStateStatus = 'BLOCKED';
  await h.door.advance(answered.after!.pullRequestIds!);
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: answered.after!.pullRequestIds![0] } });

  const sign = (body: Buffer, secret = h.webhookSecret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const delivery = (payload: unknown) => Buffer.from(JSON.stringify(payload));
  const body = delivery({ action: 'completed', installation: { id: cloud.installationId }, repository: { id: cloud.repoId },
    check_suite: { head_sha: SHA('hook-head'), pull_requests: [{ number: pr.number }] } });
  const id = `delivery-${randomUUID()}`;
  // A signature that is not the saved secret's is refused, and nothing is stored.
  await assert.rejects(h.webhooks.receive({ deliveryId: id, event: 'check_suite', signature: sign(body, 'not-the-secret'), rawBody: body }),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 401);
  assert.equal(await h.prisma.githubWebhookDelivery.count({ where: { id } }), 0);
  // Signed: stored, and about this pull request.
  const first = await h.webhooks.receive({ deliveryId: id, event: 'check_suite', signature: sign(body), rawBody: body });
  assert.deepEqual(first, { outcome: 'ACCEPTED', reread: [pr.id] });
  // GitHub's redelivery of the same id is a no-op.
  const second = await h.webhooks.receive({ deliveryId: id, event: 'check_suite', signature: sign(body), rawBody: body });
  assert.deepEqual(second, { outcome: 'DUPLICATE', reread: [] });
  // A repository no workspace was cloned from is dropped.
  const stranger = delivery({ action: 'opened', installation: { id: 1 }, repository: { id: 1 }, pull_request: { number: 1 } });
  const dropped = await h.webhooks.receive({ deliveryId: `delivery-${randomUUID()}`, event: 'pull_request', signature: sign(stranger), rawBody: stranger });
  assert.deepEqual(dropped, { outcome: 'DROPPED', reread: [] });
  // After the 202, the delivery's pull request is read again from GitHub, and the delivery marked applied.
  const reads = () => h.github.calls.filter((call) => call.path === '/graphql').length;
  const before = reads();
  await h.webhooks.applyAfterResponse(id, first.reread);
  assert.equal(reads(), before + 1);
  assert.ok((await h.prisma.githubWebhookDelivery.findUniqueOrThrow({ where: { id } })).appliedAt);

  // The re-read: with deliveries arriving it reads a pull request unread for ten minutes, not one read five minutes ago.
  const now = new Date();
  await h.prisma.githubPullRequest.update({ where: { id: pr.id }, data: { observedAt: new Date(now.getTime() - 5 * 60_000) } });
  await h.prisma.githubWebhookDelivery.update({ where: { id }, data: { receivedAt: new Date(now.getTime() - 60_000) } });
  const busy = reads();
  await h.door.tick(now);
  assert.equal(reads(), busy, `read before ${REREAD_WITH_DELIVERIES_MS / 60_000} minutes while deliveries arrive`);
  await h.door.tick(new Date(now.getTime() + REREAD_WITH_DELIVERIES_MS));
  assert.equal(reads(), busy + 1);
  // With no delivery in the last hour, every minute.
  await h.prisma.githubWebhookDelivery.updateMany({ data: { receivedAt: new Date(now.getTime() - 2 * 3_600_000) } });
  await h.prisma.githubPullRequest.update({ where: { id: pr.id }, data: { observedAt: new Date(now.getTime() - REREAD_WITHOUT_DELIVERIES_MS - 1000) } });
  const quiet = reads();
  await h.door.tick(now);
  assert.equal(reads(), quiet + 1);
});

// ── Push as me (docs/design/protected-branch-landing.md §3 rule 4, §5) ─────────────────────────────────────────────
//
//   (10) §3 rule 4 at the hand-out: PUSH_AS_ME only for a workspace whose owner chose it, with a live GitHub
//        connection, to a runner that declared push-as-me/v1, on a v2 claim; any one missing lands PULL_REQUEST.
//   (11) §5.2's credential door: refused before the push boundary, for another lease, another path and a landing not
//        handed out PUSH_AS_ME; answered once at the boundary with the owner's token; a second request refused and
//        announced. The LANDED result says pushed as the owner on its receipts, with GitHub's bypassed rules, only
//        when the door answered for that claim.
//   (12) A Push as me push GitHub refused lands through a pull request whose refusal says so, and the workspace keeps
//        the refusal (announced the first time) until a Push as me landing is accepted.
//   (13) A session's Merge: PUSH_AS_ME with the capability and a live connection, its token once per operation, and a
//        refused one's pull request labelled PUSH_AS_ME.
//   (14) The setting: only a workspace cloned from GitHub takes it, PUSH_AS_ME only with a live connection, only from
//        the owner signed in, and the read carries the landing block.

const OWNER_TOKEN = `ghu_${'o'.repeat(36)}`;

async function connectGithub(h: Awaited<ReturnType<typeof harness>>, ownerId: string, options: { live: boolean } = { live: true }) {
  const at = options.live ? Date.now() + 8 * 3_600_000 : Date.now() - 1_000;
  await h.prisma.githubConnection.create({
    data: {
      ownerId, githubUserId: BigInt(90_000_000 + Math.floor(Math.random() * 9_000_000)), login: 'owner-login',
      accessTokenEnc: encryptSecret(OWNER_TOKEN), refreshTokenEnc: encryptSecret(`ghr_${'r'.repeat(36)}`),
      accessExpiresAt: new Date(at), refreshExpiresAt: new Date(options.live ? Date.now() + 180 * 86_400_000 : Date.now() - 1_000),
    },
  });
}

/** One heartbeat of a v2 runner process, with or without push-as-me/v1. */
function beatV2(h: Awaited<ReturnType<typeof harness>>, runnerId: string, pushAsMe: boolean): Promise<IntegrationJobCommand[]> {
  return h.relay.dispatch({
    runnerId, leaseOwner: randomUUID(), draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2, INTEGRATION_PULL_REQUEST_CAPABILITY, ...(pushAsMe ? [PUSH_AS_ME_CAPABILITY] : [])],
  });
}

function pushAsMeDoor(h: Awaited<ReturnType<typeof harness>>, fullName: string) {
  const config = new GithubAppConfigService(h.prisma as never, h.client);
  const connections = new GithubConnectionService(h.prisma as never, config, h.client);
  const alerts: Array<{ ownerId: string; title: string; message: string }> = [];
  const push = { notifyOwner: async (ownerId: string, input: { title: string; message: string }) => { alerts.push({ ownerId, ...input }); return { delivered: true, devices: 1 }; } };
  // The owner's sight of the repository is GitHub's answer to the owner's token; the fake answers it by name.
  const workspaces = { repositoryFullName: async () => fullName };
  return { service: new PushAsMeService(h.prisma as never, workspaces as never, connections, push as never), alerts };
}

async function refusedWith(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string; message?: string } | string | undefined;
    if (response && typeof response === 'object') return `${response.code}: ${response.message}`;
    return String((error as Error).message);
  }
  return 'ANSWERED';
}

test('(10) §3 rule 4: Push as me is handed out only where it can be carried', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('push-as-me-modes');
  await connectGithub(h, ownerId);
  const chosen = await h.newWorkspace(ownerId, 'chose-push-as-me', { github: true });
  h.github.granted.set(chosen.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: chosen.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });

  // A runner without push-as-me/v1: a pull request landing, as the default.
  const first = await h.queuedLanding(ownerId, chosen, 'no capability');
  const [withoutCapability] = await beatV2(h, chosen.runnerId, false);
  assert.equal(withoutCapability?.jobId, first.jobId);
  assert.equal(withoutCapability.landVia, 'PULL_REQUEST');
  await h.prisma.projectIntegrationJob.update({ where: { id: first.jobId }, data: { state: 'CANCELLED', finishedAt: new Date() } });

  // A legacy claim (no v2 push boundary to gate the token on): PULL_REQUEST.
  const second = await h.queuedLanding(ownerId, chosen, 'a legacy claim');
  const [legacy] = await h.relay.dispatch({
    runnerId: chosen.runnerId, leaseOwner: randomUUID(), draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PULL_REQUEST_CAPABILITY, PUSH_AS_ME_CAPABILITY],
  });
  assert.equal(legacy?.jobId, second.jobId);
  assert.equal(legacy.landVia, 'PULL_REQUEST');
  await h.prisma.projectIntegrationJob.update({ where: { id: second.jobId }, data: { state: 'CANCELLED', finishedAt: new Date() } });

  // Everything holds: PUSH_AS_ME, with the landing branch to fall back to, recorded on the job.
  const third = await h.queuedLanding(ownerId, chosen, 'push as me');
  const [asMe] = await beatV2(h, chosen.runnerId, true);
  assert.equal(asMe?.jobId, third.jobId);
  assert.equal(asMe.landVia, 'PUSH_AS_ME');
  assert.match(asMe.landingRef ?? '', /^refs\/heads\/orbit\/land\//);
  assert.equal((await h.job(third.jobId)).landVia, 'PUSH_AS_ME');
  assert.equal(asMe.reportBeforePush, true);

  // The owner's connection is no longer one GitHub takes: PULL_REQUEST.
  const other = await h.newOwner('push-as-me-disconnected');
  await connectGithub(h, other, { live: false });
  const stale = await h.newWorkspace(other, 'stale-connection', { github: true });
  h.github.granted.set(stale.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: stale.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  await h.queuedLanding(other, stale, 'a spent connection');
  const [spent] = await beatV2(h, stale.runnerId, true);
  assert.equal(spent?.landVia, 'PULL_REQUEST');

  // The setting off: PULL_REQUEST.
  const off = await h.newWorkspace(ownerId, 'push-as-me-off', { github: true });
  h.github.granted.set(off.installationId, GRANTED);
  await h.queuedLanding(ownerId, off, 'the default');
  const [byDefault] = await beatV2(h, off.runnerId, true);
  assert.equal(byDefault?.landVia, 'PULL_REQUEST');
});

test('(11) §5.2: the owner\'s token is answered once, at the push boundary, and the landing says it went as the owner', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('push-as-me-door');
  await connectGithub(h, ownerId);
  const ws = await h.newWorkspace(ownerId, 'push-as-me-door', { github: true });
  h.github.granted.set(ws.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { landingMode: 'PUSH_AS_ME', pushAsMeRefusal: { at: new Date().toISOString(), branch: 'main', message: 'an older refusal' } } });
  const landing = await h.queuedLanding(ownerId, ws, 'Land as the owner');
  const [command] = await beatV2(h, ws.runnerId, true);
  assert.equal(command?.landVia, 'PUSH_AS_ME');
  const { service, alerts } = pushAsMeDoor(h, ws.fullName);
  const runner = { id: ws.runnerId, ownerId };
  const ask = (overrides: Record<string, unknown> = {}) => service.ownerCredential(runner, {
    workspaceId: ws.workspaceId, host: 'github.com', path: `${ws.fullName}.git`,
    jobId: command.jobId, claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...overrides,
  });

  // Before the synchronous PUSH report: refused.
  assert.match(await refusedWith(ask()), /^PUSH_AS_ME_REFUSED: That landing has not reached its push yet/);
  await receiveIntegrationJobProgress(h.prisma as never, ws.runnerId, command.jobId, {
    claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, phase: 'PUSH',
    testedSha: SHA('tested-Land as the owner'), testedTreeSha: SHA('tested-tree-Land as the owner'), sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP,
  }, ownerId);
  // Another lease, another repository, another runner, another host: refused, and none of them spends the answer.
  assert.match(await refusedWith(ask({ leaseOwner: randomUUID() })), /^PUSH_AS_ME_REFUSED: This runner does not hold/);
  assert.match(await refusedWith(ask({ claimGeneration: String(BigInt(command.claimGeneration) + 1n) })), /^PUSH_AS_ME_REFUSED: This runner does not hold/);
  assert.match(await refusedWith(ask({ path: 'owner/another-repository' })), /^PUSH_AS_ME_REFUSED: That path is not this workspace's repository/);
  assert.match(await refusedWith(ask({ host: 'gitlab.com' })), /^PUSH_AS_ME_REFUSED/);
  assert.match(await refusedWith(service.ownerCredential({ id: randomUUID(), ownerId }, {
    workspaceId: ws.workspaceId, host: 'github.com', path: ws.fullName,
    jobId: command.jobId, claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
  })), /^WORKSPACE_NOT_FOUND/);
  assert.equal((await h.job(command.jobId)).ownerTokenGeneration, null, 'no refused request spent the answer');

  // At the boundary: the owner's own token, once.
  const answer = await ask();
  assert.equal(answer.password, OWNER_TOKEN);
  assert.ok(Date.parse(answer.expiresAt) > Date.now() + 15 * 60_000);
  assert.equal((await h.job(command.jobId)).ownerTokenGeneration, BigInt(command.claimGeneration));
  // A second request for the same claim: refused, and the owner is told.
  assert.match(await refusedWith(ask()), /^PUSH_AS_ME_ALREADY_ANSWERED/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.title, SECOND_REQUEST_ALERT);

  // GitHub accepted the push, past main's rules: LANDED, and the receipts say it went as the owner.
  const result = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: ws.runnerId, ownerId,
    body: {
      claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'LANDED', phase: 'VERIFY',
      sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: SHA('tested-Land as the owner'), testedTreeSha: SHA('tested-tree-Land as the owner'), landedSha: SHA('tested-Land as the owner'), landedTreeSha: SHA('tested-tree-Land as the owner'),
      aheadOfUpstream: 1, checks: [],
      pushedAs: 'OWNER', bypassedRules: ['Changes must be made through a pull request.', 'Required status check "check" is expected.'],
    },
  });
  assert.equal(result.answer.state, 'LANDED');
  const receipts = await h.prisma.sessionMergeReceipt.findMany({ where: { ownerId, detail: { path: ['integrationJobId'], equals: command.jobId } } });
  assert.ok(receipts.length > 0, 'the landing wrote its receipts');
  for (const receipt of receipts) {
    const detail = receipt.detail as { pushedAs?: string; bypassedRules?: string[] };
    assert.equal(receipt.recordedBy, 'RUNNER');
    assert.equal(detail.pushedAs, 'OWNER');
    assert.deepEqual(detail.bypassedRules, ['Changes must be made through a pull request.', 'Required status check "check" is expected.']);
  }
  await service.afterJobResult(command.jobId);
  assert.equal((await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).pushAsMeRefusal, null,
    'an accepted Push as me clears the last refusal');
  void landing;

  // A runner's word alone is not enough: a landing whose token was never answered records no owner push.
  const plainWs = await h.newWorkspace(ownerId, 'push-as-me-unasked', { github: true });
  h.github.granted.set(plainWs.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: plainWs.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  await h.queuedLanding(ownerId, plainWs, 'Never asked for the token');
  const [unasked] = await beatV2(h, plainWs.runnerId, true);
  await applyIntegrationJobResult(h.prisma as never, {
    jobId: unasked!.jobId, runnerId: plainWs.runnerId, ownerId,
    body: {
      claimGeneration: unasked!.claimGeneration, leaseOwner: unasked!.leaseOwner, state: 'LANDED', phase: 'VERIFY',
      sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: SHA('tested-Never asked for the token'), testedTreeSha: SHA('tested-tree-Never asked for the token'), landedSha: SHA('tested-Never asked for the token'), landedTreeSha: SHA('tested-tree-Never asked for the token'),
      aheadOfUpstream: 1, checks: [], pushedAs: 'OWNER', bypassedRules: ['x'],
    },
  });
  const unaskedReceipts = await h.prisma.sessionMergeReceipt.findMany({ where: { ownerId, detail: { path: ['integrationJobId'], equals: unasked!.jobId } } });
  assert.ok(unaskedReceipts.length > 0);
  assert.ok(unaskedReceipts.every((receipt) => (receipt.detail as { pushedAs?: string }).pushedAs === undefined));

  // A landing handed out PULL_REQUEST is never answered the owner's token.
  const prWs = await h.newWorkspace(ownerId, 'pull-request-only', { github: true });
  h.github.granted.set(prWs.installationId, GRANTED);
  await h.queuedLanding(ownerId, prWs, 'Default mode');
  const [prCommand] = await beatV2(h, prWs.runnerId, true);
  assert.equal(prCommand?.landVia, 'PULL_REQUEST');
  await receiveIntegrationJobProgress(h.prisma as never, prWs.runnerId, prCommand!.jobId, {
    claimGeneration: prCommand!.claimGeneration, leaseOwner: prCommand!.leaseOwner, phase: 'PUSH',
  }, ownerId);
  const prDoor = pushAsMeDoor(h, prWs.fullName);
  assert.match(await refusedWith(prDoor.service.ownerCredential({ id: prWs.runnerId, ownerId }, {
    workspaceId: prWs.workspaceId, host: 'github.com', path: prWs.fullName,
    jobId: prCommand!.jobId, claimGeneration: prCommand!.claimGeneration, leaseOwner: prCommand!.leaseOwner,
  })), /^PUSH_AS_ME_REFUSED: That landing was not handed out to push as you/);
});

test('(12) a refused Push as me lands through a pull request and the workspace says why', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('push-as-me-refused');
  await connectGithub(h, ownerId);
  const ws = await h.newWorkspace(ownerId, 'enforce-admins', { github: true });
  h.github.granted.set(ws.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  await h.queuedLanding(ownerId, ws, 'Refused for the owner too');
  const [command] = await beatV2(h, ws.runnerId, true);
  assert.equal(command?.landVia, 'PUSH_AS_ME');
  const refusedWords = 'GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.';
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: ws.runnerId, ownerId,
    body: { ...h.pullRequestResult(command, SHA('refused-head'), SHA('refused-tree')), pushRefusal: refusedWords },
  });
  assert.equal(answered.answer.state, 'PULL_REQUEST');
  const waiting = await h.job(command.jobId);
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: waiting.pullRequestId! } });
  assert.deepEqual({ via: (pr.refusal as { via: string }).via, message: (pr.refusal as { message: string }).message }, { via: 'PUSH_AS_ME', message: refusedWords });
  const { service, alerts } = pushAsMeDoor(h, ws.fullName);
  await service.afterJobResult(command.jobId);
  const recorded = (await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).pushAsMeRefusal as { branch: string; message: string };
  assert.equal(recorded.branch, 'main');
  assert.equal(recorded.message, refusedWords);
  assert.equal(alerts.length, 1, 'the first refusal on a workspace is announced');
  assert.equal(alerts[0]!.title, FIRST_REFUSAL_ALERT);
  await service.afterJobResult(command.jobId);
  assert.equal(alerts.length, 1, 'and only the first');
  // The fallback pull request's own body says why, in GitHub's words (§5.5).
  h.github.scenario(ws.fullName).mergeStateStatus = 'BLOCKED';
  await h.door.advance(answered.after!.pullRequestIds!);
  const opened = h.github.calls.find((call) => call.method === 'POST' && call.path === `/repos/${ws.fullName}/pulls`);
  const body = (opened?.body as { body: string } | undefined)?.body ?? '';
  assert.match(body, /because Push as me could not push main directly\./);
  assert.ok(body.includes(`GitHub refused the push to main with the owner's account:\n\n\`\`\`text\n${refusedWords}\n\`\`\``), body);
  // The landing view quotes it as the owner's refused push (§5.5).
  const [inFlight] = await readInFlightJobs(h.prisma as never, (await h.job(command.jobId)).projectId, command.jobId);
  assert.equal(inFlight?.pullRequest?.refusal?.via, 'PUSH_AS_ME');
});

test('(13) a session\'s Merge pushes as the owner once per operation', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('push-as-me-merge');
  await connectGithub(h, ownerId);
  const ws = await h.newWorkspace(ownerId, 'merge-as-me', { github: true });
  h.github.granted.set(ws.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const leaseOwner = randomUUID();
  await h.prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId: ws.workspaceId, assignedRunnerId: ws.runnerId,
      title: 'Merge as me', prompt: 'merge', branch: `orbit/me-${sessionId.slice(0, 6)}`, isolationStatus: 'worktree',
      status: RunStatus.SUCCEEDED, finishedAt: new Date(Date.now() - 60_000),
      mergeStatus: 'pending', mergeOperationId: operationId, mergeOperationOwner: leaseOwner, mergeTarget: 'main',
    },
  });
  const merge = { sessionId, operationId, leaseOwner, branch: 'orbit/me', workDir: '/srv/merge-as-me', targetBranch: 'main' };
  assert.equal((await h.door.withMergeLanding([merge], true, true))[0]?.landVia, 'PUSH_AS_ME');
  assert.equal((await h.door.withMergeLanding([merge], true, false))[0]?.landVia, 'PULL_REQUEST', 'no push-as-me/v1: the default');

  const { service, alerts } = pushAsMeDoor(h, ws.fullName);
  const ask = (overrides: Record<string, unknown> = {}) => service.ownerCredential({ id: ws.runnerId, ownerId }, {
    workspaceId: ws.workspaceId, host: 'github.com', path: ws.fullName, sessionId, mergeOperationId: operationId, leaseOwner, ...overrides,
  });
  assert.match(await refusedWith(ask({ mergeOperationId: randomUUID() })), /^PUSH_AS_ME_REFUSED: This runner does not hold that Merge/);
  assert.match(await refusedWith(ask({ jobId: randomUUID() })), /^PUSH_AS_ME_REFUSED: A Push as me request names one landing/);
  assert.equal((await ask()).password, OWNER_TOKEN);
  assert.equal((await h.prisma.session.findUniqueOrThrow({ where: { id: sessionId } })).mergeOwnerTokenFor, operationId);
  assert.match(await refusedWith(ask()), /^PUSH_AS_ME_ALREADY_ANSWERED/);
  assert.equal(alerts[0]?.title, SECOND_REQUEST_ALERT);

  // Refused by GitHub: the Merge's pull request is labelled as the owner's refused push, and the workspace keeps it.
  h.github.pushed.set(`orbit/land/${sessionId}`, SHA('merge-head'));
  const dto = {
    operationId, leaseOwner, status: 'pull_request' as const, sourceSha: SHA('merge-source'), pushedSha: SHA('merge-head'),
    rebaseBaseSha: SHA('merge-base'), targetBranch: 'main', landVia: 'PUSH_AS_ME' as const,
    pushRefusal: 'GH013: Repository rule violations found for refs/heads/main.',
  };
  const prId = await h.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
    return recordSessionMergePullRequest(tx as never, {
      sessionId, current: { ownerId, taskId: null, mergeCheckpointId: null, mergeRecoveryAction: null }, dto, modern: true,
    });
  });
  assert.equal(((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } })).refusal as { via: string }).via, 'PUSH_AS_ME');
  await service.afterMergeResult(sessionId, dto);
  assert.match(String(((await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).pushAsMeRefusal as { message: string }).message), /GH013/);
  // Accepted: the refusal is cleared.
  await service.afterMergeResult(sessionId, { ...dto, status: 'merged', pushedAs: 'OWNER' });
  assert.equal((await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).pushAsMeRefusal, null);
});

test('(14) the landing setting: GitHub workspaces only, Push as me needs a live connection, the owner signed in', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('landing-setting');
  const ws = await h.newWorkspace(ownerId, 'landing-setting', { github: true });
  const machine = await h.newWorkspace(ownerId, 'landing-setting-machine', { github: false });
  const workspaces = new WorkspacesService(h.prisma as never);
  const code = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { return ((error as { getResponse?: () => { code?: string } }).getResponse?.())?.code ?? String(error); }
    return 'OK';
  };
  assert.equal(await code(workspaces.update(ownerId, machine.workspaceId, { landingMode: 'PULL_REQUEST' })), 'WORKSPACE_NOT_FROM_GITHUB');
  assert.equal(await code(workspaces.update(ownerId, ws.workspaceId, { landingMode: 'PUSH_AS_ME' })), 'GITHUB_NOT_CONNECTED');
  let read = await workspaces.getWithUsage(ownerId, ws.workspaceId);
  assert.deepEqual(read.landing, { mode: 'PULL_REQUEST', pushAsMe: { available: false, reason: 'GITHUB_NOT_CONNECTED' }, lastRefusal: null });
  assert.deepEqual((await workspaces.getWithUsage(ownerId, machine.workspaceId)).landing,
    { mode: null, pushAsMe: { available: false, reason: 'WORKSPACE_NOT_FROM_GITHUB' }, lastRefusal: null });
  await connectGithub(h, ownerId);
  assert.equal(await code(workspaces.update(ownerId, ws.workspaceId, { landingMode: 'PUSH_AS_ME' })), 'OK');
  read = await workspaces.getWithUsage(ownerId, ws.workspaceId);
  assert.deepEqual(read.landing, { mode: 'PUSH_AS_ME', pushAsMe: { available: true }, lastRefusal: null });
  // Saving another field leaves the setting where it is.
  await workspaces.update(ownerId, ws.workspaceId, { description: 'unrelated' });
  assert.equal((await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).landingMode, 'PUSH_AS_ME');

  // Only a signed-in owner chooses it: a token (a PAT an agent could hold, a terminal) is refused, and so is an agent's
  // MCP write, which names it as a field only the owner sets.
  const controller = new WorkspacesController(workspaces, {} as never);
  for (const credential of [
    { kind: 'PAT', tokenId: 't', scopes: ['workspaces:write'], workspaceIds: [] },
    { kind: 'TERMINAL', terminalId: 't', runnerId: ws.runnerId, machineName: 'm' },
    undefined,
  ]) {
    // The refusal is thrown before the service is reached, so the call itself throws rather than returning a promise.
    assert.equal(await code(Promise.resolve().then(() =>
      controller.update({ userId: ownerId, email: 'x', credential } as never, ws.workspaceId, { landingMode: 'PULL_REQUEST' }))),
    'LANDING_MODE_OWNER_ONLY');
  }
  assert.equal(await code(Promise.resolve().then(() =>
    controller.update({ userId: ownerId, email: 'x', credential: { kind: 'LOGIN' } } as never, ws.workspaceId, { landingMode: 'PULL_REQUEST' }))), 'OK');
  assert.equal((await h.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } })).landingMode, 'PULL_REQUEST');
  assert.throws(() => sanitizeWorkspaceWrite({ landingMode: 'PUSH_AS_ME' }), (error: { getResponse?: () => { code?: string } }) =>
    error.getResponse?.()?.code === 'HUMAN_ONLY_WORKSPACE_FIELD');
});

//   (15) §16 Q1, early revocation: once a Push as me push reports back, the server refreshes the owner's connection
//        (the stored refresh token traded for a new pair, stored) and then revokes the token it handed out, by name,
//        with the App's credential — never the grant. The connection stays live under the new token. A refresh or a
//        revoke GitHub refuses still ends the landing as it ended, is recorded, leaves the connection live, and does
//        not reopen the attempt's one handout. A result reported once more retires nothing twice.

test('(15) §16 Q1: the owner\'s token is retired once the push reports back, and a failure is only recorded', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);

  /** A Push as me landing past its push boundary, the owner's token answered for it. */
  async function answeredLanding(label: string) {
    const ownerId = await h.newOwner(label);
    await connectGithub(h, ownerId);
    const ws = await h.newWorkspace(ownerId, label, { github: true });
    h.github.granted.set(ws.installationId, GRANTED);
    await h.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
    await h.queuedLanding(ownerId, ws, label);
    const [command] = await beatV2(h, ws.runnerId, true);
    assert.equal(command?.landVia, 'PUSH_AS_ME');
    await receiveIntegrationJobProgress(h.prisma as never, ws.runnerId, command.jobId, {
      claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, phase: 'PUSH',
      testedSha: SHA(`tested-${label}`), testedTreeSha: SHA(`tested-tree-${label}`), sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP,
    }, ownerId);
    const door = pushAsMeDoor(h, ws.fullName);
    const logged: string[] = [];
    (door.service as unknown as { log: unknown }).log = { log: (line: string) => logged.push(line), warn: (line: string) => logged.push(`WARN ${line}`) };
    const ask = () => door.service.ownerCredential({ id: ws.runnerId, ownerId }, {
      workspaceId: ws.workspaceId, host: 'github.com', path: ws.fullName,
      jobId: command.jobId, claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
    });
    assert.equal((await ask()).password, OWNER_TOKEN);
    const land = (state: 'LANDED' | 'PULL_REQUEST') => applyIntegrationJobResult(h.prisma as never, {
      jobId: command.jobId, runnerId: ws.runnerId, ownerId,
      body: state === 'LANDED'
        ? {
          claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'LANDED', phase: 'VERIFY',
          sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
          testedSha: SHA(`tested-${label}`), testedTreeSha: SHA(`tested-tree-${label}`),
          landedSha: SHA(`tested-${label}`), landedTreeSha: SHA(`tested-tree-${label}`), aheadOfUpstream: 1, checks: [], pushedAs: 'OWNER',
        }
        : { ...h.pullRequestResult(command, SHA(`tested-${label}`), SHA(`tested-tree-${label}`)), pushRefusal: 'GH006: Protected branch update failed for refs/heads/main.' },
    });
    const connection = () => h.prisma.githubConnection.findUniqueOrThrow({ where: { ownerId } });
    return { ownerId, command, door, logged, ask, land, connection };
  }
  const calls = () => h.github.tokenCalls.splice(0);
  /** A retirement, failed or not, reopens no handout: the token is refused, and the claim keeps its one answer. */
  async function assertNoSecondHandout(landing: Awaited<ReturnType<typeof answeredLanding>>) {
    assert.match(await refusedWith(landing.ask()), /^PUSH_AS_ME_(REFUSED|ALREADY_ANSWERED)/);
    const row = await h.job(landing.command.jobId);
    assert.equal(row.ownerTokenGeneration, BigInt(landing.command.claimGeneration));
  }

  // Accepted: refreshed, then the handed token revoked by name, in that order; the connection lives on, rotated.
  const ok = await answeredLanding('retire-accepted');
  calls();
  assert.equal((await ok.land('LANDED')).answer.state, 'LANDED');
  const retired = await ok.door.service.afterJobResult(ok.command.jobId);
  assert.deepEqual(retired, { refreshed: true, revoked: 1, failure: null });
  const made = calls();
  assert.deepEqual(made.map((call) => call.kind), ['REFRESH', 'REVOKE'], 'the refresh comes first, then the revoke');
  assert.equal((made[0] as { refreshToken: string }).refreshToken, `ghr_${'r'.repeat(36)}`, 'the stored refresh token is traded');
  assert.equal((made[1] as { accessToken: string }).accessToken, OWNER_TOKEN, 'the token handed out is the one revoked');
  assert.equal((made[1] as { basic: string }).basic, `Basic ${Buffer.from('Iv1.prfake:client-secret').toString('base64')}`);
  assert.ok(!h.github.calls.some((call) => /\/grant$/.test(call.path)), 'the grant is never revoked');
  let row = await ok.connection();
  assert.match(decryptSecret(row.accessTokenEnc), /^ghu_rotated/, 'the new token is stored');
  assert.match(decryptSecret(row.refreshTokenEnc), /^ghr_rotated/);
  assert.ok(row.refreshExpiresAt.getTime() > Date.now() + 100 * 86_400_000, 'the connection is live');
  assert.ok(ok.logged.some((line) => line.includes(ok.command.jobId) && line.includes('was retired')));
  // Once: the same result reported again retires nothing more.
  assert.equal(await ok.door.service.afterJobResult(ok.command.jobId), null);
  assert.deepEqual(calls(), []);
  // And no second handout for that claim, whatever happened since: the claim is over, and it still records its one answer.
  await assertNoSecondHandout(ok);

  // A refused push that fell back to a pull request is retired the same way: the token was handed either way.
  const fell = await answeredLanding('retire-refused');
  calls();
  assert.equal((await fell.land('PULL_REQUEST')).answer.state, 'PULL_REQUEST');
  assert.deepEqual(await fell.door.service.afterJobResult(fell.command.jobId), { refreshed: true, revoked: 1, failure: null });
  assert.deepEqual(calls().map((call) => call.kind), ['REFRESH', 'REVOKE']);

  // GitHub refuses the refresh: nothing stored is revoked (the connection would be left with a dead token), the
  // connection is untouched and live, the landing stays LANDED, and the failure is recorded.
  const noRefresh = await answeredLanding('retire-refresh-fails');
  calls();
  h.github.refreshFails = true;
  const before = await noRefresh.connection();
  assert.equal((await noRefresh.land('LANDED')).answer.state, 'LANDED');
  const refreshFailed = await noRefresh.door.service.afterJobResult(noRefresh.command.jobId);
  h.github.refreshFails = false;
  assert.equal(refreshFailed?.refreshed, false);
  assert.equal(refreshFailed?.revoked, 0);
  assert.match(String(refreshFailed?.failure), /^the refresh failed: GitHub answered 400 bad_refresh_token/);
  assert.deepEqual(calls().map((call) => call.kind), ['REFRESH'], 'no revoke without a new token stored');
  row = await noRefresh.connection();
  assert.equal(row.accessTokenEnc, before.accessTokenEnc);
  assert.equal(row.refreshExpiresAt.getTime(), before.refreshExpiresAt.getTime(), 'the connection is not marked dead');
  assert.equal((await h.job(noRefresh.command.jobId)).state, 'LANDED');
  assert.ok(noRefresh.logged.some((line) => line.startsWith('WARN') && line.includes(noRefresh.command.jobId) && line.includes('not fully retired')));
  await assertNoSecondHandout(noRefresh);

  // GitHub refuses the revoke: the new pair is stored and the connection live; the failure is recorded.
  const noRevoke = await answeredLanding('retire-revoke-fails');
  calls();
  h.github.revokeFails = true;
  assert.equal((await noRevoke.land('LANDED')).answer.state, 'LANDED');
  const revokeFailed = await noRevoke.door.service.afterJobResult(noRevoke.command.jobId);
  h.github.revokeFails = false;
  assert.equal(revokeFailed?.refreshed, true);
  assert.equal(revokeFailed?.revoked, 0);
  assert.match(String(revokeFailed?.failure), /^a revoke failed: GitHub answered 500/);
  assert.deepEqual(calls().map((call) => call.kind), ['REFRESH', 'REVOKE']);
  row = await noRevoke.connection();
  assert.match(decryptSecret(row.accessTokenEnc), /^ghu_rotated/);
  assert.ok(row.refreshExpiresAt.getTime() > Date.now());
  assert.equal((await h.job(noRevoke.command.jobId)).state, 'LANDED');
  assert.ok(noRevoke.logged.some((line) => line.startsWith('WARN') && line.includes('not fully retired')));
  await assertNoSecondHandout(noRevoke);

  // A session's Merge: retired once its result reports back, refresh then revoke.
  const ownerId = await h.newOwner('retire-merge');
  await connectGithub(h, ownerId);
  const ws = await h.newWorkspace(ownerId, 'retire-merge', { github: true });
  await h.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const leaseOwner = randomUUID();
  await h.prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId: ws.workspaceId, assignedRunnerId: ws.runnerId,
      title: 'Retire after a merge', prompt: 'merge', branch: `orbit/ret-${sessionId.slice(0, 6)}`, isolationStatus: 'worktree',
      status: RunStatus.SUCCEEDED, finishedAt: new Date(Date.now() - 60_000),
      mergeStatus: 'pending', mergeOperationId: operationId, mergeOperationOwner: leaseOwner, mergeTarget: 'main',
    },
  });
  const merge = pushAsMeDoor(h, ws.fullName);
  assert.equal((await merge.service.ownerCredential({ id: ws.runnerId, ownerId }, {
    workspaceId: ws.workspaceId, host: 'github.com', path: ws.fullName, sessionId, mergeOperationId: operationId, leaseOwner,
  })).password, OWNER_TOKEN);
  calls();
  const mergeResult = { operationId, leaseOwner, status: 'merged' as const, landVia: 'PUSH_AS_ME' as const, pushedAs: 'OWNER' as const, targetBranch: 'main' };
  assert.deepEqual(await merge.service.afterMergeResult(sessionId, mergeResult), { refreshed: true, revoked: 1, failure: null });
  const mergeCalls = calls();
  assert.deepEqual(mergeCalls.map((call) => call.kind), ['REFRESH', 'REVOKE']);
  assert.equal((mergeCalls[1] as { accessToken: string }).accessToken, OWNER_TOKEN);
  assert.equal(await merge.service.afterMergeResult(sessionId, mergeResult), null, 'once');
});

// ── the failure paths (design §4.2 J-T16 to J-T20, §4.5, §4.6) ─────────────────────────────────────────────────────

type Harness = Awaited<ReturnType<typeof harness>>;

/** A protected main's landing, waiting on its open pull request (J-T14, then the door opened it). */
async function waitingOnPullRequest(h: Harness, ownerId: string, label: string) {
  const cloud = await h.newWorkspace(ownerId, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), { github: true });
  h.github.granted.set(cloud.installationId, GRANTED);
  const landing = await h.queuedLanding(ownerId, cloud, label);
  const [command] = await h.beat(cloud.runnerId, true);
  assert.equal(command?.landVia, 'PULL_REQUEST');
  const head = SHA(`${label}-head`);
  const answered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body: h.pullRequestResult(command, head, SHA(`${label}-tree`)),
  });
  assert.equal(answered.answer.state, 'PULL_REQUEST');
  const scenario = h.github.scenario(cloud.fullName);
  scenario.mergeStateStatus = 'BLOCKED';
  scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'IN_PROGRESS', conclusion: null }];
  await h.door.advance(answered.after!.pullRequestIds!);
  const prId = (await h.job(command.jobId)).pullRequestId!;
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } });
  assert.equal(pr.state, 'OPEN');
  return { cloud, landing, command, head, prId, number: pr.number!, scenario };
}

/** The runner's next generation answering PULL_REQUEST: it pushed `head` to the same landing branch. */
async function pushAgain(h: Harness, ownerId: string, cloud: { runnerId: string }, command: IntegrationJobCommand, head: string, source = WORK_TIP) {
  const body = { ...h.pullRequestResult(command, head, SHA(`tree-of-${head}`)), sourceSha: source };
  for (const pull of h.github.pulls) if (pull.head === (command.landingRef ?? '').replace('refs/heads/', '') && pull.state === 'OPEN') pull.headSha = head;
  return applyIntegrationJobResult(h.prisma as never, { jobId: command.jobId, runnerId: cloud.runnerId, ownerId, body });
}

const ACTIONS_LOG = [
  '2026-11-23T10:00:00.0000000Z ##[group]Run npm run test:pg',
  '2026-11-23T10:00:01.0000000Z > orbit@ test:pg',
  '2026-11-23T10:00:02.0000000Z token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  '2026-11-23T10:00:03.0000000Z not ok 14 - the review wait merges after approval',
  '2026-11-23T10:00:04.0000000Z ##[error]AssertionError: expected LANDED, got PULL_REQUEST',
  '2026-11-23T10:00:05.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

test('J-T16 and W4–W6: a failing required check goes back to the task\'s session with its log, and its fix updates the same pull request', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('red-check');
  const w = await waitingOnPullRequest(h, ownerId, 'Add the landing timeline');
  // W4 hands a failure to the task's own work session when its DONE ended it.
  const work = await h.prisma.session.findFirstOrThrow({ where: { taskId: w.landing.taskId } });
  await h.prisma.session.update({ where: { id: work.id }, data: { endReason: 'task_done' } });

  h.github.logs.set(9001, ACTIONS_LOG);
  w.scenario.checks = [
    { name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'FAILURE', jobId: 9001 },
    { name: 'lint', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  await h.door.reread(w.prId);

  // J-T16: CHECK_FAILED, the GitHub check and its log kept in the job's checks; nothing merged; the pull request open.
  const failed = await h.job(w.command.jobId);
  assert.equal(failed.state, 'CHECK_FAILED');
  assert.ok(failed.finishedAt);
  const checks = failed.checks as unknown as IntegrationCheckResult[];
  const github = checks.find((check) => check.name === 'GITHUB_CHECK');
  assert.ok(github, `the GitHub check is in the job's checks: ${JSON.stringify(checks.map((check) => check.name))}`);
  assert.equal(github.command, 'PostgreSQL specs');
  assert.equal(github.github?.pullRequest.number, w.number);
  assert.equal(github.github?.headSha, w.head);
  assert.equal(github.github?.conclusion, 'failure');
  assert.match(github.outputTail, /AssertionError: expected LANDED, got PULL_REQUEST/);
  assert.doesNotMatch(github.outputTail, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/, 'the log is redacted before it is stored');
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'nothing was merged');
  const pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: w.prId } });
  assert.equal(pr.state, 'OPEN');
  assert.equal(pr.condition, 'CHECK_FAILED');
  const line = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: w.command.jobId, kind: 'PULL_REQUEST', text: { startsWith: 'Required check' } } });
  assert.equal(line?.text, `Required check "PostgreSQL specs" failed on pull request #${w.number}`);
  // The attempt's result line says what is true of it: its commit was pushed, and the pull request is not merged.
  const result = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: w.command.jobId, kind: 'RESULT' } });
  assert.equal(result?.text, 'Check failed · pull request not merged');

  // W4/W5: the item is the task's own work session's.
  const item = await h.prisma.projectOpenItem.findFirstOrThrow({ where: { integrationJobId: w.command.jobId } });
  assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
  assert.equal(item.state, 'OPEN');
  assert.equal(item.workSessionId, work.id, 'W4 hands a GitHub check failure to the session that wrote the work');
  // W6's pull request text, from the rows the failure wrote.
  const facts = await readLandingFixFacts(h.prisma as never, { integrationJobId: w.command.jobId, title: item.title, payload: item.payload });
  assert.ok(facts);
  const turn = landingFixMessage(facts);
  assert.match(turn, new RegExp(`The required check "PostgreSQL specs" failed on pull request #${w.number} \\(${w.head.slice(0, 7)}\\):`));
  assert.match(turn, /AssertionError: expected LANDED, got PULL_REQUEST/);
  assert.match(turn, /Full log: https:\/\/github\.com\/.+\/actions\/runs\/1\/job\/9001/);
  assert.match(turn, new RegExp(`main is unchanged, and pull request #${w.number} stays open`));
  assert.match(turn, new RegExp(`Orbit updates pull request #${w.number} with your commit`));

  // The fix: W7 on a MAIN line supersedes the failed candidate with one for the new commit, in the same round.
  const fixedTip = SHA('the fixed tip');
  const candidate = await h.prisma.$transaction(async (tx) => {
    const codebase = await tx.projectCodebase.findFirstOrThrow({
      where: { projectId: w.landing.projectId }, select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
    });
    await supersedeLiveCandidates(tx, w.landing.projectId, `refs/heads/${work.branch}`);
    return queueTaskBranchCandidate(tx, {
      ownerId, projectId: w.landing.projectId, taskId: w.landing.taskId, codebase,
      session: { id: work.id, branch: work.branch!, runnerId: w.cloud.runnerId },
    });
  });
  assert.ok(candidate);
  const [check] = await h.beat(w.cloud.runnerId, true);
  assert.equal(check?.kind, 'CHECK_PROMOTION');
  await applyIntegrationJobResult(h.prisma as never, {
    jobId: check.jobId, runnerId: w.cloud.runnerId, ownerId,
    body: {
      claimGeneration: check.claimGeneration, leaseOwner: check.leaseOwner, state: 'READY', phase: 'CHECK',
      sourceSha: fixedTip, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP, testedSha: SHA('fixed tested'),
      testedTreeSha: SHA('fixed tree'), aheadOfUpstream: 2, filesChanged: 1, checks: [GREEN_CHECK],
    },
  });
  await h.promotions.confirm({ userId: ownerId }, w.landing.projectId, candidate.promotionId, fixedTip);
  const [land] = await h.beat(w.cloud.runnerId, true);
  assert.equal(land?.kind, 'LAND_PROMOTION');
  assert.equal(land.pullRequestOpen, true, 'the fix is handed the open pull request');
  assert.equal(land.landingRef, w.command.landingRef, 'and the same landing branch');
  assert.equal(land.landingRefSha, w.head, 'leased on the head Orbit pushed before');
  const fixedHead = SHA('the fixed head');
  const again = await pushAgain(h, ownerId, w.cloud, land, fixedHead, fixedTip);
  assert.deepEqual(again.after?.pullRequestIds, [w.prId], 'the same pull request');
  const updated = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: w.prId } });
  assert.equal(updated.headSha, fixedHead);
  assert.equal(updated.condition, null, 'what GitHub said about the old head no longer holds');

  // GitHub runs the checks again on the new head; they pass, and the same pull request merges.
  w.scenario.checks = [
    { name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'SUCCESS', jobId: 9002 },
    { name: 'lint', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  w.scenario.mergeStateStatus = 'CLEAN';
  w.scenario.baseSha = UPSTREAM_TIP;
  w.scenario.mergeTree = () => SHA(`tree-of-${fixedHead}`);
  await h.door.advance(again.after!.pullRequestIds!);
  const landed = await h.job(land.jobId);
  assert.equal(landed.state, 'LANDED');
  assert.equal(landed.pullRequestId, w.prId);
  assert.equal(h.github.calls.filter((call) => call.method === 'POST' && call.path === `/repos/${w.cloud.fullName}/pulls`).length, 1,
    'one pull request was opened, and the fix updated it');
  assert.deepEqual(h.github.calls.find((call) => call.method === 'PUT')?.body, { sha: fixedHead, merge_method: 'rebase' });
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: w.prId } })).state, 'MERGED');
});

test('J-T17: a pull request behind main catches up into the same pull request, uncounted; a merge refused for a moved base counts', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('moved');
  const w = await waitingOnPullRequest(h, ownerId, 'Catch up with main');
  const promotionId = (await h.job(w.command.jobId)).promotionId!;

  // Three catch-ups in a row: each ends its attempt TARGET_MOVED and queues the next under the same confirmation.
  let command = w.command;
  for (let round = 1; round <= 3; round += 1) {
    w.scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }];
    w.scenario.mergeStateStatus = 'BEHIND';
    await h.door.reread(w.prId);
    const moved = await h.job(command.jobId);
    assert.equal(moved.state, 'ERROR', `catch-up ${round}`);
    assert.equal(moved.errorCode, 'TARGET_MOVED');
    assert.equal((moved.errorDetail as { pullRequestCatchUp?: boolean }).pullRequestCatchUp, true);
    const items = await h.prisma.projectOpenItem.findMany({ where: { integrationJobId: command.jobId }, select: { kind: true, title: true, payload: true } });
    assert.deepEqual(items, [], 'a catch-up asks nobody for anything');
    const promotion = await h.prisma.projectPromotion.findUniqueOrThrow({ where: { id: promotionId } });
    assert.equal(promotion.state, 'CONFIRMED', `catch-up ${round} is not one of J-T13's three`);
    const line = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: command.jobId, kind: 'NEXT_GENERATION' } });
    assert.match(String(line?.text), /catching up with main/);
    assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: w.prId } })).state, 'OPEN');
    const [following] = await h.beat(w.cloud.runnerId, true);
    assert.equal(following?.kind, 'LAND_PROMOTION');
    assert.equal(following.jobId, promotion.landJobId);
    assert.equal(following.pullRequestOpen, true);
    assert.equal(following.landingRef, w.command.landingRef, 'the next generation pushes to the same landing branch');
    const answered = await pushAgain(h, ownerId, w.cloud, following, SHA(`caught-up-${round}`));
    assert.deepEqual(answered.after?.pullRequestIds, [w.prId]);
    command = following;
  }

  // A merge GitHub refuses because main moved counts: the third in a row blocks the candidate.
  for (let refused = 1; refused <= 3; refused += 1) {
    w.scenario.mergeStateStatus = 'CLEAN';
    w.scenario.baseSha = UPSTREAM_TIP;
    w.scenario.baseModified = true;
    await h.door.reread(w.prId);
    const ended = await h.job(command.jobId);
    assert.equal(ended.state, 'ERROR', `refused merge ${refused}`);
    assert.equal(ended.errorCode, 'TARGET_MOVED');
    assert.equal((ended.errorDetail as { pullRequestMergeRefused?: boolean }).pullRequestMergeRefused, true);
    const promotion = await h.prisma.projectPromotion.findUniqueOrThrow({ where: { id: promotionId } });
    if (refused < 3) {
      assert.equal(promotion.state, 'CONFIRMED');
      const [following] = await h.beat(w.cloud.runnerId, true);
      assert.equal(following?.pullRequestOpen, true);
      await pushAgain(h, ownerId, w.cloud, following, SHA(`after-refusal-${refused}`));
      command = following;
    } else {
      assert.equal(promotion.state, 'BLOCKED', 'the third refused merge in a row blocks the candidate (J-T13)');
      assert.equal(await h.prisma.projectOpenItem.count({ where: { integrationJobId: command.jobId, kind: 'INTEGRATION_ERROR' } }), 1);
    }
  }
});

test('J-T19 and J-T20: a pull request closed on GitHub, and one whose head Orbit did not push', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('closed');

  const closed = await waitingOnPullRequest(h, ownerId, 'Closed on GitHub');
  const pull = h.github.pulls.find((row) => row.number === closed.number)!;
  pull.state = 'CLOSED';
  pull.closedBy = 'octo-reviewer';
  await h.door.reread(closed.prId);
  const ended = await h.job(closed.command.jobId);
  assert.equal(ended.state, 'ERROR');
  assert.equal(ended.errorCode, 'PULL_REQUEST_CLOSED');
  assert.match(String((ended.errorDetail as { message?: string }).message), new RegExp(`@octo-reviewer closed pull request #${closed.number} without merging it`));
  const closedRow = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: closed.prId } });
  assert.equal(closedRow.state, 'CLOSED');
  assert.equal(closedRow.closedBy, 'octo-reviewer');
  const closedItem = await h.prisma.projectOpenItem.findFirstOrThrow({ where: { integrationJobId: closed.command.jobId } });
  assert.equal(closedItem.kind, 'INTEGRATION_ERROR');
  assert.equal((closedItem.payload as { errorCode?: string }).errorCode, 'PULL_REQUEST_CLOSED');

  const foreign = await waitingOnPullRequest(h, ownerId, 'Somebody pushed the landing branch');
  h.github.pulls.find((row) => row.number === foreign.number)!.headSha = SHA('a commit Orbit never checked');
  foreign.scenario.mergeStateStatus = 'CLEAN';
  foreign.scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }];
  await h.door.reread(foreign.prId);
  const changed = await h.job(foreign.command.jobId);
  assert.equal(changed.state, 'ERROR');
  assert.equal(changed.errorCode, 'PULL_REQUEST_HEAD_CHANGED');
  assert.equal((changed.errorDetail as { foundSha?: string }).foundSha, SHA('a commit Orbit never checked'));
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'Orbit merges only what it pushed');
  assert.equal((await h.prisma.projectOpenItem.findFirstOrThrow({ where: { integrationJobId: foreign.command.jobId } })).kind, 'INTEGRATION_ERROR');
});

test('A required review: the landing waits for it with the link, the owner is told once, and the approval merges it', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('review');
  const told: Array<{ ownerId: string; title: string; message: string; url?: string }> = [];
  const door = h.doorWith({ push: { notifyOwner: async (owner: string, input: { title: string; message: string; url?: string }) => { told.push({ ownerId: owner, ...input }); return { delivered: true, devices: 1 }; } } });
  const w = await waitingOnPullRequest(h, ownerId, 'Wait for the owner\'s review');
  w.scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }];
  w.scenario.reviewDecision = 'REVIEW_REQUIRED';
  w.scenario.mergeStateStatus = 'BLOCKED';
  await door.reread(w.prId);
  await door.reread(w.prId);
  await door.tick(new Date(Date.now() + 3_600_000));

  const [waiting] = await readInFlightJobs(h.prisma as never, w.landing.projectId, w.command.jobId);
  assert.equal(waiting?.state, 'PULL_REQUEST');
  assert.equal(waiting.blockingReason?.code, 'WAITING_FOR_REVIEW');
  assert.equal(waiting.blockingReason?.summary, `Waiting for review on pull request #${w.number}`);
  assert.equal(waiting.pullRequest?.url, `https://github.com/${w.cloud.fullName}/pull/${w.number}`);
  assert.equal(waiting.pullRequest?.condition, 'REVIEW_REQUIRED');
  const landingSession = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: w.landing.landingId } });
  const view = await readLandingView(h.prisma as never, ownerId, landingSession.sessionId);
  assert.equal(view?.pullRequest?.url, `https://github.com/${w.cloud.fullName}/pull/${w.number}`);
  assert.deepEqual(told, [{
    ownerId, title: 'Waiting for review', message: `Pull request #${w.number} is waiting for review`, priority: 'normal',
    url: `https://github.com/${w.cloud.fullName}/pull/${w.number}`,
  }], 'the owner is told once, with the link');
  assert.ok((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: w.prId } })).reviewAnnouncedAt);
  const line = await h.prisma.projectIntegrationJobEvent.findFirst({ where: { jobId: w.command.jobId, kind: 'PULL_REQUEST', text: { startsWith: 'Waiting for review' } } });
  assert.equal(line?.text, `Waiting for review on pull request #${w.number}`);
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'nothing merges before the review');

  // Approved: merged and landed.
  w.scenario.reviewDecision = 'APPROVED';
  w.scenario.mergeStateStatus = 'CLEAN';
  w.scenario.baseSha = UPSTREAM_TIP;
  w.scenario.mergeTree = () => SHA('Wait for the owner\'s review-tree');
  await door.reread(w.prId);
  assert.equal((await h.job(w.command.jobId)).state, 'LANDED');
  assert.equal(told.length, 1);
});

test('§4.6 under D5: a session\'s Merge whose check fails is handed the log as a turn that merges again, at most twice; a moved target merges again; closed is an error', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('session-fix');
  const cloud = await h.newWorkspace(ownerId, 'session-fix', { github: true });
  const turns: Array<{ sessionId: string; clientTurnId: string; content: string }> = [];
  const mergedAgain: Array<{ sessionId: string; pullRequestId: string; target: string }> = [];
  const sessions = {
    // The real createTurn writes the turn and calls the hook in its transaction; this one does the same two writes.
    createTurn: async (_owner: string, sessionId: string, dto: { clientTurnId: string; content: string }, opts: { participateSendTransaction?: (tx: never) => Promise<void> }) => {
      await h.prisma.$transaction(async (tx) => {
        await opts.participateSendTransaction?.(tx as never);
        const seq = await tx.conversationTurn.count({ where: { sessionId } });
        await tx.conversationTurn.create({ data: { sessionId, seq: seq + 1, clientTurnId: dto.clientTurnId, content: dto.content } as never });
      });
      turns.push({ sessionId, clientTurnId: dto.clientTurnId, content: dto.content });
    },
    mergeAgainForPullRequest: async (sessionId: string, pullRequestId: string, target: string) => {
      mergedAgain.push({ sessionId, pullRequestId, target });
      return 'QUEUED';
    },
  };
  const door = h.doorWith({ sessions });

  async function sessionWaiting(label: string) {
    const sessionId = randomUUID();
    await h.prisma.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId: cloud.workspaceId, assignedRunnerId: cloud.runnerId,
        title: label, prompt: 'do it', branch: `orbit/s-${sessionId.slice(0, 6)}`, isolationStatus: 'worktree',
        status: RunStatus.AWAITING_INPUT, mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeTarget: 'main',
      },
    });
    const head = SHA(`${label}-head-1`);
    h.github.pushed.set(`orbit/land/${sessionId}`, head);
    const prId = await h.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
      return recordSessionMergePullRequest(tx as never, {
        sessionId, current: { ownerId, taskId: null, mergeCheckpointId: null, mergeRecoveryAction: null }, modern: true,
        dto: { operationId: randomUUID(), leaseOwner: 'x', status: 'pull_request', sourceSha: SHA(`${label}-source`), pushedSha: head, rebaseBaseSha: UPSTREAM_TIP, targetBranch: 'main' },
      });
    });
    await door.advance([prId]);
    return { sessionId, prId, head, number: (await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: prId } })).number! };
  }
  /** The merge again after the fix turn: the runner pushed `head` to the same landing branch. */
  async function mergedWith(s: { sessionId: string; prId: string }, head: string) {
    h.github.pushed.set(`orbit/land/${s.sessionId}`, head);
    const pull = h.github.pulls.find((row) => row.head === `orbit/land/${s.sessionId}`)!;
    pull.headSha = head;
    await h.prisma.session.update({ where: { id: s.sessionId }, data: { mergeStatus: 'pending', mergeAfterTurnAt: null } });
    await h.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${s.sessionId}::uuid FOR UPDATE`;
      return recordSessionMergePullRequest(tx as never, {
        sessionId: s.sessionId, current: { ownerId, taskId: null, mergeCheckpointId: null, mergeRecoveryAction: null }, modern: true,
        dto: { operationId: randomUUID(), leaseOwner: 'x', status: 'pull_request', sourceSha: SHA(`${head}-source`), pushedSha: head, rebaseBaseSha: UPSTREAM_TIP, targetBranch: 'main' },
      });
    });
  }

  const s = await sessionWaiting('Tidy the settings page');
  const scenario = h.github.scenario(cloud.fullName);
  h.github.logs.set(7001, ACTIONS_LOG);
  scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'FAILURE', jobId: 7001 }];
  scenario.mergeStateStatus = 'BLOCKED';
  await door.reread(s.prId);
  let session = await h.prisma.session.findUniqueOrThrow({ where: { id: s.sessionId } });
  assert.equal(session.mergeStatus, 'error');
  assert.match(String(session.mergeError), new RegExp(`The required check "PostgreSQL specs" failed on pull request #${s.number}`));
  assert.ok(session.mergeAfterTurnAt, 'the fix turn owes the merge after it, written in the turn\'s own transaction');
  assert.equal(session.mergeAfterTurnTarget, 'main');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.clientTurnId, pullRequestFixTurnId(s.prId, s.head));
  assert.match(turns[0]!.content, /AssertionError: expected LANDED, got PULL_REQUEST/);
  assert.match(turns[0]!.content, new RegExp(`your commit updates pull request #${s.number}`));
  assert.match(turns[0]!.content, /fix round 1 of 2/);
  assert.doesNotMatch(turns[0]!.content, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  // Read again on the same head: no second turn.
  await h.prisma.session.update({ where: { id: s.sessionId }, data: { mergeStatus: 'pull_request' } });
  await door.reread(s.prId);
  assert.equal(turns.length, 1, 'one failed head is one turn');
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: s.prId } })).state, 'OPEN', 'the pull request stays open');

  // Round 2 on the fix's head, and nothing more after it.
  await mergedWith(s, SHA('fix-1'));
  await door.reread(s.prId);
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.content, /fix round 2 of 2/);
  await mergedWith(s, SHA('fix-2'));
  await door.reread(s.prId);
  assert.equal(turns.length, 2, 'at most two rounds (D5)');
  session = await h.prisma.session.findUniqueOrThrow({ where: { id: s.sessionId } });
  assert.equal(session.mergeStatus, 'error');
  assert.equal(await h.prisma.githubPullRequest.count({ where: { sessionId: s.sessionId } }), 1, 'every round updated the same pull request');

  // The target moved: the merge is queued again, into the same pull request.
  scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'IN_PROGRESS', conclusion: null }];
  scenario.mergeStateStatus = 'BLOCKED';
  const moved = await sessionWaiting('Fix the toolbar');
  scenario.checks = [{ name: 'PostgreSQL specs', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }];
  scenario.mergeStateStatus = 'BEHIND';
  await door.reread(moved.prId);
  assert.deepEqual(mergedAgain, [{ sessionId: moved.sessionId, pullRequestId: moved.prId, target: 'main' }]);

  // Closed on GitHub: an error naming who closed it.
  scenario.mergeStateStatus = 'BLOCKED';
  const closed = await sessionWaiting('Rename the menu');
  const pull = h.github.pulls.find((row) => row.number === closed.number)!;
  pull.state = 'CLOSED';
  pull.closedBy = 'octo-reviewer';
  await door.reread(closed.prId);
  const closedSession = await h.prisma.session.findUniqueOrThrow({ where: { id: closed.sessionId } });
  assert.equal(closedSession.mergeStatus, 'error');
  assert.match(String(closedSession.mergeError), new RegExp(`@octo-reviewer closed pull request #${closed.number} without merging it`));
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: closed.prId } })).state, 'CLOSED');
});

// ── The web board's states (docs/mocks/protected-branch-landing), read as the clients read them ─────────────────────

/** Six required checks, `passed` of them green; the rest still running, or one of them red. */
function requiredChecks(passed: number, failing = false) {
  return Array.from({ length: 6 }, (_, i) => ({
    name: i === 5 ? 'PostgreSQL specs' : `check ${i + 1}`, required: true,
    status: i < passed || (failing && i === 5) ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion: i < passed ? 'SUCCESS' : failing && i === 5 ? 'FAILURE' : null,
    ...(failing && i === 5 ? { jobId: 9101 } : {}),
  }));
}

test('(16) every state the web board draws is read, with the pull request block and its workspace, from the real services', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const h = await harness(t);
  // LANDING_STATES_OUT: the seed for the screenshots. The owners can sign in with this password, and what is written
  // is the ids the pages are opened by. Without it the case only asserts the read models.
  const out = process.env.LANDING_STATES_OUT;
  const PASSWORD = 'landing-board-2026';
  const owner = await h.newOwner('board');
  const bare = await h.newOwner('no-github');
  for (const [id, label] of [[owner, 'board'], [bare, 'no-github']] as const) {
    await h.prisma.user.update({ where: { id }, data: { email: `${label}@landing-board.test`, passwordHash: hashPassword(PASSWORD) } });
  }
  await connectGithub(h, owner);
  const manifest: Record<string, unknown> = { password: PASSWORD, owners: { board: 'board@landing-board.test', noGithub: 'no-github@landing-board.test' } };

  // a: opened, 2 of 6 checks; d: main moved (the pull request's condition says BEHIND while the attempt is held).
  const a = await waitingOnPullRequest(h, owner, 'Opened with checks running');
  a.scenario.checks = requiredChecks(2);
  await h.door.reread(a.prId);
  const d = await waitingOnPullRequest(h, owner, 'Main moved meanwhile');
  d.scenario.checks = requiredChecks(0);
  await h.door.reread(d.prId);
  await h.sql.query(`UPDATE "github_pull_request" SET "condition" = 'BEHIND' WHERE "id" = $1::uuid`, [d.prId]);

  // b: every required check green, a review is required.
  const b = await waitingOnPullRequest(h, owner, 'Waiting for the owner review');
  b.scenario.checks = requiredChecks(6);
  b.scenario.reviewDecision = 'REVIEW_REQUIRED';
  await h.door.reread(b.prId);

  // c: a required check failed on GitHub.
  const c = await waitingOnPullRequest(h, owner, 'A required check failed');
  h.github.logs.set(9101, ACTIONS_LOG);
  c.scenario.checks = requiredChecks(5, true);
  await h.door.reread(c.prId);
  assert.equal((await h.job(c.command.jobId)).state, 'CHECK_FAILED');

  // e: approved and merged.
  const e = await waitingOnPullRequest(h, owner, 'Merged by pull request');
  e.scenario.checks = requiredChecks(6);
  e.scenario.reviewDecision = 'APPROVED';
  e.scenario.mergeStateStatus = 'CLEAN';
  e.scenario.baseSha = UPSTREAM_TIP;
  e.scenario.mergeTree = () => SHA('Merged by pull request-tree');
  await h.door.reread(e.prId);
  assert.equal((await h.job(e.command.jobId)).state, 'LANDED');

  // closed on GitHub by someone else.
  const closed = await waitingOnPullRequest(h, owner, 'Closed on GitHub without merging');
  const pull = h.github.pulls.find((row) => row.number === closed.number)!;
  pull.state = 'CLOSED';
  pull.closedBy = 'sam';
  await h.door.reread(closed.prId);
  assert.equal((await h.job(closed.command.jobId)).errorCode, 'PULL_REQUEST_CLOSED');

  // f: Push as me refused, fell back to a pull request, and the workspace remembers the refusal.
  const f = await h.newWorkspace(owner, 'push-refused', { github: true });
  h.github.granted.set(f.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: f.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  const fLanding = await h.queuedLanding(owner, f, 'Push as me fell back');
  const [fCommand] = await beatV2(h, f.runnerId, true);
  assert.equal(fCommand?.landVia, 'PUSH_AS_ME');
  const refusedWords = 'GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.';
  const fAnswered = await applyIntegrationJobResult(h.prisma as never, {
    jobId: fCommand.jobId, runnerId: f.runnerId, ownerId: owner,
    body: { ...h.pullRequestResult(fCommand, SHA('f-head'), SHA('f-tree')), pushRefusal: refusedWords },
  });
  const fScenario = h.github.scenario(f.fullName);
  fScenario.mergeStateStatus = 'BLOCKED';
  fScenario.checks = requiredChecks(6);
  fScenario.reviewDecision = 'REVIEW_REQUIRED';
  await h.door.advance(fAnswered.after!.pullRequestIds!);
  await pushAsMeDoor(h, f.fullName).service.afterJobResult(fCommand.jobId);

  // The settings: Push as me chosen with nothing refused, a workspace not from GitHub, and an installation that has
  // not accepted the pull request permissions.
  const pam = await h.newWorkspace(owner, 'push-as-me-on', { github: true });
  h.github.granted.set(pam.installationId, GRANTED);
  await h.prisma.workspace.update({ where: { id: pam.workspaceId }, data: { landingMode: 'PUSH_AS_ME' } });
  const notGithub = await h.newWorkspace(owner, 'not-from-github', { github: false });
  const pending = await h.newWorkspace(owner, 'permissions-pending', { github: true });
  h.github.granted.set(pending.installationId, { contents: 'write', metadata: 'read' });
  const unconnected = await h.newWorkspace(bare, 'github-not-connected', { github: true });
  h.github.granted.set(unconnected.installationId, GRANTED);

  // What the clients read.
  const workspaces = new WorkspacesService(h.prisma as never, undefined, undefined, h.grants);
  const settings = async (ownerId: string, ws: { workspaceId: string }) => (await workspaces.getWithUsage(ownerId, ws.workspaceId)).landing;
  assert.equal((await settings(owner, a.cloud)).mode, 'PULL_REQUEST');
  assert.deepEqual((await settings(owner, a.cloud)).pushAsMe, { available: true });
  assert.equal((await settings(owner, pam)).mode, 'PUSH_AS_ME');
  assert.equal((await settings(owner, f)).lastRefusal?.message, refusedWords);
  assert.equal((await settings(owner, notGithub)).mode, null);
  const pendingView = await settings(owner, pending);
  assert.equal(pendingView.permissionsPending?.account, 'owner');
  assert.match(pendingView.permissionsPending?.reviewUrl ?? '', /^https:\/\/github\.com\/settings\/installations\/\d+$/);
  assert.equal((await settings(owner, a.cloud)).permissionsPending, undefined);
  assert.deepEqual((await settings(bare, unconnected)).pushAsMe, { available: false, reason: 'GITHUB_NOT_CONNECTED' });

  const cards = async (projectId: string, jobId: string) => (await readInFlightJobs(h.prisma as never, projectId, jobId))[0]?.pullRequest;
  const aCard = await cards(a.landing.projectId, a.command.jobId);
  assert.equal(aCard?.workspaceId, a.cloud.workspaceId);
  assert.deepEqual([aCard?.condition, aCard?.checks.passed, aCard?.checks.required], ['CHECKS_PENDING', 2, 6]);
  assert.equal((await cards(b.landing.projectId, b.command.jobId))?.condition, 'REVIEW_REQUIRED');
  assert.equal((await cards(d.landing.projectId, d.command.jobId))?.condition, 'BEHIND');
  const fCard = await cards(fLanding.projectId, fCommand.jobId);
  assert.equal(fCard?.refusal?.via, 'PUSH_AS_ME');
  assert.equal(fCard?.workspaceId, f.workspaceId);
  // A landing into main is a promotion's, so its terminal states are read on the landing's own view (§2.9).
  const landingOf = async (w: { landing: { landingId: string } }) => {
    const row = await h.prisma.projectLanding.findUniqueOrThrow({ where: { id: w.landing.landingId } });
    return readLandingView(h.prisma as never, owner, row.sessionId);
  };
  const cView = await landingOf(c);
  assert.equal(cView?.currentAttempt?.state, 'CHECK_FAILED');
  assert.equal(cView?.pullRequest?.checks.failed[0]?.name, 'PostgreSQL specs');
  assert.equal((await landingOf(e))?.pullRequest?.state, 'MERGED');
  assert.equal((await landingOf(closed))?.pullRequest?.state, 'CLOSED');

  if (out) {
    const writeJson = (await import('node:fs')).writeFileSync;
    const ids = (w: { landing: { projectId: string; taskId: string }; cloud: { workspaceId: string } }) =>
      ({ projectId: w.landing.projectId, taskId: w.landing.taskId, workspaceId: w.cloud.workspaceId });
    manifest.cards = {
      a: ids(a), b: ids(b), c: ids(c), d: ids(d), e: ids(e), closed: ids(closed),
      f: { projectId: fLanding.projectId, taskId: fLanding.taskId, workspaceId: f.workspaceId },
    };
    manifest.settings = {
      pullRequest: a.cloud.workspaceId, pushAsMe: pam.workspaceId, refused: f.workspaceId, notFromGithub: notGithub.workspaceId,
      permissionsPending: pending.workspaceId, notConnected: unconnected.workspaceId,
    };
    manifest.grants = Object.fromEntries([...h.github.granted.entries()].map(([id, permissions]) => [String(id), permissions]));
    writeJson(out, JSON.stringify(manifest, null, 2));
  }
});
