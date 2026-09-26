// The words and numbers a background agent's or workflow's progress is drawn with — the card badge,
// the per-phase agent list, the footer, the tray's one-line summary. Written once here for web and
// ported line for line to OrbitKit's `TaskProgressCopy`; both are held to the same golden table
// (taskProgressCopy.golden.json), which is what keeps the two clients saying the same thing.

import { workflowLaunchReceipt } from './events';
import type { TaskProgress, TaskProgressAgent } from './taskProgress';

/** Where one agent of a workflow stands, reduced to the four states a row draws. */
export type AgentLane = 'done' | 'running' | 'queued' | 'failed';

export function agentLane(a: TaskProgressAgent): AgentLane {
  if (a.error || a.state === 'error' || a.state === 'failed') return 'failed';
  if (a.state === 'done' || a.cached) return 'done';
  if (!a.state || a.state === 'start' || a.state === 'queued' || a.state === 'pending') return 'queued';
  return 'running';
}

export interface ProgressPhaseGroup {
  title: string;
  done: number;
  total: number;
  agents: TaskProgressAgent[];
}

/** The agents grouped by the phase the script put them in, phases in their own order. */
export function progressPhaseGroups(p: TaskProgress): ProgressPhaseGroup[] {
  const byPhase = new Map<number, TaskProgressAgent[]>();
  for (const a of p.agents) {
    const key = a.phaseIndex ?? -1;
    const list = byPhase.get(key) ?? [];
    list.push(a);
    byPhase.set(key, list);
  }
  return [...byPhase.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, agents]) => {
      const sorted = [...agents].sort((x, y) => x.index - y.index);
      const title =
        p.phases.find((ph) => ph.index === index)?.title || sorted.find((a) => a.phaseTitle)?.phaseTitle || '';
      return {
        title,
        done: sorted.filter((a) => agentLane(a) === 'done').length,
        total: sorted.length,
        agents: sorted,
      };
    });
}

/** The badge on the card: a workflow's agents done out of all, an agent's tool calls. */
export function progressBadge(p: TaskProgress): string | null {
  if (p.agents.length > 0) {
    const done = p.agents.filter((a) => agentLane(a) === 'done').length;
    return `${done}/${p.agents.length}`;
  }
  const calls = p.usage?.toolUses ?? 0;
  return calls > 0 ? String(calls) : null;
}

const tools = (n: number): string => (n === 1 ? '1 tool' : `${n} tools`);
const toolCalls = (n: number): string => (n === 1 ? '1 tool call' : `${n} tool calls`);

/** The right-hand word of an agent's row. */
export function agentDetail(a: TaskProgressAgent): string {
  const lane = agentLane(a);
  if (lane === 'failed') return 'failed';
  if (a.cached) return 'cached';
  if (lane === 'queued') return 'queued';
  return a.toolCalls != null ? tools(a.toolCalls) : '';
}

/** What a running agent is doing right now: its current tool and what it is doing with it. */
export function agentNow(a: TaskProgressAgent): string {
  if (agentLane(a) !== 'running') return '';
  return [a.lastToolName, a.lastToolSummary].filter(Boolean).join(' ');
}

/** 45s · 17m · 1h 5m */
export function progressDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

function totalToolCalls(p: TaskProgress): number {
  return p.usage?.toolUses ?? p.agents.reduce((n, a) => n + (a.toolCalls ?? 0), 0);
}

/** The footer under the list: "113 tool calls · 17m". */
export function progressFooter(p: TaskProgress): string {
  const parts: string[] = [];
  const n = totalToolCalls(p);
  if (n > 0) parts.push(toolCalls(n));
  if (p.usage && p.usage.durationMs > 0) parts.push(progressDuration(p.usage.durationMs));
  return parts.join(' · ');
}

/**
 * The tray row's second line while the work runs: where a workflow is ("Design 2/3 ·
 * design:entity-graph running · 113 tool calls"), what an agent is doing ("Bash · 46 tool calls").
 */
export function progressTrayLine(p: TaskProgress): string | null {
  const parts: string[] = [];
  if (p.agents.length > 0) {
    const groups = progressPhaseGroups(p);
    const current = groups.find((g) => g.done < g.total) ?? groups[groups.length - 1];
    if (current) parts.push(`${current.title ? `${current.title} ` : ''}${current.done}/${current.total}`);
    const running = p.agents.filter((a) => agentLane(a) === 'running');
    if (running.length === 1) parts.push(`${running[0].label} running`);
    else if (running.length > 1) parts.push(`${running.length} agents running`);
  } else if (p.lastToolName) {
    parts.push(p.lastToolName);
  }
  const n = totalToolCalls(p);
  if (n > 0) parts.push(toolCalls(n));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * What a Workflow call is called: its launch receipt's summary, else the progress's description,
 * else the `description` in the script's own `meta`. A resumed run carries no script at all, so the
 * receipt is what names it.
 */
export function workflowTitle(input: unknown, result: unknown, progress?: TaskProgress | null): string | undefined {
  const receipt = result == null ? null : workflowLaunchReceipt(result);
  if (receipt?.summary) return receipt.summary;
  if (progress?.description) return progress.description;
  const script = input && typeof input === 'object' ? (input as { script?: unknown }).script : undefined;
  return typeof script === 'string' ? scriptMetaDescription(script) : undefined;
}

/**
 * The first `description: '…'` in a workflow script — its `meta` block opens every script. Read by
 * hand rather than by a regex with a back-reference, so OrbitKit's port reads it the same way.
 */
export function scriptMetaDescription(script: string): string | undefined {
  const at = script.indexOf('description');
  if (at < 0) return undefined;
  let i = at + 'description'.length;
  while (i < script.length && /\s/.test(script[i])) i += 1;
  if (script[i] !== ':') return undefined;
  i += 1;
  while (i < script.length && /\s/.test(script[i])) i += 1;
  const quote = script[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let out = '';
  for (i += 1; i < script.length; i += 1) {
    const ch = script[i];
    if (ch === '\\' && i + 1 < script.length) {
      out += script[i + 1];
      i += 1;
      continue;
    }
    if (ch === quote) return out || undefined;
    out += ch;
  }
  return undefined;
}
