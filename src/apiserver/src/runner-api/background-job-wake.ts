import { ConversationTurn, Prisma } from '@prisma/client';
import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  SessionLifecycleState,
  SessionRunState,
} from '@orbit/shared';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { stripNul } from './strip-nul';

/**
 * Waking a session for one of its runner-hosted background jobs.
 *
 * A job the agent started with `bg_run` can ask to wake its session when it exits, or when it has
 * written something new (runner-go background_job.go). The engine that asked may be long gone by
 * then — that is why the wait is the runner's and not the engine's — so the runner reports the wake
 * here, and the control plane files it as a turn of the session: queued, claimed and delivered like
 * any other, into the engine that is resident or into one resumed for it.
 *
 * The turn carries no words of anybody's. Its content stays empty and the wakes are kept beside it
 * (`background_job_wake`), written into what the runner is handed only at delivery. So everything a
 * wake says is recorded as the control plane's note on the runner's echo (control-plane-note.ts),
 * exactly as the `<background-jobs>` block is, and none of it previews or re-sends as the person's
 * message.
 *
 * Wakes nobody has been handed yet are one turn: a wake that arrives while a wake turn is still
 * queued files itself onto that turn, and a job's later wake replaces its earlier one there.
 */

/** The `client_turn_id` prefix of a turn filed to deliver background job wakes. */
export const BACKGROUND_WAKE_TURN_PREFIX = 'bg-wake:';

export function isBackgroundWakeTurn(clientTurnId: string | null | undefined): boolean {
  return typeof clientTurnId === 'string' && clientTurnId.startsWith(BACKGROUND_WAKE_TURN_PREFIX);
}

/** One wake, as the runner reports it (runner-go `bgWake`). */
export class BackgroundWakeDto {
  /** `<jobId>:exit`, or `<jobId>:output:<n>`: what a retry of this wake is recognised by. */
  @IsString()
  @MaxLength(200)
  @Matches(/^[\w:.-]+$/)
  wakeId!: string;

  @IsString()
  @MaxLength(100)
  jobId!: string;

  @IsIn(['exit', 'output'])
  trigger!: string;

  @IsString()
  @MaxLength(40)
  kind!: string;

  @IsString()
  @MaxLength(20_000)
  command!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @IsIn(['running', 'completed', 'failed', 'killed'])
  status!: string;

  @IsOptional()
  @IsInt()
  exitCode?: number;

  /** Why a killed job was killed: `runner_shutdown`, `session_cancelled`, ... */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;

  @IsString()
  @MaxLength(4_096)
  outputPath!: string;

  /** Where the output this wake is about begins: where the job's previous wake ended. */
  @IsInt()
  @Min(0)
  outputOffset!: number;

  /** How long the output file was when the wake was sent. */
  @IsInt()
  @Min(0)
  outputSize!: number;

  /** The end of the output, as much as the runner quotes (2000 bytes). */
  @IsString()
  @MaxLength(8_000)
  outputExcerpt!: string;
}

/**
 * What the control plane did with a wake: filed it as a new turn (ENQUEUED), onto a wake turn nobody
 * has been handed yet (MERGED), or nowhere, because the session has ended (DROPPED).
 */
export interface BackgroundWakeReceipt {
  outcome: 'ENQUEUED' | 'MERGED' | 'DROPPED';
  turnId?: string;
}

/**
 * Whether a session has ended in any of the ways a turn filed now would undo. `createTurn` refuses
 * the Trash, the terminal statuses and a requested cancel on its own; it does not refuse a session
 * completed while parked, nor an interrupted one whose end was recorded — and a wake must not
 * bring either back.
 */
export function sessionHasEnded(session: {
  status: string;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
}): boolean {
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return true;
  const run = deriveSessionRunState(session);
  return run === SessionRunState.ENDED || run === SessionRunState.SUCCEEDED || run === SessionRunState.FAILED;
}

/**
 * The session's wake turn nobody has been handed yet, if there is one.
 *
 * Read under the Session lock `createTurn` holds. Every door that hands a turn out or takes a queued
 * one away — the inbox claim, completion's drain, interrupt, withdraw, end — takes that same lock
 * first, so the turn found here is still queued when the wake is filed onto it.
 */
