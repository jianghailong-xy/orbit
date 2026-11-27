/**
 * Scheduled tasks' domain methods (docs/scheduled-tasks-design.md §3, §4, §8): create, update, decide, pause,
 * resume, end, delete and undo. The tools and REST doors of later tasks call these; nothing here fires a run or
 * opens a session.
 *
 * WHO IS ASKING
 * =============
 * Every method takes a `ScheduleActor`:
 *   * OWNER — the owner-authenticated channel with no acting session: a person pressing Create, Allow or Undo.
 *     It is the only actor whose decision writes a wider envelope.
 *   * PAT — a personal access token. It may use the controls (pause, resume, end, delete, undo) but never create,
 *     change or decide: those are the owner's own decision (OWNER_INTERACTIVE_CREDENTIAL_REQUIRED).
 *   * SESSION — an agent session of the owner. When the session serves a run of the schedule being changed
 *     (`session.scheduleRunId` → that schedule) it is the RUN, whose narrowing does not shrink the envelope.
 *
 * THE RULE (§4, schedule-envelope.ts)
 * ===================================
 * A change from a session inside the envelope applies at once and writes a ScheduleRevision. A change that grows
 * it — another workspace, a wider access level, more runs a week, a longer run limit — applies nothing and is
 * written as a PENDING ScheduleChangeRequest, which only the OWNER's Allow applies. A session's create is always
 * such a request: the card's Create is the press that writes the first envelope. A session cannot ask for an
 * access level whose mode is wider than its own (PERMISSION_MODE_WIDER_THAN_SESSION).
 *
 * LOCKS
 * =====
 * Every write runs in one transaction that takes the per-account advisory lock first (SCHEDULE_LOCK_NAMESPACE, the
 * owner id's hash) — which is what makes SCHEDULE_LIMIT a count that two concurrent creates cannot both pass — and
 * then the one schedule row FOR UPDATE.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  type Schedule,
  type ScheduleChangeRequest,
  type ScheduleChangedBy,
  type ScheduleEndedReason,
  type ScheduleState,
} from '@prisma/client';

import { PatRefusal, patForbiddenBody } from '../auth/pat-scope.decorator';
import { isWiderThanStarter, resolvePermissionMode, widerModeRefusal } from '../common/permission-mode';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_LEVEL_MODE,
  DEFAULT_RUN_LIMIT_MINUTES,
  MAX_RUN_LIMIT_MINUTES,
  judgeEnvelopeChange,
  sameEnvelope,
  type AccessLevel,
  type Envelope,
} from './schedule-envelope';
import {
  ScheduleRuleError,
  assertTimezone,
  mergeRule,
  nextDueAt,
  parseRule,
  ruleCommandHash,
  runsPerWeek,
  suggestedEndAt,
  type ScheduleRule,
} from './schedule-time';
import { closeUnknownItems } from '../conditions/condition-attention';
import { assertConditionRoom, createConditionRow } from '../conditions/conditions.service';
import { MANAGED_RUNNER_DEMAND, type ManagedRunnerDemand } from '../managed-runners/managed-runner-demand';
import { RealtimeService } from '../realtime/realtime.service';
import { isBackgroundWakeTurn } from '../runner-api/background-job-wake';
import { isSessionReplyTurn } from '../sessions/session-request';
import { SCHEDULE_ACCESS_NOT_ENFORCEABLE, scheduleRunMode } from './schedule-access';
import { scheduleRunsStarted, scheduleStartCheck } from './schedule-start-check';
import { workspaceNames } from './schedule-views';
import {
  SCHEDULE_NOTIFIER,
  closeScheduleItems,
  fileScheduleItem,
  goalReachedCopy,
  heldClause,
  sendAlerts,
  widenCopy,
  type ScheduleAlert,
  type ScheduleNotifier,
} from './schedule-attention';

/** At most this many schedules that are not ENDED per account (§3). */
export const SCHEDULE_LIMIT = 50;

/** The clock a spec may provide in place of the wall clock. */
export const SCHEDULE_CLOCK = Symbol('SCHEDULE_CLOCK');

/** pg_advisory_xact_lock namespace for the per-account schedule serializer. */
export const SCHEDULE_LOCK_NAMESPACE = 4000750;

export type ScheduleActor =
  | { kind: 'OWNER'; ownerId: string }
  | { kind: 'PAT'; ownerId: string }
  | { kind: 'SESSION'; ownerId: string; sessionId: string };

export interface ScheduleBaseline {
  key: string;
  summary?: string | null;
  links?: unknown[];
}

export interface ScheduleCreateInput {
  intent: string;
  title: string;
  prompt: string;
  rule: unknown;
  /**
   * The IANA zone the person named. A session may leave it out: the create card then takes the zone of the device
   * that presses Create (§5.1), which the OWNER's Allow supplies.
   */
  timezone?: string | null;
  accessLevel: AccessLevel;
  runLimitMinutes?: number;
  startAt?: Date;
  endAt?: Date | null;
  /** The planned end by count (§8.5): the schedule stops after this many runs have started. */
  maxRuns?: number | null;
  baseline?: ScheduleBaseline;
  /** The OWNER names it; a session's create always uses the session's own workspace. */
  workspaceId?: string;
  /**
   * The card's read-back: one sentence in the agent's words saying what it will do ("Every day at 10:00 Beijing
   * time I check …"). Kept on the CREATE request, which is where the card and the inspector read it from.
   */
  readBack?: string | null;
  /**
   * What a new finding of this task is, as a plural noun ("versions", "issues"): the card's last line says "You'll hear
   * about new versions and failures only." Without it the line says findings.
   */
  findings?: string | null;
}

/** What the owner's press on a card may carry. */
export interface ScheduleDecisionInput {
  /** The pressing device's IANA zone, taken only when the CREATE proposal names none (§5.1). */
  timezone?: string | null;
  /**
   * The create card's **No end** (§8.5): Create writes no end instead of the suggested one. A card that carries no
   * suggested end ignores it; an end the person or agent named is never removed by it.
   */
  dropSuggestedEnd?: boolean;
}

export type ScheduleDecisionResult =
  | { outcome: 'ALLOWED' | 'DECLINED'; request: ScheduleChangeRequest; schedule: Schedule | null }
  /** An UPDATE asked against a revision the schedule has moved past: superseded, nothing applied. */
  | {
      outcome: 'STALE';
      request: ScheduleChangeRequest;
      schedule: Schedule | null;
      /** REVISION_MOVED: the schedule changed since the ask. WORKSPACE_GONE: the workspace it names is no longer the owner's. */
      reason: 'REVISION_MOVED' | 'WORKSPACE_GONE';
    };

/** What a change may touch. `intent` changes only when the person restates the goal (§8.2). */
export interface SchedulePatch {
  /** Dropped when the patch only reschedules (`isOnlyReschedule`): a correction of the time is not a new goal. */
  intent?: string;
  /**
   * A new read-back for the schedule as it is after the change, at most 500 characters. Recorded and undoable.
   * A rule or time-zone change without one clears the stored one, and the read derives it. Null restores a cleared value on undo.
   */
  readBack?: string | null;
  title?: string;
  prompt?: string;
  rule?: unknown;
  timezone?: string;
  endAt?: Date | null;
  /** null removes it. At or below the runs already started is refused (SCHEDULE_MAX_RUNS_ALREADY_REACHED). */
  maxRuns?: number | null;
  accessLevel?: AccessLevel;
  runLimitMinutes?: number;
  workspaceId?: string;
}

export type ScheduleCreateResult =
  | { outcome: 'CREATED'; schedule: Schedule }
  | { outcome: 'PENDING'; request: ScheduleChangeRequest }
  /** §8.1: the calling session already created this one (same workspace, same title or intent); no card was raised. */
  | { outcome: 'EXISTS'; schedule: Schedule };

export type ScheduleAppliedResult =
  | { outcome: 'APPLIED'; schedule: Schedule; revision: number }
  | { outcome: 'UNCHANGED'; schedule: Schedule };

export type ScheduleUpdateResult = ScheduleAppliedResult | { outcome: 'PENDING'; request: ScheduleChangeRequest };

/** An update's result, and whether the intent it carried was left alone because the patch only reschedules. */
export type ScheduleUpdateAnswer = ScheduleUpdateResult & { intentKept?: boolean };

type Tx = Prisma.TransactionClient;

/** The fields a revision records, as stored JSON. */
type FieldValues = Record<string, unknown>;

const PATCH_FIELDS = [
  'intent', 'title', 'prompt', 'rule', 'timezone', 'endAt', 'maxRuns', 'accessLevel', 'runLimitMinutes', 'workspaceId',
  'readBack',
] as const;

/** The fields that say when and how much a schedule runs: a change of these alone is no restated goal (§8.2). */
const RESCHEDULE_FIELDS = ['rule', 'timezone', 'endAt', 'maxRuns', 'accessLevel', 'runLimitMinutes'] as const;

