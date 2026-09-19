import { ApiError } from '../api';
import { encodeId } from './idCodec';

/**
 * What this end says when a message, or a Run, meets the run that actually holds a task.
 *
 * One task has one run at a time — `session_task_execution_claim_idx` makes that a property of the
 * database — and the platform re-dispatches a failed task within seconds. So the session somebody
 * is looking at stops being the task's current run without anything on their screen changing, and
 * the next thing they send meets a refusal written for a program:
 *
 *     task 5Tkr… could not be started: session 6vVU… (RUNNING) holds its execution claim. Let
 *     that run reach a terminal status of its own, then start the task again
 *
 * Every client used to put that sentence on screen verbatim, because `message.error(e.message)` is
 * all a caller can do with an Error. The refusals were already STRUCTURED — a stable `code`, the
 * run in the way as a public id, whether it is on its way out — and `ApiError` already carries the
 * whole body; the structure was simply being thrown away one layer above it. This is the layer that
 * reads it: a code in, words and a way out back.
 *
 * Read BY CODE, never by prose. Several unrelated 409s reach the same handlers, and a build that
 * branched on the sentence would start showing the wrong card the first time somebody reworded it.
 * A code this build has never heard of — an older server that sends none at all, a newer one that
 * has grown a case — comes back null, and the caller shows the server's own words. That fallback is
 * the point rather than a leftover: a refusal nobody translated is still better read than swallowed.
 *
 * The request half of the same contract is `docs/session-message-routing-contract.md`, which the
 * apiserver holds up with `sessions/resume-routes-to-current-run.pg.spec.ts`.
 *
 * The strings are DECLARED, not written inline, because the macOS client says the same things about
 * the same answers and nothing between the two would catch them drifting apart — its parity test
 * reads this file.
 */

/** 2.1: the message was delivered, to the run that has the task rather than the one it was sent in. */
export const TASK_RUN_HANDED_OVER_TITLE = 'Sent to the run working on this task';
export const TASK_RUN_HANDED_OVER_BODY =
  'This session was replaced by a newer run, so your message went there.';

/** 2.4, and the Run button: the task is taken, and waiting is not what fixes it. */
export const TASK_RUN_HELD_TITLE = 'A newer run has this task';
export const TASK_RUN_HELD_BODY =
  'Another run is working on this task, so this one cannot take it. Open the run that has it and '
  + 'carry on there.';

/** 2.3: the run in the way is on its way out, so this settles itself in a moment. */
export const TASK_RUN_ENDING_TITLE = 'That run is stopping';
export const TASK_RUN_ENDING_BODY =
  'The run working on this task is on its way out. Nothing is lost — this goes through as soon as '
  + 'it lets go.';

export const TASK_RUN_PIN_TITLE = 'This task is pinned to a different provider';

export const TASK_RUN_SWITCH_TITLE = 'Stop the run that is going?';

export const OPEN_THE_RUN = 'Open the run';
export const CLEAR_THE_PIN = "Clear the task's pin";
export const STOP_AND_CONTINUE = 'Stop it and continue';
export const KEEP_IT_RUNNING = 'Keep it running';

/** The two entries a task offers when nothing of it is going — unchanged, and named here so the
 *  third one is chosen against them in one place. */
export const RUN_ENTRY_LABEL = 'Run';
export const RETRY_ENTRY_LABEL = 'Retry';
export const OPEN_RUN_ENTRY_HINT = 'A run of this task is going — open it';

/** How long to hold a message whose holder is letting go. The server's own
 *  `TASK_RUN_RETRY_AFTER_SECONDS`; a resend before that meets the same answer. */
export const TASK_RUN_RESEND_AFTER_MS = 2000;

/**
 * How many times waiting is a plan.
 *
 * A run that is letting go normally frees the task within a couple of seconds, so a handful of
 * resends covers it. Past that, whatever is holding the engine is not the shutdown this was
 * waiting for, and a client that went on resending would be a request every two seconds for as
 * long as the tab stays open — on exactly the page somebody leaves open while they go and look at
 * something else. So it stops, and says the true thing instead: the run is still there.
 */
export const TASK_RUN_RESEND_MAX_ATTEMPTS = 5;

/**
 * The same refusal, re-read once waiting has stopped being a plan.
 *
 * Not a second server answer — nothing new was learned — but this end's own account of a holder
 * that did not let go. It keeps the run it named, so the way out is the same one click it always
 * was, and drops the promise the ENDING wording makes.
 */
