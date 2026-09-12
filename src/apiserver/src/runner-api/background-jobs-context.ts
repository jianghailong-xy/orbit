import { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

/**
 * What a returning engine is told about the background work it left behind.
 *
 * A runner-hosted background job (see runner-go/background_job.go) survives the engine that asked
 * for it: that is the entire point of stage 2. The consequence is that the engine which comes back
 * — a fresh process resuming a restored conversation — has no record of the job at all. The
 * transcript stops before the job finished, so `claude --resume` restores a conversation in which
 * the build is still running, or was never mentioned again.
 *
 * The runner's own `background_task` events are the durable record, and this turns them back into
 * the three facts an agent needs to pick the work up instead of starting it over: what is still
 * running, what ended while nobody was here, and where each one's output is.
 *
 * Said once per engine, not once per turn — see `isFirstDeliveryOfGeneration`.
 */

/** How many `background_task` rows one delivery will look at. A job writes two of them. */
const EVENT_SCAN_LIMIT = 400;

/** Only these end a job's life; everything else is a state it is passing through. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

type BackgroundEventRow = { seq: number; payload: unknown; createdAt: Date };

/** One job, folded from every event that named it. */
interface BackgroundJob {
  id: string;
  kind: string;
  command: string;
  outputPath: string;
  status: string;
  exitCode?: number;
  reason?: string;
  endedAt?: Date;
}

/**
 * Whether this delivery is the first one this engine process has taken.
 *
 * The inbox lease generation IS the engine process: activation and takeover mint a new one, and a
 * turn records the generation it was handed out under. So "no earlier turn carries this
 * generation" is exactly "this engine has not been told yet", with no new column to keep in step.
 *
 * A legacy poller carries no generation and cannot prove a process boundary, so it is left alone
 * rather than given the block on every single turn — the same correctness-first choice the
 * coordinator block makes.
 */
async function isFirstDeliveryOfGeneration(
  tx: Prisma.TransactionClient,
  sessionId: string,
  turnId: string,
  leaseGeneration: string,
): Promise<boolean> {
  const earlier = await tx.conversationTurn.count({
    where: {
      sessionId,
      leaseGeneration,
      id: { not: turnId },
      deliveredAt: { not: null },
    },
  });
  return earlier === 0;
}

/**
 * When the agent last had the floor. Jobs that ended before that were already visible to it, so
 * re-announcing them turns a report about what changed into a standing inventory.
 */
async function previousDeliveryAt(
  tx: Prisma.TransactionClient,
  sessionId: string,
  turnId: string,
): Promise<Date | null> {
  const previous = await tx.conversationTurn.findFirst({
    where: { sessionId, id: { not: turnId }, deliveredAt: { not: null } },
    orderBy: { deliveredAt: 'desc' },
    select: { deliveredAt: true },
  });
  return previous?.deliveredAt ?? null;
}

/**
 * Fold the event log into one record per job.
 *
 * `kind` is the discriminator: only a runner-hosted job carries one. An engine-owned
 * Bash(run_in_background) shell — parsed out of Claude's own <task-notification> — died with the
 * engine that spawned it, so offering it as work to pick back up would send the agent to read an
 * output file nothing is still writing.
 */
function foldJobs(rows: BackgroundEventRow[]): Map<string, BackgroundJob> {
  const jobs = new Map<string, BackgroundJob>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    if (!kind) continue;
    const id = String(payload.toolUseId ?? payload.shellId ?? '');
    if (!id) continue;
    const status = String(payload.status ?? '');
    const job = jobs.get(id) ?? { id, kind, command: '', outputPath: '', status };
    job.kind = kind;
    job.status = status || job.status;
    if (typeof payload.command === 'string' && payload.command) job.command = payload.command;
    if (typeof payload.outputPath === 'string' && payload.outputPath) {
      job.outputPath = payload.outputPath;
    }
    if (typeof payload.exitCode === 'number') job.exitCode = payload.exitCode;
    if (typeof payload.reason === 'string' && payload.reason) job.reason = payload.reason;
    if (TERMINAL_STATUSES.has(status)) job.endedAt = row.createdAt;
    jobs.set(id, job);
  }
  return jobs;
}

function describe(job: BackgroundJob): string {
  const parts = [job.id, job.kind];
  if (job.command) parts.push(job.command);
  return parts.join('｜');
}

function outputOf(job: BackgroundJob): string {
  return job.outputPath ? `｜输出 ${job.outputPath}` : '';
}

/** A Claude Monitor the runner reported stopped along with the engine that was running it. */
interface StoppedMonitor {
  taskId: string;
  toolUseId: string;
  timeoutMs?: number;
  persistent: boolean;
  endedAt: Date;
}

/**
 * The Monitors that stopped with an engine.
 *
 * A Monitor is not a job, and nothing about it can be picked back up: it ran inside the engine, so
 * the engine's stop ended it, and Claude writes nothing for a Monitor that did not end on its own.
 * What the replacement engine needs to know is that the wait it arranged is gone. The runner marks
 * that `killed` event with `tool: 'Monitor'` (runner-go killEngineShells); a Monitor that ended on
 * its own is never reported killed, and its own notifications carry no `tool`.
 */
