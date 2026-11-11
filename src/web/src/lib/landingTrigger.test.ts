import { describe, expect, it } from 'vitest';
import type { IntegrationTimelineTrigger } from '@orbit/shared';
import { sentenceText } from './landingSentence';
import { triggerMessage } from './landingTrigger';

const trigger = (over: Partial<IntegrationTimelineTrigger>): IntegrationTimelineTrigger => ({
  cause: 'DONE', by: 'TASK', at: '2026-11-11T07:44:00.000Z', sourceRef: 'refs/heads/orbit/task-oom-doc-3e81c2',
  sourceSha: 'c4a90b7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 's1', reason: null, ...over,
});
const said = (t: IntegrationTimelineTrigger, context: Parameters<typeof triggerMessage>[1] = { task: 'Record the OOM kill' }) => {
  const message = triggerMessage(t, context);
  return [message.from, sentenceText(message.parts)];
};

describe('triggerMessage', () => {
  it('says what the task handed over: its name, its branch and its commit', () => {
    expect(said(trigger({}))).toEqual(['From the task · Done', 'Land Record the OOM kill · orbit/task-oom-doc-3e81c2 · c4a90b7']);
    const parts = triggerMessage(trigger({}), { task: 'T' }).parts;
    expect(parts.filter((part) => part.strong).map((part) => part.text)).toEqual(['T']);
    expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual(['orbit/task-oom-doc-3e81c2', 'c4a90b7']);
    // No commit known: the branch alone.
    expect(said(trigger({ sourceSha: null }))[1]).toBe('Land Record the OOM kill · orbit/task-oom-doc-3e81c2');
  });

  it('signs a rerun with who asked, and says the reason it gave', () => {
    expect(said(trigger({ cause: 'RETRY', by: 'COORDINATOR', reason: 'The red was the acceptance command' })))
      .toEqual(['From the coordinator · Rerun', 'The red was the acceptance command']);
    expect(said(trigger({ cause: 'RETRY', by: 'OWNER', reason: null }))[0]).toBe('From you · Rerun');
    expect(said(trigger({ cause: 'RETRY', by: 'OWNER', reason: null }))[1]).toMatch(/^Land Record the OOM kill · /u);
    expect(said(trigger({ cause: 'RETRY', by: 'ORBIT' }))[0]).toBe('From Orbit · Rerun');
  });

  it('says why Orbit queued it on its own', () => {
    expect(said(trigger({ cause: 'BACKFILL', by: 'ORBIT', sourceSha: null })))
      .toEqual(['From Orbit', 'Land Record the OOM kill · orbit/task-oom-doc-3e81c2 · the project started integrating']);
    expect(said(trigger({ cause: 'BEHIND_WORK', by: 'ORBIT', sourceSha: null }))[1])
      .toMatch(/ · the task's work ended on another branch$/u);
    expect(said(trigger({ cause: 'OBSERVE', by: 'ORBIT', sourceRef: 'refs/heads/project/p1' })))
      .toEqual(['From Orbit', 'Look for finished work on project/p1']);
  });

  it('says a merge round\'s check and its merge, and who confirmed the merge', () => {
    const line = { sourceRef: 'refs/heads/project/p1', sourceSha: 'fe5db82bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(said(trigger({ cause: 'CHECK', by: 'ORBIT', ...line }), { task: 'Merged into main', main: 'main' }))
      .toEqual(['From Orbit', 'Check project/p1 · fe5db82 before merging into main']);
    expect(said(trigger({ cause: 'CONFIRMED', by: 'AUTOMATIC', ...line }), { task: '', tasks: 1, main: 'main', attempt: { attempt: 2, limit: 3 } }))
      .toEqual(['From Automatic', 'Merge 1 task into main · project/p1 · fe5db82 · attempt 2 of 3']);
    expect(said(trigger({ cause: 'CONFIRMED', by: 'OWNER', ...line }), { task: '', tasks: 2, main: 'main', attempt: { attempt: 1, limit: 3 } }))
      .toEqual(['From you', 'Merge 2 tasks into main · project/p1 · fe5db82']);
  });
});