export function undeliveredWakeTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<ConversationTurn | null> {
  return tx.conversationTurn.findFirst({
    where: {
      sessionId,
      kind: 'message',
      status: 'PENDING',
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    orderBy: { seq: 'asc' },
  });
}

/**
 * File one wake onto the wake turn that will deliver it. A job's later wake replaces its earlier one:
 * it says how the job stands now, while what the session has not been told about still begins where
 * the earlier wake's output did. Except that nothing replaces how a job ended: the runner sends an
 * output wake and the exit wake from separate requests, and the one found as the process exited can
 * arrive second, saying `running` about a job that is gone.
 */
export async function fileBackgroundJobWake(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  wake: BackgroundWakeDto,
): Promise<void> {
  const facts = {
    trigger: wake.trigger,
    kind: stripNul(wake.kind),
    command: stripNul(wake.command),
    description: wake.description ? stripNul(wake.description) : null,
    status: wake.status,
    exitCode: wake.exitCode ?? null,
    reason: wake.reason ? stripNul(wake.reason) : null,
    outputPath: stripNul(wake.outputPath),
    outputSize: BigInt(wake.outputSize),
    outputExcerpt: stripNul(wake.outputExcerpt),
  };
  const offset = BigInt(wake.outputOffset);
  const earlier = await tx.backgroundJobWake.findUnique({
    where: { sessionId_clientTurnId_jobId: { sessionId, clientTurnId, jobId: wake.jobId } },
    select: { id: true, trigger: true, outputOffset: true },
  });
  if (earlier?.trigger === 'exit' && wake.trigger === 'output') return;
  if (earlier) {
    await tx.backgroundJobWake.update({
      where: { id: earlier.id },
      data: { ...facts, outputOffset: earlier.outputOffset < offset ? earlier.outputOffset : offset },
    });
    return;
  }
  await tx.backgroundJobWake.create({
    data: { sessionId, clientTurnId, jobId: stripNul(wake.jobId), outputOffset: offset, ...facts },
  });
}

type StoredWake = {
  jobId: string;
  trigger: string;
  kind: string;
  command: string;
  description: string | null;
  status: string;
  exitCode: number | null;
  reason: string | null;
  outputPath: string;
  outputOffset: bigint;
  outputSize: bigint;
  outputExcerpt: string;
  createdAt: Date;
};

/** What the kill reasons a runner reports mean for somebody deciding whether to wait again. */
const KILLED_BECAUSE: Record<string, string> = {
  runner_shutdown: 'the runner process hosting it stopped — a restart or a self-update — and the job was killed with it',
  session_cancelled: 'the session was cancelled, or handed to another runner process, and the job was killed with it',
};

function describeTrigger(wake: StoredWake): string {
  if (wake.trigger === 'output') return `new output｜${wake.status}`;
  if (wake.status === 'killed') {
    const gloss = wake.reason && KILLED_BECAUSE[wake.reason] ? ` (${KILLED_BECAUSE[wake.reason]})` : '';
    return wake.reason ? `ended｜killed｜reason ${wake.reason}${gloss}` : 'ended｜killed';
  }
  return wake.exitCode == null ? `ended｜${wake.status}` : `ended｜${wake.status}｜exit code ${wake.exitCode}`;
}

/** The block a wake turn delivers. */
export function buildBackgroundWakeBlock(wakes: StoredWake[]): string {
  const lines = ['<background-job-wake>', '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:'];
  for (const wake of wakes) {
    const head = [wake.jobId, wake.kind, wake.command];
    if (wake.description) head.push(wake.description);
    lines.push(`    ${head.join('｜')}`);
    lines.push(`      ${describeTrigger(wake)}`);
    lines.push(`      output ${wake.outputPath}｜this covers bytes ${wake.outputOffset}–${wake.outputSize}`);
    const excerpt = wake.outputExcerpt.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!excerpt) {
      lines.push('      (no output)');
      continue;
    }
    lines.push('      output tail:');
    for (const line of excerpt.split('\n')) lines.push(`        ${line}`);
  }
  lines.push('  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.');
  if (wakes.some((wake) => wake.status === 'killed')) {
    lines.push('  A killed job does not come back on its own: to keep waiting, start it again with bg_run.');
  }
  lines.push('</background-job-wake>');
  return lines.join('\n');
}

/**
 * Write a wake turn's wakes into the content being delivered.
 *
 * The turn's own content is empty, so what is delivered is the block alone — or, for a turn handed
 * out again after its runner died, the continuation nudge followed by the block. Throws on a database
 * failure: unlike a note riding along on somebody's message, this block IS the turn, and a turn
 * delivered without it would wake the agent for nothing. The claim rolls back and the turn stays
 * queued for the next poll.
 */
export async function appendBackgroundWakeContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const wakes = await tx.backgroundJobWake.findMany({ where: { sessionId, clientTurnId } });
  if (wakes.length === 0) return content;
  // In the order the wakes first arrived, ordered here rather than trusted from the read.
  wakes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.jobId.localeCompare(b.jobId));
  const block = buildBackgroundWakeBlock(wakes);
  return content ? `${content}\n\n${block}` : block;
}
