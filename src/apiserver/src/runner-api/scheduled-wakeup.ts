import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { stripNul } from './strip-nul';

/**
 * A wakeup a session asks the control plane to hold.
 *
 * Claude Code's ScheduleWakeup keeps its timer inside the engine process, and Orbit recycles engines
 * (idle TTL, LRU) and restarts runners: the wakeup dies with the process, a resumed engine never re-arms
 * it, and it does not fire while the engine still has a Monitor or background shell running. The agent
 * asks here instead (runner-go `schedule_wakeup`), the row waits in `session_scheduled_wakeup`, and when
 * it is due the scheduled-wakeup worker files it as a turn of the session (scheduled-wakeup.worker.ts) —
 * onto the same `bg-wake:` turn a background job's wake uses, so it is queued, claimed and delivered the
 * way those are, into the engine that is resident or into one resumed for it.
 *
 * Like a job's wake, the turn carries nobody's words: its content stays empty, and what the wakeup says
 * is written into what the runner is handed at delivery (appendScheduledWakeupContext), where it is
 * recorded as the control plane's note.
 *
 * One one-shot wakeup waits per session, the way one ScheduleWakeup does: a later request replaces the
 * waiting one, and a stop cancels it.
 *
 * A LOOP (`recurring: true`, docs/long-running-loop-contract.md §1) is held the same way, so that a relay
 * of one-shot wakeups the agent renews every turn is no longer what keeps a days-long loop alive: the
 * loop is a `session_wakeup_loop` row, and each of its ticks is an ordinary wakeup row naming it, which
 * the worker files like any other and replaces with the next one in the same transaction. A session runs
 * at most one loop — a later recurring request replaces it — and a one-shot wakeup and a loop never
 * replace each other. A stop ends both.
 */

/** ScheduleWakeup's own bounds, so the door it is routed to answers the same request the same way. */
export const SCHEDULED_WAKEUP_MIN_DELAY_SECONDS = 60;
export const SCHEDULED_WAKEUP_MAX_DELAY_SECONDS = 3_600;
/** A loop's interval, and its first tick's delay, are clamped to [60, 86400] seconds. */
export const WAKEUP_LOOP_MIN_EVERY_SECONDS = 60;
export const WAKEUP_LOOP_MAX_EVERY_SECONDS = 86_400;
/** How long a loop runs when it names no `until`, and the furthest `until` it may name. */
export const WAKEUP_LOOP_DEFAULT_SPAN_MS = 7 * 24 * 60 * 60 * 1_000;
export const WAKEUP_LOOP_MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1_000;

/** Why a loop ended. Every end writes one of these, with when (`session_wakeup_loop.ended_at`). */
export type WakeupLoopEndReason = 'REQUESTED' | 'REPLACED' | 'OWNER_STOP' | 'SESSION_ENDED' | 'UNTIL_REACHED';

/** One request, as runner-go's `schedule_wakeup` sends it. */
export class ScheduledWakeupDto {
  /** Cancel the waiting wakeup and end the running loop instead of scheduling anything. */
  @IsOptional()
  @IsBoolean()
  stop?: boolean;

  /** Hold a loop — a tick every `everySeconds` until `until` — rather than one wakeup. */
  @IsOptional()
  @IsBoolean()
  recurring?: boolean;

  /** One wakeup: seconds from now, clamped to [60, 3600]. A loop: when its first tick is due, clamped to
   *  [60, 86400]; one interval when omitted. */
  @ValidateIf((dto: ScheduledWakeupDto) => dto.stop !== true && (dto.recurring !== true || dto.delaySeconds !== undefined))
  @IsNumber({ allowNaN: false, allowInfinity: false })
  delaySeconds?: number;

  /** A loop's interval, in seconds. Clamped to [60, 86400]. */
  @ValidateIf((dto: ScheduledWakeupDto) => dto.everySeconds !== undefined || (dto.stop !== true && dto.recurring === true))
  @IsNumber({ allowNaN: false, allowInfinity: false })
  everySeconds?: number;

