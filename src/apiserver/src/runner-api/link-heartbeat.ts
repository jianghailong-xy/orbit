import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PlanUsage, RunnerHeartbeatRequest, RunnerHeartbeatResponse } from '@orbit/shared';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { sanitizeRunnerRepoHealth } from '../common/runner-repo-health';
import { sanitizeRunnerSelfUpdate } from '../common/runner-self-update';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { PREPARED_STATEMENT } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { sanitizePlanUsageAccounts } from '../providers/plan-usage-accounts';
import { countCodexResetSnapshotWrite } from '../runners/codex-reset-metrics';
import { storableBranchSha } from '../tasks/owner-confirmation-review';
import { mergeHeartbeatPlanUsage } from './codex-reset-plan-usage';
import { runnerLinkHintsOf, runnerLinkHintsSql, type RunnerLinkHintColumns, type RunnerLinkHints } from './runner-link-hints';
import { stripNul } from './strip-nul';

/**
 * A heartbeat the runner link's gateway forwarded, answered from runner_presence (docs/runner-link-design.md §5.7,
 * §6.5, §9; migrations 0444 and 0447).
 *
 * Over HTTPS every heartbeat reconciles in full: it rewrites the runner row with everything the runner reported and
 * runs some twenty reads and conditional updates for what it may hand the runner. Over the link a beat costs one
 * statement (readLinkBeat) unless something says otherwise. That statement admits the caller as RunnerAuthGuard
 * would (the runner exists, still holds the credential its link token was minted with, and its account is not
 * disabled), upserts the runner's presence row, and reads what the answer needs: whether the process still holds the
 * lease of every session it supervises, what waits for the runner (the HintState the gateway puts in HeartbeatAck), and
 * the runner's own settings. The beat then takes one of three answers (linkBeatVerdict):
 *
 *   QUIET   nothing changed: the answer hands out nothing (quietHeartbeatAnswer). One statement.
 *   REPORT  only the runner's report changed — its disk probes, its sessions' worktrees, its usage, its catalogues:
 *           those are written by one more statement (writeLinkBeatReports), and the answer is the quiet one.
 *   FULL    the beat reconciles in full, as an HTTPS beat does, and records what it covered (recordLinkReconcile).
 *
 * A beat reconciles in full when:
 *   - the presence row is new, or holds no record of a full reconcile (a crash or a failover empties the table: it is
 *     UNLOGGED), or the last one left something pending;
 *   - the runner's change count moved since (`changes`, which every writer of something a heartbeat delivers moves
 *     after its commit: RealtimeService.markRunnerChanged);
 *   - the beat says something that decides what it is handed (a DELIVERY fact, or the headers its process declared);
 *   - the process lost the lease of a session it supervises;
 *   - this runner's five-minute period turned over since the last one (periodicReconcileDue).
 *
 * A full reconcile that hands out anything, or leaves anything in flight that a beat renews or settles — a merge or a
 * commit pending, a cancellation still drained, an integration job or a repository operation queued or running, a
 * Codex reset under way, a relay slot in flight — records no reconcile, so the next beat reconciles in full again,
 * as every HTTPS beat does: redelivery and renewal keep their contracts.
 */

/** What a change in one member of a heartbeat's body means for a beat answered from runner_presence. */
export type HeartbeatFactRole =
  /** It decides what the heartbeat hands the runner, or its change runs more than a write: a changed value reconciles in full. */
  | 'DELIVERY'
  /** The runner's report, kept where the heartbeat keeps it, which nothing the heartbeat hands out depends on: a
   *  changed value is written by writeLinkBeatReports, and nothing is drained. */
  | 'REPORT'
  /** The heartbeat route does not read it. */
  | 'UNREAD';

/**
 * Every member of a heartbeat's body (RunnerHeartbeatRequest, @orbit/shared), classified. The type holds it to the
 * interface, so a member added there does not compile until it is classified here.
 *
 *   leaseOwner, draining, supervisedSessionIds   whose merges, commits, integration jobs, repository operations and
 *                                                Codex resets the beat claims, and which leases it reports lost.
 *   engines                                      its change runs the signed-out notice and the finished-install
 *                                                cleanup, which read the runner row first.
 *   expiredCommitErrors                          rare, and it clears session rows the worktree snapshots write too:
 *                                                one statement cannot write a row twice.
 *   managedWorkload                              a managed runner's beat always reconciles in full.
 *   the rest but idleCapacity                    reports: the runner row's catalogues and state, its plan usage, its
 *                                                sessions' worktrees, its workspaces' directories.
 */
export const HEARTBEAT_FACTS = {
  status: 'REPORT',
  idleCapacity: 'UNREAD',
  version: 'REPORT',
  leaseOwner: 'DELIVERY',
  supervisedSessionIds: 'DELIVERY',
  expiredCommitErrors: 'DELIVERY',
  draining: 'DELIVERY',
  commands: 'REPORT',
  skills: 'REPORT',
  planUsage: 'REPORT',
  modelCatalog: 'REPORT',
  engines: 'DELIVERY',
  runtimeDefaultModels: 'REPORT',
  sessions: 'REPORT',
  agentDirProbes: 'REPORT',
  repos: 'REPORT',
  runsAsRoot: 'REPORT',
  reposRoot: 'REPORT',
  selfUpdate: 'REPORT',
  managedWorkload: 'DELIVERY',
} as const satisfies { [K in keyof Required<RunnerHeartbeatRequest>]: HeartbeatFactRole };

export type HeartbeatFactKind = keyof typeof HEARTBEAT_FACTS;

/** The pseudo-kind under which the headers a process declared (capabilities, engines, OS) are kept. */
export const HEADERS_FACT = '@headers';

/** The kinds the runner row is written from; unchanged, a full reconcile leaves the row as it is (item 4 of O1). */
export const RUNNER_ROW_FACTS: readonly string[] = [
  'status', 'version', 'leaseOwner', 'draining', 'commands', 'skills', 'modelCatalog', 'engines', 'runtimeDefaultModels',
  'repos', 'runsAsRoot', 'reposRoot', 'selfUpdate', 'managedWorkload', HEADERS_FACT,
];

