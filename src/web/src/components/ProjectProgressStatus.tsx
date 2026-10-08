import { useCallback, useId, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CoordinatorFuseUsage,
  CoordinatorWakeups,
  IntegrationCheckResult,
  OpenItemAction,
  OpenItemFacts,
  OpenItemHandling,
  OpenItemKind,
  ProjectOpenItemRow,
  ProjectOpenItemsView,
} from '@orbit/shared';
import { api } from '../api';
import { stripAnsi } from '../lib/ansi';
import { checkDuration } from '../lib/checkDuration';
import {
  CHAT_ABOUT_THIS,
  CHAT_REFUSAL_LABEL,
  EXCEPTION_CHAT_PREFIX,
  PAUSE_CHAT_PREFIX,
  coordinatorChatPath,
  itemChat,
  type CoordinatorChatSubject,
} from '../lib/coordinatorChat';
import { decisionReceiptAnchor, type ReceiptPlacement } from '../lib/decisionReceipt';
import { encodeId } from '../lib/idCodec';
import { projectOpenItemsQuery } from '../lib/queries';
import {
  START_PROJECT_TITLE,
  START_ROW_NOT_ASKED,
  START_ROW_OWN,
  startPageRow,
  startRequestSummary,
} from '../lib/projectStart';
import { PROJECT_DONE_COPY } from '../lib/projectDone';
import { newRunRequestToken, runRequestResend } from '../lib/runRequestToken';
import { refreshTaskScheduleViews } from '../lib/taskSchedule';
import { readTaskRunConflict } from '../lib/taskRunHandoff';
import { ago, formatSpan } from '../lib/watches';
import { TaskRunHandoffNotice } from './TaskRunHandoffNotice';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Textarea } from './ui/Textarea';

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
 * The word an exception card wears for where the coordinator's handling of it stands (§4.7 H1–H5).
 *
 * `Handling` while the rerun the coordinator asked for is still queued or running — the item is
 * open, and nothing about it is settled yet: it wears the blue the project list's "Coordinator ·
 * handling" chip wears, and never the word "handled". `Handled` once the rerun landed or passed, or
 * the coordinator closed the item with a reason; `Superseded` once the rerun failed again and a new
 * card took this one's place. What is the owner's says so in its heading (`escalationHeading`), as it
 * always has.
 */
export const HANDLING_TAG = 'Handling';
export const HANDLED_TAG = 'Handled';
export const SUPERSEDED_TAG = 'Superseded';

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

const REVIEW_HEADING: Readonly<Record<string, string>> = {
  OUTSIDE_DECLARED_SCOPE: 'Changed files it didn’t declare',
  MERGE_REFUSED_BY_GIT: 'Git refused to merge it',
};

