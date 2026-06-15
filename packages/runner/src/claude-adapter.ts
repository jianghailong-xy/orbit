import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ClaimedJob, ModelUsage, RunEventType, RunStatus, TokenUsage } from '@orbit/shared';

export interface ExecResult {
  status: RunStatus;
  result?: string;
  subtype?: string;
  error?: string;
  claudeSessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
}

export type EmitFn = (type: RunEventType, payload: Record<string, unknown>) => void;

/**
 * Drive Claude Code for one job. Prefers the Agent SDK (`query()`); falls back to
 * the `claude -p --output-format stream-json` CLI when the SDK isn't installed or
 * `ORBIT_CLAUDE_MODE=cli` is set. Both paths normalize into the same event stream.
 */
export async function executeJob(
  job: ClaimedJob,
  emit: EmitFn,
  signal: AbortSignal,
  workdir: string,
): Promise<ExecResult> {
  if (process.env.ORBIT_CLAUDE_MODE !== 'cli') {
    const sdk = await loadSdk();
    if (sdk) return runWithSdk(sdk, job, emit, signal, workdir);
    emit(RunEventType.SYSTEM, {
      note: '@anthropic-ai/claude-agent-sdk not found; falling back to `claude -p` CLI',
    });
  }
  return runWithCli(job, emit, signal, workdir);
}

async function loadSdk(): Promise<any | null> {
  try {
    // Non-literal specifier so the build doesn't require the package to be present.
    const moduleName = '@anthropic-ai/claude-agent-sdk';
    return await import(moduleName);
  } catch {
    return null;
  }
}

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function normalizeModelUsage(mu: unknown): Record<string, ModelUsage> | undefined {
  if (!mu || typeof mu !== 'object') return undefined;
  return mu as Record<string, ModelUsage>;
}

// ─────────────────────────────────── Agent SDK path ───────────────────────────────────

async function runWithSdk(
  sdk: any,
  job: ClaimedJob,
  emit: EmitFn,
  signal: AbortSignal,
  workdir: string,
): Promise<ExecResult> {
  const a = job.agent;
  const q = sdk.query({
    prompt: job.prompt,
    options: clean({
      model: a.model,
      cwd: workdir,
      appendSystemPrompt: a.appendSystemPrompt,
      systemPrompt: a.systemPrompt,
      allowedTools: a.allowedTools,
      disallowedTools: a.disallowedTools,
      permissionMode: a.permissionMode,
      maxTurns: a.maxTurns,
      maxBudgetUsd: a.maxBudgetUsd,
      mcpServers: a.mcpConfig,
      resume: job.resumeSessionId,
    }),
  });

  const onAbort = (): void => {
    try {
      q.interrupt?.();
    } catch {
      /* ignore */
    }
  };
  signal.addEventListener('abort', onAbort);

  try {
    for await (const msg of q) {
      handleMessage(msg, emit);
      if (msg.type === 'result') return resultFrom(msg, signal);
    }
    return { status: signal.aborted ? RunStatus.CANCELLED : RunStatus.SUCCEEDED };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// ───────────────────────────────────── CLI path ───────────────────────────────────────

function runWithCli(
  job: ClaimedJob,
  emit: EmitFn,
  signal: AbortSignal,
  workdir: string,
): Promise<ExecResult> {
  const a = job.agent;
  const args = [
    '-p',
    job.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    a.model,
    '--permission-mode',
    a.permissionMode,
  ];
  if (a.allowedTools.length) args.push('--allowedTools', a.allowedTools.join(','));
  if (a.disallowedTools.length) args.push('--disallowedTools', a.disallowedTools.join(','));
  if (a.maxTurns) args.push('--max-turns', String(a.maxTurns));
  if (a.maxBudgetUsd) args.push('--max-budget-usd', String(a.maxBudgetUsd));
  if (job.resumeSessionId) args.push('--resume', job.resumeSessionId);
  if (a.mcpConfig) {
    const mcpPath = join(workdir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: a.mcpConfig }));
    args.push('--mcp-config', mcpPath);
  }

  return new Promise<ExecResult>((resolve) => {
    const child = spawn('claude', args, { cwd: workdir, env: process.env });
    let final: ExecResult = { status: RunStatus.FAILED, error: 'claude produced no result' };
    let buf = '';

    const onAbort = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    signal.addEventListener('abort', onAbort);

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handleMessage(msg, emit);
        if (msg.type === 'result') final = resultFrom(msg, signal);
      }
    });
    child.stderr.on('data', (c: Buffer) => emit(RunEventType.SYSTEM, { stderr: c.toString() }));
    child.on('error', (err) => {
      final = { status: RunStatus.FAILED, error: `failed to spawn claude: ${err.message}` };
    });
    child.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      resolve(signal.aborted ? { ...final, status: RunStatus.CANCELLED } : final);
    });
  });
}

// ─────────────────────────────── shared message handling ──────────────────────────────

function handleMessage(msg: any, emit: EmitFn): void {
  switch (msg.type) {
    case 'system':
      emit(RunEventType.SYSTEM, {
        subtype: msg.subtype,
        model: msg.model,
        sessionId: msg.session_id,
      });
      break;
    case 'assistant':
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text') emit(RunEventType.ASSISTANT, { text: block.text });
        else if (block.type === 'tool_use')
          emit(RunEventType.TOOL_USE, { name: block.name, input: block.input });
        else if (block.type === 'tool_result')
          emit(RunEventType.TOOL_RESULT, { content: block.content, isError: block.is_error });
      }
      break;
    case 'stream_event':
      if (msg.event?.delta?.type === 'text_delta')
        emit(RunEventType.TEXT_DELTA, { text: msg.event.delta.text });
      break;
    default:
      break;
  }
}

function resultFrom(msg: any, signal: AbortSignal): ExecResult {
  const isError =
    msg.is_error || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'));
  return {
    status: signal.aborted
      ? RunStatus.CANCELLED
      : isError
        ? RunStatus.FAILED
        : RunStatus.SUCCEEDED,
    result: msg.result,
    subtype: msg.subtype,
    claudeSessionId: msg.session_id,
    numTurns: msg.num_turns,
    durationMs: msg.duration_ms,
    costUsd: msg.total_cost_usd,
    usage: msg.usage,
    modelUsage: normalizeModelUsage(msg.modelUsage),
  };
}
