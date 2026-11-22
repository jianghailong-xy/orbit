// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRunView, WorkflowRunView } from '@orbit/shared';
import type { RunEvent } from '../components/Transcript';
import { useSubagentRuns } from './subagentRuns';
import { useWorkflowRuns, workflowRunsSignature, type WorkflowRuns } from './workflowRuns';

/**
 * The web's copy of a session's Orbit workflows and their calls' runs, kept live the way its SubAgent runs are:
 * read again from the server whenever the transcript says a workflow opened, one of its calls started or ended,
 * or the workflow ended. The events are the runner's (runner-go subagent_workflow.go: the workflow call and its
 * receipt, each agent() drawn as a delegate call nested under it, the call's SubAgent nested under that, the
 * call's result, the script's log lines, and the workflow call's terminal background_task).
 */

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  seq,
  type,
  ts: `2026-11-19T10:00:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});

const WF = 'toolu_workflow';
const callResult = (status: string, result: string) =>
  JSON.stringify({ runId: 'r', status, result, changedFiles: [], model: 'claude-sonnet-5-5', costUsd: 0.25 });

/** One workflow's life, in the order the runner writes it. */
const life = {
  opened: ev(1, 'tool_use', {
    id: WF, name: 'mcp__orbit__workflow', input: { description: 'Review the parser', script: 'export const meta = {}' },
  }),
  receipt: ev(2, 'tool_result', { toolUseId: WF, content: [{ type: 'text', text: '{"workflowRunId":"wf1","status":"running"}' }] }),
  call0: ev(3, 'tool_use', {
    id: `${WF}#0`, name: 'mcp__orbit__delegate', input: { description: 'Lexer', prompt: 'Review the lexer.', workflow_phase: 'Review' },
    parentToolUseId: WF, workflowRunId: 'wf1',
  }),
  call0Started: ev(4, 'assistant', { text: 'Reading the lexer.', parentToolUseId: `${WF}#0`, subagentRunId: 'run0' }),
  call0Works: ev(5, 'tool_use', {
    id: 'run0:toolu_1', name: 'Read', input: { file_path: 'src/lexer.ts' }, parentToolUseId: `${WF}#0`, subagentRunId: 'run0',
  }),
  log: ev(6, 'assistant', { text: 'Both reviews started', parentToolUseId: WF, workflowRunId: 'wf1' }),
  call1: ev(7, 'tool_use', {
    id: `${WF}#1`, name: 'mcp__orbit__delegate', input: { description: 'Grammar', prompt: 'Review the grammar.', workflow_phase: 'Review' },
    parentToolUseId: WF, workflowRunId: 'wf1',
  }),
  call1Started: ev(8, 'thinking', { text: 'The grammar first.', parentToolUseId: `${WF}#1`, subagentRunId: 'run1' }),
  call0Ended: ev(9, 'tool_result', {
    toolUseId: `${WF}#0`, parentToolUseId: WF, content: callResult('DONE', 'Two findings.'), isError: false, workflowRunId: 'wf1',
  }),
  call1Ended: ev(10, 'tool_result', {
    toolUseId: `${WF}#1`, parentToolUseId: WF, content: callResult('FAILED', 'The SubAgent failed.'), isError: true, workflowRunId: 'wf1',
  }),
  ended: ev(11, 'background_task', {
    toolUseId: WF, status: 'completed', summary: 'Workflow wf1 done: 1 calls done, 1 failed, $0.25', workflowRunId: 'wf1',
  }),
};

const workflow = (over: Partial<WorkflowRunView>): WorkflowRunView => ({
  id: 'wf1', toolUseId: WF, name: 'review-parser', description: 'Review the parser', phases: ['Review'], status: 'RUNNING',
  callsDone: 0, callsFailed: 0, costUsd: 0, maxCostUsd: null, error: null, createdAt: '2026-11-19T10:00:01.000Z', endedAt: null,
  ...over,
});

const run = (index: number, over: Partial<SubagentRunView>): SubagentRunView => ({
  toolUseId: `${WF}#${index}`, type: 'general', background: false, status: 'RUNNING', level: 'S', model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5', effort: 'low', reasons: [], why: null, removed: [], costUsd: 0, resultSummary: null,
  workspaceName: null, description: index === 0 ? 'Lexer' : 'Grammar', engine: 'claude', readonly: false, changedFiles: [],
  workflowRunId: 'wf1', callIndex: index, label: index === 0 ? 'Lexer' : 'Grammar', phase: 'Review',
  createdAt: '2026-11-19T10:00:04.000Z', endedAt: null,
  ...over,
});

/** The session's rows as the server holds them at each moment, and every read the client sent it. */
let server: { workflows: WorkflowRunView[]; runs: SubagentRunView[] };
let reads: string[];
let seen: WorkflowRuns;
let container: HTMLDivElement;
let root: Root;

