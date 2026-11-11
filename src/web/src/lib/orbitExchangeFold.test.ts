import { describe, expect, it } from 'vitest';
import {
  EMPTY_TREE_LOOKUP,
  OTHER_BRANCH_TITLE,
  branchExchanges,
  buildExchangeTree,
  downstreamCount,
  exchangeKinds,
  parseRunNotice,
  replyGist,
  upstreamFromGraph,
  type ExchangeTarget,
  type ExchangeTreeLookup,
} from './orbitExchangeFold';
import type { ProjectDependencyGraphResponse } from './projectDependencyGraph';

const B1 = '0195c0de-0000-7000-8000-000000000011';
const B4 = '0195c0de-0000-7000-8000-000000000014';
const B4b = '0195c0de-0000-7000-8000-000000000015';
const B5 = '0195c0de-0000-7000-8000-000000000016';
const RUN_OF_B4 = '0195c0de-0000-7000-8000-0000000000a4';

const task = (id: string, title?: string): ExchangeTarget => ({ kind: 'TASK', id, title });
const ex = (seq: number, target: ExchangeTarget | null) => ({ seq, target });

/** B1 → B4 → { B4b, B5 }: the Runner link v1 project the board was drawn from. */
const lookup: ExchangeTreeLookup = {
  taskOfSession: (id) => (id === RUN_OF_B4 ? { id: B4 } : null),
  upstreamOf: (id) => ({ [B4]: [B1], [B4b]: [B4], [B5]: [B4, B1] } as Record<string, string[]>)[id] ?? [],
  taskTitle: (id) => ({ [B1]: 'B1', [B4]: 'B4', [B4b]: 'B4b', [B5]: 'B5' } as Record<string, string>)[id],
};

describe('replyGist', () => {
  it('reads the first line a reply says, as plain text', () => {
    expect(replyGist('我确认了 B1（[定向提示与 NATS](orbit-task:x)），它正在落地。\n\n**确认依据**\n- 第 1 版…')).toBe(
      '我确认了 B1（定向提示与 NATS），它正在落地。',
    );
    expect(replyGist('\n## **Verdict:** confirmed `B5`\nmore')).toBe('Verdict: confirmed B5');
    expect(replyGist('- first point\n- second')).toBe('first point');
    expect(replyGist('```\ncode\n```')).toBe('code');
    expect(replyGist('')).toBe('');
  });
});

describe('exchangeKinds', () => {
  it('counts a group by kind, in a fixed order, naming only the kinds it holds', () => {
    const cats = ['watch', 'evidence', 'evidence', 'job', 'ready', 'watch', 'evidence'] as const;
    expect(exchangeKinds(cats.map((category) => ({ category })))).toBe(
      '3 evidence, 1 can start, 2 watches, 1 background job',
    );
    expect(exchangeKinds([{ category: 'reply' }])).toBe('1 reply');
  });
});

