import { Prisma } from '@prisma/client';
import {
  isOrbitOwnedRef,
  landingRefFor,
  type IntegrationCheckResult,
  type IntegrationJobResultRequest,
  type LandVia,
  type LandingPullRequestView,
  type PullRequestCondition,
  type PullRequestMergeMethod,
  type PullRequestState,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { appendIntegrationJobEvent } from './project-integration-event';

/**
 * Landing on a protected GitHub branch through a pull request (docs/design/protected-branch-landing.md): the rows
 * and rules the control plane keeps. GitHub itself is reached by the pull request door
 * (`github/pull-request-door.service.ts`); the runner's half is `src/runner-go/integrate_pull_request.go`.
 */

const SHA40 = /^[0-9a-f]{40}$/;

/** The longest refusal kept, after redaction: GitHub's words for a refused direct push (§5.5). */
export const PUSH_REFUSAL_MAX = 1000;

// ── §3: how a landing's mode is chosen ──────────────────────────────────────────────────────────────────────────

/** What §3 decides on, read when the attempt is handed out. */
export interface LandingModeFacts {
  targetRef: string;
  /** The workspace the attempt runs in — the source session's — and whether it was cloned from GitHub. */
  githubRepoId: bigint | null;
  githubInstallationId: bigint | null;
  /** The runner it is handed to declared the capability (§9 item 7). */
  runnerDeclares: boolean;
  /** The installation granted the pull request permissions (§10); null when GitHub could not be asked. */
  permissionsGranted: boolean | null;
  /** The id the landing branch is named after: the landing session's, or a session's own for its Merge. Null for a
   *  job from before landing subjects (0436), which has nothing to name the branch or the pull request after. */
  landingKey: string | null;
  /** The subject's open pull request, which it finishes through whatever the rules say now (§3). */
  openPullRequest: { headSha: string | null } | null;
}

/** Which of §3's rules decided, for the logs and for a refusal that has to say what to fix. */
export type LandingModeRule =
  | 'OPEN_PULL_REQUEST'
  | 'ORBIT_BRANCH'
  | 'NOT_FROM_GITHUB'
  | 'RUNNER_OUTDATED'
  | 'PERMISSIONS_PENDING'
  | 'NO_LANDING_SUBJECT'
  | 'DEFAULT';

/** §3's answer, as the command carries it. */
export interface LandingMode {
  landVia: LandVia;
  rule: LandingModeRule;
  landingRef?: string;
  landingRefSha?: string;
  pullRequestOpen?: true;
}

/**
 * §3, in order. A subject with an open Orbit pull request finishes through it. Otherwise an Orbit branch, a workspace
 * not cloned from GitHub, a runner without the capability and an installation that has not accepted the permissions
 * all push as today (PUSH); every other GitHub landing pushes as today and opens a pull request when GitHub refuses
 * (PULL_REQUEST). Rule 4, Push as me, is the Push as me task's (§17 P3): until it lands, no workspace reads PUSH_AS_ME.
 */
export function landingModeOf(facts: LandingModeFacts): LandingMode {
  if (facts.openPullRequest && facts.landingKey && facts.runnerDeclares && facts.githubRepoId != null) {
    const sha = facts.openPullRequest.headSha;
    return {
      landVia: 'PULL_REQUEST',
      rule: 'OPEN_PULL_REQUEST',
      landingRef: landingRefFor(facts.landingKey),
      ...(sha && SHA40.test(sha) ? { landingRefSha: sha } : {}),
      pullRequestOpen: true,
    };
  }
  if (isOrbitOwnedRef(facts.targetRef)) return { landVia: 'PUSH', rule: 'ORBIT_BRANCH' };
  if (facts.githubRepoId == null || facts.githubInstallationId == null) return { landVia: 'PUSH', rule: 'NOT_FROM_GITHUB' };
  if (!facts.runnerDeclares) return { landVia: 'PUSH', rule: 'RUNNER_OUTDATED' };
  if (facts.permissionsGranted !== true) return { landVia: 'PUSH', rule: 'PERMISSIONS_PENDING' };
  if (!facts.landingKey) return { landVia: 'PUSH', rule: 'NO_LANDING_SUBJECT' };
  return { landVia: 'PULL_REQUEST', rule: 'DEFAULT', landingRef: landingRefFor(facts.landingKey) };
}

/** The wire fields a mode adds to a command, for a runner that declared the capability: none for one that did not. */
export function landingCommandFields(mode: LandingMode, runnerDeclares: boolean): {
  landVia?: LandVia; landingRef?: string; landingRefSha?: string; pullRequestOpen?: true;
} {
  if (!runnerDeclares) return {};
  return {
    landVia: mode.landVia,
    ...(mode.landingRef ? { landingRef: mode.landingRef } : {}),
    ...(mode.landingRefSha ? { landingRefSha: mode.landingRefSha } : {}),
    ...(mode.pullRequestOpen ? { pullRequestOpen: true as const } : {}),
  };
}

// ── §4.2 J-T14: a runner's PULL_REQUEST result ──────────────────────────────────────────────────────────────────

/** The job row J-T14 reads, beside the fence the result door already checked. */
export interface PullRequestResultJob {
  id: string;
  ownerId: string;
  projectId: string;
  kind: string;
  sessionId: string | null;
  targetRef: string;
  landingId: string | null;
  landVia: string | null;
  landingRef: string | null;
  claimGeneration: bigint;
  round: number | null;
}

/** Why a PULL_REQUEST result cannot be taken as it is, or null when it can (§4.2 J-T14). */
export function pullRequestResultRefusal(job: PullRequestResultJob, body: IntegrationJobResultRequest): string | null {
  if (job.kind !== 'LAND_TASK' && job.kind !== 'LAND_PROMOTION') return 'only a landing waits on a pull request';
  if (job.landVia !== 'PULL_REQUEST' && job.landVia !== 'PUSH_AS_ME') {
    return 'this attempt was not handed out to land through a pull request';
  }
  if (!job.landingRef || !job.landingId) return 'this attempt names no landing branch';
  for (const [field, value] of [
    ['testedSha', body.testedSha], ['testedTreeSha', body.testedTreeSha], ['landingRefSha', body.landingRefSha],
  ] as const) {
    if (typeof value !== 'string' || !SHA40.test(value)) return `a PULL_REQUEST result names its ${field} as a full sha`;
  }
  if (!SHA40.test(pullRequestBaseSha(job, body) ?? '')) return 'a PULL_REQUEST result names the target tip it was built on';
  return null;
}

/** The target tip the landing branch's commit was built and checked on: the target for a task, the upstream for a
 *  promotion (whose target is its upstream). */
function pullRequestBaseSha(job: Pick<PullRequestResultJob, 'kind'>, body: IntegrationJobResultRequest): string | null {
  return (job.kind === 'LAND_PROMOTION' ? body.upstreamSha ?? body.targetShaBefore : body.targetShaBefore) ?? null;
}

/** GitHub's words for a refused push, as a row keeps them: redacted, then clipped. */
export function storedRefusal(message: string | null | undefined): string | null {
  const said = (message ?? '').trim();
  if (said === '') return null;
  return redactSecrets(said).text.slice(0, PUSH_REFUSAL_MAX);
}

/**
 * J-T14's writes, in the result door's transaction and after its fence: the subject's pull request row — a new one
 * in OPENING, or the open one with its new head — and the job moved to PULL_REQUEST, holding no runner and no lease,
 * with the timeline's "Pushed <sha7> for a pull request". The door opens the pull request on GitHub after the commit.
 */
export async function recordPullRequestResult(
  tx: Prisma.TransactionClient,
  job: PullRequestResultJob,
  body: IntegrationJobResultRequest,
  checks: IntegrationCheckResult[],
  workspace: { id: string; githubRepoId: bigint; githubInstallationId: bigint },
): Promise<{ pullRequestId: string }> {
  const now = new Date();
  const headSha = body.landingRefSha as string;
  const baseSha = pullRequestBaseSha(job, body) as string;
  const message = storedRefusal(body.pushRefusal);
  const refusal = message ? { via: job.landVia, message, at: now.toISOString() } : null;
  // One open pull request per landing subject (`github_pull_request_open_landing_key`), taken FOR UPDATE beside the
  // job row this transaction already holds (rank 60).
  const [open] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "github_pull_request"
     WHERE "landing_id" = ${job.landingId}::uuid AND "state" IN ('OPENING', 'OPEN')
     FOR UPDATE`);
  let pullRequestId: string;
  if (open) {
    pullRequestId = open.id;
    await tx.githubPullRequest.update({
      where: { id: open.id },
      data: {
        headSha, baseSha, sourceSha: body.sourceSha ?? null, testedTreeSha: body.testedTreeSha as string,
        // What GitHub said about the old head no longer holds: the next read is the first about this one.
        condition: null, checks: [], observedAt: null,
        ...(refusal ? { refusal } : {}),
      },
    });
  } else {
    const created = await tx.githubPullRequest.create({
      data: {
        ownerId: job.ownerId,
        workspaceId: workspace.id,
        githubRepoId: workspace.githubRepoId,
        installationId: workspace.githubInstallationId,
        landingId: job.landingId,
        baseRef: job.targetRef,
        headRef: job.landingRef as string,
        state: 'OPENING',
        headSha,
        baseSha,
        sourceSha: body.sourceSha ?? null,
        testedTreeSha: body.testedTreeSha as string,
        ...(refusal ? { refusal } : {}),
      },
      select: { id: true },
    });
    pullRequestId = created.id;
  }
  await tx.projectIntegrationJob.update({
    where: { id: job.id },
    data: {
      state: 'PULL_REQUEST',
      phase: 'PUSH',
      sourceSha: body.sourceSha ?? undefined,
      targetShaBefore: body.targetShaBefore ?? undefined,
      upstreamSha: body.upstreamSha ?? undefined,
      mainSyncSha: body.mainSyncSha ?? undefined,
      testedSha: body.testedSha as string,
      testedTreeSha: body.testedTreeSha as string,
      aheadOfUpstream: body.aheadOfUpstream ?? undefined,
      checks: checks as unknown as Prisma.InputJsonValue,
      pullRequestId,
      // No runner holds it any more (§4.2): every later report of this claim is refused STALE_CLAIM, which stops it.
      claimLeaseOwner: null,
      heartbeatAt: now,
      step: null,
      currentCheck: Prisma.DbNull,
    },
  });
  await appendIntegrationJobEvent(tx, {
    jobId: job.id,
    key: `pull-request:pushed:${Number(job.claimGeneration)}`,
    kind: 'PULL_REQUEST',
    claim: Number(job.claimGeneration),
    round: job.round ?? null,
    phase: 'PUSH',
    actor: { type: 'RUNNER' },
    data: { step: 'PUSHED', headSha, landingRef: job.landingRef, ...(message ? { refusal: message } : {}) },
    text: `Pushed ${headSha.slice(0, 7)} for a pull request`,
  });
  return { pullRequestId };
}

// ── the read model (§8) ─────────────────────────────────────────────────────────────────────────────────────────

/** A pull request row as the read models take it. */
export interface PullRequestViewRow {
  number: number | null;
  url: string | null;
  state: string;
  condition: string | null;
  checks: unknown;
  mergeMethod: string | null;
  mergedSha: string | null;
  refusal: unknown;
}

/** One stored check, as the row keeps it (§7 `checks`). */
interface StoredCheck {
  name: string;
  required: boolean;
  state: 'PASSED' | 'FAILED' | 'PENDING';
  url: string | null;
}

function storedChecks(value: unknown): StoredCheck[] {
  if (!Array.isArray(value)) return [];
  return value.filter((check): check is StoredCheck =>
    !!check && typeof check === 'object' && typeof (check as StoredCheck).name === 'string');
}

/** The `pullRequest` block the landing view, a task's landing row, a project's in-flight jobs and a session carry. */
export function pullRequestViewOf(row: PullRequestViewRow): LandingPullRequestView {
  const required = storedChecks(row.checks).filter((check) => check.required);
  const refusal = row.refusal && typeof row.refusal === 'object'
    ? row.refusal as { via?: unknown; message?: unknown }
    : null;
  return {
    number: row.number,
    url: row.url,
    state: row.state as PullRequestState,
    condition: (row.condition as PullRequestCondition | null) ?? null,
    checks: {
      passed: required.filter((check) => check.state === 'PASSED').length,
      required: required.length,
      failed: required.filter((check) => check.state === 'FAILED').map((check) => ({ name: check.name, url: check.url ?? null })),
    },
    mergeMethod: (row.mergeMethod as PullRequestMergeMethod | null) ?? null,
    mergedSha: row.mergedSha,
    refusal: refusal && typeof refusal.message === 'string'
      ? { via: refusal.via === 'PUSH_AS_ME' ? 'PUSH_AS_ME' : 'PULL_REQUEST', message: refusal.message }
      : null,
  };
}

/** The columns `pullRequestViewOf` reads, for a Prisma select. */
export const PULL_REQUEST_VIEW_SELECT = {
  number: true, url: true, state: true, condition: true, checks: true, mergeMethod: true, mergedSha: true, refusal: true,
} as const;

/** The blocking reason a landing waiting on its pull request reads as (§8): its checks, or a review. */
export function pullRequestBlockingCode(condition: string | null): 'WAITING_FOR_CHECKS' | 'WAITING_FOR_REVIEW' {
  return condition === 'REVIEW_REQUIRED' || condition === 'CHANGES_REQUESTED' ? 'WAITING_FOR_REVIEW' : 'WAITING_FOR_CHECKS';
}

/**
 * The sentence a landing waiting on its pull request reads as (§11.2's drafts; the board task refines them): what it
 * waits for, on which pull request, and how far the required checks are.
 */
export function pullRequestWaitSummary(
  code: 'WAITING_FOR_CHECKS' | 'WAITING_FOR_REVIEW',
  pullRequest: LandingPullRequestView | null,
  mainBranch: string | null,
): string {
  const branch = mainBranch ?? 'main';
  if (!pullRequest || pullRequest.number === null) return `Opening a pull request: ${branch} requires one`;
  const which = `pull request #${pullRequest.number}`;
  if (code === 'WAITING_FOR_REVIEW') {
    return pullRequest.condition === 'CHANGES_REQUESTED'
      ? `Changes requested on ${which}`
      : `Waiting for review on ${which}`;
  }
  switch (pullRequest.condition) {
    case 'CHECK_FAILED':
      return `A required check failed on ${which}`;
    case 'BEHIND':
    case 'CONFLICTING':
      return `${branch} moved since ${which} was opened`;
    case 'MERGE_QUEUE':
      return `${branch} merges through a merge queue: add ${which} to it on GitHub`;
    case 'MERGEABLE':
      return `Merging ${which}`;
    default: {
      const { passed, required } = pullRequest.checks;
      return required > 0
        ? `Waiting for the required checks on ${which} · ${passed} of ${required}`
        : `Waiting for the required checks on ${which}`;
    }
  }
}
