import { createHash } from 'node:crypto';
import { uuidToBase62 } from '@orbit/shared';

/** The title a coordination session is filed under. */
export function coordinatorSessionTitle(projectTitle: string): string {
  // "Coordinator" is a role, rendered as a badge; putting it in the mutable title duplicates
  // metadata and makes the project and its conversation acquire two different names. Both columns
  // are TEXT, so keep the identity exact rather than silently truncating one side.
  return projectTitle;
}

/**
 * The standing instructions for a project's coordination session.
 *
 * This is shared by all three places a coordinator can acquire its role: the opening message of a
 * newly-created coordinator, the `project_create` result that promotes the conversation already
 * in flight, and delivery-time context on its later messages. Keeping one instruction body is what
 * prevents those paths from granting the same database identity but describing different
 * behavioural boundaries.
 *
 * A coordinator is driven by user interaction. The control loop that used to open turns on its
 * own is gone, so this says what the project is, where to read its real state, and which tools are
 * in reach. It also says whether the project's Automatic switch (`coordinatorEnabled`) is on,
 * because the switch still acts: facts are delivered to this conversation as queued turns
 * (`CoordinatorDeliveryService`), auto-run tasks are started for it, and a clean promotion of the
 * project's own branch lands on main without the owner's card (`project-promotion.ts`). Saying
 * nothing about it was read as "the owner decides everything": the sentence about DONE, which
 * meant the project's, was generalised to its tasks, and the coordinator of an Automatic project
 * declared OWNER_CONFIRMED on a mock-up task and waited for the owner (seen 2026-09-29). So with
 * the switch on, the text divides the work — the platform judges EXECUTABLE and VERIFICATION, the
 * coordinator judges EVIDENCE_JUDGMENT, and the owner is needed only for the criteria, advance
 * authorization of launches and irreversible steps, and genuine trade-offs. With it off, the text
 * is the conversational one it was, and in both the DONE sentence names the project. The mode is
 * part of the rendered text and therefore of `buildCoordinatorDeliveryContextKey`, so flipping the
 * switch re-delivers the instructions on the next turn. The authenticated channel is useful
 * provenance, but is not by itself proof that a human rather than a credential holder is present.
 *
 * Unit T6 took two claims out of it. This used to say `project_update` was for the acceptance
 * criteria and for recording `status = DONE`, and both are routed to owner review: the criteria
 * are the exam this project is judged against, and DONE is the statement that its goal was met.
 * The owner-authenticated channel can still write either, while `coordinator-authority.ts`
 * restricts only the one-shot judgment session. That is workflow separation and action-specific
 * traceability, not a hard human-presence boundary, so the opening names both the route and its
 * actual guarantee.
 *
 * It also says what to do with the work a coordinator turns up: file it under this project, or —
 * when it is a body of work of its own — open a project for it. That second half used to be
 * forbidden here: the coordinator's half of the runner-side rule that stopped offering the
 * proposal to a session already inside recorded work (`orbitProjectInstructions`), which the
 * runner cannot apply to a coordinator because its claim carries no project pointer. The
 * boundary lives here, and it moved because what it guarded is handled at the write instead: a
 * session coordinates at most one project, so `createInSession` answers a second one by opening a
 * conversation of its own for it, which knows none of this one. The confirmation card is the
 * owner's answer, and the brief the coordinator writes is all that new conversation inherits —
 * which is what the body now says.
 *
 * It says the start is the owner's, because `task_start` is refused until they press it
 * (`projectAwaitingStart`): a coordinator told only at the refusal has already said it is starting.
 * And it says how to ask for it — `project_request_start`, once every criterion has a task serving
 * it — because the owner's "Start this project?" card appears only once the coordinator has asked.
 *
 * The paragraph asking for a `modelHint` on every task is there only while the project owner has
 * smart model selection on (`modelRouting`, common/model-routing-switch.ts): off, the feature is
 * as if it did not exist. Like the Automatic switch it is part of the rendered text, and so of the
 * delivery context key — every reader passes the same owner's switch, so turning it on or off
 * re-delivers the instructions on the coordinator's next turn, and an opening rendered under the
 * other value is not current (`coordinatorOpeningIsCurrent`). Absent is off.
 */
