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
import { ScheduleRuleError, assertTimezone, nextDueAt, parseRule, runsPerWeek, type ScheduleRule } from './schedule-time';
import { SCHEDULE_ACCESS_NOT_ENFORCEABLE, scheduleRunMode } from './schedule-access';
import { scheduleStartCheck } from './schedule-start-check';

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
  baseline?: ScheduleBaseline;
  /** The OWNER names it; a session's create always uses the session's own workspace. */
  workspaceId?: string;
  /**
   * The card's read-back: one sentence in the agent's words saying what it will do ("Every day at 10:00 Beijing
   * time I check …"). Kept on the CREATE request, which is where the card and the inspector read it from.
   */
  readBack?: string | null;
}

/** What the owner's press on a card may carry. */
export interface ScheduleDecisionInput {
  /** The pressing device's IANA zone, taken only when the CREATE proposal names none (§5.1). */
  timezone?: string | null;
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
  intent?: string;
  title?: string;
  prompt?: string;
  rule?: unknown;
  timezone?: string;
  endAt?: Date | null;
  accessLevel?: AccessLevel;
  runLimitMinutes?: number;
  workspaceId?: string;
}

export type ScheduleCreateResult =
  | { outcome: 'CREATED'; schedule: Schedule }
  | { outcome: 'PENDING'; request: ScheduleChangeRequest };

export type ScheduleAppliedResult =
  | { outcome: 'APPLIED'; schedule: Schedule; revision: number }
  | { outcome: 'UNCHANGED'; schedule: Schedule };

export type ScheduleUpdateResult = ScheduleAppliedResult | { outcome: 'PENDING'; request: ScheduleChangeRequest };

type Tx = Prisma.TransactionClient;

/** The fields a revision records, as stored JSON. */
type FieldValues = Record<string, unknown>;

const PATCH_FIELDS = [
  'intent', 'title', 'prompt', 'rule', 'timezone', 'endAt', 'accessLevel', 'runLimitMinutes', 'workspaceId',
] as const;

interface ResolvedActor {
  changedBy: ScheduleChangedBy;
  sessionId: string | null;
  /** The session's mode and engine, for the permission-mode ceiling. */
  session: { mode: string; engine: string | null; workspaceId: string | null } | null;
  /** The schedule the calling session serves a run of (`session.scheduleRunId`), or null. */
  servesScheduleId: string | null;
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

function checkAccessLevel(level: unknown): asserts level is AccessLevel {
  if (level !== 'CHECK_ONLY' && level !== 'OPEN_PR') {
    throw refusal('BAD_REQUEST', 'SCHEDULE_ACCESS_LEVEL_INVALID', 'An access level is CHECK_ONLY or OPEN_PR.');
  }
}

function checkText(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw refusal('BAD_REQUEST', 'SCHEDULE_FIELD_INVALID', `A schedule's ${name} is a non-empty string.`);
  }
}

/** What a schedule's settings need of the envelope. */
function needOf(s: { workspaceId: string; accessLevel: AccessLevel; rule: unknown; runLimitMinutes: number }): Envelope {
  return {
    workspaceId: s.workspaceId,
    accessLevel: s.accessLevel,
    runsPerWeek: runsPerWeek(ruleOf(s.rule)),
    runLimitMinutes: s.runLimitMinutes,
  };
}

function envelopeOf(s: Schedule): Envelope {
  return {
    workspaceId: s.envelopeWorkspaceId,
    accessLevel: s.envelopeAccessLevel,
    runsPerWeek: s.envelopeRunsPerWeek,
    runLimitMinutes: s.envelopeRunLimitMinutes,
  };
}

