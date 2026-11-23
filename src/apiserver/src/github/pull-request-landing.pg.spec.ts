/**
 * Landing through a pull request, on real PostgreSQL (docs/design/protected-branch-landing.md §3, §4, §13). GitHub is
 * faked through `GithubClient`'s injected fetch, as the GitHub specs do; every row is written by the code under test
 * except the fixture's project, task, sessions and the App's saved configuration.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/github/pull-request-landing.pg.spec.ts
 *
 * What it is held to:
 *   (1) §3 at the hand-out: a runner without integration-pull-request/v1 is handed today's command and nothing is
 *       recorded; with it, an installation that has not accepted the permissions, an Orbit branch and a workspace not
 *       cloned from GitHub land PUSH; a GitHub workspace whose installation granted them lands PULL_REQUEST, its
 *       landing branch named after the landing session, both recorded on the job.
 *   (2) J-T14: the runner's PULL_REQUEST result moves the job to PULL_REQUEST and writes the subject's pull request
 *       row (OPENING, head, base, tested tree, GitHub's refusal); no runner holds it (a late report is STALE_CLAIM); it
 *       is in flight (J3 holds the task's next landing, the in-flight read says PULL_REQUEST, never timed out, waiting
 *       for checks); a PULL_REQUEST from an attempt handed out PUSH is refused.
 *   (3) The door opens the pull request as the App (head orbit/land/<id>, base main), waits while the required checks
 *       run and while a review is required, merges with sha = the pushed head once GitHub allows, and on GitHub's
 *       merged answer lands the job (J-T15): LANDED with GitHub's commit, a receipt recorded by SERVER naming the pull
 *       request, the pull request MERGED, the landing branch deleted, the landing settled.
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
 */