function renderCoordinatorInstructions(
  projectIdentity: string,
  coordinatorEnabled: boolean,
  modelRouting: boolean,
): string {
  return (
    `You coordinate ${projectIdentity}: this is its coordinator session.\n\n`
    + 'This session is for following the project’s progress and coordinating its tasks, not for doing their work '
    + 'yourself — the implementation is left to each task’s own session.\n\n'
    + 'Read first: use project_get to read this project’s goal, acceptance criteria and instructions, then task_list '
    + '(projectId: the id above) to see where each of its tasks stands. Neither is in any task’s description, and without '
    + 'reading them you can only guess. Once you have read them, start with a short report of where things stand.\n\n'
    + (coordinatorEnabled
      ? 'This project has Automatic on: the account owner has authorized it to move forward by itself. Tasks set to '
        + 'auto-run are started by Orbit itself; when the project has an integration branch of its own, work on that '
        + 'branch whose checks all pass and that has no conflict is merged into main by the platform itself; anything '
        + 'on a task that needs you is delivered to this session as a message. Moving forward rests on your own '
        + 'judgment, not on asking the account owner one question at a time — which kinds of matter do need the account '
        + 'owner is written below.\n\n'
      : 'Progress comes from talking with people: say clearly where things stand, ask what needs asking, agree on the '
        + 'next step, then act. No automatic loop decides for you when to act.\n\n')
    + 'When it is time to act, you have tools: project_update changes this project’s title, goal and instructions; '
    + 'task_create, task_update and task_start manage its tasks.\n\n'
    + (modelRouting
      ? 'Give every task you create a modelHint (S/M/L/XL) and a one-sentence modelHintReason, and when you see a task '
        + 'in the project without one, add it with task_update. '
        + 'S: mechanical edits, copy changes, version upgrades (Sonnet · low); M: a well-specified feature or fix '
        + '(Sonnet · medium); L: unknown root cause, concurrency, cross-module work, migrations, or core paths such as '
        + 'dispatch (Opus · high); XL: architecture design, long unattended work, or repeated failures at L (Opus · max). '
        + 'The Codex engine maps these to low/medium/high/xhigh on its same default model. The reason states what the '
        + 'judgment rests on, in at most 500 characters. '
        + 'modelHint is a difficulty suggestion that can move up a tier after a failure; model is a hard pin and takes '
        + 'precedence over the suggestion. The engine is set with the engine field; provider only decides which '
        + 'credential is used (a sign-in, an account pool or a key), and must be one that engine can use.\n\n'
      : '')
    + 'Until the project has started, task_start is refused: tasks can be created ahead of time, but do not look for a '
    + 'way around it. The account owner presses start, and you ask for it: once the plan is written and every acceptance '
    + 'criterion has a task serving it (task_create with criterionKey), request the start with project_request_start, '
    + 'attaching the start settings you recommend and a one-sentence reason. '
    + 'Orbit runs a ready check first: if it fails, it says why, reason by reason, and records nothing; only if it passes '
    + 'does a start card appear in front of the account owner. '
    + 'Wait until Orbit tells you the project has started before starting tasks.\n\n'
    + 'For new work that turns up in this session, first ask whether it is part of this project: if it is, record it as '
    + 'a task under this project; if it really is a separate undertaking, you may open a new project — project_create '
    + 'first puts a confirmation card in front of the account owner at the screen, and the project is created only if '
    + 'they agree. Know this before you open one: a session coordinates only one project, so the new project will not '
    + 'be attached to this session; the server opens a coordinator session of its own for it in the same workspace, '
    + 'and says so in the result. That session knows nothing of the background here: the goal, acceptance criteria and '
    + 'instructions you write are everything it starts from — write them so they stand on their own, and if you cannot, '
    + 'do not open it yet.\n\n'
    + 'Two things are not yours to decide: changing this project’s acceptance criteria, and recording this project as DONE. '
    + 'The acceptance criteria are the ruler this project’s completion is judged by, and whoever changes the ruler can '
    + 'make any conclusion true; '
    + 'the project’s DONE is the statement “the goal was reached” itself, and if it is wrong, nothing downstream asks again. '
    + 'Both are recorded through the account owner’s channel — say clearly what should change and what is still missing, '
    + 'and let the account owner at the screen decide. '
    + 'HUMAN_ONLY here means role separation and a trail per action, not a cryptographic proof by the server that a real '
    + 'person is present. '
    + 'The DONE meant here is the project’s own, not that of any of its tasks: whether a task is done goes by the '
    + 'completion criterion it declared.\n\n'
    + (coordinatorEnabled
      ? 'This project has Automatic on, so whether a task is done is yours to judge, not something the account owner '
        + 'confirms card by card: the platform judges EXECUTABLE and VERIFICATION by itself; for EVIDENCE_JUDGMENT you '
        + 'read the evidence and decide CONFIRM or SEND_BACK with task_evidence_decide, and a SEND_BACK says what the '
        + 'next revision has to prove. Do not declare OWNER_CONFIRMED on a task unless the project criterion it serves '
        + 'itself says the account owner confirms it (its verificationMethod starts with OWNER_CONFIRMED).\n\n'
        + 'Once a task under this project is DONE, the platform lands it on the project’s integration line; when a '
        + 'landing’s check fails, times out or errors, an integration open item is delivered here. By then the task '
        + 'itself is finished, and task_start does not queue the landing again: when you are sure a rerun will come out '
        + 'differently (the baseline was repaired, the check timed out, the integration machinery failed), queue it once '
        + 'more with integration_retry and a reason; a problem in the delivery itself is sent back for rework with '
        + 'task_reopen; when a separate code fix is needed, use task_create and attach it to the open item with '
        + 'fixesOpenItemId; do not use a task that has already ended as the place for a new fix. '
        + 'A delivery that changed files its declaration did not mention, or that git refused to merge, is also delivered '
        + 'here, as a delivery-review open item: compare the task’s declaration, the criterion it serves and the actual '
        + 'changes, then accept it (open_item_resolve, with your reason), send it back (task_reopen), or supersede it '
        + '(cancel it, then task_create with supersedesTaskId). '
        + 'Whether such a landing goes ahead is yours to judge, not a question for the account owner; the platform reruns '
        + 'nothing by itself. Once you take up an open item it stays yours, '
        + 'and the platform does not hand it to the account owner because time ran out; only when this session has not '
        + 'taken it up (it is stuck, down or ended) for longer than the project’s exceptionEscalationSeconds does it go '
        + 'to the account owner. After a fix task attached to an open item lands, the platform delivers the item again, '
        + 'for you to check whether the original task’s work is live and then close it (open_item_resolve) or requeue '
        + 'it (integration_retry). '
        + 'When the check on merging the project branch into main is red (that open item has no task), '
        + 'use integration_retry the same way, passing promotionId to rerun that candidate’s check; the merge itself is '
        + 'still confirmed by the account owner or the Automatic setting. '
        + 'For a code problem, file a fix task with fixesOpenItemId set to that open item; use integration_retry only for '
        + 'an environment or one-off problem. '
        + 'When the merge-check command or its time limit has to change, or there is another trade-off only the account '
        + 'owner can decide, ask with ask_owner, giving at least two options and the reason in the recommended one; anything that '
        + 'needs the account owner’s decision while you handle an item is asked with ask_owner too, and the item stays '
        + 'with you. '
        + 'Only what the account owner must handle in person (their device, account or keys) is handed to the account '
        + 'owner with open_item_hand_over, with an explanation. '
        + 'After a requeue or rerun the item shows as being handled, and only when the result is in is it marked handled '
        + '(HANDLED) or superseded by a new failure.\n\n'
        + 'Only three kinds of matter need the account owner: changing or confirming the acceptance criteria; authorizing '
        + 'a launch or an irreversible step in advance; and a trade-off that truly needs the account owner’s decision. '
        + 'Send each decision as a question with ask_owner, each with the default you recommend; where you can move '
        + 'forward on the default, move forward on it rather than stopping to wait.\n\n'
      : '')
    + 'Do not go looking for tools you were not given: listing or deleting projects, opening another coordinator '
    + 'session and directing a runner directly are not in your hands.'
  );
}

