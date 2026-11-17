/**
 * How a condition's state moves (docs/condition-triggers-design.md §5), as a pure function of the condition and one
 * sample, or of the condition and the clock. conditions.service.ts writes what it returns.
 *
 *   WAITING ──compare true──▶ HOLDING ──true for holdSeconds──▶ FIRED
 *      ▲                         │                                 │
 *      └──────compare false──────┘          WHEN: rearm holds ─────┘  (READY_AGAIN)
 *                                           startWhen: stays FIRED until its task starts (C4 ends it)
 *
 *   any ──3 failed checks in a row, or no sample for 3 intervals──▶ UNKNOWN ──a sample that reads──▶ back, by that sample
 *
 * The rules this file holds:
 *   - it fires on the crossing, once: `armed` is false from FIRED until the re-arm comparison holds, and nothing
 *     fires while it is false;
 *   - holdSeconds is measured between samples: from the first sample of an unbroken run of true samples
 *     (`trueSince`) to the sample that completes the span. A hold of 0 fires on the first true sample;
 *   - a failed sample (timed out, an error, no number, or a non-zero exit outside EXIT_ZERO) is neither true nor
 *     false: it counts towards UNKNOWN and leaves the hold as it is, but it cannot complete one;
 *   - UNKNOWN never fires and never counts as false: entering it clears `trueSince`, so a hold starts over;
 *   - a sample that reads leaves UNKNOWN and is then evaluated as any sample is, from WAITING when the condition is
 *     armed and from FIRED when it is not. So a condition that already held when it went UNKNOWN fires on its first
 *     reading only if it was armed: the newest sample decides, and nothing replays;
 *   - with no `rearm`, a WHEN condition is ready again as soon as the comparison is false; the sample that re-arms it
 *     starts no hold of its own;
 *   - a sample no newer than the newest one already evaluated is stored and not evaluated;
 *   - with `repeatSeconds` (WHEN rules only), a FIRED condition fires again once that long has passed since
 *     `repeatFrom`, on a sample whose comparison holds, while it has not re-armed. `repeatFrom` is the last FIRED; a
 *     sample whose comparison is false without re-arming clears it, and the next sample that holds sets it again, so
 *     the clock restarts from that sample. Entering UNKNOWN clears it too, and the sample that leaves UNKNOWN restarts
 *     it: UNKNOWN never repeats. A failed sample neither completes a repeat nor breaks one.
 */
import type { ConditionCompareOp, ConditionEventKind, ConditionSampleOutcome, ConditionState, ConditionUnknownReason } from '@orbit/shared';

/** Three failed checks in a row, or three intervals with no sample, is UNKNOWN (§5.3). */
export const CONDITION_FAILURES_TO_UNKNOWN = 3;
export const CONDITION_SILENT_INTERVALS_TO_UNKNOWN = 3;

/** What the comparison and the attach point say. */
export interface ConditionRules {
  compareOp: ConditionCompareOp;
  compareValue: number | null;
  holdSeconds: number;
  rearmOp: ConditionCompareOp | null;
  rearmValue: number | null;
  intervalSeconds: number;
  /** A schedule's WHEN rule re-arms; a task's startWhen fires once. */
  scheduleId: string | null;
  /** WHEN rules only: fire again every this many seconds while it still holds and has not re-armed; null never. */
  repeatSeconds: number | null;
}

/** The columns the evaluation moves. */
export interface ConditionMachine {
  state: ConditionState;
  armed: boolean;
  lastSampleAt: Date | null;
  lastValue: number | null;
  lastOutcome: ConditionSampleOutcome | null;
  lastReadAt: Date | null;
  trueSince: Date | null;
  unknownSince: Date | null;
  unknownReason: ConditionUnknownReason | null;
  failedChecks: number;
  /** When it last fired on a crossing (a repeat leaves it): the run block's "first fired". */
  firedAt: Date | null;
  /** What the next repeat is counted from; null while none is due. */
  repeatFrom: Date | null;
}

