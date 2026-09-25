import { describe, expect, it } from 'vitest';
import {
  EMPTY_LIVE_TASK_PROGRESS,
  endedTaskProgress,
  reduceLiveTaskProgress,
} from './liveTaskProgress';

const frame = (state: string, toolCalls: number) => ({
  type: 'task_progress',
  payload: {
    toolUseId: 'toolu_wf',
    taskId: 'w2f3yv1s8',
    taskType: 'local_workflow',
    usage: { totalTokens: 792000, toolUses: 63, durationMs: 780000 },
    phases: [{ index: 1, title: 'Design' }],
    agents: [{ index: 4, label: 'design:page-wiki', phaseIndex: 1, state, toolCalls }],
  },
});

describe('reduceLiveTaskProgress', () => {
  it('keeps the latest whole picture per launching call', () => {
    let live = reduceLiveTaskProgress(EMPTY_LIVE_TASK_PROGRESS, frame('running', 20));
    live = reduceLiveTaskProgress(live, frame('done', 34));

    expect(live.size).toBe(1);
    expect(live.get('toolu_wf')?.agents[0]).toMatchObject({ label: 'design:page-wiki', state: 'done', toolCalls: 34 });
    expect(live.get('toolu_wf')?.usage?.toolUses).toBe(63);
  });

  it("drops a task's entry when its end arrives, and everything on a runtime restart", () => {
    const live = reduceLiveTaskProgress(EMPTY_LIVE_TASK_PROGRESS, frame('running', 20));
    const ended = reduceLiveTaskProgress(live, {
      type: 'background_task',
      payload: { toolUseId: 'toolu_wf', shellId: 'w2f3yv1s8', status: 'completed' },
    });
    expect(ended).toBe(EMPTY_LIVE_TASK_PROGRESS);
    expect(reduceLiveTaskProgress(live, { type: 'system', payload: { subtype: 'resumed' } })).toBe(
      EMPTY_LIVE_TASK_PROGRESS,
    );
  });

  it('ignores a frame that names no call, and leaves the map alone for everything else', () => {
    const live = reduceLiveTaskProgress(EMPTY_LIVE_TASK_PROGRESS, frame('running', 20));
    expect(reduceLiveTaskProgress(live, { type: 'task_progress', payload: { taskId: 'x' } })).toBe(live);
    expect(reduceLiveTaskProgress(live, { type: 'assistant', payload: { text: 'hi' } })).toBe(live);
  });
});

describe('endedTaskProgress', () => {
  it("reads what each finished task ended with off the transcript's durable events", () => {
    const ended = endedTaskProgress([
      { type: 'tool_use', payload: { id: 'toolu_wf', name: 'Workflow' } },
      { type: 'background_task', payload: { toolUseId: 'toolu_wf', status: 'completed', progress: frame('done', 34).payload } },
      // A re-delivered end with nothing attached says nothing about it.
      { type: 'background_task', payload: { toolUseId: 'toolu_wf', status: 'completed' } },
    ]);
    expect(ended.get('toolu_wf')?.agents[0]?.state).toBe('done');
  });
});
