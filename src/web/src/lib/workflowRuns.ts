import { ORBIT_WORKFLOW_TOOL, type SubagentRunView, type WorkflowRunView } from '@orbit/shared';
import { createContext, useEffect, useState } from 'react';
import { getSessionWorkflows } from '../api';
import type { RunEvent } from '../components/Transcript';
import { DELEGATE_TOOL, readSessionSubagents } from './subagentRuns';

/**
 * Orbit workflows in the transcript (docs/subagent-workflow-design.md §3.3): what a `mcp__orbit__workflow` block
 * shows of the workflow and of each of its calls, read from the server (`GET /sessions/:id/workflows` and the
 * SubAgent runs that are its calls), never from the transcript's text.
 */
export interface WorkflowRuns {
  /** The session's workflows by `mcp__orbit__workflow` call. */
  workflows: ReadonlyMap<string, WorkflowRunView>;
  /** Their calls' SubAgent runs by call: `<workflow call>#<callIndex>`, as the transcript nests it under the workflow. */
  calls: ReadonlyMap<string, SubagentRunView>;
}

const NO_RUNS: WorkflowRuns = { workflows: new Map(), calls: new Map() };

/** The session's workflows and their calls' runs (`useWorkflowRuns`), for the transcript's workflow blocks. Empty
 *  where nothing reads them: a share page, an export. */
export const WorkflowRunsCtx = createContext<WorkflowRuns>(NO_RUNS);

/**
 * What moves a session's workflows and their calls' runs, as the runner draws a workflow (runner-go
 * subagent_workflow.go): the top-level workflow call and its receipt (the workflow opened), each `agent()` as a
 * delegate call nested under it (a call made, queued until its run opens), the first event of that call's SubAgent
 * (its run opened), the call's result (its run ended) and the workflow call's background_task (the workflow ended).
 * The rest of a call's events and the script's log lines move nothing. Empty when the transcript holds no workflow.
 */
export function workflowRunsSignature(events: readonly RunEvent[]): string {
  const workflows = new Set<string>();
  const calls = new Set<string>();
  const opened = new Set<string>();
  const seqs: number[] = [];
  for (const event of events) {
    const p = (event.payload ?? {}) as { id?: unknown; name?: unknown; toolUseId?: unknown; parentToolUseId?: unknown };
    const parent = typeof p.parentToolUseId === 'string' ? p.parentToolUseId : null;
    if (event.type === 'tool_use' && typeof p.id === 'string' && !parent && p.name === ORBIT_WORKFLOW_TOOL) {
      workflows.add(p.id);
      seqs.push(event.seq);
    } else if (event.type === 'tool_use' && typeof p.id === 'string' && parent && workflows.has(parent) && p.name === DELEGATE_TOOL) {
      calls.add(p.id);
      seqs.push(event.seq);
    } else if (
      (event.type === 'tool_result' || event.type === 'background_task') &&
      (workflows.has(String(p.toolUseId)) || calls.has(String(p.toolUseId)))
    ) {
      seqs.push(event.seq);
    } else if (parent && calls.has(parent) && !opened.has(parent)) {
      opened.add(parent);
      seqs.push(event.seq);
    }
  }
  return seqs.join(',');
}

/**
 * The session's workflows and their calls' runs, re-read whenever a workflow opens, one of its calls starts or
 * ends, or it ends (`workflowRunsSignature`), as `useSubagentRuns` re-reads a session's delegate calls. A session
 * that never ran a workflow reads nothing, and a failed read is left alone until the transcript moves again.
 */
export function useWorkflowRuns(sessionId: string, events: readonly RunEvent[]): WorkflowRuns {
  const signature = workflowRunsSignature(events);
  const [state, setState] = useState<{ sessionId: string; runs: WorkflowRuns }>({ sessionId, runs: NO_RUNS });
  useEffect(() => {
    if (!signature) return;
    let closed = false;
    Promise.all([getSessionWorkflows(sessionId), readSessionSubagents(sessionId)])
      .then(([workflows, runs]) => {
        if (closed) return;
        setState({
          sessionId,
          runs: {
            workflows: new Map(workflows.map((row) => [row.toolUseId, row])),
            calls: new Map(runs.filter((row) => row.workflowRunId).map((row) => [row.toolUseId, row])),
          },
        });
      })
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [sessionId, signature]);
  return state.sessionId === sessionId ? state.runs : NO_RUNS;
}
