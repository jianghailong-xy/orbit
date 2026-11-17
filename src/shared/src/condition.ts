/**
 * Conditions: work that starts when something outside Orbit becomes true (docs/condition-triggers-design.md).
 * The runner runs a condition's probe and reports what it read; the server decides (§4.2, §5).
 */

/** The capability a runner declares to be handed conditionProbes and to report conditionSamples (§4.2). */
export const CONDITION_PROBE_CAPABILITY = 'condition-probe/v1';

export const CONDITION_STATES = ['WAITING', 'HOLDING', 'FIRED', 'UNKNOWN', 'ENDED'] as const;
export type ConditionState = (typeof CONDITION_STATES)[number];

export const CONDITION_COMPARE_OPS = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'EXIT_ZERO'] as const;
export type ConditionCompareOp = (typeof CONDITION_COMPARE_OPS)[number];

export const CONDITION_SAMPLE_OUTCOMES = ['VALUE', 'EXIT', 'TIMEOUT', 'ERROR'] as const;
export type ConditionSampleOutcome = (typeof CONDITION_SAMPLE_OUTCOMES)[number];

export const CONDITION_EVENT_KINDS = ['FIRED', 'READY_AGAIN', 'CANT_READ', 'READ_AGAIN', 'ASKED_STILL_WAITING'] as const;
export type ConditionEventKind = (typeof CONDITION_EVENT_KINDS)[number];

/** Why a condition is UNKNOWN (§5.3, §4.2). RUNNER_ASLEEP is shown and never notified. */
export const CONDITION_UNKNOWN_REASONS = ['TIMEOUT', 'ERROR', 'RUNNER_OFFLINE', 'RUNNER_ASLEEP'] as const;
export type ConditionUnknownReason = (typeof CONDITION_UNKNOWN_REASONS)[number];

/** The Waiting on you kind a condition that cannot be read files (§5.3). */
export const CONDITION_WAITING_KIND = 'CONDITION_UNKNOWN';

/** One probe for the runner to run, on HeartbeatResponse.conditionProbes. Mirrors runner-go ConditionProbe. */
export interface ConditionProbe {
  /** The condition's id. */
  id: string;
  /** The exact command the owner approved. */
  command: string;
  /** sha256 hex of `command`: the runner refuses a command that does not match it. */
  commandHash: string;
  timeoutSeconds: number;
  intervalSeconds: number;
  /** The workspace's directory on this runner, where the command runs. */
  workDir: string;
  /** The workspace's environment, layered over the runner's as a session's is. */
  env: Record<string, string>;
}

/** One reading, on HeartbeatRequest.conditionSamples. */
export interface ConditionSampleReport {
  conditionId: string;
  /** When the probe ran (ISO 8601). */
  at: string;
  /** VALUE: a number on stdout's last line; EXIT: the exit code under EXIT_ZERO; TIMEOUT; ERROR: anything else. */
  outcome: ConditionSampleOutcome;
  value?: number | null;
  exitCode?: number | null;
  stderrTail?: string | null;
}

export interface ConditionCompare {
  op: ConditionCompareOp;
  value?: number | null;
}

export interface ConditionSampleView {
  at: string;
  outcome: ConditionSampleOutcome;
  value: number | null;
  exitCode: number | null;
  stderrTail: string | null;
}

export interface ConditionEventView {
  at: string;
  kind: ConditionEventKind;
  value: number | null;
  runId: string | null;
  /** A FIRED that is a repeat: the history says "Fired again". */
  repeat: boolean;
}

/** GET /conditions/:id: a condition's state, its newest samples and its events. */
export interface ConditionView {
  id: string;
  workspaceId: string;
  text: string;
  unit: string | null;
  probe: { command: string; timeoutSeconds: number };
  compare: ConditionCompare;
  holdSeconds: number;
  rearm: ConditionCompare | null;
  intervalSeconds: number;
  /** A WHEN condition's repeat: it fires again every this many seconds while it still holds; null fires once. */
  repeatSeconds: number | null;
  state: ConditionState;
  lastSampleAt: string | null;
  lastValue: number | null;
  lastOutcome: ConditionSampleOutcome | null;
  lastReadAt: string | null;
  trueSince: string | null;
  unknownSince: string | null;
  unknownReason: ConditionUnknownReason | null;
  failedChecks: number;
  firedAt: string | null;
  approvedAt: string;
  taskId: string | null;
  scheduleId: string | null;
  createdAt: string;
  endedAt: string | null;
  /** Newest first. */
  samples: ConditionSampleView[];
  /** Newest first. */
  events: ConditionEventView[];
}

/** The Waiting on you kind a task's condition that has not fired for 30 days files (§6.2, P3). */
export const CONDITION_STILL_WAITING_KIND = 'CONDITION_STILL_WAITING';
/** How long a task's condition waits before it asks, and again after each Keep waiting. */
export const CONDITION_STILL_WAITING_DAYS = 30;
/** The question's two answers, by option index. */
export const CONDITION_STILL_WAITING_OPTIONS = ['Keep waiting', 'Stop'] as const;

/** What a probe read when the agent ran it before filing: the card's Today line, and the first sample. */
export interface ConditionBaseline {
  /** The number on stdout's last line. Required unless the comparison is EXIT_ZERO. */
  value?: number | null;
  /** The exit code. Required under EXIT_ZERO. */
  exitCode?: number | null;
}

/** task_create's `startWhen` (§6.2, §8): the condition, and the baseline the agent read. */
export interface TaskStartWhenInput {
  text: string;
  command: string;
  compare: ConditionCompare;
  holdSeconds?: number;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  unit?: string | null;
  baseline: ConditionBaseline;
}

/** A task's startWhen on its read: what it waits for, and the newest reading. */
export interface TaskStartWhenView {
  conditionId: string;
  text: string;
  unit: string | null;
  state: ConditionState;
  lastValue: number | null;
  lastSampleAt: string | null;
  firedAt: string | null;
  /** "Waiting for: <text>" while the condition has not fired or ended; null otherwise. */
  waitingLine: string | null;
}

/** The line a waiting task shows wherever a task shows why it has not started. */
export function startWhenWaitingLine(text: string): string {
  return `Waiting for: ${text}`;
}
