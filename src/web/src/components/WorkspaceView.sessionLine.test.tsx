import { describe, expect, it } from 'vitest';
import { sessionLine } from './WorkspaceView';

/**
 * The session row's second line. Kept in step with the native port
 * (`OrbitKit/App/SessionLine.swift` + `SessionLineTests`) — the two are hand-synced, so the same
 * cases are asserted on both sides.
 */
describe('sessionLine', () => {
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
