/**
 * How a task ENDED, for a reader (contract §13.6).
 *
 * `status` alone cannot say it. A cancelled attempt somebody re-ran from scratch and a cancelled
 * attempt somebody dropped are the same status and opposite facts, and until this existed the
 * difference lived in a comment — so a list of a project's history showed a column of identical
 * grey "Cancelled" chips over work that had, in fact, been finished by its successor.
 *
 * Derived here rather than sent as a field for the reason the server derives it too: `status` and
 * `terminalReason` are each authoritative about their own question, and a third value holding
 * their combination is a third thing that can be wrong. The server's `taskOutcome` is the same
 * function; this is the copy that runs where the chip is drawn.
 */

export type TaskOutcome =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'ABANDONED';

export interface TaskOutcomeFacts {
  status?: string | null;
  terminalReason?: string | null;
}

export function taskOutcome(task: TaskOutcomeFacts | null | undefined): TaskOutcome | '' {
  if (!task) return '';
  if (task.terminalReason === 'SUPERSEDED') return 'SUPERSEDED';
  if (task.terminalReason === 'ABANDONED') return 'ABANDONED';
  // An unrecognised status reads as itself, never as a healthy default.
  return (task.status ?? '') as TaskOutcome | '';
}

export interface OutcomeChip {
  label: string;
  tone: string;
}

/**
 * The chip. `SUPERSEDED` is amber rather than grey on purpose: it is the one terminal state that
 * means the work is still happening, and painting it the same muted colour as "Cancelled" is
 * exactly the reading this whole unit exists to correct.
 */
const OUTCOME_CHIP: Record<TaskOutcome, OutcomeChip> = {
  OPEN: { label: 'Open', tone: 'muted' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  DONE: { label: 'Done', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  SUPERSEDED: { label: 'Superseded', tone: 'amber' },
  ABANDONED: { label: 'Abandoned', tone: 'muted' },
};

export function taskOutcomeChip(task: TaskOutcomeFacts | null | undefined): OutcomeChip {
  const outcome = taskOutcome(task);
  return OUTCOME_CHIP[outcome as TaskOutcome] ?? { label: outcome, tone: 'muted' };
}

/**
 * The sentence under the chip: what replaced this, or what this replaced.
 *
 * Returns null when there is nothing to say, so a caller renders nothing rather than an empty row.
 * `SUCCESSOR_DELETED` gets its own wording — "something replaced this and the record of what has
 * been deleted" is a different fact from "nothing did", and reading it as the latter is the one
 * wrong answer.
 */
export function supersessionNote(task: {
  terminalReason?: string | null;
  supersededByTaskIdAbsentReason?: string | null;
  successorChain?: Array<{ id: string; title: string }> | null;
  supersedes?: Array<{ id: string; title: string }> | null;
} | null | undefined): string | null {
  if (!task) return null;
  if (task.terminalReason === 'SUPERSEDED') {
    if (task.supersededByTaskIdAbsentReason === 'SUCCESSOR_DELETED') {
      return 'Superseded — the task that replaced it has been deleted';
    }
    const chain = task.successorChain ?? [];
    if (chain.length === 0) return 'Superseded by a later attempt';
    const head = chain[chain.length - 1];
    return chain.length === 1
      ? `Superseded by ${head.title}`
      : `Superseded — ${head.title} is the live attempt, ${chain.length} replacements on`;
  }
  const replaced = task.supersedes ?? [];
  if (replaced.length === 1) return `Replaces ${replaced[0].title}`;
  if (replaced.length > 1) return `Replaces ${replaced.length} earlier attempts`;
  return null;
}
