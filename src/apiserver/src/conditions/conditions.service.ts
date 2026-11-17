/**
 * Conditions on the server (docs/condition-triggers-design.md §3, §4.2, §5): what a runner is handed to probe, the
 * samples it reports, the state they move, the clock's silence, and the read. The server runs no command.
 *
 * A condition is created only by what it is attached to, a task's startWhen or a schedule's WHEN rule (C3, C4), through
 * createCondition; there is no route that creates one. Firing writes the FIRED event and the state, and calls every
 * registered fire hook in the same transaction: that is where C3 inserts a schedule run and C4 makes a task due.
 */
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  CONDITION_SAMPLE_OUTCOMES,
  type ConditionCompareOp,
  type ConditionProbe,
  type ConditionSampleOutcome,
  type ConditionUnknownReason,
  type ConditionView,
} from '@orbit/shared';
import type { Condition, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { withTransactionRetry } from '../common/transaction-retry';
import { stringEnv } from '../sessions/session-settings';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONDITION_NOTIFIER,
  closeUnknownItems,
  fileUnknownItem,
  unknownCopy,
  unknownIsNotified,
  unknownItemKey,
  type ConditionAlert,
  type ConditionNotifier,
} from './condition-attention';
import {
  evaluateSample,
  evaluateSilence,
  silentSince,
  type ConditionEventDraft,
  type ConditionMachine,
  type ConditionRules,
  type ConditionSampleInput,
  type ConditionStep,
} from './condition-evaluation';

/** At most this many conditions that are not ENDED per account (§3). */
export const CONDITION_LIMIT_PER_ACCOUNT = 20;
/** Samples are kept this long, and at most this many per condition (§3). */
export const CONDITION_SAMPLE_KEEP_DAYS = 30;
export const CONDITION_SAMPLES_KEPT = 1000;
/** A heartbeat carries at most this many samples; the rest are dropped unread. */
export const CONDITION_SAMPLES_PER_BEAT = 500;
const STDERR_TAIL_MAX = 2000;
/** What the read returns. */
const VIEW_SAMPLES = 50;
const VIEW_EVENTS = 50;

export function conditionCommandHash(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

/** What firing hands a hook, inside the transaction that fired. */
export interface ConditionFiring {
  condition: Condition;
  /** The FIRED event's id and the firing sample's time. */
  eventId: string;
  at: Date;
  value: number | null;
}

/** Where C3 and C4 start the work a firing asks for. Throwing rolls the firing back. */
export interface ConditionFireHook {
  onFired(tx: Prisma.TransactionClient, firing: ConditionFiring): Promise<void>;
}

export interface ConditionCreateInput {
  ownerId: string;
  workspaceId: string;
  command: string;
  timeoutSeconds?: number;
  compare: { op: ConditionCompareOp; value?: number | null };
  holdSeconds?: number;
  rearm?: { op: ConditionCompareOp; value?: number | null } | null;
  intervalSeconds?: number;
  text: string;
  unit?: string | null;
  taskId?: string | null;
  scheduleId?: string | null;
  createdFromSessionId?: string | null;
  /** When the owner pressed Create or Allow on this exact command. */
  approvedAt: Date;
}

export const CONDITION_LIMIT_REACHED = 'CONDITION_LIMIT_REACHED';
export const CONDITION_NOT_FOUND = 'CONDITION_NOT_FOUND';

/** What became of a heartbeat's samples. */
export interface ConditionIntake {
  stored: number;
  /** Samples that named a condition whose workspace this runner does not serve, or no condition at all. */
  refused: number;
  /** Samples that were not well formed. */
  malformed: number;
}

interface CleanSample extends ConditionSampleInput {
  conditionId: string;
  stderrTail: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanSample(raw: unknown): CleanSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.conditionId !== 'string' || !UUID_RE.test(s.conditionId)) return null;
  if (typeof s.at !== 'string') return null;
  const at = new Date(s.at);
  if (!Number.isFinite(at.getTime())) return null;
  if (typeof s.outcome !== 'string' || !(CONDITION_SAMPLE_OUTCOMES as readonly string[]).includes(s.outcome)) return null;
  const value = typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : null;
  const exitCode = typeof s.exitCode === 'number' && Number.isInteger(s.exitCode) ? s.exitCode : null;
  const stderrTail = typeof s.stderrTail === 'string' && s.stderrTail
    ? s.stderrTail.replace(/\u0000/g, '').slice(-STDERR_TAIL_MAX)
    : null;
  return { conditionId: s.conditionId.toLowerCase(), at, outcome: s.outcome as ConditionSampleOutcome, value, exitCode, stderrTail };
}

