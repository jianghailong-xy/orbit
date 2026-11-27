import type { SubagentRunView, WorkflowRunView } from '@orbit/shared';
import type { RunEvent } from '../components/Transcript';
import type { WorkflowRuns } from './workflowRuns';

/**
 * Orbit workflows in the states board parts 2 and 3 draw (docs/mocks/subagent-workflow/board.html), as the
 * transcript stores their events (runner-go subagent_workflow.go) and the server serves their views
 * (`GET /sessions/:id/workflows` and `/subagents`). Shared by the specs and the screenshot rig.
 */

export interface CallSpec {
  label: string;
  phase: string;
  prompt: string;
  state: 'done' | 'failed' | 'interrupted' | 'running' | 'queued';
  level?: 'S' | 'M' | 'L';
  model?: string;
  cost?: number;
  result?: string;
}

export interface WorkflowSpec {
  /** The workflow call's tool_use id. */
  id: string;
  runId: string;
  name: string;
  description: string;
  phases: string[];
  status: WorkflowRunView['status'];
  calls: CallSpec[];
  /** Log lines, each written after the call at `after` (-1: before any call). */
  logs?: Array<{ after: number; text: string }>;
  maxCostUsd?: number;
  /** The spend the server reports once the workflow ended; while it runs, the ended calls'. */
  costUsd?: number;
  error?: string;
  /** Minutes from its start to now (running) or to its end. */
  minutes: number;
}