  /** When a loop ends by itself, ISO 8601: seven days out when omitted, thirty days out at most. */
  @IsOptional()
  @IsISO8601()
  until?: string;

  /** What the session is waiting for: said back to it when it is woken. Required for one wakeup; a loop
   *  may leave it out. */
  @ValidateIf((dto: ScheduledWakeupDto) => dto.stop !== true && (dto.recurring !== true || dto.reason !== undefined))
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason?: string;

  /** What the woken turn is to do. Required for a loop: it is what every tick's turn does. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  prompt?: string;
}

/** What the control plane did: holds a wakeup (and when it is due), holds a loop (and when its first tick
 *  is due), or cancelled what was waiting. */
export type ScheduledWakeupReceipt =
  | { outcome: 'SCHEDULED'; id: string; dueAt: string; delaySeconds: number; clamped: boolean; replaced: boolean }
  | {
      outcome: 'SCHEDULED';
      recurring: true;
      /** The loop. */
      loopId: string;
      /** Its first tick, and when that is due. */
      id: string;
      dueAt: string;
      delaySeconds: number;
      everySeconds: number;
      until: string;
      /** Whether anything asked for was moved into bounds, and what was asked for where it was. */
      clamped: boolean;
      clampedFrom: { everySeconds?: number; delaySeconds?: number; until?: string };
      /** Whether a loop that was running ended (REPLACED) to make way for this one. */
      replaced: boolean;
    }
  /** `cancelled` counts one-shot wakeups, `loopsStopped` loops: a stop takes both. */
  | { outcome: 'CANCELLED'; cancelled: number; loopsStopped: number };

/**
 * Hold a wakeup or a loop for the session. A wakeup replaces the one-shot wakeup waiting, if any; a loop
 * replaces the running loop, if any; neither touches the other. Inside the runner door's retried
 * transaction (runnerApi.scheduledWakeup): what is replaced and what replaces it are written together, or
 * neither is.
 *
 * The session row is taken FOR KEY SHARE before anything else: the mode and the row the insert's foreign
 * key takes anyway, moved earlier (common/lock-order.ts, as I4 does). Taken at the insert, it came after
 * the waiting wakeup or the running loop this transaction had just locked, while createTurn and interrupt
 * hold the session FOR UPDATE and then reach for those same rows: a deadlock cycle.
 */
export async function scheduleWakeup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  dto: ScheduledWakeupDto,
): Promise<ScheduledWakeupReceipt> {
  await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR KEY SHARE`;
  if (dto.recurring === true) return scheduleWakeupLoop(tx, sessionId, dto);
  // A request that names a loop's fields without asking for a loop is not quietly taken as one wakeup.
  if (dto.everySeconds !== undefined || dto.until !== undefined) {
    throw new BadRequestException('everySeconds and until belong to a loop: send them with recurring: true');
  }
  const requested = Math.round(Number(dto.delaySeconds));
  const delaySeconds = Math.min(SCHEDULED_WAKEUP_MAX_DELAY_SECONDS, Math.max(SCHEDULED_WAKEUP_MIN_DELAY_SECONDS, requested));
  // Only the one-shot wakeup waiting: a loop's tick is the loop's, and a one-shot request leaves it alone.
  const superseded = await tx.sessionScheduledWakeup.updateMany({
    where: { sessionId, loopId: null, state: 'PENDING' },
    data: { state: 'SUPERSEDED', settledAt: new Date() },
  });
  const held = await tx.sessionScheduledWakeup.create({
    data: {
      sessionId,
      delaySeconds,
      reason: stripNul(dto.reason ?? ''),
      prompt: dto.prompt ? stripNul(dto.prompt) : null,
      dueAt: new Date(Date.now() + delaySeconds * 1_000),
    },
    select: { id: true, dueAt: true },
  });
  return {
    outcome: 'SCHEDULED',
    id: held.id,
    dueAt: held.dueAt.toISOString(),
    delaySeconds,
    clamped: delaySeconds !== requested,
    replaced: superseded.count > 0,
  };
}

/** Start a loop: end the running one (REPLACED), write the loop and its first tick. */
async function scheduleWakeupLoop(
  tx: Prisma.TransactionClient,
  sessionId: string,
  dto: ScheduledWakeupDto,
): Promise<ScheduledWakeupReceipt> {
  const prompt = stripNul(dto.prompt ?? '');
  if (prompt.trim() === '') {
    throw new BadRequestException("prompt is required with recurring: true: it is what every tick's turn is to do");
  }
  const now = new Date();
  const clampedFrom: { everySeconds?: number; delaySeconds?: number; until?: string } = {};
  const requestedEvery = Math.round(Number(dto.everySeconds));
  const everySeconds = clampLoopSeconds(requestedEvery);
  if (everySeconds !== requestedEvery) clampedFrom.everySeconds = requestedEvery;
  const requestedDelay = dto.delaySeconds === undefined ? everySeconds : Math.round(Number(dto.delaySeconds));
  const delaySeconds = clampLoopSeconds(requestedDelay);
  if (delaySeconds !== requestedDelay) clampedFrom.delaySeconds = requestedDelay;
  let until = dto.until === undefined ? new Date(now.getTime() + WAKEUP_LOOP_DEFAULT_SPAN_MS) : new Date(dto.until);
  if (Number.isNaN(until.getTime())) throw new BadRequestException('until is not a date');
  const latest = new Date(now.getTime() + WAKEUP_LOOP_MAX_SPAN_MS);
  if (until.getTime() > latest.getTime()) {
    clampedFrom.until = until.toISOString();
    until = latest;
  }
  const firstDueAt = new Date(now.getTime() + delaySeconds * 1_000);
  if (until.getTime() < firstDueAt.getTime()) {
    throw new BadRequestException(
      `until (${until.toISOString()}) is before the first tick (${firstDueAt.toISOString()}): name a later until or a shorter delaySeconds`,
    );
  }
  const replaced = await endWakeupLoop(tx, sessionId, 'REPLACED', now);
  const reason = dto.reason ? stripNul(dto.reason) : null;
  const loop = await tx.sessionWakeupLoop.create({
    data: { sessionId, everySeconds, prompt, reason, firstDueAt, untilAt: until },
    select: { id: true },
  });
  const tick = await tx.sessionScheduledWakeup.create({
    data: { sessionId, loopId: loop.id, delaySeconds, reason: reason ?? '', dueAt: firstDueAt },
    select: { id: true, dueAt: true },
  });
  return {
    outcome: 'SCHEDULED',
    recurring: true,
    loopId: loop.id,
    id: tick.id,
    dueAt: tick.dueAt.toISOString(),
    delaySeconds,
    everySeconds,
    until: until.toISOString(),
    clamped: Object.keys(clampedFrom).length > 0,
    clampedFrom,
    replaced: replaced > 0,
  };
}

function clampLoopSeconds(seconds: number): number {
  return Math.min(WAKEUP_LOOP_MAX_EVERY_SECONDS, Math.max(WAKEUP_LOOP_MIN_EVERY_SECONDS, seconds));
}

/**
 * Cancel the session's waiting one-shot wakeup and end its loop (REQUESTED), inside the runner door's
 * transaction. Nothing waiting is an answer, not an error, so a second stop answers zeros.
 */
export async function stopScheduledWakeups(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<ScheduledWakeupReceipt> {
  const now = new Date();
  const loopsStopped = await endWakeupLoop(tx, sessionId, 'REQUESTED', now);
  const { count } = await tx.sessionScheduledWakeup.updateMany({
    where: { sessionId, loopId: null, state: 'PENDING' },
    data: { state: 'CANCELLED', settledAt: now },
  });
  return { outcome: 'CANCELLED', cancelled: count, loopsStopped };
}

/**
 * End the session's running loop, if it has one, and cancel the tick it has waiting. How many loops it
 * ended: 0 or 1. The loop row first and its tick after it — the order every writer of a loop takes them
 * in (settleLoopTick too), so two of them meet on the loop row and never on the tick in the other order.
 * A tick of this loop already filed onto a queued turn stays there: it is delivered, and its block says
 * the loop has ended.
 */
export async function endWakeupLoop(
  tx: Prisma.TransactionClient,
  sessionId: string,
  reason: WakeupLoopEndReason,
  now: Date = new Date(),
): Promise<number> {
  const ended = await tx.sessionWakeupLoop.updateManyAndReturn({
    where: { sessionId, state: 'ACTIVE' },
    data: { state: 'ENDED', endedReason: reason, endedAt: now },
    select: { id: true },
  });
  if (ended.length === 0) return 0;
  await tx.sessionScheduledWakeup.updateMany({
    where: { loopId: { in: ended.map((loop) => loop.id) }, state: 'PENDING' },
    data: { state: 'CANCELLED', settledAt: now },
  });
  return ended.length;
}

/** The wakeup was no longer waiting when a delivery went to settle it: replaced, cancelled, or settled by another pass. */
export class ScheduledWakeupSettled extends Error {}

/**
 * Settle a due wakeup onto the wake turn that delivers it, inside that turn's transaction: either both
 * are written or neither is. A wakeup no longer waiting throws, which rolls the turn back with it.
 */
export async function markScheduledWakeupDelivered(
  tx: Prisma.TransactionClient,
  wakeupId: string,
  clientTurnId: string,
): Promise<void> {
  const { count } = await tx.sessionScheduledWakeup.updateMany({
    where: { id: wakeupId, state: 'PENDING' },
    data: { state: 'DELIVERED', clientTurnId, settledAt: new Date() },
  });
  if (count !== 1) throw new ScheduledWakeupSettled(`scheduled wakeup ${wakeupId} is no longer waiting`);
}

/** A due wakeup whose session had ended: it wakes nobody. False when something else settled it first. */
export async function dropScheduledWakeup(prisma: PrismaService, wakeupId: string): Promise<boolean> {
  const { count } = await prisma.sessionScheduledWakeup.updateMany({
    where: { id: wakeupId, state: 'PENDING' },
    data: { state: 'DROPPED', settledAt: new Date() },
  });
  return count === 1;
}

/**
 * When a loop's next tick is due, after the tick due at `dueAt` was settled at `now`, and how many due
 * times in between nobody was due: fixed rate, so the next tick is `dueAt + k × every` for the smallest k
 * that lands after now, and the k − 1 skipped due times are missed. The last tick is due at `until` — the
 * next tick's due time is never later — and after it there is none (`next: null`). An `until` that passed
 * while the worker was late leaves no tick to file: its due times up to `until` are all missed, and the
 * loop is over.
 */
export function nextLoopTick(
  dueAt: Date,
  everySeconds: number,
  until: Date,
  now: Date,
): { next: Date | null; skipped: number } {
  const due = dueAt.getTime();
  const end = until.getTime();
  const every = everySeconds * 1_000;
  if (due >= end) return { next: null, skipped: 0 };
  const k = Math.max(1, Math.floor((now.getTime() - due) / every) + 1);
  const slot = due + k * every;
  if (slot < end) return { next: new Date(slot), skipped: k - 1 };
  if (end > now.getTime()) return { next: new Date(end), skipped: k - 1 };
  return { next: null, skipped: Math.ceil((end - due) / every) };
}

/** A tick's number in its loop, 1 for the first: the due times since the first, counting the last one at `until`. */
export function loopTickNumber(loop: { firstDueAt: Date; everySeconds: number }, dueAt: Date): number {
  return Math.ceil((dueAt.getTime() - loop.firstDueAt.getTime()) / (loop.everySeconds * 1_000)) + 1;
}

/** How a tick's due time is settled, and what that says about the session it came due on. */
export interface LoopTickSettlement {
  tickId: string;
  loopId: string;
  sessionId: string;
  dueAt: Date;
  now: Date;
  /** Filed onto this wake turn: a new one, or a queued one it joined. `absorbed`: that queued turn already
   *  carries an earlier tick of this loop, so this one is not a run of its own but a missed one. Absent:
   *  the tick is DROPPED. */
  delivered?: { clientTurnId: string; absorbed: boolean };
  /** End the loop with this tick instead of writing the next one: the session it came due on has ended. */
  end?: 'SESSION_ENDED';
  /** `revive_streak`: the tick revived the session (increment), found it healthy (reset), or neither (keep) —
   *  a tick skipped for an armed retry, a revive that was refused, or one held at the limit. */
  streak: 'increment' | 'reset' | 'keep';
}

/** What settling a tick left: the next tick, or the reason the loop ended. */
export interface LoopTickResult {
  next: { id: string; dueAt: Date } | null;
  ended: WakeupLoopEndReason | null;
}

/**
 * Settle a loop's due tick — DELIVERED onto a wake turn, or DROPPED — and in the same transaction write
 * its next tick, or end the loop when this was the last one. So an ACTIVE loop always has exactly one
 * tick waiting, whatever happened to the one before it: a failed delivery is a missed tick, never the
 * end of the loop.
 *
 * It takes the session row FOR KEY SHARE first — the mode and the row the next tick's insert takes anyway,
 * moved earlier, and already held FOR UPDATE when it runs inside createTurn or the revive — then the loop
 * row, then the tick. So the worker's own drop never holds the loop while it waits for a session that
 * createTurn or interrupt holds FOR UPDATE on their way to that loop; and a stop or a replacement racing
 * this meets it on the loop row. A loop that ended, or a tick something else settled, throws
 * ScheduledWakeupSettled, which rolls back everything its caller wrote with it.
 */
export async function settleLoopTick(
  tx: Prisma.TransactionClient,
  settlement: LoopTickSettlement,
): Promise<LoopTickResult> {
  const { tickId, loopId, sessionId, dueAt, now } = settlement;
  await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR KEY SHARE`;
  const [loop] = await tx.$queryRaw<Array<{
    state: string; everySeconds: number; untilAt: Date; reason: string | null; reviveStreak: number;
  }>>`
    SELECT "state", "every_seconds" AS "everySeconds", "until_at" AS "untilAt", "reason",
           "revive_streak" AS "reviveStreak"
      FROM "session_wakeup_loop"
     WHERE "id" = ${loopId}::uuid AND "session_id" = ${sessionId}::uuid
     FOR UPDATE`;
  if (!loop || loop.state !== 'ACTIVE') throw new ScheduledWakeupSettled(`wakeup loop ${loopId} is no longer running`);
  const settled = await tx.sessionScheduledWakeup.updateMany({
    where: { id: tickId, loopId, state: 'PENDING' },
    data: settlement.delivered
      ? { state: 'DELIVERED', clientTurnId: settlement.delivered.clientTurnId, settledAt: now }
      : { state: 'DROPPED', settledAt: now },
  });
  if (settled.count !== 1) throw new ScheduledWakeupSettled(`tick ${tickId} of wakeup loop ${loopId} is no longer waiting`);

  let ended: WakeupLoopEndReason | null = settlement.end ?? null;
  let next: Date | null = null;
  let skipped = 0;
  if (!ended) {
    const plan = nextLoopTick(dueAt, loop.everySeconds, loop.untilAt, now);
    skipped = plan.skipped;
    if (plan.next) next = plan.next;
    else ended = 'UNTIL_REACHED';
  }
  const delivered = settlement.delivered;
  // A tick filed as a run of its own fired; one folded into a turn already carrying this loop's tick, or
  // dropped, is missed — unless the loop is ending with it because its session has.
  const fired = delivered && !delivered.absorbed ? 1 : 0;
  const missed = (delivered ? (delivered.absorbed ? 1 : 0) : settlement.end ? 0 : 1) + skipped;
  await tx.sessionWakeupLoop.update({
    where: { id: loopId },
    data: {
      ticksFired: { increment: fired },
      ticksMissed: { increment: missed },
      ...(settlement.streak === 'increment'
        ? { reviveStreak: loop.reviveStreak + 1 }
        : settlement.streak === 'reset' ? { reviveStreak: 0 } : {}),
      ...(ended ? { state: 'ENDED', endedReason: ended, endedAt: now } : {}),
    },
  });
  if (!next) return { next: null, ended };
  const written = await tx.sessionScheduledWakeup.create({
    data: {
      sessionId,
      loopId,
      delaySeconds: Math.max(0, Math.round((next.getTime() - now.getTime()) / 1_000)),
      reason: loop.reason ?? '',
      dueAt: next,
    },
    select: { id: true, dueAt: true },
  });
  return { next: written, ended: null };
}

