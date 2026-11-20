/**
 * The envelope (docs/scheduled-tasks-design.md §4): what a person agreed to on a card, in four parts and nothing
 * else — the workspace, the access level, runs per week and the run limit — and, for a WHEN rule, a fifth: the probe
 * command the owner approved (docs/condition-triggers-design.md §4.1, §6.1), kept as its hash. One pure rule decides whether a change
 * applies at once or waits for the owner's press, and what the envelope becomes after it.
 */
import { PermissionMode } from '@orbit/shared';

export type AccessLevel = 'CHECK_ONLY' | 'OPEN_PR' | 'LAND';
export type ChangedBy = 'USER' | 'SESSION' | 'RUN';

export interface Envelope {
  workspaceId: string;
  accessLevel: AccessLevel;
  runsPerWeek: number;
  runLimitMinutes: number;
  /**
   * A WHEN rule's approved probe command, as its sha256; null (or absent, in an envelope stored before it existed) for
   * a timed schedule. A command whose hash differs from the envelope's is wider: any change of command waits for Allow.
   */
  commandHash?: string | null;
}

export type EnvelopePart = 'WORKSPACE' | 'ACCESS_LEVEL' | 'RUNS_PER_WEEK' | 'RUN_LIMIT' | 'PROBE_COMMAND';

export const DEFAULT_RUN_LIMIT_MINUTES = 30;
export const MAX_RUN_LIMIT_MINUTES = 120;

const ACCESS_ORDER: Record<AccessLevel, number> = { CHECK_ONLY: 0, OPEN_PR: 1, LAND: 2 };

/** The permission mode a run at each access level gets (§6.2). */
export const ACCESS_LEVEL_MODE: Record<AccessLevel, PermissionMode> = {
  CHECK_ONLY: PermissionMode.PLAN,
  OPEN_PR: PermissionMode.ACCEPT_EDITS,
  LAND: PermissionMode.ACCEPT_EDITS,
};

/** The parts of `asked` that are wider than `envelope`, in the card's order. */
export function widenedParts(envelope: Envelope, asked: Envelope): EnvelopePart[] {
  const parts: EnvelopePart[] = [];
  if (asked.workspaceId !== envelope.workspaceId) parts.push('WORKSPACE');
  if (ACCESS_ORDER[asked.accessLevel] > ACCESS_ORDER[envelope.accessLevel]) parts.push('ACCESS_LEVEL');
  if (asked.runsPerWeek > envelope.runsPerWeek) parts.push('RUNS_PER_WEEK');
  if (asked.runLimitMinutes > envelope.runLimitMinutes) parts.push('RUN_LIMIT');
  if (asked.commandHash && asked.commandHash !== (envelope.commandHash ?? null)) parts.push('PROBE_COMMAND');
  return parts;
}

export interface EnvelopeJudgment {
  /** Inside: the change applies at once. Otherwise it waits on a card naming `widens`. */
  inside: boolean;
  widens: EnvelopePart[];
  /** The envelope once the change applies (at once when inside, on Allow when not). */
  next: Envelope;
}

/**
 * Judge a change from `before` (what the schedule needs now) to `after` (what it would need), against `envelope`.
 *
 *   * Inside the envelope: applies at once.
 *   * Outside: waits; on Allow the widened parts take what `after` needs.
 *   * A person's narrowing (USER, or an ordinary SESSION) shrinks the envelope part it narrowed; a RUN's own
 *     narrowing leaves the envelope as it was, so the run, or any session, may return to it without asking.
 *     Only a part the change itself narrowed shrinks: rewriting the prompt of a schedule a run had backed off
 *     leaves the envelope where it was.
 */
export function judgeEnvelopeChange(envelope: Envelope, before: Envelope, after: Envelope, changedBy: ChangedBy): EnvelopeJudgment {
  const widens = widenedParts(envelope, after);
  const next: Envelope = { ...envelope };
  if (widens.includes('WORKSPACE')) next.workspaceId = after.workspaceId;
  if (widens.includes('ACCESS_LEVEL')) next.accessLevel = after.accessLevel;
  if (widens.includes('RUNS_PER_WEEK')) next.runsPerWeek = after.runsPerWeek;
  if (widens.includes('RUN_LIMIT')) next.runLimitMinutes = after.runLimitMinutes;
  if (widens.includes('PROBE_COMMAND')) next.commandHash = after.commandHash;
  if (changedBy !== 'RUN') {
    if (ACCESS_ORDER[after.accessLevel] < ACCESS_ORDER[before.accessLevel]) {
      next.accessLevel = ACCESS_ORDER[after.accessLevel] < ACCESS_ORDER[next.accessLevel] ? after.accessLevel : next.accessLevel;
    }
    if (after.runsPerWeek < before.runsPerWeek) next.runsPerWeek = Math.min(next.runsPerWeek, after.runsPerWeek);
    if (after.runLimitMinutes < before.runLimitMinutes) next.runLimitMinutes = Math.min(next.runLimitMinutes, after.runLimitMinutes);
  }
  return { inside: widens.length === 0, widens, next };
}

export function sameEnvelope(a: Envelope, b: Envelope): boolean {
  return (
    a.workspaceId === b.workspaceId
    && a.accessLevel === b.accessLevel
    && a.runsPerWeek === b.runsPerWeek
    && a.runLimitMinutes === b.runLimitMinutes
    && (a.commandHash ?? null) === (b.commandHash ?? null)
  );
}
