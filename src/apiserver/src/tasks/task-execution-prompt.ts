import type { Prisma } from '@prisma/client';
import { branchName } from '../projects/project-criterion-landing';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/**
 * What the brief reads of the task's project: its binding, for how finished work reaches the
 * upstream (§10.5 O-L3). Selected beside the task by every reader that builds or rebuilds the brief,
 * so the three cannot disagree about it.
 */
export const TASK_DELIVERY_SELECT = {
  codebases: {
    where: { slot: 'primary' },
    select: { deliveryMode: true, integrationStartedAt: true, integrationRef: true, remoteName: true },
  },
} satisfies Prisma.ProjectSelect;

/** One binding, as `TASK_DELIVERY_SELECT` reads it. */
interface TaskDeliveryBinding {
  deliveryMode: string;
  integrationStartedAt: Date | null;
  integrationRef: string;
  remoteName: string;
}

/**
 * O-L3 (§10.5): the sentence that tells a run how this project's work reaches its line — always on an
 * AGENT_PUSH project (a MAIN line, so the line's branch is the upstream), and on a PLATFORM one once
 * it has started integrating. Null for everything else: no project or binding, a PLATFORM line not
 * started yet, a codeless task, and a foreman's or a verifier's run, neither of which delivers the
 * work.
 */
function taskDeliverySentence(task: {
  codeless?: boolean | null;
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  project?: { codebases?: readonly TaskDeliveryBinding[] } | null;
}): string | null {
  const binding = task.project?.codebases?.[0];
  if (!binding || task.codeless || task.isForeman === true || task.verifiesTaskId != null) return null;
  const branch = branchName(binding.integrationRef);
  if (binding.deliveryMode === 'AGENT_PUSH') {
    return `This project delivers by pushing to ${branch}. Push your commits to `
      + `${binding.remoteName}/${branch} before you finish — Orbit checks that they are there.`;
  }
  return binding.integrationStartedAt
    ? `Do not push to ${branch}. Orbit lands your branch after your work is accepted.`
    : null;
}

/**
 * The brief a task's run is handed as its opening turn — and what `task-start-card.ts` rebuilds to
 * prove a card says what the run was handed. In a module of its own so that rebuilding it does not
 * import `TasksService`: the turn cards are read inside `SessionsService` (sessions/turn-cards.ts),
 * and a TasksService loaded while SessionsService is still being defined would record an undefined
 * constructor dependency.
 */
