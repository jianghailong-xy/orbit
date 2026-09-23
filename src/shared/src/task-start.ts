/** The judgment a task declares — who or what settles it (`TaskCompletionCriterion`). */
export type TaskStartCriterion = 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT' | 'OWNER_CONFIRMED';

/**
 * What the turn that STARTS a task's run carries beside its text.
 *
 * That turn is the brief `buildTaskExecutionPrompt` writes for the agent: the task's description and
 * acceptance criteria, then four steps of protocol — which tools to call, how to report, which
 * statuses never to write. Until this existed a client had nothing to draw it from but those words,
 * and drew all of them as a message the account owner had typed, several screens long, in front of
 * the run's first action.
 *
 * Recorded beside the runner's echo of that turn, and only when the task's fields rebuild the
 * delivered brief exactly, so every field here is what the agent was actually handed — a task edited
 * between the dispatch and the echo gets no card and keeps the bubble, rather than a card describing
 * something the agent never read.
 */
export interface TaskStartCard {
  /** The task, in the uuid spelling every other read of one uses. */
  taskId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  /** Null on a row from before every door required a criterion. */
  completionCriterion: TaskStartCriterion | null;
  /** The EXECUTABLE check, when the task declared one. */
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  /** The list's standing instructions, when the brief carried them. */
  listInstructions: string | null;
  /** The project the task is filed under, if any. */
  project: { id: string; title: string } | null;
  /** Started by one of the automatic doors — a schedule, a prerequisite finishing, a first run — rather than by a request. */
  auto: boolean;
}