/**
 * How a beat answered from runner_presence learns that it has something to hand out, for every member of the
 * heartbeat's answer (RunnerHeartbeatResponse, @orbit/shared, and the link's linkHints):
 *
 *   MARKED        its writers move the runner's change count after their commit; `writers` names each, and
 *                 link-heartbeat.spec.ts holds each to calling one of the marking functions.
 *   EVERY_BEAT    the beat statement reads it on every beat.
 *   IN_PROCESS    it is held in this process, which every beat asks.
 *   FULL_ONLY     only a beat that reconciles in full can carry it, and those runners always do.
 *
 * `pending` says what keeps a runner reconciling in full while the field is in flight (heartbeatAnswerHandsOut,
 * readLinkReconcilePending), as every HTTPS beat does: redelivery and renewal keep their contracts.
 */
export const HEARTBEAT_DELIVERIES = {
  cancelSessionIds: {
    how: 'MARKED',
    writers: [
      'sessions/sessions.service.ts#publishEndIntent', 'realtime/reaper.service.ts#forceFinalize',
      'realtime/reaper.service.ts#endParked', 'runner-api/runner-api.controller.ts#turnComplete',
    ],
    pending: 'drained for an hour, or until five minutes after its session finished: every full answer carries it',
  },
  leaseLostSessionIds: { how: 'EVERY_BEAT', reads: 'the lease of every supervised session, by the leaseLostSessionIds rule' },
  maxConcurrent: { how: 'EVERY_BEAT', reads: 'runner.max_concurrent, which the quiet answer carries' },
  minFreeDiskMb: { how: 'EVERY_BEAT', reads: 'runner.min_free_disk_mb, which the quiet answer carries' },
  mergeRequests: {
    how: 'MARKED',
    writers: ['sessions/sessions.service.ts#mergeToMain', 'sessions/sessions.service.ts#checkAfterRepairTurn'],
    pending: 'a merge pending on any session of the runner, whichever process holds it',
  },
  commitRequests: {
    how: 'MARKED',
    writers: ['sessions/sessions.service.ts#commitWorktree'],
    pending: 'a commit pending on any session of the runner, whichever process holds it',
  },
  artifactRequests: {
    how: 'MARKED',
    writers: ['sessions/sessions.service.ts#getWorktreeFileForOwner', 'sessions/sessions.service.ts#enqueueLegacyArtifactRequest'],
    pending: 'every full answer carries a request until its turn is answered',
  },
  loginRequest: {
    how: 'MARKED',
    writers: ['runners/runners.service.ts#startLogin', 'runners/runners.service.ts#submitLoginCode', 'runners/runners.service.ts#cancelLogin'],
    pending: 'a sign-in in flight',
  },
  accountRemoveRequest: { how: 'MARKED', writers: ['runners/runners.service.ts#removeAccount'], pending: 'a removal pending' },
  codexAccountRemoveRequest: { how: 'MARKED', writers: ['runners/runners.service.ts#removeAccount'], pending: 'a removal pending' },
  installRequest: {
    how: 'MARKED',
    writers: ['runners/runners.service.ts#startInstall', 'runners/runners.service.ts#startEngineUpdate'],
    pending: 'an install or an update in flight',
  },
  agentDirs: {
    how: 'MARKED',
    writers: ['workspaces/workspaces.service.ts#create', 'workspaces/workspaces.service.ts#update', 'workspaces/workspaces.service.ts#remove'],
  },
  repoCleanupRequest: { how: 'MARKED', writers: ['workspaces/workspaces.service.ts#requestRepoCleanup'], pending: 'a clean-up pending' },
  refreshModelCatalog: { how: 'MARKED', writers: ['runners/runners.service.ts#requestModelCatalogRefresh'], pending: 'until a beat claims it' },
  checkSelfUpdate: { how: 'MARKED', writers: ['runners/runners.service.ts#requestSelfUpdate'], pending: 'until a beat claims it' },
  codexRateLimitResetRequest: {
    how: 'MARKED',
    writers: ['runners/codex-rate-limit-reset.service.ts#create'],
    pending: 'an operation of the runner still active: every beat renews, settles or takes over its claim',
  },
  claudeHistoryRequest: { how: 'MARKED', writers: ['runners/runners.service.ts#requestClaudeHistory'], pending: 'a scan pending or running' },
  integrationJobs: {
    how: 'MARKED',
    writers: [
      'projects/project-integration-job.ts#queueLandTask', 'projects/project-integration-job.ts#queuePromotionJob',
      'runner-api/runner-api.controller.ts#integrationJobRelease', 'queue/dispatch-pause.service.ts#wake',
    ],
    pending: 'a job of the runner queued or running: every beat may claim it, hand it out again or take it over',
  },
  wikiRepoOps: {
    how: 'MARKED',
    writers: ['wiki-worker/wiki-repo-ops.ts#enqueueWikiRepoOp'],
    pending: 'an operation of the runner queued or running',
  },
  managedSleep: { how: 'FULL_ONLY', reads: 'a managed runner is admitted by RunnerAuthGuard and reconciles in full on every beat' },
  cursorKeyChecks: { how: 'IN_PROCESS', reads: 'cursorKeyCheckRelay, asked on every beat (providers.service.ts#checkCursorKey also marks)' },
  linkHints: { how: 'EVERY_BEAT', reads: 'readRunnerLinkHints in the beat statement; watchers and the release in this process' },
} as const satisfies Record<keyof Required<RunnerHeartbeatResponse> | 'linkHints', HeartbeatDelivery>;

export type HeartbeatDelivery =
  | { how: 'MARKED'; writers: readonly string[]; pending?: string }
  | { how: 'EVERY_BEAT' | 'IN_PROCESS' | 'FULL_ONLY'; reads: string };

// ── Digests ──────────────────────────────────────────────────────────────────────────────────────────────

/** 96 bits of SHA-256, which is plenty to tell one report from the next and keeps the stored map small. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 16);
}

/** The headers a process declares on every call, which decide what each drain hands it. */
export interface LinkBeatHeaders {
  capabilities?: string | string[];
  providers?: string;
  os?: string;
}