function rulesOf(c: Condition): ConditionRules {
  return {
    compareOp: c.compareOp,
    compareValue: c.compareValue,
    holdSeconds: c.holdSeconds,
    rearmOp: c.rearmOp,
    rearmValue: c.rearmValue,
    intervalSeconds: c.intervalSeconds,
    scheduleId: c.scheduleId,
  };
}

function machineOf(c: Condition): ConditionMachine {
  return {
    state: c.state,
    armed: c.armed,
    lastSampleAt: c.lastSampleAt,
    lastValue: c.lastValue,
    lastOutcome: c.lastOutcome,
    lastReadAt: c.lastReadAt,
    trueSince: c.trueSince,
    unknownSince: c.unknownSince,
    unknownReason: c.unknownReason as ConditionUnknownReason | null,
    failedChecks: c.failedChecks,
    firedAt: c.firedAt,
  };
}

function iso(at: Date | null): string | null {
  return at ? at.toISOString() : null;
}

@Injectable()
export class ConditionsService {
  private readonly log = new Logger('ConditionsService');
  private readonly hooks: ConditionFireHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CONDITION_NOTIFIER) private readonly notifier?: ConditionNotifier,
    @Optional() @Inject('CONDITION_CLOCK') private readonly clock: () => Date = () => new Date(),
  ) {}

  /** C3 and C4 register here. In C1 nothing does: a firing writes its event and state and starts nothing. */
  registerFireHook(hook: ConditionFireHook): void {
    this.hooks.push(hook);
  }

  /**
   * A condition for a task or a schedule, inside the caller's transaction. Refused past 20 not ENDED in the
   * account, counted under the owner's advisory lock so two creates cannot both take the twentieth place.
   */
  async createCondition(tx: Prisma.TransactionClient, input: ConditionCreateInput): Promise<Condition> {
    const command = input.command.trim();
    if (!command) throw new BadRequestException('a condition needs a probe command');
    if (!input.text.trim()) throw new BadRequestException('a condition needs its text: the condition in words');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`condition-limit:${input.ownerId}`}, 0))`;
    const live = await tx.condition.count({ where: { ownerId: input.ownerId, state: { not: 'ENDED' } } });
    if (live >= CONDITION_LIMIT_PER_ACCOUNT) {
      throw new ConflictException({
        code: CONDITION_LIMIT_REACHED,
        message: `this account already has ${CONDITION_LIMIT_PER_ACCOUNT} conditions that have not ended; end one first`,
      });
    }
    return tx.condition.create({
      data: {
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        probeCommand: command,
        probeTimeoutSeconds: input.timeoutSeconds ?? 20,
        compareOp: input.compare.op,
        compareValue: input.compare.op === 'EXIT_ZERO' ? null : input.compare.value ?? null,
        holdSeconds: input.holdSeconds ?? 0,
        rearmOp: input.rearm?.op ?? null,
        rearmValue: input.rearm && input.rearm.op !== 'EXIT_ZERO' ? input.rearm.value ?? null : null,
        intervalSeconds: input.intervalSeconds ?? 300,
        text: input.text.trim(),
        unit: input.unit ?? null,
        approvedCommandHash: conditionCommandHash(command),
        approvedAt: input.approvedAt,
        taskId: input.taskId ?? null,
        scheduleId: input.scheduleId ?? null,
        createdFromSessionId: input.createdFromSessionId ?? null,
      },
    });
  }

  /**
   * What HeartbeatResponse.conditionProbes lists: the live conditions of this runner's live workspaces that have a
   * directory, each with that directory and the workspace's environment (runner-go ConditionProbe).
   */
  async probesFor(runnerId: string): Promise<ConditionProbe[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; probe_command: string; approved_command_hash: string; probe_timeout_seconds: number; interval_seconds: number;
      work_dir: string; env: unknown;
    }>>`
      SELECT c."id", c."probe_command", c."approved_command_hash", c."probe_timeout_seconds", c."interval_seconds",
             w."work_dir", w."env"
        FROM "condition" c
        JOIN "workspace" w ON w."id" = c."workspace_id" AND w."owner_id" = c."owner_id"
       WHERE w."runner_id" = ${runnerId}::uuid AND w."deleted_at" IS NULL AND w."work_dir" IS NOT NULL
         AND c."state" <> 'ENDED'
       ORDER BY c."id"
       LIMIT 200
    `;
    return rows.map((r) => ({
      id: r.id,
      command: r.probe_command,
      commandHash: r.approved_command_hash,
      timeoutSeconds: r.probe_timeout_seconds,
      intervalSeconds: r.interval_seconds,
      workDir: r.work_dir,
      // The workspace's own variables, as a session of it is started with them (sessions/session-settings.ts).
      env: stringEnv(r.env),
    }));
  }

  /**
   * HeartbeatRequest.conditionSamples. A sample is taken only for a live condition of the runner's owner whose
   * workspace this runner serves; any other is refused and stored nowhere. Each condition's samples are stored and
   * evaluated under its row lock, oldest first.
   */
  async intake(runner: { id: string; ownerId: string }, raw: unknown): Promise<ConditionIntake> {
    const result: ConditionIntake = { stored: 0, refused: 0, malformed: 0 };
    if (!Array.isArray(raw) || raw.length === 0) return result;
    const samples: CleanSample[] = [];
    for (const item of raw.slice(0, CONDITION_SAMPLES_PER_BEAT)) {
      const s = cleanSample(item);
      if (s) samples.push(s);
      else result.malformed += 1;
    }
    const ids = [...new Set(samples.map((s) => s.conditionId))];
    if (ids.length === 0) return result;
    const served = new Set((await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "condition" c
        JOIN "workspace" w ON w."id" = c."workspace_id" AND w."owner_id" = c."owner_id"
       WHERE c."id" = ANY(${ids}::uuid[]) AND c."owner_id" = ${runner.ownerId}::uuid AND c."state" <> 'ENDED'
         AND w."runner_id" = ${runner.id}::uuid AND w."deleted_at" IS NULL
    `).map((r) => r.id));
    const alerts: ConditionAlert[] = [];
    for (const id of ids) {
      const mine = samples.filter((s) => s.conditionId === id);
      if (!served.has(id)) {
        result.refused += mine.length;
        continue;
      }
      mine.sort((a, b) => a.at.getTime() - b.at.getTime());
      const { stored, alert } = await this.applySamples(id, runner.id, mine);
      result.stored += stored;
      if (alert) alerts.push(alert);
    }
    await this.send(alerts);
    return result;
  }

  private async applySamples(conditionId: string, runnerId: string, samples: CleanSample[]): Promise<{ stored: number; alert: ConditionAlert | null }> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const condition = await this.lock(tx, conditionId);
      // Served is checked again under the lock: the workspace may have moved to another runner since.
      const workspace = await tx.workspace.findFirst({
        where: { id: condition?.workspaceId, ownerId: condition?.ownerId, runnerId, deletedAt: null },
        select: { id: true },
      });
      if (!condition || condition.state === 'ENDED' || !workspace) return { stored: 0, alert: null };
      const inserted = await tx.conditionSample.createMany({
        data: samples.map((s) => ({
          conditionId, at: s.at, outcome: s.outcome, value: s.value, exitCode: s.exitCode, stderrTail: s.stderrTail,
        })),
        skipDuplicates: true,
      });
      let machine = machineOf(condition);
      const rules = rulesOf(condition);
      const steps: ConditionStep[] = [];
      for (const sample of samples) {
        const step = evaluateSample(rules, machine, sample);
        steps.push(step);
        machine = step.next;
      }
      const alert = await this.write(tx, condition, machine, steps);
      await tx.$executeRaw`
        DELETE FROM "condition_sample" WHERE "condition_id" = ${conditionId}::uuid AND "id" IN (
          SELECT "id" FROM "condition_sample" WHERE "condition_id" = ${conditionId}::uuid
           ORDER BY "at" DESC OFFSET ${CONDITION_SAMPLES_KEPT}
        )
      `;
      return { stored: inserted.count, alert };
    }, { label: 'conditions.applySamples' });
  }

  /**
   * The clock's part: every live condition silent for three intervals goes UNKNOWN (RUNNER_ASLEEP for a managed runner
   * asleep, else RUNNER_OFFLINE); and samples older than 30 days go. Safe to run on every replica at once: each
   * condition is decided under its row lock.
   */
  async sweep(): Promise<{ unknown: number; pruned: number }> {
    const now = this.clock();
    const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "condition"
       WHERE "state" IN ('WAITING', 'HOLDING', 'FIRED')
         AND COALESCE("last_sample_at", "approved_at") <= ${now}::timestamptz - ("interval_seconds" * 3) * interval '1 second'
       LIMIT 500
    `;
    const alerts: ConditionAlert[] = [];
    let unknown = 0;
    for (const { id } of candidates) {
      const alert = await withTransactionRetry(this.prisma, async (tx) => {
        const condition = await this.lock(tx, id);
        if (!condition || !silentSince(condition, condition, now)) return undefined;
        const asleep = await this.runnerAsleep(tx, condition);
        const step = evaluateSilence(condition, { ...machineOf(condition), approvedAt: condition.approvedAt }, now, asleep);
        if (!step.enteredUnknown) return undefined;
        unknown += 1;
        return this.write(tx, condition, step.next, [step]);
      }, { label: 'conditions.sweep' });
      if (alert) alerts.push(alert);
    }
    await this.send(alerts);
    const pruned = await this.prisma.$executeRaw`
      DELETE FROM "condition_sample" WHERE "at" < ${now}::timestamptz - ${CONDITION_SAMPLE_KEEP_DAYS} * interval '1 day'
    `;
    return { unknown, pruned };
  }

  /** The owner's read: state, the newest samples and the events. Another account's condition is a 404. */
  async get(ownerId: string, id: string): Promise<ConditionView> {
    const c = UUID_RE.test(id)
      ? await this.prisma.condition.findFirst({
          where: { id, ownerId },
          include: {
            samples: { orderBy: { at: 'desc' }, take: VIEW_SAMPLES },
            events: { orderBy: [{ at: 'desc' }, { id: 'desc' }], take: VIEW_EVENTS },
          },
        })
      : null;
    if (!c) throw new NotFoundException({ code: CONDITION_NOT_FOUND, message: 'no such condition' });
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      text: c.text,
      unit: c.unit,
      probe: { command: c.probeCommand, timeoutSeconds: c.probeTimeoutSeconds },
      compare: { op: c.compareOp, value: c.compareValue },
      holdSeconds: c.holdSeconds,
      rearm: c.rearmOp ? { op: c.rearmOp, value: c.rearmValue } : null,
      intervalSeconds: c.intervalSeconds,
      state: c.state,
      lastSampleAt: iso(c.lastSampleAt),
      lastValue: c.lastValue,
      lastOutcome: c.lastOutcome,
      lastReadAt: iso(c.lastReadAt),
      trueSince: iso(c.trueSince),
      unknownSince: iso(c.unknownSince),
      unknownReason: c.unknownReason as ConditionUnknownReason | null,
      failedChecks: c.failedChecks,
      firedAt: iso(c.firedAt),
      approvedAt: c.approvedAt.toISOString(),
      taskId: c.taskId,
      scheduleId: c.scheduleId,
      createdAt: c.createdAt.toISOString(),
      endedAt: iso(c.endedAt),
      samples: c.samples.map((s) => ({
        at: s.at.toISOString(), outcome: s.outcome, value: s.value, exitCode: s.exitCode, stderrTail: s.stderrTail,
      })),
      events: c.events.map((e) => ({ at: e.at.toISOString(), kind: e.kind, value: e.value, runId: e.runId })),
    };
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<Condition | null> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "condition" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return locked.length ? tx.condition.findUnique({ where: { id } }) : null;
  }

  private async runnerAsleep(tx: Prisma.TransactionClient, condition: Condition): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ asleep: boolean }>>`
      SELECT (m."desired_state" = 'SLEEPING' OR m."management_state" = 'SLEEPING') AS "asleep"
        FROM "workspace" w JOIN "managed_runner" m ON m."runner_id" = w."runner_id"
       WHERE w."id" = ${condition.workspaceId}::uuid
    `;
    return rows[0]?.asleep === true;
  }

  /**
   * Write what the steps decided: the columns, the events, the fire hooks for a FIRED, and the item for entering or
   * leaving UNKNOWN. Returns the push to send once the transaction commits.
   */
  private async write(
    tx: Prisma.TransactionClient,
    condition: Condition,
    machine: ConditionMachine,
    steps: ConditionStep[],
  ): Promise<ConditionAlert | null> {
    const updated = await tx.condition.update({ where: { id: condition.id }, data: { ...machine } });
    const events: ConditionEventDraft[] = steps.flatMap((s) => s.events);
    let alert: ConditionAlert | null = null;
    const now = this.clock();
    for (const event of events) {
      const row = await tx.conditionEvent.create({
        data: { conditionId: condition.id, at: event.at, kind: event.kind, value: event.value },
        select: { id: true },
      });
      if (event.kind === 'FIRED') {
        for (const hook of this.hooks) {
          await hook.onFired(tx, { condition: updated, eventId: row.id, at: event.at, value: event.value });
        }
      }
    }
    for (const step of steps) {
      if (step.leftUnknown) await closeUnknownItems(tx, condition.id, now);
      if (step.enteredUnknown) alert = await this.enteredUnknown(tx, updated, step.next, step.enteredUnknown, now);
    }
    // An alert only for the spell the condition is still in: one that left UNKNOWN again in the same beat says nothing.
    return updated.state === 'UNKNOWN' ? alert : null;
  }

  private async enteredUnknown(
    tx: Prisma.TransactionClient,
    condition: Condition,
    machine: ConditionMachine,
    reason: ConditionUnknownReason,
    now: Date,
  ): Promise<ConditionAlert | null> {
    if (!unknownIsNotified(reason) || !machine.unknownSince) return null;
    const copy = unknownCopy({
      text: condition.text,
      unit: condition.unit,
      reason,
      lastValue: machine.lastValue,
      lastReadAt: machine.lastReadAt,
      lastSampleAt: machine.lastSampleAt,
      approvedAt: condition.approvedAt,
      now,
    });
    const key = unknownItemKey(condition.id, machine.unknownSince);
    const home = await this.homeSession(tx, condition);
    let ownerRequestId: string | null = null;
    if (home) {
      ownerRequestId = await fileUnknownItem(tx, {
        ownerId: condition.ownerId, askedBySessionId: home, conditionId: condition.id, workspaceId: condition.workspaceId,
        key, title: copy.title, why: copy.why,
      });
      // Filed before: a replay of the same entry, already told.
      if (!ownerRequestId) return null;
    }
    return {
      ownerId: condition.ownerId, conditionId: condition.id, sessionId: home, ownerRequestId,
      title: copy.title, body: copy.body, collapseId: key,
    };
  }

  /** Where the item is shown: the conversation the condition came from, else its task's or its schedule's. */
  private async homeSession(tx: Prisma.TransactionClient, condition: Condition): Promise<string | null> {
    if (condition.createdFromSessionId) return condition.createdFromSessionId;
    if (condition.taskId) {
      const task = await tx.task.findUnique({ where: { id: condition.taskId }, select: { creatorSessionId: true } });
      return task?.creatorSessionId ?? null;
    }
    if (condition.scheduleId) {
      const schedule = await tx.schedule.findUnique({ where: { id: condition.scheduleId }, select: { createdFromSessionId: true } });
      return schedule?.createdFromSessionId ?? null;
    }
    return null;
  }

  private async send(alerts: readonly ConditionAlert[]): Promise<void> {
    if (!this.notifier) return;
    for (const alert of alerts) {
      try {
        await this.notifier.notify(alert);
      } catch (error) {
        this.log.warn(`condition alert for ${alert.conditionId} was not sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
