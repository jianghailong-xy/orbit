import { useId, useState, type JSX, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal } from 'antd';
import type {
  CoordinatorFuseUsage,
  CoordinatorWakeups,
  IntegrationCheckResult,
  OpenItemAction,
  OpenItemFacts,
  OpenItemKind,
  ProjectOpenItemRow,
  ProjectOpenItemsView,
} from '@orbit/shared';
import { api } from '../api';
import { stripAnsi } from '../lib/ansi';
import { checkDuration } from '../lib/checkDuration';
import { encodeId } from '../lib/idCodec';
import { projectOpenItemsQuery } from '../lib/queries';
import { newRunRequestToken, runRequestResend } from '../lib/runRequestToken';
import { refreshTaskScheduleViews } from '../lib/taskSchedule';
import { readTaskRunConflict } from '../lib/taskRunHandoff';
import { ago, formatSpan } from '../lib/watches';
import { TaskRunHandoffNotice } from './TaskRunHandoffNotice';

/**
 * What a project still owes somebody, and what its coordinator has left to spend
 * (`docs/project-integration-line-contract.md` §7.2 V5 / V7, §7.5; mocks 2 ②③, 5 and 6 ①).
 *
 * WHY THE PAGE NEEDED THIS AT ALL. A project that had stopped moving said so nowhere. The work
 * overview counted tasks, the coordinator card said "Idle", and the reason — a merge conflict
 * nobody had picked up, a question waiting on the owner, a fuse that had paused the conversation
 * two hours ago — lived in rows no page read. So "why is this not moving" could only be answered by
 * asking the coordinator, which is how 54 coordinator conversations came to be driven by hand.
 * Every row here is one of those rows, with the two facts that make it actionable: WHO has it, and
 * HOW LONG they have had it.
 *
 * TWO SHAPES, ONE READ. The project page wants a list — the owner is catching up on a project and
 * needs the whole of it, oldest first. The coordinator's own conversation wants cards — it is a
 * transcript, and a card is how everything else the platform files there is drawn. Both are this
 * module against `GET /projects/:id/open-items`, so what the two say cannot drift: one component
 * renders an item, and the hosts decide whether it is a row or a card.
 *
 * WHAT IS DRAWN IS WHAT THE SERVER SERVES. `detailLine` is the server's own sentence about the
 * fact that opened the item, `actions` is the set of presses that have a door on the other side
 * today (§4.8), and `facts` is the item's own payload read into fields — the files a merge
 * conflicted on, the check that disagreed, the branch it left alone. None of the three is
 * re-derived here: a card that composed its own sentence from a payload would be a second rendering
 * of one fact, free to disagree with the row beside it, and a button this file invented would be
 * one the reader presses to no effect. The fact block (§7.5) is not a second rendering either:
 * every VALUE in it is a field of that reading, and every WORD around those values — the labels,
 * and the sentences a value is read in — is this file's copy, taken from mock 5.
 *
 * ONE PRESS IS NOT ON THAT LIST, and it is named rather than left to be noticed: "Mark as handled",
 * the owner's ending for an exception they dealt with themselves (§4.7). Its door is real —
 * `POST /projects/:id/open-items/:itemId/resolve` — and it landed without adding itself to the
 * server's `actions`, so a project whose work was landed by hand carried items no press could
 * answer. It is drawn from the item's KIND, which is the same fact the service's own door decides
 * on, and it is drawn only where the owner is the one who has it — see `HAND_CLOSABLE_KINDS`.
 */

/** §7.5's mark: Orbit filed this, an agent turn did not write it. The wording the criteria and
 *  question cards already carry, so the three read as one family. */
export const FROM_ORBIT = 'FROM ORBIT';
export const FROM_ORBIT_TITLE =
  'Orbit filed this from the fact that opened it. It is not something an agent turn wrote into this page.';

export const OPEN_ITEMS_HEADING = 'Open items';
export const NEEDS_YOU_GROUP = 'Needs you';
export const WITH_COORDINATOR_GROUP = 'With the coordinator';

/**
 * What each exception card is called, by kind (§7.5, from mock 5).
 *
 * The kind's own line and nothing else: WHAT the item is about — the task, the branch, the check —
 * is a row of the fact block below it, so the two never arrive as one run-on sentence about both.
 * This is the card's copy rather than the item's `title`, which is the server's one-line name for
 * the item and what the Open items ROW shows (§7.2 V5).
 */
const ITEM_HEADING: Partial<Record<OpenItemKind, string>> = {
  INTEGRATION_CONFLICT: 'Merge conflict — needs a fix on the task branch',
  INTEGRATION_CHECK_FAILED: 'Checks failed on the combined tree',
  INTEGRATION_ERROR: 'Integration error',
  TASK_FAILED: 'Task failed',
};

/** The two words each group's rows use for who has the item. */
const WHO = { OWNER: 'You', COORDINATOR: 'Coordinator' } as const;

/**
 * §7.5's heading for an item that BECAME the owner's, one per way it happened.
 *
 * Each says the thing the owner has to know before deciding anything: nobody acted, the
 * conversation that had it is over, the chain ran out of attempts, or somebody put it here on
 * purpose. `DEFAULT` is absent because an item assigned to the owner from the start — a question,
 * a merge approval, a pause — is not an escalation and says so in its own title.
 */
function escalationHeading(row: ProjectOpenItemRow, now: number): string | null {
  switch (row.assigneeReason) {
    case 'ESCALATED':
      return `Now yours — no one acted on this for ${waitedBeforeEscalation(row)}`;
    case 'COORDINATOR_ENDED':
      return 'Now yours — the coordinator conversation ended';
    case 'CHAIN_LIMIT':
      return 'Now yours — the 3rd failure in this chain';
    case 'HANDED_OVER':
      return 'Now yours — the coordinator handed it over';
    case 'NO_COORDINATOR':
      return `Now yours — this project has no coordinator (waiting ${formatSpan(waitedMs(row, now))})`;
    default:
      return null;
  }
}

function waitedMs(row: Pick<ProjectOpenItemRow, 'waitingSince'>, now: number): number {
  return now - Date.parse(row.waitingSince);
}

/** How long the coordinator had it before the clock took it away — the window the project set, read
 *  off the two instants rather than off the setting, so a window that was changed afterwards cannot
 *  make this sentence lie about what happened. */
