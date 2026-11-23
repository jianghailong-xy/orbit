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
  scheduleWhenLines,
  type ScheduleConditionReading,
  type ScheduleRule as SharedRule,
} from '@orbit/shared';
import type { Prisma, Schedule, ScheduleChangeRequest, ScheduleFinding, ScheduleRevision, ScheduleRun } from '@prisma/client';

import { cloudWorkspaceIds } from '../managed-runners/managed-runner-work';
import { runReasonText } from './schedule-attention';
import type { Envelope, EnvelopePart } from './schedule-envelope';
import { SCHEDULE_RUN_STARTED } from './schedule-start-check';
import { instantOfLocal, nextDueAt, offsetAt, parseRule, runsPerWeek, suggestedEndAt, type ScheduleRule } from './schedule-time';

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
  // A WHEN rule has no time, so its zone says nothing.
  if (rule.kind === 'WHEN') return [...when, what(s)].join(SCHEDULE_COPY.separator);
  return [...when, s.timezone, what(s)].join(SCHEDULE_COPY.separator);
}

function what(s: Pick<Schedule, 'title' | 'prompt'>): string {
  return s.prompt.trim().split(/(?<=[.!?])\s+|\r?\n/, 1)[0] || s.title;
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

/** The runner each workspace's probes run on, for a WHEN rule's "Checked every 5 min on workstation-gpu". */
export async function workspaceRunnerNames(tx: Tx, ownerId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await tx.workspace.findMany({
    where: { id: { in: unique }, ownerId, deletedAt: null },
    select: { id: true, runner: { select: { name: true } } },
  });
  return new Map(rows.filter((r) => r.runner?.name).map((r) => [r.id, r.runner!.name]));
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
  /** The runner of each workspace a WHEN rule's card names; absent, the card leaves the runner out. */
  runners?: Map<string, string>;
  /** The workspaces a WHEN rule's card names that are on Orbit Cloud: the card says the condition keeps it awake. */
  cloud?: Set<string>;
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
      maxRuns?: number | null;
      /** §8.5: the server proposes an end 7 days out, which Create writes unless No end was pressed. */
      suggestedEnd?: boolean;
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
      when: rule.kind === 'WHEN'
        ? {
            ...when,
            // The When line of the condition-triggers board ③: the condition, its re-arm and how it is checked, and
            // the command verbatim, which is what Create approves.
            // And, on Orbit Cloud, that it keeps the workspace awake while it waits (§4.2).
            text: scheduleWhenLines(rule.condition, ctx.runners?.get(asked.workspaceId) ?? null).text,
            condition: scheduleWhenLines(
              rule.condition, ctx.runners?.get(asked.workspaceId) ?? null, ctx.cloud?.has(asked.workspaceId) ?? false,
            ),
          }
        : { ...when, text: scheduleCreateWhen({ when: when as never }, ctx.now, p.timezone ?? 'UTC').text, condition: null },
      ...lines,
      today: p.baseline
        ? { key: p.baseline.key, summary: p.baseline.summary ?? null, text: p.baseline.summary ?? p.baseline.key }
        : null,
      notice: scheduleCreateNotice(p.findings),
      // §8.5 Ends: the end the agent named, or the server's suggested one, the same local time 7 days after now (in
      // UTC until a pressing device names the zone); Create fixes it 7 days after the press. `suggested` marks the
      // server's; a pending card offers No end for it (allow with dropSuggestedEnd). Once allowed, the card reads what
      // Create wrote (decide records it on the proposal): the fixed end, or none after No end. A card declined or
      // withdrawn created nothing, so it shows no suggestion.
      ends: p.suggestedEnd === true && request.state === 'PENDING'
        ? { endAt: suggestedEndAt(ctx.now, p.timezone ?? 'UTC').toISOString(), maxRuns: null, suggested: true }
        : p.endAt || p.maxRuns != null
          ? { endAt: p.endAt ?? null, maxRuns: p.maxRuns ?? null, suggested: p.suggestedEnd === true }
          : null,
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
export async function scheduleCardViews(
  tx: Tx,
  ownerId: string,
  requests: ScheduleChangeRequest[],
  now: Date,
  gate?: { enabled: boolean } | null,
) {
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
  const whenWorkspaceIds = requests.filter((r) => (r.proposed as { rule?: { kind?: string } } | null)?.rule?.kind === 'WHEN')
    .map((r) => (r.envelopeAsked as unknown as Envelope).workspaceId);
  const ctx: ScheduleCardContext = {
    workspaces: await workspaceNames(tx, ownerId, workspaceIds),
    engines: await sessionEngines(tx, ownerId, requests.map((r) => r.askedBySessionId).filter((id): id is string => !!id)),
    schedules: new Map(schedules.map((s) => [s.id, s])),
    runners: await workspaceRunnerNames(tx, ownerId, whenWorkspaceIds),
    cloud: await cloudWorkspaceIds(tx, gate, whenWorkspaceIds),
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
    askedText: revision.askedText ?? null,
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
  /** A WHEN schedule's condition, by the schedule's id. */
  conditions?: Map<string, ScheduleConditionReading>;
  /** The runs each schedule has started in all, by the schedule's id (§8.5); absent counts as none. */
  runsStarted?: Map<string, number>;
}

/**
 * The agents' names and the creating sessions' engines for a set of schedules, read in two queries. The engine is the
 * one a run starts on (schedule-start-check.ts engineOf) while that session is still in the schedule's workspace.
 */
export async function scheduleViewNames(
  tx: Tx,
  ownerId: string,
  schedules: readonly Pick<Schedule, 'id' | 'agentId' | 'createdFromSessionId' | 'workspaceId' | 'rule'>[],
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
  const whenIds = schedules.filter((s) => (s.rule as { kind?: string } | null)?.kind === 'WHEN').map((s) => s.id);
  const conditions = whenIds.length
    ? await tx.condition.findMany({
        where: { scheduleId: { in: whenIds }, ownerId },
        select: { id: true, scheduleId: true, text: true, unit: true, state: true, lastValue: true, lastSampleAt: true },
      })
    : [];
  // §8.5: started as §4's budget counts them (scheduleRunsStarted), a retried start being the same row.
  const started = schedules.length
    ? await tx.scheduleRun.groupBy({
        by: ['scheduleId'],
        where: { scheduleId: { in: schedules.map((s) => s.id) }, ...SCHEDULE_RUN_STARTED },
        _count: { _all: true },
      })
    : [];
  return {
    agents: new Map(agents.map((a) => [a.id, a.name])),
    engines,
    runsStarted: new Map(started.map((g) => [g.scheduleId, g._count._all])),
    conditions: new Map(conditions.map((c) => [c.scheduleId!, {
      id: c.id,
      text: c.text,
      unit: c.unit,
      state: c.state,
      lastValue: c.lastValue,
      lastSampleAt: c.lastSampleAt?.toISOString() ?? null,
    }])),
  };
}

/** A schedule as the list shows it. */
export function scheduleView(s: Schedule, workspaces: Map<string, string>, names?: ScheduleViewNames) {
  const rule = s.rule as unknown as ScheduleRule;
  const runsStarted = names?.runsStarted?.get(s.id) ?? 0;
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
      commandHash: s.envelopeCommandHash,
    },
    state: s.state,
    heldReason: s.heldReason,
    endedReason: s.endedReason,
    note: s.note,
    revision: s.revision,
    startAt: s.startAt.toISOString(),
    endAt: s.endAt?.toISOString() ?? null,
    /** The planned end by count (§8.5), and how far along it is: clients read "3 runs left" from runsLeft. */
    maxRuns: s.maxRuns,
    runsStarted,
    runsLeft: s.maxRuns === null ? null : Math.max(0, s.maxRuns - runsStarted),
    nextDueAt: s.nextDueAt?.toISOString() ?? null,
    consecutiveFailures: s.consecutiveFailures,
    createdFromSessionId: s.createdFromSessionId,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    /** A WHEN rule's condition with its newest reading and its age (condition-triggers board ④); null for a timed one. */
    condition: names?.conditions?.get(s.id) ?? null,
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
