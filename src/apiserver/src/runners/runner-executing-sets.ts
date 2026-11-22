import { Prisma } from '@prisma/client';
import { sessionHeldSql } from '../common/session-release';
import type { PrismaService } from '../prisma/prisma.service';
import { BACKGROUND_JOB_SESSIONS_MAX } from './runner-background-holders';

/**
 * What a runner's beat says is executing in each session it supervises (RunnerHeartbeatRequest.executing; plan step 1.6,
 * design §11.5 of docs/session-three-state-design.md).
 *
 * `Session.engineTurnActive`, `runningSubagents`, `runningBgJobs` and `runningBgShells` are inferred from the event
 * stream: an id goes in when a launch is seen and comes out when its end is reported, so an end report that never
 * arrives leaves the session reading as working for good. A runner that sends `executing` states, for each session it
 * names, the complete current value of each set it gives; this module REPLACES the stored ones from it. So an id whose
 * end report was lost is gone at the next beat that carries sets.
 *
 * What is written, and what is left alone:
 *   - a beat without `executing` (an older runner) writes nothing, and today's inference stands;
 *   - a session the beat does not name is left alone, and so is a set an entry leaves out: the runner states only what
 *     it knows in full, and a set it could not state whole (more than EXECUTING_IDS_MAX ids) is left out;
 *   - only a session assigned to the beating runner, still open, a conversation, and leased to the beating process is
 *     written: a beat cannot write another runner's session, a closed one, or one another process of the same runner has
 *     taken over (its predecessor's view is not the session's);
 *   - `runningBgJobActivity` keeps the freshness of every job id that stays, and drops the others, as the events path
 *     prunes it (sessions/background-job-activity.ts);
 *   - an id already stored keeps its place, new ids follow in the beat's order, and a set equal to the stored one as a
 *     set writes nothing: a quiet beat touches no row.
 *
 * A beat and the event batches travel by separate requests and are written by separate transactions, so a beat composed
 * just before a launch can be written after the batch that reported the launch (on the link a beat may wait up to 75 s
 * for its answer, and the next beat comes 30 s after that). Replacing from it would take the new id out again until
 * the next beat, and a session with a job just started would read as executing nothing: a waiting parent released
 * early, a scheduled run landed early. So the beat says when it was composed (`executingAt`, the runner's clock), each
 * batch that moves a set stamps the session with its newest event's `ts` on the same clock (`executing_event_at`), and
 * a session stamped at or after the beat's instant is left as the batch left it — in either direction, so a beat
 * composed before an end does not put the ended id back either. The runner observes an event into the state a beat
 * reads before it stamps the event's `ts` (runner-go session_executing.go), so news the beat missed always carries a
 * later stamp. A beat without `executingAt` (a runner of step 1.6 alone) replaces as before.
 */

/** At most this many ids in one set of one session: a set longer than this is not stated, and its stored value stands. */
export const EXECUTING_IDS_MAX = 256;

/** The longest id kept: tool_use ids and runner job ids are far shorter. */
const EXECUTING_ID_MAX_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The instant a beat says its `executing` was composed, on the runner's clock; undefined for a beat that does not say,
 * or says something that is not a time.
 */
export function executingStatedAt(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** One session's sets as stored from a beat; a member left out is not stated. */
export interface ExecutingEntry {
  sessionId: string;
  engineTurnActive?: boolean;
  subagents?: string[];
  jobs?: string[];
  shells?: string[];
}

function idSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > EXECUTING_IDS_MAX) return undefined;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || id === '' || id.length > EXECUTING_ID_MAX_LENGTH) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The entries a beat carries, as they may be written: null for a beat that carries none (no `executing`, or not a list),
 * which writes nothing. Entries name a session by UUID, each once (the first wins), at most BACKGROUND_JOB_SESSIONS_MAX;
 * a set that is not a list of ids is not stated.
 */