function waitedBeforeEscalation(row: ProjectOpenItemRow): string {
  if (row.escalatedAt == null) return 'a while';
  return formatSpan(Date.parse(row.escalatedAt) - Date.parse(row.waitingSince));
}

/**
 * The time under an item, in the words its group uses (§7.2 V5).
 *
 * The coordinator's items are the ones with two numbers on them, and both matter: how long it has
 * had it, and how long before it stops being its problem. The owner's items have one — except an
 * escalated one, where WHEN it arrived is what the reader is orienting by.
 */
export function waitingLabel(row: ProjectOpenItemRow, now: number): string {
  const waited = formatSpan(waitedMs(row, now));
  if (row.assignee === 'COORDINATOR') {
    if (row.escalateAt == null) return `waiting ${waited}`;
    const left = Date.parse(row.escalateAt) - now;
    return left > 0 ? `${waited} · goes to you in ${formatSpan(left)}` : `${waited} · due to come to you`;
  }
  if (row.escalatedAt != null) return `escalated ${ago(row.escalatedAt, now)}`;
  return `waiting ${waited}`;
}

/** §7.5's footer: who has it, how long, and when it stops being theirs. */
export function ownerLine(row: ProjectOpenItemRow, now: number): string {
  const waited = `waiting ${formatSpan(waitedMs(row, now))}`;
  if (row.assignee === 'OWNER') {
    // An item a clock already moved says WHEN it moved, in the words the coordinator's own footer
    // uses for the same instant — it is the fact the escalation heading above it is about, and
    // without it the line said only that the item had been waiting, which the heading already said.
    return row.escalatedAt == null
      ? `Owner: you · ${waited}`
      : `Owner: you · ${waited} · came to the owner at ${waitedBeforeEscalation(row)}`;
  }
  const left = row.escalateAt == null ? null : Date.parse(row.escalateAt) - now;
  return left != null && left > 0
    ? `Owner: coordinator · ${waited} · goes to the owner in ${formatSpan(left)}`
    : `Owner: coordinator · ${waited}`;
}

/** The label each door wears. A row draws the ways in; a card draws those AND the three that write.
 *  An action this map has no label for is not drawn at all, which is what stops a name the server
 *  has not listed from becoming a press nobody can answer. */
const ACTION_LABEL: Partial<Record<OpenItemAction, string>> = {
  REVIEW: 'Review',
  ANSWER: 'Answer',
  RESUME: 'Resume',
  OPEN_COORDINATOR: 'Open coordinator',
  OPEN_TASK_SESSION: 'Open task session',
  RETRY: 'Retry',
  CANCEL_TASK: 'Cancel task',
  ASK_COORDINATOR_AGAIN: 'Ask the coordinator again',
};

/** The presses that WRITE, and the only ones. Two things turn on the same answer: that a card draws
 *  them only where this row carries what they would need, and that a ROW leaves them out — a row is
 *  a way in (§7.2 V5), and the one press it offers is a reading door.
 *
 *  It is NOT what decides a card's weights any more (mock 7): a card leads with the next step for its
 *  KIND, and for a conflict that step is `Open task session` — a door that writes nothing. */
const WRITE_ACTIONS: ReadonlySet<OpenItemAction> = new Set<OpenItemAction>([
  'RETRY',
  'CANCEL_TASK',
  'ASK_COORDINATOR_AGAIN',
]);

/** Whether this row carries what a writing press would need, in the same shape `actionHref` answers
 *  for the links: the two task presses act on the task the item is about, and the third is about
 *  the item itself, which every row carries. */
function writeTarget(row: ProjectOpenItemRow, action: OpenItemAction): string | null {
  return action === 'ASK_COORDINATOR_AGAIN' ? row.itemId : row.taskId;
}

/** Where a press goes, or null when this row does not carry the address it would need. */
function actionHref(row: ProjectOpenItemRow, action: OpenItemAction): string | null {
  switch (action) {
    case 'REVIEW':
      // The merge card, mounted beside this list by both hosts — the same anchor the question's
      // press uses, and for the same reason: one merge, confirmed in one place (§7.5).
      return row.promotionId ? `#promotion-${row.promotionId}` : null;
    case 'ANSWER':
      // The question's own card, already on this page and in the coordinator's conversation. An
      // anchor rather than a second copy of the card: one question, answered in one place.
      return `#question-${row.itemId}`;
    case 'OPEN_COORDINATOR':
      return row.delivery.sessionId
        ? `/sessions/${encodeURIComponent(encodeId(row.delivery.sessionId))}`
        : null;
    case 'OPEN_TASK_SESSION':
      return row.sessionId
        ? `/sessions/${encodeURIComponent(encodeId(row.sessionId))}`
        : row.taskId
          ? `/tasks/${encodeURIComponent(encodeId(row.taskId))}`
          : null;
    default:
      return null;
  }
}

/** The presses a ROW offers: the server's own list, minus the ones that write, in its order. */
function drawableActions(row: ProjectOpenItemRow): OpenItemAction[] {
  return row.actions.filter(
    (action) =>
      ACTION_LABEL[action] != null
      && !WRITE_ACTIONS.has(action)
      && (action === 'RESUME' || actionHref(row, action) != null),
  );
}

/** The presses a CARD offers: the same list, with the writing presses drawn as the buttons they
 *  are — each one only where this row carries what it would need. Never more than the server
 *  listed, so a card cannot come to offer something no door answers. */
function cardActions(row: ProjectOpenItemRow): OpenItemAction[] {
  return row.actions.filter(
    (action) =>
      ACTION_LABEL[action] != null
      && (WRITE_ACTIONS.has(action)
        ? writeTarget(row, action) != null
        : action === 'RESUME' || actionHref(row, action) != null),
  );
}

/** The doors a card may LEAD with: go onto the work, run the task again, hand the item back. The
 *  rest of an item's list is a way to LOOK (`Open coordinator`) or to STOP (`Cancel task`), which
 *  the mock demotes to text links — both are still there, they just no longer compete with the press
 *  the card is asking for (mock 7's rule 2). */
const LEADING_ACTIONS: ReadonlySet<OpenItemAction> = new Set<OpenItemAction>([
  'OPEN_TASK_SESSION',
  'RETRY',
  'ASK_COORDINATOR_AGAIN',
]);