function Probe({ events }: { events: readonly RunEvent[] }) {
  seen = useWorkflowRuns('s1', events);
  return null;
}

async function show(events: readonly RunEvent[]) {
  await act(async () => {
    root.render(<Probe events={events} />);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  server = { workflows: [], runs: [] };
  reads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    reads.push(url);
    const body = url === '/api/sessions/s1/workflows' ? server.workflows : url === '/api/sessions/s1/subagents' ? server.runs : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('a session\'s workflows on the web', () => {
  it('are read again as the workflow opens, each call starts and ends, and the workflow ends; nothing else reads', async () => {
    const delegate = ev(20, 'tool_use', { id: 'toolu_d', name: 'mcp__orbit__delegate', input: { prompt: 'x' } });
    await show([delegate]);
    expect(reads, 'a session that never ran a workflow reads nothing').toEqual([]);
    expect(seen.workflows.size).toBe(0);

    // The workflow opens: its call reaches the transcript, then the receipt the server's row answered it with.
    server.workflows = [workflow({})];
    await show([life.opened]);
    expect(reads).toEqual(['/api/sessions/s1/workflows', '/api/sessions/s1/subagents']);
    expect(seen.workflows.get(WF)).toMatchObject({ id: 'wf1', name: 'review-parser', status: 'RUNNING', phases: ['Review'] });
    await show([life.opened, life.receipt]);
    expect(reads).toHaveLength(4);

    // A call is made (queued until its run opens), then its SubAgent's first event says the run is open.
    await show([life.opened, life.receipt, life.call0]);
    expect(reads).toHaveLength(6);
    expect(seen.calls.size, 'no run yet: the call is queued').toBe(0);
    server.runs = [run(0, {}), { ...run(0, {}), toolUseId: 'toolu_d', workflowRunId: null, callIndex: null, label: null, phase: null }];
    await show([life.opened, life.receipt, life.call0, life.call0Started]);
    expect(reads).toHaveLength(8);
    expect(seen.calls.get(`${WF}#0`)).toMatchObject({ status: 'RUNNING', workflowRunId: 'wf1', callIndex: 0, label: 'Lexer', phase: 'Review' });
    expect(seen.calls.has('toolu_d'), "a delegate call's run is not a workflow's").toBe(false);

    // The call's later events and the script's log lines move nothing.
    await show([life.opened, life.receipt, life.call0, life.call0Started, life.call0Works, life.log]);
    expect(reads).toHaveLength(8);

    // The second call is made, then starts; then each ends, and the workflow's live counts follow.
    const upToCall1 = [life.opened, life.receipt, life.call0, life.call0Started, life.call0Works, life.log, life.call1];
    await show(upToCall1);
    expect(reads).toHaveLength(10);
    expect(seen.calls.has(`${WF}#1`)).toBe(false);
    server.runs = [run(0, {}), run(1, {})];
    upToCall1.push(life.call1Started);
    await show([...upToCall1]);
    expect(reads).toHaveLength(12);
    expect(seen.calls.get(`${WF}#1`)).toMatchObject({ status: 'RUNNING', callIndex: 1, label: 'Grammar' });

    server.runs = [run(0, { status: 'DONE', costUsd: 0.25, endedAt: '2026-11-19T10:00:09.000Z' }), run(1, {})];
    server.workflows = [workflow({ callsDone: 1, costUsd: 0.25 })];
    await show([...upToCall1, life.call0Ended]);
    expect(reads).toHaveLength(14);
    expect(seen.calls.get(`${WF}#0`)?.status).toBe('DONE');
    expect(seen.workflows.get(WF)).toMatchObject({ status: 'RUNNING', callsDone: 1, callsFailed: 0, costUsd: 0.25 });

    server.runs = [server.runs[0], run(1, { status: 'FAILED', endedAt: '2026-11-19T10:00:10.000Z' })];
    server.workflows = [workflow({ callsDone: 1, callsFailed: 1, costUsd: 0.25 })];
    await show([...upToCall1, life.call0Ended, life.call1Ended]);
    expect(reads).toHaveLength(16);
    expect(seen.calls.get(`${WF}#1`)?.status).toBe('FAILED');
    expect(seen.workflows.get(WF)).toMatchObject({ callsFailed: 1 });

    // The workflow ends.
    server.workflows = [workflow({ status: 'DONE', callsDone: 1, callsFailed: 1, costUsd: 0.25, endedAt: '2026-11-19T10:00:11.000Z' })];
    await show([...upToCall1, life.call0Ended, life.call1Ended, life.ended]);
    expect(reads).toHaveLength(18);
    expect(seen.workflows.get(WF)).toMatchObject({ status: 'DONE', callsDone: 1, callsFailed: 1, endedAt: '2026-11-19T10:00:11.000Z' });
  });

  it('signs each moment once, by seq', () => {
    const all = Object.values(life);
    expect(workflowRunsSignature(all)).toBe('1,2,3,4,7,8,9,10,11');
    expect(workflowRunsSignature([life.call0, life.call0Started]), 'a delegate call nested under no workflow is not a workflow call').toBe('');
  });

  it('read /subagents once when a delegate signature and a workflow signature move together, and neither view misses it', async () => {
    let delegateSeen: ReturnType<typeof useSubagentRuns> = new Map();
    function Both({ events }: { events: readonly RunEvent[] }) {
      delegateSeen = useSubagentRuns('s1', events);
      seen = useWorkflowRuns('s1', events);
      return null;
    }
    const both = async (events: readonly RunEvent[]) => {
      await act(async () => {
        root.render(<Both events={events} />);
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const delegate = ev(20, 'tool_use', { id: 'toolu_d', name: 'mcp__orbit__delegate', input: { prompt: 'x' } });
    server.workflows = [workflow({})];
    server.runs = [run(0, {}), { ...run(0, {}), toolUseId: 'toolu_d', workflowRunId: null, callIndex: null, label: null, phase: null }];
    await both([delegate, life.opened]);
    expect(reads.filter((url) => url.endsWith('/subagents'))).toHaveLength(1);
    expect(delegateSeen.get('toolu_d')?.status).toBe('RUNNING');
    expect(seen.workflows.get(WF)?.status).toBe('RUNNING');

    // The delegate ends and a workflow call is made on one update: one more read, both views move.
    reads.length = 0;
    server.runs = [run(0, {}), { ...run(0, {}), toolUseId: 'toolu_d', workflowRunId: null, callIndex: null, label: null, phase: null, status: 'DONE' }];
    server.workflows = [workflow({ callsDone: 1 })];
    const delegateEnded = ev(21, 'tool_result', { toolUseId: 'toolu_d', content: [{ type: 'text', text: '{}' }] });
    await both([delegate, life.opened, delegateEnded, life.call0]);
    expect(reads.filter((url) => url.endsWith('/subagents'))).toHaveLength(1);
    expect(delegateSeen.get('toolu_d')?.status).toBe('DONE');
    expect(seen.workflows.get(WF)).toMatchObject({ callsDone: 1 });
    expect(seen.calls.get(`${WF}#0`)?.status).toBe('RUNNING');
  });

  it('sends at most two /subagents reads when three observers move in separate ticks, and each ends with the trailing answer', async () => {
    const answers = [[run(0, {})], [run(0, { status: 'DONE', endedAt: '2026-11-19T10:00:09.000Z' })]];
    let gate: (() => void) | null = null;
    const subagentReads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/workflows') {
        return new Response(JSON.stringify([workflow({})]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      subagentReads.push(url);
      const body = answers[Math.min(subagentReads.length, answers.length) - 1];
      // The first read stays in flight while the signatures move.
      if (subagentReads.length === 1) await new Promise<void>((resolve) => { gate = resolve; });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const seenBy: { a?: ReturnType<typeof useSubagentRuns>; b?: ReturnType<typeof useSubagentRuns>; w?: WorkflowRuns } = {};
    function A({ events }: { events: readonly RunEvent[] }) { seenBy.a = useSubagentRuns('s1', events); return null; }
    function B({ events }: { events: readonly RunEvent[] }) { seenBy.b = useSubagentRuns('s1', events); return null; }
    function W({ events }: { events: readonly RunEvent[] }) { seenBy.w = useWorkflowRuns('s1', events); return null; }
    const delegateCall = ev(20, 'tool_use', { id: `${WF}#0`, name: 'mcp__orbit__delegate', input: { prompt: 'x' } });
    const results = (n: number) => Array.from({ length: n }, (_, k) => ev(30 + k, 'tool_result', { toolUseId: `${WF}#0`, content: 'x' }));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const events = (n: number) => [life.opened, life.call0, delegateCall, ...results(n)];
    const moves = [
      (n: number) => root.render(<><A events={events(n)} /><B events={[]} /><W events={[]} /></>),
      (n: number) => root.render(<><A events={events(n)} /><B events={events(n)} /><W events={[]} /></>),
      (n: number) => root.render(<><A events={events(n)} /><B events={events(n)} /><W events={events(n)} /></>),
    ];
    for (let n = 1; n <= 5; n++) {
      await act(async () => { moves[Math.min(n, 3) - 1](n); await tick(); });
    }
    await act(async () => { (gate as (() => void) | null)?.(); for (let i = 0; i < 8; i++) await tick(); });
    expect(subagentReads).toHaveLength(2);
    for (const view of [seenBy.a, seenBy.b, seenBy.w?.calls]) expect(view?.get(`${WF}#0`)?.status).toBe('DONE');
  });
});