export interface ConditionSampleInput {
  at: Date;
  outcome: ConditionSampleOutcome;
  value: number | null;
  exitCode: number | null;
}

export interface ConditionEventDraft {
  kind: ConditionEventKind;
  at: Date;
  value: number | null;
  /** A FIRED that is a repeat: "Fired again". */
  repeat?: boolean;
}

export interface ConditionStep {
  next: ConditionMachine;
  events: ConditionEventDraft[];
  /** Set when this step entered UNKNOWN, with why. */
  enteredUnknown: ConditionUnknownReason | null;
  /** Set when this step left UNKNOWN. */
  leftUnknown: boolean;
  /** Set when this step fired: the FIRED event is in `events`. */
  fired: boolean;
}

/** What one sample says: a reading (its number, or its exit code under EXIT_ZERO), or a failure and why. */
type Reading =
  | { ok: true; value: number; exitCode: number | null }
  | { ok: false; reason: 'TIMEOUT' | 'ERROR' };

function readingOf(sample: ConditionSampleInput, op: ConditionCompareOp): Reading {
  if (sample.outcome === 'TIMEOUT') return { ok: false, reason: 'TIMEOUT' };
  if (op === 'EXIT_ZERO') {
    return sample.outcome === 'EXIT' && Number.isInteger(sample.exitCode)
      ? { ok: true, value: sample.exitCode!, exitCode: sample.exitCode }
      : { ok: false, reason: 'ERROR' };
  }
  return sample.outcome === 'VALUE' && typeof sample.value === 'number' && Number.isFinite(sample.value)
    ? { ok: true, value: sample.value, exitCode: sample.exitCode }
    : { ok: false, reason: 'ERROR' };
}

function holds(op: ConditionCompareOp, line: number | null, reading: { value: number; exitCode: number | null }): boolean {
  switch (op) {
    case 'EXIT_ZERO': return (reading.exitCode ?? reading.value) === 0;
    case 'GT': return reading.value > line!;
    case 'GTE': return reading.value >= line!;
    case 'LT': return reading.value < line!;
    case 'LTE': return reading.value <= line!;
    case 'EQ': return reading.value === line!;
  }
}

/** Whether one sample holds the comparison: null when it read nothing (a failed check is neither true nor false). */
export function sampleHolds(op: ConditionCompareOp, line: number | null, sample: ConditionSampleInput): boolean | null {
  const reading = readingOf(sample, op);
  return reading.ok ? holds(op, line, reading) : null;
}

function enterUnknown(m: ConditionMachine, at: Date, reason: ConditionUnknownReason, step: ConditionStep): void {
  m.state = 'UNKNOWN';
  m.unknownSince = at;
  m.unknownReason = reason;
  m.trueSince = null;
  m.repeatFrom = null;
  step.events.push({ kind: 'CANT_READ', at, value: null });
  step.enteredUnknown = reason;
}

function blankStep(machine: ConditionMachine): ConditionStep {
  return { next: { ...machine }, events: [], enteredUnknown: null, leftUnknown: false, fired: false };
}