/** What the next step is for a kind of exception, where the design names one (mock 7 ①②③).
 *
 *  A conflict and a failed combined-tree check both want the branch fixed, so the way onto that
 *  branch leads and a whole new run is the way to take the same step differently. A task that failed
 *  wants another run, so `Retry` leads and the run is the alternative. A kind this map has no answer
 *  for — an integration error, which the mock does not draw — keeps the server's own order rather
 *  than being handed a step nobody asked for. */
const KIND_NEXT_STEP: Partial<Record<OpenItemKind, OpenItemAction>> = {
  INTEGRATION_CONFLICT: 'OPEN_TASK_SESSION',
  INTEGRATION_CHECK_FAILED: 'OPEN_TASK_SESSION',
  TASK_FAILED: 'RETRY',
};

/** The presses a card leads with, in the order it draws them: the step this kind of exception is
 *  asking for, then the same step taken another way.
 *
 *  Both come from the server's own list, so a card never offers a door that is not there: a kind
 *  whose next step the server does not list leads with whatever the server put first, and a card
 *  whose pair is missing a door draws the one it has. */
function leadingDoors(row: ProjectOpenItemRow, actions: OpenItemAction[]): OpenItemAction[] {
  const leading = actions.filter((action) => LEADING_ACTIONS.has(action));
  // An item that has become the owner's leads with the way back to the coordinator that should have
  // had it (§4.7): the work is not the owner's to run again, and the server lists no RETRY for one.
  const next = row.assignee === 'OWNER' ? 'ASK_COORDINATOR_AGAIN' : KIND_NEXT_STEP[row.kind];
  if (next == null || !leading.includes(next)) return leading;
  return [next, ...leading.filter((action) => action !== next)];
}

function ItemLink({
  row,
  action,
  primary,
  quiet,
}: {
  row: ProjectOpenItemRow;
  action: OpenItemAction;
  /** The press the reader is expected to make. Only the owner's own rows have one: what the
   *  coordinator is handling is offered to be looked at, not to be acted on. */
  primary?: boolean;
  /** The CARD's quiet weight for the doors it is not asking for (mock 7, 方案 B): a text link rather
   *  than the boxed way-in a row draws, so the press beside it is what the eye lands on. */
  quiet?: boolean;
}): JSX.Element {
  const href = actionHref(row, action) ?? '#';
  const label = ACTION_LABEL[action] ?? action;
  const className = quiet
    ? 'project-open-item-quiet'
    : `project-open-item-action${primary ? ' is-primary' : ''}`;
  // An in-page anchor is an anchor; a route is a Link, so it does not reload the app.
  return href.startsWith('#') ? (
    <a className={className} href={href}>
      {label}
    </a>
  ) : (
    <Link className={className} to={href}>
      {label}
    </Link>
  );
}

/** `POST /projects/:id/fuse/:episodeId/resume` — the owner's alone (§6.3 F-T4). An empty body
 *  resumes without raising anything, which is what the plain press means. */
function resumeFuse(projectId: string, episodeId: string): Promise<unknown> {
  return api(
    `/projects/${encodeURIComponent(projectId)}/fuse/${encodeURIComponent(episodeId)}/resume`,
    { method: 'POST', body: {} },
  );
}

/**
 * The pause card (mock 6 ①): why the coordinator stopped, what it cost, what is still running
 * without it, and the one press that starts it again.
 *
 * Its own component because it is the one card here with a WRITE behind it. Everything the reader
 * needs to weigh the resume is in the server's sentence — the pause writes its own `detailLine`
 * rather than borrowing the failure wording, for exactly that reason (§6.2).
 */
export function FusePauseCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => resumeFuse(projectId, row.fuseEpisodeId!),
    // Resumed or refused, the items are re-read: the card goes when the episode closes, and a
    // second pause — a new episode, never this row again (§6.2) — arrives as its own card.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  return (
    <ItemCard row={row} heading={row.title} tone="owner" now={now} id={`fuse-${row.itemId}`}>
      <Button
        type="primary"
        size="small"
        loading={resume.isPending}
        disabled={row.fuseEpisodeId == null}
        onClick={() => resume.mutate()}
      >
        Resume
      </Button>
      {resume.isError ? (
        <Alert
          type="error"
          showIcon
          className="project-open-item-error"
          message="The coordinator was not resumed"
          description={(resume.error as Error).message}
        />
      ) : null}
    </ItemCard>
  );
}

/**
 * What a write made from a card makes stale.
 *
 * The item list it was drawn from, always — that is the card's own read. And for the two presses
 * that act on a task, every view of that task through the boundary every other Run press uses
 * (`refreshTaskScheduleViews`), which an accepted run makes stale whether or not this card is the
 * thing that started it: a run consumes the task's one-shot `runAt` and moves its status.
 */
function refreshItemWriteViews(qc: QueryClient, projectId: string, taskId?: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey }),
    qc.invalidateQueries({ queryKey: ['project', projectId] }),
    ...(taskId ? [refreshTaskScheduleViews(qc, taskId, projectId)] : []),
  ]).then(() => undefined);
}

/**
 * Retry: start the failed task again, through the same door every other Run press in this app
 * sends (`POST /tasks/:id/execute`, with the press's own `triggerId` so a resend of it is one run
 * rather than a second).
 *
 * Nothing here writes the ITEM: the server clears the task's FAILED as the run is dispatched and
 * answers the failure on the same fact, so the card closes because the task moved (§4.2). A
 * refusal — a run already working on this task, a replaced attempt — is drawn where the press was
 * made, in the notice the rest of the app uses for it, which is also the way into that run.
 */
export function retryTaskMutationOptions(qc: QueryClient, projectId: string, taskId: string) {
  return {
    // A press whose ANSWER was lost is resent under the same name; a new press draws a new one.
    ...runRequestResend,
    mutationFn: ({ triggerId }: { triggerId: string }) =>
      api(`/tasks/${encodeURIComponent(taskId)}/execute`, { method: 'POST', body: { triggerId } }),
    onSuccess: () => refreshItemWriteViews(qc, projectId, taskId),
  };
}

/**
 * Cancel task: the attempt stops here and the exceptions it opened close with it (§4.2:
 * `TASK_CLOSED`). No run is stopped by it — a task with a live run is a task that is not FAILED —
 * so the press is about the record, and its confirm says exactly that.
 */
