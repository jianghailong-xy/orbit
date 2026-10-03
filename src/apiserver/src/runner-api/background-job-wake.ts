import { BackgroundJobWake, ConversationTurn, Prisma } from '@prisma/client';
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
 *
 * A job's exit that arrives while the session is running a turn goes into that turn instead, as a
 * CURRENT_WORK steer aimed at it, whenever the runtime and the runner can steer one (createTurn's
 * `steerIfLive`): the agent learns the job ended at its next tool call rather than after the turn it
 * is in, and no turn of its own is opened for it. Waiting behind the running turn, a wake used to sit
 * for minutes and then open a whole turn to report a job the agent had often read for itself by then.
 * Output wakes never steer — a job writing every minute would interrupt the turn every minute — so
 * they queue for the next turn as they always have. The two routes never join each other's turn: a
 * steer joins a steer still waiting for the same running turn, a next-turn wake the queued next-turn
 * wake. A steer that misses its turn comes back as an ordinary wake turn, and takes the queued one
 * with it (`foldQueuedWakeTurnsInto`).
 *
 * One job's own wakes are the exception. Its exit is the last thing it will say, and it covers its
 * output from where the earliest unread wake began, so a steered exit takes that job's output wake
 * off the next-turn queue (`takeJobOffNextTurnQueue`), and an output wake arriving after the exit was
 * filed is dropped (`StaleBackgroundWake`). Either one left alone would open a turn after the exit
 * was read, to report output the exit had already reported.
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
 * has been handed yet (MERGED), or nowhere (DROPPED) — because the session has ended, or because it
 * reports output its job's exit, already filed, reports too.
 */
export interface BackgroundWakeReceipt {
  outcome: 'ENQUEUED' | 'MERGED' | 'DROPPED';
  turnId?: string;
}

/**
 * An output wake that arrived after its job's exit was filed. The runner sends the two from separate
 * requests, and the output found as the process exited can arrive second; by then the exit has said
 * how the job ended and where its output is, whether it is still queued, written into a running turn
 * or long since read. Filed anyway, it would open a turn of its own to say less than the exit did.
 * Thrown from the coalesce hook, so nothing of it is written; answered DROPPED, which the runner does
 * not retry.
 */
export class StaleBackgroundWake extends Error {
  constructor(jobId: string) {
    super(`background job ${jobId} already reported its exit; its later output wake has nothing to add`);
    this.name = 'StaleBackgroundWake';
  }
}

