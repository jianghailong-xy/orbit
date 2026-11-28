import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ControlEvent, ControlEventType, uuidToBase62, type ControlListChanged } from '@orbit/shared';
import { createHash } from 'node:crypto';
import { Observable } from 'rxjs';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersionParts } from '../sessions/open-list-version';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { sessionCarriesTaskSql } from '../sessions/task-work-carrier';

/** How often the account counters are summed, and so the soonest a hint follows a write. */
export const LIST_CHANGED_COUNTER_EVERY_MS = 1_000;
/** How often the whole version is read for every watched account, for what moves with the clock alone. */
export const LIST_CHANGED_CLOCK_EVERY_MS = 15_000;

/** One stream that declared `hints=list_changed`, and the version it was last told. */
interface Stream {
  send: (event: ControlEvent) => void;
  /** Whether it also declared `hints=list_scopes`, and so is told which workspaces moved. */
  scoped: boolean;
  /** Undefined until its first hint, which it gets at the first tick after it subscribed. */
  told?: string;
}

interface Watched {
  /** The streams of this account on this process that declared `hints=list_changed`. */
  streams: Set<Stream>;
  /** Each counter key's total at the last read (`<source>`, `<source>@w:<ws>`, `<source>@c:<ws>`); undefined until the first one. */
  keys?: Map<string, bigint>;
  /** The clock part of the hint token at its last read (`hintClock`); undefined until the first one. */
  clockPart?: string;
  /** The workspaces holding an Open PENDING row, which a `since=` read rebuilds on every read (rule 4), as last read. */
  always: Set<string>;
  /** The account's `session` counter total when `always` was read; undefined until it is. */
  alwaysAt?: string;
  /** The task-run pairs (rule 5) of the previous tick, so a run that stopped carrying its task in this one still
   *  names its creator's workspace. */
  carried?: Array<[string, string]>;
}

/** One row of a tick's statement: a counter key, an open request's two workspaces, an always-rebuilt workspace, or a re-read of those. */
interface TickRow {
  kind: 'k' | 'p' | 't' | 'a' | 'r';
  owner_id: string;
  a: string | null;
  b: string | null;
}

/**
 * The Open-list predicate of migration 1464's triggers (sessions.service.ts listShape): a CONVERSATION, neither
 * completed, archived nor deleted, no Ask, no scheduled run and no schedule-change conversation (main 1447).
 */
const listed = (alias: string): Prisma.Sql => {
  const s = Prisma.raw(alias);
  return Prisma.sql`${s}.kind = 'CONVERSATION' AND ${s}.completed_at IS NULL AND ${s}.archived_at IS NULL
    AND ${s}.deleted_at IS NULL AND ${s}.help_ask IS NULL AND ${s}.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')`;
};

