/**
 * What the doors answer about scheduled tasks (docs/scheduled-tasks-design.md §8.1, §9): a schedule as the list and
 * the inspector read it, this month's use, and the two cards — the create card and the envelope card — drawn from a
 * `schedule_change_request` row. The MCP tools and the REST doors answer the same shapes, so a card a session put up
 * reads the same in its tool result, in `GET /api/sessions/:id/schedule-cards` and in the owner's list of requests.
 *
 * The lines are English (CLAUDE.md §5) and follow the create card of §8.1: When, Runs in, May, Costs, Today, and the
 * line on what the person will hear about. Each line comes with the values it was written from, so a client may set
 * its own words. Every sentence is the boards' own, from @orbit/shared (SCHEDULE_COPY and its text functions), so the
 * server and the clients cannot word a line two ways (schedule-copy.spec.ts).
 */
import {
  scheduleCostsText,
  SCHEDULE_COPY,
  scheduleCreateNotice,
  scheduleCreateWhen,
  scheduleMayText,
  scheduleRuleText as sharedRuleText,
  scheduleRunsInText,
  scheduleUsageText,
  type ScheduleRule as SharedRule,
} from '@orbit/shared';
import type { Prisma, Schedule, ScheduleChangeRequest, ScheduleFinding, ScheduleRevision, ScheduleRun } from '@prisma/client';

import { runReasonText } from './schedule-attention';
import type { Envelope, EnvelopePart } from './schedule-envelope';
import { instantOfLocal, nextDueAt, offsetAt, parseRule, runsPerWeek, type ScheduleRule } from './schedule-time';

type Tx = Prisma.TransactionClient;

export { scheduleMayText };

/** "Daily 10:00", "Weekdays at 09:00", "Mondays 10:00", "Mon, Thu 10:00", "Once": the cards' short form. */
export function scheduleRuleText(rule: ScheduleRule): string {
  return sharedRuleText(rule as SharedRule, 'short');
}

/**
 * The inspector's "What it does" (§9.2): the agent's current read-back, or the current When with the first
 * sentence of the run instructions. Do not try to strip timing from free-form read-backs or the person's intent.
 */
export function scheduleReadBack(s: Pick<Schedule, 'readBack' | 'rule' | 'timezone' | 'title' | 'prompt'>): string {
  if (s.readBack) return s.readBack;
  const rule = s.rule as unknown as ScheduleRule;
  const when = rule.kind === 'ONCE' ? [scheduleRuleText(rule), rule.at.replace('T', ' ')] : [sharedRuleText(rule as SharedRule, 'long')];
  const what = s.prompt.trim().split(/(?<=[.!?])\s+|\r?\n/, 1)[0] || s.title;
  return [...when, s.timezone, what].join(SCHEDULE_COPY.separator);
}

interface WorkspaceRef {
  id: string;
  name: string | null;
}

function runsInLine(workspace: WorkspaceRef, engine: string | null) {
  const name = workspace.name ?? 'a deleted workspace';
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    engine,
    text: scheduleRunsInText(name, engine),
  };
}

function envelopeLines(e: Envelope, workspace: WorkspaceRef, engine: string | null) {
  return {
    runsIn: runsInLine(workspace, engine),
    may: { accessLevel: e.accessLevel, text: scheduleMayText(e.accessLevel) },
    costs: {
      runsPerWeek: e.runsPerWeek,
      runLimitMinutes: e.runLimitMinutes,
      text: scheduleCostsText(e.runsPerWeek, e.runLimitMinutes),
    },
  };
}