/**
 * Whether `patch` changes only when and how much the schedule runs, besides any intent and read-back it carries:
 * the person corrected the time, the frequency or the limits ("make it weekly", "change it back to 09:00"), which
 * §8.2 says leaves what was asked alone. A new prompt, title or workspace may come with a restated goal.
 */
export function isOnlyReschedule(patch: SchedulePatch): boolean {
  if (patch.prompt !== undefined || patch.title !== undefined || patch.workspaceId !== undefined) return false;
  return RESCHEDULE_FIELDS.some((key) => patch[key] !== undefined);
}

/** Title or intent compared as a person reads them: case, spacing and surrounding whitespace aside. */
function sameWords(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

interface ResolvedActor {
  changedBy: ScheduleChangedBy;
  sessionId: string | null;
  /** The session's mode and engine, for the permission-mode ceiling. */
  session: { mode: string; engine: string | null; workspaceId: string | null } | null;
  /** The schedule the calling session serves a run of (`session.scheduleRunId`), or null. */
  servesScheduleId: string | null;
  /** The person's words that asked for the change, when it comes from the schedule's change conversation (§8.2). */
  askedText?: string | null;
}

/** What a run's own session may do to its schedule (§8.3): change it inside the envelope, or end it. */
export type ScheduleRunSessionAction = 'CREATE' | 'UPDATE' | 'END' | 'CONTROL';

/**
 * §8.3: a session serving a run may update and end the schedule it serves, and nothing else — no other schedule, no
 * new one, and none of the person's controls (pause, resume, run now, stop, delete, undo).
 */
export function assertRunSessionScope(
  servesScheduleId: string | null,
  scheduleId: string | null,
  action: ScheduleRunSessionAction,
): void {
  if (servesScheduleId === null) return;
  if ((action === 'UPDATE' || action === 'END') && scheduleId === servesScheduleId) return;
  throw new ForbiddenException({
    code: 'SCHEDULE_RUN_SESSION_SCOPE',
    message:
      scheduleId !== null && scheduleId !== servesScheduleId
        ? 'A scheduled run may change only the schedule it serves; this is another one. Nothing was changed.'
        : 'A scheduled run may change its own schedule inside its envelope, or end it, and nothing else. '
          + 'Nothing was changed; say in the report what the person should do.',
  });
}

/** The schedule a session serves a run of, or null for an ordinary session (or no session). */
export async function runSessionScheduleId(tx: Prisma.TransactionClient, actor: ScheduleActor): Promise<string | null> {
  if (actor.kind !== 'SESSION') return null;
  const session = await tx.session.findFirst({
    where: { id: actor.sessionId, ownerId: actor.ownerId },
    select: { scheduleRun: { select: { scheduleId: true } } },
  });
  return session?.scheduleRun?.scheduleId ?? null;
}

function refusal(status: 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND', code: string, message: string): Error {
  const body = { code, message };
  switch (status) {
    case 'BAD_REQUEST':
      return new BadRequestException(body);
    case 'CONFLICT':
      return new ConflictException(body);
    case 'FORBIDDEN':
      return new ForbiddenException(body);
    case 'NOT_FOUND':
      return new NotFoundException(body);
  }
}

function patRefusal(): PatRefusal {
  return new PatRefusal(patForbiddenBody('OWNER_INTERACTIVE'));
}

function ruleOf(raw: unknown): ScheduleRule {
  try {
    return parseRule(raw);
  } catch (err) {
    if (err instanceof ScheduleRuleError) throw refusal('BAD_REQUEST', err.code, err.message);
    throw err;
  }
}

/** A change's rule, merged onto the WHEN rule it changes (schedule-time.ts mergeRule), then validated. */
function ruleAfter(current: ScheduleRule, raw: unknown): ScheduleRule {
  try {
    return parseRule(mergeRule(current, raw));
  } catch (err) {
    if (err instanceof ScheduleRuleError) throw refusal('BAD_REQUEST', err.code, err.message);
    throw err;
  }
}

function checkTimezone(timezone: string): void {
  try {
    assertTimezone(timezone);
  } catch (err) {
    if (err instanceof ScheduleRuleError) throw refusal('BAD_REQUEST', err.code, err.message);
    throw err;
  }
}

function checkRunLimit(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUN_LIMIT_MINUTES) {
    throw refusal(
      'BAD_REQUEST',
      'SCHEDULE_RUN_LIMIT_INVALID',
      `A run limit is a whole number of minutes from 1 to ${MAX_RUN_LIMIT_MINUTES}.`,
    );
  }
}

/** An EVERY rule's run ends before its next slot is due: its run limit is shorter than its interval. */
function checkRunLimitFitsRule(rule: ScheduleRule, runLimitMinutes: number): void {
  if (rule.kind === 'EVERY' && runLimitMinutes >= rule.minutes) {
    throw refusal(
      'BAD_REQUEST',
      'SCHEDULE_RUN_LIMIT_NOT_SHORTER_THAN_INTERVAL',
      `A run limit of ${runLimitMinutes} minutes is not shorter than the ${rule.minutes}-minute interval: ` +
        `give a run limit under ${rule.minutes} minutes, or a longer interval.`,
    );
  }
}

/** The run limit a schedule gets when it names none: half an EVERY rule's interval, at most the default (30). */
function defaultRunLimit(rule: ScheduleRule): number {
  return rule.kind === 'EVERY' ? Math.min(DEFAULT_RUN_LIMIT_MINUTES, rule.minutes / 2) : DEFAULT_RUN_LIMIT_MINUTES;
}

/** A planned end by count is a whole number of started runs, at least 1 (§8.5); null is none. */
function checkMaxRuns(value: unknown): void {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw refusal('BAD_REQUEST', 'SCHEDULE_MAX_RUNS_INVALID', 'maxRuns is a whole number of runs, at least 1.');
  }
}

/**
 * A planned end by count must lie ahead of the runs already started (§8.5): one at or below them is refused, since
 * ending now is schedule_end. Read under the schedule lock the change holds.
 */
async function assertMaxRunsAhead(tx: Tx, scheduleId: string, maxRuns: unknown): Promise<void> {
  if (typeof maxRuns !== 'number') return;
  const started = await scheduleRunsStarted(tx, scheduleId);
  if (maxRuns > started) return;
  throw refusal(
    'CONFLICT',
    'SCHEDULE_MAX_RUNS_ALREADY_REACHED',
    `This schedule has already started ${started} ${started === 1 ? 'run' : 'runs'}; maxRuns must be more than that. `
      + 'To stop it now, end it instead.',
  );
}

/** Whether a create card proposes the 7-day end (§8.5): an EVERY rule that names neither endAt nor maxRuns. */
function suggestsEnd(n: { rule: ScheduleRule; endAt: Date | null; maxRuns: number | null }): boolean {
  return n.rule.kind === 'EVERY' && n.endAt === null && n.maxRuns === null;
}

function checkAccessLevel(level: unknown): asserts level is AccessLevel {
  if (level !== 'CHECK_ONLY' && level !== 'OPEN_PR' && level !== 'LAND') {
    throw refusal('BAD_REQUEST', 'SCHEDULE_ACCESS_LEVEL_INVALID', 'An access level is CHECK_ONLY, OPEN_PR or LAND.');
  }
}

function checkReadBack(value: unknown): void {
  if (typeof value !== 'string' || value.length > 500) {
    throw refusal('BAD_REQUEST', 'SCHEDULE_FIELD_INVALID', 'A read-back is one sentence of at most 500 characters.');
  }
}

function checkText(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw refusal('BAD_REQUEST', 'SCHEDULE_FIELD_INVALID', `A schedule's ${name} is a non-empty string.`);
  }
}

/** What a schedule's settings need of the envelope. */
function needOf(s: { workspaceId: string; accessLevel: AccessLevel; rule: unknown; runLimitMinutes: number }): Envelope {
  const rule = ruleOf(s.rule);
  return {
    workspaceId: s.workspaceId,
    accessLevel: s.accessLevel,
    runsPerWeek: runsPerWeek(rule),
    runLimitMinutes: s.runLimitMinutes,
    commandHash: ruleCommandHash(rule),
  };
}

/** The person's latest message in a session: the words a change from it was asked with. */
async function personsLatestWords(tx: Tx, sessionId: string): Promise<string | null> {
  const turns = await tx.conversationTurn.findMany({
    where: { sessionId, kind: 'message', senderSessionId: null },
    orderBy: { seq: 'desc' },
    take: 10,
    select: { content: true, clientTurnId: true },
  });
  const said = turns.find((t) => !isBackgroundWakeTurn(t.clientTurnId) && !isSessionReplyTurn(t.clientTurnId) && t.content?.trim());
  return said?.content?.trim().slice(0, 2000) ?? null;
}

function envelopeOf(s: Schedule): Envelope {
  return {
    workspaceId: s.envelopeWorkspaceId,
    accessLevel: s.envelopeAccessLevel,
    runsPerWeek: s.envelopeRunsPerWeek,
    runLimitMinutes: s.envelopeRunLimitMinutes,
    commandHash: s.envelopeCommandHash,
  };
}

