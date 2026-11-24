import { noSessionRequests } from './prisma-transaction-double';

/**
 * For the unit specs that drive a payload door against a fake Prisma: recognise the one statement
 * `readSessionPhaseFields` (sessions/session-phase.ts) runs, and answer it from the fake's own session rows, as the
 * database would for rows with nothing armed on them — no watch, no wake-up, an online runner, no dispatch pause. A
 * fake that answers every `$queryRaw` alike would otherwise hand the reader a row it cannot match to a session.
 */

interface Query {
  strings?: readonly string[];
  sql?: string;
  values?: readonly unknown[];
}

/** Whether `query` is the session-phase facts statement. */
export function isSessionPhaseFactsQuery(query: unknown): boolean {
  const q = query as Query | undefined;
  const text = q?.sql ?? q?.strings?.join('?') ?? '';
  return text.includes('AS "hasResumeWatch"');
}

/** The statement's answer for the sessions it asks about, built from `rows` (a fake's session rows by id). */
export function sessionPhaseFactsAnswer(query: unknown, rows: Record<string, Record<string, unknown> | undefined>) {
  const values = (query as Query).values ?? [];
  return values.flatMap((value) => {
    const row = typeof value === 'string' ? rows[value] : undefined;
    if (!row) return [];
    return [{
      id: value,
      ownerId: row.ownerId ?? null,
      taskId: row.taskId ?? null,
      status: row.status,
      finishedAt: row.finishedAt ?? null,
      lastTurnOutcome: row.lastTurnOutcome ?? null,
      error: row.error ?? null,
      endReason: row.endReason ?? null,
      sessionKind: row.sessionKind ?? 'CONVERSATION',
      engineTurnActive: row.engineTurnActive ?? false,
      runningSubagents: row.runningSubagents ?? [],
      runningBgJobs: row.runningBgJobs ?? [],
      runningBgShells: row.runningBgShells ?? [],
      retryAt: row.retryAt ?? null,
      hasResumeWatch: false,
      hasPendingWakeup: false,
      runnerUnavailable: false,
      dispatchPaused: false,
    }];
  });
}

/**
 * The tables `waitingOn: 'PERSON'` reads when a door has no count of its own (the detail, the shared header, the guest
 * row, `session.ended`): approval cards and the owner decisions on a session (projects/owner-decision-signal.ts), all
 * answering with none. Spread into a fake beside its own `session`, which must answer `findMany` too.
 */
export function noAnswersOwed() {
  return {
    approval: { findMany: async () => [], count: async () => 0 },
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    task: { findMany: async () => [] },
    sessionRequest: noSessionRequests(),
    projectOpenItem: { findMany: async () => [] },
    ownerRequest: { findMany: async () => [], groupBy: async () => [] },
    projectHandoffApproval: { findMany: async () => [] },
  };
}
