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
 * The block's grey meta: `M · Opus 5.5 · high`, then ` · 3m 12s · $0.21` once the run has ended. Null when
 * there is nothing to say yet.
 */
export function subagentMeta(run: SubagentRunView | undefined): string | null {
  if (!run) return null;
  const parts: string[] = [];
  if (run.level) parts.push(run.level);
  if (run.modelLabel ?? run.model) parts.push((run.modelLabel ?? run.model)!);
  if (run.effort) parts.push(run.effort);
  if (run.status !== 'RUNNING' && run.endedAt) {
    parts.push(wikiDuration((Date.parse(run.endedAt) - Date.parse(run.createdAt)) / 1000));
    parts.push(`$${run.costUsd.toFixed(2)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** The opened block's first line, after its bold `Why`: the router's reasons, in order. */
export function subagentWhy(run: SubagentRunView | undefined): string | null {
  return run && run.reasons.length ? run.reasons.join(' · ') : null;
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