/** The names a set of cards and schedules need, read once. */
export async function workspaceNames(tx: Tx, ownerId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await tx.workspace.findMany({
    where: { id: { in: unique }, ownerId, deletedAt: null },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The engine the asking session runs, for the card's *Runs in* line. */
export async function sessionEngines(tx: Tx, ownerId: string, ids: Iterable<string>): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await tx.session.findMany({ where: { id: { in: unique }, ownerId }, select: { id: true, engine: true } });
  return new Map(rows.map((r) => [r.id, r.engine]));
}

export interface ScheduleCardContext {
  workspaces: Map<string, string>;
  engines: Map<string, string | null>;
  /** The schedule an UPDATE card is about. */
  schedules: Map<string, Pick<Schedule, 'id' | 'title' | 'timezone' | 'rule' | 'workspaceId'>>;
  now: Date;
}

/**
 * One card: the create card for a CREATE request, the envelope card (*Now* / *Asked*) for an UPDATE. `decision`
 * names the owner-channel doors that answer it; nothing else does.
 */
export function scheduleCardView(request: ScheduleChangeRequest, ctx: ScheduleCardContext) {
  const engine = request.askedBySessionId ? (ctx.engines.get(request.askedBySessionId) ?? null) : null;
  const ws = (id: string): WorkspaceRef => ({ id, name: ctx.workspaces.get(id) ?? null });
  const base = {
    id: request.id,
    kind: request.kind,
    state: request.state,
    askedBy: request.askedBy,
    askedBySessionId: request.askedBySessionId,
    scheduleId: request.scheduleId,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    resultRevision: request.resultRevision,
    decision: request.state === 'PENDING'
      ? { allow: `/api/schedule-requests/${request.id}/allow`, decline: `/api/schedule-requests/${request.id}/decline` }
      : null,
  };
  const asked = request.envelopeAsked as unknown as Envelope;
  if (request.kind === 'CREATE') {
    const p = request.proposed as unknown as {
      title: string;
      intent: string;
      readBack?: string | null;
      rule: ScheduleRule;
      timezone: string | null;
      startAt?: string | null;
      endAt?: string | null;
      baseline?: { key: string; summary?: string | null; links?: unknown[] } | null;
      findings?: string | null;
    };
    const rule = parseRule(p.rule);
    const firstRunAt = p.timezone
      ? nextDueAt(rule, p.timezone, ctx.now, {
          startAt: p.startAt ? new Date(p.startAt) : ctx.now,
          endAt: p.endAt ? new Date(p.endAt) : null,
        })
      : null;
    const lines = envelopeLines(asked, ws(asked.workspaceId), engine);
    const when = { rule, timezone: p.timezone, firstRunAt: firstRunAt?.toISOString() ?? null };
    return {
      ...base,
      title: p.title,
      readBack: p.readBack ?? p.intent,
      intent: p.intent,
      // A card with no zone has no first run yet, so the zone it falls back to is never read.
      when: { ...when, text: scheduleCreateWhen({ when: when as never }, ctx.now, p.timezone ?? 'UTC').text },
      ...lines,
      today: p.baseline
        ? { key: p.baseline.key, summary: p.baseline.summary ?? null, text: p.baseline.summary ?? p.baseline.key }
        : null,
      notice: scheduleCreateNotice(p.findings),
      envelope: null,
    };
  }
  const schedule = request.scheduleId ? ctx.schedules.get(request.scheduleId) : undefined;
  const before = request.envelopeBefore as unknown as Envelope | null;
  return {
    ...base,
    title: schedule?.title ?? null,
    readBack: null,
    intent: null,
    when: null,
    runsIn: null,
    may: null,
    costs: null,
    today: null,
    notice: null,
    proposed: request.proposed,
    envelope: {
      widens: request.widens as EnvelopePart[],
      now: before ? envelopeLines(before, ws(before.workspaceId), engine) : null,
      asked: envelopeLines(asked, ws(asked.workspaceId), engine),
    },
  };
}

export type ScheduleCardView = ReturnType<typeof scheduleCardView>;

/** Cards for a set of requests, with what they name read in two queries. */
export async function scheduleCardViews(tx: Tx, ownerId: string, requests: ScheduleChangeRequest[], now: Date) {
  const scheduleIds = requests.map((r) => r.scheduleId).filter((id): id is string => id !== null);
  const schedules = scheduleIds.length
    ? await tx.schedule.findMany({
        where: { id: { in: scheduleIds }, ownerId },
        select: { id: true, title: true, timezone: true, rule: true, workspaceId: true },
      })
    : [];
  const workspaceIds: string[] = [];
  for (const r of requests) {
    workspaceIds.push((r.envelopeAsked as unknown as Envelope).workspaceId);
    const before = r.envelopeBefore as unknown as Envelope | null;
    if (before) workspaceIds.push(before.workspaceId);
  }
  const ctx: ScheduleCardContext = {
    workspaces: await workspaceNames(tx, ownerId, workspaceIds),
    engines: await sessionEngines(tx, ownerId, requests.map((r) => r.askedBySessionId).filter((id): id is string => !!id)),
    schedules: new Map(schedules.map((s) => [s.id, s])),
    now,
  };
  return requests.map((r) => scheduleCardView(r, ctx));
}

/**
 * The record a change inside the envelope leaves in the session that made it (§4): what changed, who changed it,
 * and the door that undoes it.
 */
export function scheduleRecordView(scheduleId: string, title: string, revision: ScheduleRevision, undoneBy: number | null) {
  const fields = revision.fields as unknown as { before: Record<string, unknown> | null; after: Record<string, unknown> };
  return {
    kind: 'SCHEDULE_CHANGE_RECORD' as const,
    scheduleId,
    title,
    revision: revision.revision,
    changedBy: revision.changedBy,
    sessionId: revision.sessionId,
    changed: Object.keys(fields.after ?? {}),
    before: fields.before,
    after: fields.after,
    undoOfRevision: revision.undoOfRevision,
    undoneByRevision: undoneBy,
    createdAt: revision.createdAt.toISOString(),
    undo: revision.revision > 1 && undoneBy === null
      ? { method: 'POST', path: `/api/schedules/${scheduleId}/undo`, body: { revision: revision.revision } }
      : null,
  };
}

/** The instant this month began in `timezone`. */
export function monthStart(now: Date, timezone: string): Date {
  const local = new Date(now.getTime() + offsetAt(now.getTime(), timezone));
  return new Date(instantOfLocal(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1), timezone));
}

/**
 * "14 runs · 41 min" under This month (§4): the runs that started this month in the schedule's zone and the minutes they
 * took; a cost only where an engine reported one.
 */
export async function scheduleUsageThisMonth(tx: Tx, schedule: Pick<Schedule, 'id' | 'timezone'>, now: Date) {
  const since = monthStart(now, schedule.timezone);
  const runs = await tx.scheduleRun.findMany({
    where: { scheduleId: schedule.id, startedAt: { gte: since } },
    select: { startedAt: true, endedAt: true, sessionId: true },
  });
  let ms = 0;
  for (const r of runs) ms += Math.max(0, (r.endedAt ?? now).getTime() - r.startedAt!.getTime());
  const sessionIds = runs.map((r) => r.sessionId).filter((id): id is string => !!id);
  const cost = sessionIds.length
    ? await tx.session.aggregate({ where: { id: { in: sessionIds } }, _sum: { costUsd: true } })
    : null;
  const costUsd = cost?._sum.costUsd ?? 0;
  const minutes = Math.round(ms / 60_000);
  return {
    since: since.toISOString(),
    runs: runs.length,
    minutes,
    costUsd: costUsd > 0 ? costUsd : null,
    text: scheduleUsageText({ runs: runs.length, minutes }),
  };
}

export function scheduleRunView(run: ScheduleRun) {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    scheduleRevision: run.scheduleRevision,
    plannedAt: run.plannedAt.toISOString(),
    trigger: run.trigger,
    state: run.state,
    attempt: run.attempt,
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    sessionId: run.sessionId,
    key: run.key,
    summary: run.summary,
    links: run.links,
    failureReason: run.failureReason,
    heldReason: run.heldReason,
    /** Why the run did not start or ended, in English (an OVER_BUDGET slot says so); null when it has no reason. */
    reasonText: runReasonText(run),
  };
}

