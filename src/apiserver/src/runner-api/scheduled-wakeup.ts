import { Prisma } from '@prisma/client';
import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
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
 * One wakeup waits per session, the way one ScheduleWakeup does: a later request replaces the waiting one,
 * and a stop cancels it.
 */

/** ScheduleWakeup's own bounds, so the door it is routed to answers the same request the same way. */
export const SCHEDULED_WAKEUP_MIN_DELAY_SECONDS = 60;
export const SCHEDULED_WAKEUP_MAX_DELAY_SECONDS = 3_600;

/** One request, as runner-go's `schedule_wakeup` sends it. */
export class ScheduledWakeupDto {
  /** Cancel the waiting wakeup instead of scheduling one. */
  @IsOptional()
  @IsBoolean()
  stop?: boolean;

  /** Seconds from now. Clamped to [60, 3600]. */
  @ValidateIf((dto: ScheduledWakeupDto) => dto.stop !== true)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  delaySeconds?: number;

  /** What the session is waiting for: said back to it when it is woken. */
  @ValidateIf((dto: ScheduledWakeupDto) => dto.stop !== true)
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason?: string;

  /** What the woken turn is to do. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  prompt?: string;
}

/** What the control plane did: holds a wakeup (and when it is due), or cancelled the waiting one. */
export type ScheduledWakeupReceipt =
  | { outcome: 'SCHEDULED'; id: string; dueAt: string; delaySeconds: number; clamped: boolean; replaced: boolean }
  | { outcome: 'CANCELLED'; cancelled: number };

/**
 * Hold a wakeup for the session, replacing the one waiting, if any. Inside the runner door's retried
 * transaction (runnerApi.scheduledWakeup): the waiting row is superseded and the new one inserted
 * together, or neither is.
 */
export async function scheduleWakeup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  dto: ScheduledWakeupDto,
): Promise<ScheduledWakeupReceipt> {
  const requested = Math.round(Number(dto.delaySeconds));
  const delaySeconds = Math.min(SCHEDULED_WAKEUP_MAX_DELAY_SECONDS, Math.max(SCHEDULED_WAKEUP_MIN_DELAY_SECONDS, requested));
  const superseded = await tx.sessionScheduledWakeup.updateMany({
    where: { sessionId, state: 'PENDING' },
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

/** Cancel the session's waiting wakeup. Nothing waiting is an answer, not an error. */
export async function cancelScheduledWakeup(prisma: PrismaService, sessionId: string): Promise<ScheduledWakeupReceipt> {
  const { count } = await prisma.sessionScheduledWakeup.updateMany({
    where: { sessionId, state: 'PENDING' },
    data: { state: 'CANCELLED', settledAt: new Date() },
  });
  return { outcome: 'CANCELLED', cancelled: count };
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

type DeliveredWakeup = {
  id: string;
  reason: string;
  prompt: string | null;
  delaySeconds: number;
  dueAt: Date;
  createdAt: Date;
};

/** The block a wake turn delivers for the wakeups filed onto it. */
export function buildScheduledWakeupBlock(wakeups: DeliveredWakeup[]): string {
  const lines = ['<scheduled-wakeup>', '  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:'];
  for (const wakeup of wakeups) {
    lines.push(`    ${wakeup.createdAt.toISOString()} scheduled ${wakeup.delaySeconds} seconds out, due ${wakeup.dueAt.toISOString()}`);
    lines.push(`    reason: ${wakeup.reason}`);
    const prompt = (wakeup.prompt ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!prompt) continue;
    lines.push('    what you left for this turn:');
    for (const line of prompt.split('\n')) lines.push(`      ${line}`);
  }
  lines.push('  The control plane recorded this for you; the user did not say it. To wait again, call mcp__orbit__schedule_wakeup again.');
  lines.push('</scheduled-wakeup>');
  return lines.join('\n');
}

/**
 * Write the wakeups filed onto a wake turn into the content being delivered. Throws on a database
 * failure, for the reason appendBackgroundWakeContext does: this block is the turn.
 */
export async function appendScheduledWakeupContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const wakeups = await tx.sessionScheduledWakeup.findMany({ where: { sessionId, clientTurnId, state: 'DELIVERED' } });
  if (wakeups.length === 0) return content;
  // In the order they came due, ordered here rather than trusted from the read.
  wakeups.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
  const block = buildScheduledWakeupBlock(wakeups);
  return content ? `${content}\n\n${block}` : block;
}
