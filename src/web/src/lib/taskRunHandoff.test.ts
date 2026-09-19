import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { encodeId } from './idCodec';
import {
  CLEAR_THE_PIN,
  KEEP_IT_RUNNING,
  OPEN_THE_RUN,
  RETRY_ENTRY_LABEL,
  RUN_ENTRY_LABEL,
  STOP_AND_CONTINUE,
  TASK_RUN_ENDING_TITLE,
  TASK_RUN_HANDED_OVER_TITLE,
  TASK_RUN_HELD_TITLE,
  TASK_RUN_PIN_TITLE,
  TASK_RUN_RESEND_MAX_ATTEMPTS,
  providerSwitchNote,
  stillHeldAfterWaiting,
  readTaskRunConflict,
  routedToSession,
  stopSessionIdFor,
  taskRunEntry,
} from './taskRunHandoff';

const RUN = '4eOMnBRmZbsZpBHpqfoBbT';
const TASK = '5Tkrnx1kbOyLZdlRiVN4Og';

/** The English the server writes, verbatim from `tasks/task-run-receipt.ts#taskAlreadyRunning`. */
const RAW_ALREADY_RUNNING =
  `task ${TASK} could not be started: session ${RUN} (RUNNING) holds its execution claim. `
  + 'Let that run reach a terminal status of its own, then start the task again';
/** …and from `#taskRunPinConflict`. */
const RAW_PIN_CONFLICT =
  `task ${TASK} is pinned to deepseek, but session ${RUN} holds its execution claim on claude. `
  + "A running session's provider is not switched under it; let it reach a terminal status of its "
  + 'own, and the next attempt starts on the pinned one';

const alreadyRunning = (extra: Record<string, unknown> = {}): ApiError =>
  new ApiError(RAW_ALREADY_RUNNING, 409, 'TASK_ALREADY_RUNNING', {
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_ALREADY_RUNNING',
    message: RAW_ALREADY_RUNNING,
    owner: 'USER',
    taskId: TASK,
    conflictingSessionId: RUN,
    conflictingSessionStatus: 'RUNNING',
    conflictingSessionEnding: false,
    retryable: true,
    ...extra,
  });

const pinConflict = (): ApiError =>
  new ApiError(RAW_PIN_CONFLICT, 409, 'TASK_RUN_PIN_CONFLICT', {
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_PIN_CONFLICT',
    message: RAW_PIN_CONFLICT,
    owner: 'USER',
    taskId: TASK,
    conflictingSessionId: RUN,
    pinnedTo: 'deepseek',
    runningOn: 'claude',
    retryable: true,
  });

const switchConfirmation = (): ApiError =>
  new ApiError('…the English nobody should read…', 409, 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED', {
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED',
    message: '…the English nobody should read…',
    owner: 'USER',
    confirmationRequired: true,
    confirm: { field: 'stopSessionId', value: RUN },
    runningProvider: 'claude',
    requestedProvider: 'deepseek',
    taskId: TASK,
    conflictingSessionId: RUN,
    conflictingSessionStatus: 'RUNNING',
    retryable: false,
  });

/** Every word of prose this conflict would put on screen, so "the raw sentence" can be ruled out. */
const shown = (conflict: { title: string; body: string; actions: readonly { label: string }[] }) =>
  [conflict.title, conflict.body, ...conflict.actions.map((a) => a.label)].join(' — ');

