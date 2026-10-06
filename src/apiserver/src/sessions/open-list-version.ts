import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { worktreeOperationFenceSql } from '../common/session-inbox-fence';
import { EVIDENCE_REVIEW_WINDOW_SECONDS } from '../tasks/evidence-review';
import { EVIDENCE_REVIEW_TURN_KEY_PREFIX } from './watch-turn-key';
import { freshRunningBgJobs } from './background-job-activity';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';

/**
 * A cheap stand-in for "would `SessionsService.list` answer the Open list differently now": the
 * clients poll it every few seconds with `If-None-Match`, and building the real answer (hundreds of
 * rows, ~1.5 MB of JSON, a dozen owner-decision reads) only to hash it and send a 304 saved them
 * nothing. The controller compares this version instead and never builds the list when it matches.
 *
 * The one rule is that it may change when the list did not, never the other way round. So it is
 * not `max(updated_at)`: `@updatedAt` is only bumped by Prisma writes, and several raw writes of
 * columns the list shows (`retry_at`, the queue's claims) leave it alone, as does every table here
 * with no such column. Instead each source contributes the set of its row VERSIONS — `(ctid, xmin)`
 * is a new pair for every insert and update, whoever wrote it, and a delete removes one — folded to
 * a count and an order-free sum. Vacuum freezing or moving a row only changes it spuriously.
 *
 * The sources are every table `listRows` and the readers it calls reach (owner decisions,
 * request peers, confirmations under review, project membership, the queued-gate lateral), each
 * widened to the account rather than mirroring their filters: a superset can only invalidate more.
 * Tasks are the one exception, narrowed to the ones a reader can reach (see `task_ids`), because an
 * account can hold a hundred thousand of them and fingerprinting all of them cost as much as the list.
 * Anyone adding a source to the list row must add it here (`open-list-version.pg.spec.ts` pins
 * the ones the row shows).
 *
 * The rest of the list is a fact about the clock, not the rows: a runner going offline, a job going
 * quiet, a share link expiring, a review window or an escalation passing. Each is a threshold that
 * flips once while the data stands still, so the version carries how many have flipped, decided on
 * the SAME clock the list decides it on (Postgres `now()` for the SQL ones, `nowMs` for the JS
 * ones). Read before the list is built and with an earlier clock, a version can only lag the list
 * it is sent with — which costs one more 200 later, never a 304 over a stale body.
 */
