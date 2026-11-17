/**
 * A task's startWhen (docs/condition-triggers-design.md §3, §5.2, §6.2; C4): the condition that starts a task, a peer
 * of `runAt`.
 *
 *   - Created with the task, in the same transaction, on the card's approval: the condition (createCondition, which
 *     stores the command's hash as approved) and its baseline, the reading the agent took before filing. A baseline
 *     that already holds fires the condition at once, so the task is due from the start.
 *   - Due: the scans that evaluate `run_at` gain "its condition has fired" (START_WHEN_FIRED_SQL in SCHEDULED_DUE_SQL)
 *     and the two ready predicates are vetoed until it has (START_WHEN_PERMITS_SQL), as a future `run_at` vetoes them.
 *     Retained, not consumed: a fired condition stays fired while its task is unassigned, held or blocked.
 *   - Ended: by the start that keeps it, whichever door started it, which also clears the task's pointer as a start
 *     clears `run_at` (endStartWhen); by the task being cancelled, done or failed (migration 1060's trigger); by the
 *     owner's Stop on the 30-day question, which leaves the pointer, so the task stays OPEN and starts by nobody but a
 *     person.
 *
 * A condition is not a dependency state: nothing here reads or writes dependencyState or the dependency gate.
 */
import { BadRequestException } from '@nestjs/common';
import {
  startWhenWaitingLine,
  type ConditionState,
  type TaskStartWhenInput,
  type TaskStartWhenView,
} from '@orbit/shared';
import type { Condition, Prisma } from '@prisma/client';

import { readingText } from '../conditions/condition-attention';
import { evaluateSample, type ConditionMachine } from '../conditions/condition-evaluation';
import type { ConditionsService } from '../conditions/conditions.service';

/** The refusal of a task that names both triggers. */
export const TASK_START_WHEN_AND_RUN_AT = 'TASK_START_WHEN_AND_RUN_AT';

type Db = Prisma.TransactionClient;

/**
 * The condition `t` waits on has fired and has not ended. `fired_at` rather than `state = 'FIRED'`: a fired startWhen
 * that goes UNKNOWN (its runner offline while the task waits for a slot) has still fired, and keeps the task due.
 */
export function startWhenFiredSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM "condition" sw WHERE sw."id" = ${alias}."start_when_condition_id"`
    + ` AND sw."fired_at" IS NOT NULL AND sw."state" <> 'ENDED')`;
}

/** No startWhen, or one that has fired: what the ready predicates add beside `run_at IS NULL OR run_at <= now()`. */
export function startWhenPermitsSql(alias: string): string {
  return `(${alias}."start_when_condition_id" IS NULL OR ${startWhenFiredSql(alias)})`;
}

/** The same question for a row read in TypeScript (the dependents' instant path). */
export function startWhenPermits(condition: { firedAt: Date | null; state: ConditionState } | null | undefined): boolean {
  if (!condition) return true;
  return condition.firedAt !== null && condition.state !== 'ENDED';
}

/** The checks the DTO's decorators cannot state, before anything is written. `where` prefixes a batch item's index. */
export function assertStartWhenShape(
  item: { startWhen?: TaskStartWhenInput | null; runAt?: string | null; assigneeId?: string | null },
  where = '',
): void {
  const sw = item.startWhen;
  if (!sw) return;
  if (item.runAt) {
    throw new BadRequestException({
      code: TASK_START_WHEN_AND_RUN_AT,
      message: `${where}a task has at most one of runAt and startWhen: name the time or the condition, not both`,
    });
  }
  if (!item.assigneeId) {
    throw new BadRequestException(`${where}startWhen needs an assigneeId: the condition is checked on that workspace's runner`);
  }
  if (!sw.text?.trim()) throw new BadRequestException(`${where}startWhen.text is required: the condition in words`);
  if (!sw.command?.trim()) throw new BadRequestException(`${where}startWhen.command is required: the probe the runner runs`);
  const exitZero = sw.compare?.op === 'EXIT_ZERO';
  if (!exitZero && !(typeof sw.compare?.value === 'number' && Number.isFinite(sw.compare.value))) {
    throw new BadRequestException(`${where}startWhen.compare.value is required unless the comparison is EXIT_ZERO`);
  }
  const b = sw.baseline;
  if (!b) {
    throw new BadRequestException(`${where}startWhen.baseline is required: run the command once and pass what it read`);
  }
  if (exitZero ? !Number.isInteger(b.exitCode) : !(typeof b.value === 'number' && Number.isFinite(b.value))) {
    throw new BadRequestException(
      `${where}startWhen.baseline.${exitZero ? 'exitCode' : 'value'} is required: what the command read when you ran it`,
    );
  }
}