function foldStoppedMonitors(rows: BackgroundEventRow[]): StoppedMonitor[] {
  const monitors = new Map<string, StoppedMonitor>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (payload.tool !== 'Monitor' || payload.status !== 'killed') continue;
    const toolUseId = String(payload.toolUseId ?? '');
    if (!toolUseId) continue;
    monitors.set(toolUseId, {
      taskId: String(payload.shellId ?? ''),
      toolUseId,
      ...(typeof payload.timeoutMs === 'number' ? { timeoutMs: payload.timeoutMs } : {}),
      persistent: payload.persistent === true,
      endedAt: row.createdAt,
    });
  }
  return [...monitors.values()];
}

function describeMonitor(monitor: StoppedMonitor): string {
  const parts = [monitor.taskId, 'Monitor', `tool_use ${monitor.toolUseId}`];
  if (monitor.persistent) parts.push('persistent');
  else if (monitor.timeoutMs !== undefined) parts.push(`timeout ${monitor.timeoutMs}ms`);
  return parts.join('｜');
}

/** The block itself, or null when there is nothing worth a line. */
function buildBackgroundJobsBlock(
  live: BackgroundJob[],
  ended: BackgroundJob[],
  stoppedMonitors: StoppedMonitor[],
): string | null {
  if (live.length === 0 && ended.length === 0 && stoppedMonitors.length === 0) return null;
  const lines: string[] = ['<background-jobs>'];
  if (live.length > 0) {
    lines.push('  仍在运行（runner 托管，不随 engine 重启而死）：');
    for (const job of live) lines.push(`    ${describe(job)}${outputOf(job)}`);
  }
  if (ended.length > 0) {
    lines.push('  你不在的时候结束了：');
    for (const job of ended) {
      // The exit code is the runner's own Wait, not a number parsed out of prose — so a job that
      // ended is reported as it actually ended, including the kill it did not ask for.
      const outcome = job.exitCode === undefined
        ? job.status
        : `${job.status}｜退出码 ${job.exitCode}`;
      const why = job.reason ? `｜原因 ${job.reason}` : '';
      lines.push(`    ${describe(job)}｜${outcome}${why}${outputOf(job)}`);
    }
  }
  if (stoppedMonitors.length > 0) {
    lines.push('  随上一个 engine 一起停掉的 Monitor（它跑在 engine 进程里，不会再通知你）：');
    for (const monitor of stoppedMonitors) lines.push(`    ${describeMonitor(monitor)}`);
    lines.push('  还要等的事，请重新安排等待。');
  }
  if (live.length > 0 || ended.length > 0) {
    lines.push('  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。');
    lines.push('  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。');
  } else {
    lines.push('  这是控制面替你记下的，不是用户说的。');
  }
  lines.push('</background-jobs>');
  return lines.join('\n');
}

/**
 * Append this session's background-job state to the content being delivered, or return it
 * unchanged.
 *
 * Throws on a database failure; the caller decides whether a note for the agent is worth costing
 * the turn it was going to ride along with (it is not — see the call site in dequeueTurn).
 */
export async function appendBackgroundJobsContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  turnId: string,
  leaseGeneration: string | null,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  if (!leaseGeneration) return content;
  if (!(await isFirstDeliveryOfGeneration(tx, sessionId, turnId, leaseGeneration))) return content;

  const rows = await tx.runEvent.findMany({
    where: { sessionId, type: RunEventType.BACKGROUND_TASK },
    orderBy: { seq: 'desc' },
    take: EVENT_SCAN_LIMIT,
    select: { seq: true, payload: true, createdAt: true },
  });
  // Read newest-first so the cap keeps the recent end of a long session, then fold oldest-first so
  // a job's terminal event wins over its launch. Ordered here rather than trusted from the read:
  // "the last row wins" is the whole meaning of the fold, and it must not depend on the shape a
  // driver happens to hand back.
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const jobs = foldJobs(ordered);
  const monitors = foldStoppedMonitors(ordered);
  if (jobs.size === 0 && monitors.length === 0) return content;

  const since = await previousDeliveryAt(tx, sessionId, turnId);
  const live: BackgroundJob[] = [];
  const ended: BackgroundJob[] = [];
  for (const job of jobs.values()) {
    if (!TERMINAL_STATUSES.has(job.status)) {
      live.push(job);
    } else if (!since || !job.endedAt || job.endedAt > since) {
      ended.push(job);
    }
  }
  // Any delivery after an engine stopped went to the engine that replaced it, and was told then.
  const stoppedMonitors = monitors.filter((monitor) => !since || monitor.endedAt > since);
  const block = buildBackgroundJobsBlock(live, ended, stoppedMonitors);
  if (!block) return content;
  return `${content ?? ''}\n\n${block}`;
}