export function stillHeldAfterWaiting(conflict: TaskRunConflict): TaskRunConflict {
  const { resendAfterMs: _dropped, ...rest } = conflict;
  return { ...rest, kind: 'HELD', title: TASK_RUN_HELD_TITLE, body: TASK_RUN_HELD_BODY };
}

/**
 * Which of the four situations this is — chosen by what the reader has to DO, not by status code.
 *
 * `HELD` and `ENDING` are one code (`TASK_ALREADY_RUNNING`) and separated by a field, because the
 * status alone cannot tell them apart: a run being cancelled has `cancel_requested_at` set and is
 * still RUNNING. Waiting fixes one of them and nothing but opening the other fixes the other.
 */
export type TaskRunConflictKind = 'HELD' | 'ENDING' | 'PIN' | 'CONFIRM_SWITCH';

export interface TaskRunConflictAction {
  kind: 'OPEN_RUN' | 'CLEAR_PIN' | 'STOP_AND_CONTINUE' | 'KEEP_RUNNING';
  label: string;
  /** Where `OPEN_RUN` goes, when the answer named a run. Null on the others. */
  href: string | null;
}

export interface TaskRunConflict {
  kind: TaskRunConflictKind;
  title: string;
  body: string;
  /** The run in the way, as the public id the server named, or null if it named none. */
  sessionId: string | null;
  /** The task both runs are about, so a way out that edits the TASK (clearing its pin) has
   *  something to edit. Every one of these refusals names it. */
  taskId: string | null;
  actions: readonly TaskRunConflictAction[];
  /**
   * What to send back to answer a `CONFIRM_SWITCH`, straight from the server. It names the SESSION
   * rather than being a bare flag: the authorisation is for the run the person was shown, so a
   * claim that changed hands between question and answer asks again instead of being stopped on a
   * confirmation about a different run.
   */
  confirm?: { field: string; value: string };
  /** Present only on `ENDING`: resend the same message, unchanged, after this long. */
  resendAfterMs?: number;
}

const openRun = (sessionId: string | null): TaskRunConflictAction => ({
  kind: 'OPEN_RUN',
  label: OPEN_THE_RUN,
  href: sessionId ? sessionHref(sessionId) : null,
});

/** The route a run lives at. One spelling, so a link built here cannot drift from the Runs list's. */
export function sessionHref(sessionId: string): string {
  return `/sessions/${encodeId(sessionId)}`;
}

const str = (body: Record<string, unknown> | undefined, key: string): string | null => {
  const value = body?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export function readTaskRunConflict(error: unknown): TaskRunConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body;
  const sessionId = str(body, 'conflictingSessionId');
  const taskId = str(body, 'taskId');
  switch (error.code) {
    case 'TASK_ALREADY_RUNNING': {
      // A run that is letting go frees the task by itself, so this end waits rather than asking
      // the reader to do anything — the message is still in hand and has lost nothing.
      if (body?.conflictingSessionEnding === true) {
        return {
          kind: 'ENDING',
          title: TASK_RUN_ENDING_TITLE,
          body: TASK_RUN_ENDING_BODY,
          sessionId,
          taskId,
          actions: [openRun(sessionId)],
          resendAfterMs: TASK_RUN_RESEND_AFTER_MS,
        };
      }
      return {
        kind: 'HELD',
        title: TASK_RUN_HELD_TITLE,
        body: TASK_RUN_HELD_BODY,
        sessionId,
        taskId,
        actions: [openRun(sessionId)],
      };
    }
    case 'TASK_RUN_PIN_CONFLICT': {
      // The providers are the one part of the server's sentence worth keeping: they are what the
      // reader is choosing between, and neither of them is an id.
      const pinned = str(body, 'pinnedTo') ?? 'another provider';
      const running = str(body, 'runningOn') ?? 'a different one';
      return {
        kind: 'PIN',
        title: TASK_RUN_PIN_TITLE,
        body:
          `This task is pinned to ${pinned}, and the run working on it is on ${running}. A run `
          + `keeps its provider for its whole life, so ${pinned} starts with the next one.`,
        sessionId,
        taskId,
        actions: [
          openRun(sessionId),
          { kind: 'CLEAR_PIN', label: CLEAR_THE_PIN, href: null },
        ],
      };
    }
    case 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED': {
      const running = str(body, 'runningProvider') ?? 'another provider';
      const requested = str(body, 'requestedProvider') ?? 'the one you picked';
      const confirm = body?.confirm as { field?: unknown; value?: unknown } | undefined;
      return {
        kind: 'CONFIRM_SWITCH',
        title: TASK_RUN_SWITCH_TITLE,
        body:
          `This task is being worked on ${running}. A run keeps its provider for its whole life, `
          + `so continuing on ${requested} means stopping that one first — its branch and worktree `
          + 'are kept.',
        sessionId,
        taskId,
        actions: [
          { kind: 'STOP_AND_CONTINUE', label: STOP_AND_CONTINUE, href: null },
          { kind: 'KEEP_RUNNING', label: KEEP_IT_RUNNING, href: null },
        ],
        ...(typeof confirm?.field === 'string' && typeof confirm?.value === 'string'
          ? { confirm: { field: confirm.field, value: confirm.value } }
          : {}),
      };
    }
    default:
      // Including an older server, which sends no code at all. The caller shows `error.message`.
      return null;
  }
}

