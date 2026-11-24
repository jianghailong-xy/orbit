import { BadRequestException, ConflictException } from '@nestjs/common';
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
  type SessionMergeResultRequest,
  type WorkspaceLandingView,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { redactCheckOutput } from '../runner-api/check-output-redaction';
import { FAILURE_LINES_HEADING } from './landing-fix-turn';
import { appendIntegrationJobEvent } from './project-integration-event';
import { reportedLandingAuthority } from './task-checkpoint.service';

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
  /**
   * §3 rule 4: the workspace's landing mode is PUSH_AS_ME, the owner's GitHub connection is live, and the process can
   * carry the owner's token (it declared `push-as-me/v1` and, for an integration job, the claim is v2, whose push
   * boundary gates the token). Absent is false.
   */
  pushAsMe?: boolean;
}

/** Which of §3's rules decided, for the logs and for a refusal that has to say what to fix. */
export type LandingModeRule =
  | 'OPEN_PULL_REQUEST'
  | 'ORBIT_BRANCH'
  | 'NOT_FROM_GITHUB'
  | 'RUNNER_OUTDATED'
  | 'PERMISSIONS_PENDING'
  | 'NO_LANDING_SUBJECT'
  | 'PUSH_AS_ME'
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
 * (PULL_REQUEST), or, where the owner chose Push as me and it can be carried (rule 4), pushes the target with the
 * owner's own token and opens a pull request when GitHub refuses (PUSH_AS_ME).
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
  if (facts.pushAsMe) return { landVia: 'PUSH_AS_ME', rule: 'PUSH_AS_ME', landingRef: landingRefFor(facts.landingKey) };
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

// ── §5: Push as me ──────────────────────────────────────────────────────────────────────────────────────────────

/** The most rules a receipt keeps of GitHub's "Bypassed rule violations" lines, and the longest of each. */
export const BYPASSED_RULES_MAX = 20;
export const BYPASSED_RULE_MAX_CHARS = 300;

/** GitHub's "Bypassed rule violations" lines as a receipt keeps them: strings only, redacted and clipped. */
export function storedBypassedRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '')
    .slice(0, BYPASSED_RULES_MAX)
    .map((rule) => redactSecrets(rule.trim()).text.slice(0, BYPASSED_RULE_MAX_CHARS));
}

/**
 * §5.2's "pushed as the owner", for a LANDED result: the claim was handed out as PUSH_AS_ME, the credential door
 * answered the owner's token for this very claim generation, and the runner says the target push carried it. Any
 * one missing and the landing is recorded as it always was.
 */
export function pushedAsOwnerOf(
  job: { landVia: string | null; ownerTokenGeneration: bigint | null; claimGeneration: bigint },
  body: Pick<IntegrationJobResultRequest, 'pushedAs' | 'bypassedRules'>,
): { pushedAs: 'OWNER'; bypassedRules: string[] } | null {
  if (job.landVia !== 'PUSH_AS_ME' || body.pushedAs !== 'OWNER') return null;
  if (job.ownerTokenGeneration === null || job.ownerTokenGeneration !== job.claimGeneration) return null;
  return { pushedAs: 'OWNER', bypassedRules: storedBypassedRules(body.bypassedRules) };
}

/**
 * A workspace's `landing` block (§8, §11.1): its setting (null for a workspace not cloned from GitHub, which has no
 * choice), whether Push as me can be chosen and why not, and the last refusal GitHub gave a Push as me landing there.
 */
export function workspaceLandingView(
  workspace: { githubRepoId: bigint | null; landingMode: string | null; pushAsMeRefusal: unknown },
  githubConnected: boolean,
): WorkspaceLandingView {
  if (workspace.githubRepoId == null) {
    return { mode: null, pushAsMe: { available: false, reason: 'WORKSPACE_NOT_FROM_GITHUB' }, lastRefusal: null };
  }
  const raw = workspace.pushAsMeRefusal as { at?: unknown; branch?: unknown; message?: unknown } | null;
  const lastRefusal = raw && typeof raw === 'object' && typeof raw.message === 'string'
    && typeof raw.at === 'string' && typeof raw.branch === 'string'
    ? { at: raw.at, branch: raw.branch, message: raw.message }
    : null;
  return {
    mode: workspace.landingMode === 'PUSH_AS_ME' ? 'PUSH_AS_ME' : 'PULL_REQUEST',
    pushAsMe: githubConnected ? { available: true } : { available: false, reason: 'GITHUB_NOT_CONNECTED' },
    lastRefusal,
  };
}