export function cancelTaskMutationOptions(qc: QueryClient, projectId: string, taskId: string) {
  return {
    mutationFn: () =>
      api(`/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
      }),
    onSuccess: () => refreshItemWriteViews(qc, projectId, taskId),
  };
}

/**
 * Ask the coordinator again: an escalated item goes back to the conversation that coordinates the
 * project, with the clock the project set for it restarted (§4.7).
 *
 * Nothing is retried and nothing ends here — what the coordinator does about it is the
 * coordinator's, which is the whole reason the press exists rather than a second Retry. The server
 * refuses it when there is no live coordinator conversation to hand it to.
 */
export function askCoordinatorAgainMutationOptions(
  qc: QueryClient,
  projectId: string,
  itemId: string,
) {
  return {
    mutationFn: () =>
      api(
        `/projects/${encodeURIComponent(projectId)}/open-items/${encodeURIComponent(itemId)}`
        + '/return-to-coordinator',
        { method: 'POST', body: {} },
      ),
    onSuccess: () => refreshItemWriteViews(qc, projectId),
  };
}

/**
 * Mark as handled: the owner ends an exception they dealt with themselves (§4.7's "标记已处理").
 *
 * The ending every other press on this card leaves to a fact — a task that moved on, a landing that
 * happened — is the one a person sometimes has and the platform never will: work landed by hand
 * leaves no row to read, and the item goes on saying "this did not land" until somebody says
 * otherwise. The reason travels in the body because it is required (`ResolveOpenItemDto`: a note of
 * at least one character, trimmed and checked again in the service), and it is the whole of what the
 * record gains. Nothing is retried and nothing is reopened.
 *
 * The items are re-read rather than patched: which rows this project still owes somebody is the
 * server's answer, and the same re-read moves the project's own counts.
 */
export function markItemHandledMutationOptions(qc: QueryClient, projectId: string, itemId: string) {
  return {
    mutationFn: (note: string) =>
      api(
        `/projects/${encodeURIComponent(projectId)}/open-items/${encodeURIComponent(itemId)}/resolve`,
        { method: 'POST', body: { note } },
      ),
    onSuccess: () => refreshItemWriteViews(qc, projectId),
  };
}

export const CANCEL_TASK_MODAL_TITLE = 'Cancel this task?';
export const CANCEL_TASK_MODAL_OK = 'Cancel task';
/** What the confirm says, in the two facts a reader weighing it needs: what it stops, and what it
 *  does not touch. A cancelled task is a record, not a deletion — its branch, its history and its
 *  page stay, and reopening it later is the same press that reopens any other stopped attempt. */
export const CANCEL_TASK_MODAL_BODY =
  'It is recorded as cancelled: no further run starts on it, and the failed-attempt notices it '
  + 'opened close with it. Its branch and history stay where they are.';

/** The label the press wears and its dialog's confirm repeats, as the cancel press does. */
export const MARK_HANDLED = 'Mark as handled';
export const MARK_HANDLED_MODAL_TITLE = 'Mark this item as handled?';
/** What the confirm says, in the two facts a reader weighing it needs: what it ends, and what it
 *  does not touch. Nothing read this ending off a row — that is the whole reason the press exists —
 *  so the reason is what the record gains. */
export const MARK_HANDLED_MODAL_BODY =
  'It stops being something this project owes anyone. The reason is what the record gains, because '
  + 'nothing on the line could verify the ending for itself — the task, its branch and its history '
  + 'stay where they are.';

/**
 * The kinds an owner closes by hand (§4.7's "标记已处理"): the exceptions, which are the ones a person
 * sometimes answers in a way the platform cannot read. A question is the owner's to ANSWER rather
 * than to close, and a merge approval and a paused project each have a press of their own — the
 * server's own door refuses all three (`HAND_CLOSABLE_RESOLUTIONS`, which names the same set).
 */
const HAND_CLOSABLE_KINDS: ReadonlySet<OpenItemKind> = new Set<OpenItemKind>([
  'INTEGRATION_CONFLICT',
  'INTEGRATION_CHECK_FAILED',
  'INTEGRATION_ERROR',
  'TASK_FAILED',
]);

/**
 * The three weights a card's presses are drawn in (mock 7, 方案 B): the press this kind of exception
 * is asking for, the other way to take that step, and — for the two doors that only LOOK or only
 * STOP — a quiet text link. A link is a weight and not an element: the presses drawn in it are the
 * link-flavoured button, so an ending the eye is meant to pass over is still one a keyboard reaches.
 */
type PressTier = 'primary' | 'secondary' | 'link';

/** One press, one button — in the weight the card gave it. */
function PressButton({
  label,
  tier,
  danger,
  pending,
  onClick,
}: {
  label: string;
  tier: PressTier;
  danger?: boolean;
  pending?: boolean;
  onClick: () => void;
}): JSX.Element {
  if (tier === 'link') {
    return (
      <Button
        className={`project-open-item-quiet${danger ? ' is-danger' : ''}`}
        type="link"
        size="small"
        loading={pending}
        onClick={onClick}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button
      size="small"
      type={tier === 'primary' ? 'primary' : 'default'}
      danger={danger}
      loading={pending}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** The card's one sentence about a press that was refused, in the shape the pause card uses. */
function PressError({ headline, error }: { headline: string; error: Error }): JSX.Element {
  return (
    <Alert
      type="error"
      showIcon
      className="project-open-item-error"
      message={headline}
      description={error.message}
    />
  );
}

function RetryPress({
  row,
  projectId,
  tier,
}: {
  row: ProjectOpenItemRow;
  projectId: string;
  tier: PressTier;
}): JSX.Element {
  const qc = useQueryClient();
  const retry = useMutation(retryTaskMutationOptions(qc, projectId, row.taskId ?? ''));
  const error = retry.error instanceof Error ? retry.error : null;
  const conflict = error ? readTaskRunConflict(error) : null;
  return (
    <>
      <PressButton
        label={ACTION_LABEL.RETRY!}
        tier={tier}
        pending={retry.isPending}
        onClick={() => retry.mutate({ triggerId: newRunRequestToken() })}
      />
      {conflict?.sessionId ? (
        <TaskRunHandoffNotice conflict={conflict} className="project-open-item-error" />
      ) : error ? (
        <PressError headline="The task was not started" error={error} />
      ) : null}
    </>
  );
}

/**
 * Open task session: the way onto the work an exception is about — the attempt that opened it, or
 * the task when that attempt has no session left.
 *
 * Drawn as a press where the card leads with it (mock 7's rule 1: what a conflict is asking for is
 * somebody to go and fix the branch, which is a different step from running it again) rather than as
 * the way in a row draws. The same address either way, and a route, so it does not reload the app.
 */
function OpenTaskSessionPress({
  row,
  tier,
}: {
  row: ProjectOpenItemRow;
  tier: PressTier;
}): JSX.Element {
  const navigate = useNavigate();
  // `cardActions` draws this action only where the row carries the address it reaches.
  const href = actionHref(row, 'OPEN_TASK_SESSION') as string;
  return (
    <PressButton
      label={ACTION_LABEL.OPEN_TASK_SESSION!}
      tier={tier}
      onClick={() => navigate(href)}
    />
  );
}

/**
 * Cancel task: the attempt stops here and the exceptions it opened close with it (§4.2:
 * `TASK_CLOSED`). No run is stopped by it — a task with a live run is a task that is not FAILED —
 * so the press is about the record, and its confirm says exactly that.
 *
 * Drawn in the QUIET weight wherever it appears (mock 7's rule 2): stopping a task is one of the two
 * things a reader does rarest and last, so it never takes the weight of the press the card is
 * asking for — and it still asks before it writes.
 */
function CancelTaskPress({
  row,
  projectId,
}: {
  row: ProjectOpenItemRow;
  projectId: string;
}): JSX.Element {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation(cancelTaskMutationOptions(qc, projectId, row.taskId ?? ''));
  return (
    <>
      <PressButton
        label={ACTION_LABEL.CANCEL_TASK!}
        tier="link"
        danger
        pending={cancel.isPending}
        onClick={() => setConfirming(true)}
      />
      <Modal
        open={confirming}
        title={CANCEL_TASK_MODAL_TITLE}
        okText={CANCEL_TASK_MODAL_OK}
        okButtonProps={{ danger: true, loading: cancel.isPending }}
        cancelText="Back"
        onOk={() => cancel.mutate(undefined, { onSuccess: () => setConfirming(false) })}
        // A refusal leaves the modal open over the row it was about: the reader gets to read what
        // the server said and decide again, rather than losing the question with the answer.
        onCancel={() => {
          cancel.reset();
          setConfirming(false);
        }}
      >
        <p>{CANCEL_TASK_MODAL_BODY}</p>
        {cancel.isError ? (
          <PressError headline="The task was not cancelled" error={cancel.error as Error} />
        ) : null}
      </Modal>
    </>
  );
}

function AskCoordinatorAgainPress({
  row,
  projectId,
  tier,
}: {
  row: ProjectOpenItemRow;
  projectId: string;
  tier: PressTier;
}): JSX.Element {
  const qc = useQueryClient();
  const ask = useMutation(askCoordinatorAgainMutationOptions(qc, projectId, row.itemId));
  return (
    <>
      <PressButton
        label={ACTION_LABEL.ASK_COORDINATOR_AGAIN!}
        tier={tier}
        pending={ask.isPending}
        onClick={() => ask.mutate()}
      />
      {ask.isError ? (
        <PressError headline="The item was not handed back" error={ask.error as Error} />
      ) : null}
    </>
  );
}

/**
 * The owner closing an exception themselves. Like the cancel press, the press asks first — the
 * reason is required, and a reader who has typed nothing yet is asked for it rather than sent off to
 * be refused — and a refusal leaves the dialog open over the item it was about.
 *
 * It is drawn in the QUIET weight at the end of the row (mock 7, 方案 B) rather than as a third
 * button: it is the ending for an exception nobody has to act on at all, offered to the one reader
 * who already knows that, so it is the last thing in the row and the lightest.
 */
function MarkHandledPress({
  row,
  projectId,
}: {
  row: ProjectOpenItemRow;
  projectId: string;
}): JSX.Element {
  const qc = useQueryClient();
  const fieldId = useId();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const mark = useMutation(markItemHandledMutationOptions(qc, projectId, row.itemId));
  const trimmed = note.trim();
  const close = () => {
    if (mark.isPending) return;
    mark.reset();
    setNote('');
    setAsking(false);
  };
  return (
    <>
      <PressButton
        label={MARK_HANDLED}
        tier="link"
        pending={mark.isPending}
        onClick={() => setAsking(true)}
      />
      <Modal
        open={asking}
        title={MARK_HANDLED_MODAL_TITLE}
        okText={MARK_HANDLED}
        // Empty is not a press: the server requires the reason, so the confirm waits for one. The
        // handler holds the same line, because a disabled button is not a rule about what is sent.
        okButtonProps={{ disabled: trimmed === '', loading: mark.isPending }}
        cancelText="Back"
        onOk={() => {
          if (trimmed === '') return;
          mark.mutate(trimmed, {
            onSuccess: () => {
              setNote('');
              setAsking(false);
            },
          });
        }}
        onCancel={close}
      >
        <p>{MARK_HANDLED_MODAL_BODY}</p>
        <label className="project-open-item-reason-label" htmlFor={fieldId}>
          Why is it no longer open?
        </label>
        <Input.TextArea
          id={fieldId}
          value={note}
          maxLength={2000}
          autoSize={{ minRows: 2, maxRows: 8 }}
          onChange={(event) => setNote(event.target.value)}
        />
        {mark.isError ? (
          <PressError headline="The item was not closed" error={mark.error as Error} />
        ) : null}
      </Modal>
    </>
  );
}

/** One press of a card, by the action the server named, in the weight the card gave it. An action
 *  that writes and has no press here is one this build cannot make — and `cardActions` has already
 *  left it undrawn. */
function ItemPress({
  row,
  action,
  projectId,
  tier,
}: {
  row: ProjectOpenItemRow;
  action: OpenItemAction;
  projectId: string;
  tier: PressTier;
}): JSX.Element | null {
  switch (action) {
    case 'RETRY':
      return <RetryPress row={row} projectId={projectId} tier={tier} />;
    case 'OPEN_TASK_SESSION':
      return <OpenTaskSessionPress row={row} tier={tier} />;
    // Cancel task takes no weight: it is the one door drawn quiet wherever it lands (see its own
    // press), so the card's three weights never reach it.
    case 'CANCEL_TASK':
      return <CancelTaskPress row={row} projectId={projectId} />;
    case 'ASK_COORDINATOR_AGAIN':
      return <AskCoordinatorAgainPress row={row} projectId={projectId} tier={tier} />;
    default:
      return null;
  }
}

/**
 * An exception the coordinator is handling: a conflict, a failed combined-tree check, an
 * integration error, or a task that failed (mock 5, left column).
 *
 * One component for four kinds, because the card is the same card: what happened, who has it, how
 * long they have had it, and when it stops being theirs. What differs between the four is the kind's
 * heading and what its payload has to say, and both arrive already written — see `ItemFactRows`.
 */
export function OpenItemCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  return (
    <ItemCard
      row={row}
      heading={ITEM_HEADING[row.kind] ?? row.title}
      tone="coordinator"
      now={now}
    >
      <CardActions projectId={projectId} row={row} />
    </ItemCard>
  );
}

/**
 * One row of a card's fact block (§7.5). A fixed-width key column, so four rows read as a table —
 * the same two classes the merge confirmation card's own rows use, which is what makes the two
 * cards' blocks look like one thing.
 */
function FactRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="criteria-decision-kv project-open-item-fact">
      <span className="criteria-decision-k">{label}</span>
      <span className="criteria-decision-v">{children}</span>
    </div>
  );
}

/** How many lines of a failed check's output stay out of the fold. The rest are one press away. */
const CHECK_TAIL_LINES = 6;

/**
 * The tail of what a failed check printed.
 *
 * `Pre` is the app's block for a command's output, and it folds past a few lines by keeping the
 * FIRST ones — which is right for output that grows downwards from its start and exactly wrong for
 * a tail, whose whole reason to be shown is the failure at its end. So this keeps the last lines
 * folded and offers the rest, in the same shape the reader has met everywhere else.
 */
function CheckOutputTail({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = stripAnsi(text).split('\n');
  const hidden = Math.max(0, lines.length - CHECK_TAIL_LINES);
  const shown = open || hidden === 0 ? lines.join('\n') : lines.slice(hidden).join('\n');
  return (
    <div className="project-open-item-log">
      <pre className="chat-pre">{shown}</pre>
      {hidden > 0 ? (
        <button className="chat-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show ${hidden} more lines`}
        </button>
      ) : null}
    </div>
  );
}