/** What a schedule's view names beyond its workspace: its agent, and the engine its runs start on. */
export interface ScheduleViewNames {
  agents: Map<string, string>;
  /** By the session a schedule came from. */
  engines: Map<string, string | null>;
}

/**
 * The agents' names and the creating sessions' engines for a set of schedules, read in two queries. The engine is the
 * one a run starts on (schedule-start-check.ts engineOf) while that session is still in the schedule's workspace.
 */
export async function scheduleViewNames(
  tx: Tx,
  ownerId: string,
  schedules: readonly Pick<Schedule, 'agentId' | 'createdFromSessionId' | 'workspaceId'>[],
): Promise<ScheduleViewNames> {
  const agentIds = [...new Set(schedules.map((s) => s.agentId).filter((id): id is string => !!id))];
  const sessionIds = [...new Set(schedules.map((s) => s.createdFromSessionId).filter((id): id is string => !!id))];
  const agents = agentIds.length
    ? await tx.agent.findMany({ where: { id: { in: agentIds }, ownerId, deletedAt: null }, select: { id: true, name: true } })
    : [];
  const sessions = sessionIds.length
    ? await tx.session.findMany({
        where: { id: { in: sessionIds }, ownerId, deletedAt: null },
        select: { id: true, engine: true, workspaceId: true },
      })
    : [];
  const byId = new Map(sessions.map((r) => [r.id, r]));
  const engines = new Map<string, string | null>();
  for (const s of schedules) {
    const origin = s.createdFromSessionId ? byId.get(s.createdFromSessionId) : undefined;
    if (origin && origin.workspaceId === s.workspaceId) engines.set(origin.id, origin.engine);
  }
  return { agents: new Map(agents.map((a) => [a.id, a.name])), engines };
}