// ── §4.5 J-T16: a required check that failed on the pull request ───────────────────────────────────────────────

/** The most failure lines a GitHub check's record keeps, and the longest one. */
const GITHUB_FAILURE_LINES = 40;
const GITHUB_FAILURE_LINE_CHARS = 300;
/** GitHub Actions' timestamp in front of every log line. */
const ACTIONS_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s?/;

/**
 * The lines of a failed check's log a person reads first (§4.5 "The log"): GitHub Actions' own `##[error]` lines when it
 * wrote any, else every line that says it errored or failed, the last {@link GITHUB_FAILURE_LINES} of them.
 */
export function githubFailureLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(ACTIONS_TIMESTAMP, '').trimEnd()).filter((line) => line.trim() !== '');
  const marked = lines.filter((line) => line.includes('##[error]'));
  const picked = marked.length > 0
    ? marked.map((line) => line.replace('##[error]', '').trim())
    : lines.filter((line) => /\b(error|errors|fail|failed|failure|failing|panic)\b/i.test(line));
  return picked.slice(-GITHUB_FAILURE_LINES).map((line) => (line.length > GITHUB_FAILURE_LINE_CHARS
    ? `${line.slice(0, GITHUB_FAILURE_LINE_CHARS - 1)}…`
    : line));
}

/**
 * One required check that failed on the pull request, as the job's `checks` keep it (J-T16): a GITHUB_CHECK whose
 * `outputTail` is the log's tail (or, for a check that is not a GitHub Actions job, what it said about itself),
 * followed by the failure lines under the heading the runner uses, so the landing-fix turn reads it as it reads a
 * runner's check. Redacted here; the result door clips it as it clips every check.
 */
export function githubCheckResult(input: {
  name: string;
  url: string | null;
  conclusion: string | null;
  /** The Actions job's log, when there is one. */
  log: string | null;
  /** What the check said about itself: a check run's title, summary and text, or a status's description. */
  summary: string | null;
  pullRequest: { number: number; url: string };
  headSha: string;
}): IntegrationCheckResult {
  const text = redactCheckOutput(input.log ?? input.summary ?? '');
  const lines = text === '' ? [] : input.log ? githubFailureLines(text) : text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, GITHUB_FAILURE_LINES);
  const tail = text.slice(-12_000);
  return {
    name: 'GITHUB_CHECK',
    command: input.name,
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 0,
    outputTail: [tail, ...(lines.length > 0 ? ['', FAILURE_LINES_HEADING, ...lines] : [])].join('\n'),
    github: {
      conclusion: input.conclusion ?? 'failure',
      url: input.url,
      pullRequest: input.pullRequest,
      headSha: input.headSha,
    },
  };
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
  workspaceId?: string | null;
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
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    refusal: refusal && typeof refusal.message === 'string'
      ? { via: refusal.via === 'PUSH_AS_ME' ? 'PUSH_AS_ME' : 'PULL_REQUEST', message: refusal.message }
      : null,
  };
}