const INITIAL: ConditionMachine = {
  state: 'WAITING', armed: true, lastSampleAt: null, lastValue: null, lastOutcome: null, lastReadAt: null,
  trueSince: null, unknownSince: null, unknownReason: null, failedChecks: 0, firedAt: null, repeatFrom: null,
};

/**
 * The task's condition and its baseline, in the transaction that writes the task, and the task's pointer to it. The
 * baseline is the condition's first sample, evaluated as any sample is: one that holds with no hold fires at once.
 */
export async function writeStartWhen(
  tx: Db,
  conditions: Pick<ConditionsService, 'createCondition'>,
  input: {
    ownerId: string;
    taskId: string;
    workspaceId: string;
    startWhen: TaskStartWhenInput;
    createdFromSessionId: string | null;
    approvedAt: Date;
  },
): Promise<Condition> {
  const sw = input.startWhen;
  const exitZero = sw.compare.op === 'EXIT_ZERO';
  const condition = await conditions.createCondition(tx, {
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    command: sw.command,
    timeoutSeconds: sw.timeoutSeconds,
    compare: { op: sw.compare.op, value: exitZero ? null : sw.compare.value ?? null },
    holdSeconds: sw.holdSeconds,
    intervalSeconds: sw.intervalSeconds,
    text: sw.text,
    unit: sw.unit ?? null,
    taskId: input.taskId,
    createdFromSessionId: input.createdFromSessionId,
    approvedAt: input.approvedAt,
  });
  const sample = {
    at: input.approvedAt,
    outcome: exitZero ? 'EXIT' as const : 'VALUE' as const,
    value: exitZero ? null : sw.baseline.value ?? null,
    exitCode: exitZero ? sw.baseline.exitCode ?? null : null,
  };
  const step = evaluateSample(
    {
      compareOp: condition.compareOp,
      compareValue: condition.compareValue,
      holdSeconds: condition.holdSeconds,
      rearmOp: null,
      rearmValue: null,
      intervalSeconds: condition.intervalSeconds,
      // A startWhen fires once: no repeat (WHEN rules only).
      repeatSeconds: null,
      scheduleId: null,
    },
    INITIAL,
    sample,
  );
  await tx.conditionSample.create({ data: { conditionId: condition.id, ...sample } });
  const written = await tx.condition.update({ where: { id: condition.id }, data: { ...step.next } });
  for (const event of step.events) {
    await tx.conditionEvent.create({ data: { conditionId: condition.id, at: event.at, kind: event.kind, value: event.value } });
  }
  await tx.task.update({ where: { id: input.taskId }, data: { startWhenConditionId: condition.id } });
  return written;
}

/**
 * The start that keeps a startWhen: the condition ends and the task's pointer clears, as a start clears `run_at`.
 * Compare-and-set on the condition the start read, so it is exactly-once under an at-least-once sweep and a second
 * call changes nothing. Whichever door started the task (the scan, task_start, Run, a bulk Run) ends it: task_start
 * ignores the condition and ends it too (§5.2).
 */
export async function endStartWhen(
  db: Db,
  ownerId: string,
  taskId: string,
  conditionId: string | null | undefined,
  now: Date,
): Promise<boolean> {
  if (!conditionId) return false;
  await db.condition.updateMany({
    where: { id: conditionId, ownerId, taskId, state: { not: 'ENDED' } },
    data: { state: 'ENDED', endedAt: now },
  });
  const cleared = await db.task.updateMany({
    where: { id: taskId, ownerId, startWhenConditionId: conditionId },
    data: { startWhenConditionId: null },
  });
  return cleared.count > 0;
}