function envelopeColumns(e: Envelope) {
  return {
    envelopeWorkspaceId: e.workspaceId,
    envelopeAccessLevel: e.accessLevel,
    envelopeRunsPerWeek: e.runsPerWeek,
    envelopeRunLimitMinutes: e.runLimitMinutes,
  };
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
  ) {
    this.clock = clock ?? (() => new Date());
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
    return withTransactionRetry(
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
        await this.assertUnderLimit(tx, actor.ownerId);
        if (actor.kind === 'SESSION') {
          const request = await tx.scheduleChangeRequest.create({
            data: {
              ownerId: actor.ownerId,
              kind: 'CREATE',
              askedBy: who.changedBy,
              askedBySessionId: who.sessionId,
              proposed: this.createProposal(normalized),
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
  }

  // -------------------------------------------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------------------------------------------

  /** §4: inside the envelope it applies at once; outside it waits on a request only the OWNER's Allow applies. */
  async update(actor: ScheduleActor, scheduleId: string, patch: SchedulePatch): Promise<ScheduleUpdateResult> {
    if (actor.kind === 'PAT') throw patRefusal();
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
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
        return this.changeLocked(tx, actor, who, schedule, patch, null);
      },
      loggedRetry(this.logger, 'schedules.update'),
    );
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
    return withTransactionRetry(
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
            data: { state: 'ALLOWED', decidedAt: now, decidedByUserId: actor.ownerId, scheduleId: schedule.id, resultRevision: 1 },
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
      },
      loggedRetry(this.logger, 'schedules.decide'),
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Direct controls (§8.4)
  // -------------------------------------------------------------------------------------------------------------

  /** ACTIVE → PAUSED: no next slot, and a QUEUED run is cancelled. A RUNNING run continues. */
  async pause(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    return withTransactionRetry(
      this.prisma,
      (tx) =>
        this.controlLocked(tx, actor, scheduleId, (s) => {
          if (s.state !== 'ACTIVE') throw refusal('CONFLICT', 'SCHEDULE_NOT_ACTIVE', `The schedule is ${s.state}.`);
          return { state: 'PAUSED', endedReason: null };
        }),
      loggedRetry(this.logger, 'schedules.pause'),
    );
  }

  /**
   * PAUSED or HELD → ACTIVE, at the next slot after now; slots missed meanwhile are not caught up. From HELD the
   * start checks (§6.1) run first, and a schedule that still fails one stays HELD (SCHEDULE_START_CHECK_FAILED).
   */
  async resume(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    return withTransactionRetry(
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
            throw refusal('CONFLICT', 'SCHEDULE_START_CHECK_FAILED', `The schedule is still held: ${check.reason}.`);
          }
        });
        if (resumed.heldReason === null) return resumed;
        return tx.schedule.update({ where: { id: resumed.id }, data: { heldReason: null } });
      },
      loggedRetry(this.logger, 'schedules.resume'),
    );
  }

  /** ENDED (GOAL_REACHED): what a session, or the run itself, says when there is nothing left to watch. */
  async end(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    return withTransactionRetry(
      this.prisma,
      (tx) =>
        this.controlLocked(tx, actor, scheduleId, () => ({ state: 'ENDED', endedReason: 'GOAL_REACHED' }), false, undefined, 'END'),
      loggedRetry(this.logger, 'schedules.end'),
    );
  }

  /** ENDED (DELETED). Runs and findings are kept. */
  async remove(actor: ScheduleActor, scheduleId: string): Promise<Schedule> {
    return withTransactionRetry(
      this.prisma,
      (tx) => this.controlLocked(tx, actor, scheduleId, () => ({ state: 'ENDED', endedReason: 'DELETED' }), true),
      loggedRetry(this.logger, 'schedules.remove'),
    );
  }

  /**
   * Undo one revision: put back what it changed, provided nothing has changed those fields since. The OWNER's Undo
   * restores the envelope too; a session's or a token's is judged by §4 like any other change.
   */
  async undo(actor: ScheduleActor, scheduleId: string, revision: number): Promise<ScheduleUpdateResult> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
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
        return this.changeLocked(tx, actor, who, schedule, patch, revision);
      },
      loggedRetry(this.logger, 'schedules.undo'),
    );
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
  ): Promise<ScheduleUpdateResult> {
    const settings = this.settingsAfter(schedule, patch);
    if (who.session && settings.accessLevel !== schedule.accessLevel) this.assertEnforceable(who.session.engine, settings.accessLevel);
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
    const request = await tx.scheduleChangeRequest.create({
      data: {
        ownerId: schedule.ownerId,
        scheduleId: schedule.id,
        kind: 'UPDATE',
        askedBy: who.changedBy,
        askedBySessionId: who.sessionId,
        baseRevision: schedule.revision,
        proposed: this.patchJson(patch),
        envelopeBefore: envelopeOf(schedule) as unknown as Prisma.InputJsonValue,
        envelopeAsked: judgment.next as unknown as Prisma.InputJsonValue,
        widens: judgment.widens,
      },
    });
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
    let due: Date | null = null;
    if (state === 'ACTIVE') {
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
    if (Object.keys(after).length === 0) return { outcome: 'UNCHANGED', schedule };

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
        accessLevel: afterSchedule.accessLevel,
        runLimitMinutes: afterSchedule.runLimitMinutes,
        workspaceId: afterSchedule.workspaceId,
        ...envelopeColumns(envelope),
        state,
        endedReason,
        endedAt: state === 'ENDED' ? (schedule.state === 'ENDED' ? schedule.endedAt : now) : null,
        nextDueAt: due,
        revision,
      },
    });
    await tx.scheduleRevision.create({
      data: {
        scheduleId: schedule.id,
        revision,
        changedBy: who.changedBy,
        sessionId: who.sessionId,
        fields: { before, after } as Prisma.InputJsonValue,
        undoOfRevision: opts.undoOf,
      },
    });
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
    if (!due) throw refusal('BAD_REQUEST', 'SCHEDULE_NO_NEXT_SLOT', 'The rule has no slot left before the schedule\'s end.');
    const envelope = needOf(input);
    const schedule = await tx.schedule.create({
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
        accessLevel: input.accessLevel,
        runLimitMinutes: input.runLimitMinutes,
        ...envelopeColumns(envelope),
        state: 'ACTIVE',
        nextDueAt: due,
        createdFromSessionId,
      },
    });
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
        owner: { select: { preferences: true } },
      },
    });
    if (!session) throw refusal('NOT_FOUND', 'SESSION_NOT_FOUND', 'The calling session does not exist.');
    const isRun = scheduleId !== null && session.scheduleRun?.scheduleId === scheduleId;
    return {
      changedBy: isRun ? 'RUN' : 'SESSION',
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
    if (input.readBack != null && (typeof input.readBack !== 'string' || input.readBack.length > 500)) {
      throw refusal('BAD_REQUEST', 'SCHEDULE_FIELD_INVALID', 'A read-back is one sentence of at most 500 characters.');
    }
    const runLimitMinutes = input.runLimitMinutes ?? DEFAULT_RUN_LIMIT_MINUTES;
    checkRunLimit(runLimitMinutes);
    if (input.baseline) checkText('baseline key', input.baseline.key);
    return {
      workspaceId,
      intent: input.intent,
      title: input.title,
      prompt: input.prompt,
      rule: ruleOf(input.rule),
      timezone,
      accessLevel: input.accessLevel,
      runLimitMinutes,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      baseline: input.baseline ?? null,
      readBack: input.readBack?.trim() || null,
    };
  }

  private createProposal(n: NormalizedCreate): Prisma.InputJsonValue {
    return {
      ...n,
      startAt: n.startAt ? n.startAt.toISOString() : null,
      endAt: n.endAt ? n.endAt.toISOString() : null,
    } as unknown as Prisma.InputJsonValue;
  }

  private createFromProposal(p: FieldValues): NormalizedCreate {
    return {
      ...(p as unknown as NormalizedCreate),
      timezone: (p.timezone as string | null | undefined) ?? null,
      readBack: (p.readBack as string | null | undefined) ?? null,
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
    if (patch.rule !== undefined) next.rule = ruleOf(patch.rule);
    if (patch.timezone !== undefined) (checkTimezone(patch.timezone), (next.timezone = patch.timezone));
    if (patch.endAt !== undefined) next.endAt = patch.endAt;
    if (patch.accessLevel !== undefined) (checkAccessLevel(patch.accessLevel), (next.accessLevel = patch.accessLevel));
    if (patch.runLimitMinutes !== undefined) (checkRunLimit(patch.runLimitMinutes), (next.runLimitMinutes = patch.runLimitMinutes));
    if (patch.workspaceId !== undefined) {
      checkText('workspace', patch.workspaceId);
      next.workspaceId = patch.workspaceId;
    }
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
      accessLevel: s.accessLevel,
      runLimitMinutes: s.runLimitMinutes,
      workspaceId: s.workspaceId,
    };
  }

  private fieldValues(s: Schedule): FieldValues {
    return {
      ...this.fieldValuesOfSettings(this.settingsOf(s)),
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
}
