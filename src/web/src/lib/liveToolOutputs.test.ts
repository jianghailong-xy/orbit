import { describe, expect, it } from 'vitest';
import {
  clearLiveToolOutputsForSession,
  EMPTY_LIVE_TOOL_OUTPUTS,
  reduceLiveToolOutputs,
  type LiveToolOutputs,
} from './liveToolOutputs';

describe('foreground shell output snapshots', () => {
  it('replaces each whole snapshot instead of appending it', () => {
    const first = reduceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'one\n' },
    });
    const second = reduceLiveToolOutputs(first, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'one\ntwo\n' },
    });

    expect(second.get('shell-turn-1')?.content).toBe('one\ntwo\n');
  });

  it('accepts an empty current snapshot and ignores non-user-shell tools', () => {
    const seeded: LiveToolOutputs = new Map([
      ['shell-turn-1', { content: 'old output' }],
    ]);
    const cleared = reduceLiveToolOutputs(seeded, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: '' },
    });
    const unrelated = reduceLiveToolOutputs(cleared, {
      type: 'tool_output',
      payload: { toolUseId: 'agent-bash-1', content: 'not this channel' },
    });

    expect(cleared.has('shell-turn-1')).toBe(true);
    expect(cleared.get('shell-turn-1')?.content).toBe('');
    expect(unrelated).toBe(cleared);
  });

  it('does not regress when versioned snapshots arrive new then old', () => {
    const newest = reduceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, {
      type: 'tool_output',
      payload: {
        toolUseId: 'shell-turn-1',
        content: 'newest output',
        snapshotSeq: 12,
      },
    });
    const reorderedOld = reduceLiveToolOutputs(newest, {
      type: 'tool_output',
      payload: {
        toolUseId: 'shell-turn-1',
        content: 'older output',
        snapshotSeq: 11,
      },
    });

    expect(reorderedOld).toBe(newest);
    expect(reorderedOld.get('shell-turn-1')).toEqual({
      content: 'newest output',
      snapshotSeq: 12,
    });
  });

  it('keeps arrival-order replacement for legacy snapshots without a version', () => {
    const first = reduceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'first' },
    });
    const second = reduceLiveToolOutputs(first, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'second' },
    });

    expect(second.get('shell-turn-1')).toEqual({ content: 'second' });
  });

  it('ignores an unorderable legacy snapshot after versioned delivery has begun', () => {
    const versioned = reduceLiveToolOutputs(EMPTY_LIVE_TOOL_OUTPUTS, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'ordered', snapshotSeq: 8 },
    });
    const legacy = reduceLiveToolOutputs(versioned, {
      type: 'tool_output',
      payload: { toolUseId: 'shell-turn-1', content: 'unknown age' },
    });

    expect(legacy).toBe(versioned);
    expect(legacy.get('shell-turn-1')).toEqual({ content: 'ordered', snapshotSeq: 8 });
  });

  it('drops the transient snapshot when its durable result arrives', () => {
    const current: LiveToolOutputs = new Map([
      ['shell-turn-1', { content: 'preview', snapshotSeq: 1 }],
      ['shell-turn-2', { content: 'still running', snapshotSeq: 2 }],
    ]);
    const next = reduceLiveToolOutputs(current, {
      type: 'tool_result',
      payload: { toolUseId: 'shell-turn-1', content: 'final' },
    });

    expect(next.has('shell-turn-1')).toBe(false);
    expect(next.get('shell-turn-2')?.content).toBe('still running');
  });

  it('clears the previous runner generation when a session resumes', () => {
    const current: LiveToolOutputs = new Map([
      ['shell-turn-1', { content: 'old runner tail', snapshotSeq: 41 }],
    ]);

    const next = reduceLiveToolOutputs(current, {
      type: 'system',
      payload: { subtype: 'resumed' },
    });

    expect(next).toBe(EMPTY_LIVE_TOOL_OUTPUTS);
  });

  it('clears the selected session when polling discovers it is no longer running', () => {
    const outputs: LiveToolOutputs = new Map([
      ['shell-turn-1', { content: 'last live output', snapshotSeq: 4 }],
    ]);
    const current = { sessionId: 'session-1', outputs };

    const cleared = clearLiveToolOutputsForSession(current, 'session-1');
    const otherSession = clearLiveToolOutputsForSession(current, 'session-2');

    expect(cleared).toEqual({ sessionId: 'session-1', outputs: EMPTY_LIVE_TOOL_OUTPUTS });
    expect(otherSession).toBe(current);
  });
});
