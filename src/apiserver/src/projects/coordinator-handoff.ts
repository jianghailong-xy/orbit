import { BadRequestException } from '@nestjs/common';
import {
  COORDINATOR_HANDOFF_PROMPT_HEAD,
  COORDINATOR_HANDOFF_SECTIONS,
  COORDINATOR_HANDOFF_TURN_PREFIX,
  type CoordinatorHandoffFailureCode,
  type CoordinatorHandoffState,
  type CoordinatorHandoffSuccessor,
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

/** The states a handoff is live in: one row at most per outgoing coordinator (migration 0810). */
export const LIVE_HANDOFF_STATES = ['WRITING', 'HANDING_OVER', 'FAILED'] as const;

/** The note turn of one attempt: a new attempt is a new key, so an earlier turn's end settles nothing. */
export function coordinatorHandoffTurnId(handoffId: string, attempt: number): string {
  return `${COORDINATOR_HANDOFF_TURN_PREFIX}${handoffId}:${attempt}`;
}

/**
 * What the outgoing coordinator is asked, as a platform turn. Two steps, in this order: first record
 * every owner ruling of this conversation that is not yet a project record (`project_ruling_record`,
 * coordinator handoff v2 §2), then write a note in exactly the four sections as its final message. It
 * is told what the note is for and what not to do in that turn, so the turn stays a note and does not
 * become another round of work.
 */
export function coordinatorHandoffPrompt(): string {
  const sections = COORDINATOR_HANDOFF_SECTIONS.map((title) => `${title}`).join('\n');
  return [
    COORDINATOR_HANDOFF_PROMPT_HEAD,
    'The owner is handing this project over to a new coordinator conversation. Before this one is completed, '
      + 'do two things, in this order.',
    'First, record the owner\'s rulings. Read project_get\'s rulings, then for every ruling the owner gave in '
      + 'this conversation that is not there yet, call project_ruling_record with the ruling in one sentence, '
      + 'the owner\'s own words as the quote (copied exactly from that turn), and that turn\'s id as '
      + 'sourceTurnId. When a ruling replaces one already recorded, pass the old one\'s id as supersedes. '
      + 'Answered ask_owner questions are recorded already.',
    'Then write the handoff note the new coordinator will start from. Your final message is the note. Use '
      + 'exactly these four sections, in this order, each title on a line of its own followed by a few short lines:',
    sections,
    'Where things stand: the state of the work in a sentence or two. Rulings not yet recorded: a ruling you '
      + 'could not record, with why; normally "Nothing.". Waiting on: what you are waiting for, and from whom. '
      + 'Next: the next step you would have taken.',
    'The new coordinator reads project_get and task_list first, so do not copy them: write what only this '
      + 'conversation knows. Apart from project_ruling_record, do not start, change or file anything in this '
      + 'turn, and do not ask questions — nobody will answer them here. If a section has nothing in it, write '
      + '"Nothing." under it.',
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
  successorEngine: string | null;
  successorProvider: string | null;
  successorModel: string | null;
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
  successorEngine: true,
  successorProvider: true,
  successorModel: true,
  endedAt: true,
} as const;

/**
 * A successor as the request named it, trimmed, with empty fields dropped. Undefined when the request leaves
 * it out (keep what the handoff has); null when it names none — `null`, or every field empty — which is
 * "Same as this one" and clears a pick made earlier.
 */
export function readHandoffSuccessor(raw: unknown): CoordinatorHandoffSuccessor | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('successor must be an object');
  const out: CoordinatorHandoffSuccessor = {};
  for (const key of ['engine', 'provider', 'model'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value == null) continue;
    if (typeof value !== 'string') throw new BadRequestException(`successor.${key} must be a string`);
    if (value.trim()) out[key] = value.trim();
  }
  return out.engine || out.provider || out.model ? out : null;
}

/** The row's columns for a successor; all null when none is named. */
export function successorColumns(successor: CoordinatorHandoffSuccessor | null) {
  return {
    successorEngine: successor?.engine ?? null,
    successorProvider: successor?.provider ?? null,
    successorModel: successor?.model ?? null,
  };
}

/** The successor the row keeps, or null. */
export function successorOf(row: Pick<CoordinatorHandoffRow, 'successorEngine' | 'successorProvider' | 'successorModel'>): CoordinatorHandoffSuccessor | null {
  if (!row.successorEngine && !row.successorProvider && !row.successorModel) return null;
  return { engine: row.successorEngine, provider: row.successorProvider, model: row.successorModel };
}

function failureOf(row: CoordinatorHandoffRow): { failureCode: CoordinatorHandoffFailureCode | null; failureReason: string | null } {
  if (row.state !== 'FAILED' || !row.failureCode) return { failureCode: null, failureReason: null };
  const code = row.failureCode as CoordinatorHandoffFailureCode;
  return { failureCode: code, failureReason: coordinatorHandoffFailureSentence(code) };
}

/** A handoff recorded before `kind` was added moved watches only, so a wait without one reads as WATCH. */
function movedWaitsOf(row: CoordinatorHandoffRow): CoordinatorPendingWait[] {
  if (!Array.isArray(row.movedWaits)) return [];
  return (row.movedWaits as Array<Omit<CoordinatorPendingWait, 'kind'> & { kind?: CoordinatorPendingWait['kind'] }>)
    .map((wait) => ({ ...wait, kind: wait.kind ?? 'WATCH' }));
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
    successor: successorOf(row),
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
    successor: successorOf(row),
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
