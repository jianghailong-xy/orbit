import type { SubagentRunStatus, SubagentRunView, WorkflowRunView } from '@orbit/shared';
import { DELEGATE_TOOL } from './subagentRuns';

/**
 * An Orbit workflow's block in the transcript (docs/mocks/subagent-workflow/board.html parts 2 and 3): what its
 * head, its calls grouped by phase, its log lines and its banners say, read from the server's `WorkflowRunView`
 * and its calls' SubAgent runs, with the transcript giving only which calls were made, in what order, and where
 * the script's `log()` lines fell among them.
 */

/** What the block reads of a workflow call's nested events: its `agent()` calls and its log lines. */
export interface WorkflowChild {
  kind: string;
  seq: number;
  /** A call's (`kind: 'tool'`). */
  id?: string;
  name?: string;
  input?: any;
  result?: { isError?: boolean };
  /** A log line's (`kind: 'assistant'`). */
  text?: string;
}
type CallChild = WorkflowChild & { id: string };

/** `stopped`: ended because the workflow was interrupted or stopped, not by its own failure. */
export type WorkflowCallState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowCall {
  /** The call's tool_use id, `<workflow call>#<callIndex>`. */
  id: string;
  label: string;
  /** Its result's first line once it ended, else its prompt's. */
  line: string;
  phase: string | null;
  state: WorkflowCallState;
  /** `tier · model · $cost`, the cost once it ended; null for a queued call. */
  meta: string | null;
}

export type WorkflowItem = { kind: 'call'; call: WorkflowCall } | { kind: 'log'; seq: number; text: string };

export interface WorkflowGroup {
  phase: string | null;
  items: WorkflowItem[];
  /** `3 done · 1 failed · 3 running · 2 queued`, leaving out what is none. */
  counts: string;
}

/** The open block's body, in the order the script made it: phase groups, with log lines between them. */
export type WorkflowSection = { kind: 'group'; group: WorkflowGroup } | { kind: 'log'; seq: number; text: string };

export interface WorkflowModel {
  status: SubagentRunStatus;
  /** Calls that ended (done or failed), and calls the script made. */
  ended: number;
  started: number;
  /** `7 / 12 · $0.84`, or `… · $0.84 of $5.00` with a limit; the cost only once the server has said it. */
  badge: string;
  /** The folded block's second line while it runs: `Verify · 3 running, 2 queued`. */
  live: string | null;
  sections: WorkflowSection[];
  banners: Array<{ tone: 'warn' | 'bad'; text: string }>;
}

export const usd = (value: number): string => `$${value.toFixed(2)}`;

/** `4m 05s`, `1h 02m`, `40s`, as the board writes a workflow's time. */
export function workflowDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** How long a workflow ran, or has run by `now`. */
export function workflowElapsed(view: Pick<WorkflowRunView, 'createdAt' | 'endedAt'>, now: number): string {
  const end = view.endedAt ? Date.parse(view.endedAt) : now;
  return workflowDuration((end - Date.parse(view.createdAt)) / 1000);
}

const firstLine = (text: unknown): string =>
  typeof text === 'string' ? text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '' : '';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function callOf(child: CallChild, run: SubagentRunView | undefined): WorkflowCall {
  const input = (child.input ?? {}) as { description?: unknown; prompt?: unknown; workflow_phase?: unknown };
  const state: WorkflowCallState = run
    ? run.status === 'RUNNING'
      ? 'running'
      : run.status === 'DONE'
        ? 'done'
        : run.status === 'FAILED'
          ? 'failed'
          : 'stopped'
    : child.result
      ? child.result.isError
        ? 'failed'
        : 'done'
      : 'queued';
  const ended = state !== 'queued' && state !== 'running';
  const meta = run
    ? [run.level, run.modelLabel ?? run.model, ended && run.costUsd > 0 ? usd(run.costUsd) : null].filter(Boolean).join(' · ') ||
      null
    : null;
  const phase = run?.phase ?? (typeof input.workflow_phase === 'string' && input.workflow_phase ? input.workflow_phase : null);
  return {
    id: child.id,
    label: run?.label ?? (typeof input.description === 'string' && input.description ? input.description : 'agent'),
    line: (ended && firstLine(run?.resultSummary)) || firstLine(input.prompt),
    phase,
    state,
    meta,
  };
}

