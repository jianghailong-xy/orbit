import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * Deterministic multi-connection lock scheduling against a real PostgreSQL.
 *
 * This module is the *mechanism* only: it opens one backend per party, drives each party's
 * statements in a declared order, and advances only on observed server state — never on a
 * sleep. It asserts nothing about which SQLSTATE anybody gets. That separation is deliberate:
 * the same `ScenarioSpec` proves today's 40P01 baseline and, once the production lock order is
 * repaired, proves that every party commits — one plan, two assertions.
 *
 * Everything destructive here refuses to run anywhere but an isolated disposable server; the
 * guard is `coordinator-pg-test-safety`, which the rest of the repo's destructive PG specs
 * already use, so an accidental Orbit business URL fails before the first write.
 *
 * The only barrier primitive is `pg_blocking_pids`: a party that is supposed to be waiting is
 * polled until PostgreSQL itself reports it blocked by the expected backends. A poll that does
 * not converge inside its deadline throws — a barrier never times out into a pass.
 */

/** How often the blocked-state barrier re-reads `pg_blocking_pids`. */
const POLL_INTERVAL_MS = 2;

export interface PartySpec {
  /** Stable name used by the plan and by the recorded outcome. */
  name: string;
  /**
   * `deadlock_timeout` for this backend. The victim is whichever backend runs the deadlock
   * check that finds the cycle, so a party given a timeout far beyond the run can never be the
   * victim: pinning the victim is a configured detector threshold, not a race.
   */
  deadlockTimeout: string;
}

export type PlanStep =
  /** Run to completion. A failure here is a fixture bug and aborts the scenario. */
  | { op: 'run'; party: string; label: string; sql: string; values?: unknown[] }
  /**
   * Start a statement that is expected to block, then wait until PostgreSQL reports this
   * party blocked by `blockedBy`. The wait edge is recorded as evidence.
   */
  | { op: 'block'; party: string; label: string; sql: string; values?: unknown[]; blockedBy: string[] }
  /** Await the outcome of this party's outstanding `block` statement (success or SQLSTATE). */
  | { op: 'settle'; party: string }
  /** End this party's transaction. Tolerates an already-aborted transaction. */
  | { op: 'finish'; party: string; action: 'COMMIT' | 'ROLLBACK' };

export interface ScenarioSpec {
  name: string;
  parties: PartySpec[];
  /** Statements every party runs after BEGIN, before the plan. */
  plan: PlanStep[];
}

export interface StatementOutcome {
  party: string;
  label: string;
  ok: boolean;
  sqlstate?: string;
  message?: string;
  detail?: string;
  /** PostgreSQL error CONTEXT — for an FK wait this names the RI query that blocked. */
  context?: string;
  constraint?: string;
}

export interface LockRow {
  pid: number;
  locktype: string;
  mode: string;
  granted: boolean;
  relation: string | null;
  transactionid: string | null;
  tuple: number | null;
}

export interface WaitEdge {
  /** The `block` step that produced this observation. */
  label: string;
  waiter: string;
  waiterPid: number;
  blockingPids: number[];
  blockedBy: string[];
  waitEventType: string | null;
  waitEvent: string | null;
  /** `pg_locks` for every party backend at the moment the edge was observed. */
  locks: LockRow[];
}

export interface ScenarioOutcome {
  name: string;
  pids: Record<string, number>;
  statements: StatementOutcome[];
  waitEdges: WaitEdge[];
  /** Whether each party's transaction reached COMMIT without error. */
  committed: Record<string, boolean>;
}

/** A hard wall-clock bound. Every wait in this module is measured against one. */
export class Deadline {
  private readonly endsAt: number;

  constructor(private readonly budgetMs: number) {
    this.endsAt = Date.now() + budgetMs;
  }

  remaining(): number {
    return this.endsAt - Date.now();
  }

  assertLive(what: string): void {
    if (this.remaining() <= 0) {
      throw new Error(`barrier deadline exceeded after ${this.budgetMs}ms while ${what}`);
    }
  }
}

function sqlErrorFields(e: unknown): Omit<StatementOutcome, 'party' | 'label' | 'ok'> {
  const err = e as { code?: string; message?: string; detail?: string; where?: string; constraint?: string };
  return {
    sqlstate: err?.code,
    message: err?.message,
    detail: err?.detail,
    context: err?.where,
    constraint: err?.constraint,
  };
}

/** One connection, one backend, one transaction. `pg` serializes queries per client, which is
 *  exactly the property a party needs: a statement left waiting holds the party still. */