describe('a message sent into a run that no longer holds the task', () => {
  it('follows the server to the run that took it, instead of painting it here', () => {
    // 2.1 of docs/session-message-routing-contract.md: the field's PRESENCE is the fact.
    expect(routedToSession({ turnId: 't', seq: 12, routedToSessionId: RUN })).toBe(RUN);
    expect(routedToSession({ turnId: 't', seq: 12 })).toBeNull();
    expect(routedToSession(undefined)).toBeNull();
  });

  it('names where the message went in words, with the run one click away', () => {
    const handed = readTaskRunConflict(alreadyRunning());
    expect(handed).not.toBeNull();
    expect(handed!.kind).toBe('HELD');
    expect(handed!.title).toBe(TASK_RUN_HELD_TITLE);
    // The whole point: not one word of the server's sentence reaches the screen.
    expect(shown(handed!)).not.toContain('execution claim');
    expect(shown(handed!)).not.toContain('terminal status');
    expect(shown(handed!)).not.toContain(TASK);
    expect(shown(handed!)).not.toContain(RUN);
    // …and there is a way out, pointing at the run that actually has the task.
    const open = handed!.actions.find((a) => a.kind === 'OPEN_RUN');
    expect(open).toBeDefined();
    expect(open!.label).toBe(OPEN_THE_RUN);
    expect(open!.href).toBe(`/sessions/${encodeId(RUN)}`);
    expect(handed!.sessionId).toBe(RUN);
    // The task comes through too: a way out that edits the task needs to know which one.
    expect(handed!.taskId).toBe(TASK);
  });

  it('separates a run that is working from one that is on its way out', () => {
    // 2.3: `conflictingSessionEnding` used to shape only the English. The message is still in
    // hand, so this one resends itself rather than asking the reader to do anything.
    const ending = readTaskRunConflict(alreadyRunning({ conflictingSessionEnding: true }));
    expect(ending!.kind).toBe('ENDING');
    expect(ending!.title).toBe(TASK_RUN_ENDING_TITLE);
    expect(ending!.resendAfterMs).toBeGreaterThan(0);
    expect(shown(ending!)).not.toContain('execution claim');
    // A run that is working frees nothing by waiting, so it never offers to resend itself.
    expect(readTaskRunConflict(alreadyRunning())!.resendAfterMs).toBeUndefined();

    // Waiting is a plan for a bounded while. Past that the honest reading is that the run is
    // still there — same run, same way out, without the promise the ENDING wording makes.
    expect(TASK_RUN_RESEND_MAX_ATTEMPTS).toBeGreaterThan(0);
    const gaveUp = stillHeldAfterWaiting(ending!);
    expect(gaveUp.kind).toBe('HELD');
    expect(gaveUp.title).toBe(TASK_RUN_HELD_TITLE);
    expect(gaveUp.resendAfterMs).toBeUndefined();
    expect(gaveUp.sessionId).toBe(RUN);
    expect(gaveUp.actions).toEqual(ending!.actions);
  });

  it('gives a pin conflict its own words and its own second way out', () => {
    const pin = readTaskRunConflict(pinConflict());
    expect(pin!.kind).toBe('PIN');
    expect(pin!.title).toBe(TASK_RUN_PIN_TITLE);
    expect(shown(pin!)).not.toContain('execution claim');
    expect(shown(pin!)).not.toContain(RUN);
    // Named providers survive: they are what the reader is choosing between.
    expect(pin!.body).toContain('deepseek');
    expect(pin!.body).toContain('claude');
    expect(pin!.actions.map((a) => a.kind)).toEqual(['OPEN_RUN', 'CLEAR_PIN']);
    expect(pin!.actions[0].href).toBe(`/sessions/${encodeId(RUN)}`);
    expect(pin!.actions[1].label).toBe(CLEAR_THE_PIN);
    expect(pin!.taskId).toBe(TASK);
  });

  it('still shows the server its own words when it says something this end has never heard of', () => {
    // An older apiserver (no `code` at all), and a newer one with a code this build predates.
    expect(readTaskRunConflict(new ApiError(RAW_ALREADY_RUNNING, 409))).toBeNull();
    expect(readTaskRunConflict(new ApiError('task is settled', 409, 'PROJECT_SETTLED'))).toBeNull();
    expect(readTaskRunConflict(new ApiError('later', 409, 'TASK_RUN_SOMETHING_NEW'))).toBeNull();
    // Not an ApiError at all, and a 409-shaped plain object, are both somebody else's business.
    expect(readTaskRunConflict(new TypeError('Failed to fetch'))).toBeNull();
    expect(readTaskRunConflict({ status: 409, code: 'TASK_ALREADY_RUNNING' })).toBeNull();
  });
});