function envelopeColumns(e: Envelope) {
  return {
    envelopeWorkspaceId: e.workspaceId,
    envelopeAccessLevel: e.accessLevel,
    envelopeRunsPerWeek: e.runsPerWeek,
    envelopeRunLimitMinutes: e.runLimitMinutes,
    envelopeCommandHash: e.commandHash ?? null,
  };
}

/** A WHEN schedule's condition probes while the schedule is ACTIVE or HELD; paused or ended, it is ENDED. */
function conditionLive(state: ScheduleState): boolean {
  return state === 'ACTIVE' || state === 'HELD';
}

/** A field as a revision stores it. */
function stored(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

/** Key order is not significant: JSONB stores an object's keys in its own order. */
function canonical(value: unknown): unknown {
  const v = stored(value);
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as FieldValues)[k])]));
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const SESSION_MAY_NOT_WIDEN =
  'Ask for CHECK_ONLY, or ask the person to make the change from a session whose permission mode allows it.';

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SCHEDULE_CLOCK) clock?: () => Date,
    /** Who hears (§7.3): a run's widen card and a run ending its own schedule. Absent, nothing is pushed. */
    @Optional() @Inject(SCHEDULE_NOTIFIER) private readonly notifier?: ScheduleNotifier,
    /**
     * A WHEN schedule's condition is handed to its runner on the heartbeat's full reconcile; marking the runner changed
     * after a commit that creates, changes, pauses or ends one brings that reconcile at once (link-heartbeat.ts).
     */
    @Optional() @Inject(RealtimeService) private readonly realtime?: Pick<RealtimeService, 'markRunnerChanged'>
      & Partial<Pick<RealtimeService, 'publishScheduleCardsChanged'>>,
    /**
     * An ACTIVE WHEN schedule's condition is demand for its workspace's Orbit Cloud runner (docs/condition-triggers-design.md
     * §4.2): a create, a resume or a change that leaves it ACTIVE asks a sleeping one to wake. The hook does nothing with
     * the switch off or for a runner with no mapping; absent, the manager's sweep finds it.
     */
    @Optional() @Inject(MANAGED_RUNNER_DEMAND) private readonly managedDemand?: ManagedRunnerDemand,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  private async alert(alerts: readonly ScheduleAlert[]): Promise<void> {
    await sendAlerts(this.notifier, alerts, (m) => this.logger.warn(m));
  }

  /**
   * After a commit that touched a WHEN schedule: its condition's probe was handed out, changed or withdrawn, so its
   * runner is marked changed; and an ACTIVE one's Orbit Cloud runner is asked to wake. Best effort: a mark that fails leaves it to the next full reconcile, at most five
   * minutes away.
   */
  private async markConditionRunner(schedule: Schedule | null | undefined): Promise<void> {
    if (!schedule || (schedule.rule as { kind?: string } | null)?.kind !== 'WHEN') return;
    const wake = schedule.state === 'ACTIVE' && !!this.managedDemand;
    if (!this.realtime && !wake) return;
    try {
      const workspace = await this.prisma.workspace.findUnique({ where: { id: schedule.workspaceId }, select: { runnerId: true } });
      if (workspace?.runnerId) {
        this.realtime?.markRunnerChanged(workspace.runnerId);
        // Paused, held or ended, nothing is asked: the condition no longer holds the runner, which sleeps by the idle rule.
        if (wake) await this.managedDemand!.requested(workspace.runnerId, 'condition');
      }
    } catch (error) {
      this.logger.warn(`runner of schedule ${schedule.id} not marked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * After a commit that moved what some sessions' schedule cards read (`GET /sessions/:id/schedule-cards`), tell the
   * owner's clients which (`schedule_cards.changed`): the sessions named, and every session whose cards or change
   * records name `scheduleId`, which draw its title, rule and state. Best effort: a read that fails leaves them to the
   * cards' safety read.
   */
  private async announceCards(
    ownerId: string,
    scheduleId: string | null | undefined,
    sessionIds: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    if (!this.realtime?.publishScheduleCardsChanged) return;
    try {
      const [asked, recorded] = scheduleId
        ? await Promise.all([
            this.prisma.scheduleChangeRequest.findMany({
              where: { ownerId, scheduleId, askedBySessionId: { not: null } },
              select: { askedBySessionId: true },
              distinct: ['askedBySessionId'],
            }),
            this.prisma.scheduleRevision.findMany({
              where: { scheduleId, sessionId: { not: null } },
              select: { sessionId: true },
              distinct: ['sessionId'],
            }),
          ])
        : [[], []];
      this.realtime.publishScheduleCardsChanged(ownerId, [
        ...sessionIds,
        ...asked.map((row) => row.askedBySessionId),
        ...recorded.map((row) => row.sessionId),
      ]);
    } catch (error) {
      this.logger.warn(`schedule cards of ${scheduleId ?? 'a new card'} not announced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The session an actor writes as, if any. */
  private static sessionOf(actor: ScheduleActor): string | null {
    return actor.kind === 'SESSION' ? actor.sessionId : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The OWNER's create writes the schedule and its envelope. A session's waits on a CREATE request (the create card),
   * which the OWNER's Allow turns into the schedule; it uses the session's own workspace.
   */
  async create(actor: ScheduleActor, input: ScheduleCreateInput): Promise<ScheduleCreateResult> {
    if (actor.kind === 'PAT') throw patRefusal();
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await this.lockAccount(tx, actor.ownerId);
        const who = await this.resolveActor(tx, actor, null);
        assertRunSessionScope(who.servesScheduleId, null, 'CREATE');
        const workspaceId = who.session ? who.session.workspaceId : (input.workspaceId ?? null);
        if (!workspaceId) {
          throw refusal('BAD_REQUEST', 'SCHEDULE_WORKSPACE_REQUIRED', 'A schedule runs in a workspace; the session has none.');
        }
        const normalized = this.normalizeCreate(input, workspaceId, actor.kind === 'SESSION');
        if (who.session) {
          this.assertEnforceable(who.session.engine, normalized.accessLevel);
          this.assertWithinSessionMode(who.session, normalized.accessLevel);
        }
        if (actor.kind === 'SESSION') {
          // §8.1: a session that already created this schedule is changing it, not asking for a second one.
          const mine = await tx.schedule.findMany({
            where: { ownerId: actor.ownerId, createdFromSessionId: actor.sessionId, workspaceId, state: { not: 'ENDED' } },
            orderBy: { createdAt: 'desc' },
          });
          const existing = mine.find((s) => sameWords(s.title, normalized.title) || sameWords(s.intent, normalized.intent));
          if (existing) return { outcome: 'EXISTS' as const, schedule: existing };
        }
        await this.assertUnderLimit(tx, actor.ownerId);
        if (actor.kind === 'SESSION') {
          const request = await tx.scheduleChangeRequest.create({
            data: {
              ownerId: actor.ownerId,
              kind: 'CREATE',
              askedBy: who.changedBy,
              askedBySessionId: who.sessionId,
              proposed: this.createProposal(normalized, suggestsEnd(normalized)),
              envelopeAsked: needOf(normalized) as unknown as Prisma.InputJsonValue,
              widens: [],
            },
          });
          return { outcome: 'PENDING' as const, request };
        }
        const schedule = await this.insertSchedule(tx, actor.ownerId, normalized as NormalizedCreate & { timezone: string }, null, 'USER', null);
        return { outcome: 'CREATED' as const, schedule };
      },
      loggedRetry(this.logger, 'schedules.create'),
    );
    if (result.outcome === 'CREATED') await this.markConditionRunner(result.schedule);
    if (result.outcome === 'CREATED') await this.announceCards(actor.ownerId, result.schedule.id, [SchedulesService.sessionOf(actor)]);
    if (result.outcome === 'PENDING') await this.announceCards(actor.ownerId, null, [result.request.askedBySessionId]);
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------------------------------------------

  /** §4: inside the envelope it applies at once; outside it waits on a request only the OWNER's Allow applies. */
  async update(actor: ScheduleActor, scheduleId: string, patch: SchedulePatch): Promise<ScheduleUpdateAnswer> {
    if (actor.kind === 'PAT') throw patRefusal();
    if (patch.readBack !== undefined) checkReadBack(patch.readBack);
    // §8.2: "make it weekly" is a correction of the time, not a restated goal; what was asked stays.
    const intentKept = patch.intent !== undefined && isOnlyReschedule(patch);
    if (intentKept) patch = { ...patch, intent: undefined };
    const alerts: ScheduleAlert[] = [];
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        await this.lockAccount(tx, actor.ownerId);
        const schedule = await this.lockSchedule(tx, actor.ownerId, scheduleId);
        const who = await this.resolveActor(tx, actor, scheduleId);
        assertRunSessionScope(who.servesScheduleId, scheduleId, 'UPDATE');
        if (who.changedBy === 'RUN' && patch.intent !== undefined) {
          // §8.2: the intent is the person's words, changed only when the person restates the goal.
          throw new ForbiddenException({
            code: 'SCHEDULE_RUN_MAY_NOT_RESTATE_INTENT',
            message: 'A scheduled run may rewrite its prompt but not what the person asked; nothing was changed.',
          });
        }
        if (patch.workspaceId !== undefined) await this.assertOwnWorkspace(tx, actor.ownerId, patch.workspaceId);
        return this.changeLocked(tx, actor, who, schedule, patch, null, alerts);
      },
      loggedRetry(this.logger, 'schedules.update'),
    );
    await this.alert(alerts);
    if (result.outcome === 'APPLIED') await this.markConditionRunner(result.schedule);
    if (result.outcome !== 'UNCHANGED') {
      await this.announceCards(actor.ownerId, scheduleId, [SchedulesService.sessionOf(actor)]);
    }
    return intentKept ? { ...result, intentKept } : result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Decide
  // -------------------------------------------------------------------------------------------------------------

  /**
   * The press on a create or envelope card. Owner channel only: a session and a PAT are refused. A CREATE whose
   * proposal names no time zone takes the pressing device's (`input.timezone`); one that names a zone refuses
   * another. An UPDATE asked against a revision the schedule has since moved past is superseded, not applied.
   */
  async decide(
    actor: ScheduleActor,
    requestId: string,
    decision: 'ALLOW' | 'DECLINE',
    input: ScheduleDecisionInput = {},
  ): Promise<ScheduleDecisionResult> {
    if (actor.kind === 'PAT') throw patRefusal();
    if (actor.kind === 'SESSION') {
      throw new ForbiddenException({
        code: 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY',
        requiredAction: 'ASK_A_PERSON',
        message:
          'Allowing a scheduled task, or a change that grows what it may do, is the account owner\'s own decision, made '
          + 'signed in to Orbit with no acting session. Nothing was changed; the card is waiting for them.',
      });
    }
    const answer = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await this.lockAccount(tx, actor.ownerId);
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "schedule_change_request" WHERE "id" = ${requestId}::uuid AND "owner_id" = ${actor.ownerId}::uuid
          FOR UPDATE`;
        if (rows.length === 0) throw refusal('NOT_FOUND', 'SCHEDULE_REQUEST_NOT_FOUND', 'No such schedule request.');
        const request = await tx.scheduleChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (request.state !== 'PENDING') {
          throw refusal('CONFLICT', 'SCHEDULE_REQUEST_DECIDED', `This request is already ${request.state}.`);
        }
        const now = this.clock();
        const decided = await (async (): Promise<ScheduleDecisionResult> => {
          if (decision === 'DECLINE') {
            const declined = await tx.scheduleChangeRequest.update({
              where: { id: requestId },
              data: { state: 'DECLINED', decidedAt: now, decidedByUserId: actor.ownerId },
            });
            return { outcome: 'DECLINED' as const, request: declined, schedule: null };
          }
          if (request.kind === 'CREATE') {
            await this.assertUnderLimit(tx, actor.ownerId);
            const proposal = this.createFromProposal(request.proposed as unknown as FieldValues);
            const pressed = input.timezone ?? null;
            if (proposal.timezone !== null && pressed !== null && pressed !== proposal.timezone) {
              throw refusal(
                'BAD_REQUEST',
                'SCHEDULE_TIMEZONE_ALREADY_SET',
                `The card already names its time zone (${proposal.timezone}); a pressing device's zone is taken only `
                  + 'when it names none.',
              );
            }
            const timezone = proposal.timezone ?? pressed;
            if (timezone === null) {
              throw refusal(
                'BAD_REQUEST',
                'SCHEDULE_TIMEZONE_REQUIRED',
                'This card names no time zone: Create must carry the pressing device\'s IANA time zone.',
              );
            }
            checkTimezone(timezone);
            // §8.5: the card's suggested end is the same local time 7 days after this press, unless No end was pressed.
            const suggested = (request.proposed as FieldValues).suggestedEnd === true;
            if (suggested && input.dropSuggestedEnd !== true) {
              proposal.endAt = suggestedEndAt(now, timezone);
            }
            // Re-judged as the world is now: a workspace deleted since the ask is not one to start runs in.
            if (!(await this.ownsWorkspace(tx, actor.ownerId, proposal.workspaceId))) {
              const superseded = await tx.scheduleChangeRequest.update({
                where: { id: requestId },
                data: { state: 'SUPERSEDED', decidedAt: now },
              });
              return { outcome: 'STALE' as const, request: superseded, schedule: null, reason: 'WORKSPACE_GONE' as const };
            }
            const schedule = await this.insertSchedule(
              tx,
              actor.ownerId,
              { ...proposal, timezone },
              request.askedBySessionId,
              'USER',
              request.askedBySessionId,
            );
            const allowed = await tx.scheduleChangeRequest.update({
              where: { id: requestId },
              data: {
                state: 'ALLOWED',
                decidedAt: now,
                decidedByUserId: actor.ownerId,
                scheduleId: schedule.id,
                resultRevision: 1,
                // §8.5: the decided card keeps what Create made of the suggestion: the end it fixed, still marked
                // suggested, or none when No end was pressed.
                ...(suggested
                  ? {
                      proposed: {
                        ...(request.proposed as FieldValues),
                        endAt: proposal.endAt?.toISOString() ?? null,
                        suggestedEnd: proposal.endAt !== null,
                      } as Prisma.InputJsonValue,
                    }
                  : {}),
              },
            });
            return { outcome: 'ALLOWED' as const, request: allowed, schedule };
          }
          if (input.timezone != null) {
            throw refusal('BAD_REQUEST', 'SCHEDULE_TIMEZONE_NOT_TAKEN', 'Only a create card takes the pressing device\'s time zone.');
          }
          const schedule = await this.lockSchedule(tx, actor.ownerId, request.scheduleId!);
          if (request.baseRevision !== null && request.baseRevision !== schedule.revision) {
            // Re-judged against the schedule as it is now: what was asked was asked of revision N, and the schedule
            // has moved on. Applying the patch blind could widen something the person never saw on this card.
            const superseded = await tx.scheduleChangeRequest.update({
              where: { id: requestId },
              data: { state: 'SUPERSEDED', decidedAt: now },
            });
            return { outcome: 'STALE' as const, request: superseded, schedule, reason: 'REVISION_MOVED' as const };
          }
          const moveTo = (request.proposed as FieldValues).workspaceId;
          if (typeof moveTo === 'string' && !(await this.ownsWorkspace(tx, actor.ownerId, moveTo))) {
            // Deleting a workspace bumps no revision, so the revision check above cannot see it.
            const superseded = await tx.scheduleChangeRequest.update({
              where: { id: requestId },
              data: { state: 'SUPERSEDED', decidedAt: now },
            });
            return { outcome: 'STALE' as const, request: superseded, schedule, reason: 'WORKSPACE_GONE' as const };
          }
          const who: ResolvedActor = {
            changedBy: request.askedBy,
            sessionId: request.askedBySessionId,
            session: null,
            servesScheduleId: null,
            askedText: request.askedText,
          };
          const patch = this.patchFromJson(request.proposed as unknown as FieldValues);
          const result = await this.applyLocked(tx, schedule, patch, who, { widen: true, undoOf: null });
          const allowed = await tx.scheduleChangeRequest.update({
            where: { id: requestId },
            data: {
              state: 'ALLOWED',
              decidedAt: now,
              decidedByUserId: actor.ownerId,
              resultRevision: result.outcome === 'APPLIED' ? result.revision : null,
            },
          });
          return { outcome: 'ALLOWED' as const, request: allowed, schedule: result.schedule };
        })();
        if (request.scheduleId) {
          // The card a run asked for in Waiting on you is answered by this press: DONE when it was allowed or
          // declined, WITHDRAWN when the press found it stale and superseded it without applying anything.
          await closeScheduleItems(
            tx,
            { scheduleId: request.scheduleId, kinds: ['SCHEDULE_WIDEN'], scheduleChangeRequestId: requestId },
            decided.outcome === 'STALE'
              ? { state: 'WITHDRAWN', note: 'The scheduled task changed since this was asked; nothing was applied.', now }
              : { state: 'DONE', note: decided.outcome === 'ALLOWED' ? 'Allowed.' : 'Declined.', byUserId: actor.ownerId, now },
          );
        }
        return decided;
      },
      loggedRetry(this.logger, 'schedules.decide'),
    );
    if (answer.outcome === 'ALLOWED') await this.markConditionRunner(answer.schedule);
    await this.announceCards(actor.ownerId, answer.schedule?.id ?? answer.request.scheduleId, [answer.request.askedBySessionId]);
    return answer;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Direct controls (§8.4)
  // -------------------------------------------------------------------------------------------------------------

  /** ACTIVE → PAUSED: no next slot, and a QUEUED run is cancelled. A RUNNING run continues. */
  async pause(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    const paused = await withTransactionRetry(
      this.prisma,
      (tx) =>
        this.controlLocked(tx, actor, scheduleId, (s) => {
          if (s.state !== 'ACTIVE') throw refusal('CONFLICT', 'SCHEDULE_NOT_ACTIVE', `The schedule is ${s.state}.`);
          return { state: 'PAUSED', endedReason: null };
        }),
      loggedRetry(this.logger, 'schedules.pause'),
    );
    await this.markConditionRunner(paused);
    await this.announceCards(actor.ownerId, paused.id, [SchedulesService.sessionOf(actor)]);
    return paused;
  }

  /**
   * PAUSED or HELD → ACTIVE, at the next slot after now; slots missed meanwhile are not caught up. From HELD the
   * start checks (§6.1) run first, and a schedule that still fails one stays HELD (SCHEDULE_START_CHECK_FAILED).
   */
  async resume(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    const resumedSchedule = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const resumed = await this.controlLocked(tx, actor, scheduleId, (s) => {
          if (s.state !== 'PAUSED' && s.state !== 'HELD') {
            throw refusal('CONFLICT', 'SCHEDULE_NOT_PAUSED', `The schedule is ${s.state}.`);
          }
          return { state: 'ACTIVE', endedReason: null };
        }, false, async (s) => {
          if (s.state !== 'HELD') return;
          const check = await scheduleStartCheck(tx, s);
          if (!check.ok) {
            throw refusal(
              'CONFLICT',
              'SCHEDULE_START_CHECK_FAILED',
              `The schedule is still held: ${check.reason} (${heldClause(check.reason)}).`,
            );
          }
        });
        await closeScheduleItems(
          tx,
          { scheduleId: resumed.id, kinds: ['SCHEDULE_HELD'] },
          { state: 'WITHDRAWN', note: 'The scheduled task was resumed.', now: this.clock() },
        );
        if (resumed.heldReason === null) return resumed;
        return tx.schedule.update({ where: { id: resumed.id }, data: { heldReason: null } });
      },
      loggedRetry(this.logger, 'schedules.resume'),
    );
    await this.markConditionRunner(resumedSchedule);
    await this.announceCards(actor.ownerId, resumedSchedule.id, [SchedulesService.sessionOf(actor)]);
    return resumedSchedule;
  }

  /** ENDED (GOAL_REACHED): what a session, or the run itself, says when there is nothing left to watch. */
  async end(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    const { schedule, byRun } = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const ended = await this.controlLocked(
          tx, actor, scheduleId, () => ({ state: 'ENDED', endedReason: 'GOAL_REACHED' }), false, undefined, 'END',
        );
        const written = await tx.scheduleRevision.findUnique({
          where: { scheduleId_revision: { scheduleId, revision: ended.revision } },
          select: { changedBy: true },
        });
        return { schedule: ended, byRun: written?.changedBy === 'RUN' };
      },
      loggedRetry(this.logger, 'schedules.end'),
    );
    await this.markConditionRunner(schedule);
    await this.announceCards(actor.ownerId, schedule.id, [SchedulesService.sessionOf(actor)]);
    // §8.3: a run ending its own schedule is news, once (an ENDED schedule cannot be ended again); a person's own
    // end is not, they did it.
    if (byRun) {
      await this.alert([{
        kind: 'GOAL_REACHED',
        ownerId: schedule.ownerId,
        scheduleId: schedule.id,
        runId: null,
        opens: { scheduleId: schedule.id },
        ownerRequestId: null,
        ...goalReachedCopy(schedule.title),
        collapseId: `schedule-ended-${schedule.id}-${schedule.revision}`,
      }]);
    }
    return schedule;
  }

  /** ENDED (DELETED). Runs and findings are kept. */
  async remove(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    const removed = await withTransactionRetry(
      this.prisma,
      (tx) => this.controlLocked(tx, actor, scheduleId, () => ({ state: 'ENDED', endedReason: 'DELETED' }), true),
      loggedRetry(this.logger, 'schedules.remove'),
    );
    await this.markConditionRunner(removed);
    await this.announceCards(actor.ownerId, removed.id, [SchedulesService.sessionOf(actor)]);
    return removed;
  }

  /**
   * Rename (§8.4): the title alone, the one field a surface edits. A name is inside every envelope, so it applies at
   * once, as a revision with Undo; the text it already has writes nothing. Refused when ENDED. It holds nothing: a
   * session or a run may set the title again later.
   */
  async rename(actor: ScheduleActor, scheduleId: string, title: string): Promise<ScheduleUpdateResult> {
    checkText('title', title);
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await this.lockAccount(tx, actor.ownerId);
        const schedule = await this.lockSchedule(tx, actor.ownerId, scheduleId);
        const who: ResolvedActor = actor.kind === 'PAT'
          ? { changedBy: 'USER' as const, sessionId: null, session: null, servesScheduleId: null }
          : await this.resolveActor(tx, actor, scheduleId);
        assertRunSessionScope(who.servesScheduleId, scheduleId, 'UPDATE');
        return this.applyLocked(tx, schedule, { title: title.trim() }, who, { widen: false, undoOf: null });
      },
      loggedRetry(this.logger, 'schedules.rename'),
    );
    if (result.outcome === 'APPLIED') {
      await this.announceCards(actor.ownerId, scheduleId, [SchedulesService.sessionOf(actor)]);
    }
    return result;
  }

  /**
   * Undo one revision: put back what it changed, provided nothing has changed those fields since. The OWNER's Undo
   * restores the envelope too; a session's or a token's is judged by §4 like any other change.
   */
  async undo(actor: ScheduleActor, scheduleId: string, revision: number): Promise<ScheduleUpdateResult> {
    const alerts: ScheduleAlert[] = [];
    const result = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        alerts.length = 0;
        await this.lockAccount(tx, actor.ownerId);
        const schedule = await this.lockSchedule(tx, actor.ownerId, scheduleId, { allowEnded: true });
        const row = await tx.scheduleRevision.findUnique({
          where: { scheduleId_revision: { scheduleId, revision } },
        });
        if (!row) throw refusal('NOT_FOUND', 'SCHEDULE_REVISION_NOT_FOUND', `Revision ${revision} does not exist.`);
        if (revision === 1) {
          throw refusal('CONFLICT', 'SCHEDULE_UNDO_CREATION', 'The creation cannot be undone; delete the schedule instead.');
        }
        const undoneBy = await tx.scheduleRevision.findFirst({ where: { scheduleId, undoOfRevision: revision } });
        if (undoneBy) {
          throw refusal('CONFLICT', 'SCHEDULE_ALREADY_UNDONE', `Revision ${revision} was undone by revision ${undoneBy.revision}.`);
        }
        const fields = row.fields as unknown as { before: FieldValues; after: FieldValues };
        const current = this.fieldValues(schedule);
        for (const [key, value] of Object.entries(fields.after)) {
          if (!same(current[key], value)) {
            throw refusal('CONFLICT', 'SCHEDULE_UNDO_STALE', `"${key}" has changed since revision ${revision}; nothing was undone.`);
          }
        }
        const who: ResolvedActor = actor.kind === 'PAT'
          ? { changedBy: 'USER' as const, sessionId: null, session: null, servesScheduleId: null }
          : await this.resolveActor(tx, actor, scheduleId);
        assertRunSessionScope(who.servesScheduleId, scheduleId, 'CONTROL');
        const { state, endedReason, envelope, ...rest } = fields.before;
        const patch = this.patchFromJson(rest);
        if (state !== undefined) {
          const next = state as ScheduleState;
          if (schedule.state === 'ENDED' && next !== 'ENDED') await this.assertUnderLimit(tx, actor.ownerId);
          const result = await this.applyLocked(
            tx,
            schedule,
            { ...patch, state: next, endedReason: (endedReason ?? null) as ScheduleEndedReason | null },
            who,
            { widen: actor.kind === 'OWNER', undoOf: revision, restoreEnvelope: actor.kind === 'OWNER' ? (envelope as Envelope | undefined) : undefined },
          );
          return result;
        }
        if (actor.kind === 'OWNER') {
          return this.applyLocked(tx, schedule, patch, who, {
            widen: true,
            undoOf: revision,
            restoreEnvelope: envelope as Envelope | undefined,
          });
        }
        return this.changeLocked(tx, actor, who, schedule, patch, revision, alerts);
      },
      loggedRetry(this.logger, 'schedules.undo'),
    );
    await this.alert(alerts);
    if (result.outcome === 'APPLIED') await this.markConditionRunner(result.schedule);
    if (result.outcome !== 'UNCHANGED') {
      await this.announceCards(actor.ownerId, scheduleId, [SchedulesService.sessionOf(actor)]);
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inside the transaction
  // -------------------------------------------------------------------------------------------------------------

  private async controlLocked(
    tx: Tx,
    actor: ScheduleActor,
    scheduleId: string,
    transition: (s: Schedule) => { state: ScheduleState; endedReason: ScheduleEndedReason | null },
    allowEnded = false,
    precheck?: (s: Schedule) => Promise<void>,
    action: ScheduleRunSessionAction = 'CONTROL',
  ): Promise<Schedule> {
    await this.lockAccount(tx, actor.ownerId);
    const schedule = await this.lockSchedule(tx, actor.ownerId, scheduleId, { allowEnded });
    const who: ResolvedActor = actor.kind === 'PAT'
      ? { changedBy: 'USER' as const, sessionId: null, session: null, servesScheduleId: null }
      : await this.resolveActor(tx, actor, scheduleId);
    assertRunSessionScope(who.servesScheduleId, scheduleId, action);
    await precheck?.(schedule);
    const result = await this.applyLocked(tx, schedule, transition(schedule), who, { widen: false, undoOf: null });
    return result.schedule;
  }

  /** A change judged by §4: applied, or written as a PENDING request. */
  private async changeLocked(
    tx: Tx,
    actor: ScheduleActor,
    who: ResolvedActor,
    schedule: Schedule,
    patch: SchedulePatch,
    undoOf: number | null,
    alerts: ScheduleAlert[],
  ): Promise<ScheduleUpdateResult> {
    const settings = this.settingsAfter(schedule, patch);
    if (who.session && settings.accessLevel !== schedule.accessLevel) this.assertEnforceable(who.session.engine, settings.accessLevel);
    // §8.5: refused before any card, as an envelope card that carried it could not be allowed.
    if (settings.maxRuns !== schedule.maxRuns) await assertMaxRunsAhead(tx, schedule.id, settings.maxRuns);
    const judgment = judgeEnvelopeChange(envelopeOf(schedule), needOf(this.settingsOf(schedule)), needOf(settings), who.changedBy);
    if (actor.kind === 'OWNER' || judgment.inside) {
      return this.applyLocked(tx, schedule, patch, who, { widen: actor.kind === 'OWNER', undoOf });
    }
    // The ceiling is the asking person's conversation's. A run's own mode is its schedule's access level (§6.2), so
    // holding a run to it would leave §8.3's widen card unreachable for every CHECK_ONLY run; what it asks still
    // applies only on the owner's Allow.
    if (who.session && who.changedBy !== 'RUN' && judgment.widens.includes('ACCESS_LEVEL')) {
      this.assertWithinSessionMode(who.session, settings.accessLevel);
    }
    await tx.scheduleChangeRequest.updateMany({
      where: { scheduleId: schedule.id, state: 'PENDING', kind: 'UPDATE' },
      data: { state: 'SUPERSEDED' },
    });
    await closeScheduleItems(
      tx,
      { scheduleId: schedule.id, kinds: ['SCHEDULE_WIDEN'] },
      { state: 'WITHDRAWN', note: 'A newer request replaced it.', now: this.clock() },
    );
    const request = await tx.scheduleChangeRequest.create({
      data: {
        ownerId: schedule.ownerId,
        scheduleId: schedule.id,
        kind: 'UPDATE',
        askedBy: who.changedBy,
        askedBySessionId: who.sessionId,
        askedText: who.askedText ?? null,
        baseRevision: schedule.revision,
        proposed: this.patchJson(patch),
        envelopeBefore: envelopeOf(schedule) as unknown as Prisma.InputJsonValue,
        envelopeAsked: judgment.next as unknown as Prisma.InputJsonValue,
        widens: judgment.widens,
      },
    });
    if (who.changedBy === 'RUN' && who.sessionId) {
      // §8.3: a run asking to widen its envelope gets the card in Waiting on you; nobody is in its conversation.
      const run = await tx.session.findUnique({
        where: { id: who.sessionId },
        select: { scheduleRunId: true, scheduleRun: { select: { summary: true } } },
      });
      const before = envelopeOf(schedule);
      const copy = widenCopy({
        title: schedule.title,
        reason: run?.scheduleRun?.summary ?? null,
        widens: judgment.widens,
        now: before,
        asked: judgment.next,
        ruleNow: schedule.rule as unknown as ScheduleRule,
        ruleAsked: settings.rule,
        workspaceNames: Object.fromEntries(
          await workspaceNames(tx, schedule.ownerId, [before.workspaceId, judgment.next.workspaceId]),
        ),
      });
      const itemId = await fileScheduleItem(tx, {
        kind: 'SCHEDULE_WIDEN',
        ownerId: schedule.ownerId,
        askedBySessionId: who.sessionId,
        scheduleId: schedule.id,
        scheduleRunId: run?.scheduleRunId ?? null,
        scheduleChangeRequestId: request.id,
        workspaceId: schedule.workspaceId,
        key: `schedule-widen:${request.id}`,
        title: copy.title,
        why: copy.why,
      });
      if (itemId) {
        alerts.push({
          kind: 'WIDEN',
          ownerId: schedule.ownerId,
          scheduleId: schedule.id,
          runId: run?.scheduleRunId ?? null,
          opens: { sessionId: who.sessionId },
          ownerRequestId: itemId,
          title: copy.title,
          body: copy.body,
          collapseId: `owner-request-${itemId}`,
        });
      }
    }
    return { outcome: 'PENDING', request };
  }

  /**
   * Write a change and its revision. `widen` lets the envelope grow to what the change needs (an owner-channel
   * press); otherwise a change outside it is refused here, which `changeLocked` never lets happen.
   */
  private async applyLocked(
    tx: Tx,
    schedule: Schedule,
    patch: SchedulePatch & { state?: ScheduleState; endedReason?: ScheduleEndedReason | null },
    who: ResolvedActor,
    opts: { widen: boolean; undoOf: number | null; restoreEnvelope?: Envelope },
  ): Promise<ScheduleAppliedResult> {
    const now = this.clock();
    const settings = this.settingsAfter(schedule, patch);
    const judgment = judgeEnvelopeChange(envelopeOf(schedule), needOf(this.settingsOf(schedule)), needOf(settings), who.changedBy);
    if (!judgment.inside && !opts.widen) {
      throw refusal('CONFLICT', 'SCHEDULE_OUTSIDE_ENVELOPE', 'This change grows the envelope and needs the owner to allow it.');
    }
    const envelope = opts.restoreEnvelope ?? judgment.next;
    const state = patch.state ?? schedule.state;
    const endedReason = patch.state !== undefined ? (patch.endedReason ?? null) : schedule.endedReason;
    // A new name alone leaves the times as they are: a slot that is due and not yet taken is still taken.
    const nameOnly = Object.entries(patch).every(([key, value]) => key === 'title' || value === undefined);
    let due: Date | null = nameOnly ? schedule.nextDueAt : null;
    if (!nameOnly && state === 'ACTIVE' && settings.rule.kind !== 'WHEN') {
      due = nextDueAt(ruleOf(settings.rule), settings.timezone, now, { startAt: schedule.startAt, endAt: settings.endAt });
      if (!due) {
        throw refusal('BAD_REQUEST', 'SCHEDULE_NO_NEXT_SLOT', 'The rule has no slot left before the schedule\'s end.');
      }
    }

    const beforeValues = this.fieldValues(schedule);
    const afterSchedule = {
      ...settings,
      state,
      endedReason,
      envelope,
    };
    const afterValues: FieldValues = {
      ...this.fieldValuesOfSettings(settings),
      state,
      endedReason,
      envelope,
    };
    const before: FieldValues = {};
    const after: FieldValues = {};
    for (const key of Object.keys(afterValues)) {
      const changed = key === 'envelope'
        ? !sameEnvelope(beforeValues.envelope as Envelope, envelope)
        : !same(beforeValues[key], afterValues[key]);
      if (changed) {
        before[key] = stored(beforeValues[key]);
        after[key] = stored(afterValues[key]);
      }
    }
    // The read-back describes the schedule as it is now: a new one when the change brings one, none (so the read
    // derives it) when the rule or zone moved without one.
    const readBack = patch.readBack !== undefined
      ? patch.readBack?.trim() || null
      : 'rule' in after || 'timezone' in after ? null : schedule.readBack;
    if (readBack !== schedule.readBack) {
      before.readBack = schedule.readBack;
      after.readBack = readBack;
    }
    if (Object.keys(after).length === 0) return { outcome: 'UNCHANGED', schedule };
    // Again as it is written: an Allow or an Undo comes after runs that started since the ask.
    if ('maxRuns' in after) await assertMaxRunsAhead(tx, schedule.id, after.maxRuns);

    const revision = schedule.revision + 1;
    const updated = await tx.schedule.update({
      where: { id: schedule.id },
      data: {
        intent: afterSchedule.intent,
        title: afterSchedule.title,
        prompt: afterSchedule.prompt,
        rule: afterSchedule.rule as Prisma.InputJsonValue,
        timezone: afterSchedule.timezone,
        endAt: afterSchedule.endAt,
        maxRuns: afterSchedule.maxRuns,
        accessLevel: afterSchedule.accessLevel,
        runLimitMinutes: afterSchedule.runLimitMinutes,
        workspaceId: afterSchedule.workspaceId,
        ...envelopeColumns(envelope),
        state,
        endedReason,
        endedAt: state === 'ENDED' ? (schedule.state === 'ENDED' ? schedule.endedAt : now) : null,
        nextDueAt: due,
        revision,
        readBack,
      },
    });
    await tx.scheduleRevision.create({
      data: {
        scheduleId: schedule.id,
        revision,
        changedBy: who.changedBy,
        sessionId: who.sessionId,
        askedText: who.askedText ?? null,
        fields: { before, after } as Prisma.InputJsonValue,
        undoOfRevision: opts.undoOf,
      },
    });
    await this.syncCondition(tx, updated, now);
    if (state !== 'ACTIVE' && schedule.state === 'ACTIVE') {
      // §8.4: pausing, ending or deleting cancels the run waiting in the queue; a running one continues.
      await tx.scheduleRun.updateMany({
        where: { scheduleId: schedule.id, state: 'QUEUED' },
        data: { state: 'CANCELLED', endedAt: now },
      });
    }
    if (state === 'ENDED') {
      await tx.scheduleChangeRequest.updateMany({
        where: { scheduleId: schedule.id, state: 'PENDING' },
        data: { state: 'SUPERSEDED' },
      });
      // Nothing about an ended schedule waits on the owner any more.
      await closeScheduleItems(
        tx,
        { scheduleId: schedule.id, kinds: ['SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_WIDEN'] },
        { state: 'WITHDRAWN', note: 'The scheduled task ended.', now },
      );
    }
    return { outcome: 'APPLIED', schedule: updated, revision };
  }

  private async insertSchedule(
    tx: Tx,
    ownerId: string,
    input: NormalizedCreate & { timezone: string },
    createdFromSessionId: string | null,
    changedBy: ScheduleChangedBy,
    revisionSessionId: string | null,
  ): Promise<Schedule> {
    const now = this.clock();
    const startAt = input.startAt ?? now;
    const due = nextDueAt(input.rule, input.timezone, now, { startAt, endAt: input.endAt });
    if (!due && input.rule.kind !== 'WHEN') {
      throw refusal('BAD_REQUEST', 'SCHEDULE_NO_NEXT_SLOT', 'The rule has no slot left before the schedule\'s end.');
    }
    const envelope = needOf(input);
    let schedule = await tx.schedule.create({
      data: {
        ownerId,
        workspaceId: input.workspaceId,
        intent: input.intent,
        title: input.title,
        prompt: input.prompt,
        rule: input.rule as unknown as Prisma.InputJsonValue,
        timezone: input.timezone,
        startAt,
        endAt: input.endAt,
        maxRuns: input.maxRuns,
        accessLevel: input.accessLevel,
        runLimitMinutes: input.runLimitMinutes,
        ...envelopeColumns(envelope),
        state: 'ACTIVE',
        nextDueAt: due,
        createdFromSessionId,
        readBack: input.readBack,
      },
    });
    if (input.rule.kind === 'WHEN') {
      // The owner's Create approves this exact command (docs/condition-triggers-design.md §4.1): the condition, its
      // approved hash and the schedule's rule naming it are written in this one transaction.
      const c = input.rule.condition;
      const condition = await createConditionRow(tx, {
        ownerId,
        workspaceId: input.workspaceId,
        command: c.command,
        timeoutSeconds: c.timeoutSeconds,
        compare: c.compare,
        holdSeconds: c.holdSeconds,
        rearm: c.rearm,
        intervalSeconds: c.intervalSeconds,
        repeatSeconds: c.repeatSeconds ?? null,
        text: c.text,
        unit: c.unit,
        scheduleId: schedule.id,
        createdFromSessionId,
        approvedAt: now,
      });
      schedule = await tx.schedule.update({
        where: { id: schedule.id },
        data: { rule: { ...input.rule, conditionId: condition.id } as unknown as Prisma.InputJsonValue },
      });
    }
    await tx.scheduleRevision.create({
      data: {
        scheduleId: schedule.id,
        revision: 1,
        changedBy,
        sessionId: revisionSessionId,
        fields: {
          before: null,
          after: { ...this.fieldValues(schedule), envelope } as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });
    if (input.baseline) {
      // §8.1: the creating agent's own check, already told, so the first run does not announce it as news.
      await tx.scheduleFinding.create({
        data: {
          scheduleId: schedule.id,
          key: input.baseline.key,
          summary: input.baseline.summary ?? null,
          links: (input.baseline.links ?? []) as Prisma.InputJsonValue,
          notifiedAt: now,
        },
      });
    }
    return schedule;
  }

  /**
   * Keep a WHEN schedule's condition equal to its rule after a change (docs/condition-triggers-design.md §6.1): the
   * text, comparison, hold, re-arm, interval, repeat and unit as they are now (a repeat is inside the envelope: the
   * weekly budget already bounds how many runs it can start, so a shorter one applies at once); the command once it is
   * inside the envelope (on the owner's Create or Allow, or an Undo back to it), approved as of now; and its life: a
   * schedule paused or ended ends its condition, so the runner stops being sent the probe, and one resumed brings it
   * back, armed and waiting.
   */
  private async syncCondition(tx: Tx, schedule: Schedule, now: Date): Promise<void> {
    const rule = schedule.rule as unknown as ScheduleRule;
    if (rule.kind !== 'WHEN' || !rule.conditionId) return;
    await tx.$queryRaw`SELECT "id" FROM "condition" WHERE "id" = ${rule.conditionId}::uuid FOR UPDATE`;
    const condition = await tx.condition.findUnique({ where: { id: rule.conditionId } });
    if (!condition) return;
    const c = rule.condition;
    const hash = ruleCommandHash(rule)!;
    const data: Prisma.ConditionUpdateInput = {
      workspaceId: schedule.workspaceId,
      text: c.text,
      unit: c.unit,
      probeTimeoutSeconds: c.timeoutSeconds,
      compareOp: c.compare.op,
      compareValue: c.compare.value,
      holdSeconds: c.holdSeconds,
      rearmOp: c.rearm?.op ?? null,
      rearmValue: c.rearm?.value ?? null,
      intervalSeconds: c.intervalSeconds,
      repeatSeconds: c.repeatSeconds ?? null,
    };
    if (hash !== condition.approvedCommandHash) {
      data.probeCommand = c.command;
      data.approvedCommandHash = hash;
      data.approvedAt = now;
    }
    const live = conditionLive(schedule.state);
    if (!live && condition.state !== 'ENDED') {
      Object.assign(data, { state: 'ENDED', endedAt: now, trueSince: null, repeatFrom: null });
      await closeUnknownItems(tx, condition.id, now);
    } else if (live && condition.state === 'ENDED') {
      await assertConditionRoom(tx, schedule.ownerId);
      Object.assign(data, {
        state: 'WAITING', armed: true, trueSince: null, unknownSince: null, unknownReason: null, failedChecks: 0,
        endedAt: null, resumedAt: now, repeatFrom: null,
      });
    }
    await tx.condition.update({ where: { id: condition.id }, data });
  }

  private async lockAccount(tx: Tx, ownerId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCHEDULE_LOCK_NAMESPACE}::int, hashtext(${ownerId}))`;
  }

  private async lockSchedule(
    tx: Tx,
    ownerId: string,
    scheduleId: string,
    opts: { allowEnded?: boolean } = {},
  ): Promise<Schedule> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "schedule" WHERE "id" = ${scheduleId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw refusal('NOT_FOUND', 'SCHEDULE_NOT_FOUND', 'No such schedule.');
    const schedule = await tx.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    if (schedule.state === 'ENDED' && !opts.allowEnded) {
      throw refusal('CONFLICT', 'SCHEDULE_ENDED', 'The schedule has ended.');
    }
    return schedule;
  }

  /** Another workspace a change names must be one of the owner's live ones: anything else names nothing. */
  private async assertOwnWorkspace(tx: Tx, ownerId: string, workspaceId: string): Promise<void> {
    if (!(await this.ownsWorkspace(tx, ownerId, workspaceId))) {
      throw refusal('NOT_FOUND', 'WORKSPACE_NOT_FOUND', 'No such workspace.');
    }
  }

  private async ownsWorkspace(tx: Tx, ownerId: string, workspaceId: unknown): Promise<boolean> {
    if (typeof workspaceId !== 'string') return false;
    return (await tx.workspace.count({ where: { id: workspaceId, ownerId, deletedAt: null } })) > 0;
  }

  private async assertUnderLimit(tx: Tx, ownerId: string): Promise<void> {
    const live = await tx.schedule.count({ where: { ownerId, state: { not: 'ENDED' } } });
    if (live >= SCHEDULE_LIMIT) {
      throw refusal(
        'CONFLICT',
        'SCHEDULE_LIMIT',
        `An account has at most ${SCHEDULE_LIMIT} scheduled tasks that have not ended. End or delete one first.`,
      );
    }
  }

  /** Who is asking. A session serving a run of `scheduleId` is that schedule's RUN. */
  private async resolveActor(tx: Tx, actor: ScheduleActor, scheduleId: string | null): Promise<ResolvedActor> {
    if (actor.kind !== 'SESSION') return { changedBy: 'USER', sessionId: null, session: null, servesScheduleId: null };
    const session = await tx.session.findFirst({
      where: { id: actor.sessionId, ownerId: actor.ownerId },
      select: {
        id: true,
        permissionMode: true,
        engine: true,
        workspaceId: true,
        scheduleRun: { select: { scheduleId: true } },
        changeScheduleId: true,
        owner: { select: { preferences: true } },
      },
    });
    if (!session) throw refusal('NOT_FOUND', 'SESSION_NOT_FOUND', 'The calling session does not exist.');
    const isRun = scheduleId !== null && session.scheduleRun?.scheduleId === scheduleId;
    // The schedule's own change conversation speaks for the person (§8.2): what it changes is theirs, in their words.
    // It is still judged as a session (§4): what grows the envelope waits for the owner's Allow.
    const isChange = scheduleId !== null && session.changeScheduleId === scheduleId;
    return {
      changedBy: isRun ? 'RUN' : isChange ? 'USER' : 'SESSION',
      ...(isChange ? { askedText: await personsLatestWords(tx, session.id) } : {}),
      sessionId: session.id,
      servesScheduleId: session.scheduleRun?.scheduleId ?? null,
      session: {
        mode: resolvePermissionMode(session.permissionMode, session.owner),
        engine: session.engine,
        workspaceId: session.workspaceId,
      },
    };
  }

  /** §6.2: a level the engine cannot enforce with a mode that is not wider is refused at the door. */
  private assertEnforceable(engine: string | null, level: AccessLevel): void {
    if (scheduleRunMode(level, engine)) return;
    throw refusal(
      'BAD_REQUEST',
      SCHEDULE_ACCESS_NOT_ENFORCEABLE,
      `${level} cannot be enforced on the ${engine ?? 'default'} engine: it has no permission mode that is not wider. `
        + 'Create the schedule from a session on an engine that can, such as Claude Code.',
    );
  }

  private assertWithinSessionMode(session: { mode: string; engine: string | null }, level: AccessLevel): void {
    const mode = ACCESS_LEVEL_MODE[level];
    if (isWiderThanStarter({ mode: session.mode, engine: session.engine }, mode, session.engine)) {
      throw widerModeRefusal(session.mode, mode, session.engine, SESSION_MAY_NOT_WIDEN);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------------------------------------------

  private normalizeCreate(input: ScheduleCreateInput, workspaceId: string, cardTakesZone: boolean): NormalizedCreate {
    checkText('intent', input.intent);
    checkText('title', input.title);
    checkText('prompt', input.prompt);
    checkAccessLevel(input.accessLevel);
    const timezone = input.timezone ?? null;
    if (timezone !== null) checkTimezone(timezone);
    else if (!cardTakesZone) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_TIMEZONE_REQUIRED', 'A schedule needs an IANA time zone.');
    }
    if (input.readBack != null) checkReadBack(input.readBack);
    if (input.findings != null && (typeof input.findings !== 'string' || input.findings.length > 60)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_FIELD_INVALID', 'findings is a plural noun of at most 60 characters.');
    }
    if (input.runLimitMinutes != null) checkRunLimit(input.runLimitMinutes);
    if (input.maxRuns != null) checkMaxRuns(input.maxRuns);
    if (input.baseline) checkText('baseline key', input.baseline.key);
    const rule = ruleOf(input.rule);
    const runLimitMinutes = input.runLimitMinutes ?? defaultRunLimit(rule);
    checkRunLimitFitsRule(rule, runLimitMinutes);
    if (rule.kind === 'WHEN') {
      // docs/condition-triggers-design.md §4.1, §8: the agent ran the probe once; that reading is the card's Today.
      if (!input.baseline) {
        throw refusal(
          'BAD_REQUEST',
          'SCHEDULE_BASELINE_REQUIRED',
          'A WHEN rule needs a baseline: run the probe command once and pass what it read as { key, summary }.',
        );
      }
      rule.conditionId = null;
    }
    return {
      workspaceId,
      intent: input.intent,
      title: input.title,
      prompt: input.prompt,
      rule,
      timezone,
      accessLevel: input.accessLevel,
      runLimitMinutes,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      maxRuns: input.maxRuns ?? null,
      baseline: input.baseline ?? null,
      readBack: input.readBack?.trim() || null,
      findings: input.findings?.trim() || null,
    };
  }

  /** `suggestedEnd` marks the server's 7-day end (§8.5), which Create turns into an endAt unless No end was pressed. */
  private createProposal(n: NormalizedCreate, suggestedEnd: boolean): Prisma.InputJsonValue {
    return {
      ...n,
      startAt: n.startAt ? n.startAt.toISOString() : null,
      endAt: n.endAt ? n.endAt.toISOString() : null,
      ...(suggestedEnd ? { suggestedEnd: true } : {}),
    } as unknown as Prisma.InputJsonValue;
  }

  private createFromProposal(p: FieldValues): NormalizedCreate {
    const { suggestedEnd: _suggested, ...proposed } = p;
    return {
      ...(proposed as unknown as NormalizedCreate),
      maxRuns: (p.maxRuns as number | null | undefined) ?? null,
      timezone: (p.timezone as string | null | undefined) ?? null,
      readBack: (p.readBack as string | null | undefined) ?? null,
      findings: (p.findings as string | null | undefined) ?? null,
      startAt: p.startAt ? new Date(p.startAt as string) : null,
      endAt: p.endAt ? new Date(p.endAt as string) : null,
    };
  }

  private settingsOf(s: Schedule): Settings {
    return {
      intent: s.intent,
      title: s.title,
      prompt: s.prompt,
      rule: s.rule as unknown as ScheduleRule,
      timezone: s.timezone,
      endAt: s.endAt,
      maxRuns: s.maxRuns,
      accessLevel: s.accessLevel,
      runLimitMinutes: s.runLimitMinutes,
      workspaceId: s.workspaceId,
    };
  }

  /** The settings once `patch` applies, each field validated. */
  private settingsAfter(s: Schedule, patch: SchedulePatch): Settings {
    const next = this.settingsOf(s);
    if (patch.intent !== undefined) (checkText('intent', patch.intent), (next.intent = patch.intent));
    if (patch.title !== undefined) (checkText('title', patch.title), (next.title = patch.title));
    if (patch.prompt !== undefined) (checkText('prompt', patch.prompt), (next.prompt = patch.prompt));
    if (patch.rule !== undefined) next.rule = ruleAfter(next.rule, patch.rule);
    if (patch.timezone !== undefined) (checkTimezone(patch.timezone), (next.timezone = patch.timezone));
    if (patch.endAt !== undefined) next.endAt = patch.endAt;
    if (patch.maxRuns !== undefined) (checkMaxRuns(patch.maxRuns), (next.maxRuns = patch.maxRuns));
    if (patch.accessLevel !== undefined) (checkAccessLevel(patch.accessLevel), (next.accessLevel = patch.accessLevel));
    if (patch.runLimitMinutes !== undefined) (checkRunLimit(patch.runLimitMinutes), (next.runLimitMinutes = patch.runLimitMinutes));
    if (patch.workspaceId !== undefined) {
      checkText('workspace', patch.workspaceId);
      next.workspaceId = patch.workspaceId;
    }
    if (patch.rule !== undefined || patch.runLimitMinutes !== undefined) checkRunLimitFitsRule(next.rule, next.runLimitMinutes);
    return next;
  }

  private fieldValuesOfSettings(s: Settings): FieldValues {
    return {
      intent: s.intent,
      title: s.title,
      prompt: s.prompt,
      rule: s.rule,
      timezone: s.timezone,
      endAt: stored(s.endAt),
      maxRuns: s.maxRuns,
      accessLevel: s.accessLevel,
      runLimitMinutes: s.runLimitMinutes,
      workspaceId: s.workspaceId,
    };
  }

  private fieldValues(s: Schedule): FieldValues {
    return {
      ...this.fieldValuesOfSettings(this.settingsOf(s)),
      readBack: s.readBack,
      state: s.state,
      endedReason: s.endedReason,
      envelope: envelopeOf(s),
    };
  }

  private patchJson(patch: SchedulePatch): Prisma.InputJsonValue {
    const out: FieldValues = {};
    for (const key of PATCH_FIELDS) if (patch[key] !== undefined) out[key] = stored(patch[key]);
    return out as Prisma.InputJsonValue;
  }

  private patchFromJson(json: FieldValues): SchedulePatch {
    const patch: SchedulePatch = {};
    for (const key of PATCH_FIELDS) {
      if (!(key in json)) continue;
      const value = json[key];
      (patch as FieldValues)[key] = key === 'endAt' ? (value ? new Date(value as string) : null) : value;
    }
    return patch;
  }
}

interface Settings {
  intent: string;
  title: string;
  prompt: string;
  rule: ScheduleRule;
  timezone: string;
  endAt: Date | null;
  maxRuns: number | null;
  accessLevel: AccessLevel;
  runLimitMinutes: number;
  workspaceId: string;
}

interface NormalizedCreate extends Omit<Settings, 'timezone'> {
  /** Null on a session's create card that left the zone to the pressing device. */
  timezone: string | null;
  startAt: Date | null;
  baseline: ScheduleBaseline | null;
  readBack: string | null;
  findings: string | null;
}