/** How a check ended, in the words the mock uses for it (§7.5): the code it returned, or that its
 *  budget ran out while it was still running. */
function checkVerdict(check: IntegrationCheckResult): string {
  if (check.exitCode != null) return `exit ${check.exitCode}`;
  return check.timedOut ? 'timed out' : 'no exit code';
}

/** `3rd`, `1st`, `12th` — the mock counts the failure that stops being the coordinator's. */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Why an attempt failed and where its chain stands (§4.3, §4.5), in the two rows mock 5 draws. */
function howFailed(failure: NonNullable<OpenItemFacts['failure']>): string {
  const how: Record<string, string> = {
    ACCEPTANCE_EXIT_MISMATCH: 'the acceptance command exited',
    RUN_FAILED: 'a turn of the run failed',
    RUNNER_FINALIZED_FAILED: 'the runner finished the run as failed',
    REAPED_API_ERROR: 'the run stopped on an API or sign-in error and was reaped',
    ATTEMPT_LOST_RUNNER_OFFLINE: 'its runner went offline and the attempt was taken back',
    ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED: 'its runtime never started and the attempt was taken back',
    REPORTED_FAILED: 'somebody filed it as failed',
  };
  const said = how[failure.how ?? ''] ?? 'the task failed';
  return failure.exitCode == null
    ? said
    : `${said} ${failure.exitCode} (expected ${failure.expectedExitCode ?? 0})`;
}