describe('buildExchangeTree', () => {
  it('puts each exchange under its task, and a task under the prerequisite in the same group', () => {
    const tree = buildExchangeTree(
      [
        ex(10, task(B1, 'B1 Targeted hints')),
        ex(20, { kind: 'SESSION', id: RUN_OF_B4, title: 'B4 run' }),
        ex(30, task(B4)),
        ex(35, null),
        ex(40, task(B4b)),
        ex(50, task(B5)),
      ],
      lookup,
    )!;
    expect(tree.map((b) => b.title)).toEqual(['B1 Targeted hints', OTHER_BRANCH_TITLE]);
    const [b1, other] = tree;
    expect(b1.exchanges.map((e) => e.seq)).toEqual([10]);
    const [b4] = b1.children;
    // The watch on B4's run is B4's: the session is placed by the task it runs.
    expect(b4.exchanges.map((e) => e.seq)).toEqual([20, 30]);
    // B5 waits on both B4 and B1: it goes under the one that came first in the group, B1 — once.
    expect(b4.children.map((b) => b.title)).toEqual(['B4b']);
    expect(b1.children.map((b) => b.title)).toEqual(['B4', 'B5']);
    expect(other.exchanges.map((e) => e.seq)).toEqual([35]);
    expect(downstreamCount(b1)).toBe(3);
    expect(branchExchanges(b1).map((e) => e.seq)).toEqual([10, 20, 30, 40, 50]);
  });

  it('makes a task whose prerequisites are not in the group a root', () => {
    const tree = buildExchangeTree([ex(1, task(B4b)), ex(2, task(B5))], lookup)!;
    expect(tree.map((b) => b.title)).toEqual(['B4b', 'B5']);
  });

  it('puts a session it cannot place under a task with everything else, not in a branch named after an id', () => {
    const landing = '0195c0de-0000-7000-8000-0000000000ff';
    const tree = buildExchangeTree(
      [ex(1, { kind: 'SESSION', id: landing, title: 'Land · B1' }), ex(2, task(B1)), ex(3, { kind: 'SESSION', id: landing })],
      lookup,
    )!;
    expect(tree.map((b) => [b.title, b.exchanges.map((e) => e.seq)])).toEqual([
      ['B1', [2]],
      [OTHER_BRANCH_TITLE, [1, 3]],
    ]);
  });

  it('draws no tree for a group about one thing', () => {
    expect(buildExchangeTree([ex(1, task(B1)), ex(2, task(B1))], lookup)).toBeNull();
    expect(buildExchangeTree([ex(1, null), ex(2, null)], lookup)).toBeNull();
  });

  it('names a task this page knows nothing about by the end of its id', () => {
    const tree = buildExchangeTree([ex(1, task(B1)), ex(2, null)], EMPTY_TREE_LOOKUP)!;
    expect(tree[0].title).toMatch(/^Task \w{8}$/);
  });
});

describe('parseRunNotice', () => {
  it('reads the task a run notice is about, and nothing else', () => {
    const note = [
      '<orbit-run-notice task="34vZUH31xayU3ZWjyRWfh" run-session="3y90ooHJ7OgQrKUV8KyqwZ" from-session="3y90ooHJ7OgQrKUV8KyqwZ" from-mode="auto">',
      'A run of the task “A task’s delivered_sha can freeze” used notify. It did not reach the account owner.',
      'Message: Background job bgj_c06ee80b2571 ended (exit code 0)',
      'Nothing is waiting for your reply. If the owner should know or decide, use ask_owner with your recommendation.',
      '</orbit-run-notice>',
    ].join('\n');
    expect(parseRunNotice(note)).toEqual({ taskId: '34vZUH31xayU3ZWjyRWfh', taskTitle: 'A task’s delivered_sha can freeze' });
    expect(parseRunNotice(note.replace('task="34vZUH31xayU3ZWjyRWfh"', 'task=""'))?.taskId).toBeNull();
    expect(parseRunNotice('<orbit-run-question task="x" run-session="y">\nA run asked…\n</orbit-run-question>')).toBeNull();
    expect(parseRunNotice(note.replace('</orbit-run-notice>', ''))).toBeNull();
    expect(parseRunNotice(undefined)).toBeNull();
  });
});

describe('upstreamFromGraph', () => {
  it('reads prerequisites off marks: a run in order, an edge from the last of one to the first of the next', () => {
    const graph = {
      marks: [
        { kind: 'TASK', id: 'm1', taskId: B1, title: 'B1', status: 'DONE', parentTaskId: null },
        {
          kind: 'RUN', id: 'm2', title: 'run', taskCount: 2, statusCounts: {}, parentTaskId: null, expandable: true,
          members: [{ taskId: B4, title: 'B4', status: 'DONE' }, { taskId: B4b, title: 'B4b', status: 'OPEN' }],
        },
        { kind: 'TASK', id: 'm3', taskId: B5, title: 'B5', status: 'OPEN', parentTaskId: null },
      ],
      edges: [{ sourceMarkId: 'm1', targetMarkId: 'm2' }, { sourceMarkId: 'm2', targetMarkId: 'm3' }],
      taskCount: 4, folded: true, truncated: false,
    } as unknown as ProjectDependencyGraphResponse;
    const read = upstreamFromGraph(graph);
    expect(read.upstreamOf(B4)).toEqual([B1]);
    expect(read.upstreamOf(B4b)).toEqual([B4]);
    expect(read.upstreamOf(B5)).toEqual([B4b]);
    expect(read.upstreamOf(B1)).toEqual([]);
    expect(read.taskTitle(B4b)).toBe('B4b');
    expect(upstreamFromGraph(undefined).upstreamOf(B4)).toEqual([]);
  });
});
