import { describe, expect, it } from 'vitest';
import { sessionLine, statusLabel } from './WorkspaceView';

/**
 * The session row's second line. Kept in step with the native port
 * (`OrbitKit/App/SessionLine.swift` + `SessionLineTests`) — the two are hand-synced, so the same
 * cases are asserted on both sides.
 */
describe('sessionLine', () => {
  it('prioritizes a canonical completion-receipt obligation over every Running hint', () => {
    const session = {
      status: 'RUNNING',
      engineStartedAt: null,
      pendingApprovals: 2,
      lastToolUse: 'Bash',
      lastUserText: 'rerun it',
      controlPlaneObligations: [
        {
          obligationId: 'obl-ack-1',
          obligationRevision: 3,
          reason: 'The successful completion receipt has not committed.',
          owner: 'PROJECT_COORDINATOR',
          requiredAction: 'Repair the compatibility writer and recover the original callback.',
          actionProtocol: ['diagnose', 'repair', 'deploy', 'verify'],
          firstFailureAt: '2026-08-28T13:45:50.000Z',
          latestFailureAt: '2026-08-28T13:50:00.000Z',
          observationCount: 126,
          factKind: 'CONTROL_PLANE_COMMIT_REJECTED',
          errorFingerprint: 'P0001:TASK_DONE_CANONICAL_FACT_REQUIRED',
        },
      ],
    };

    expect(sessionLine(session, true)).toEqual({
      text: 'Command finished · completion receipt retrying',
      tone: 'approval',
    });
    expect(statusLabel(session)).toBe('Completion receipt retrying');
  });

  it('surfaces live state before any reply preview', () => {
    expect(sessionLine({ status: 'RUNNING', pendingApprovals: 2 }, true)).toEqual({
      text: 'Waiting for approval',
      tone: 'approval',
    });
    expect(
      sessionLine({ status: 'RUNNING', lastToolUse: 'mcp__orbit__task_create' }, true),
    ).toEqual({ text: 'Running task_create…', tone: 'running' });
    expect(sessionLine({ status: 'RUNNING' }, true)).toEqual({ text: 'Running…', tone: 'running' });
  });

  /**
   * A turn the runtime started for itself — a background task reporting in, a scheduled wake-up —
   * never reaches /turn-complete, so the session stays parked at AWAITING_INPUT while it streams.
   * The row must say what it is doing rather than fall through to the previous reply, which reads
   * as idle.
   */
  it('reads a self-driven turn as working, not as parked', () => {
    expect(
      sessionLine(
        {
          status: 'AWAITING_INPUT',
          engineTurnActive: true,
          lastToolUse: 'Bash',
          lastAssistantText: 'Waiting for the completion notification.',
        },
        true,
      ),
    ).toEqual({ text: 'Running Bash…', tone: 'running' });
    // Between tools there is no frontier tool, and the stale reply would read as idle.
    expect(sessionLine({ status: 'AWAITING_INPUT', engineTurnActive: true }, true)).toEqual({
      text: 'Running…',
      tone: 'running',
    });
    // Once the turn ends the server clears the flag and the reply preview takes over again.
    expect(
      sessionLine(
        { status: 'AWAITING_INPUT', engineTurnActive: false, lastAssistantText: 'All done.' },
        true,
      ),
    ).toEqual({ text: 'All done.', tone: 'preview' });
  });

  /**
   * The whole point of the line while a turn runs: it says whether what you sent has been answered
   * yet. The message is server-kept from the moment it is enqueued (SessionsService.createTurn) —
   * so it stands through the wait for a slot and through the tool phase — and it is marked as
   * yours, because unmarked it reads exactly like a reply to it.
   */
  it('shows the message you sent, marked as yours, until a reply lands', () => {
    expect(
      sessionLine(
        { status: 'RUNNING', lastAssistantText: 'previous reply', lastUserText: 'fix the drawer shadow' },
        true,
      ),
    ).toEqual({ text: 'You: fix the drawer shadow', tone: 'preview' });
    // A tool in flight still outranks it — that's what the session is doing right now.
    expect(
      sessionLine({ status: 'RUNNING', lastToolUse: 'Bash', lastUserText: 'fix the drawer shadow' }, true),
    ).toEqual({ text: 'Running Bash…', tone: 'running' });
    // The server clears it once the workspace answers, and the reply takes the line back.
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'On it — reading the CSS.' }, true)).toEqual({
      text: 'On it — reading the CSS.',
      tone: 'preview',
    });
  });

  it('flattens the last reply into one prose line', () => {
    expect(
      sessionLine({ status: 'AWAITING_INPUT', lastAssistantText: '## Done\n\nFixed `Session`.' }, true),
    ).toEqual({ text: 'Done Fixed Session.', tone: 'preview' });
  });

  /**
   * A turn interrupted before the workspace said anything leaves the message you sent standing — the
   * server only clears `lastUserText` once the workspace actually answers — and it outranks the older
   * reply below it.
   */
  it('shows an unanswered message ahead of the previous reply', () => {
    expect(
      sessionLine(
        {
          status: 'INTERRUPTED',
          lastAssistantText: 'previous reply',
          lastUserText: '设置按钮的底色很奇怪，请帮我 review',
        },
        true,
      ),
    ).toEqual({ text: 'You: 设置按钮的底色很奇怪，请帮我 review', tone: 'preview' });
  });

  /**
   * Nothing to preview at all: the line falls back to the run's own state word rather than
   * vanishing. A missing line shortens the row on iOS, where the row is sized by its content.
   */
  it('falls back to the run state word when there is nothing to preview', () => {
    expect(sessionLine({ status: 'SUCCEEDED' }, true)).toEqual({
      text: 'Succeeded',
      tone: 'preview',
    });
    expect(sessionLine({ status: 'FAILED' }, true)).toEqual({ text: 'Failed', tone: 'preview' });
    expect(sessionLine({ status: 'INTERRUPTED' }, true)).toEqual({
      text: 'Interrupted',
      tone: 'preview',
    });
    // Trash (live: false) states the outcome the same way. The word is the *run's*: every
    // deliberate end is one neutral terminal regardless of endReason (sessionRunStateOf), and
    // "Completed" is the filing axis — sessionLifecycleLabel says that one, next to this.
    expect(sessionLine({ status: 'CANCELLED', endReason: 'completed' }, false)).toEqual({
      text: 'Ended',
      tone: 'preview',
    });
  });
});