function chainStanding(failure: NonNullable<OpenItemFacts['failure']>): string {
  const standing = `attempt ${failure.attempt} of ${failure.limit} in this chain`;
  return failure.attempt >= failure.limit
    ? `${standing} — this one is the owner's`
    : `${standing} — the ${ordinal(failure.limit)} failure goes straight to the owner`;
}

/**
 * The card's fact block (§7.5, mock 5): what the item's payload holds, in the rows the mock draws.
 *
 * Every row is drawn only where the payload has something to say, because an item whose payload
 * predates this build still has to read as the card it was rather than as a card with blanks in it.
 * A payload this build cannot read at all is not a blank card either: it keeps the one line the
 * card had before the rows existed — the server's own sentence about the fact.
 */
function ItemFactRows({ row }: { row: ProjectOpenItemRow }): JSX.Element | null {
  const facts = row.facts;
  if (!facts) {
    return row.detailLine ? <p className="project-open-item-detail">{row.detailLine}</p> : null;
  }
  const check = facts.check;
  return (
    <div className="project-open-item-facts">
      {facts.task ? <FactRow label="Task">{facts.task.title}</FactRow> : null}
      {facts.targetRef ? (
        <FactRow label="Into">
          <span className="project-open-item-mono">{facts.targetRef}</span>
          {facts.targetSha ? ` at ${facts.targetSha.slice(0, 7)}` : null}
          {facts.nothingLanded ? ' · nothing landed' : null}
        </FactRow>
      ) : null}
      {facts.files.length > 0 ? (
        <FactRow label="Files">
          <span className="project-open-item-mono">{facts.files.join(' · ')}</span>
        </FactRow>
      ) : null}
      {/* Only where the item is about a task: the press this sentence describes is a push to that
          task's branch, and a promotion's failure has no task branch to push to. */}
      {facts.task && facts.files.length > 0 ? (
        <FactRow label="After a fix">
          push to the task branch — Orbit re-integrates and re-checks on its own
        </FactRow>
      ) : null}
      {check ? (
        <>
          <FactRow label="Check">
            <span className="project-open-item-mono">{check.command}</span>
            {' · '}
            <span className="project-open-item-bad">{checkVerdict(check)}</span>
            {` after ${checkDuration(check.durationMs)}`}
          </FactRow>
          {check.outputTail.trim() !== '' ? <CheckOutputTail text={check.outputTail} /> : null}
        </>
      ) : null}
      {facts.branchUnchanged ? (
        <FactRow label="Branch">
          unchanged — the task passed on its own branch; it fails only on the combined tree
        </FactRow>
      ) : null}
      {facts.failure ? (
        <>
          <FactRow label="How">{howFailed(facts.failure)}</FactRow>
          <FactRow label="Retries">{chainStanding(facts.failure)}</FactRow>
        </>
      ) : null}
      {facts.errorCode ? (
        <FactRow label="Error">
          <span className="project-open-item-mono">{facts.errorCode}</span>
        </FactRow>
      ) : null}
    </div>
  );
}