/**
 * `sessions.list_changed` (docs/realtime-control-plane-stream.md §4.8): a hint, sent to the streams
 * that asked for it, that the account's Open list may read differently than that stream was last told.
 *
 * It does not depend on any write path publishing anything. Every table the Open list is built
 * from bumps the account's `open_list_epoch` counters (migrations 0484/0487), so this process reads
 * those counters once a second — one statement for every account it has a hinted stream of, however
 * many streams and devices that is — and tells a stream when they moved. What
 * moves only with the clock (a runner going offline, a job going quiet, a review window or an
 * escalation passing) moves no counter, so every 15 s the clock part of the hint token is read for
 * each watched account as well.
 *
 * What it compares is a hint token, not the list's version (docs/list-freshness-scope-hints.md §5.0):
 * the counter sums and that clock part, which leaves out the runners' heartbeats and the runner
 * columns outside `steady`. A second in which only counters moved reads nothing but the counters.
 *
 * Which workspaces moved (§5.1, migration 1464): the sources that hang on one session or one
 * workspace bump a key naming the workspace, `w:` for a row in an Open list and `c:` for one in none,
 * and every other source the account's key. A stream that also declared `hints=list_scopes` is told
 * `scopes`, the public ids of the workspaces whose Open lists may read differently since its previous
 * hint, and is told nothing on a tick in which no such workspace moved. It gets no `scopes` — any list
 * may have moved — on its first hint, when an account-wide key moved, and when the clock part moved (a
 * clock threshold, a runner's `steady`). A workspace moved when its own `w:` key did, and also:
 * - when the other end of one of the account's OPEN requests moved, in either scope (rule 3): an open
 *   request shows the peer's title on both rows, and a held question reads the recipient's row and
 *   turn. That holds within one workspace too: a peer outside every Open list moves only `c:W`, and an
 *   Open row of W still draws it;
 * - when any scope moved and the workspace holds an Open PENDING row (rule 4), whose queued gate counts
 *   other sessions on its runner, which a `since=` read rebuilds on every read. Those are read again
 *   whenever the account's `session` keys moved. A row rooted in a LANDING session, which that read
 *   rebuilds too, is not one of them: the landing's own writes move no counter (open_list_bump_session
 *   counts CONVERSATION rows only) and its progress writes account-wide sources, which name no workspace;
 * - when a session running a task moved, for the workspace of the session that created the task (rule 5):
 *   that row counts its created tasks that are running and queued (`readCreatedTasksActive`). The pairs are
 *   the runs that carry a task now and those that did at the previous tick, so the write that ends a run's
 *   carry, after which this tick no longer reads its pair, still names the creator's workspace.
 * Every other stream is told exactly what it was before: `{ version }`, whenever the token moved.
 *
 * What a stream was told is kept per stream, not per account. A new stream is told the current
 * version at the first tick after it subscribed, whether or not anything moved: a client reads its
 * list around the time it connects, in either order relative to the subscription, and this first
 * hint is what that read is answered against — a write that landed between the two is never lost
 * in a baseline. After that a stream is told only a version that differs from the one it holds.
 *
 * At most one hint per stream per second: a tick sends each stream at most one, and the next tick is
 * scheduled a full interval after this one ended, never on a fixed beat a slow tick could catch up
 * with. One tick chain at a time: a stream that arrives while a tick runs leaves the next one to that
 * tick's end.
 *
 * Reads only. It writes nothing and takes no lock.
 */