export async function readOpenListVersion(
  prisma: PrismaService,
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const o = Prisma.sql`${ownerId}::uuid`;
  // How many row versions, and an order-free fingerprint of which.
  const rowsOf = (alias: string, from: Prisma.Sql) => {
    const t = Prisma.raw(alias);
    return Prisma.sql`(SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(${t}.ctid::text || ':' || ${t}.xmin::text, 0)), 0)::text ${from})`;
  };
  const ownedBy = (table: string) => rowsOf('x', Prisma.sql`FROM ${Prisma.raw(table)} x WHERE x.owner_id = ${o}`);
  const ownedViaProject = (table: string) =>
    rowsOf('x', Prisma.sql`FROM ${Prisma.raw(table)} x JOIN project p ON p.id = x.project_id WHERE p.owner_id = ${o}`);
  /** Epoch milliseconds, truncated as a JS Date read of the column is. */
  const ms = (ts: Prisma.Sql) => Prisma.sql`floor(extract(epoch FROM ${ts}) * 1000)`;

  // One statement, so one round trip and one plan; the account's sessions are read once.
  const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    WITH owned AS MATERIALIZED (
      SELECT s.id, s.ctid::text || ':' || s.xmin::text AS v, s.status::text AS status,
             s.task_id, s.context_task_id, s.assigned_runner_id,
             COALESCE(s.completed_at, s.archived_at) IS NULL AND s.deleted_at IS NULL AS open,
             ${worktreeOperationFenceSql('s')} AS fenced,
             CASE WHEN cardinality(s.running_bg_jobs) > 0
                  THEN json_build_array(s.running_bg_jobs, s.running_bg_job_activity) END AS bg
        FROM session s WHERE s.owner_id = ${o}
    ),
    -- The runners the list rows can name, whoever owns them.
    runners AS MATERIALIZED (
      SELECT r.ctid::text || ':' || r.xmin::text AS v, r.status::text AS status, r.last_heartbeat_at
        FROM runner r
       WHERE r.owner_id = ${o} OR r.id IN (SELECT assigned_runner_id FROM owned WHERE assigned_runner_id IS NOT NULL)
    ),
    -- The tasks any reader of the list can reach. Not the account's every task (there can be a
    -- hundred thousand, and nearly all of them reach nothing here): the ones a session names, the
    -- ones with evidence, a confirmation request, an open item or an integration job, and the ones
    -- that serve or verify a criterion (what the derived project-done reading walks). A task that
    -- joins or leaves this set changes the set, so the set itself needs no version of its own.
    task_ids AS (
      SELECT task_id AS id FROM owned WHERE task_id IS NOT NULL
      UNION SELECT context_task_id FROM owned WHERE context_task_id IS NOT NULL
      UNION SELECT task_id FROM task_completion_evidence WHERE owner_id = ${o}
      UNION SELECT task_id FROM task_owner_confirmation_request WHERE owner_id = ${o}
      UNION SELECT task_id FROM project_open_item WHERE owner_id = ${o} AND task_id IS NOT NULL
      UNION SELECT task_id FROM project_integration_job WHERE owner_id = ${o} AND task_id IS NOT NULL
      UNION SELECT id FROM task WHERE owner_id = ${o} AND verifies_task_id IS NOT NULL
      UNION SELECT t.id FROM task t JOIN project_acceptance_criterion_definition d ON d.id = t.criterion_definition_id
              JOIN project p ON p.id = d.project_id WHERE p.owner_id = ${o} AND t.criterion_definition_id IS NOT NULL
    ),
    evidence_review_turn AS (
      SELECT x.ctid::text || ':' || x.xmin::text AS v, x.created_at
        FROM task_completion_evidence e
        JOIN task t ON t.id = e.task_id AND t.status IN ('OPEN', 'IN_PROGRESS')
        JOIN conversation_turn x ON x.session_id = t.creator_session_id
          AND x.client_turn_id = ${EVIDENCE_REVIEW_TURN_KEY_PREFIX} || e.id::text
       WHERE e.owner_id = ${o}
    )
    SELECT
      (SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(v, 0)), 0)::text FROM owned) AS session,
      -- The queued gate counts every running turn on the runner a PENDING row waits for.
      ${rowsOf('x', Prisma.sql`FROM session x WHERE x.status = 'RUNNING' AND x.owner_id <> ${o}
        AND x.assigned_runner_id IN (SELECT assigned_runner_id FROM owned WHERE status = 'PENDING')`)} AS foreign_running,
      ${ownedBy('workspace')} AS workspace,
      (SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(v, 0)), 0)::text FROM runners) AS runner,
      -- ANY(ARRAY(…)), not IN: the planner reads the criterion branch above as the whole task table
      -- (a foreign-key estimate that ignores its NULLs) and would scan all of it for a few thousand ids.
      ${rowsOf('x', Prisma.sql`FROM task x WHERE x.id = ANY(ARRAY(SELECT id FROM task_ids))`)} AS task,
      ${ownedBy('project')} AS project,
      ${rowsOf('x', Prisma.sql`FROM project_coordinator_wake x JOIN project p ON p.id = x.project_id
        WHERE p.owner_id = ${o} AND x.status IN ('DELIVERED', 'SESSION_OPENED')`)} AS coordinator_wake,
      ${ownedBy('project_open_item')} AS open_item,
      ${ownedBy('project_ratified_action_intent')} AS ratified_intent,
      ${ownedBy('project_ratified_action_commit')} AS ratified_commit,
      ${ownedBy('project_criteria_decision')} AS criteria_decision,
      ${ownedViaProject('project_acceptance_criterion_definition')} AS criterion_definition,
      ${ownedBy('project_standard_set_confirmation')} AS standard_set_confirmation,
      ${ownedViaProject('project_task_status_count')} AS task_status_count,
      ${ownedBy('project_promotion')} AS promotion,
      ${ownedBy('project_integration_job')} AS integration_job,
      ${ownedBy('project_codebase')} AS codebase,
      ${ownedBy('project_criteria_authorship')} AS criteria_authorship,
      ${ownedBy('session_merge_receipt')} AS merge_receipt,
      ${ownedBy('task_completion_evidence')} AS completion_evidence,
      ${ownedBy('task_evidence_decision')} AS evidence_decision,
      ${ownedBy('task_owner_confirmation_request')} AS confirmation_request,
      ${ownedBy('task_owner_confirmation_claim')} AS confirmation_claim,
      ${ownedBy('task_owner_decision')} AS owner_decision,
      ${ownedBy('task_owner_confirmation_review')} AS confirmation_review,
      ${ownedBy('task_owner_confirmation_review_record')} AS confirmation_review_record,
      ${rowsOf('x', Prisma.sql`FROM approval x JOIN owned s ON s.id = x.session_id
        WHERE s.open AND x.status = 'PENDING'`)} AS approval,
      ${rowsOf('x', Prisma.sql`FROM session_request x WHERE x.owner_id = ${o} AND x.state = 'OPEN'`)} AS session_request,
      ${ownedBy('session_tag')} AS session_tag,
      ${rowsOf('x', Prisma.sql`FROM session_tag_link x JOIN owned s ON s.id = x.session_id WHERE s.open`)} AS session_tag_link,
      ${ownedBy('share_link')} AS share_link,
      -- currentTurnStartedAt: the unanswered turns of a row that can be mid-turn.
      ${rowsOf('x', Prisma.sql`FROM conversation_turn x JOIN owned s ON s.id = x.session_id
        WHERE s.status IN ('RUNNING', 'PENDING') AND x.answered_at IS NULL`)} AS open_turn,
      -- The dispatching session's evidence-review turn (reviewerHolds).
      (SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(v, 0)), 0)::text FROM evidence_review_turn) AS evidence_review_turn,
      -- A confirmation reviewer's delivery turn (confirmationReviewStates).
      ${rowsOf('x', Prisma.sql`FROM task_owner_confirmation_review v
        JOIN conversation_turn x ON x.session_id = v.reviewer_session_id
          AND x.client_turn_id = v.delivery_turn_client_id
        WHERE v.owner_id = ${o}`)} AS review_turn,
      -- The thresholds the list decides on Postgres' clock. Each only flips one way as time passes.
      (SELECT count(*) FROM runners WHERE status = 'OFFLINE' OR last_heartbeat_at IS NULL
        OR last_heartbeat_at < now() - (${SESSION_RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond'))::text AS runners_offline_sql,
      (SELECT count(*) FROM owned WHERE fenced)::text AS fenced,
      (SELECT count(*) FROM share_link sl WHERE sl.owner_id = ${o} AND sl.revoked_at IS NULL
        AND (sl.expires_at IS NULL OR sl.expires_at > now()))::text AS share_links_live,
      -- What the thresholds decided on the JS clock are read from; not hashed (the rows are).
      (SELECT json_agg(bg) FROM owned WHERE bg IS NOT NULL) AS bg_jobs,
      (SELECT json_agg(json_build_array(status, ${ms(Prisma.sql`last_heartbeat_at`)})) FROM runners) AS runner_clock,
      -- The instants at which a JS-clock threshold flips: an evidence-review window closing, a
      -- coordinator's escalation running out (from a delivered wake or a done request; at once
      -- when its session has ended, hence both), a confirmation review falling due.
      (SELECT json_agg(${ms(Prisma.sql`at`)}) FROM (
        SELECT created_at + ${EVIDENCE_REVIEW_WINDOW_SECONDS} * interval '1 second' AS at FROM evidence_review_turn
        UNION ALL
        SELECT unnest(ARRAY[w.updated_at, w.updated_at + p.exception_escalation_seconds * interval '1 second'])
          FROM project_coordinator_wake w JOIN project p ON p.id = w.project_id
         WHERE p.owner_id = ${o} AND w.status = 'DELIVERED'
        UNION ALL
        SELECT unnest(ARRAY[i.updated_at, i.updated_at + p.exception_escalation_seconds * interval '1 second'])
          FROM project_open_item i JOIN project p ON p.id = i.project_id
         WHERE i.owner_id = ${o} AND i.kind = 'DONE_REQUEST'
        UNION ALL
        SELECT v.due_at FROM task_owner_confirmation_review v WHERE v.owner_id = ${o}
      ) d) AS deadlines
  `);

  const { bg_jobs, runner_clock, deadlines, ...rows } = row;
  // Same predicates as the readers, on the same instant-or-earlier: each count only moves one way.
  const deadlinesPassed = ((deadlines ?? []) as Array<number | null>)
    .filter((at) => at != null && at <= nowMs).length;
  const freshJobs = ((bg_jobs ?? []) as Array<[string[], unknown]>)
    .reduce((n, [jobs, activity]) => n + freshRunningBgJobs(jobs, activity, nowMs).length, 0);
  const runnersOnline = ((runner_clock ?? []) as Array<[string, number | null]>)
    .filter(([status, heartbeat]) => status !== 'OFFLINE' && heartbeat != null
      && heartbeat >= nowMs - SESSION_RUNNER_OFFLINE_AFTER_MS).length;

  return createHash('sha256')
    .update(JSON.stringify([rows, deadlinesPassed, freshJobs, runnersOnline]))
    .digest('base64url')
    .slice(0, 27);
}

/** The views the version answers for: Open, and its legacy alias. */
export function isOpenListView(view: string | undefined): boolean {
  return view === undefined || view === 'open' || view === 'active';
}

/**
 * The ETag sent with an Open list: weak, because it names the data rather than the bytes (and
 * Cloudflare demotes a strong one when it compresses anyway), and prefixed so it can never equal
 * the body-hash ETag Express computes for every other response. Every query parameter that shapes
 * the list is part of it, so a filtered or paged list never matches the whole one.
 */
export function openListEtag(version: string, filters: Record<string, string | number | undefined>): string {
  const scope = Object.keys(filters)
    .sort()
    .filter((key) => filters[key] !== undefined)
    .map((key) => `${key}=${filters[key]}`)
    .join('&');
  const scoped = scope ? createHash('sha256').update(`${version}|${scope}`).digest('base64url').slice(0, 27) : version;
  return `W/"ol1-${scoped}"`;
}

/** Whether an If-None-Match header names this ETag, by the weak comparison. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return header.split(',').some((tag) => opaque(tag) === wanted);
}
