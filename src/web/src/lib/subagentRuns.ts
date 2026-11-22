import { delegateLaunchReceipt, toolResultText, type SubagentRunView } from '@orbit/shared';
import { useEffect, useState } from 'react';
import { getSessionSubagents } from '../api';
import type { RunEvent } from '../components/Transcript';
import { wikiDuration } from './wikiRuns';

/**
 * SubAgents in the transcript (docs/subagent-design.md §6.4): what a `mcp__orbit__delegate` block shows beside
 * its call — tier, model, Why and time (no cost) — read from the session's `subagent_run` rows.
 */

export const DELEGATE_TOOL = 'mcp__orbit__delegate';

const NO_RUNS: ReadonlyMap<string, SubagentRunView> = new Map();

/**
 * What moves a session's SubAgent runs: each top-level delegate call, its result, and the terminal
 * background_task a background run ends with. Empty when the transcript holds no delegate call, so a session
 * that never delegated reads nothing.
 */
export function delegateRunsSignature(events: readonly RunEvent[]): string {
  const calls = new Set<string>();
  const seqs: number[] = [];
  for (const event of events) {
    const p = (event.payload ?? {}) as { id?: unknown; name?: unknown; toolUseId?: unknown; parentToolUseId?: unknown };
    if (event.type === 'tool_use' && p.name === DELEGATE_TOOL && !p.parentToolUseId && typeof p.id === 'string') {
      calls.add(p.id);
      seqs.push(event.seq);
    } else if ((event.type === 'tool_result' || event.type === 'background_task') && calls.has(String(p.toolUseId))) {
      seqs.push(event.seq);
    }
  }
  return seqs.join(',');
}

interface SubagentFlight {
  /** True until the request has gone out: callers in the same tick join it. */
  starting: boolean;
  promise: Promise<SubagentRunView[]>;
  /** The one read issued when this one ends, for every caller that asked while it was in flight. */
  trailing: Promise<SubagentRunView[]> | null;
}

const flights = new Map<string, SubagentFlight>();

function beginRead(sessionId: string): Promise<SubagentRunView[]> {
  const flight: SubagentFlight = {
    starting: true,
    trailing: null,
    promise: Promise.resolve().then(() => {
      flight.starting = false;
      return getSessionSubagents(sessionId);
    }),
  };
  const done = () => {
    if (!flight.trailing && flights.get(sessionId) === flight) flights.delete(sessionId);
  };
  flight.promise.then(done, done);
  flights.set(sessionId, flight);
  return flight.promise;
}

/**
 * The one owner of `GET /sessions/:id/subagents`: the delegate view, the workflow view and the page's own read all
 * go through it, with at most one request in flight per session. Callers in the tick that starts a read join it
 * (the request goes out after they have). A caller that asks while it is in flight joins one trailing read, issued
 * when the first ends, so nobody gets an answer older than its own change and a burst is two requests at most.
 */
export function readSessionSubagents(sessionId: string): Promise<SubagentRunView[]> {
  const flight = flights.get(sessionId);
  if (!flight) return beginRead(sessionId);
  if (flight.starting) return flight.promise;
  flight.trailing ??= flight.promise.then(
    () => beginRead(sessionId),
    () => beginRead(sessionId),
  );
  return flight.trailing;
}