describe('switching provider on a task that is already going', () => {
  it('says when the switch takes effect rather than flashing the new model', () => {
    // A run in flight keeps its provider for its whole life, so the pick lands on the NEXT turn.
    const withRun = providerSwitchNote({ from: 'claude', to: 'deepseek', liveRun: true });
    expect(withRun).not.toBeNull();
    expect(withRun).toContain('deepseek');
    expect(withRun).toContain('next');
    // Nothing is going, so there is no "this turn" to finish and no next one to wait for.
    const noRun = providerSwitchNote({ from: 'claude', to: 'deepseek', liveRun: false });
    expect(noRun).not.toBeNull();
    expect(noRun).not.toBe(withRun);
    expect(noRun).toContain('deepseek');
    // Picking what is already running changes nothing, and says nothing.
    expect(providerSwitchNote({ from: 'claude', to: 'claude', liveRun: true })).toBeNull();
    expect(providerSwitchNote({ from: null, to: 'claude', liveRun: false })).toBeNull();
  });

  it('asks before stopping the run, and stops nothing until it is answered', () => {
    const ask = readTaskRunConflict(switchConfirmation());
    expect(ask!.kind).toBe('CONFIRM_SWITCH');
    expect(shown(ask!)).not.toContain('the English nobody should read');
    // Both providers are named, because that is the choice being made.
    expect(ask!.body).toContain('claude');
    expect(ask!.body).toContain('deepseek');
    expect(ask!.actions.map((a) => a.kind)).toEqual(['STOP_AND_CONTINUE', 'KEEP_RUNNING']);
    expect(ask!.actions[0].label).toBe(STOP_AND_CONTINUE);
    expect(ask!.actions[1].label).toBe(KEEP_IT_RUNNING);
    // The confirmation names the run it is about, so a claim that changed hands asks again.
    expect(ask!.confirm).toEqual({ field: 'stopSessionId', value: RUN });

    // …and the request carries it only once the reader has said so.
    expect(stopSessionIdFor(ask!, false)).toBeUndefined();
    expect(stopSessionIdFor(ask!, true)).toBe(RUN);
    // Never pre-armed off some other conflict: only this one authorises a stop.
    expect(stopSessionIdFor(readTaskRunConflict(alreadyRunning()), true)).toBeUndefined();
    expect(stopSessionIdFor(null, true)).toBeUndefined();
  });
});

describe('the entry a task offers while a run of it is going', () => {
  const live = { id: RUN, status: 'RUNNING' };

  it('points at the run in flight instead of a retry that cannot be accepted', () => {
    const entry = taskRunEntry({ status: 'IN_PROGRESS', running: true, sessions: [live] });
    expect(entry.kind).toBe('OPEN_RUN');
    expect(entry.label).toBe(OPEN_THE_RUN);
    expect(entry.href).toBe(`/sessions/${encodeId(RUN)}`);
  });

  it('reads the live run, not the status this end last wrote down', () => {
    // The reported case: the row still says FAILED because the platform re-dispatched the task
    // two seconds later and this tab has not caught up. Pressing Retry here is the 409.
    const stale = taskRunEntry({ status: 'FAILED', running: true, sessions: [live] });
    expect(stale.kind).toBe('OPEN_RUN');
    expect(stale.href).toBe(`/sessions/${encodeId(RUN)}`);
    // A row that carries no session list still knows a run is going, and says so without
    // pretending to know which one.
    const rowOnly = taskRunEntry({ status: 'FAILED', running: true });
    expect(rowOnly.kind).toBe('OPEN_RUN');
    expect(rowOnly.href).toBeNull();
    // Queued counts: it holds the task's claim just as a running one does.
    expect(taskRunEntry({ status: 'FAILED', queued: true }).kind).toBe('OPEN_RUN');
    // A session list is ground truth on its own, for a caller with no `running` flag.
    expect(taskRunEntry({ status: 'FAILED', sessions: [live] }).kind).toBe('OPEN_RUN');
  });

  it('is still a retry when nothing is going', () => {
    const failed = taskRunEntry({
      status: 'FAILED',
      running: false,
      queued: false,
      sessions: [{ id: RUN, status: 'FAILED' }],
    });
    expect(failed.kind).toBe('RETRY');
    expect(failed.label).toBe(RETRY_ENTRY_LABEL);
    expect(failed.href).toBeNull();
    const open = taskRunEntry({ status: 'OPEN', running: false, queued: false, sessions: [] });
    expect(open.kind).toBe('RUN');
    expect(open.label).toBe(RUN_ENTRY_LABEL);
  });
});

describe('the words this end uses', () => {
  it('keeps the handover heading distinct from the refusal it replaced', () => {
    // 2.1 is a SUCCESS — the message was delivered — and 2.3/2.4 are not. One heading for both
    // would tell a reader whose message did land that something went wrong.
    expect(TASK_RUN_HANDED_OVER_TITLE).not.toBe(TASK_RUN_HELD_TITLE);
    for (const copy of [
      TASK_RUN_HANDED_OVER_TITLE,
      TASK_RUN_HELD_TITLE,
      TASK_RUN_ENDING_TITLE,
      TASK_RUN_PIN_TITLE,
      OPEN_THE_RUN,
      CLEAR_THE_PIN,
      STOP_AND_CONTINUE,
      KEEP_IT_RUNNING,
    ]) {
      expect(copy.trim()).toBe(copy);
      expect(copy.length).toBeGreaterThan(0);
    }
  });
});