export class OpenListHints {
  private readonly log = new Logger('OpenListHints');
  private readonly owners = new Map<string, Watched>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private lastClockAt = 0;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly counterEveryMs = LIST_CHANGED_COUNTER_EVERY_MS,
    private readonly clockEveryMs = LIST_CHANGED_CLOCK_EVERY_MS,
  ) {}

  /**
   * The hints for one stream of `ownerId`; watching starts on subscribe and ends on unsubscribe. `scoped`: the
   * stream declared `hints=list_scopes`.
   */
  watch(ownerId: string, options: { scoped?: boolean } = {}): Observable<ControlEvent> {
    return new Observable<ControlEvent>((subscriber) => {
      const stream: Stream = { send: (event) => subscriber.next(event), scoped: options.scoped === true };
      let watched = this.owners.get(ownerId);
      if (!watched) {
        watched = { streams: new Set(), always: new Set() };
        this.owners.set(ownerId, watched);
      }
      watched.streams.add(stream);
      this.schedule();
      const mine = watched;
      return () => {
        mine.streams.delete(stream);
        if (mine.streams.size === 0 && this.owners.get(ownerId) === mine) this.owners.delete(ownerId);
        if (this.owners.size === 0 && this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
      };
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.ticking || this.owners.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ticking = true;
      void this.tick().finally(() => {
        this.ticking = false;
        this.schedule();
      });
    }, this.counterEveryMs);
    this.timer.unref?.();
  }

  private read(ids: string[]): Promise<TickRow[]> {
    const held = ids.flatMap((id) => {
      const at = this.owners.get(id)?.alwaysAt;
      return at === undefined ? [] : [[id, at] as const];
    });
    return this.prisma.$queryRaw<TickRow[]>(openListTickStatement(ids, held));
  }

  private async tick(): Promise<void> {
    const ids = [...this.owners.keys()];
    if (ids.length === 0) return;
    try {
      const read = new Map<string, {
        keys: Map<string, bigint>; pairs: Array<[string, string]>; carried: Array<[string, string]>; always?: Set<string>; alwaysAt?: string;
      }>();
      const of = (ownerId: string) => {
        let found = read.get(ownerId);
        if (!found) read.set(ownerId, found = { keys: new Map(), pairs: [], carried: [] });
        return found;
      };
      const always: Array<[string, string]> = [];
      for (const row of await this.read(ids)) {
        const owner = of(row.owner_id);
        if (row.kind === 'k') owner.keys.set(row.a!, BigInt(row.b!));
        else if (row.kind === 'p') owner.pairs.push([row.a!, row.b!]);
        else if (row.kind === 't') owner.carried.push([row.a!, row.b!]);
        else if (row.kind === 'r') {
          owner.always = new Set();
          owner.alwaysAt = row.a!;
        } else always.push([row.owner_id, row.a!]);
      }
      for (const [ownerId, ws] of always) of(ownerId).always?.add(ws);
      const now = Date.now();
      const clock = now - this.lastClockAt >= this.clockEveryMs;
      if (clock) this.lastClockAt = now;
      await Promise.all(ids.map(async (ownerId) => {
        const watched = this.owners.get(ownerId);
        if (!watched) return;
        const { keys, pairs, carried, always: rebuilt, alwaysAt } = of(ownerId);
        // Read just now, whatever becomes of the rest of this account's tick.
        if (rebuilt) {
          watched.always = rebuilt;
          watched.alwaysAt = alwaysAt;
        }
        const untold = [...watched.streams].some((stream) => stream.told === undefined);
        // The counters moving does not read the version: the clock part is what the counters do not
        // cover, and it is read on the clock tick and for a new stream only.
        let clockPart = watched.clockPart;
        if (clock || untold || clockPart === undefined) {
          clockPart = (await readOpenListVersionParts(this.prisma, ownerId, Date.now())).hintClock;
        }
        const sum = [...keys.values()].reduce((total, epoch) => total + epoch, 0n).toString();
        // Opaque to clients, which compare it with the previous hint's only.
        const version = createHash('sha256').update(`${sum}|${clockPart}`).digest('base64url').slice(0, 27);
        const scopes = movedScopes(
          watched.keys, keys, watched.clockPart !== clockPart, [...pairs, ...carried, ...(watched.carried ?? [])], watched.always,
        );
        watched.keys = keys;
        watched.carried = carried;
        watched.clockPart = clockPart;
        for (const stream of watched.streams) {
          const first = stream.told === undefined;
          if (!first && (stream.scoped && scopes !== undefined ? scopes.length === 0 : stream.told === version)) continue;
          stream.told = version;
          const data: ControlListChanged = stream.scoped && !first && scopes !== undefined ? { version, scopes } : { version };
          stream.send({
            type: ControlEventType.SESSIONS_LIST_CHANGED,
            sessionId: '',
            agentId: null,
            ts: new Date().toISOString(),
            data: data as unknown as Record<string, unknown>,
          });
        }
      }));
    } catch (error) {
      this.log.warn(`list_changed tick failed: ${(error as Error).message}`);
    }
  }
}

/**
 * The poller's one statement per tick, for every watched account (`ids`): each counter key's total; the two
 * workspaces of each OPEN request (rule 3), the same one twice when both peers sit in it, on session_request's
 * partial OPEN indexes; and, for an account whose `session` keys moved since they were last read (`held`: the
 * `session` total each account's were read at; an account not in it was never read), the workspaces holding an
 * Open queued row (rule 4), through session_owner_held_task_idx, marked by an `r` row with the `session`
 * total they were read at; and the workspaces of each session carrying a task and of the session that created
 * the task (rule 5), over the carriers alone. No branch scans an account's sessions.
 */
