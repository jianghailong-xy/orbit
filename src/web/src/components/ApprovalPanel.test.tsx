import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalPanel } from './ApprovalPanel';
import type { ApprovalInfo } from '../api';

const dagApproval = (over: Record<string, unknown> = {}): ApprovalInfo =>
  ({
    id: 'a1',
    toolName: 'orbit_dag_change',
    input: {
      listId: 'l1',
      note: '把 WARC 转换拆开并行跑，它不依赖去重完成。',
      preview: {
        listTitle: 'FineWeb CC-MAIN-2025-26',
        ops: [
          {
            op: 'remove',
            taskTitle: '[W 009/250] 000_00008.parquet → WARC',
            dependsOnTitle: '[D] 全局去重',
            noop: false,
          },
          { op: 'add', taskTitle: '[W 010/250] → WARC', dependsOnTitle: '[S] 采样校验', noop: true },
        ],
        changes: [
          { taskId: 't1', title: '[W 009/250] 000_00008.parquet → WARC', from: 'BLOCKED', to: 'NONE' },
        ],
        becomingRunnable: 40,
        becomingBlocked: 0,
        effectiveCount: 1,
        edgesBefore: 312,
        edgesAfter: 311,
      },
      ...(over.input as object),
    },
    ...over,
  }) as ApprovalInfo;

const render = (a: ApprovalInfo) => renderToStaticMarkup(<ApprovalPanel approval={a} onDecide={() => {}} />);

const batchApproval = (preview: Record<string, unknown>): ApprovalInfo =>
  ({ id: 'b1', toolName: 'orbit_task_batch', input: { preview } }) as ApprovalInfo;

describe('batch create approval', () => {
  it('leads with how many actually start, not how many are written', () => {
    // Fifty tasks that wait on each other cost two runs; fifty independent ones cost fifty. The
    // titles look identical either way, which is the whole reason the counts come first.
    const html = render(batchApproval({ taskCount: 50, startingNow: 2, blocked: 48 }));

    expect(html).toContain('2 start running within the minute');
    expect(html).toContain('48 wait on a prerequisite');
    expect(html).toContain('create 50 tasks?');
  });

  it('says a root needs a manual start instead of promising it will run', () => {
    // The bug the real approval flow caught: the card claimed a task would start within the
    // minute, and it never did. Auto-run triggers on a prerequisite finishing, so a task with
    // none is never picked up — and every root of a fresh DAG is exactly that.
    const html = render(batchApproval({ taskCount: 50, startingNow: 0, needsManualStart: 50 }));

    expect(html).toContain('50 need a manual start');
    expect(html).toContain('0 start running within the minute');
  });

  it('separates tasks that cannot run from tasks that are merely waiting', () => {
    // Nothing finishing will release these — they sit until a person assigns them, and a batch
    // that is silently all of them did nothing at all.
    const html = render(batchApproval({ taskCount: 3, startingNow: 0, blocked: 0, notDispatchable: 3 }));

    expect(html).toContain('cannot run');
    expect(html).not.toContain('wait on a prerequisite');
  });

  it('shows a window of titles and counts the rest', () => {
    const html = render(
      batchApproval({
        taskCount: 40,
        startingNow: 1,
        tasks: [{ title: '[W 001/250] → WARC', dependsOnRefs: ['s0'] }],
        titlesTruncated: 39,
      }),
    );

    expect(html).toContain('[W 001/250] → WARC');
    expect(html).toContain('waits on 1');
    expect(html).toContain('+39 more');
  });

  it('offers no "always allow" — a standing yes to creating tasks is a blank cheque', () => {
    const html = render(batchApproval({ taskCount: 2, startingNow: 2 }));

    expect(html).not.toContain('Always allow');
    expect(html).toContain('Create them');
    expect(html).toContain('Create nothing');
  });
});

describe('DAG change approval', () => {
  it('leads with the consequence, which is the part the ops do not show', () => {
    // "remove 1 edge" is unremarkable until you know it releases 40 tasks, and the sweep starts
    // those within the minute. That number is the whole reason this is an approval.
    const html = render(dagApproval());

    expect(html).toContain('40 tasks become runnable');
    expect(html).toContain('start on the next sweep');
  });

  it('names the list being restructured in the question itself', () => {
    expect(render(dagApproval())).toContain('FineWeb CC-MAIN-2025-26');
  });

  it("shows the proposer's reason, since the edges alone cannot be judged", () => {
    expect(render(dagApproval())).toContain('把 WARC 转换拆开并行跑');
  });

  it('describes each edge in task titles, never ids', () => {
    const html = render(dagApproval());

    expect(html).toContain('[W 009/250] 000_00008.parquet → WARC');
    expect(html).toContain('no longer waits on');
    expect(html).toContain('[D] 全局去重');
    expect(html).not.toContain('orbit_dag_change');
  });

  it('marks an op that would change nothing', () => {
    expect(render(dagApproval())).toContain('already so');
  });

  it('offers no "always allow" — there is no repeatable form of this', () => {
    // Every batch releases a different set of tasks; a standing rule would be a blank cheque.
    const html = render(dagApproval());

    expect(html).not.toContain('Always allow');
    expect(html).toContain('Apply changes');
    expect(html).toContain('Leave the graph alone');
  });

  it('conjugates the singular case', () => {
    const html = render(
      dagApproval({
        input: { preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 1 } },
      }),
    );

    expect(html).toContain('1 task stops being runnable');
  });

  it('drops the edge caption when there are no edges to caption', () => {
    const html = render(
      dagApproval({
        input: { preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 0 } },
      }),
    );

    expect(html).not.toContain('Edges written');
  });

  it('does not call a task freed of its last prerequisite runnable', () => {
    // BLOCKED -> NONE reads like a release and is not one: nothing is left to trigger it.
    const html = render(
      dagApproval({
        input: {
          preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingManual: 3, becomingBlocked: 0 },
        },
      }),
    );

    expect(html).toContain('3 stop waiting, but now need a manual start');
    expect(html).not.toContain('become runnable');
  });

  it('says so plainly when a restructure moves no task', () => {
    const html = render(
      dagApproval({
        input: {
          preview: { listTitle: 'X', ops: [], changes: [], becomingRunnable: 0, becomingBlocked: 0 },
        },
      }),
    );

    expect(html).toContain('No task changes state');
  });

  it('still renders an ordinary tool approval as the raw input', () => {
    const html = renderToStaticMarkup(
      <ApprovalPanel
        approval={{ id: 'b1', toolName: 'Bash', input: { command: 'ls -la' } } as ApprovalInfo}
        onDecide={() => {}}
      />,
    );

    expect(html).toContain('Approve tool call: Bash');
    expect(html).toContain('ls -la');
  });
});