/** The session's SubAgent runs by delegate call, re-read whenever one starts or ends in the transcript. */
export function useSubagentRuns(sessionId: string, events: readonly RunEvent[]): ReadonlyMap<string, SubagentRunView> {
  const signature = delegateRunsSignature(events);
  const [state, setState] = useState<{ sessionId: string; runs: ReadonlyMap<string, SubagentRunView> }>({
    sessionId,
    runs: NO_RUNS,
  });
  useEffect(() => {
    if (!signature) return;
    let closed = false;
    readSessionSubagents(sessionId)
      .then((rows) => {
        if (!closed) setState({ sessionId, runs: new Map(rows.map((row) => [row.toolUseId, row])) });
      })
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [sessionId, signature]);
  return state.sessionId === sessionId ? state.runs : NO_RUNS;
}

/**
 * The block's grey meta: `M · Opus 5.5 · high`, then ` · on orbit-macos` for a run on another workspace
 * (docs/subagent-design.md §10.3), then ` · 3m 12s` once the run has ended; the run's cost is not shown. Null when there is nothing
 * to say yet.
 */
export function subagentMeta(run: SubagentRunView | undefined): string | null {
  if (!run) return null;
  const parts: string[] = [];
  if (run.level) parts.push(run.level);
  if (run.modelLabel ?? run.model) parts.push((run.modelLabel ?? run.model)!);
  if (run.effort) parts.push(run.effort);
  if (run.workspaceName) parts.push(`on ${run.workspaceName}`);
  if (run.status !== 'RUNNING' && run.endedAt) {
    parts.push(wikiDuration((Date.parse(run.endedAt) - Date.parse(run.createdAt)) / 1000));
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The opened block's first line, after its bold `Why`: the run's one-clause Why — the tier, the pick with its
 * provider once and why, any move, how many candidates were removed — or, for a row from before it was kept,
 * the router's reasons in order. A run on another workspace starts with how the workspace was chosen.
 */
export function subagentWhy(run: SubagentRunView | undefined): string | null {
  if (!run) return null;
  const why = run.why ?? (run.reasons?.length ? run.reasons.join(' · ') : null);
  // A run on another workspace leads with how that workspace was chosen (§10.3): its first reason.
  const chosen = run.workspaceName ? run.reasons?.[0] : undefined;
  if (chosen && why && !why.startsWith(chosen)) return `${chosen} · ${why}`;
  return why;
}

/** What the Why line opens to: every reason the router gave, then every candidate it removed with its reason. */
export function subagentWhyDetails(run: SubagentRunView | undefined): { reasons: string[]; removed: string[] } {
  const removed = (run?.removed ?? []).map((c) => {
    const engine = c.engine && c.engine !== c.provider ? ` (${c.engine})` : '';
    const model = c.model ? `, ${c.model}${c.effort ? ` · ${c.effort}` : ''}` : '';
    return `${c.provider}${engine}${model}: ${c.reason}`;
  });
  return { reasons: run?.why ? run.reasons : [], removed };
}

/**
 * What the opened block ends with: the text the SubAgent handed back. A foreground call's result is
 * `{ runId, status, result, … }`; a background call's is only its receipt, so its result comes from the run
 * once it has ended. Null while there is nothing to show; anything unrecognised is shown as it came.
 */
export function delegateResultText(content: unknown, run: SubagentRunView | undefined): string | null {
  const text = toolResultText(content);
  let parsed: { result?: unknown } | null = null;
  try {
    const value = JSON.parse(text.trim());
    if (value && typeof value === 'object') parsed = value;
  } catch {
    // The call's JSON clipped to a preview (the server trims a long result): the run's own text, never the
    // receipt's opening brace.
    if (text.trim().startsWith('{')) return run && run.status !== 'RUNNING' && run.resultSummary ? run.resultSummary : null;
    return text;
  }
  if (parsed && typeof parsed.result === 'string' && parsed.result) return parsed.result;
  if (run && run.status !== 'RUNNING' && run.resultSummary) return run.resultSummary;
  if (delegateLaunchReceipt(content)) return null;
  return text;
}

type ToolUsePayload = { id?: unknown; name?: unknown; input?: unknown; parentToolUseId?: unknown; subagentRunId?: unknown };

/**
 * The `delegate` call a SubAgent's approval card was asked from (docs/subagent-design.md §5.3), or null for a card
 * the session asked itself. The card's `toolUseId` is the child's call as the parent's transcript writes it, the
 * run id and the child's own id; that call nests under the delegate call. Before the child's call reaches the
 * transcript, any event of the same run says which delegate call it nests under.
 */
export function delegateCallOfApproval(
  approval: { subagentRunId?: string; toolUseId?: string },
  events: readonly RunEvent[],
): string | null {
  if (!approval.subagentRunId || !approval.toolUseId) return null;
  const uses = new Map<string, ToolUsePayload>();
  for (const event of events) {
    const p = (event.payload ?? {}) as ToolUsePayload;
    if (event.type === 'tool_use' && typeof p.id === 'string') uses.set(p.id, p);
  }
  let id = uses.get(approval.toolUseId)?.parentToolUseId;
  const colon = approval.toolUseId.indexOf(':');
  if (typeof id !== 'string' && colon > 0) {
    const run = approval.toolUseId.slice(0, colon);
    for (const use of uses.values()) {
      if (use.subagentRunId === run && typeof use.parentToolUseId === 'string' && uses.get(use.parentToolUseId)?.name === DELEGATE_TOOL) {
        return use.parentToolUseId;
      }
    }
  }
  // Up through the child's own nesting, if the call was one of its sub-agent's.
  for (let hops = 0; typeof id === 'string' && hops < 8; hops++) {
    const use = uses.get(id);
    if (!use) return null;
    if (use.name === DELEGATE_TOOL) return id;
    id = use.parentToolUseId;
  }
  return null;
}

/** A delegate call's `description`, as the parent wrote it; empty when the transcript does not have it. */
export function delegateDescription(callId: string | null, events: readonly RunEvent[]): string {
  if (!callId) return '';
  for (const event of events) {
    const p = (event.payload ?? {}) as ToolUsePayload;
    if (event.type === 'tool_use' && p.id === callId) {
      const description = (p.input as { description?: unknown } | undefined)?.description;
      return typeof description === 'string' ? description.trim() : '';
    }
  }
  return '';
}

/** What a card asks to do, in a few words, for the SubAgent block's `Waiting for approval · <action>`. */
export function approvalAction(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = [i.file_path, i.notebook_path, i.path].find((v): v is string => typeof v === 'string' && v !== '');
  if (typeof i.command === 'string' && i.command.trim()) return `Run ${i.command.trim().split('\n')[0]}`;
  if (path) return `${toolName} ${path.split('/').pop()}`;
  return toolName;
}

/** The run a `delegate` call's result names — its launch receipt's or its end's — or null before it has one. */
export function delegateRunId(content: unknown): string | null {
  try {
    const parsed: unknown = JSON.parse(toolResultText(content).trim());
    const runId = parsed && typeof parsed === 'object' ? (parsed as { runId?: unknown }).runId : undefined;
    return typeof runId === 'string' && runId !== '' ? runId : null;
  } catch {
    return null;
  }
}

/** Whether a run that has ended did not finish: failed or interrupted. A stopped run was stopped on purpose, so it is
 *  grey and no failure (docs/mocks/subagent-card-and-end-line D1). */
export const subagentRunFailed = (run: SubagentRunView): boolean =>
  run.status === 'FAILED' || run.status === 'INTERRUPTED';

/** How long a run took, once it has ended (`50s`, `4m 12s`); null while it runs. */
export function subagentDuration(run: SubagentRunView): string | null {
  if (run.status === 'RUNNING' || !run.endedAt) return null;
  return wikiDuration((Date.parse(run.endedAt) - Date.parse(run.createdAt)) / 1000);
}

/** An engine as an Agent's chip names it: short, since the model follows it (OrbitKit's `SubagentBlock.shortName`). */
export function agentShortName(engine: string): string {
  switch (engine) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'kimi': return 'Kimi';
    case 'antigravity': return 'Antigravity';
    case 'opencode': return 'OpenCode';
    case 'dsh': return 'DeepSeek';
    case 'cursor': return 'Cursor';
    default: return engine.charAt(0).toUpperCase() + engine.slice(1);
  }
}

/** The session an Agent was started from: its own engine and model. */
export interface AgentParent {
  engine: string | null;
  model: string | null;
}

/** One model the session's Agents ran on, with how many runs took it; `engine` gives the chip its mark. */
export interface AgentModelCount {
  label: string;
  engine: string | null;
  count: number;
}

/** One place the session's Agents ran: a workspace by name, or null for the session's own machine. */
export interface AgentMachineCount {
  name: string | null;
  count: number;
}

/**
 * The session's Agents, as the composer band's line and its list draw them — the web's copy of OrbitKit's
 * `SubagentSessionSummary` (docs/mocks/agents-band-models, revision 3). No cost anywhere.
 */
export interface SubagentSessionSummary {
  count: number;
  running: number;
  /** The running ones first, then the rest, each newest first. */
  rows: SubagentRunView[];
  /** The words after "Agents" (see `subagentSessionSummary`). */
  band: string;
  /** The models the runs took, most runs first. */
  models: AgentModelCount[];
  /** Every place the runs ran, most runs first; the session's own machine is `name: null`. */
  machines: AgentMachineCount[];
  /** Whether any run went to another workspace. */
  elsewhere: boolean;
  /** Whether any run went to another workspace or another model than the session's: the band shows where
   *  the work went only then, so a session whose Agents all ran on its own model and machine stays quiet. */
  spread: boolean;
  /** The newest running run, which the band names while one runs; null while none does. */
  current: SubagentRunView | null;
}

/** The model a run took, as its chip names it: the catalogue's label, the id, else its engine's name. */
export function agentModelLabel(run: SubagentRunView): string | null {
  return run.modelLabel ?? run.model ?? (run.engine ? agentShortName(run.engine) : null);
}

/**
 * Whether a run ran on the session's own machine and model: a shadow row (no engine of its own) runs on the
 * parent's, and a run on the parent's engine with the parent's model is no different from the parent.
 */
export function agentRunIsOwn(run: SubagentRunView, parent: AgentParent | undefined): boolean {
  if (run.workspaceName) return false;
  if (!run.engine) return true;
  return !!parent && run.engine === parent.engine && (run.model ?? null) === (parent.model ?? null);
}

/**
 * Null when the session started no Agent. While one runs the band says what it is doing, by its `delegate`
 * description; several running lead with how many (`2 running · Deploy …`), naming the newest; a running run
 * with no description keeps the counts (`2 · 1 running`). With none running it is the count alone: the
 * models and machines say what was done, and each run's title is on its row in the list.
 */
export function subagentSessionSummary(
  runs: Iterable<SubagentRunView>,
  parent?: AgentParent,
): SubagentSessionSummary | null {
  const all = [...runs];
  if (all.length === 0) return null;
  const newestFirst = (a: SubagentRunView, b: SubagentRunView) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  const going = all.filter((run) => run.status === 'RUNNING').sort(newestFirst);
  const rows = [...going, ...all.filter((run) => run.status !== 'RUNNING').sort(newestFirst)];
  const count = all.length;
  const running = going.length;
  const described = (run: SubagentRunView | undefined) => run?.description?.trim() ?? '';
  let band: string;
  if (running === 0) {
    band = `${count}`;
  } else {
    const newest = described(going[0]);
    band = !newest ? `${count} · ${running} running` : running > 1 ? `${running} running · ${newest}` : newest;
  }
  const models = new Map<string, AgentModelCount>();
  const machines = new Map<string | null, AgentMachineCount>();
  // Oldest first, so a tie keeps the order the runs were started in.
  for (const run of [...rows].reverse()) {
    const label = agentModelLabel(run);
    if (label) {
      const engine = run.engine ?? parent?.engine ?? null;
      const key = `${engine ?? ''}\u0000${label}`;
      const seen = models.get(key);
      if (seen) seen.count++;
      else models.set(key, { label, engine, count: 1 });
    }
    const name = run.workspaceName ?? null;
    const place = machines.get(name);
    if (place) place.count++;
    else machines.set(name, { name, count: 1 });
  }
  const byCount = <T extends { count: number }>(list: T[]) => list.sort((a, b) => b.count - a.count);
  return {
    count,
    running,
    rows,
    band,
    models: byCount([...models.values()]),
    machines: byCount([...machines.values()]),
    elsewhere: all.some((run) => !!run.workspaceName),
    spread: all.some((run) => !agentRunIsOwn(run, parent)),
    current: going[0] ?? null,
  };
}