/** A schedule as the list shows it. */
export function scheduleView(s: Schedule, workspaces: Map<string, string>, names?: ScheduleViewNames) {
  const rule = s.rule as unknown as ScheduleRule;
  return {
    id: s.id,
    title: s.title,
    intent: s.intent,
    prompt: s.prompt,
    rule,
    ruleText: scheduleRuleText(rule),
    timezone: s.timezone,
    workspaceId: s.workspaceId,
    workspaceName: workspaces.get(s.workspaceId) ?? null,
    agentId: s.agentId,
    agentName: (s.agentId && names?.agents.get(s.agentId)) || null,
    engine: (s.createdFromSessionId && names?.engines.get(s.createdFromSessionId)) || null,
    accessLevel: s.accessLevel,
    may: scheduleMayText(s.accessLevel),
    runLimitMinutes: s.runLimitMinutes,
    runsPerWeek: runsPerWeek(rule),
    envelope: {
      workspaceId: s.envelopeWorkspaceId,
      accessLevel: s.envelopeAccessLevel,
      runsPerWeek: s.envelopeRunsPerWeek,
      runLimitMinutes: s.envelopeRunLimitMinutes,
    },
    state: s.state,
    heldReason: s.heldReason,
    endedReason: s.endedReason,
    note: s.note,
    revision: s.revision,
    startAt: s.startAt.toISOString(),
    endAt: s.endAt?.toISOString() ?? null,
    nextDueAt: s.nextDueAt?.toISOString() ?? null,
    consecutiveFailures: s.consecutiveFailures,
    createdFromSessionId: s.createdFromSessionId,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  };
}

export function scheduleFindingView(f: ScheduleFinding) {
  return {
    key: f.key,
    summary: f.summary,
    firstRunId: f.firstRunId,
    lastSeenRunId: f.lastSeenRunId,
    notifiedAt: f.notifiedAt?.toISOString() ?? null,
    baseline: f.firstRunId === null,
    links: f.links,
    createdAt: f.createdAt.toISOString(),
  };
}