/** Whether this session has a job's exit on file, on any wake turn, delivered or not. */
export async function jobExitFiled(
  tx: Prisma.TransactionClient,
  sessionId: string,
  jobId: string,
): Promise<boolean> {
  const exit = await tx.backgroundJobWake.findFirst({
    where: { sessionId, jobId, trigger: 'exit' },
    select: { id: true },
  });
  return exit !== null;
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
 * The session's wake turn nobody has been handed yet on this route, if there is one: a queued
 * next-turn wake, or — for a wake going into the running turn — a steer still waiting for that same
 * turn. Never the other route's: a steer joining a queued wake would wait for the next turn after
 * all, and a next-turn wake joining a steer would be written into a turn it was not decided for.
 * A steer the runner has taken, or the engine has acknowledged, is no longer PENDING, so a later wake
 * is a steer of its own.
 *
 * Read under the Session lock `createTurn` holds. Every door that hands a turn out or takes a queued
 * one away — the inbox claim, completion's drain, interrupt, withdraw, end — takes that same lock
 * first, so the turn found here is still queued when the wake is filed onto it.
 */
export function undeliveredWakeTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
  route: { kind: string; targetTurnId?: string } = { kind: 'message' },
): Promise<ConversationTurn | null> {
  return tx.conversationTurn.findFirst({
    where: {
      sessionId,
      ...(route.kind === 'steer'
        ? { kind: 'steer', sendIntent: 'CURRENT_WORK', targetTurnId: route.targetTurnId }
        : { kind: 'message' }),
      status: 'PENDING',
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Fold every other queued next-turn wake into the wake turn a missed steer just became.
 *
 * A steer wake whose turn ended before the engine read it is put back in the queue as an ordinary
 * next-turn message, on the same row (`requeueUnreadCurrentWorkSteers` at turn-complete, or the
 * runner's `steer_requeue`). A wake that arrived meanwhile for the next turn — a job's output, a
 * wakeup coming due, an exit no live turn could take — is queued as a turn of its own, so without
 * this the two would each open a turn, back to back, to say what one turn says.
 *
 * The requeued row is the one kept: it may already have a `user` event in the transcript, and its
 * re-delivery amends that line where a client drew it. A queued turn nobody was handed goes the way a
 * withdrawn one does — its wakes and its due wakeups move onto the kept turn first. A job both turns
 * carry keeps the wake that says how it ended, as `fileBackgroundJobWake` would have; output read
 * from the earlier of the two offsets still has to be read. A queued wake turn that is already in the
 * transcript (handed out once, and back unanswered) is left as it is: deleting it would strand the
 * line drawn for it.
 *
 * Under the Session lock its caller holds, in the transaction that requeued the steer.
 */
export async function foldQueuedWakeTurnsInto(
  tx: Prisma.TransactionClient,
  sessionId: string,
  kept: { id: string; clientTurnId: string },
): Promise<number> {
  if (!isBackgroundWakeTurn(kept.clientTurnId)) return 0;
  const others = await unannouncedQueuedWakeTurns(tx, sessionId, kept.id);
  for (const other of others) {
    const wakes = await tx.backgroundJobWake.findMany({
      where: { sessionId, clientTurnId: other.clientTurnId },
    });
    for (const wake of wakes) await moveJobWake(tx, sessionId, wake, kept.clientTurnId);
    await tx.sessionScheduledWakeup.updateMany({
      where: { sessionId, clientTurnId: other.clientTurnId, state: 'DELIVERED' },
      data: { clientTurnId: kept.clientTurnId },
    });
    await tx.conversationTurn.deleteMany({ where: { id: other.id, sessionId, status: 'PENDING' } });
  }
  return others.length;
}

/**
 * Take one job's wake off the next-turn queue, now that its exit has been written into the running
 * turn as a steer (`steerClientTurnId`).
 *
 * The job's output wakes waited for the next turn; its exit, arriving while a turn ran, was steered
 * into that turn. Left where it was, the output wake would open a turn after this one to report
 * output the exit already reports: the job is over, and once the output wake is merged into it the
 * exit covers its output from where that wake began. A queued turn left carrying nothing goes the way
 * a withdrawn one does; one still carrying another job's wake, or a wakeup that came due, stays. A
 * steer that then misses its turn takes the wake back to the queue with it, so nothing here can make
 * the output go unreported.
 *
 * Only turns nobody has been handed: one already in the transcript keeps the line drawn for it, as in
 * `foldQueuedWakeTurnsInto`. Under the Session lock createTurn holds, in the transaction that files
 * the steer.
 */
export async function takeJobOffNextTurnQueue(
  tx: Prisma.TransactionClient,
  sessionId: string,
  steerClientTurnId: string,
  jobId: string,
): Promise<void> {
  for (const queued of await unannouncedQueuedWakeTurns(tx, sessionId)) {
    if (queued.clientTurnId === steerClientTurnId) continue;
    const wake = await tx.backgroundJobWake.findUnique({
      where: { sessionId_clientTurnId_jobId: { sessionId, clientTurnId: queued.clientTurnId, jobId } },
    });
    if (!wake) continue;
    await moveJobWake(tx, sessionId, wake, steerClientTurnId);
    const wakesLeft = await tx.backgroundJobWake.count({
      where: { sessionId, clientTurnId: queued.clientTurnId },
    });
    const wakeupsLeft = await tx.sessionScheduledWakeup.count({
      where: { sessionId, clientTurnId: queued.clientTurnId, state: 'DELIVERED' },
    });
    if (wakesLeft === 0 && wakeupsLeft === 0) {
      await tx.conversationTurn.deleteMany({ where: { id: queued.id, sessionId, status: 'PENDING' } });
    }
  }
}

/** The queued next-turn wake turns nobody has been handed yet — none of them has a `user` event. */
async function unannouncedQueuedWakeTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  exceptTurnId?: string,
): Promise<Array<{ id: string; clientTurnId: string }>> {
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      ...(exceptTurnId ? { id: { not: exceptTurnId } } : {}),
      kind: 'message',
      status: 'PENDING',
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    select: { id: true, clientTurnId: true },
    orderBy: { seq: 'asc' },
  });
  if (queued.length === 0) return [];
  const announced = await tx.runEvent.findMany({
    where: { sessionId, type: 'user', turnId: { in: queued.map((turn) => turn.id) } },
    select: { turnId: true },
  });
  const shown = new Set(announced.map((event) => event.turnId));
  return queued.filter((turn) => !shown.has(turn.id));
}

/**
 * Move one job's wake onto another wake turn. When the job already has a wake there, the two become
 * one, as `fileBackgroundJobWake` would have made them had both arrived on that turn: the wake that
 * says how the job ended wins over one that says it is running, and its output is read from the
 * earlier of the two offsets.
 */
async function moveJobWake(
  tx: Prisma.TransactionClient,
  sessionId: string,
  wake: BackgroundJobWake,
  toClientTurnId: string,
): Promise<void> {
  const there = await tx.backgroundJobWake.findUnique({
    where: { sessionId_clientTurnId_jobId: { sessionId, clientTurnId: toClientTurnId, jobId: wake.jobId } },
  });
  if (!there) {
    await tx.backgroundJobWake.update({ where: { id: wake.id }, data: { clientTurnId: toClientTurnId } });
    return;
  }
  const later = there.updatedAt >= wake.updatedAt ? there : wake;
  const says = there.trigger === 'exit' ? there : wake.trigger === 'exit' ? wake : later;
  await tx.backgroundJobWake.update({
    where: { id: there.id },
    data: {
      trigger: says.trigger,
      kind: says.kind,
      command: says.command,
      description: says.description,
      status: says.status,
      exitCode: says.exitCode,
      reason: says.reason,
      outputPath: says.outputPath,
      outputSize: says.outputSize,
      outputExcerpt: says.outputExcerpt,
      outputOffset: there.outputOffset < wake.outputOffset ? there.outputOffset : wake.outputOffset,
    },
  });
  await tx.backgroundJobWake.delete({ where: { id: wake.id } });
}

/**
 * `foldQueuedWakeTurnsInto` for the steers a turn's completion just requeued: the first of them that
 * is a wake turn keeps every other wake queued for the next turn, the other requeued ones included.
 */
export async function foldRequeuedWakeTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  requeuedTurnIds: readonly string[],
): Promise<void> {
  const requeued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      id: { in: [...requeuedTurnIds] },
      clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX },
    },
    select: { id: true, clientTurnId: true },
    orderBy: { seq: 'asc' },
  });
  const kept = requeued.find((turn) => isBackgroundWakeTurn(turn.clientTurnId));
  if (kept) await foldQueuedWakeTurnsInto(tx, sessionId, kept);
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

