import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { worktreeOperationFenceSql } from '../common/session-inbox-fence';
import { EVIDENCE_REVIEW_WINDOW_SECONDS } from '../tasks/evidence-review';
import { freshRunningBgJobs } from './background-job-activity';
import { RUNNER_OFFLINE_AFTER_MS, runnerIsOnline, runnerLastBeatSql } from '../runners/runner-presence';

/**
 * A cheap stand-in for "would `SessionsService.list` answer the Open list differently now": the
 * clients poll it every few seconds with `If-None-Match`, and building the real answer (hundreds of
 * rows, ~1.5 MB of JSON, a dozen owner-decision reads) only to hash it and send a 304 saved them
 * nothing. The controller compares this version instead and never builds the list when it matches.
 *
 * The one rule is that it may change when the list did not, never the other way round. So it is
 * not `max(updated_at)`: `@updatedAt` is only bumped by Prisma writes, and several raw writes of
 * columns the list shows (`retry_at`, the queue's claims) leave it alone. Instead every source
 * table carries a per-owner counter (`open_list_epoch`, migration 0484), bumped by the table's own
 * statement-level triggers on every insert, update and delete: a counter cannot lag a write, and it
 * may move when the list did not change — the direction this version is allowed to be wrong in.
 * A counter is spread over as many rows as it has concurrent writers (0487), and a bump takes one
 * no other transaction holds: with a single row per counter every writer of the account queued
 * behind the open transaction holding it, and two writers taking two counters in opposite orders
 * deadlocked.
 *
 * The sources are every table `listRows` and the readers it calls reach (owner decisions,
 * request peers, confirmations under review, project membership, the queued-gate lateral). The
 * probe reads their counters, not their rows: hashing the rows of an account with a hundred
 * thousand tasks and eight thousand sessions was most of the database's read time on every poll.
 * Anyone adding a source to the list row must add it here and give its table triggers
 * (`open-list-version.pg.spec.ts` pins the sources the row shows and the triggers each one has).
 *
 * It answers for the flat Open list only. A project read — landing-aware included — is built every
 * time and keeps Express's body-hash ETag (sessions.controller.ts), so the LANDING rows only that
 * read can show (contract §2.9 LS6) are not a source here: an insert or a settlement leaves this
 * version exactly where it was.
 *
 * The rest of the list is a fact about the clock, not the rows: a runner going offline, a job going
 * quiet, a share link expiring, a fence going stale, a review window or an escalation passing.
 * Each is a threshold that flips once while the data stands still, so the version carries how many
 * have flipped, decided on the SAME clock the list decides it on (Postgres `now()` for the SQL
 * ones, `nowMs` for the JS ones). Read before the list is built and with an earlier clock, a
 * version can only lag the list it is sent with — which costs one more 200 later, never a 304 over
 * a stale body. The rows those thresholds are read from are read live, as are the few sources that
 * are tiny or belong to someone else: runners, their presence rows, share links, and the foreign
 * running turns a PENDING row waits behind.
 */