/** A card's presses, in the weights the mock gives them (mock 7, 方案 B): the step this kind of
 *  exception is asking for, the other way to take that step, and — behind both — the doors that only
 *  look and only stop, drawn as quiet links so they stop competing with the press.
 *
 *  The pair comes from `leadingDoors`, which reads the server's own list: a card never leads with a
 *  press the server did not offer, and `cardActions` has already left undrawn anything this row
 *  carries no address for. The pair is drawn first and the rest after it in the server's own order,
 *  so a card reads left to right as what to do, what else would do it, and the ways in and out.
 *
 *  "Mark as handled" is drawn after them and never as one of the pair: it is the ending for an
 *  exception nobody has to act on at all — the work is already where it was going — so it is offered
 *  last, to the one reader who knows that (方案 B: a link at the end of the row, not a third button).
 *  It is not on the server's `actions` list (see this module's head), which is why it is drawn from
 *  the kind rather than from the row's own list. */
function CardActions({
  projectId,
  row,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
}): JSX.Element {
  const actions = cardActions(row);
  // The pair in its own order — the step this kind is asking for, then the alternative beside it —
  // and the rest of the server's list after it: a card reads left to right as what to do, what else
  // would do it, and the ways in and out.
  const leading = leadingDoors(row, actions);
  const [primary, secondary] = leading;
  const tierOf = (action: OpenItemAction): PressTier =>
    action === primary ? 'primary' : action === secondary ? 'secondary' : 'link';
  const ordered = [...leading, ...actions.filter((action) => !leading.includes(action))];
  const handClosable = row.assignee === 'OWNER' && HAND_CLOSABLE_KINDS.has(row.kind);
  return (
    <>
      {ordered.map((action) =>
        // A door a card may lead with, or one it writes through, has a press of its own; everything
        // else an item lists is a door to look through, and is drawn as the way in it is.
        LEADING_ACTIONS.has(action) || WRITE_ACTIONS.has(action) ? (
          <ItemPress
            key={action}
            row={row}
            action={action}
            projectId={projectId}
            tier={tierOf(action)}
          />
        ) : (
          <ItemLink key={action} row={row} action={action} quiet />
        ),
      )}
      {handClosable ? <MarkHandledPress row={row} projectId={projectId} /> : null}
    </>
  );
}

/**
 * The same exception once it is the owner's (mock 5, right column): the heading says how it got
 * here, because that is the fact the reader is missing — an item that arrived by a clock, by a
 * conversation ending, by a chain running out or by a hand-over each ask for something different.
 *
 * What it is about is not in that heading and not in a bare line under it either: it is the first
 * row of the fact block, the same row the card wears while the coordinator has it.
 */
export function EscalatedItemCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  const heading = escalationHeading(row, now) ?? ITEM_HEADING[row.kind] ?? row.title;
  return (
    <ItemCard row={row} heading={heading} tone="owner" now={now}>
      <CardActions projectId={projectId} row={row} />
    </ItemCard>
  );
}

/** The chrome all three share: the head with its provenance mark, the fact block, the actions, and
 *  the footer that says who owes an answer and by when. */
function ItemCard({
  row,
  heading,
  tone,
  now,
  id,
  children,
}: {
  row: ProjectOpenItemRow;
  heading: string;
  /** Amber for what the owner has to act on, neutral for what the coordinator is handling — the
   *  same two colours the project page's two groups use, so a card and its row agree at a glance. */
  tone: 'owner' | 'coordinator';
  now: number;
  id?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`approval-card project-open-item-card is-${tone}`}
      id={id ?? `open-item-${row.itemId}`}
      data-kind={row.kind}
    >
      <div className="approval-head project-open-item-head">
        <span className="project-open-item-heading">{heading}</span>
        <span
          className={`criteria-provenance${tone === 'coordinator' ? ' prov-neutral' : ''}`}
          title={FROM_ORBIT_TITLE}
        >
          {FROM_ORBIT}
        </span>
      </div>
      <div className="approval-body is-plan project-open-item-body">
        <ItemFactRows row={row} />
        <div className="project-open-item-actions">{children}</div>
      </div>
      <div className="project-open-item-foot">{ownerLine(row, now)}</div>
    </div>
  );
}

/** Which card an item is drawn as. The pause is its own because it writes; an item that became the
 *  owner's is its own because its heading is the story of how; everything else is the plain one. */
function ItemAsCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element | null {
  if (row.kind === 'FUSE_PAUSED') {
    return <FusePauseCard projectId={projectId} row={row} now={now} />;
  }
  // A question has its own card, mounted beside this one by both hosts — drawing it again here
  // would be two cards answering one question, and only one of them could win. A merge approval is
  // the same: `ProjectPromotionCard` draws it from the candidate itself, which is where what would
  // land and what the checks came to actually live.
  if (row.kind === 'COORDINATOR_QUESTION' || row.kind === 'PROMOTION_APPROVAL') return null;
  return escalationHeading(row, now) != null ? (
    <EscalatedItemCard projectId={projectId} row={row} now={now} />
  ) : (
    <OpenItemCard projectId={projectId} row={row} now={now} />
  );
}

/**
 * Every open exception of this project, as cards, wherever a transcript wants them: the project's
 * coordinator conversation draws these under its own turns, and the project page expands the same
 * components (§7.5).
 *
 * Reads nothing without a project — an ordinary session coordinates none — and draws nothing while
 * nothing is open, so neither host has to know whether there is anything to show.
 */