/**
 * What the block says brought it, by the kind of turn delivering it: a turn the control plane opened
 * for it, or — for a steer — the turn the agent is already in, which nobody opened for the wake.
 */
const WAKE_HEADS: Record<'message' | 'steer', string> = {
  message: '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  steer: '  A background job you started with bg_run has news you were waiting for. It ended while you were working, so this message was added to the turn you are in:',
};

/** The block a wake turn delivers. */
export function buildBackgroundWakeBlock(wakes: StoredWake[], turnKind: string = 'message'): string {
  const lines = ['<background-job-wake>', WAKE_HEADS[turnKind === 'steer' ? 'steer' : 'message']];
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
 * queued for the next poll. `turnKind` is the delivering turn's: a steer says it joined the turn the
 * agent is in rather than that one was opened for it.
 */
export async function appendBackgroundWakeContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
  turnKind: string = 'message',
): Promise<string | null | undefined> {
  const wakes = await tx.backgroundJobWake.findMany({ where: { sessionId, clientTurnId } });
  if (wakes.length === 0) return content;
  // In the order the wakes first arrived, ordered here rather than trusted from the read.
  wakes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.jobId.localeCompare(b.jobId));
  const block = buildBackgroundWakeBlock(wakes, turnKind);
  return content ? `${content}\n\n${block}` : block;
}