export function openListTickStatement(ids: readonly string[], held: ReadonlyArray<readonly [string, string]>): Prisma.Sql {
  return Prisma.sql`
      WITH counters AS (
        SELECT owner_id, split_part(source, '#', 1) AS key, sum(epoch) AS total
          FROM open_list_epoch
         WHERE owner_id = ANY(${[...ids]}::uuid[])
         GROUP BY owner_id, split_part(source, '#', 1)
      ),
      sessions AS (
        SELECT o.id AS owner_id, COALESCE(sum(c.total), 0)::text AS total
          FROM unnest(${[...ids]}::uuid[]) AS o(id)
          LEFT JOIN counters c ON c.owner_id = o.id AND split_part(c.key, '@', 1) = 'session'
         GROUP BY o.id
      ),
      stale AS (
        SELECT s.owner_id, s.total
          FROM sessions s
          LEFT JOIN unnest(${held.map(([id]) => id)}::uuid[], ${held.map(([, at]) => at)}::text[]) AS h(owner_id, total)
            ON h.owner_id = s.owner_id
         WHERE h.total IS DISTINCT FROM s.total
      )
      SELECT 'k' AS kind, owner_id::text AS owner_id, key AS a, total::text AS b FROM counters
      UNION ALL
      SELECT 'r', owner_id::text, total, NULL FROM stale
      UNION ALL
      SELECT 'p', r.owner_id::text, f.workspace_id::text, t.workspace_id::text
        FROM session_request r
        JOIN session f ON f.id = r.from_session_id
        JOIN session t ON t.id = r.to_session_id
       WHERE r.state = 'OPEN' AND r.owner_id = ANY(${[...ids]}::uuid[])
         AND f.workspace_id IS NOT NULL AND t.workspace_id IS NOT NULL
      UNION ALL
      SELECT DISTINCT 't', c.owner_id::text, c.workspace_id::text, cr.workspace_id::text
        FROM session c
        JOIN task k ON k.id = c.task_id
        JOIN session cr ON cr.id = k.creator_session_id
       WHERE c.owner_id = ANY(${[...ids]}::uuid[]) AND c.task_id IS NOT NULL AND ${Prisma.raw(sessionCarriesTaskSql('c'))}
         AND c.workspace_id IS NOT NULL AND cr.workspace_id IS NOT NULL
      UNION ALL
      SELECT DISTINCT 'a', x.owner_id::text, x.workspace_id::text, NULL::text
        FROM session x
       WHERE x.owner_id IN (SELECT owner_id FROM stale) AND x.finished_at IS NULL AND ${sessionTurnStateSql('x')} = 'QUEUED'
         AND x.workspace_id IS NOT NULL AND ${listed('x')}`;
}

/**
 * The public ids of the workspaces whose Open lists may read differently between two reads of an account's
 * counter keys, or undefined when any list may: the first read, an account-wide key, or the clock part moved.
 */
export function movedScopes(
  before: ReadonlyMap<string, bigint> | undefined,
  after: ReadonlyMap<string, bigint>,
  clockMoved: boolean,
  pairs: ReadonlyArray<readonly [string, string]>,
  always: ReadonlySet<string>,
): string[] | undefined {
  if (before === undefined || clockMoved) return undefined;
  const named = new Set<string>();
  const moved = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const at = key.indexOf('@');
    if (at < 0) return undefined;
    const scope = key.slice(at + 1);
    const ws = scope.slice(2);
    moved.add(ws);
    if (scope.startsWith('w:')) named.add(ws);
  }
  if (moved.size === 0) return [];
  for (const [a, b] of pairs) {
    if (moved.has(a)) named.add(b);
    if (moved.has(b)) named.add(a);
  }
  for (const ws of always) named.add(ws);
  return [...named].map(uuidToBase62).sort();
}

function declares(hints: string | string[] | undefined, name: string): boolean {
  const values = Array.isArray(hints) ? hints : hints === undefined ? [] : [hints];
  return values.some((value) => value.split(',').some((hint) => hint.trim() === name));
}
/** Whether a `GET /api/events?hints=` value declares `list_changed`. */
export function declaresListChanged(hints: string | string[] | undefined): boolean {
  return declares(hints, 'list_changed');
}
/** Whether a `GET /api/events?hints=` value declares `owner_requests`. */
export function declaresOwnerRequests(hints: string | string[] | undefined): boolean {
  return declares(hints, 'owner_requests');
}
/** Whether a `GET /api/events?hints=` value declares `drive_changed`. */
export function declaresDriveChanged(hints: string | string[] | undefined): boolean {
  return declares(hints, 'drive_changed');
}
/** Whether a `GET /api/events?hints=` value declares `drive_syncs`. */
export function declaresDriveSyncs(hints: string | string[] | undefined): boolean {
  return declares(hints, 'drive_syncs');
}
/** Whether a `GET /api/events?hints=` value declares `schedule_cards`. */
export function declaresScheduleCards(hints: string | string[] | undefined): boolean {
  return declares(hints, 'schedule_cards');
}
/** Whether a `GET /api/events?hints=` value declares `list_scopes`. */
export function declaresListScopes(hints: string | string[] | undefined): boolean {
  return declares(hints, 'list_scopes');
}