/** What a beat says, kind by kind, and the part of it that decides what it is handed. */
export interface LinkBeatDigests {
  /** One digest per member of the body it carries (HEARTBEAT_FACTS, UNREAD ones left out), and HEADERS_FACT. */
  facts: Record<string, string>;
  /** The DELIVERY members' digests and the headers', as one. */
  delivery: string;
}

/**
 * The digests of a beat. The supervised sessions are taken as a set: a runner that lists them in another order says
 * the same thing. A member the body leaves out has no digest; one it sends as null has the digest of null, which is
 * not the same thing (an absent member keeps or clears what the server holds).
 */
export function linkBeatDigests(dto: RunnerHeartbeatRequest | null | undefined, headers: LinkBeatHeaders): LinkBeatDigests {
  const facts: Record<string, string> = {};
  const body = (dto ?? {}) as Record<string, unknown>;
  for (const kind of Object.keys(HEARTBEAT_FACTS) as HeartbeatFactKind[]) {
    if (HEARTBEAT_FACTS[kind] === 'UNREAD' || !Object.prototype.hasOwnProperty.call(body, kind)) continue;
    let value = body[kind];
    if (value === undefined) continue;
    if (kind === 'supervisedSessionIds' && Array.isArray(value)) {
      value = [...new Set(value.map((id) => (typeof id === 'string' ? id.toLowerCase() : id)))].sort();
    }
    if (kind === 'leaseOwner' && typeof value === 'string') value = value.toLowerCase();
    facts[kind] = digest(JSON.stringify(value) ?? 'undefined');
  }
  facts[HEADERS_FACT] = digest(JSON.stringify([headers.capabilities ?? null, headers.providers ?? null, headers.os ?? null]));
  const delivery = digest(
    [HEADERS_FACT, ...(Object.keys(HEARTBEAT_FACTS) as HeartbeatFactKind[]).filter((k) => HEARTBEAT_FACTS[k] === 'DELIVERY')]
      .sort()
      .map((kind) => `${kind}=${facts[kind] ?? '-'}`)
      .join(';'),
  );
  return { facts, delivery };
}

/** The facts map as runner_presence.facts_hash keeps it: JSON, kinds in a fixed order. */
export function factsHashOf(facts: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(facts).sort().map((kind) => [kind, facts[kind]])));
}

/** facts_hash read back; anything that is not the JSON object factsHashOf writes reads as no record. */
export function readFactsHash(stored: string | null | undefined): Record<string, string> | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [kind, value] of Object.entries(parsed)) if (typeof value === 'string') out[kind] = value;
    return out;
  } catch {
    return null;
  }
}

/** runner_presence.reconcile_hash for a full reconcile that covered `delivery` and change count `changes`. */
export function reconcileHashOf(delivery: string, changes: string): string {
  return `${delivery}:${changes}`;
}

/** The REPORT kinds whose digest differs from what was stored: the reports a beat writes. */
export function changedReports(stored: Record<string, string>, now: Record<string, string>): HeartbeatFactKind[] {
  return (Object.keys(HEARTBEAT_FACTS) as HeartbeatFactKind[]).filter(
    (kind) => HEARTBEAT_FACTS[kind] === 'REPORT' && stored[kind] !== now[kind],
  );
}

// ── The five-minute period ───────────────────────────────────────────────────────────────────────────────

/** How often a link heartbeat reconciles in full when nothing says it must (design §5.7). */
export const LINK_RECONCILE_EVERY_MS = 5 * 60_000;

/**
 * Where in each five minutes this runner's periodic reconcile falls: spread by its id, so a fleet whose presence rows a
 * failover emptied — every runner reconciling within the same half minute — does not reconcile together again.
 */
export function reconcilePhaseMs(runnerId: string): number {
  return parseInt(createHash('sha256').update(runnerId.toLowerCase()).digest('hex').slice(0, 8), 16) % LINK_RECONCILE_EVERY_MS;
}

/**
 * Whether this runner's period turned over since its last full reconcile: at most five minutes after it, and every
 * five minutes while nothing else asks for one. Both instants are the database's clock.
 */
export function periodicReconcileDue(runnerId: string, reconciledAtMs: number, nowMs: number): boolean {
  const phase = reconcilePhaseMs(runnerId);
  return Math.floor((nowMs - phase) / LINK_RECONCILE_EVERY_MS) > Math.floor((reconciledAtMs - phase) / LINK_RECONCILE_EVERY_MS);
}

// ── The beat statement ───────────────────────────────────────────────────────────────────────────────────

/** What readLinkBeat is asked: the caller as its link token names it, and what the beat says. */
export interface LinkBeatInput {
  runnerId: string;
  ownerId: string;
  /** The link token's `credential` claim: the fingerprint of the runner credential it was minted with. */
  credential: string;
  /** The beating process (the heartbeat's leaseOwner); null for none. */
  processId: string | null;
  gatewayId: string | null;
  /** Every session id the body names, for the landing check (§2.9 LS6), in lower case. */
  namedSessionIds: string[];
  /** The supervised sessions, in lower case; their leases are checked when processId is set. */
  supervisedSessionIds: string[];
  /** The beat's planUsage digest: the stored plan usage is read only when the stored digest differs. */
  planUsageDigest: string | null;
}

/** One row of the beat statement; none when the runner does not exist or is not the token's owner's. */
export interface LinkBeatRow extends RunnerLinkHintColumns {
  credentialHeld: boolean;
  ownerDisabled: boolean;
  managed: boolean;
  landingNamed: boolean;
  maxConcurrent: number;
  minFreeDiskMb: number | null;
  /** Whether the presence row was written: false for a caller refused above, and for a managed runner. */
  beaten: boolean;
  inserted: boolean | null;
  changes: string | null;
  factsHash: string | null;
  reconcileHash: string | null;
  reconciledMs: number | null;
  nowMs: number;
  leasesHeld: number;
  planUsageRead: boolean;
  planUsage: unknown;
}

const OPEN_STATUSES_SQL = Prisma.raw(OPEN_SESSION_STATUSES.map((status) => `'${status}'`).join(', '));