/** One sample, evaluated. */
export function evaluateSample(rules: ConditionRules, machine: ConditionMachine, sample: ConditionSampleInput): ConditionStep {
  const step = blankStep(machine);
  const m = step.next;
  if (m.state === 'ENDED') return step;
  if (m.lastSampleAt && sample.at.getTime() <= m.lastSampleAt.getTime()) return step;
  m.lastSampleAt = sample.at;
  m.lastOutcome = sample.outcome;

  const reading = readingOf(sample, rules.compareOp);
  if (!reading.ok) {
    m.failedChecks += 1;
    if (m.state !== 'UNKNOWN' && m.failedChecks >= CONDITION_FAILURES_TO_UNKNOWN) enterUnknown(m, sample.at, reading.reason, step);
    return step;
  }

  m.failedChecks = 0;
  m.lastValue = reading.value;
  m.lastReadAt = sample.at;
  if (m.state === 'UNKNOWN') {
    m.state = m.armed ? 'WAITING' : 'FIRED';
    m.unknownSince = null;
    m.unknownReason = null;
    m.trueSince = null;
    m.repeatFrom = null;
    step.events.push({ kind: 'READ_AGAIN', at: sample.at, value: reading.value });
    step.leftUnknown = true;
  }

  const compareHolds = holds(rules.compareOp, rules.compareValue, reading);
  if (!m.armed) {
    // FIRED. A startWhen condition stays FIRED until its task starts; a WHEN condition waits for its re-arm.
    if (rules.scheduleId === null) return step;
    const ready = rules.rearmOp ? holds(rules.rearmOp, rules.rearmValue, reading) : !compareHolds;
    if (ready) {
      m.armed = true;
      m.state = 'WAITING';
      m.trueSince = null;
      m.repeatFrom = null;
      step.events.push({ kind: 'READY_AGAIN', at: sample.at, value: reading.value });
      return step;
    }
    if (rules.repeatSeconds === null) return step;
    if (!compareHolds) {
      // False, but not re-armed yet: the repeats stop until the comparison holds again.
      m.repeatFrom = null;
    } else if (m.repeatFrom === null) {
      // It holds again after a break, or after UNKNOWN: the clock restarts from this sample.
      m.repeatFrom = sample.at;
    } else if (sample.at.getTime() - m.repeatFrom.getTime() >= rules.repeatSeconds * 1000) {
      m.repeatFrom = sample.at;
      step.events.push({ kind: 'FIRED', at: sample.at, value: reading.value, repeat: true });
      step.fired = true;
    }
    return step;
  }

  if (!compareHolds) {
    m.state = 'WAITING';
    m.trueSince = null;
    return step;
  }
  m.trueSince ??= sample.at;
  if (sample.at.getTime() - m.trueSince.getTime() >= rules.holdSeconds * 1000) {
    m.state = 'FIRED';
    m.armed = false;
    m.firedAt = sample.at;
    m.trueSince = null;
    m.repeatFrom = rules.repeatSeconds !== null && rules.scheduleId !== null ? sample.at : null;
    step.events.push({ kind: 'FIRED', at: sample.at, value: reading.value });
    step.fired = true;
  } else {
    m.state = 'HOLDING';
  }
  return step;
}

/**
 * The clock's part: a condition with no sample for three intervals since its newest one (or since it was approved,
 * when it has none) is UNKNOWN, `RUNNER_ASLEEP` when its runner is an Orbit Cloud one still coming up (woken for it, and
 * waiting for capacity or starting), else `RUNNER_OFFLINE`. One already UNKNOWN or ENDED is left as it is.
 */
export function evaluateSilence(
  rules: Pick<ConditionRules, 'intervalSeconds'>,
  machine: ConditionMachine & { approvedAt: Date; resumedAt?: Date | null },
  now: Date,
  runnerAsleep: boolean,
): ConditionStep {
  const { approvedAt: _approvedAt, resumedAt: _resumedAt, ...rest } = machine;
  const step = blankStep(rest);
  if (machine.state === 'UNKNOWN' || machine.state === 'ENDED') return step;
  if (!silentSince(rules, machine, now)) return step;
  enterUnknown(step.next, now, runnerAsleep ? 'RUNNER_ASLEEP' : 'RUNNER_OFFLINE', step);
  return step;
}

/**
 * Whether no sample has arrived for three intervals: since the newest sample (or the approval, before any), or since
 * its schedule was resumed when that is newer, so a resume does not read as a runner gone quiet.
 */
export function silentSince(
  rules: Pick<ConditionRules, 'intervalSeconds'>,
  machine: { lastSampleAt: Date | null; approvedAt: Date; resumedAt?: Date | null },
  now: Date,
): boolean {
  const from = machine.lastSampleAt ?? machine.approvedAt;
  const since = machine.resumedAt && machine.resumedAt > from ? machine.resumedAt : from;
  return now.getTime() - since.getTime() >= CONDITION_SILENT_INTERVALS_TO_UNKNOWN * rules.intervalSeconds * 1000;
}
