import { delegateLaunchReceipt, toolResultText, type SubagentRunView } from '@orbit/shared';
import { useEffect, useState } from 'react';
import { getSessionSubagents } from '../api';
import type { RunEvent } from '../components/Transcript';
import { wikiDuration } from './wikiRuns';

/**
 * SubAgents in the transcript (docs/subagent-design.md §6.4): what a `mcp__orbit__delegate` block shows beside
 * its call — tier, model, Why, time and cost — read from the session's `subagent_run` rows.
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
    getSessionSubagents(sessionId)
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
 * (docs/subagent-design.md §10.3), then ` · 3m 12s · $0.21` once the run has ended. Null when there is nothing
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
    parts.push(`$${run.costUsd.toFixed(2)}`);
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