function itemHeading(row: ProjectOpenItemRow): string {
  if (row.kind === 'DELIVERY_REVIEW') {
    const reason = row.facts?.review?.reason;
    return (reason ? REVIEW_HEADING[reason] : undefined) ?? row.title;
  }
  return ITEM_HEADING[row.kind] ?? row.title;
}

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
  DELIVERY_REVIEW: 'OPEN_TASK_SESSION',
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
  onChat,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
  onChat?: (subject: CoordinatorChatSubject) => void;
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
    <ItemCard
      row={row}
      heading={row.title}
      tone="owner"
      now={now}
      id={`fuse-${row.itemId}`}
      onChat={onChat}
    >
      <Button
        variant="primary"
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
          className="project-open-item-error"
          title="The coordinator was not resumed"
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
  'DELIVERY_REVIEW',
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
        variant="link"
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
      variant={tier === 'primary' ? 'primary' : 'default'}
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
      className="project-open-item-error"
      title={headline}
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
      <Dialog
        className="project-open-item-dialog"
        open={confirming}
        title={CANCEL_TASK_MODAL_TITLE}
        // A refusal leaves the dialog open over the row it was about: the reader gets to read what
        // the server said and decide again, rather than losing the question with the answer.
        onClose={() => {
          cancel.reset();
          setConfirming(false);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                cancel.reset();
                setConfirming(false);
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              danger
              loading={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onSuccess: () => setConfirming(false) })}
            >
              {CANCEL_TASK_MODAL_OK}
            </Button>
          </>
        }
      >
        <p>{CANCEL_TASK_MODAL_BODY}</p>
        {cancel.isError ? (
          <PressError headline="The task was not cancelled" error={cancel.error as Error} />
        ) : null}
      </Dialog>
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
      <Dialog
        className="project-open-item-dialog"
        open={asking}
        title={MARK_HANDLED_MODAL_TITLE}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Back</Button>
            {/* Empty is not a press: the server requires the reason, so the confirm waits for one.
                The handler holds the same line, because a disabled button is not a rule about what
                is sent. */}
            <Button
              variant="primary"
              disabled={trimmed === ''}
              loading={mark.isPending}
              onClick={() => {
                if (trimmed === '') return;
                mark.mutate(trimmed, {
                  onSuccess: () => {
                    setNote('');
                    setAsking(false);
                  },
                });
              }}
            >
              {MARK_HANDLED}
            </Button>
          </>
        }
      >
        <p>{MARK_HANDLED_MODAL_BODY}</p>
        <label className="project-open-item-reason-label" htmlFor={fieldId}>
          Why is it no longer open?
        </label>
        <Textarea
          id={fieldId}
          value={note}
          maxLength={2000}
          autoSize={{ minRows: 2, maxRows: 8 }}
          onChange={(event) => setNote(event.target.value)}
        />
        {mark.isError ? (
          <PressError headline="The item was not closed" error={mark.error as Error} />
        ) : null}
      </Dialog>
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
  onChat,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
  onChat?: (subject: CoordinatorChatSubject) => void;
}): JSX.Element {
  return (
    <ItemCard
      row={row}
      heading={itemHeading(row)}
      tone="coordinator"
      now={now}
      onChat={onChat}
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
      {facts.review ? (
        <FactRow label="Declared">
          <span className="project-open-item-mono">
            {facts.review.declaredPaths.length > 0
              ? facts.review.declaredPaths.join(' · ')
              : 'no paths'}
          </span>
        </FactRow>
      ) : null}
      {facts.task && facts.files.length > 0 && !facts.review ? (
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

/** What the coordinator's rerun is, in the card's words: a task's landing, or a candidate's check. */
function rerunOf(
  row: Pick<ProjectOpenItemRow, 'promotionId'>,
  jobKind?: OpenItemHandling['jobKind'],
): string {
  const check = jobKind ? jobKind === 'CHECK_PROMOTION' : row.promotionId != null;
  return check ? 'the re-check of the merge into main' : 'the rerun of the landing';
}

/** §4.7 H1, in one line: which rerun, which generation, where it is, and since when it was asked. */
function handlingLine(row: ProjectOpenItemRow, handling: OpenItemHandling, now: number): string {
  const where = handling.state === 'RUNNING' ? 'is running' : 'is queued';
  return `${rerunOf(row, handling.jobKind)} — generation ${handling.generation} ${where} · asked `
    + `${ago(handling.startedAt, now)}`;
}

/** §4.7 H2/H3, in one line: how the coordinator's handling of an item ended. */
function outcomeLine(row: ProjectOpenItemRow): string | null {
  const outcome = row.outcome;
  if (!outcome) return null;
  if (outcome.resolution === 'RETRIED') {
    return `${rerunOf(row)} failed again — a new item took its place`;
  }
  if (outcome.jobId == null) return 'closed by the coordinator, with its reason';
  return row.promotionId != null
    ? 'the re-check of the merge into main passed'
    : 'the rerun of the landing landed';
}

/**
 * The card's rows about the coordinator's handling (§4.7): the rerun while it runs, or how it
 * ended — each with the reason the coordinator gave, which is the one part of the record nobody
 * else wrote. Nothing at all for an item nobody has handled.
 */
function ItemHandlingRows({
  row,
  now,
}: {
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element | null {
  const handling = row.handling ?? null;
  const outcome = row.outcome ?? null;
  if (!handling && !outcome) return null;
  const said = outcome ? outcomeLine(row) : null;
  const reason = outcome ? outcome.note : handling?.reason ?? null;
  return (
    <div className="project-open-item-facts project-open-item-handling">
      {handling ? <FactRow label={HANDLING_TAG}>{handlingLine(row, handling, now)}</FactRow> : null}
      {outcome && said ? (
        <FactRow label={outcome.resolution === 'RETRIED' ? SUPERSEDED_TAG : HANDLED_TAG}>
          {said}
          {outcome.supersededByItemId ? (
            <>
              {' · '}
              <a
                className="project-open-item-quiet"
                href={`#open-item-${outcome.supersededByItemId}`}
              >
                see the new item
              </a>
            </>
          ) : null}
        </FactRow>
      ) : null}
      {reason ? <FactRow label="Reason">{reason}</FactRow> : null}
    </div>
  );
}

/** The card's fact block in words, for a chat about the item: the same rows `ItemFactRows` draws,
 *  minus the check's output — a coordinator that wants it reads the item. */
function itemFactLines(row: ProjectOpenItemRow): string[] {
  const facts = row.facts;
  if (!facts) return [];
  const lines: string[] = [];
  if (facts.task) lines.push(`Task: ${facts.task.title}`);
  if (facts.targetRef) {
    const sha = facts.targetSha ? ` at ${facts.targetSha.slice(0, 7)}` : '';
    lines.push(`Into: ${facts.targetRef}${sha}${facts.nothingLanded ? ' · nothing landed' : ''}`);
  }
  if (facts.files.length > 0) lines.push(`Files: ${facts.files.join(' · ')}`);
  if (facts.review) {
    const declared = facts.review.declaredPaths;
    lines.push(`Declared: ${declared.length > 0 ? declared.join(' · ') : 'no paths'}`);
  }
  if (facts.check) {
    lines.push(`Check: ${facts.check.command} · ${checkVerdict(facts.check)} after `
      + `${checkDuration(facts.check.durationMs)}`);
  }
  if (facts.branchUnchanged) {
    lines.push(
      'Branch: unchanged — the task passed on its own branch; it fails only on the combined tree',
    );
  }
  if (facts.failure) {
    lines.push(`How: ${howFailed(facts.failure)}`);
    lines.push(`Retries: ${chainStanding(facts.failure)}`);
  }
  if (facts.errorCode) lines.push(`Error: ${facts.errorCode}`);
  return lines;
}

/** How an item that is the owner's became theirs, as the clause a chat about it carries — the
 *  escalation heading's story, told about the item rather than to the reader. */
function ownerClause(row: ProjectOpenItemRow, now: number): string {
  switch (row.assigneeReason) {
    case 'ESCALATED':
      return `the owner’s now — no one acted on it for ${waitedBeforeEscalation(row)}`;
    case 'COORDINATOR_ENDED':
      return 'the owner’s now — the coordinator conversation ended';
    case 'CHAIN_LIMIT':
      return 'the owner’s now — the 3rd failure in this chain';
    case 'HANDED_OVER':
      return 'the owner’s now — the coordinator handed it over';
    case 'NO_COORDINATOR':
      return 'the owner’s — the project had no coordinator when it opened';
    default:
      return `waiting on the owner for ${formatSpan(waitedMs(row, now))}`;
  }
}

/** Who asked for the rerun an item's handling is, or was: the owner's own door (0380), or the
 *  coordinator's. A settled row says it in `resolvedBy`, an open one in `handling.userId`. */
function handledByOwner(row: ProjectOpenItemRow): boolean {
  return row.outcome ? row.outcome.resolvedBy === 'USER' : row.handling?.userId != null;
}

/**
 * Where an item's handling stands (§4.7), as the line a chat about it carries: whose move it is,
 * since when, and what is in flight. The stage is the server's (`ProjectOpenItemRow.chat`).
 */
export function itemStandingLine(row: ProjectOpenItemRow, now: number): string {
  if (row.kind === 'FUSE_PAUSED') {
    return 'the coordinator stopped itself, and only the owner can lift it';
  }
  const handling = row.handling ?? null;
  switch (itemChat(row).stage) {
    case 'HANDLING': {
      const rerun = handling
        ? `being handled — ${handlingLine(row, handling, now)}`
        : 'being handled by the coordinator';
      // The clock can hand an item to the owner while its rerun still runs (§4.7 H4): both are true,
      // and whose move it is next is the second half.
      return row.assignee === 'OWNER' ? `${rerun}; ${ownerClause(row, now)}` : rerun;
    }
    case 'WITH_COORDINATOR': {
      const left = row.escalateAt == null ? null : Date.parse(row.escalateAt) - now;
      return `waiting on the coordinator for ${formatSpan(waitedMs(row, now))}`
        + (left != null && left > 0 ? ` — it goes to the owner in ${formatSpan(left)}` : '');
    }
    case 'WITH_OWNER':
      return ownerClause(row, now);
    case 'HANDLED': {
      const owner = handledByOwner(row);
      // The card's `outcomeLine` names the coordinator for a close with no job; the owner's own
      // "Mark as handled" is one too, and the chat says whose it was.
      const how = owner && row.outcome?.jobId == null ? 'closed by hand, with its reason' : outcomeLine(row);
      return `handled by ${owner ? 'the owner' : 'the coordinator'} ${ago(row.outcome?.resolvedAt, now)}`
        + `${how ? ` — ${how}` : ''}`;
    }
    case 'SUPERSEDED':
      return `superseded — ${handledByOwner(row) ? 'the owner’s' : 'the coordinator’s'} rerun failed `
        + 'again, and a new item took its place';
  }
}

/** What the composer's bar says once "Chat about this" armed it for this item. */
export function openItemChatBanner(row: ProjectOpenItemRow): string {
  return (row.kind === 'FUSE_PAUSED' ? PAUSE_CHAT_PREFIX : EXCEPTION_CHAT_PREFIX) + row.title;
}

/**
 * What "Chat about this" carries ahead of the reader's message (§4.8): the project, the item and
 * what failed, and where its handling stands — because the conversation it is read in may not have
 * this item in front of it any more: it is a row of the project's list, not a turn of that
 * transcript. The ids ride along so an answer about an item that has since moved can be told apart
 * from one about this one (the native ends' `ExceptionCards.chatContext` does the same).
 *
 * It describes; it authorizes nothing. A rerun, a merge or a close is still a door somebody presses.
 */
export function openItemChatContext({
  projectTitle,
  projectId,
  row,
  now,
}: {
  projectTitle: string | null;
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): string {
  const what = row.kind === 'FUSE_PAUSED' ? 'pause' : 'exception';
  const reason = row.handling?.reason || row.outcome?.note || null;
  const ids = [
    `project ${projectId}`,
    `open item ${row.itemId}`,
    ...(row.taskId ? [`task ${row.taskId}`] : []),
    ...(row.promotionId ? [`promotion ${row.promotionId}`] : []),
    `waiting since ${row.waitingSince}`,
  ];
  return [
    `About the ${what}${projectTitle ? ` in “${projectTitle}”` : ''}:`,
    '',
    row.title,
    ...(row.detailLine ? [row.detailLine] : []),
    ...itemFactLines(row),
    `Where it stands: ${itemStandingLine(row, now)}`,
    ...(reason ? [`${handledByOwner(row) ? 'The owner’s' : 'The coordinator’s'} reason: ${reason}`] : []),
    '',
    `(${ids.join(' · ')})`,
  ].join('\n');
}

/** The state word a card's head wears (§4.7), or null for an item nobody is handling. */
function handlingTag(
  row: ProjectOpenItemRow,
): { text: string; tone: 'handling' | 'handled' | 'superseded' } | null {
  if (row.outcome) {
    return row.outcome.resolution === 'RETRIED'
      ? { text: SUPERSEDED_TAG, tone: 'superseded' }
      : { text: HANDLED_TAG, tone: 'handled' };
  }
  return row.handling ? { text: HANDLING_TAG, tone: 'handling' } : null;
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
  onChat,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
  onChat?: (subject: CoordinatorChatSubject) => void;
}): JSX.Element {
  const heading = escalationHeading(row, now) ?? itemHeading(row);
  return (
    <ItemCard row={row} heading={heading} tone="owner" now={now} onChat={onChat}>
      <CardActions projectId={projectId} row={row} />
    </ItemCard>
  );
}

/**
 * An exception the coordinator's handling has ended (§4.7 H5): handled — its rerun landed or
 * passed, or it closed the item with a reason — or superseded by the card its failed rerun opened.
 * The same card, at the same place in the conversation, with no door left on it: what it was about,
 * how it ended, and the coordinator's reason. What it still has is the conversation — about how a
 * handled one was handled; a superseded one says the chat belongs to the item that replaced it.
 */
export function SettledItemCard({
  row,
  now,
  onChat,
}: {
  row: ProjectOpenItemRow;
  now: number;
  onChat?: (subject: CoordinatorChatSubject) => void;
}): JSX.Element {
  return (
    <ItemCard row={row} heading={itemHeading(row)} tone="settled" now={now} onChat={onChat} />
  );
}

/** A settled card's footer: who ended it and when — the coordinator, in both endings. */
function settledLine(row: ProjectOpenItemRow, now: number): string {
  const when = ago(row.outcome?.resolvedAt, now);
  return row.outcome?.resolution === 'RETRIED'
    ? `Superseded after the coordinator’s rerun · ${when}`
    : `Handled by the coordinator · ${when}`;
}

/**
 * "Chat about this" (§4.8): a message to the project's coordinator conversation about this item,
 * carrying what the card says (`openItemChatContext`). Its own row under the doors, because it is
 * not one of them — it presses nothing on the item, so it is drawn on every card, whoever holds the
 * item and however its handling ended — and a refusal is said beside it, in the server's terms,
 * rather than leaving a grey button to explain itself.
 *
 * In the coordinator's conversation the host arms its composer (`onChat`); anywhere else the press
 * opens that conversation, which arms it on arrival (`coordinatorChatPath`).
 */
function ItemChatRow({
  row,
  onChat,
}: {
  row: ProjectOpenItemRow;
  onChat?: (subject: CoordinatorChatSubject) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const chat = itemChat(row);
  // A host with a composer of its own can always take the message; one without has to know where
  // the conversation is.
  const refusal = chat.refusal ?? (!onChat && !chat.sessionId ? 'NO_COORDINATOR' : null);
  const subject: CoordinatorChatSubject = { kind: 'item', row };
  return (
    <div className="project-open-item-chat">
      <Button
        size="small"
        disabled={refusal != null}
        onClick={() => {
          if (refusal != null) return;
          if (onChat) onChat(subject);
          else if (chat.sessionId) navigate(coordinatorChatPath(chat.sessionId, subject));
        }}
      >
        {CHAT_ABOUT_THIS}
      </Button>
      {refusal != null ? (
        <span className="project-open-item-chat-refusal">{CHAT_REFUSAL_LABEL[refusal]}</span>
      ) : null}
    </div>
  );
}

/** The chrome all three share: the head with its provenance mark, the fact block, the actions, the
 *  chat, and the footer that says who owes an answer and by when. */
function ItemCard({
  row,
  heading,
  tone,
  now,
  id,
  onChat,
  children,
}: {
  row: ProjectOpenItemRow;
  heading: string;
  /** Amber for what the owner has to act on, neutral for what the coordinator is handling — the
   *  same two colours the project page's two groups use, so a card and its row agree at a glance —
   *  and a quieter neutral for one whose handling has ended (§4.7 H5). */
  tone: 'owner' | 'coordinator' | 'settled';
  now: number;
  id?: string;
  /** The host's composer, when the card is drawn in the conversation a chat about it goes to. */
  onChat?: (subject: CoordinatorChatSubject) => void;
  children?: ReactNode;
}): JSX.Element {
  const tag = handlingTag(row);
  return (
    <div
      className={`approval-card project-open-item-card is-${tone}`}
      id={id ?? `open-item-${row.itemId}`}
      data-kind={row.kind}
      // One handle for all three cards, whichever id each is drawn under: what the conversation's
      // pinned line scrolls to, and measures to say which way that is (`revealOpenItemCard`).
      data-open-item={row.itemId}
      data-handling={tag?.tone}
    >
      <div className="approval-head project-open-item-head">
        <span className="project-open-item-heading">{heading}</span>
        {tag ? <span className={`project-open-item-state is-${tag.tone}`}>{tag.text}</span> : null}
        <span
          className={`criteria-provenance${tone === 'owner' ? '' : ' prov-neutral'}`}
          title={FROM_ORBIT_TITLE}
        >
          {FROM_ORBIT}
        </span>
      </div>
      <div className="approval-body is-plan project-open-item-body">
        <ItemFactRows row={row} />
        <ItemHandlingRows row={row} now={now} />
        <div className="project-open-item-actions">{children}</div>
        <ItemChatRow row={row} onChat={onChat} />
      </div>
      <div className="project-open-item-foot">
        {tone === 'settled' ? settledLine(row, now) : ownerLine(row, now)}
      </div>
    </div>
  );
}

/** Which card an item is drawn as. The pause is its own because it writes; an item that became the
 *  owner's is its own because its heading is the story of how; everything else is the plain one.
 *  Exported for the conversation's host, which draws one per row it inserts (`exceptionCardRows`). */
export function ItemAsCard({
  projectId,
  row,
  now,
  onChat,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
  /** "Chat about this" into the host's own composer — given by the coordinator conversation, which
   *  is where the chat is held (`ItemChatRow`). */
  onChat?: (subject: CoordinatorChatSubject) => void;
}): JSX.Element | null {
  if (row.kind === 'FUSE_PAUSED') {
    return <FusePauseCard projectId={projectId} row={row} now={now} onChat={onChat} />;
  }
  // Ended by the coordinator's handling (§4.7 H5): the card stays where it was, saying how it ended.
  if (row.outcome) return <SettledItemCard row={row} now={now} onChat={onChat} />;
  // A question has its own card, mounted beside this one by both hosts — drawing it again here
  // would be two cards answering one question, and only one of them could win. A merge approval is
  // the same: `ProjectPromotionCard` draws it from the candidate itself, which is where what would
  // land and what the checks came to actually live.
  if (hasCardOfItsOwn(row)) return null;
  return escalationHeading(row, now) != null ? (
    <EscalatedItemCard projectId={projectId} row={row} now={now} onChat={onChat} />
  ) : (
    <OpenItemCard projectId={projectId} row={row} now={now} onChat={onChat} />
  );
}

/** The two kinds `ItemAsCard` draws nothing for, because each has a card of its own. */
function hasCardOfItsOwn(row: Pick<ProjectOpenItemRow, 'kind'>): boolean {
  return row.kind === 'COORDINATOR_QUESTION' || row.kind === 'PROMOTION_APPROVAL';
}

/**
 * Whether a row is drawn as a card the OWNER answers by pressing a door rather than by replying — an
 * exception that became theirs, or the pause only they can lift. The conversation's pinned line
 * points at these as well as at its questions (`DecisionStrip`), so one that has scrolled away still
 * has something pointing at it. The native clients count the same rows (`ExceptionCards.cards`).
 */
export function isOwnerExceptionCard(row: ProjectOpenItemRow): boolean {
  // A card whose handling has ended asks nobody anything, whoever held it last.
  return row.assignee === 'OWNER' && !row.outcome && !hasCardOfItsOwn(row);
}

/**
 * Every open exception of this project, as cards, wherever a transcript wants them: the project's
 * coordinator conversation draws these INTO its own turns, at the moment each one happened, and the
 * project page expands the same components (§7.5).
 *
 * That placement is the whole of this function: the rows, each with the anchor its card is drawn
 * at. It used to be a component that rendered them as a block under the transcript, which is where
 * a card with no moment of its own belongs and the one place a card WITH one must not go — an
 * exception that became the owner's thirty-four minutes ago sat under the newest message in the
 * conversation, reading `waiting 34m` while sitting as if it had just happened. The moment is
 * `escalatedAt`, the instant the clock handed the item over and what the card's own heading counts
 * from, and `waitingSince` where the read does not say (an item that was never the coordinator's
 * has no escalation instant). Both native clients place these two cards by the same field
 * (`DeliveryAnchor.exception` → `ReceiptAnchor.place`), so the ends cannot disagree about where the
 * same exception happened.
 *
 * Drawn in `ordered`'s order, which the transcript preserves for rows sharing an anchor (the pause
 * still leads). A stamp no clock can parse gives a null anchor, which the host drops — the same
 * three answers `decisionReceiptAnchor` gives everywhere else.
 */
export function exceptionCardRows(
  items: ProjectOpenItemsView | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
): Array<{ row: ProjectOpenItemRow; anchor: ReceiptPlacement | null }> {
  return ordered(items).map((row) => ({
    row,
    anchor: decisionReceiptAnchor(events, row.escalatedAt ?? row.waitingSince),
  }));
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
  // The settled ones too (§4.7 H5): a card the conversation drew while the coordinator handled it
  // stays at the moment it happened and says how it ended, rather than vanishing from under the
  // reader the moment its rerun lands.
  const all = [
    ...(items?.needsYou ?? []),
    ...(items?.withCoordinator ?? []),
    ...(items?.settled ?? []),
  ];
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
        {/* §4.7 H1: the coordinator's rerun of it, while it runs — the row is still open, and says
            so rather than "handled". */}
        {row.handling ? (
          <div className="project-open-item-line is-handling" title={row.handling.reason}>
            <span className="project-open-item-state is-handling">{HANDLING_TAG}</span>
            {` ${handlingLine(row, row.handling, now)}`}
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
 * The coordinator's request to start the project, as the Needs you group's row (mock board3 ②):
 * "Start this project?", what it suggests, and Review — which goes to the one place the request is
 * answered, the card in the coordinator conversation, rather than drawing a second copy of it here.
 * The server lists no door for it (`actions` is empty for this kind), so the press is the page's.
 */
function StartRequestRowView({
  row,
  now,
  onReview,
  reviewing,
}: {
  row: ProjectOpenItemRow;
  now: number;
  onReview?: () => void;
  reviewing?: boolean;
}): JSX.Element {
  const settings = row.startRequest?.settings ?? null;
  const line = settings ? startRequestSummary(settings) : row.detailLine;
  return (
    <li className="project-open-item-row is-owner" data-kind="START_REQUEST">
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <div className="project-open-item-title" title={START_PROJECT_TITLE}>
          {START_PROJECT_TITLE}
        </div>
        {line ? (
          <div className="project-open-item-line" title={line}>
            {line}
          </div>
        ) : null}
      </div>
      <div className="project-open-item-who">
        <span>{WHO.OWNER}</span>
        <time className="project-open-item-age" dateTime={row.waitingSince}>
          {waitingLabel(row, now)}
        </time>
      </div>
      <div className="project-open-item-press">
        {onReview ? (
          <button
            type="button"
            className="project-open-item-action is-primary"
            disabled={reviewing}
            onClick={onReview}
          >
            {ACTION_LABEL.REVIEW}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The same row while no coordinator has asked: the owner's own way to start the project, quiet,
 *  because nobody is waiting on it — and it opens the same card, set by the default rule. */
function OwnStartRowView({ onStart }: { onStart: () => void }): JSX.Element {
  return (
    <li className="project-open-item-row is-owner is-own-start" data-kind="START">
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <button type="button" className="project-open-item-title project-open-item-start" onClick={onStart}>
          {START_ROW_OWN}
        </button>
        <div className="project-open-item-line">{START_ROW_NOT_ASKED}</div>
      </div>
      <div className="project-open-item-who" />
      <div className="project-open-item-press" />
    </li>
  );
}

/** The owner-facing DONE_REQUEST row opens the same settlement card as the transcript. */
function DoneRequestRowView({
  row,
  now,
  onReview,
  reviewing,
}: {
  row: ProjectOpenItemRow;
  now: number;
  onReview?: () => void;
  reviewing?: boolean;
}): JSX.Element {
  const detail = row.doneRequest
    ? `${PROJECT_DONE_COPY.openItemsDoneRequest} · ${row.doneRequest.gaps.length} ${PROJECT_DONE_COPY.gapsItCouldntProve}`
    : row.detailLine;
  return (
    <li className="project-open-item-row is-owner project-open-item-done-request" data-kind="DONE_REQUEST">
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <div className="project-open-item-state is-ready-to-close">{PROJECT_DONE_COPY.readyToClose}</div>
        <div className="project-open-item-title" title={PROJECT_DONE_COPY.heading}>{PROJECT_DONE_COPY.heading}</div>
        {detail ? <div className="project-open-item-line" title={detail}>{detail}</div> : null}
      </div>
      <div className="project-open-item-who">
        <span>{WHO.OWNER}</span>
        <time className="project-open-item-age" dateTime={row.waitingSince}>{waitingLabel(row, now)}</time>
      </div>
      <div className="project-open-item-press">
        {onReview ? (
          <button type="button" className="project-open-item-action is-primary" disabled={reviewing} onClick={onReview}>
            {ACTION_LABEL.REVIEW}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The owner's own "Record as done…" while no coordinator has asked: a grey hint, because nobody is
 *  waiting on it — so it is not counted with what needs them. */
function OwnDoneRowView({ onRecord }: { onRecord: () => void }): JSX.Element {
  return (
    <li className="project-open-item-row is-owner is-own-start is-hint project-open-item-done-own" data-kind="DONE">
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <button type="button" className="project-open-item-title project-open-item-start" onClick={onRecord}>
          {PROJECT_DONE_COPY.recordAsDoneRow}
        </button>
        <div className="project-open-item-line">{PROJECT_DONE_COPY.notAskedYet}</div>
      </div>
      <div className="project-open-item-who" />
      <div className="project-open-item-press" />
    </li>
  );
}

/**
 * The coordinator's open DONE_REQUEST, as the open-items entry `ProjectOpenItems` polls holds it, or
 * null. A passive read of that one cache line: it starts no request and adds no entry of its own.
 */
export function useOpenDoneRequest(projectId: string | null | undefined): ProjectOpenItemRow | null {
  const qc = useQueryClient();
  const subscribe = useCallback((onChange: () => void) => qc.getQueryCache().subscribe(onChange), [qc]);
  const read = (): ProjectOpenItemRow | null => (
    projectId
      ? (qc.getQueryData(projectOpenItemsQuery(projectId).queryKey)?.doneRequest ?? null)
      : null
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The project page's Open items card (mock 2 ②): what is waiting, in the two groups that say who is
 * expected to act, oldest first in both.
 *
 * The two groups are the whole point of the card. "Three things need you and two are being handled"
 * is a different project from "five things are stuck", and before this the page could not tell the
 * reader which one they were looking at.
 *
 * A project nobody has started leads its Needs you group with the start (mock board3 ②): the
 * coordinator's request when there is one — served beside the items rather than among them
 * (`startRequest`) — and otherwise the owner's own "Start…".
 */
export function ProjectOpenItems({
  projectId,
  now = Date.now(),
  started,
  onReviewStart,
  reviewingStart,
  onStartProject,
  onReviewDone,
  reviewingDone,
  onRecordDone,
}: {
  projectId: string | null | undefined;
  now?: number;
  /** Whether the project has been started, from the document the page holds. Only `false` draws
   *  the start's row: a read that does not say is not a project waiting to be started. */
  started?: boolean | null;
  /** Review on the coordinator's request: into its conversation, onto the card. */
  onReviewStart?: () => void;
  reviewingStart?: boolean;
  /** Start… while nobody has asked: the same card, over the page. */
  onStartProject?: () => void;
  onReviewDone?: () => void;
  reviewingDone?: boolean;
  onRecordDone?: () => void;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // The pause is drawn as a card above the groups and counted in neither: it is not something
  // waiting on a person the way the rows are, it is the reason some of them are waiting.
  const paused = (items.data?.needsYou ?? []).filter((row) => row.kind === 'FUSE_PAUSED');
  const start = startPageRow(started, items.data);
  const startRequest = start?.kind === 'asked' ? start.row : null;
  const doneRequest = items.data?.doneRequest ?? null;
  const needsYou = [
    ...(startRequest ? [startRequest] : []),
    ...(doneRequest ? [doneRequest] : []),
    ...(items.data?.needsYou ?? []).filter((row) => row.kind !== 'FUSE_PAUSED' && row.kind !== 'DONE_REQUEST'),
  ];
  const withCoordinator = items.data?.withCoordinator ?? [];
  const ownStart = start?.kind === 'own' && onStartProject ? onStartProject : null;
  const ownDone = items.data !== undefined && !doneRequest && onRecordDone ? onRecordDone : null;
  if (
    !projectId
    || (paused.length + needsYou.length + withCoordinator.length === 0 && !ownStart && !ownDone)
  ) return null;

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
      {needsYou.length > 0 || ownStart || ownDone ? (
        <>
          <div className="project-open-items-group">{NEEDS_YOU_GROUP}</div>
          <ul className="project-open-items-list">
            {ownStart ? <OwnStartRowView onStart={ownStart} /> : null}
            {ownDone ? <OwnDoneRowView onRecord={ownDone} /> : null}
            {needsYou.map((row) =>
              row === startRequest ? (
                <StartRequestRowView
                  key={row.itemId}
                  row={row}
                  now={now}
                  onReview={onReviewStart}
                  reviewing={reviewingStart}
                />
              ) : row === doneRequest ? (
                <DoneRequestRowView
                  key={row.itemId}
                  row={row}
                  now={now}
                  onReview={onReviewDone}
                  reviewing={reviewingDone}
                />
              ) : (
                <OpenItemRowView key={row.itemId} row={row} now={now} />
              ),
            )}
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