export function buildCoordinatorInstructions(
  title: string,
  projectId: string,
  coordinatorEnabled: boolean,
  modelRouting = false,
): string {
  return renderCoordinatorInstructions(
    `project “${title}” (id: ${uuidToBase62(projectId)})`,
    coordinatorEnabled,
    modelRouting,
  );
}

/**
 * What a session is told when the project it just recorded is coordinated by a DIFFERENT
 * conversation.
 *
 * A session coordinates at most one project, so a session that already has one cannot be promoted
 * again. Recording the project anyway and leaving it coordinated by nobody is what used to happen
 * — the caller was refused, dropped the session header, and retried — so `createInSession` now
 * opens the new project its own conversation, in this same workspace.
 *
 * It travels under the same key as the promotion, deliberately: both answer "what did recording
 * this project do to MY role", and a caller shown nothing would read the promotion's absence as
 * the promotion.
 */
export function buildDelegatedCoordinatorNotice(
  title: string,
  projectId: string,
  coordinatorSessionId: string,
): string {
  return (
    `Project “${title}” (id: ${uuidToBase62(projectId)}) is recorded, but you are not its coordinator session.\n\n`
    + 'You already coordinate another project, and a session coordinates only one project — so a coordinator session '
    + `of its own has been opened for it in the same workspace (session id: ${uuidToBase62(coordinatorSessionId)}), and `
    + 'the project points to that session from now on.\n\n'
    + 'Your own role has not changed: the project in your hands is still the one you had. To follow the new project, go '
    + 'to that session; reading its state here with project_get / task_list is fine too, but do not make coordination '
    + 'decisions for it in this session.'
  );
}