const FIXED_START = Date.parse('2026-11-19T17:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

export interface WorkflowFixture {
  events: RunEvent[];
  runs: WorkflowRuns;
  /** The workflow call, in the running set while it runs. */
  running: string[];
}

/** The events and views of one workflow, its events numbered from `seq`. */
export function workflowFixture(spec: WorkflowSpec, seq = 1): WorkflowFixture {
  // A running workflow started `minutes` ago, so its open head's clock reads that; an ended one at a fixed time.
  const START = spec.status === 'RUNNING' ? Date.now() - spec.minutes * 60_000 : FIXED_START;
  const events: RunEvent[] = [];
  const at = () => iso(START + events.length * 1000);
  const ev = (type: string, payload: Record<string, unknown>) => events.push({ seq: seq + events.length, type, ts: at(), payload });
  const script = `export const meta = { name: '${spec.name}', description: '${spec.description}', phases: [${spec.phases
    .map((p) => `{ title: '${p}' }`)
    .join(', ')}] }\n// …`;
  ev('tool_use', { id: spec.id, name: 'mcp__orbit__workflow', input: { description: spec.description, script } });
  ev('tool_result', { toolUseId: spec.id, content: [{ type: 'text', text: JSON.stringify({ status: 'running', workflowRunId: spec.runId }) }] });
  const logs = spec.logs ?? [];
  const log = (after: number) =>
    logs.filter((l) => l.after === after).forEach((l) => ev('assistant', { text: l.text, parentToolUseId: spec.id, workflowRunId: spec.runId }));
  log(-1);
  const calls = new Map<string, SubagentRunView>();
  const end = START + spec.minutes * 60_000;
  spec.calls.forEach((call, index) => {
    const id = `${spec.id}#${index}`;
    ev('tool_use', {
      id,
      name: 'mcp__orbit__delegate',
      parentToolUseId: spec.id,
      workflowRunId: spec.runId,
      input: { description: call.label, prompt: call.prompt, workflow_phase: call.phase },
    });
    if (call.state !== 'queued') {
      const ended = call.state !== 'running';
      const created = START + index * 20_000;
      calls.set(id, {
        toolUseId: id,
        type: 'general',
        background: true,
        status: call.state === 'running' ? 'RUNNING' : call.state === 'done' ? 'DONE' : call.state === 'failed' ? 'FAILED' : 'INTERRUPTED',
        level: call.level ?? 'M',
        model: call.model ?? 'deepseek-chat',
        modelLabel: call.model ?? 'DeepSeek Chat',
        effort: null,
        reasons: [],
        why: null,
        removed: [],
        costUsd: ended ? call.cost ?? 0 : 0,
        resultSummary: ended ? call.result ?? null : null,
        workspaceName: null,
        description: call.label,
        engine: 'claude',
        readonly: false,
        changedFiles: [],
        workflowRunId: spec.runId,
        callIndex: index,
        label: call.label,
        phase: call.phase,
        createdAt: iso(created),
        endedAt: ended ? iso(Math.min(end, created + 90_000 + index * 10_000)) : null,
      });
      ev('assistant', { text: `Working on ${call.label}.`, parentToolUseId: id });
    }
    if (call.state !== 'running' && call.state !== 'queued') {
      ev('tool_result', {
        toolUseId: id,
        parentToolUseId: spec.id,
        isError: call.state !== 'done',
        content: JSON.stringify({ status: call.state.toUpperCase(), result: call.result ?? '' }),
      });
    }
    log(index);
  });
  const ended = [...calls.values()].filter((run) => run.status === 'DONE' || run.status === 'FAILED');
  const running = spec.status === 'RUNNING';
  if (!running) {
    ev('background_task', { toolUseId: spec.id, status: spec.status === 'DONE' ? 'completed' : 'failed', workflowRunId: spec.runId });
  }
  const view: WorkflowRunView = {
    id: spec.runId,
    toolUseId: spec.id,
    name: spec.name,
    description: spec.description,
    phases: spec.phases,
    status: spec.status,
    callsDone: ended.filter((run) => run.status === 'DONE').length,
    callsFailed: ended.filter((run) => run.status !== 'DONE').length,
    costUsd: spec.costUsd ?? ended.reduce((sum, run) => sum + run.costUsd, 0),
    maxCostUsd: spec.maxCostUsd ?? null,
    error: spec.error ?? null,
    createdAt: iso(START),
    endedAt: running ? null : iso(end),
  };
  return { events, runs: { workflows: new Map([[spec.id, view]]), calls }, running: running ? [spec.id] : [] };
}

/** Board part 2: a review mid-way, four reviewers done, the verifiers running, two queued, one failed. */
export const REVIEW_RUNNING: WorkflowSpec = {
  id: 'toolu_review',
  runId: '350WfReview00000000001',
  name: 'review-changes',
  description: 'Review the scheduler diff',
  phases: ['Review', 'Verify'],
  status: 'RUNNING',
  minutes: 4.083,
  calls: [
    { label: 'review:correctness', phase: 'Review', prompt: 'Review the diff for correctness', state: 'done', model: 'DeepSeek Chat', cost: 0.09, result: '2 findings' },
    { label: 'review:timezones', phase: 'Review', prompt: 'Review the diff for timezone bugs', state: 'done', model: 'GPT-5.6 Sol', cost: 0.18, result: '2 findings' },
    { label: 'review:concurrency', phase: 'Review', prompt: 'Review the diff for races', state: 'done', model: 'DeepSeek Chat', cost: 0.07, result: '1 finding' },
    { label: 'review:migrations', phase: 'Review', prompt: 'Review the diff for migration hazards', state: 'done', model: 'Kimi K3', cost: 0.11, result: '3 findings' },
    { label: 'verify', phase: 'Verify', prompt: 'nextRun() skips a day at DST end', state: 'done', level: 'S', model: 'DeepSeek Chat', cost: 0.03, result: 'Real: reproduced with Europe/Berlin, 2026-10-25' },
    { label: 'verify', phase: 'Verify', prompt: 'Lock released before the row write', state: 'done', level: 'S', model: 'DeepSeek Chat', cost: 0.02, result: 'Real: the lock is dropped one statement early' },
    { label: 'verify', phase: 'Verify', prompt: 'Migration drops an index in a transaction', state: 'failed', level: 'S', model: 'Claude Haiku 5.5', cost: 0, result: 'The SubAgent ended without a result.' },
    { label: 'verify', phase: 'Verify', prompt: 'Cron parse accepts 61 minutes', state: 'running', level: 'S', model: 'DeepSeek Chat' },
    { label: 'verify', phase: 'Verify', prompt: 'pause() races resume()', state: 'running', level: 'S', model: 'GPT-5.6 Sol' },
    { label: 'verify', phase: 'Verify', prompt: 'runAt stored without zone', state: 'running', level: 'S', model: 'DeepSeek Chat' },
    { label: 'verify', phase: 'Verify', prompt: 'Retry counter never resets', state: 'queued' },
    { label: 'verify', phase: 'Verify', prompt: 'Backfill loads every row', state: 'queued' },
  ],
  logs: [{ after: 3, text: '8 findings from 4 reviewers; verifying each one' }],
};

const reviewCalls = REVIEW_RUNNING.calls;

/** Board part 3 ①: the runner stopped with five calls ended and seven not. */
export const REVIEW_INTERRUPTED: WorkflowSpec = {
  ...REVIEW_RUNNING,
  id: 'toolu_interrupted',
  runId: '350WfInterrupted000001',
  status: 'INTERRUPTED',
  minutes: 3,
  costUsd: 0.61,
  error: 'The workflow was interrupted: the runner process hosting it stopped (a restart or an update).',
  logs: [],
  calls: [
    ...reviewCalls.slice(0, 5),
    ...reviewCalls.slice(5).map((call) => ({ ...call, state: 'interrupted' as const, cost: 0, result: 'The runner stopped before this SubAgent ended.' })),
  ],
};

/** Board part 3 ③: the caller's $5.00 limit reached; the three calls then running finished. */
export const FLAKY_COST_LIMIT: WorkflowSpec = {
  id: 'toolu_flaky',
  runId: '350WfFlaky000000000001',
  name: 'find-flaky',
  description: 'Hunt flaky specs until dry',
  phases: ['Hunt'],
  status: 'DONE',
  minutes: 12,
  maxCostUsd: 5,
  costUsd: 5,
  calls: Array.from({ length: 23 }, (_, i) => ({
    label: `hunt:${i + 1}`,
    phase: 'Hunt',
    prompt: `Run spec batch ${i + 1} ten times`,
    state: 'done' as const,
    level: 'S' as const,
    cost: i < 20 ? 0.25 : 0,
    result: i % 4 === 0 ? '1 flaky spec' : 'No flaky spec',
  })),
};

/** Board part 3 ⑤: the script threw before it made any call. */
export const AUDIT_SCRIPT_ERROR: WorkflowSpec = {
  id: 'toolu_audit',
  runId: '350WfAudit000000000001',
  name: 'audit-routes',
  description: 'Audit every route',
  phases: ['Audit'],
  status: 'FAILED',
  minutes: 0.02,
  calls: [],
  error:
    "the script threw: TypeError: Cannot read property 'length' of undefined\n\tat workflow.js:4:23(12)\n\tat workflow.js:1:13(3)",
};

/** Board part 2's head with a limit: `$0.84 of $5.00`. */
export const REVIEW_WITH_LIMIT: WorkflowSpec = { ...REVIEW_RUNNING, id: 'toolu_limited', runId: '350WfLimited0000000001', maxCostUsd: 5 };

/** The wake turn's note for the review once it finished (apiserver buildWorkflowFinishedBlock). */
export const REVIEW_FINISHED_NOTE = [
  '<orbit-workflow-finished>',
  '  Workflow review-changes — Review the scheduler diff (run 350WfReviewDone0000001) finished: DONE',
  '    Calls done: 11, failed: 1. Cost: $1.37.',
  '    Result: "3 confirmed findings."',
  '  The control plane opened this turn for it.',
  '</orbit-workflow-finished>',
].join('\n');

/** The same review, ended, as the server serves it once it finished. */
export const REVIEW_DONE: WorkflowSpec = {
  ...REVIEW_RUNNING,
  id: 'toolu_review_done',
  runId: '350WfReviewDone0000001',
  status: 'DONE',
  minutes: 6.667,
  costUsd: 1.37,
  calls: reviewCalls.map((call) =>
    call.state === 'running' || call.state === 'queued' ? { ...call, state: 'done' as const, cost: 0.1, result: 'Not real' } : call,
  ),
};

/** A `user` event as ingest stores a wake turn: the echo, and the block as the control plane's note. */
export const wakeEvent = (seq: number, note: string): RunEvent => ({
  seq,
  type: 'user',
  turnId: `turn-wake-${seq}`,
  ts: '2026-11-19T17:37:00.000Z',
  payload: { text: note, controlPlaneNote: note },
});

/** Several fixtures' runs as one session's. */
export function mergeRuns(...fixtures: WorkflowFixture[]): WorkflowRuns {
  return {
    workflows: new Map(fixtures.flatMap((f) => [...f.runs.workflows])),
    calls: new Map(fixtures.flatMap((f) => [...f.runs.calls])),
  };
}