/** Whether this wake turn already carries a tick of this loop: a tick joining it is then missed. */
export async function turnCarriesLoopTick(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  loopId: string,
): Promise<boolean> {
  const tick = await tx.sessionScheduledWakeup.findFirst({
    where: { sessionId, clientTurnId, loopId, state: 'DELIVERED' },
    select: { id: true },
  });
  return tick != null;
}

type DeliveredWakeup = {
  id: string;
  reason: string;
  prompt: string | null;
  delaySeconds: number;
  dueAt: Date;
  createdAt: Date;
};

/** The loop a delivered tick belongs to, as its block describes it. */
type TickLoop = {
  everySeconds: number;
  untilAt: Date;
  state: string;
  endedReason: string | null;
  prompt: string;
};

/** One entry of a `<scheduled-wakeup>` block: a one-shot wakeup, or a loop's ticks filed onto this turn,
 *  shown as one entry for the latest of them. */
export type ScheduledWakeupEntry =
  | { kind: 'once'; wakeup: DeliveredWakeup }
  | {
      kind: 'tick';
      /** The latest of the loop's ticks on this turn. */
      tick: DeliveredWakeup;
      loop: TickLoop;
      /** Its number in the loop, 1 for the first. */
      number: number;
      /** The loop's due times since its previous run that did not become a run of their own. */
      missedSinceLastRun: number;
      /** No later tick of the loop has been filed: when the loop has ended, this was its last. */
      latest: boolean;
    };