export async function readOpenListVersion(
  prisma: PrismaService,
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const o = Prisma.sql`${ownerId}::uuid`;
  // How many row versions, and an order-free fingerprint of which (only the few live sources use it).
  const rowsOf = (alias: string, from: Prisma.Sql) => {
    const t = Prisma.raw(alias);
    return Prisma.sql`(SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(${t}.ctid::text || ':' || ${t}.xmin::text, 0)), 0)::text ${from})`;
  };
  const ownedBy = (table: string) => rowsOf('x', Prisma.sql`FROM ${Prisma.raw(table)} x WHERE x.owner_id = ${o}`);
  /** Epoch milliseconds, truncated as a JS Date read of the column is. */
  const ms = (ts: Prisma.Sql) => Prisma.sql`floor(extract(epoch FROM ${ts}) * 1000)`;

  // One statement, so one round trip and one plan.
  const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    WITH runners AS MATERIALIZED (
      SELECT r.id, r.ctid::text || ':' || r.xmin::text AS v, r.status::text AS status, ${runnerLastBeatSql('r')} AS beat
        FROM runner r
       WHERE r.owner_id = ${o}
          OR r.id IN (SELECT assigned_runner_id FROM session
                       WHERE owner_id = ${o} AND assigned_runner_id IS NOT NULL)
    )
    SELECT
      -- Every source table's counter in one read (migration 0484). It may move when the list did
      -- not; it cannot lag a write. A LANDING session is not one of them: the flat list excludes
      -- those rows, and the read that can show them hashes its own body. A counter is the sum of
      -- its rows, keyed '<source>' and '<source>#<n>' (0487): a bump adds one to whichever row no
      -- other writer holds, so writers never queue on it.
      COALESCE((SELECT string_agg(src || '=' || total, ',' ORDER BY src)
                  FROM (SELECT split_part(source, '#', 1) AS src, sum(epoch) AS total
                          FROM open_list_epoch
                         WHERE owner_id = ${o}
                         GROUP BY 1) counters), '') AS epochs,
      -- The queued gate counts every running turn on the runner a PENDING row waits for.
      ${rowsOf('x', Prisma.sql`FROM session x WHERE x.status = 'RUNNING' AND x.owner_id <> ${o}
        AND x.assigned_runner_id IN (SELECT assigned_runner_id FROM session
          WHERE owner_id = ${o} AND status = 'PENDING' AND assigned_runner_id IS NOT NULL)`)} AS foreign_running,
      (SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(v, 0)), 0)::text FROM runners) AS runner,
      -- Those runners' presence rows, which a heartbeat rewrites without touching the runner's own.
      ${rowsOf('x', Prisma.sql`FROM runner_presence x WHERE x.runner_id IN (SELECT id FROM runners)`)} AS runner_presence,
      -- Small enough to keep reading whole: every share link the account owns.
      ${ownedBy('share_link')} AS share_link,
      -- The thresholds the list decides on Postgres' clock. Each only flips one way as time passes.
      (SELECT count(*) FROM runners WHERE status = 'OFFLINE' OR beat IS NULL
        OR beat < now() - (${RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond'))::text AS runners_offline_sql,
      -- The fence goes stale five minutes after a merge/commit request. The extra status OR repeats
      -- what the fence below already implies, so the partial index can carry only the sessions whose
      -- status makes them candidates for it (the rest are a seq scan of the whole account).
      (SELECT count(*) FROM session s
        WHERE s.owner_id = ${o}
          AND (s.merge_status IS NOT DISTINCT FROM 'pending' OR s.commit_status IS NOT DISTINCT FROM 'pending')
          AND ${worktreeOperationFenceSql('s')})::text AS fenced,
      (SELECT count(*) FROM share_link sl WHERE sl.owner_id = ${o} AND sl.revoked_at IS NULL
        AND (sl.expires_at IS NULL OR sl.expires_at > now()))::text AS share_links_live,
      -- What the thresholds decided on the JS clock are read from; not hashed (the counters are).
      (SELECT json_agg(json_build_array(s.running_bg_jobs, s.running_bg_job_activity))
         FROM session s WHERE s.owner_id = ${o} AND cardinality(s.running_bg_jobs) > 0) AS bg_jobs,
      (SELECT json_agg(json_build_array(status, ${ms(Prisma.sql`beat`)})) FROM runners) AS runner_clock,
      -- The instants at which a JS-clock threshold flips: an evidence-review window closing (the
      -- delivery moment is stamped on the evidence row by migration 0484, so no task or turn is
      -- joined here), a coordinator's escalation running out (from a delivered wake or a done
      -- request; at once when its session has ended, hence both), a confirmation review falling due.
      (SELECT json_agg(${ms(Prisma.sql`at`)}) FROM (
        SELECT e.review_turn_at + ${EVIDENCE_REVIEW_WINDOW_SECONDS} * interval '1 second' AS at
          FROM task_completion_evidence e
         WHERE e.owner_id = ${o} AND e.review_turn_at IS NOT NULL
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
        UNION ALL
        -- An owner request stops being counted on its row at its deadline, before the sweep that
        -- writes it EXPIRED (owner-decision-signal.ts).
        SELECT r.expires_at FROM owner_request r
         WHERE r.owner_id = ${o} AND r.state = 'PENDING' AND r.expires_at IS NOT NULL
      ) d) AS deadlines
  `);

  const { bg_jobs, runner_clock, deadlines, ...rows } = row;
  // Same predicates as the readers, on the same instant-or-earlier: each count only moves one way.
  const deadlinesPassed = ((deadlines ?? []) as Array<number | null>)
    .filter((at) => at != null && at <= nowMs).length;
  const freshJobs = ((bg_jobs ?? []) as Array<[string[], unknown]>)
    .reduce((n, [jobs, activity]) => n + freshRunningBgJobs(jobs, activity, nowMs).length, 0);
  const runnersOnline = ((runner_clock ?? []) as Array<[string, number | null]>)
    .filter(([status, beat]) => runnerIsOnline({ status, lastHeartbeatAt: beat == null ? null : new Date(beat) }, nowMs))
    .length;

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
