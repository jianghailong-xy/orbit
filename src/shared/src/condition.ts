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