class Party {
  private pending: { label: string; promise: Promise<StatementOutcome>; settled: boolean } | null = null;

  constructor(
    readonly spec: PartySpec,
    private readonly client: Client,
    readonly pid: number,
  ) {}

  async run(label: string, sql: string, values?: unknown[]): Promise<void> {
    try {
      await this.client.query(sql, values as never);
    } catch (e) {
      const fields = sqlErrorFields(e);
      throw new Error(
        `party ${this.spec.name} step ${label} was expected to succeed but failed ` +
          `(${fields.sqlstate ?? 'no sqlstate'}): ${fields.message ?? String(e)}`,
      );
    }
  }

  /** Start a statement and keep its promise. Nothing is awaited: the party is now waiting. */
  dispatch(label: string, sql: string, values?: unknown[]): void {
    if (this.pending) throw new Error(`party ${this.spec.name} already has ${this.pending.label} outstanding`);
    const promise = this.client
      .query(sql, values as never)
      .then(() => ({ party: this.spec.name, label, ok: true }) as StatementOutcome)
      .catch((e) => ({ party: this.spec.name, label, ok: false, ...sqlErrorFields(e) }) as StatementOutcome)
      .then((outcome) => {
        if (this.pending?.label === label) this.pending.settled = true;
        return outcome;
      });
    this.pending = { label, promise, settled: false };
  }

  /** Whether the outstanding statement already finished — a statement that was declared to
   *  block but did not. */
  get pendingSettled(): boolean {
    return this.pending?.settled ?? false;
  }

