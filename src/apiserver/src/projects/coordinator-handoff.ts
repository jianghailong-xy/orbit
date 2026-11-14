import {
  COORDINATOR_HANDOFF_SECTIONS,
  COORDINATOR_HANDOFF_TURN_PREFIX,
  type CoordinatorHandoffFailureCode,
  type CoordinatorHandoffState,
  type CoordinatorHandoffView,
  type CoordinatorPendingWait,
  type SessionCoordinatorHandoff,
  type SessionCoordinatorHandoffReceived,
  coordinatorHandoffFailureSentence,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The pure half of a coordinator handoff (docs/coordinator-handoff.md; the service is
 * coordinator-handoff.service.ts): the note turn's key and words, and how a session reads its
 * handoff for the detail and the realtime summary.
 */

/** A note turn that has been delivered and has not ended after this long has timed out. */
export const HANDOFF_NOTE_TURN_TIMEOUT_MS = 10 * 60_000;
/** A note turn still queued behind another this long after it was asked for has timed out too. */
export const HANDOFF_NOTE_QUEUED_TIMEOUT_MS = 60 * 60_000;

/** The states a handoff is live in: one row at most per outgoing coordinator (migration 0721). */
export const LIVE_HANDOFF_STATES = ['WRITING', 'HANDING_OVER', 'FAILED'] as const;

/** The note turn of one attempt: a new attempt is a new key, so an earlier turn's end settles nothing. */
export function coordinatorHandoffTurnId(handoffId: string, attempt: number): string {
  return `${COORDINATOR_HANDOFF_TURN_PREFIX}${handoffId}:${attempt}`;
}

/**
 * What the outgoing coordinator is asked, as a platform turn: a note in exactly the four sections,
 * as its whole reply. It is told what the note is for and what not to do in that turn, so the turn
 * stays a note and does not become another round of work.
 */
export function coordinatorHandoffPrompt(): string {
  const sections = COORDINATOR_HANDOFF_SECTIONS.map((title) => `${title}`).join('\n');
  return [
    'From Orbit · handoff note',
    'The owner is handing this project over to a new coordinator conversation. Before this one is completed, '
      + 'write the handoff note the new coordinator will start from.',
    'Your whole reply is the note. Use exactly these four sections, in this order, each title on a line of '
      + 'its own followed by a few short lines:',
    sections,
    'Where things stand: the state of the work in a sentence or two. Agreed with the owner: decisions and '
      + 'promises made in this conversation that are not written anywhere else. Waiting on: what you are '
      + 'waiting for, and from whom. Next: the next step you would have taken.',
    'The new coordinator reads project_get and task_list first, so do not copy them: write what only this '
      + 'conversation knows. Do not start, change or file anything in this turn, and do not ask questions — '
      + 'nobody will answer them here. If a section has nothing in it, write "Nothing." under it.',
  ].join('\n\n');
}

/** The row's fields a view is written from. */
export interface CoordinatorHandoffRow {
  id: string;
  ownerId: string;
  projectId: string;
  fromSessionId: string;
  toSessionId: string | null;
  state: string;
  attempt: number;
  clientTurnId: string | null;
  startedAt: Date;
  failureCode: string | null;
  note: string | null;
  movedWaits: unknown;
  endedAt: Date | null;
}

export const HANDOFF_ROW_SELECT = {
  id: true,
  ownerId: true,
  projectId: true,
  fromSessionId: true,
  toSessionId: true,
  state: true,
  attempt: true,
  clientTurnId: true,
  startedAt: true,
  failureCode: true,
  note: true,
  movedWaits: true,
  endedAt: true,
} as const;

function failureOf(row: CoordinatorHandoffRow): { failureCode: CoordinatorHandoffFailureCode | null; failureReason: string | null } {
  if (row.state !== 'FAILED' || !row.failureCode) return { failureCode: null, failureReason: null };
  const code = row.failureCode as CoordinatorHandoffFailureCode;
  return { failureCode: code, failureReason: coordinatorHandoffFailureSentence(code) };
}

function movedWaitsOf(row: CoordinatorHandoffRow): CoordinatorPendingWait[] {
  return Array.isArray(row.movedWaits) ? (row.movedWaits as CoordinatorPendingWait[]) : [];
}

/** What every handoff endpoint answers. */
export function coordinatorHandoffView(row: CoordinatorHandoffRow): CoordinatorHandoffView {
  return {
    projectId: row.projectId,
    sessionId: row.fromSessionId,
    state: row.state as CoordinatorHandoffView['state'],
    startedAt: row.startedAt.toISOString(),
    ...failureOf(row),
    handedOverToSessionId: row.toSessionId,
    movedWaits: movedWaitsOf(row),
  };
}

/** `coordinatorHandoff` on the outgoing coordinator: its newest handoff, unless it was cancelled. */
export function sessionCoordinatorHandoff(row: CoordinatorHandoffRow | null): SessionCoordinatorHandoff | null {
  if (!row || row.state === 'CANCELLED') return null;
  return {
    state: row.state as CoordinatorHandoffState,
    startedAt: row.startedAt.toISOString(),
    ...failureOf(row),
    handedOverToSessionId: row.toSessionId,
  };
}

/** `coordinatorHandoffReceived` on the successor. */
export function sessionCoordinatorHandoffReceived(
  row: CoordinatorHandoffRow | null,
): SessionCoordinatorHandoffReceived | null {
  if (!row || row.state !== 'COMPLETED') return null;
  return {
    handoffFromSessionId: row.fromSessionId,
    note: row.note,
    handedOverAt: (row.endedAt ?? row.startedAt).toISOString(),
    movedWaits: movedWaitsOf(row),
  };
}

/** Both handoff keys a session's detail and realtime summary carry: two indexed reads. */
export async function readSessionCoordinatorHandoffs(
  prisma: Pick<PrismaService, 'coordinatorHandoff'>,
  sessionId: string,
): Promise<{
  coordinatorHandoff: SessionCoordinatorHandoff | null;
  coordinatorHandoffReceived: SessionCoordinatorHandoffReceived | null;
}> {
  const [outgoing, received] = await Promise.all([
    prisma.coordinatorHandoff.findFirst({
      where: { fromSessionId: sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: HANDOFF_ROW_SELECT,
    }),
    prisma.coordinatorHandoff.findFirst({
      where: { toSessionId: sessionId, state: 'COMPLETED' },
      select: HANDOFF_ROW_SELECT,
    }),
  ]);
  return {
    coordinatorHandoff: sessionCoordinatorHandoff(outgoing),
    coordinatorHandoffReceived: sessionCoordinatorHandoffReceived(received),
  };
}
