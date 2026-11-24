import { Prisma } from '@prisma/client';
import {
  MAX_PROJECT_REOPEN_TEXT,
  PROJECT_REOPEN_KIND,
  type ProjectReopenAsker,
  type ProjectReopenPayload,
  type ProjectReopenSettledStatus,
} from '@orbit/shared';
import { enqueueResolutions } from './owner-request-endings';

/**
 * PROJECT_REOPEN (docs/project-reopen-request-design.md §4, migration 1573): the rules with no service in them — what a
 * filing must hold, the payload's askers, and the one statement that settles a project's waiting card, which the
 * owner's answer, the project page's Reopen press and a project delete all write through.
 */

/** A filing's text, or why it is refused: `why` and `plannedWork`, each trimmed, non-empty, at most 2,000 characters. */
export function projectReopenText(
  filing: { why?: unknown; plannedWork?: unknown },
): { why: string; plannedWork: string } | { error: string } {
  const why = typeof filing.why === 'string' ? filing.why.trim() : '';
  const plannedWork = typeof filing.plannedWork === 'string' ? filing.plannedWork.trim() : '';
  if (!why) return { error: 'why is required: say what the refused write was for, so the owner can decide' };
  if (!plannedWork) return { error: 'plannedWork is required: say what work you will add once the project is reopened' };
  if (why.length > MAX_PROJECT_REOPEN_TEXT) return { error: `why is at most ${MAX_PROJECT_REOPEN_TEXT} characters` };
  if (plannedWork.length > MAX_PROJECT_REOPEN_TEXT) {
    return { error: `plannedWork is at most ${MAX_PROJECT_REOPEN_TEXT} characters` };
  }
  return { why, plannedWork };
}

/**
 * When the project was settled, as far as the schema records it: `done_at` for DONE. A cancellation has no column of
 * its own, so a CANCELLED project's is the row's last write, which the cancel was unless the owner edited it since.
 * A decline is held to the settlement it was asked over (`declinedSinceSettled`), so this is what tells a project that
 * was reopened and settled again from one that never moved.
 */
export function projectSettledAt(project: { status: string; doneAt: Date | null; updatedAt: Date }): Date {
  return project.status === 'DONE' && project.doneAt ? project.doneAt : project.updatedAt;
}

/** The payload's askers, oldest first; an unreadable payload has none. */
export function projectReopenAskers(payload: unknown): ProjectReopenAsker[] {
  const askers = (payload as Partial<ProjectReopenPayload> | null)?.askers;
  return Array.isArray(askers) ? askers.filter((a) => typeof a?.sessionId === 'string') : [];
}

/** The payload a new request is filed with. */
export function newProjectReopenPayload(input: {
  projectId: string;
  statusAtAsk: ProjectReopenSettledStatus;
  settledAt: Date;
  plannedWork: string;
  sessionId: string;
  now: Date;
}): ProjectReopenPayload {
  return {
    projectId: input.projectId,
    statusAtAsk: input.statusAtAsk,
    settledAt: input.settledAt.toISOString(),
    plannedWork: input.plannedWork,
    askers: [{ sessionId: input.sessionId, askedAt: input.now.toISOString() }],
  };
}

/** Whether a declined request was asked over the settlement the project still stands in. */
export function declinedSinceSettled(
  declinedPayload: unknown,
  project: { status: string; doneAt: Date | null; updatedAt: Date },
): boolean {
  const asked = declinedPayload as Partial<ProjectReopenPayload> | null;
  return asked?.statusAtAsk === project.status && asked?.settledAt === projectSettledAt(project).toISOString();
}

/** The refusal of a re-file after a decline, dated in UTC. */
export function projectReopenDeclinedMessage(declinedAt: Date, reason: string | null): string {
  return `The owner declined to reopen this project on ${declinedAt.toISOString().slice(0, 10)}`
    + (reason ? `: “${reason}”.` : '.')
    + ' A declined card is a refusal: do not ask again; tell the person instead.';
}

/** A request settled by `settlePendingProjectReopens`, with every session that asked it. */
export interface SettledProjectReopen {
  id: string;
  askers: string[];
}

/**
 * Every PENDING PROJECT_REOPEN of the project ended in one statement, each with its delivery to its asking sessions,
 * inside the caller's transaction — so the reopen (or delete) and the cards' endings commit or roll back together. A
 * compare-and-set on PENDING: a card another writer ended first is left as it ended.
 */
export async function settlePendingProjectReopens(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  to: 'DONE' | 'WITHDRAWN',
  data: Pick<Prisma.OwnerRequestUpdateManyMutationInput, 'resolvedByUserId' | 'resolvedClient' | 'resolutionNote'>,
  now: Date,
): Promise<SettledProjectReopen[]> {
  const rows = await tx.ownerRequest.updateManyAndReturn({
    where: { ownerId, projectId, kind: PROJECT_REOPEN_KIND, state: 'PENDING' },
    data: { ...data, state: to, resolvedAt: now },
    select: { id: true, askedBySessionId: true, payload: true },
  });
  await enqueueResolutions(tx, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    askers: [...new Set([row.askedBySessionId, ...projectReopenAskers(row.payload).map((a) => a.sessionId)])],
  }));
}
