// How far a background sub-agent or workflow has got: the runner's relay of Claude Code's
// `task_started` / `task_progress` frames (runner-go claude_task_progress.go), keyed by the
// launching Agent/Workflow call's tool_use id. It arrives live as TASK_PROGRESS events (never
// stored, each one the whole picture so far), and once more as the `progress` of the durable
// BACKGROUND_TASK that ends the task. The native twin is OrbitKit's `TaskProgress`.

export interface TaskProgressAgent {
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  /** The CLI's own word: `start` (queued), `running`, `done`, `error`, … */
  state?: string;
  model?: string;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  error?: string;
  /** Answered from the workflow's journal on a resume rather than run again. */
  cached?: boolean;
}

export interface TaskProgress {
  toolUseId: string;
  taskId?: string;
  /** `local_agent`, `local_workflow`, … — said only by the frame that starts the task. */
  taskType?: string;
  description?: string;
  workflowName?: string;
  lastToolName?: string;
  summary?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  phases: Array<{ index: number; title: string }>;
  agents: TaskProgressAgent[];
  logs: string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Read a TASK_PROGRESS payload, or a BACKGROUND_TASK's `progress`. Null when it names no call to
 * hang on; every other field is optional, because each runner release may send less.
 */
export function parseTaskProgress(payload: unknown): TaskProgress | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const toolUseId = str(p.toolUseId);
  if (!toolUseId) return null;
  const usage = p.usage && typeof p.usage === 'object' ? (p.usage as Record<string, unknown>) : null;
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
  return {
    toolUseId,
    taskId: str(p.taskId),
    taskType: str(p.taskType),
    description: str(p.description),
    workflowName: str(p.workflowName),
    lastToolName: str(p.lastToolName),
    summary: str(p.summary),
    usage: usage
      ? {
          totalTokens: num(usage.totalTokens) ?? 0,
          toolUses: num(usage.toolUses) ?? 0,
          durationMs: num(usage.durationMs) ?? 0,
        }
      : undefined,
    phases: list(p.phases)
      .filter((ph) => num(ph.index) !== undefined)
      .map((ph) => ({ index: num(ph.index)!, title: str(ph.title) ?? '' })),
    agents: list(p.agents)
      .filter((a) => num(a.index) !== undefined)
      .map((a) => ({
        index: num(a.index)!,
        label: str(a.label) ?? '',
        phaseIndex: num(a.phaseIndex),
        phaseTitle: str(a.phaseTitle),
        state: str(a.state),
        model: str(a.model),
        tokens: num(a.tokens),
        toolCalls: num(a.toolCalls),
        lastToolName: str(a.lastToolName),
        lastToolSummary: str(a.lastToolSummary),
        error: str(a.error),
        cached: a.cached === true ? true : undefined,
      })),
    logs: Array.isArray(p.logs) ? p.logs.filter((l): l is string => typeof l === 'string') : [],
  };
}