/**
 * The beat, in one statement. Admits the caller exactly as RunnerAuthGuard does for a link call — the runner exists,
 * its credential is still the one the token was minted with (the fingerprint migration 0443's trigger computes), its
 * account is not disabled — and refuses a body naming a LANDING session (§2.9 LS6) before anything is written. A
 * managed runner's beat writes nothing here: RunnerAuthGuard admits it, with its instance, and it reconciles in full.
 *
 * Then it upserts the presence row — the process, the gateway node, the beat, LINK — leaving the change count and the
 * reconcile record as they are, and reads what the answer needs: the record, how many of the supervised sessions this
 * process still holds the lease of (the leaseLostSessionIds rule: assigned to the runner, open, a conversation, leased
 * to this process), what waits for the runner (readRunnerLinkHints' three columns), the runner's settings, and the
 * stored plan usage when the beat's differs from what was last stored.
 *
 * It is sent as a named prepared statement (PREPARED_STATEMENT, prisma-client.ts), whose text is one of two as the
 * beat carries a plan usage or not: unnamed, PostgreSQL parsed and planned it on every beat, 1.6 ms of database CPU
 * against 0.2 ms named.
 */
export async function readLinkBeat(prisma: Pick<PrismaService, '$queryRaw'>, input: LinkBeatInput): Promise<LinkBeatRow | null> {
  const storedPlanUsageDigest = Prisma.sql`substring(b."factsHash" from '"planUsage":"([A-Za-z0-9_-]+)"')`;
  const readPlanUsage = input.planUsageDigest === null
    ? Prisma.sql`false`
    : Prisma.sql`(b."factsHash" IS NOT NULL AND ${storedPlanUsageDigest} IS DISTINCT FROM ${input.planUsageDigest}::text)`;
  const credentialHeld = Prisma.sql`substr(encode(sha256(convert_to('orbit-runner-link:' || r."token_hash", 'UTF8')), 'hex'), 1, 32) = ${input.credential}::text`;
  const landingNamed = Prisma.sql`EXISTS (SELECT 1 FROM "session" s WHERE s."id" = ANY(${input.namedSessionIds}::uuid[]) AND s."owner_id" = r."owner_id" AND s."kind" = 'LANDING')`;
  const rows = await prisma.$queryRaw<LinkBeatRow[]>`${Prisma.raw(PREPARED_STATEMENT)}
    WITH caller AS (
      SELECT r."id", r."max_concurrent" AS "maxConcurrent", r."min_free_disk_mb" AS "minFreeDiskMb",
             ${credentialHeld} AS "credentialHeld", u."disabled_at" IS NOT NULL AS "ownerDisabled",
             EXISTS (SELECT 1 FROM "managed_runner" m WHERE m."runner_id" = r."id") AS "managed", ${landingNamed} AS "landingNamed"
        FROM "runner" r JOIN "user" u ON u."id" = r."owner_id"
       WHERE r."id" = ${input.runnerId}::uuid AND r."owner_id" = ${input.ownerId}::uuid
    ),
    beat AS (
      INSERT INTO "runner_presence" ("runner_id", "process_id", "gateway_id", "last_beat_at", "link_state")
      SELECT c."id", ${input.processId}::uuid, ${input.gatewayId}::text, (now() AT TIME ZONE 'UTC'), 'LINK'
        FROM caller c
       WHERE c."credentialHeld" AND NOT c."ownerDisabled" AND NOT c."managed" AND NOT c."landingNamed"
      ON CONFLICT ("runner_id") DO UPDATE
         SET "process_id" = EXCLUDED."process_id",
             "gateway_id" = EXCLUDED."gateway_id",
             "last_beat_at" = EXCLUDED."last_beat_at",
             "link_state" = EXCLUDED."link_state"
      RETURNING "changes"::text AS "changes",
                "facts_hash" AS "factsHash",
                "reconcile_hash" AS "reconcileHash",
                (extract(epoch FROM "reconciled_at") * 1000)::float8 AS "reconciledMs",
                (xmax = 0) AS "inserted"
    )
    SELECT c."credentialHeld", c."ownerDisabled", c."managed", c."landingNamed", c."maxConcurrent", c."minFreeDiskMb",
           (b."changes" IS NOT NULL) AS "beaten", b."inserted", b."changes", b."factsHash", b."reconcileHash", b."reconciledMs",
           (extract(epoch FROM now()) * 1000)::float8 AS "nowMs",
           (SELECT count(*)::int FROM "session" s
             WHERE s."id" = ANY(${input.supervisedSessionIds}::uuid[])
               AND s."assigned_runner_id" = c."id"
               AND s."status" IN (${OPEN_STATUSES_SQL})
               AND s."kind" = 'CONVERSATION'
               AND s."inbox_lease_owner" = ${input.processId}::uuid) AS "leasesHeld",
           ${readPlanUsage} AS "planUsageRead",
           CASE WHEN ${readPlanUsage} THEN (SELECT r."plan_usage" FROM "runner" r WHERE r."id" = c."id") END AS "planUsage",
           ${runnerLinkHintsSql(input.runnerId)}
      FROM caller c
      LEFT JOIN beat b ON true
  `;
  return rows[0] ?? null;
}

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────────────

/** Why a beat reconciles in full. */
export type LinkReconcileReason =
  /** The presence row is new, holds no reconcile, or the last one left something pending. */
  | 'NO_RECORD'
  /** The process lost the lease of a session it supervises. */
  | 'LEASE'
  /** Something a heartbeat delivers changed (the runner's change count moved). */
  | 'CHANGED'
  /** The beat says something that decides what it is handed. */
  | 'INPUTS'
  /** The runner's five-minute period turned over. */
  | 'PERIOD';

export type LinkBeatVerdict =
  | { answer: 'QUIET' }
  | { answer: 'REPORT'; reports: HeartbeatFactKind[] }
  | { answer: 'FULL'; reason: LinkReconcileReason };