/**
 * The row for a session that holds a slot but whose engine is not up yet. Measured on this
 * deployment it is ~3.3s of every start (against ~50ms actually queued), and it used to render as
 * the message echoed back under a working spinner — which reads as "the agent has your prompt".
 */
describe('sessionLine while the engine is starting', () => {
  it('says it is starting rather than echoing the prompt back', () => {
    expect(
      sessionLine(
        { status: 'RUNNING', engineStartedAt: null, lastUserText: 'ship it' },
        true,
      ),
    ).toEqual({ text: 'Starting…', tone: 'running' });
  });

  it('goes back to the ordinary live line once the engine has spoken', () => {
    expect(
      sessionLine(
        {
          status: 'RUNNING',
          engineStartedAt: '2026-08-24T17:07:37.170Z',
          lastToolUse: 'Read',
        },
        true,
      ),
    ).toEqual({ text: 'Running Read…', tone: 'running' });
  });

  // The rolling-upgrade case: a control plane that never sends the field must not park every
  // running session under a startup label. Absent is not null.
  it('keeps the old behaviour for a payload that never carried the field', () => {
    expect(sessionLine({ status: 'RUNNING' }, true)).toEqual({
      text: 'Running…',
      tone: 'running',
    });
  });

  // Starting is a refinement of RUNNING; a queued session has no engine to be starting. The row
  // carries `queuedReason: null` because that is what a current server sends for an ungated
  // queued session — omitting it here would exercise the old-server fallback instead.
  it('does not pre-empt the queued line', () => {
    expect(
      sessionLine({ status: 'PENDING', engineStartedAt: null, queuedReason: null }, true),
    ).toEqual({ text: 'Queued', tone: 'queued' });
  });
});

describe('sessionLine names the gate holding a queued session', () => {
  it('says the runner is offline instead of blaming a slot', () => {
    expect(sessionLine({ status: 'PENDING', queuedReason: 'runner_offline' }, true)).toEqual({
      text: 'Runner offline',
      tone: 'queued',
    });
  });

  it('keeps slot wording when a slot really is what is missing', () => {
    expect(
      sessionLine({ status: 'PENDING', queuedReason: 'runner_at_capacity' }, true),
    ).toEqual({ text: 'Waiting for slot', tone: 'queued' });
  });
});