/** The repeatable delivery form carries only server-derived identity, never agent-written title. */
export function buildCoordinatorDeliveryInstructions(
  projectId: string,
  coordinatorEnabled: boolean,
  modelRouting = false,
): string {
  return renderCoordinatorInstructions(`the project (id: ${uuidToBase62(projectId)})`, coordinatorEnabled, modelRouting);
}

/**
 * Identity of one coordinator context inside one live engine context.
 *
 * Binding the exact rendered instructions means an instruction edit automatically invalidates an
 * old acknowledgement — and so does flipping the project's Automatic switch or its owner's smart
 * model selection, since the text depends on both. The lease generation invalidates it on process
 * restart, and the durable compaction event seq invalidates it when the provider drops history
 * without restarting.
 */
export function buildCoordinatorDeliveryContextKey(
  projectId: string,
  leaseGeneration: string,
  contextEpoch: number,
  coordinatorEnabled: boolean,
  modelRouting = false,
): string {
  return createHash('sha256')
    .update([
      'orbit-project-coordinator-context-v1',
      projectId,
      leaseGeneration,
      String(contextEpoch),
      buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled, modelRouting),
    ].join('\0'))
    .digest('hex');
}

/** The first user message for a coordinator created from the project page. */
export function buildCoordinatorOpening(
  title: string,
  projectId: string,
  coordinatorEnabled: boolean,
  modelRouting = false,
): string {
  return buildCoordinatorInstructions(title, projectId, coordinatorEnabled, modelRouting);
}

/**
 * The identity sentence of an opening written before the copy was English (2026-10), with the
 * project id it names. Those openings are still the prompts of the coordinators created then.
 */
const CHINESE_OPENING_IDENTITY = /（id: ([0-9A-Za-z]+)）的协调会话。/g;

/** Whether the immutable project id shows that this session already opened as its coordinator. */
export function hasCoordinatorOpening(prompt: string, projectId: string): boolean {
  // Match the stable identity sentence rather than the whole prompt: project titles can change,
  // and tightening the instructions later must not make every dedicated coordinator receive two
  // copies. An arbitrary session that already contains this exact marker is already role-aware.
  const id = uuidToBase62(projectId);
  return prompt.includes(`(id: ${id}): this is its coordinator session.`)
    || [...prompt.matchAll(CHINESE_OPENING_IDENTITY)].some((match) => match[1] === id);
}

/**
 * Whether a dedicated coordinator's opening still says what delivery would say now.
 *
 * The opening is rendered once, when the session is created, and on the initial turn it stands in
 * for the delivery block that the turn's context key says was delivered. That holds only while its
 * body — everything after the identity line, the one part a title changes — is the current
 * rendering: an opening written before the Automatic switch or the owner's smart model selection
 * flipped is not that context.
 */
export function coordinatorOpeningIsCurrent(
  prompt: string,
  projectId: string,
  coordinatorEnabled: boolean,
  modelRouting = false,
): boolean {
  const delivered = buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled, modelRouting);
  return (
    hasCoordinatorOpening(prompt, projectId)
    && prompt.includes(delivered.slice(delivered.indexOf('\n\n')))
  );
}

/** Append the canonical delivery block without making assumptions about how the role was gained. */
export function wrapCoordinatorDeliveryContext(
  content: string | undefined,
  projectId: string,
  coordinatorEnabled: boolean,
  modelRouting = false,
): string {
  const coordinatorInstructions = buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled, modelRouting);
  // This deliberately remains user-level context, matching the project-page opening. Project
  // title is agent-writable data and must never be promoted into a system/developer instruction.
  return (
    `${content ?? ''}\n\n<orbit_project_coordinator_context>\n${coordinatorInstructions}\n`
    + '</orbit_project_coordinator_context>'
  );
}

/** Add delivery-time role context to a promoted coordinator's next user/steer message. */
export function appendCoordinatorDeliveryContext(
  content: string | undefined,
  sessionPrompt: string,
  titleBeforeProjectManagement: string | null | undefined,
  project: { id: string; coordinatorEnabled: boolean } | null | undefined,
  modelRouting = false,
): string | undefined {
  if (
    !project
    || (titleBeforeProjectManagement == null && hasCoordinatorOpening(sessionPrompt, project.id))
  ) {
    return content;
  }
  // This deliberately remains user-level context, matching the project-page opening. Project
  // title is agent-writable data and must never be promoted into a system/developer instruction.
  // The stored ConversationTurn remains exactly what the person typed; this expansion is the same
  // delivery-time pattern used for #references and pending list events.
  return wrapCoordinatorDeliveryContext(content, project.id, project.coordinatorEnabled, modelRouting);
}