  async settle(deadline: Deadline): Promise<StatementOutcome> {
    const pending = this.pending;
    if (!pending) throw new Error(`party ${this.spec.name} has no outstanding statement to settle`);
    this.pending = null;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`party ${this.spec.name} statement ${pending.label} never settled`)),
        Math.max(1, deadline.remaining()),
      ).unref(),
    );
    return Promise.race([pending.promise, timeout]);
  }

  /**
   * COMMIT/ROLLBACK, reporting whether the transaction actually committed.
   *
   * The command tag, not the absence of an error, is what decides. PostgreSQL answers COMMIT on
   * an ALREADY-ABORTED transaction with success and the tag `ROLLBACK`, so trusting the call to
   * throw would report a transaction that lost a deadlock as committed — precisely the reading
   * the post-fix regression depends on being honest about.
   */
  async finish(action: 'COMMIT' | 'ROLLBACK'): Promise<boolean> {
    try {
      const result = await this.client.query(action);
      return action === 'COMMIT' && result.command === 'COMMIT';
    } catch {
      await this.client.query('ROLLBACK').catch(() => undefined);
      return false;
    }
  }

  async end(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

/** Read-only third connection. It never writes and never joins a lock cycle; it exists so the
 *  waiting parties can be observed while they wait. */
export class Observer {
  constructor(private readonly client: Client) {}

  async blockedState(pid: number): Promise<{ blockingPids: number[]; waitEventType: string | null; waitEvent: string | null }> {
    const { rows } = await this.client.query<{
      blocking: number[];
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `SELECT pg_blocking_pids($1) AS blocking, wait_event_type, wait_event
         FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    const row = rows[0];
    if (!row) throw new Error(`backend ${pid} disappeared from pg_stat_activity`);
    return { blockingPids: row.blocking ?? [], waitEventType: row.wait_event_type, waitEvent: row.wait_event };
  }

  async locks(pids: number[]): Promise<LockRow[]> {
    const { rows } = await this.client.query<LockRow>(
      `SELECT l.pid, l.locktype, l.mode, l.granted,
              l.relation::regclass::text AS relation,
              l.transactionid::text AS transactionid,
              l.tuple
         FROM pg_locks l
         LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ANY($1::int[])
          -- The evidence, without the noise: every row lock and transaction wait, plus the
          -- table-level modes that name the operation. A statement takes dozens of index locks
          -- and not one of them says anything about a lock cycle.
          AND (NOT l.granted
               OR l.locktype IN ('transactionid', 'tuple', 'advisory')
               OR (l.locktype = 'relation' AND c.relkind = 'r' AND l.mode <> 'AccessShareLock'))
        ORDER BY l.pid, l.granted DESC, l.locktype, l.mode`,
      [pids],
    );
    return rows;
  }
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

/**
 * Poll until PostgreSQL reports `pid` blocked by exactly `expected`. Returns the observation.
 *
 * This is the only synchronisation primitive in the harness. It is a condition barrier, not a
 * sleep: it advances the moment the server reports the state the plan requires, and a deadline
 * that expires is a thrown error, never a quiet pass.
 */
async function awaitBlocked(
  observer: Observer,
  pid: number,
  expected: number[],
  deadline: Deadline,
  what: string,
  hasSettled: () => boolean,
): Promise<{ blockingPids: number[]; waitEventType: string | null; waitEvent: string | null }> {
  let last: number[] = [];
  for (;;) {
    // A statement declared to block that has already finished will never block. Say so now
    // rather than burning the deadline on a state that can no longer arrive.
    if (hasSettled()) throw new Error(`${what}: the statement finished without ever blocking`);
    deadline.assertLive(`${what} (last seen blocked by [${last.join(', ')}])`);
    const state = await observer.blockedState(pid);
    last = state.blockingPids;
    const want = [...expected].sort();
    const got = [...state.blockingPids].sort();
    if (got.length === want.length && got.every((v, i) => v === want[i])) return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Run one scenario. Every party gets its own backend; the plan is executed exactly as written.
 *
 * The returned outcome is a *record* of what PostgreSQL did — which statements succeeded, which
 * SQLSTATE each failure carried, and the observed wait graph. Callers decide what that means.
 */
export async function runScenario(
  url: string,
  spec: ScenarioSpec,
  budgetMs: number,
): Promise<ScenarioOutcome> {
  assertCoordinatorPgUrlIsIsolated(url);
  const deadline = new Deadline(budgetMs);
  const parties = new Map<string, Party>();
  const observerClient = await connect(url);
  const observer = new Observer(observerClient);
  const outcome: ScenarioOutcome = { name: spec.name, pids: {}, statements: [], waitEdges: [], committed: {} };

  try {
    for (const partySpec of spec.parties) {
      const client = await connect(url);
      const pid = await backendPid(client);
      const party = new Party(partySpec, client, pid);
      parties.set(partySpec.name, party);
      outcome.pids[partySpec.name] = pid;
      await party.run('BEGIN', 'BEGIN');
      // SET LOCAL so the setting dies with the transaction and cannot leak into a later round.
      await party.run('deadlock_timeout', `SET LOCAL deadlock_timeout = '${partySpec.deadlockTimeout}'`);
      const { rows } = await client.query<{ v: string }>(`SELECT current_setting('deadlock_timeout') AS v`);
      if (rows[0].v !== partySpec.deadlockTimeout) {
        throw new Error(
          `party ${partySpec.name} could not pin deadlock_timeout: asked for ` +
            `${partySpec.deadlockTimeout}, server reports ${rows[0].v}`,
        );
      }
    }

    const partyOf = (name: string): Party => {
      const party = parties.get(name);
      if (!party) throw new Error(`plan references unknown party ${name}`);
      return party;
    };
    const allPids = [...parties.values()].map((p) => p.pid);

    for (const step of spec.plan) {
      const party = partyOf(step.party);
      switch (step.op) {
        case 'run':
          deadline.assertLive(`running ${step.party}/${step.label}`);
          await party.run(step.label, step.sql, step.values);
          outcome.statements.push({ party: step.party, label: step.label, ok: true });
          break;
        case 'block': {
          if (step.blockedBy.length === 0) {
            throw new Error(`plan step ${step.party}/${step.label} declares a block on nobody`);
          }
          party.dispatch(step.label, step.sql, step.values);
          const expected = step.blockedBy.map((n) => partyOf(n).pid);
          const state = await awaitBlocked(
            observer,
            party.pid,
            expected,
            deadline,
            `waiting for ${step.party}/${step.label} to block on [${step.blockedBy.join(', ')}]`,
            () => party.pendingSettled,
          );
          outcome.waitEdges.push({
            label: step.label,
            waiter: step.party,
            waiterPid: party.pid,
            blockingPids: state.blockingPids,
            blockedBy: step.blockedBy,
            waitEventType: state.waitEventType,
            waitEvent: state.waitEvent,
            locks: await observer.locks(allPids),
          });
          break;
        }
        case 'settle':
          outcome.statements.push(await party.settle(deadline));
          break;
        case 'finish':
          outcome.committed[step.party] = await party.finish(step.action);
          break;
      }
    }
    return outcome;
  } finally {
    for (const party of parties.values()) await party.end();
    await observerClient.end().catch(() => undefined);
  }
}