/** How a beat the beat statement admitted is answered. */
export function linkBeatVerdict(
  runnerId: string,
  row: Pick<LinkBeatRow, 'inserted' | 'changes' | 'factsHash' | 'reconcileHash' | 'reconciledMs' | 'nowMs' | 'leasesHeld'>,
  digests: LinkBeatDigests,
  leasesSupervised: number,
): LinkBeatVerdict {
  const stored = readFactsHash(row.factsHash);
  const [storedDelivery, storedChanges] = (row.reconcileHash ?? '').split(':');
  if (row.inserted || row.reconciledMs === null || !row.reconcileHash || !stored || !storedDelivery || storedChanges === undefined) {
    return { answer: 'FULL', reason: 'NO_RECORD' };
  }
  if (row.leasesHeld < leasesSupervised) return { answer: 'FULL', reason: 'LEASE' };
  if (storedChanges !== row.changes) return { answer: 'FULL', reason: 'CHANGED' };
  if (storedDelivery !== digests.delivery) return { answer: 'FULL', reason: 'INPUTS' };
  if (periodicReconcileDue(runnerId, row.reconciledMs, row.nowMs)) return { answer: 'FULL', reason: 'PERIOD' };
  const reports = changedReports(stored, digests.facts);
  return reports.length > 0 ? { answer: 'REPORT', reports } : { answer: 'QUIET' };
}

/**
 * The answer to a beat that reconciled nothing: what a full reconcile answers a runner it has nothing for, so the
 * runner, applying it as any heartbeat answer, changes nothing. No command; the runner's own settings as they stand;
 * and no `agentDirs`, which a runner reads as "keep scanning the directories you have" — a full reconcile names them.
 */
export function quietHeartbeatAnswer(
  row: Pick<LinkBeatRow, 'maxConcurrent' | 'minFreeDiskMb'>,
  extra: Pick<RunnerHeartbeatResponse, 'cursorKeyChecks'> & { linkHints?: RunnerLinkHints },
): RunnerHeartbeatResponse & { linkHints?: RunnerLinkHints } {
  return {
    cancelSessionIds: [],
    leaseLostSessionIds: [],
    maxConcurrent: row.maxConcurrent,
    minFreeDiskMb: row.minFreeDiskMb,
    mergeRequests: [],
    commitRequests: [],
    artifactRequests: [],
    ...(extra.cursorKeyChecks && extra.cursorKeyChecks.length > 0 ? { cursorKeyChecks: extra.cursorKeyChecks } : {}),
    ...(extra.linkHints ? { linkHints: extra.linkHints } : {}),
  };
}

/** The HintState columns of a beat row, as RunnerLinkHints reads them. */
export function linkBeatHints(row: RunnerLinkHintColumns): Pick<RunnerLinkHints, 'inboxSessionIds' | 'claim' | 'approvals'> {
  return runnerLinkHintsOf(row);
}

// ── The report statement ─────────────────────────────────────────────────────────────────────────────────

/** What writeLinkBeatReports needs beyond the body. */
export interface LinkReportInput {
  runnerId: string;
  leaseOwner: string | null;
  dto: RunnerHeartbeatRequest;
  reports: readonly HeartbeatFactKind[];
  digests: LinkBeatDigests;
  /** facts_hash as the beat statement read it. */
  storedFacts: Record<string, string>;
  /** The plan usage stored when the beat statement read it (planUsageRead), to compare and set against. */
  storedPlanUsage: unknown;
  now: Date;
}

/** Why a report cannot go into one statement; the beat then reconciles in full, which writes it as HTTPS does. */
export class LinkReportUnwritable extends Error {}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes the reports a beat changed, in one statement, as a full reconcile writes them: the heartbeat route's runner
 * row write for the catalogues and state, storeHeartbeatPlanUsage's compare-and-set for the plan usage, the worktree
 * snapshots with their merged-branch reconcile, and the directory probes with the repository address they teach. It
 * stores their digests beside the others in facts_hash. Nothing is drained and nothing is handed out.
 *
 * The plan usage is merged against the value the beat statement read and written only while that is still the stored
 * value. A lost race keeps the old digest, so the next beat writes it again against the value that won. A report this
 * cannot write as one statement — a value of a type the row would refuse, an id that is not a UUID — throws
 * LinkReportUnwritable before anything is written, and the beat reconciles in full instead.
 */