export function ProjectExceptionCards({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const rows = ordered(items.data);
  if (!projectId || rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <ItemAsCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
    </>
  );
}

/**
 * The pause first, then everything else oldest first (§7.2 V5, mock 6 ①).
 *
 * The pause is pinned because it is the only item that is ABOUT the coordinator rather than about
 * a piece of work: while it holds, every other item on this list is waiting on a conversation that
 * has stopped, and a reader who resolved them one by one without seeing it would be working around
 * the thing that stopped the project.
 */
function ordered(items: ProjectOpenItemsView | undefined): ProjectOpenItemRow[] {
  const all = [...(items?.needsYou ?? []), ...(items?.withCoordinator ?? [])];
  const paused = all.filter((row) => row.kind === 'FUSE_PAUSED');
  const rest = all
    .filter((row) => row.kind !== 'FUSE_PAUSED')
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  return [...paused, ...rest];
}

function OpenItemRowView({ row, now }: { row: ProjectOpenItemRow; now: number }): JSX.Element {
  const actions = drawableActions(row);
  return (
    <li className={`project-open-item-row is-${row.assignee === 'OWNER' ? 'owner' : 'coordinator'}`}>
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <div className="project-open-item-title" title={row.title}>
          {row.title}
        </div>
        {row.detailLine ? (
          <div className="project-open-item-line" title={row.detailLine}>
            {row.detailLine}
          </div>
        ) : null}
      </div>
      <div className="project-open-item-who">
        <span>{WHO[row.assignee]}</span>
        <time className="project-open-item-age" dateTime={row.waitingSince}>
          {waitingLabel(row, now)}
        </time>
      </div>
      <div className="project-open-item-press">
        {/* The first door the server listed is the primary one; the rest are reachable from the
            card this row expands to. A row with none says so by drawing none. */}
        {actions[0] ? (
          <ItemLink row={row} action={actions[0]} primary={row.assignee === 'OWNER'} />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The project page's Open items card (mock 2 ②): what is waiting, in the two groups that say who is
 * expected to act, oldest first in both.
 *
 * The two groups are the whole point of the card. "Three things need you and two are being handled"
 * is a different project from "five things are stuck", and before this the page could not tell the
 * reader which one they were looking at.
 */
export function ProjectOpenItems({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // The pause is drawn as a card above the groups and counted in neither: it is not something
  // waiting on a person the way the rows are, it is the reason some of them are waiting.
  const paused = (items.data?.needsYou ?? []).filter((row) => row.kind === 'FUSE_PAUSED');
  const needsYou = (items.data?.needsYou ?? []).filter((row) => row.kind !== 'FUSE_PAUSED');
  const withCoordinator = items.data?.withCoordinator ?? [];
  if (!projectId || paused.length + needsYou.length + withCoordinator.length === 0) return null;

  return (
    <section className="project-open-items" aria-label={OPEN_ITEMS_HEADING}>
      <header className="project-open-items-head">
        <span className="project-open-items-title">{OPEN_ITEMS_HEADING}</span>
        <span className="project-open-items-hint">
          {`${needsYou.length} need you · ${withCoordinator.length} with the coordinator · oldest first`}
        </span>
      </header>
      {paused.map((row) => (
        <FusePauseCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
      {needsYou.length > 0 ? (
        <>
          <div className="project-open-items-group">{NEEDS_YOU_GROUP}</div>
          <ul className="project-open-items-list">
            {needsYou.map((row) => (
              <OpenItemRowView key={row.itemId} row={row} now={now} />
            ))}
          </ul>
        </>
      ) : null}
      {withCoordinator.length > 0 ? (
        <>
          <div className="project-open-items-group">{WITH_COORDINATOR_GROUP}</div>
          <ul className="project-open-items-list">
            {withCoordinator.map((row) => (
              <OpenItemRowView key={row.itemId} row={row} now={now} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** §7.2 V7's four states for the last thing the platform sent the coordinator. `RETURNED` is the
 *  one drawn in amber: it is the only one of the four where a delivery did NOT happen. */
const WAKEUP_WORD: Record<CoordinatorWakeups['state'], string> = {
  DELIVERED: 'delivered',
  QUEUED: 'queued',
  RETURNED: 'returned',
  NONE: 'none yet',
};

/**
 * The two rows the coordinator card gained (§7.2 V7, mock 2 ③): whether the platform's last word
 * reached this conversation, and how much of today's own initiative it has left.
 *
 * Presentational, like the card that hosts it — it is handed the payload's own two objects and
 * reports nothing back. Kept here rather than in `ProjectCoordinatorCard` because both facts belong
 * to this contract and move with it, and because the card is already the longest file on the page.
 */
export function CoordinatorProgressRows({
  wakeups,
  fuse,
  now = Date.now(),
}: {
  wakeups: CoordinatorWakeups;
  fuse: CoordinatorFuseUsage;
  now?: number;
}): JSX.Element {
  const word = WAKEUP_WORD[wakeups.state] ?? wakeups.state;
  const when = wakeups.at == null
    ? null
    : wakeups.state === 'DELIVERED'
      ? `last ${ago(wakeups.at, now)}`
      : ago(wakeups.at, now);
  // Bounded at the limit: a coordinator 31 turns into a 30 limit has a full bar, not one and a
  // tenth, and the numbers beside it are what say by how much it went over.
  const filled = fuse.limit != null && fuse.limit > 0
    ? Math.min(100, Math.round((fuse.selfStartedToday / fuse.limit) * 100))
    : null;
  return (
    <>
      <div className="project-coordinator-progress" aria-label="Wake-ups">
        <span className="project-coordinator-progress-label">Wake-ups</span>
        <span className="project-coordinator-progress-value">
          <span className={wakeups.state === 'RETURNED' ? 'is-returned' : 'is-carried'}>{word}</span>
          {when ? ` · ${when}` : null}
        </span>
      </div>
      <div className="project-coordinator-progress is-stacked" aria-label="Self-started today">
        <div className="project-coordinator-progress-line">
          <span className="project-coordinator-progress-label">Self-started today</span>
          <span className="project-coordinator-progress-value">
            {fuse.limit == null
              ? `${fuse.selfStartedToday} · no limit`
              : `${fuse.selfStartedToday} of ${fuse.limit}`}
            {fuse.paused ? <span className="is-paused">{' · paused'}</span> : null}
          </span>
        </div>
        {filled !== null ? (
          <div className="project-coordinator-meter">
            <i className={fuse.paused ? 'is-paused' : undefined} style={{ width: `${filled}%` }} />
          </div>
        ) : null}
      </div>
    </>
  );
}
