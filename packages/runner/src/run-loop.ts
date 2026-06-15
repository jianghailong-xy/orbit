import { mkdirSync } from 'fs';
import { join } from 'path';
import {
  ClaimedJob,
  NormalizedRunEvent,
  RunEventType,
  RunStatus,
  RunnerStatus,
} from '@orbit/shared';
import { executeJob, ExecResult } from './claude-adapter';
import { RunnerConfig, runsDir } from './config';
import { Transport } from './transport';

const VERSION = '0.1.0';
const HEARTBEAT_MS = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runLoop(cfg: RunnerConfig): Promise<void> {
  const transport = new Transport(cfg.serverUrl, cfg.runnerToken);
  const active = new Set<string>();
  const controllers = new Map<string, AbortController>();
  let stopping = false;

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const res = await transport.heartbeat({
          status: RunnerStatus.ONLINE,
          idleCapacity: Math.max(0, cfg.maxConcurrent - active.size),
          version: VERSION,
        });
        for (const runId of res?.cancelRunIds ?? []) {
          controllers.get(runId)?.abort();
        }
      } catch (err) {
        log('heartbeat failed:', errMsg(err));
      }
    })();
  }, HEARTBEAT_MS);

  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`runner "${cfg.name}" online → ${cfg.serverUrl} (max ${cfg.maxConcurrent} concurrent)`);

  while (!stopping) {
    if (active.size >= cfg.maxConcurrent) {
      await sleep(500);
      continue;
    }
    let job: ClaimedJob | null = null;
    try {
      job = await transport.claimJob();
    } catch (err) {
      log('claim failed:', errMsg(err));
      await sleep(2000);
      continue;
    }
    if (!job || !job.runId) continue;

    active.add(job.runId);
    void executeAndReport(transport, job, active, controllers);
  }

  clearInterval(heartbeat);
  log('runner stopping; waiting for active jobs…');
  while (active.size > 0) await sleep(200);
}

async function executeAndReport(
  transport: Transport,
  job: ClaimedJob,
  active: Set<string>,
  controllers: Map<string, AbortController>,
): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(job.runId, ctrl);

  let seq = 0;
  const buffer: NormalizedRunEvent[] = [];
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const events = buffer.splice(0, buffer.length);
    try {
      await transport.postEvents(job.runId, { events });
    } catch (err) {
      log(`event flush failed for ${job.runId}:`, errMsg(err));
    }
  };
  const emit = (type: RunEventType, payload: Record<string, unknown>): void => {
    buffer.push({ seq: seq++, type, ts: new Date().toISOString(), payload });
    if (buffer.length >= 25) void flush();
  };
  const flushTimer = setInterval(() => void flush(), 1000);

  log(`▶ run ${job.runId} — ${job.title}`);
  let result: ExecResult;
  try {
    const workdir = join(runsDir(), job.runId);
    mkdirSync(workdir, { recursive: true });
    result = await executeJob(job, emit, ctrl.signal, workdir);
  } catch (err) {
    result = { status: RunStatus.FAILED, error: errMsg(err) };
    emit(RunEventType.ERROR, { message: result.error });
  } finally {
    clearInterval(flushTimer);
    await flush();
    controllers.delete(job.runId);
    active.delete(job.runId);
  }

  try {
    await transport.complete(job.runId, {
      status: result.status,
      result: result.result,
      subtype: result.subtype,
      error: result.error,
      claudeSessionId: result.claudeSessionId,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      usage: result.usage,
      modelUsage: result.modelUsage,
    });
    log(`■ run ${job.runId} → ${result.status} ($${(result.costUsd ?? 0).toFixed(4)})`);
  } catch (err) {
    log(`complete failed for ${job.runId}:`, errMsg(err));
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[orbit-runner ${new Date().toISOString()}]`, ...args);
}