/** What the task read selects of its condition. */
export const START_WHEN_VIEW_SELECT = {
  id: true, text: true, unit: true, state: true, lastValue: true, lastSampleAt: true, firedAt: true,
} satisfies Prisma.ConditionSelect;

/** The task read's `startWhen`: what it waits for, the newest reading, and the waiting line while it waits. */
export function startWhenView(
  c: Prisma.ConditionGetPayload<{ select: typeof START_WHEN_VIEW_SELECT }> | null | undefined,
): TaskStartWhenView | null {
  if (!c) return null;
  const waiting = c.state !== 'ENDED' && c.firedAt === null;
  return {
    conditionId: c.id,
    text: c.text,
    unit: c.unit,
    state: c.state,
    lastValue: c.lastValue,
    lastSampleAt: c.lastSampleAt ? c.lastSampleAt.toISOString() : null,
    firedAt: c.firedAt ? c.firedAt.toISOString() : null,
    waitingLine: waiting ? startWhenWaitingLine(c.text) : null,
  };
}

function intervalText(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Whether the baseline already holds: the card says the task starts at once. */
function baselineHolds(sw: TaskStartWhenInput): boolean {
  const { op, value } = sw.compare;
  if (op === 'EXIT_ZERO') return sw.baseline.exitCode === 0;
  const v = sw.baseline.value;
  if (typeof v !== 'number' || typeof value !== 'number') return false;
  switch (op) {
    case 'GT': return v > value;
    case 'GTE': return v >= value;
    case 'LT': return v < value;
    case 'LTE': return v <= value;
    case 'EQ': return v === value;
  }
}

/** The confirmation card's three lines (frame 2 of docs/mocks/condition-triggers): Starts when, Today, If never. */
export type StartWhenCardLines = {
  startsWhen: string;
  /** How it is checked, under the condition. */
  checked: string;
  command: string;
  today: string;
  ifNever: string;
};

export function startWhenCardLines(sw: TaskStartWhenInput, runnerName: string | null): StartWhenCardLines {
  const interval = intervalText(sw.intervalSeconds ?? 300);
  const where = runnerName ? ` on ${runnerName}` : '';
  const reading = sw.compare.op === 'EXIT_ZERO'
    ? `The check exited ${sw.baseline.exitCode ?? '?'}`
    : readingText(sw.baseline.value ?? 0, sw.unit ?? null);
  const holds = baselineHolds(sw);
  return {
    startsWhen: sw.text.trim(),
    checked: `Once. Checked every ${interval}${where}, no model.`,
    command: sw.command.trim(),
    today: holds
      ? `${reading}. It already holds, so the task starts as soon as it is created.`
      : `${reading}. Not yet.`,
    ifNever: 'Asks you after 30 days of waiting',
  };
}

/**
 * The block a run started by its condition begins with (§6.2): what fired and when, and that the reading may have gone
 * back since, so the run checks again itself and ends without acting if it no longer holds.
 */
export function conditionStartedBlock(c: {
  text: string;
  unit: string | null;
  probeCommand: string;
  firedAt: Date | null;
  lastValue: number | null;
  compareOp: string;
  firedValue: number | null;
}): string {
  const value = c.firedValue ?? c.lastValue;
  const reading = value === null
    ? ''
    : c.compareOp === 'EXIT_ZERO'
      ? ` (the check exited ${value})`
      : ` (it read ${readingText(value, c.unit)})`;
  const at = c.firedAt ? ` at ${c.firedAt.toISOString()}` : '';
  return [
    '## Started by a condition',
    '',
    `This task was started by its condition, not by a person: "${c.text}" held${reading}${at}.`,
    'The reading may have gone back since it fired. Before you act, check the condition again yourself by running:',
    '',
    '```sh',
    c.probeCommand,
    '```',
    '',
    'If it no longer holds, say so and end without acting: the owner decides whether to wait again.',
  ].join('\n');
}
