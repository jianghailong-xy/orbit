import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { worktreeOperationFenceSql } from '../common/session-inbox-fence';
import { EVIDENCE_REVIEW_WINDOW_SECONDS } from '../tasks/evidence-review';
import { freshRunningBgJobs } from './background-job-activity';
import { sessionTurnStateSql } from './session-turn-state';
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
  return (await readOpenListVersionParts(prisma, ownerId, nowMs)).version;
}

/**
 * The version, and the two parts of it a `since=` read decides from whether it may build only the
 * rows that moved (`SessionsService.listOpenSince`):
 *
 * - `epochs`: each source's counter total, so the read can tell WHICH sources were written since its
 *   cursor's snapshot — every source a row reads has a rule there for finding the rows it moved, or
 *   sends the read to a whole build.
 * - `steady`: what of the rest a row can show that no per-row check of that read covers — each
 *   runner's name and status and whether it reads online. Not the runners' beats: the delta does not
 *   count a raw heartbeat as a change, and their presence rows are rewritten every 30 s.
 * - `deadlinesPassed`: the decision deadlines passed, after which a row's waiting cards and decisions
 *   are read again for every row.
 */
export interface OpenListVersionParts {
  version: string;
  epochs: Record<string, string>;
  steady: string;
  /**
   * What the realtime hint poller compares besides the counter sums (docs/list-freshness-scope-hints.md
   * §5.0): the version's non-counter inputs with the runner rows and their presence rows left out, and
   * each runner's `steady` and the background-job holders of its presence row (the queued explanation
   * reads them) in their place. A heartbeat or a runner column outside `steady` moves the
   * version and not this.
   */
  hintClock: string;
  /** How many of the account's decision deadlines have passed (the version's own count of them). */
  deadlinesPassed: number;
}