export function buildTaskExecutionPrompt(task: {
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  completionCriterion?: TaskCompletionCriterionValue | null;
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  list?: { instructions?: string | null } | null;
  codeless?: boolean | null;
  project?: { codebases?: readonly TaskDeliveryBinding[] } | null;
}): string {
  const systemRun = task.isForeman === true || task.verifiesTaskId != null;
  const instructions = systemRun ? undefined : task.list?.instructions?.trim();
  const delivery = taskDeliverySentence(task);
  // What would PROVE this task done, handed to the run that has to argue it is. It used to be
  // left out, which asked every run to answer "am I finished?" against criteria it had to go and
  // fetch with `task_get` — so a run that did not fetch them answered against the description
  // instead, and the description says what to DO and never what would settle it. Not suppressed
  // for a foreman or a verifier the way the list's instructions are: those describe how the
  // LIST's work is done and neither of those runs is doing it, whereas a task's own acceptance
  // criteria are about that task whoever is running it.
  const acceptance = task.acceptanceCriteria?.trim();
  const executableAcceptance =
    task.acceptanceCommand != null && task.acceptanceExpectedExitCode != null;
  // OWNER_CONFIRMED is settled only by the account owner pressing Confirm done in the app, so a run
  // of such a task has nothing to submit. Handed the evidence envelope like every other task, its
  // runs did as told and filed evidence that criterion never reads — often for a task in no
  // project, with no project_get criterion to copy.
  const ownerConfirmed = task.completionCriterion === 'OWNER_CONFIRMED';
  return (
    `Start the task “${task.title}”.\n\n` +
    (task.description ? `Task description:\n${task.description}\n\n` : '') +
    (acceptance ? `Acceptance criteria (what decides whether this task is done):\n${acceptance}\n\n` : '') +
    (instructions ? `List instructions (the same for every task in this list):\n${instructions}\n\n` : '') +
    // Where the work goes once it is done; a project's instructions that say otherwise give way to it.
    (delivery ? `${delivery}\n\n` : '') +
    // The wiki's dossier cuts the brief at this heading (`TASK_BOILERPLATE` in wiki/wiki-dossier.ts):
    // reworded here, it has to be reworded there too.
    `Follow these steps:\n` +
    `1. First use task_get to read the task in full with its comment history.\n` +
    `2. Do the task.\n` +
    // Where the result goes is said as the platform writes it: the comparison writes task.status and
    // nothing else (runner-api.controller.ts turnComplete, held there by
    // executable-exit-code-judgment.spec.ts at the account owner's direction), so the brief must not
    // promise a comment carrying the output.
    (executableAcceptance
      ? `3. Once this reply ends, Orbit automatically runs the task's one declared EXECUTABLE acceptance command ` +
        `in this run session's workspace (expected exit code ${task.acceptanceExpectedExitCode}): a matching ` +
        `exit code derives DONE, anything else derives FAILED. ` +
        `The raw output and the actual exit code are not written to a task comment; the result is recorded in these ` +
        `places: the derived status is on the task (task_get shows it); the command and its raw output are in this ` +
        `session's record, as one of its Bash calls (to see the output again, rerun the same command in the ` +
        `workspace); on FAILED this session ends failed, its error reading \`acceptance command exited ` +
        `<actual exit code>; expected ${task.acceptanceExpectedExitCode}\` (read this session with session_get; its ` +
        `id is in the environment variable ORBIT_SESSION_ID), and if the task belongs to a project, the project ` +
        `also gets a TASK_FAILED exception recording both exit codes. The acceptance itself writes a task comment ` +
        `only when the command could not return a result to compare (EXECUTABLE_ACCEPTANCE_UNAVAILABLE), and the ` +
        `task's status then stays as it was. ` +
        `Do not write status yourself, and do not ask the coordinator to approve this mechanical verdict.\n`
      : ownerConfirmed
        ? `3. When you are done, first declare with task_request_confirmation (MCP; the CLI is `
          + `\`orbit task request-confirmation\`) that this run has finished the work, then say in a sentence or two `
          + `in this session what you did, and end the turn. `
          + `Only that declaration puts a confirmation card in front of the account owner; without it there is no `
          + `card at all — the task stays OPEN, and only the owner can confirm it, from the task panel. The card `
          + `reaches the owner only when the turn in which this run has really stopped ends (an empty queue, no `
          + `background job in flight, no wake you scheduled yourself). This task's completion criterion is `
          + `OWNER_CONFIRMED: the account owner confirms it in the Orbit app (Confirm done) or sends it back `
          + `(Send back…), and no agent session (the coordinator included) can confirm it for them; the reason for `
          + `a send-back arrives in this session as the next message — when it does, carry on as it says, and `
          + `declare again once you are done again. Do not call task_evidence_submit, and do not write status.\n`
        : `3. When you are done, submit the completion evidence envelope with task_evidence_submit. All four `
          + `fields are required: claim (what you claim to have completed), criterion ({key, text}, copied from the `
          + `acceptance criteria project_get returns), checks (each {kind, ref}, kind one of `
          + `TOOL_CALL / COMMIT / ARTIFACT, ref pointing at a row already recorded under this task's sessions; at `
          + `least one must resolve, or the whole submission is refused), and gaps (what this evidence could not `
          + `establish; an empty array if nothing). A TOOL_CALL may also carry command/succeeded, which the server `
          + `checks byte for byte against the cited tool_call. Do not copy a command's raw output into the evidence `
          + `— Orbit has stored it already; work answered by an exit code alone belongs to EXECUTABLE acceptance, `
          + `not here. Do not use task_comment in place of submitting evidence, and do not write status — DONE is `
          + `the authorization that unlocks downstream tasks, and only evaluating the completionCriterion the task `
          + `declares can produce it; the server refuses a direct DONE from anyone.\n`) +
    `4. If the work failed or could not be finished, first explain why with task_comment, then use task_update ` +
    `to set the status to FAILED. Do not set it to DONE, and do not set it to IN_PROGRESS — downstream treats ` +
    `IN_PROGRESS as an ordinary wait and keeps waiting forever, while only FAILED marks downstream as needing ` +
    `a person to step in.`
  );
}
