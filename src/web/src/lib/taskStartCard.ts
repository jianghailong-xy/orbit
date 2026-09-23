import type { TaskStartCard, TaskStartCriterion } from '@orbit/shared';

/**
 * The turn that starts a task's run, as the control plane recorded it beside the echo — the reading
 * `TaskStartCard` is drawn from.
 *
 * That turn is the brief written for the AGENT: the task's description and acceptance criteria, then
 * four steps of protocol about which tools to call and which statuses never to write. Drawn as a
 * message it was the account owner's own bubble, several screens long, in front of the run's first
 * action. The payload names the task it was built from (`taskStart`, apiserver
 * tasks/task-start-card.ts), and a payload that is not a card parses as NOTHING rather than as half
 * a card — so a turn stored before the payload existed keeps its old reading. Nothing here is read
 * out of the brief's text.
 */
export function parseTaskStartCard(payload: unknown): TaskStartCard | null {
  const raw = (payload as { taskStart?: unknown } | null)?.taskStart;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  // A card names its task and what it is called; a payload missing either is not a card.
  if (typeof card.taskId !== 'string' || card.taskId === '' || typeof card.title !== 'string' || card.title === '') {
    return null;
  }
  const project = card.project as Record<string, unknown> | null | undefined;
  return {
    taskId: card.taskId,
    title: card.title,
    description: stringOrNull(card.description),
    acceptanceCriteria: stringOrNull(card.acceptanceCriteria),
    completionCriterion: criterionOf(card.completionCriterion),
    acceptanceCommand: stringOrNull(card.acceptanceCommand),
    acceptanceExpectedExitCode: typeof card.acceptanceExpectedExitCode === 'number'
      ? card.acceptanceExpectedExitCode
      : null,
    listInstructions: stringOrNull(card.listInstructions),
    project: project && typeof project === 'object' && typeof project.id === 'string'
      && typeof project.title === 'string'
      ? { id: project.id, title: project.title }
      : null,
    auto: card.auto === true,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const CRITERIA: readonly TaskStartCriterion[] = ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT', 'OWNER_CONFIRMED'];

function criterionOf(value: unknown): TaskStartCriterion | null {
  return CRITERIA.includes(value as TaskStartCriterion) ? (value as TaskStartCriterion) : null;
}

/** The card's name, on its head and on the sticky bar that points back at it. */
export const TASK_START_LABEL = 'Task started';
/** The chip a run started by a schedule, a prerequisite finishing or a first run carries. */
export const TASK_START_AUTO_LABEL = 'Auto-started';
export const TASK_START_SHOW_DETAILS = 'Show details';
export const TASK_START_HIDE_DETAILS = 'Hide details';
export const TASK_START_CRITERIA_HEADING = 'Acceptance criteria';
export const TASK_START_INSTRUCTIONS_HEADING = 'List instructions';
export const TASK_START_SHOW_COMMAND = 'Show full command';
export const TASK_START_HIDE_COMMAND = 'Show less';
export const TASK_START_OPEN_TASK = 'Open the task ↗';
/** The fold the brief the agent read stays behind. */
export const TASK_START_RAW_SUMMARY = 'What the agent was told';

/**
 * The judgment each criterion declares, in the words the task panel's chip already uses
 * (`COMPLETION_CRITERION_CHIP`, TaskDetailPanel.tsx — a test holds the two to each other; the panel
 * is not imported here because it imports the transcript this card is drawn in).
 */
export const TASK_START_JUDGED_BY: Record<TaskStartCriterion, string> = {
  EXECUTABLE: 'Judged by · its acceptance command',
  VERIFICATION: 'Judged by · an independent check',
  EVIDENCE_JUDGMENT: 'Judged by · submitted evidence',
  OWNER_CONFIRMED: 'Judged by · the account owner',
};

/** What the declared judgment means for this run, in one line. */
export function taskStartJudgedHow(card: TaskStartCard): string | null {
  switch (card.completionCriterion) {
    case 'EXECUTABLE':
      return `Runs after each turn: exit ${card.acceptanceExpectedExitCode ?? 0} → Done, else Failed.`;
    case 'OWNER_CONFIRMED':
      return 'You confirm it in Orbit once the run says it is done — or send it back.';
    case 'EVIDENCE_JUDGMENT':
      return 'The run submits evidence; an independent session confirms it.';
    case 'VERIFICATION':
      return 'A separate verification task judges the work; this run does not settle it.';
    default:
      return null;
  }
}

/**
 * Whether the description is folded to three lines while the card is shut. One that fits is drawn
 * whole — fading out a sentence that ends there would promise more that is not there.
 */
export function taskStartFoldsDescription(card: TaskStartCard): boolean {
  const description = card.description ?? '';
  return description.includes('\n') || description.length > DESCRIPTION_FOLD_CHARS;
}

/**
 * Whether there is anything behind "Show details": the criteria and the list's instructions are
 * only ever drawn open, a command is clamped until then, and a long description is folded.
 */
export function taskStartHasDetails(card: TaskStartCard): boolean {
  return card.acceptanceCriteria != null
    || card.listInstructions != null
    || (card.completionCriterion === 'EXECUTABLE' && card.acceptanceCommand != null)
    || taskStartFoldsDescription(card);
}

/** Past about this many characters a description no longer fits the three lines it is folded to. */
const DESCRIPTION_FOLD_CHARS = 140;