process.env.PROVIDER_SECRET_KEY = process.env.PROVIDER_SECRET_KEY || `pull-request-landing-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import { INTEGRATION_PULL_REQUEST_CAPABILITY, SESSION_MERGE_PULL_REQUEST_CAPABILITY, type IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { encryptSecret } from '../providers/provider-crypto';
import { TasksService } from '../tasks/tasks.service';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  applyIntegrationJobResult,
  receiveIntegrationJobProgress,
} from '../runner-api/integration-job-relay';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from '../projects/project-integration-job';
import { readInFlightJobs, stopInFlightJob } from '../projects/project-integration-line';
import { GITHUB_API, GithubClient } from './github-api.client';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubInstallationGrants } from './github-installation-grants';
import { GithubWebhookService } from './github-webhook';
import { PullRequestDoorService, REREAD_WITHOUT_DELIVERIES_MS, REREAD_WITH_DELIVERIES_MS } from './pull-request-door.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const SHA = (seed: string) => createHmac('sha1', 'pr').update(seed).digest('hex');
const WORK_REPORTED = [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }];

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
}

/** What GitHub says about a pull request's merge: one scenario a case sets. */
interface Scenario {
  mergeStateStatus: string;
  reviewDecision: string | null;
  checks: Array<{ name: string; required: boolean; status: string; conclusion: string | null }>;
  baseSha: string | null;
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
  private nextNumber = 100;

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
    assert.equal(url.origin, GITHUB_API, `the door reached ${url.origin}`);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });
    const json = (status: number, value: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    let match: RegExpMatchArray | null;
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
      if (scenario.refuses.includes(body.merge_method)) {
        return json(405, { message: `${body.merge_method[0].toUpperCase()}${body.merge_method.slice(1)} merges are not allowed on this repository.` });
      }
      if (body.sha !== pull.headSha) return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      pull.state = 'MERGED';
      pull.mergedBy = 'orbitd-cloud[bot]';
      pull.mergeCommit = { oid: SHA(`merge-${pull.number}`), tree: scenario.mergeTree(pull) };
      return json(200, { sha: pull.mergeCommit.oid, merged: true, message: 'Pull Request successfully merged' });
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
              mergeable: 'MERGEABLE', mergeStateStatus: pull.state === 'MERGED' ? 'UNKNOWN' : scenario.mergeStateStatus,
              reviewDecision: scenario.reviewDecision, isInMergeQueue: false, isMergeQueueEnabled: false,
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: scenario.checks.map((check) => ({
                __typename: 'CheckRun', name: check.name, status: check.status, conclusion: check.conclusion,
                detailsUrl: `https://github.com/${fullName}/actions/runs/1`, isRequired: check.required,
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

  /** A DONE task of a project whose line is `line` (MAIN lands on main itself), its work finished, and its landing queued. */
  async function queuedLanding(ownerId: string, workspace: { runnerId: string; workspaceId: string; fullName: string }, label: string, line: 'MAIN' | 'PROJECT_BRANCH' = 'MAIN') {
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `The project ${label} lands into` } });
    await prisma.projectCodebase.create({
      data: {
        ownerId, projectId, canonicalRepoUrl: `https://github.com/${workspace.fullName}.git`, upstreamRef: 'refs/heads/main',
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
    await prisma.session.create({
      data: {
        id: randomUUID(), ownerId, creatorId: ownerId, taskId: task.id, workspaceId: workspace.workspaceId,
        assignedRunnerId: workspace.runnerId, title: `ran ${label}`, prompt: 'do the work', branch: `orbit/pr-${task.id}`,
        isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, baseSha: SHA(`base-${label}`),
        changedFiles: WORK_REPORTED as never, createdAt: new Date(Date.now() - 2 * 86_400_000), finishedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    assert.ok(queued.enqueued, `no landing was queued: ${JSON.stringify(queued)}`);
    const job = await prisma.projectIntegrationJob.findFirstOrThrow({ where: { taskId: task.id, kind: 'LAND_TASK' }, select: { id: true } });
    return { projectId, taskId: task.id, jobId: job.id };
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
      sourceSha: SHA(`source-${command.jobId}`), targetShaBefore: SHA(`main-${command.jobId}`), upstreamSha: SHA(`main-${command.jobId}`),
      testedSha: head, testedTreeSha: tree, landingRefSha: head,
      pushRefusal: 'GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.',
      checks: [{ name: 'TASK_ACCEPTANCE' as const, command: 'true', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1200, outputTail: '' }],
    };
  }

  const job = (jobId: string) => prisma.projectIntegrationJob.findUniqueOrThrow({ where: { id: jobId } });

  return { prisma, sql, github, client, grants, relay, door, webhooks, webhookSecret, tasks, newOwner, newWorkspace, queuedLanding, beat, pullRequestResult, job };
}

const GRANTED = { contents: 'write', metadata: 'read', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', workflows: 'write' };

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IntegrationJobRefused) return error.code;
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
  const landingSession = await h.prisma.projectLanding.findFirstOrThrow({ where: { taskId: landing.taskId } });
  assert.equal(command?.landVia, 'PULL_REQUEST');
  assert.equal(command.landingRef, `refs/heads/orbit/land/${landingSession.sessionId}`);
  assert.equal(command.pullRequestOpen, undefined);
  const recorded = await h.job(landing.jobId);
  assert.equal(recorded.landVia, 'PULL_REQUEST');
  assert.equal(recorded.landingRef, command.landingRef);
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
  // It is in flight: never timed out, waiting for checks, and J3 holds the task's next landing.
  const [inFlight] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(inFlight?.state, 'PULL_REQUEST');
  assert.equal(inFlight.timedOut, false);
  assert.equal(inFlight.blockingReason?.code, 'WAITING_FOR_CHECKS');
  const again = await h.prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, landing.taskId));
  assert.equal(again.enqueued, false, 'J3: one landing in flight per task, a pull request included');

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
  pr = await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } });
  assert.equal(pr.state, 'OPEN');
  assert.equal(pr.number, h.github.pulls[0]!.number);
  assert.equal(pr.condition, 'CHECKS_PENDING');
  assert.ok(!h.github.calls.some((call) => call.method === 'PUT'), 'nothing was merged while the required checks ran');
  const [checking] = await readInFlightJobs(h.prisma as never, landing.projectId, command.jobId);
  assert.equal(checking?.pullRequest?.number, pr.number);
  assert.deepEqual(checking.pullRequest?.checks, { passed: 1, required: 2, failed: [] });

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
  const settled = await h.prisma.projectLanding.findFirstOrThrow({ where: { taskId: landing.taskId } });
  assert.equal(settled.settledAs, 'LANDED');
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
      status: RunStatus.SUCCEEDED, mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeTarget: 'main',
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

  // The runner's `pull_request` result left the Merge waiting (the controller's write, as recordMergePullRequest makes it).
  const head = SHA('session-head');
  const base = SHA('session-base');
  h.github.pushed.set(`orbit/land/${sessionId}`, head);
  const pr = await h.prisma.githubPullRequest.create({
    data: {
      ownerId, workspaceId: cloud.workspaceId, githubRepoId: BigInt(cloud.repoId), installationId: BigInt(cloud.installationId),
      sessionId, baseRef: 'refs/heads/main', headRef: `refs/heads/orbit/land/${sessionId}`, state: 'OPENING',
      headSha: head, baseSha: base, sourceSha: SHA('session-source'),
    },
  });
  await h.prisma.session.update({ where: { id: sessionId }, data: { mergeStatus: 'pull_request', mergePullRequestId: pr.id } });
  const scenario = h.github.scenario(cloud.fullName);
  scenario.mergeStateStatus = 'CLEAN';
  scenario.baseSha = base;
  scenario.mergeTree = () => SHA('session-tree');
  await h.door.advance([pr.id]);
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
  assert.equal((await h.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } })).state, 'MERGED');
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