/**
 * The block a wake turn delivers for the wakeups and loop ticks filed onto it. Every entry keeps the line
 * shapes the clients read (timing, `reason:`, the prompt under its heading); a tick adds its `loop:` line
 * between the timing and the reason, which those readers pass over. A loop that was given no reason has
 * no `reason:` line.
 */
export function buildScheduledWakeupBlock(entries: ScheduledWakeupEntry[]): string {
  const once = entries.some((entry) => entry.kind === 'once');
  const ticks = entries.some((entry) => entry.kind === 'tick');
  const opening = !ticks
    ? 'The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:'
    : once
      ? 'What you asked for with schedule_wakeup is due; the control plane opened this turn for it:'
      : 'A tick of the loop you started with schedule_wakeup is due; the control plane opened this turn for it:';
  const lines = ['<scheduled-wakeup>', `  ${opening}`];
  for (const entry of entries) {
    const wakeup = entry.kind === 'once' ? entry.wakeup : entry.tick;
    lines.push(`    ${wakeup.createdAt.toISOString()} scheduled ${wakeup.delaySeconds} seconds out, due ${wakeup.dueAt.toISOString()}`);
    if (entry.kind === 'tick') lines.push(`    ${loopLine(entry)}`);
    if (wakeup.reason) lines.push(`    reason: ${wakeup.reason}`);
    const prompt = ((entry.kind === 'tick' ? entry.loop.prompt : wakeup.prompt) ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!prompt) continue;
    lines.push('    what you left for this turn:');
    for (const line of prompt.split('\n')) lines.push(`      ${line}`);
  }
  let closing = '  The control plane recorded this for you; the user did not say it.';
  if (once) closing += ' To wait again, call mcp__orbit__schedule_wakeup again.';
  if (entries.some((entry) => entry.kind === 'tick' && entry.loop.state === 'ACTIVE')) {
    closing += ' The loop goes on by itself, so do not schedule its next tick; to stop it, call mcp__orbit__schedule_wakeup with stop: true.';
  }
  lines.push(closing);
  lines.push('</scheduled-wakeup>');
  return lines.join('\n');
}

