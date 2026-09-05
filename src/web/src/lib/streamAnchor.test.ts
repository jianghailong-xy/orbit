import { describe, expect, it } from 'vitest';
import { streamAnchorAfter, type StreamAnchorEvent } from './streamAnchor';

/**
 * Which side of the half-written reply a live event lands on.
 *
 * Two kinds of event arrive while a stretch of generation is running, and they belong on opposite
 * sides of it: a message the user typed mid-turn (echoed back with a higher seq) goes below the
 * bubble, a tool call the model itself made goes above it. Both are "later" by seq, so only the
 * anchor can tell them apart.
 */

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): StreamAnchorEvent => ({
  seq,
  type,
  payload,
});

/** The stream as WorkspaceView reads it: cursor first, then the anchor rule. */
const replay = (events: StreamAnchorEvent[]) => {
  let anchor: number | null = null;
  let cursor = 0;
  for (const e of events) {
    cursor = Math.max(cursor, e.seq);
    anchor = streamAnchorAfter(anchor, e, cursor);
  }
  return anchor;
};

describe('streamAnchorAfter', () => {
  it('follows a tool call the model made after its last thought', () => {
    // The shape that produced the bug, from session 01a07092 (2026-09-05): the model thinks (the
    // deltas anchor the drafts), the thinking block closes at 2931, it runs a command, and then
    // streams the answer explaining what the command found. Left on the thought, that answer
    // renders ABOVE the command it is describing.
    const anchor = replay([
      ev(2925, 'thinking_delta', { text: 'reading the diff' }),
      ev(2931, 'thinking', { text: '' }),
      ev(2932, 'system', { subtype: 'context' }),
      ev(2933, 'tool_use', { id: 't1', name: 'Bash', input: { command: 'git status --short' } }),
      ev(2934, 'tool_result', { toolUseId: 't1', content: ' M package.json' }),
      ev(2935, 'system', { subtype: 'status' }),
      ev(2936, 'thinking_delta', { text: 'weighing it up' }),
      ev(2937, 'text_delta', { text: 'here is what I found' }),
    ]);

    expect(anchor).toBe(2934);
  });

  it('does not follow a message typed into the middle of the turn', () => {
    // The runner echoes it as a `user` event with a seq higher than anything on screen. Following
    // it would put the message above a bubble that keeps growing, in a pane pinned to the tail.
    const anchor = replay([
      ev(1, 'assistant', { text: 'earlier reply' }),
      ev(2, 'text_delta', { text: 'the reply being written' }),
      ev(3, 'user', { text: 'one more thing', steer: true }),
      ev(4, 'user_delivery', { delivery: 'acknowledged' }),
      ev(5, 'system', { subtype: 'status' }),
    ]);

    expect(anchor).toBe(2);
  });

  it('re-anchors each stretch at the cursor it starts from', () => {
    const anchor = replay([
      ev(1, 'text_delta', { text: 'first stretch' }),
      ev(2, 'assistant', { text: 'first stretch' }),
      ev(3, 'tool_use', { id: 't1', name: 'Bash', input: { command: 'ls' } }),
      ev(4, 'tool_result', { toolUseId: 't1', content: 'ok' }),
      ev(5, 'text_delta', { text: 'second stretch' }),
    ]);

    expect(anchor).toBe(5);
  });

  it('drops the anchor at every boundary that supersedes the drafts', () => {
    for (const type of ['assistant', 'turn_end', 'user', 'interrupt', 'error']) {
      expect(streamAnchorAfter(7, ev(9, type), 9)).toBeNull();
    }
    expect(streamAnchorAfter(7, ev(9, 'system', { subtype: 'resumed' }), 9)).toBeNull();
  });

  it('leaves the anchor alone when nothing is streaming', () => {
    // Idle, the drafts render last; a tool call must not invent an anchor that splits the
    // transcript and unfolds a run of calls spanning the seam.
    expect(streamAnchorAfter(null, ev(3, 'tool_use', { id: 't1', name: 'Bash' }), 3)).toBeNull();
    expect(streamAnchorAfter(null, ev(4, 'tool_result', { toolUseId: 't1' }), 4)).toBeNull();
  });
});
