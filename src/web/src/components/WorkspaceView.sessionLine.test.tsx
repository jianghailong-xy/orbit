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
    ).toEqual({ text: '设置按钮的底色很奇怪，请帮我 review', tone: 'preview' });
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
    // Trash (live: false) states the outcome the same way.
    expect(sessionLine({ status: 'CANCELLED', endReason: 'completed' }, false)).toEqual({
      text: 'Completed',
      tone: 'preview',
    });
  });
});