/**
 * Where a resume actually put the message, when that is not where it was sent.
 *
 * The field's PRESENCE is the fact (contract 2.1). Absent means the ordinary resume happened and
 * the message is in this session, which is what every build before this one assumed unconditionally
 * — so an older server keeps behaving exactly as it did.
 */
export function routedToSession(
  answer: { routedToSessionId?: string } | null | undefined,
): string | null {
  return answer?.routedToSessionId ?? null;
}

/**
 * The one thing that authorises stopping a run that is doing work.
 *
 * Only a `CONFIRM_SWITCH` carries one, and only once the reader has answered it. Never derived
 * from some other conflict that happens to name a session, and never remembered: stopping a run is
 * destructive, so every stop is its own answer to its own question.
 */
export function stopSessionIdFor(
  conflict: TaskRunConflict | null | undefined,
  confirmed: boolean,
): string | undefined {
  if (!confirmed || conflict?.kind !== 'CONFIRM_SWITCH') return undefined;
  return conflict.confirm?.value;
}

/**
 * What a provider pick in the composer will actually do, said while the pick is still standing.
 *
 * It replaced a four-second `Model → DeepSeek`, which named the change and not its timing — and
 * the timing is the whole question here, because a run keeps its provider for its whole life. With
 * something going, the pick cannot touch it and lands on the next turn; with nothing going, the
 * next message is the next turn. Null when there is nothing to say, which includes picking what is
 * already running: that is not a switch.
 */
export function providerSwitchNote({
  from,
  to,
  liveRun,
}: {
  /** What the session/run is on now, or null when this end does not know. */
  from: string | null;
  /** What the reader just picked. */
  to: string;
  /** A run of this task is going right now. */
  liveRun: boolean;
}): string | null {
  if (!from || !to || from === to) return null;
  return liveRun
    ? `The turn in flight finishes on ${from}. Your next one runs on ${to}.`
    : `Your next message runs on ${to}.`;
}

export interface TaskRunEntryView {
  kind: 'RUN' | 'RETRY' | 'OPEN_RUN';
  label: string;
  hint: string;
  /** The run to open, when this end knows which one it is; null when it only knows there is one. */
  href: string | null;
}

/**
 * What a task's row and its panel offer to press.
 *
 * The live run wins over `status`, and that ordering is the fix: `status` is a label a workspace
 * maintains and it lags, while `running`/`queued` are derived from the session rows on every read
 * (`tasks.service.ts#withRunning`). The reported failure is exactly that gap — a task failed, the
 * platform re-dispatched it two seconds later, and the row still said FAILED — so a Retry drawn
 * off the status is a button whose only possible answer is the 409 this file translates.
 *
 * A caller that carries the task's sessions gets a link to the run; a list row, which carries the
 * flags but no session, gets the same entry without one rather than a guess.
 */
export function taskRunEntry(task: {
  status: string;
  running?: boolean;
  queued?: boolean;
  sessions?: readonly { id: string; status: string }[];
}): TaskRunEntryView {
  const busy = (task.sessions ?? []).find((s) => s.status === 'RUNNING' || s.status === 'PENDING');
  if (task.running || task.queued || busy) {
    return {
      kind: 'OPEN_RUN',
      label: OPEN_THE_RUN,
      hint: OPEN_RUN_ENTRY_HINT,
      href: busy ? sessionHref(busy.id) : null,
    };
  }
  return task.status === 'FAILED'
    ? { kind: 'RETRY', label: RETRY_ENTRY_LABEL, hint: RETRY_ENTRY_LABEL, href: null }
    : { kind: 'RUN', label: RUN_ENTRY_LABEL, hint: RUN_ENTRY_LABEL, href: null };
}