/** The columns `pullRequestViewOf` reads, for a Prisma select. */
export const PULL_REQUEST_VIEW_SELECT = {
  number: true, url: true, state: true, condition: true, checks: true, mergeMethod: true, mergedSha: true, refusal: true, workspaceId: true,
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

// ── §4.6: a session's Merge that waits on a pull request ────────────────────────────────────────────────────────

/**
 * A session's Merge GitHub refused because of the target's rules, landed on the session's landing branch instead
 * (docs/design/protected-branch-landing.md §4.6 steps 2 and 3): the Merge now waits on a pull request. Called by the
 * merge result's own transaction, under its session row lock and after its operation fence: the session records
 * `pull_request` and the pull request row it waits on — a new one, or the open one with its new head. No receipt:
 * nothing has landed yet. The same `[K6]` §7 authority as a landing is asked first, since the pull request lands
 * exactly this source. Answers the row's id, for the door to open it after the commit.
 */
export async function recordSessionMergePullRequest(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    current: { ownerId: string; taskId: string | null; mergeCheckpointId: string | null; mergeRecoveryAction: string | null };
    dto: SessionMergeResultRequest;
    /** The result names the operation it reports on (the owner-bearing protocol). */
    modern: boolean;
  },
): Promise<string> {
  const { sessionId, current, dto } = input;
  const sha = (value: string | undefined) => {
    const v = (value ?? '').trim().toLowerCase();
    return SHA40.test(v) ? v : null;
  };
  const pushedSha = sha(dto.pushedSha);
  const sourceSha = sha(dto.sourceSha);
  const baseSha = sha(dto.rebaseBaseSha);
  const targetBranch = (dto.targetBranch ?? '').trim();
  if (!input.modern || current.mergeRecoveryAction) {
    throw new BadRequestException('only a claimed merge reports a pull request');
  }
  if (!pushedSha || !sourceSha || !baseSha || targetBranch === '') {
    throw new BadRequestException('a pull_request result names the pushed commit, the source, the base and the target');
  }
  const workspace = await tx.session.findUnique({
    where: { id: sessionId },
    select: { workspace: { select: { id: true, githubRepoId: true, githubInstallationId: true } } },
  }).then((row) => row?.workspace ?? null);
  if (!workspace?.githubRepoId || !workspace.githubInstallationId) {
    throw new ConflictException('this workspace was not cloned from GitHub, so a merge here cannot land through a pull request');
  }
  const authority = await reportedLandingAuthority(tx, {
    ownerId: current.ownerId, taskId: current.taskId, mergeCheckpointId: current.mergeCheckpointId, sourceSha,
  });
  if (authority.decision !== 'ALLOWED') throw new ConflictException(`${authority.decision}: ${authority.detail}`);
  const baseRef = `refs/heads/${targetBranch}`;
  const message = storedRefusal(dto.pushRefusal);
  // §5.4: a Merge handed out as PUSH_AS_ME says so, and its refusal is the owner's push that GitHub (or Orbit) refused.
  const via = dto.landVia === 'PUSH_AS_ME' ? 'PUSH_AS_ME' : 'PULL_REQUEST';
  const refusal = message ? { via, message, at: new Date().toISOString() } : null;
  // One open pull request per session (`github_pull_request_open_session_key`), beside the session row this
  // transaction holds (rank 30 → 60).
  const [open] = await tx.$queryRaw<Array<{ id: string; baseRef: string }>>(Prisma.sql`
    SELECT "id", "base_ref" AS "baseRef" FROM "github_pull_request"
     WHERE "session_id" = ${sessionId}::uuid AND "state" IN ('OPENING', 'OPEN')
     FOR UPDATE`);
  if (open && open.baseRef !== baseRef) {
    throw new ConflictException(`this session's pull request into ${open.baseRef.replace('refs/heads/', '')} is open: merge or close it before merging into ${targetBranch}`);
  }
  let pullRequestId: string;
  if (open) {
    pullRequestId = open.id;
    await tx.githubPullRequest.update({
      where: { id: open.id },
      data: { headSha: pushedSha, baseSha, sourceSha, condition: null, checks: [], observedAt: null, ...(refusal ? { refusal } : {}) },
    });
  } else {
    pullRequestId = (await tx.githubPullRequest.create({
      data: {
        ownerId: current.ownerId,
        workspaceId: workspace.id,
        githubRepoId: workspace.githubRepoId,
        installationId: workspace.githubInstallationId,
        sessionId,
        baseRef,
        headRef: landingRefFor(sessionId),
        state: 'OPENING',
        headSha: pushedSha,
        baseSha,
        sourceSha,
        ...(refusal ? { refusal } : {}),
      },
      select: { id: true },
    })).id;
  }
  // The one write of the session row in this transaction (I3).
  await tx.session.update({
    where: { id: sessionId },
    data: { mergeStatus: 'pull_request', mergeError: null, mergedAt: null, mergePullRequestId: pullRequestId },
  });
  return pullRequestId;
}