export function sanitizeExecuting(value: unknown): ExecutingEntry[] | null {
  if (!Array.isArray(value)) return null;
  const bySession = new Map<string, ExecutingEntry>();
  for (const raw of value) {
    if (bySession.size >= BACKGROUND_JOB_SESSIONS_MAX) break;
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.sessionId !== 'string' || !UUID_RE.test(e.sessionId)) continue;
    const sessionId = e.sessionId.toLowerCase();
    if (bySession.has(sessionId)) continue;
    const entry: ExecutingEntry = { sessionId };
    if (typeof e.engineTurnActive === 'boolean') entry.engineTurnActive = e.engineTurnActive;
    const subagents = idSet(e.subagents);
    if (subagents) entry.subagents = subagents;
    const jobs = idSet(e.jobs);
    if (jobs) entry.jobs = jobs;
    const shells = idSet(e.shells);
    if (shells) entry.shells = shells;
    bySession.set(sessionId, entry);
  }
  return [...bySession.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

/** The stated set as a text[]. */
function stated(member: string): Prisma.Sql {
  return Prisma.sql`ARRAY(SELECT jsonb_array_elements_text(v.${Prisma.raw(`"${member}"`)}))`;
}

/** Whether the stated set differs, as a set, from the stored column. */
function setDiffers(column: string, member: string): Prisma.Sql {
  const col = Prisma.raw(`s."${column}"`);
  return Prisma.sql`(v.${Prisma.raw(`"${member}Given"`)} AND (
    EXISTS (SELECT 1 FROM unnest(${col}) x WHERE NOT x = ANY(${stated(member)}))
    OR EXISTS (SELECT 1 FROM unnest(${stated(member)}) x WHERE NOT x = ANY(${col}))))`;
}

/** The column after the replace: its ids that stay, in their place, then the new ones in the beat's order. */
function replaced(column: string, member: string): Prisma.Sql {
  const col = Prisma.raw(`s."${column}"`);
  return Prisma.sql`CASE WHEN ${setDiffers(column, member)} THEN
      ARRAY(SELECT x FROM unnest(${col}) WITH ORDINALITY AS o(x, n) WHERE x = ANY(${stated(member)}) ORDER BY n)
      || ARRAY(SELECT x FROM unnest(${stated(member)}) WITH ORDINALITY AS o(x, n) WHERE NOT x = ANY(${col}) ORDER BY n)
    ELSE ${col} END`;
}

/** The session's last event-path move of its sets is older than the beat, or the beat does not say when it was composed. */
function olderThanTheBeat(statedAt: Date | undefined): Prisma.Sql {
  if (!statedAt) return Prisma.sql`true`;
  return Prisma.sql`(s."executing_event_at" IS NULL OR s."executing_event_at" < ${statedAt.toISOString()}::timestamp)`;
}

/**
 * Replaces the stored sets of the sessions a beat names with what it states, as the module comment says; answers the
 * ids of the sessions whose row moved, for the caller to publish. One UPDATE of session rows by key (rank 30); the
 * rows are matched in id order.
 */
export async function replaceExecutingSets(
  prisma: Pick<PrismaService, '$queryRaw'>,
  input: { runnerId: string; leaseOwner: string | null; entries: readonly ExecutingEntry[]; statedAt?: Date },
): Promise<string[]> {
  if (!input.leaseOwner || input.entries.length === 0) return [];
  const values = input.entries.map((e) => ({
    sessionId: e.sessionId,
    turnGiven: e.engineTurnActive !== undefined,
    turn: e.engineTurnActive ?? false,
    subagentsGiven: e.subagents !== undefined,
    subagents: e.subagents ?? [],
    jobsGiven: e.jobs !== undefined,
    jobs: e.jobs ?? [],
    shellsGiven: e.shells !== undefined,
    shells: e.shells ?? [],
  }));
  const turnDiffers = Prisma.sql`(v."turnGiven" AND s."engine_turn_active" IS DISTINCT FROM v."turn")`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "session" s
       SET "engine_turn_active" = CASE WHEN v."turnGiven" THEN v."turn" ELSE s."engine_turn_active" END,
           "running_subagents" = ${replaced('running_subagents', 'subagents')},
           "running_bg_shells" = ${replaced('running_bg_shells', 'shells')},
           "running_bg_jobs" = ${replaced('running_bg_jobs', 'jobs')},
           "running_bg_job_activity" = CASE WHEN ${setDiffers('running_bg_jobs', 'jobs')} THEN
               COALESCE((SELECT jsonb_object_agg(a.key, a.value) FROM jsonb_each(s."running_bg_job_activity") a
                          WHERE a.key = ANY(${stated('jobs')})), '{}'::jsonb)
             ELSE s."running_bg_job_activity" END,
           "updated_at" = (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(
             "sessionId" uuid, "turnGiven" boolean, "turn" boolean, "subagentsGiven" boolean, "subagents" jsonb,
             "jobsGiven" boolean, "jobs" jsonb, "shellsGiven" boolean, "shells" jsonb)
     WHERE s."id" = v."sessionId"
       AND s."assigned_runner_id" = ${input.runnerId}::uuid
       AND ${sessionHeldSql('s')}
       AND s."kind" = 'CONVERSATION'
       AND s."inbox_lease_owner" = ${input.leaseOwner}::uuid
       AND ${olderThanTheBeat(input.statedAt)}
       AND (${turnDiffers} OR ${setDiffers('running_subagents', 'subagents')} OR ${setDiffers('running_bg_shells', 'shells')}
            OR ${setDiffers('running_bg_jobs', 'jobs')})
    RETURNING s."id"::text AS "id"`;
  return rows.map((r) => r.id);
}