function groupCounts(calls: WorkflowCall[]): string {
  const n = (state: WorkflowCallState) => calls.filter((call) => call.state === state).length;
  return [
    [n('done'), 'done'],
    [n('failed'), 'failed'],
    [n('stopped'), 'stopped'],
    [n('running'), 'running'],
    [n('queued'), 'queued'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(' · ');
}

/** The script's error as one line: its message and the script's line, without the runner's lead-in. */
export function scriptErrorText(error: string): { threw: boolean; text: string } {
  const m = /^the script (threw|failed): ([\s\S]*)$/.exec(error.trim());
  const body = m ? m[2] : error.trim();
  const message = firstLine(body.split(/\s+at\s/)[0]) || firstLine(body);
  const line = /workflow\.js:(\d+)/.exec(body)?.[1];
  return { threw: !m || m[1] === 'threw', text: line ? `${message} (line ${line})` : message };
}

const BUDGET_SPENT = /WorkflowBudgetSpent/;

function bannersOf(view: WorkflowRunView, calls: WorkflowCall[], runs: SubagentRunView[]): WorkflowModel['banners'] {
  const banners: WorkflowModel['banners'] = [];
  if (view.status === 'INTERRUPTED') {
    const kept = calls.filter((call) => call.state === 'done').length;
    const left = calls.length - kept;
    banners.push({
      tone: 'warn',
      text:
        `Interrupted: the runner stopped. ${plural(kept, 'call', 'calls')} finished and ${kept === 1 ? 'is' : 'are'} kept` +
        (left > 0 ? `; the other ${left} did not finish.` : '.'),
    });
  }
  const limit = view.maxCostUsd;
  const limitReached = limit !== null && (view.costUsd >= limit || BUDGET_SPENT.test(view.error ?? ''));
  if (limitReached && view.status !== 'RUNNING') {
    // The calls still running when the spend reached the limit: those started before the call whose end
    // reached it, and ended after.
    const byEnd = runs.filter((run) => run.endedAt).sort((a, b) => Date.parse(a.endedAt!) - Date.parse(b.endedAt!));
    let spent = 0;
    let at: number | null = null;
    for (const run of byEnd) {
      spent += run.costUsd;
      if (spent >= limit) {
        at = Date.parse(run.endedAt!);
        break;
      }
    }
    const running =
      at === null ? 0 : runs.filter((run) => Date.parse(run.createdAt) <= at! && (!run.endedAt || Date.parse(run.endedAt) > at!)).length;
    const after =
      running > 0
        ? ` The ${running === 1 ? 'call' : `${running} calls`} already running finished`
        : ' No call was running then';
    banners.push({
      tone: 'warn',
      text:
        `Stopped starting calls at the ${usd(limit)} limit the caller set.${after}` +
        (view.status === 'DONE' ? '; the script returned what it had.' : '.'),
    });
  }
  if (view.status === 'FAILED' && view.error) {
    const { threw, text } = scriptErrorText(view.error);
    const lead = threw ? (calls.length === 0 ? 'The script threw before any call' : 'The script threw') : 'The script failed';
    banners.push({ tone: 'bad', text: `${lead}: ${text}` });
  }
  return banners;
}

/**
 * The block as the board draws it. `view` is the server's workflow, absent until it is read (and wherever nothing
 * reads it: a share page, an export); `running` then says whether the workflow call still runs. `calls` are the
 * session's workflow calls' runs by call.
 */
export function workflowModel(
  view: WorkflowRunView | undefined,
  children: readonly WorkflowChild[],
  calls: ReadonlyMap<string, SubagentRunView>,
  running: boolean,
): WorkflowModel {
  const sections: WorkflowSection[] = [];
  const all: WorkflowCall[] = [];
  let group: WorkflowGroup | null = null;
  let logs: Array<{ seq: number; text: string }> = [];
  for (const child of children) {
    if (child.kind === 'assistant' && typeof child.text === 'string' && child.text.trim()) {
      logs.push({ seq: child.seq, text: child.text.trim() });
      continue;
    }
    if (child.kind !== 'tool' || child.name !== DELEGATE_TOOL || typeof child.id !== 'string') continue;
    const call = callOf(child as CallChild, calls.get(child.id));
    all.push(call);
    if (group && group.phase === call.phase) {
      // A log line among one phase's calls stays where it fell, inside the group.
      group.items.push(...logs.map((log) => ({ kind: 'log' as const, ...log })));
    } else {
      sections.push(...logs.map((log) => ({ kind: 'log' as const, ...log })));
      group = { phase: call.phase, items: [], counts: '' };
      sections.push({ kind: 'group', group });
    }
    logs = [];
    group.items.push({ kind: 'call', call });
  }
  sections.push(...logs.map((log) => ({ kind: 'log' as const, ...log })));
  for (const section of sections) {
    if (section.kind === 'group') {
      section.group.counts = groupCounts(
        section.group.items.flatMap((item) => (item.kind === 'call' ? [item.call] : [])),
      );
    }
  }
  const status: SubagentRunStatus = view?.status ?? (running ? 'RUNNING' : 'DONE');
  const ended = all.filter((call) => call.state === 'done' || call.state === 'failed').length;
  const started = Math.max(all.length, view ? view.callsDone + view.callsFailed : 0);
  // Counted from the calls, not the runner's totals, which count an interrupted call as failed.
  const shownEnded = ended;
  const cost = view
    ? view.maxCostUsd !== null
      ? `${usd(view.costUsd)} of ${usd(view.maxCostUsd)}`
      : usd(view.costUsd)
    : null;
  let live: string | null = null;
  if (status === 'RUNNING') {
    const runningCount = all.filter((call) => call.state === 'running').length;
    const queued = all.filter((call) => call.state === 'queued').length;
    const counts = [runningCount ? `${runningCount} running` : '', queued ? `${queued} queued` : ''].filter(Boolean).join(', ');
    const phase = all.length ? all[all.length - 1].phase : null;
    live = [phase, counts].filter(Boolean).join(' · ') || null;
  }
  const runs = view ? [...calls.values()].filter((run) => run.workflowRunId === view.id) : [];
  return {
    status,
    ended: shownEnded,
    started,
    // A workflow that made no call has spent nothing worth a figure.
    badge: [`${shownEnded} / ${started}`, started > 0 ? cost : null].filter(Boolean).join(' · '),
    live,
    sections,
    banners: view ? bannersOf(view, all, runs) : [],
  };
}

// ── The turn the control plane opens when a workflow ends ─────────────────────────────────────────────

/**
 * One workflow's end, as the apiserver's `buildWorkflowFinishedBlock` (runner-api/background-job-wake.ts) spells
 * it out, with `fileWorkflowWake`'s excerpt:
 *
 *     <orbit-workflow-finished>
 *       Workflow <name>[ — <description>] (run <id>) finished: <STATUS>
 *       <why, for an interrupted one>
 *         Calls done: <n>, failed: <n>. Cost: $<x>.
 *         Error: <error>          (when it has one)
 *         Result: <JSON>          (when it returned something)
 *       <one sentence for the agent>
 *     </orbit-workflow-finished>
 */
export interface WorkflowFinishedRun {
  runId: string;
  name: string;
  description: string | null;
  status: string;
  callsDone: number | null;
  callsFailed: number | null;
  costUsd: number | null;
  error: string | null;
  /** What the script returned: a returned string as itself, anything else as its JSON. */
  result: string | null;
}

export interface WorkflowFinished {
  runs: WorkflowFinishedRun[];
  /** Whatever else the note carried, outside the workflow block. */
  rest: string;
}

const WF_BLOCK = /<orbit-workflow-finished>\n([\s\S]*?)\n<\/orbit-workflow-finished>/g;
const WF_HEAD = /^ {2}Workflow (.+?)(?: — (.+))? \(run (\S+)\) finished: ([A-Z]+)$/;
const WF_STATS = /^Calls done: (\d+), failed: (\d+)\. Cost: \$([\d.]+)\.$/;

/** The workflow block in a control plane note, or null for a note carrying none it can read. */
export function parseWorkflowFinished(note: string | null | undefined): WorkflowFinished | null {
  if (typeof note !== 'string' || !note.includes('<orbit-workflow-finished>')) return null;
  const runs: WorkflowFinishedRun[] = [];
  let rest = '';
  let end = 0;
  WF_BLOCK.lastIndex = 0;
  for (let m = WF_BLOCK.exec(note); m; m = WF_BLOCK.exec(note)) {
    rest += note.slice(end, m.index);
    end = m.index + m[0].length;
    let run: WorkflowFinishedRun | null = null;
    let field: 'error' | 'result' | null = null;
    const body: Record<'error' | 'result', string[]> = { error: [], result: [] };
    const close = () => {
      if (!run) return;
      run.error = body.error.length ? body.error.join('\n').trim() : null;
      const result = body.result.join('\n').trim();
      if (result) {
        try {
          const value = JSON.parse(result);
          run.result = typeof value === 'string' ? value : result;
        } catch {
          run.result = result;
        }
      }
      body.error = [];
      body.result = [];
      field = null;
    };
    for (const line of m[1].split('\n')) {
      const head = WF_HEAD.exec(line);
      if (head) {
        close();
        run = {
          name: head[1], description: head[2] ?? null, runId: head[3], status: head[4],
          callsDone: null, callsFailed: null, costUsd: null, error: null, result: null,
        };
        runs.push(run);
        continue;
      }
      if (!run || !line.startsWith('    ')) {
        field = null;
        continue;
      }
      const text = line.slice(4);
      const stats = WF_STATS.exec(text);
      const current = run as WorkflowFinishedRun;
      if (stats && current.callsDone === null) {
        current.callsDone = Number(stats[1]);
        current.callsFailed = Number(stats[2]);
        current.costUsd = Number(stats[3]);
      } else if (text.startsWith('Error: ')) {
        field = 'error';
        body.error.push(text.slice(7));
      } else if (text.startsWith('Result: ')) {
        field = 'result';
        body.result.push(text.slice(8));
      } else if (field) {
        body[field].push(text);
      }
    }
    close();
  }
  if (runs.length === 0) return null;
  return { runs, rest: (rest + note.slice(end)).replace(/\n{3,}/g, '\n\n').trim() };
}

/** The strip's title for one workflow's end. */
export function workflowFinishedTitle(run: Pick<WorkflowFinishedRun, 'status'>): string {
  switch (run.status) {
    case 'DONE':
      return 'Workflow finished';
    case 'INTERRUPTED':
      return 'Workflow interrupted';
    case 'STOPPED':
      return 'Workflow stopped';
    default:
      return 'Workflow failed';
  }
}

/** The strip's first line after its title: name, calls, time (when known) and cost. */
export function workflowFinishedLine(run: WorkflowFinishedRun, elapsed: string | null): string {
  const parts = [run.name];
  if (run.callsDone !== null && run.callsFailed !== null) {
    const total = run.callsDone + run.callsFailed;
    parts.push(
      run.callsFailed > 0
        ? `${plural(total, 'call', 'calls')} (${run.callsDone} done, ${run.callsFailed} failed)`
        : plural(total, 'call', 'calls'),
    );
  }
  if (elapsed) parts.push(elapsed);
  if (run.costUsd !== null) parts.push(usd(run.costUsd));
  return parts.join(' · ');
}

/** The strip's second line: what the script returned, or why it did not finish. */
export function workflowFinishedOutcome(run: WorkflowFinishedRun): string {
  if (run.status === 'DONE') return run.result ? `Returned ${firstLine(run.result)}` : 'Returned nothing.';
  if (run.status === 'FAILED' && run.error) {
    const { threw, text } = scriptErrorText(run.error);
    return `${threw ? 'The script threw' : 'The script failed'}: ${text}`;
  }
  return firstLine(run.error) || (run.result ? `Returned ${firstLine(run.result)}` : '');
}