export async function readOpenListVersionParts(
  prisma: PrismaService,
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<OpenListVersionParts> {
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
      SELECT r.id, r.name, r.ctid::text || ':' || r.xmin::text AS v, r.status::text AS status, ${runnerLastBeatSql('r')} AS beat
        FROM runner r
       WHERE r.owner_id = ${o}
          -- Asked per runner (session_open_list_runner_idx is (owner_id, assigned_runner_id)): as an IN over the
          -- owner's sessions it read every one of them to find a handful of runners (production, 2026-11-19:
          -- 9,316 index entries, 2,054 buffers, for 8 runners; the statement 26 ms -> 14 ms).
          OR EXISTS (SELECT 1 FROM session ra WHERE ra.owner_id = ${o} AND ra.assigned_runner_id = r.id)
    )
    SELECT
      -- Every source table's counter in one read (migration 0484). It may move when the list did
      -- not; it cannot lag a write. A LANDING session is not one of them: the flat list excludes
      -- those rows, and the read that can show them hashes its own body. A counter is the sum of
      -- its rows, keyed '<source>' and '<source>#<n>' (0487): a bump adds one to whichever row no
      -- other writer holds, so writers never queue on it. A source keyed by workspace (1464,
      -- '<source>@w:<ws>' or '<source>@c:<ws>', shard suffix after the key) is added up here as one
      -- source, so these sums read as they did before the keys: only the hint poller reads them apart.
      COALESCE((SELECT string_agg(src || '=' || total, ',' ORDER BY src)
                  FROM (SELECT split_part(split_part(source, '#', 1), '@', 1) AS src, sum(epoch) AS total
                          FROM open_list_epoch
                         WHERE owner_id = ${o}
                         GROUP BY 1) counters), '') AS epochs,
      -- The queued gate counts every running turn on the runner a PENDING row waits for.
      ${rowsOf('x', Prisma.sql`FROM session x WHERE x.finished_at IS NULL AND ${sessionTurnStateSql('x')} = 'IN_FLIGHT'
        AND x.owner_id <> ${o}
        AND x.assigned_runner_id IN (SELECT queued.assigned_runner_id FROM session queued
          WHERE queued.owner_id = ${o} AND queued.finished_at IS NULL AND ${sessionTurnStateSql('queued')} = 'QUEUED'
            AND queued.assigned_runner_id IS NOT NULL)`)} AS foreign_running,
      (SELECT count(*)::text || '/' || COALESCE(sum(hashtextextended(v, 0)), 0)::text FROM runners) AS runner,
      -- Those runners' presence rows, which a heartbeat rewrites without touching the runner's own.
      ${rowsOf('x', Prisma.sql`FROM runner_presence x WHERE x.runner_id IN (SELECT id FROM runners)`)} AS runner_presence,
      -- The sessions each runner's last beat says hold a slot through a background job: what the queued
      -- explanation reads from presence (runnerBackgroundHeldSessions). Only the hint token carries it, never the version.
      (SELECT string_agg(p.runner_id::text || ':' || COALESCE((SELECT string_agg(h::text, ',' ORDER BY h)
                                                                  FROM unnest(p.background_job_session_ids) h), ''), ';' ORDER BY p.runner_id)
         FROM runner_presence p WHERE cardinality(p.background_job_session_ids) > 0 AND p.runner_id IN (SELECT id FROM runners)) AS bg_holders,
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
      (SELECT json_agg(json_build_array(status, ${ms(Prisma.sql`beat`)}, id, name) ORDER BY id) FROM runners) AS runner_clock,
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

  const { bg_jobs, runner_clock, deadlines, bg_holders, ...rows } = row;
  // Same predicates as the readers, on the same instant-or-earlier: each count only moves one way.
  const deadlinesPassed = ((deadlines ?? []) as Array<number | null>)
    .filter((at) => at != null && at <= nowMs).length;
  const freshJobs = ((bg_jobs ?? []) as Array<[string[], unknown]>)
    .reduce((n, [jobs, activity]) => n + freshRunningBgJobs(jobs, activity, nowMs).length, 0);
  const runners = ((runner_clock ?? []) as Array<[string, number | null, string, string]>)
    .map(([status, beat, id, name]) => ({
      id, name, status, online: runnerIsOnline({ status, lastHeartbeatAt: beat == null ? null : new Date(beat) }, nowMs),
    }));
  const runnersOnline = runners.filter((runner) => runner.online).length;

  const version = createHash('sha256')
    .update(JSON.stringify([rows, deadlinesPassed, freshJobs, runnersOnline]))
    .digest('base64url')
    .slice(0, 27);
  const epochs: Record<string, string> = {};
  for (const entry of String(rows.epochs ?? '').split(',')) {
    const at = entry.lastIndexOf('=');
    if (at > 0) epochs[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const steady = createHash('sha256')
    .update(JSON.stringify(runners.map(({ id, name, status, online }) => [id, name, status, online])))
    .digest('base64url')
    .slice(0, 27);
  const hintClock = createHash('sha256')
    .update(JSON.stringify([
      steady, bg_holders ?? null, rows.foreign_running, rows.share_link, rows.runners_offline_sql, rows.fenced, rows.share_links_live,
      deadlinesPassed, freshJobs, runnersOnline,
    ]))
    .digest('base64url')
    .slice(0, 27);
  return { version, epochs, steady, hintClock, deadlinesPassed };
}

/**
 * The `session` columns no Open list reads (migration 1420_open_list_undrawn_writes): neither the
 * row query, its overlay, the probe of a `since=` read nor this version, so no client can draw them
 * from the list. An UPDATE that changes nothing else moves no counter, and so sends no
 * `sessions.list_changed`. The migration's `open_list_bump_session` names these same columns (and 1464's, which keys it by workspace)
 * (`open-list-undrawn-writes.pg.spec.ts` writes each one and asserts that, and that the built rows
 * do not change). A column the list starts to read must leave this list and that function.
 */
export const OPEN_LIST_UNDRAWN_SESSION_COLUMNS = [
  // Every Prisma write of the row.
  'updated_at',
  // The context gauge (a mid-turn ping every 20 s, and turn_end), the Agent Tools report, the booked totals.
  'context_tokens', 'context_window', 'agent_tools', 'engine_usage_totals',
  'coordinator_context_epoch', 'coordinator_context_ack_key',
  // A heartbeat's worktree snapshot, for every session of the runner whenever one of them changed.
  'isolation_status', 'base_sha', 'changed_files', 'worktree_dirty', 'worktree_branch', 'branch_sha',
  'branch_merged', 'merge_targets', 'branch_commits',
  // Bookkeeping of the recap pass, the alerts and the inbox claim.
  'recap_claimed_at', 'recap_event_seq', 'alerted_approval_at', 'agent_notified_at',
  'inbox_lease_owner', 'inbox_lease_generation', 'inbox_request_id', 'inbox_request_turn_id', 'claim_request_id',
  'retry_attempts', 'retry_claimed_at',
] as const;

/** The `conversation_turn` columns no Open list reads, as OPEN_LIST_UNDRAWN_SESSION_COLUMNS (`open_list_bump_via_session`). */
export const OPEN_LIST_UNDRAWN_TURN_COLUMNS = [
  'delivery_status', 'delivery_failure_code', 'delivery_failure_reason', 'delivery_terminal_at', 'delivery_acknowledged_at',
  'lease_deadline_at', 'lease_generation',
  'display_prompt', 'translation_state', 'translation_lang', 'translation_failure_reason', 'translation_http_status',
  'wiki_context', 'coordinator_context_key',
] as const;

/**
 * The `workspace` columns a runner heartbeat's directory and disk probe writes, none of which an Open
 * list draws (migration 1428_open_list_workspace_probes, `open_list_bump_owner`, carried into 1464): the row reads a
 * workspace's id, name, model and effort, and the queued gates its clone_state and, against the
 * floor of a never-started PENDING session's runner, its free bytes. So an UPDATE that changes only
 * these moves no counter, except a free-bytes change that flips that disk gate's verdict
 * (common/runner-disk-gate.ts `sessionDiskHoldSql`), which the function bumps on by itself
 * (`open-list-workspace-probes.pg.spec.ts`). A column the list starts to read must leave this list
 * and that function.
 */
export const OPEN_LIST_UNDRAWN_WORKSPACE_COLUMNS = [
  'work_dir_exists', 'work_dir_is_git', 'work_dir_probed_at', 'work_dir_free_bytes', 'work_dir_total_bytes',
  'repo_url',
] as const;

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