export async function writeLinkBeatReports(
  prisma: Pick<PrismaService, '$queryRaw'>,
  input: LinkReportInput,
): Promise<{ planUsageStored: boolean }> {
  const { dto } = input;
  const has = (kind: HeartbeatFactKind) => input.reports.includes(kind);
  const sets: Prisma.Sql[] = [];
  const json = (column: string, value: unknown) => {
    if (value !== undefined) sets.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ${JSON.stringify(value)}::jsonb`);
  };
  if (has('status')) {
    const status = dto.status ?? 'ONLINE';
    if (typeof status !== 'string') throw new LinkReportUnwritable('status is not a string');
    sets.push(Prisma.sql`"status" = CAST(${status}::text AS "runner_status")`);
  }
  if (has('version') && dto.version != null) {
    if (typeof dto.version !== 'string') throw new LinkReportUnwritable('version is not a string');
    sets.push(Prisma.sql`"version" = ${dto.version}::text`);
  }
  if (has('commands')) json('available_commands', stripNul(dto.commands ?? undefined));
  if (has('skills')) json('available_skills', stripNul(dto.skills ?? undefined));
  if (has('modelCatalog')) json('model_catalog', stripNul(dto.modelCatalog ?? undefined));
  if (has('runtimeDefaultModels') && dto.runtimeDefaultModels != null) {
    json('runtime_default_models', sanitizeRuntimeDefaultModels(dto.runtimeDefaultModels));
  }
  if (has('repos') && dto.repos != null) json('repo_health', sanitizeRunnerRepoHealth(dto.repos) ?? []);
  if (has('runsAsRoot') && dto.runsAsRoot != null) {
    if (typeof dto.runsAsRoot !== 'boolean') throw new LinkReportUnwritable('runsAsRoot is not a boolean');
    sets.push(Prisma.sql`"runs_as_root" = ${dto.runsAsRoot}::boolean`);
  }
  if (has('reposRoot') && dto.reposRoot) {
    if (typeof dto.reposRoot !== 'string') throw new LinkReportUnwritable('reposRoot is not a string');
    sets.push(Prisma.sql`"repos_root" = ${dto.reposRoot}::text`);
  }
  if (has('selfUpdate')) {
    const selfUpdate = sanitizeRunnerSelfUpdate(dto.selfUpdate);
    sets.push(selfUpdate ? Prisma.sql`"self_update" = ${JSON.stringify(selfUpdate)}::jsonb` : Prisma.sql`"self_update" = NULL`);
  }
  let planUsage: { merged: string; order: ReturnType<typeof mergeHeartbeatPlanUsage>['order'] } | null = null;
  if (has('planUsage') && dto.planUsage != null) {
    const merge = mergeHeartbeatPlanUsage(
      input.storedPlanUsage,
      sanitizePlanUsageAccounts(dto.planUsage as PlanUsage),
      input.leaseOwner,
      input.now,
    );
    planUsage = { merged: JSON.stringify(merge.planUsage), order: merge.order };
    const unchanged = input.storedPlanUsage == null
      ? Prisma.sql`(r."plan_usage" IS NULL OR r."plan_usage" = 'null'::jsonb)`
      : Prisma.sql`r."plan_usage" = ${JSON.stringify(input.storedPlanUsage)}::jsonb`;
    sets.push(Prisma.sql`"plan_usage" = CASE WHEN ${unchanged} THEN ${planUsage.merged}::jsonb ELSE r."plan_usage" END`);
  }
  // One statement runs its data-modifying CTEs in no order of its own. These take their rows in the order every other
  // writer of them does (common/lock-order.ts): the workspaces (rank 15), then the sessions (rank 30), then the runner
  // row — which the inbox, the one transaction holding both, takes FOR SHARE after its session — and the presence row
  // last. Each CTE's WHERE reads the RETURNING of the one before it, an InitPlan that runs that one to completion first.
  const ctes: Prisma.Sql[] = [];
  let previous: string | null = null;
  const after = () => (previous ? Prisma.sql`(SELECT count(*) FROM ${Prisma.raw(previous)}) >= 0` : Prisma.sql`true`);
  if (has('agentDirProbes') && Array.isArray(dto.agentDirProbes) && dto.agentDirProbes.length > 0) {
    ctes.push(Prisma.sql`probes AS (${directoryProbesSql(input.runnerId, dto.agentDirProbes, after())}), `);
    previous = 'probes';
  }
  if (has('sessions') && Array.isArray(dto.sessions) && dto.sessions.length > 0) {
    ctes.push(Prisma.sql`snapshots AS (${worktreeSnapshotsSql(input.runnerId, input.leaseOwner, dto.sessions, after())}), `);
    previous = 'snapshots';
  }
  if (sets.length > 0) {
    const stored = planUsage ? Prisma.sql`r."plan_usage" IS NOT DISTINCT FROM ${planUsage.merged}::jsonb` : Prisma.sql`true`;
    ctes.push(Prisma.sql`runner_row AS (
      UPDATE "runner" r SET ${Prisma.join(sets, ', ')}
       WHERE r."id" = ${input.runnerId}::uuid AND ${after()}
      RETURNING ${stored} AS "planUsageStored"
    ), `);
    previous = 'runner_row';
  }
  // Every kind's digest as this beat says it; but planUsage's stays as it was when its compare-and-set lost.
  const planUsageStored = planUsage
    ? Prisma.sql`COALESCE((SELECT "planUsageStored" FROM runner_row), false)`
    : Prisma.sql`true`;
  const kept = { ...input.digests.facts };
  if (input.storedFacts.planUsage === undefined) delete kept.planUsage;
  else kept.planUsage = input.storedFacts.planUsage;
  const rows = await prisma.$queryRaw<Array<{ planUsageStored: boolean }>>`
    WITH ${Prisma.join(ctes, '')}facts AS (
      UPDATE "runner_presence" p
         SET "facts_hash" = CASE WHEN ${planUsageStored} THEN ${factsHashOf(input.digests.facts)}::text ELSE ${factsHashOf(kept)}::text END
       WHERE p."runner_id" = ${input.runnerId}::uuid AND ${after()}
      RETURNING 1
    )
    SELECT ${planUsageStored} AS "planUsageStored", (SELECT count(*) FROM facts)::int AS "recorded"
  `;
  const written = rows[0]?.planUsageStored === true;
  if (planUsage?.order != null && written) countCodexResetSnapshotWrite('heartbeat', planUsage.order);
  return { planUsageStored: written };
}

/** A value the column takes, or a refusal: Prisma would refuse it, and the full reconcile answers that as HTTPS does. */
function optional<T>(value: unknown, check: (v: unknown) => v is T, what: string): { given: boolean; value: T | null } {
  if (value === undefined) return { given: false, value: null };
  if (value === null || check(value)) return { given: true, value: value as T | null };
  throw new LinkReportUnwritable(`${what} is not of the type its column takes`);
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The worktree snapshots (the heartbeat route's `dto.sessions` write), as one UPDATE: each open conversation of this
 * runner the process holds the lease of gets what its snapshot reports, a member left out keeping its column. A
 * session reported not merged whose recorded merge landed this exact tip is merged; one whose recorded merge did not has
 * that merge cleared (reconcileReportedBranchMerged), in the same write.
 */
function worktreeSnapshotsSql(runnerId: string, leaseOwner: string | null, sessions: readonly unknown[], after: Prisma.Sql): Prisma.Sql {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of sessions) {
    const s = (entry ?? {}) as Record<string, unknown>;
    if (typeof s.sessionId !== 'string' || !SESSION_ID_RE.test(s.sessionId)) throw new LinkReportUnwritable('a snapshot names no session');
    const isolation = optional(s.isolationStatus, isString, 'isolationStatus');
    const baseSha = optional(s.baseSha, isString, 'baseSha');
    const dirty = optional(s.worktreeDirty, isBoolean, 'worktreeDirty');
    const branch = optional(s.worktreeBranch, isString, 'worktreeBranch');
    const merged = optional(s.branchMerged, isBoolean, 'branchMerged');
    if (s.mergeTargets !== undefined && !(Array.isArray(s.mergeTargets) && s.mergeTargets.every(isString))) {
      throw new LinkReportUnwritable('mergeTargets is not a list of branch names');
    }
    byId.set(s.sessionId.toLowerCase(), {
      sessionId: s.sessionId.toLowerCase(),
      isolationGiven: isolation.given,
      isolationStatus: isolation.value,
      baseShaGiven: baseSha.given,
      baseSha: baseSha.value,
      changedFiles: s.changedFiles ?? [],
      worktreeDirtyGiven: dirty.given,
      worktreeDirty: dirty.value,
      mergeTargetsGiven: s.mergeTargets !== undefined,
      mergeTargets: s.mergeTargets ?? [],
      worktreeBranchGiven: branch.given,
      worktreeBranch: branch.value,
      branchShaStorable: storableBranchSha(s.branchSha) !== undefined,
      branchSha: storableBranchSha(s.branchSha) ?? null,
      branchShaGiven: !!s.branchSha,
      branchShaRaw: typeof s.branchSha === 'string' ? s.branchSha : null,
      branchMergedGiven: merged.given,
      branchMerged: merged.value,
    });
  }
  const landedTip = Prisma.sql`(s."merged_source_sha" IS NOT NULL AND (NOT v."branchShaGiven" OR s."merged_source_sha" = v."branchShaRaw"))`;
  const clearMerge = Prisma.sql`(v."branchMergedGiven" AND v."branchMerged" = false AND s."merge_status" = 'merged' AND NOT ${landedTip})`;
  return Prisma.sql`
    UPDATE "session" s
       SET "isolation_status" = CASE WHEN v."isolationGiven" THEN v."isolationStatus" ELSE s."isolation_status" END,
           "base_sha" = CASE WHEN v."baseShaGiven" THEN v."baseSha" ELSE s."base_sha" END,
           "changed_files" = v."changedFiles",
           "worktree_dirty" = CASE WHEN v."worktreeDirtyGiven" THEN v."worktreeDirty" ELSE s."worktree_dirty" END,
           "merge_targets" = CASE WHEN v."mergeTargetsGiven" THEN ARRAY(SELECT jsonb_array_elements_text(v."mergeTargets")) ELSE s."merge_targets" END,
           "worktree_branch" = CASE WHEN v."worktreeBranchGiven" THEN v."worktreeBranch" ELSE s."worktree_branch" END,
           "branch_sha" = CASE WHEN v."branchShaStorable" THEN v."branchSha" ELSE s."branch_sha" END,
           "branch_merged" = CASE
             WHEN NOT v."branchMergedGiven" THEN s."branch_merged"
             WHEN v."branchMerged" IS NULL THEN NULL
             WHEN v."branchMerged" THEN true
             WHEN s."merge_status" = 'merged' AND ${landedTip} THEN true
             ELSE false
           END,
           "merge_status" = CASE WHEN ${clearMerge} THEN NULL ELSE s."merge_status" END,
           "merge_operation_id" = CASE WHEN ${clearMerge} THEN NULL ELSE s."merge_operation_id" END,
           "merge_operation_owner" = CASE WHEN ${clearMerge} THEN NULL ELSE s."merge_operation_owner" END,
           "merge_error" = CASE WHEN ${clearMerge} THEN NULL ELSE s."merge_error" END,
           "merged_source_sha" = CASE WHEN ${clearMerge} THEN NULL ELSE s."merged_source_sha" END,
           "updated_at" = (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${JSON.stringify([...byId.values()].sort(byKey('sessionId')))}::jsonb) AS v(
             "sessionId" uuid, "isolationGiven" boolean, "isolationStatus" text, "baseShaGiven" boolean, "baseSha" text,
             "changedFiles" jsonb, "worktreeDirtyGiven" boolean, "worktreeDirty" boolean, "mergeTargetsGiven" boolean,
             "mergeTargets" jsonb, "worktreeBranchGiven" boolean, "worktreeBranch" text, "branchShaStorable" boolean,
             "branchSha" text, "branchShaGiven" boolean, "branchShaRaw" text, "branchMergedGiven" boolean, "branchMerged" boolean)
     WHERE s."id" = v."sessionId"
       AND s."assigned_runner_id" = ${runnerId}::uuid
       AND s."status" IN (${OPEN_STATUSES_SQL})
       AND s."kind" = 'CONVERSATION'
       ${leaseOwner ? Prisma.sql`AND s."inbox_lease_owner" = ${leaseOwner}::uuid` : Prisma.empty}
       AND ${after}
    RETURNING 1`;
}

/** At most this many directories a beat reports on, as the heartbeat route takes them. */
const MAX_DIRECTORY_PROBES = 200;

/**
 * The directory probes (the heartbeat route's `dto.agentDirProbes` write), as one UPDATE of this runner's live
 * workspaces: what the runner found at each working directory, and the repository address a git checkout there names,
 * kept only where the workspace still has that directory and no address of its own.
 */
function directoryProbesSql(runnerId: string, probes: readonly unknown[], after: Prisma.Sql): Prisma.Sql {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of probes.slice(0, MAX_DIRECTORY_PROBES)) {
    const p = (entry ?? {}) as Record<string, unknown>;
    if (typeof p.agentId !== 'string' || !SESSION_ID_RE.test(p.agentId)) throw new LinkReportUnwritable('a probe names no workspace');
    if (typeof p.exists !== 'boolean') throw new LinkReportUnwritable('a probe says nothing of its directory');
    const isGit = p.exists ? optional(p.isGitRepo, isBoolean, 'isGitRepo') : { given: true, value: null };
    const repoUrl = typeof p.repoUrl === 'string' ? p.repoUrl.trim() : '';
    byId.set(p.agentId.toLowerCase(), {
      agentId: p.agentId.toLowerCase(),
      exists: p.exists,
      isGitGiven: isGit.given,
      isGit: isGit.value,
      freeBytes: diskBytes(p.freeBytes),
      totalBytes: diskBytes(p.totalBytes),
      learnRepoUrl: !!(p.exists && p.isGitRepo && typeof p.workDir === 'string' && p.workDir && repoUrl),
      workDir: typeof p.workDir === 'string' ? p.workDir : null,
      repoUrl: repoUrl || null,
    });
  }
  return Prisma.sql`
    UPDATE "workspace" w
       SET "work_dir_exists" = v."exists",
           "work_dir_is_git" = CASE WHEN v."isGitGiven" THEN v."isGit" ELSE w."work_dir_is_git" END,
           "work_dir_free_bytes" = v."freeBytes",
           "work_dir_total_bytes" = v."totalBytes",
           "work_dir_probed_at" = (now() AT TIME ZONE 'UTC'),
           "repo_url" = CASE
             WHEN v."learnRepoUrl" AND w."work_dir" = v."workDir" AND (w."repo_url" IS NULL OR w."repo_url" = '') THEN v."repoUrl"
             ELSE w."repo_url"
           END
      FROM jsonb_to_recordset(${JSON.stringify([...byId.values()].sort(byKey('agentId')))}::jsonb) AS v(
             "agentId" uuid, "exists" boolean, "isGitGiven" boolean, "isGit" boolean, "freeBytes" bigint, "totalBytes" bigint,
             "learnRepoUrl" boolean, "workDir" text, "repoUrl" text)
     WHERE w."id" = v."agentId" AND w."runner_id" = ${runnerId}::uuid AND w."deleted_at" IS NULL AND ${after}
    RETURNING 1`;
}

/** Rows of one relation by id, the order two writers of several of them must agree on (common/lock-order.ts). */
function byKey(key: string): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  return (a, b) => String(a[key]).localeCompare(String(b[key]));
}

/** A disk figure as the workspace's BigInt column takes it (the heartbeat route's toDiskBytes), as text; null for none. */
function diskBytes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return BigInt(Math.floor(value)).toString();
}

// ── After a full reconcile ───────────────────────────────────────────────────────────────────────────────

/**
 * What a full reconcile left in flight that a beat renews, settles, redelivers or claims — one statement, read after the
 * reconcile: a merge or commit pending on a session of the runner (whichever process holds it), a Codex reset of the
 * runner still active, an integration job or a repository operation of its workspaces queued or running, a relay slot
 * of its own in flight. Any of them keeps the runner reconciling in full on every beat, as it would over HTTPS.
 */
export async function readLinkReconcilePending(prisma: Pick<PrismaService, '$queryRaw'>, runnerId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ pending: boolean }>>`
    SELECT (
      EXISTS (
        SELECT 1 FROM "session" s
         WHERE s."assigned_runner_id" = ${runnerId}::uuid AND (s."merge_status" = 'pending' OR s."commit_status" = 'pending')
      )
      OR EXISTS (
        SELECT 1 FROM "codex_rate_limit_reset_operation" o
         WHERE o."runner_id" = ${runnerId}::uuid
           AND (o."consume_state" IN ('PENDING', 'CLAIMED') OR (o."consume_state" = 'CONFIRMED' AND o."refresh_state" = 'PENDING'))
      )
      OR EXISTS (
        SELECT 1 FROM "project_integration_job" j
          JOIN "session" s ON s."id" = j."session_id"
          JOIN "workspace" w ON w."id" = s."workspace_id"
         WHERE w."runner_id" = ${runnerId}::uuid AND j."state" IN ('QUEUED', 'RUNNING')
      )
      OR EXISTS (
        SELECT 1 FROM "wiki_repo_op" o
          JOIN "workspace" w ON w."id" = o."workspace_id"
         WHERE w."runner_id" = ${runnerId}::uuid AND o."state" IN ('queued', 'running')
      )
      OR EXISTS (
        SELECT 1 FROM "runner" r
         WHERE r."id" = ${runnerId}::uuid
           AND (r."login_status" IN ('pending', 'awaiting_code', 'awaiting_approval', 'cancelling')
             OR r."install_status" IN ('pending', 'installing')
             OR r."codex_account_remove_status" = 'pending'
             OR r."repo_cleanup_status" = 'pending'
             OR r."claude_history_status" IN ('pending', 'scanning')
             OR r."model_catalog_refresh_at" IS NOT NULL
             OR r."self_update_requested_at" IS NOT NULL)
      )
    ) AS "pending"
  `;
  return rows[0]?.pending === true;
}

/** Whether a full answer hands the runner anything: a command, a cancellation, a lost lease. */
export function heartbeatAnswerHandsOut(answer: RunnerHeartbeatResponse): boolean {
  return (
    answer.cancelSessionIds.length > 0
    || (answer.leaseLostSessionIds?.length ?? 0) > 0
    || (answer.mergeRequests?.length ?? 0) > 0
    || (answer.commitRequests?.length ?? 0) > 0
    || (answer.artifactRequests?.length ?? 0) > 0
    || (answer.integrationJobs?.length ?? 0) > 0
    || (answer.wikiRepoOps?.length ?? 0) > 0
    || (answer.cursorKeyChecks?.length ?? 0) > 0
    || answer.loginRequest !== undefined
    || answer.accountRemoveRequest !== undefined
    || answer.codexAccountRemoveRequest !== undefined
    || answer.installRequest !== undefined
    || answer.repoCleanupRequest !== undefined
    || answer.claudeHistoryRequest !== undefined
    || answer.codexRateLimitResetRequest !== undefined
    || answer.managedSleep !== undefined
    || answer.refreshModelCatalog === true
    || answer.checkSelfUpdate === true
  );
}

/**
 * What a full reconcile of a link heartbeat leaves in the presence row: the digests of what it wrote, and — when it
 * left nothing pending — the delivery inputs and change count it covered, with the time. One that left something
 * pending records no reconcile, so the next beat reconciles in full again.
 */
export async function recordLinkReconcile(
  prisma: Pick<PrismaService, '$executeRaw'>,
  input: { runnerId: string; facts: Record<string, string>; reconcileHash: string | null },
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "runner_presence"
       SET "facts_hash" = ${factsHashOf(input.facts)}::text,
           "reconcile_hash" = ${input.reconcileHash}::text,
           "reconciled_at" = CASE WHEN ${input.reconcileHash}::text IS NULL THEN "reconciled_at" ELSE (now() AT TIME ZONE 'UTC') END
     WHERE "runner_id" = ${input.runnerId}::uuid
  `;
}