/** The `loop:` line: which tick this is, the loop's interval and end, what was missed, and how it stands. */
function loopLine(entry: Extract<ScheduledWakeupEntry, { kind: 'tick' }>): string {
  const { loop } = entry;
  const missed = entry.missedSinceLastRun === 1 ? '1 tick' : `${entry.missedSinceLastRun} ticks`;
  let line = `loop: tick ${entry.number}, every ${loop.everySeconds} seconds until ${loop.untilAt.toISOString()}; ${missed} missed since the last run`;
  if (loop.state === 'ACTIVE') return line;
  switch (loop.endedReason) {
    case 'UNTIL_REACHED':
      line += entry.latest
        ? '; this is its last tick: the loop has reached its until'
        : '; the loop has since reached its until';
      break;
    case 'REQUESTED':
      line += '; the loop has since been stopped with stop: true';
      break;
    case 'REPLACED':
      line += '; the loop has since been replaced by a newer one';
      break;
    case 'OWNER_STOP':
      line += '; the loop has since been stopped by the user';
      break;
    case 'SESSION_ENDED':
      line += '; the loop has since ended with the session';
      break;
    default:
      line += '; the loop has since ended';
  }
  return line;
}

/**
 * Write the wakeups filed onto a wake turn into the content being delivered. Throws on a database
 * failure, for the reason appendBackgroundWakeContext does: this block is the turn.
 *
 * A loop's ticks on the turn are one entry, for the latest of them; the ones it folded in are counted
 * among the ticks missed since the loop's previous run — the latest tick of it filed onto another turn —
 * which is what the tick numbers between the two say.
 */
export async function appendScheduledWakeupContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const wakeups = await tx.sessionScheduledWakeup.findMany({
    where: { sessionId, clientTurnId, state: 'DELIVERED' },
    include: { loop: true },
  });
  if (wakeups.length === 0) return content;
  // In the order they came due, ordered here rather than trusted from the read.
  wakeups.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
  const entries: Array<{ at: Date; entry: ScheduledWakeupEntry }> = [];
  const byLoop = new Map<string, typeof wakeups>();
  for (const wakeup of wakeups) {
    if (!wakeup.loopId || !wakeup.loop) {
      entries.push({ at: wakeup.dueAt, entry: { kind: 'once', wakeup } });
      continue;
    }
    byLoop.set(wakeup.loopId, [...(byLoop.get(wakeup.loopId) ?? []), wakeup]);
  }
  for (const [loopId, ticks] of byLoop) {
    const first = ticks[0];
    const tick = ticks[ticks.length - 1];
    const loop = tick.loop!;
    const previousRun = await tx.sessionScheduledWakeup.findFirst({
      where: { loopId, state: 'DELIVERED', clientTurnId: { not: clientTurnId }, dueAt: { lt: first.dueAt } },
      orderBy: { dueAt: 'desc' },
      select: { dueAt: true },
    });
    const later = loop.state === 'ACTIVE'
      ? null
      : await tx.sessionScheduledWakeup.findFirst({
          where: { loopId, state: 'DELIVERED', dueAt: { gt: tick.dueAt } },
          select: { id: true },
        });
    const number = loopTickNumber(loop, tick.dueAt);
    entries.push({
      at: tick.dueAt,
      entry: {
        kind: 'tick',
        tick,
        loop,
        number,
        missedSinceLastRun: Math.max(0, number - (previousRun ? loopTickNumber(loop, previousRun.dueAt) : 0) - 1),
        latest: later == null,
      },
    });
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  const block = buildScheduledWakeupBlock(entries.map((entry) => entry.entry));
  return content ? `${content}\n\n${block}` : block;
}
