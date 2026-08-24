import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AutoRetryService } from './auto-retry.service';
import type { SessionsService } from './sessions.service';

const NOW = new Date('2026-08-03T16:25:00Z');
const PAST = new Date('2026-08-03T16:20:00Z');
const FUTURE = '2026-08-03T21:20:00Z';

/** A runner snapshot whose 5-hour window is spent — the shape planUsageBlockedUntil reads. */
const stillBlocked = {
  provider: 'claude',
  fiveHour: { utilization: 100, resetsAt: FUTURE },
};

type SessionRow = Record<string, unknown>;

function makeService(
  rows: SessionRow[],
  opts: {
    resume?: () => Promise<unknown>;
    events?: Array<{ type: string; payload: unknown; turnId?: string }>;
    /**
     * §13.1 AG6: the task ids the owner-scoped EXISTS would return for this batch. Modelled as the
     * ANSWER rather than as child rows, because the whole point of that query is that the predicate
     * lives in SQL — a fixture that re-derived it here would be asserting against its own copy.
     */
    aggregateParentIds?: string[];
    /** Runs AFTER the sweep's due read and BEFORE anything it writes: the race, expressed once. */
    afterRead?: () => void;
    /** What the locked settle raises instead of running — the lock-contention shapes. */
    settleThrows?: unknown;
    /**
     * Whether the task is STILL an owner-scoped aggregate parent at the moment the conditional
     * settle runs — which is a different question from what the batch snapshot said, and the
     * difference is the whole point of that write being conditional. Defaults to agreeing with
     * `aggregateParentIds`; set it to false to model the release directions (policy back to MANUAL,
     * the last same-owner child deleted) landing in between.
     */
    aggregateAtSettle?: boolean;
    /**
     * The row's role as the LOCKED re-read sees it, when that differs from what the due snapshot
     * carried — i.e. a demotion to a salvage conversation committing in between.
     */
    startsTaskWorkAtSettle?: boolean;
    /**
     * The session's attachment rows, in the state the failure left them: each one stamped with
     * the turn it was sent on. The retry copies these, so a fake that only counted them could
     * not see the thing this exists for — which bytes reached the new turn.
     */
    attachments?: Array<Record<string, unknown>>;
    /** The id of the seeded first turn, when the fixture has one (the prompt's own uploads). */
    seedTurnId?: string;
    /** What the commit-race branch re-reads for this session AFTER a refused resume. */
    raceReadRow?: {
      terminalReason: string | null; supersededByTaskId: string | null;
      subjectTerminalReason: string | null; subjectSupersededByTaskId: string | null;
      completionPolicy: string; hasDirectChildren: boolean; startsTaskWork: boolean;
    };
  } = {},
) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const resumed: Array<{ id: string; content: string }> = [];
  // Kept apart from `resumed` so every assertion above stays a statement about the message.
  const resumedAttachments: string[][] = [];
  const attachments = (opts.attachments ?? []).map((a) => ({ ...a }));
  let copied = 0;
  const prisma = {
    // The only raw query this service makes is §13.1 AG6's batch EXISTS.
    // §13.1 AG6's settles run inside a transaction that locks the task first, so the fake models
    // the same two steps: what the LOCKED re-read of the task says, and then the conditional write.
    // `aggregateAtSettle` is what that re-read answers — set it to false to model a release
    // direction committing between the batch snapshot and the lock.
    // §13.1 AG6's settles run inside a transaction that walks project -> task -> session, locking
    // each with NOWAIT and re-reading everything the compare-and-set depends on. The fake models
    // that walk: `aggregateAtSettle` is what the LOCKED task read answers (set it to false to model
    // a release direction committing in between), and the session read answers from the live row,
    // so a demotion or a re-arm applied to the fixture is seen exactly where production would.
    $transaction: async (
      run: (tx: {
        $queryRaw: (q: unknown, ...v: unknown[]) => Promise<unknown[]>;
        $executeRaw: (q: unknown, ...v: unknown[]) => Promise<number>;
      }) => Promise<number>,
    ) => {
      if (opts.settleThrows) throw opts.settleThrows;
      return run({
      $queryRaw: async (query: unknown) => {
        const text = String((query as { text?: string }).text ?? '');
        if (text.includes('FROM "project"')) return [{}];
        if (text.includes('FROM "session"')) {
          const row = rows.find((r) => r.taskId != null);
          return row ? [{
            taskId: row.taskId,
            startsTaskWork: opts.startsTaskWorkAtSettle ?? row.startsTaskWork,
            status: row.status, retryAt: row.retryAt, retryAttempts: row.retryAttempts,
          }] : [];
        }
        const target = rows.find((r) => r.taskId != null);
        const stillAggregate = opts.aggregateAtSettle
          ?? (target?.taskId != null
            && (opts.aggregateParentIds ?? []).includes(target.taskId as string));
        // The scope read and the locked task read are the same shape here; `project_id` is null in
        // these fixtures, so the two agree by construction.
        return [{ projectId: null, aggregate: stillAggregate }];
      },
      $executeRaw: async (query: unknown) => {
        // `Prisma.sql` carries its own bindings on the object; a tagged-template call passes ONE
        // argument, so reading rest-args here silently sees nothing and every write becomes a no-op.
        const sql = query as { text?: string; values?: unknown[] };
        const text = String(sql.text ?? '');
        const bound = sql.values ?? [];
        const row = rows.find((r) => r.id === bound[bound.length - 1]);
        if (!row) return 0;
        if (text.includes('"retry_at" = NULL')) row.retryAt = null;
        else row.retryAttempts = bound[0] as number;
        return 1;
      },
      });
    },
    $queryRaw: async (query: unknown) => {
      // Two raw queries: §13.1 AG6's batch EXISTS over the due set, and the per-session re-read the
      // commit-race branch makes after a refused resume. Told apart by what they select.
      const text = String((query as { text?: string }).text ?? '');
      if (text.includes('subjectSupersededByTaskId')) return opts.raceReadRow ? [opts.raceReadRow] : [];
      return (opts.aggregateParentIds ?? []).map((id) => ({ id }));
    },
    session: {
      // Honour the selection predicate rather than returning everything: the regression this
      // service shipped was a `where` that matched none of the sessions it exists for, and a
      // fake that ignores `where` cannot see that. Only the status/cancel branches are
      // evaluated — `retryAt` deliberately is not, so a fixture can model a row that was armed
      // when the query ran and lost the claim before this sweep reached it.
      // A SNAPSHOT, not the live objects. The sweep decides from what it read here and writes
      // later; handing it the mutable rows would make every "somebody changed it in between" test
      // impossible to express, because the change would be visible to the read that preceded it.
      findMany: async (args: { where: { OR?: Array<Record<string, unknown>> } }) => {
        const snapshot = rows
          .filter((r) =>
            (args.where.OR ?? []).some((cond) =>
              Object.entries(cond).every(([k, v]) => (r[k] ?? null) === v),
            ),
          )
          .map((r) => ({ ...r }));
        // The race lands here: after the sweep has read, before it has written anything.
        opts.afterRead?.();
        return snapshot;
      },

      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        // Honour the guards the service relies on: `retryAt: { not: null }` is the claim (a
        // fixture with retryAt null models a user message that already won it), and `status`
        // is the "nobody has taken over" gate the backoff path uses.
        const row = rows.find((r) => r.id === args.where.id);
        // Every field the service names is honoured, not just the two this fake used to look at.
        // A fake that ignored `retryAt`'s exact instant, the attempt count or the task/role could
        // not see the bug those clauses exist for: a claim landing on a row somebody re-armed,
        // re-pointed or demoted in between.
        const where = args.where as {
          status?: string; retryAt?: { not: null } | Date | null;
          retryAttempts?: number; taskId?: string | null; startsTaskWork?: boolean;
        };
        const retryAtMatches = () => {
          if (where.retryAt === undefined) return true;
          if (where.retryAt === null) return row!.retryAt == null;
          if (where.retryAt instanceof Date) {
            return row!.retryAt instanceof Date
              && (row!.retryAt as Date).getTime() === where.retryAt.getTime();
          }
          return row!.retryAt != null;   // the `{ not: null }` spelling
        };
        const hit =
          !!row &&
          retryAtMatches() &&
          (where.status === undefined || where.status === row.status) &&
          (where.retryAttempts === undefined || where.retryAttempts === row.retryAttempts) &&
          (where.taskId === undefined || where.taskId === (row.taskId ?? null)) &&
          (where.startsTaskWork === undefined || where.startsTaskWork === row.startsTaskWork);
        if (hit) Object.assign(row as object, args.data);
        return { count: hit ? 1 : 0 };
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args as never);
        const target = rows.find((r) => r.id === args.where.id);
        if (target) Object.assign(target, args.data);
        return {};
      },
    },
    runEvent: {
      // Honour `where.type` and `take`: what stranded these sessions was reading a fixed
      // window of the stream's end, which on a long turn holds no user event at all. A fake
      // that hands back the user events regardless of what was asked for cannot see that.
      findMany: async (args: { where: { type?: string }; take: number }) => {
        const all = opts.events ?? [{ type: 'user', payload: { text: 'the original message' } }];
        const matching = args.where.type ? all.filter((e) => e.type === args.where.type) : all;
        return matching.slice(-args.take).reverse();
      },
    },
    conversationTurn: {
      findUnique: async () => (opts.seedTurnId ? { id: opts.seedTurnId } : null),
    },
    attachment: {
      // The turn scope is the whole question — "which images went with THIS message" — so the
      // fake answers it rather than handing back everything the session ever carried.
      findMany: async (args: { where: { sessionId: string; turnId: string } }) =>
        attachments.filter(
          (a) => a.sessionId === args.where.sessionId && a.turnId === args.where.turnId,
        ),
      create: async (args: { data: Record<string, unknown> }) => {
        const copy = { id: `copy-${++copied}`, turnId: null, ...args.data };
        attachments.push(copy);
        return { id: copy.id };
      },
      deleteMany: async (args: { where: { id: { in: string[] }; turnId: null } }) => {
        const doomed = attachments.filter(
          (a) => args.where.id.in.includes(a.id as string) && a.turnId == null,
        );
        for (const d of doomed) attachments.splice(attachments.indexOf(d), 1);
        return { count: doomed.length };
      },
    },
  };
  const sessions = {
    resume: async (
      _owner: string,
      id: string,
      dto: { content: string; attachmentIds?: string[] },
    ) => {
      if (opts.resume) await opts.resume();
      resumed.push({ id, content: dto.content });
      resumedAttachments.push(dto.attachmentIds ?? []);
      // What resume() does with them, so the copies a failed re-send must clean up are
      // distinguishable from the ones that became a turn's images.
      for (const attId of dto.attachmentIds ?? []) {
        const copy = attachments.find((a) => a.id === attId);
        if (copy) copy.turnId = 'turn-retry';
      }
      return { turnId: 't', seq: 1 };
    },
  } as unknown as SessionsService;
  // What the service told the world. A `final` STATUS carrying no `retryAt` is the settlement
  // signal — RealtimeService turns exactly that into the owner's push — so `settled` is derived
  // from the published events rather than from a second fake, which is what keeps this test
  // honest about the one rule both halves share.
  const published: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const realtime = {
    publish: (id: string, event: { payload: Record<string, unknown> }) => {
      published.push({ id, payload: event.payload });
    },
    publishSessionUpdated: (id: string) => {
      published.push({ id, payload: {} });
    },
  };
  const settled = () =>
    published.filter((p) => p.payload.final && !p.payload.retryAt).map((p) => p.id);
  const service = new AutoRetryService(prisma as never, sessions, realtime as never);
  return { service, updates, resumed, resumedAttachments, attachments, rows, published, settled };
}

function row(over: SessionRow = {}): SessionRow {
  return {
    id: 'session-1',
    ownerId: 'owner-1',
    provider: 'claude',
    prompt: 'opening prompt',
    numTurns: 3,
    retryAt: PAST,
    retryAttempts: 0,
    assignedRunnerId: 'runner-1',
    // A started session on a runner that is currently answering heartbeats — the shape
    // deriveSessionCapabilities needs to reach its runner-liveness branch at all. Left
    // incomplete these rows stop at NOT_STARTED, which silently skips that branch and
    // would let the runner-offline deferral pass every test without ever running.
    startedAt: PAST,
    runtimeSessionId: 'runtime-1',
    finishedAt: null,
    endReason: null,
    completedAt: null,
    deletedAt: null,
    cancelRequestedAt: null,
    assignedRunner: { planUsage: null, status: 'ONLINE', lastHeartbeatAt: NOW },
    status: RunStatus.AWAITING_INPUT,
    ...over,
  };
}

/** The same runner, three missed heartbeats ago — what a restart or a drain looks like. */
const offlineRunner = { planUsage: null, status: 'ONLINE', lastHeartbeatAt: PAST };

test('re-sends the last user message once the quota is back', async () => {
  const { service, resumed } = makeService([row()]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
});

// Either failure can settle the run FAILED with cancelRequestedAt set — turn-complete reclaims
// the runner slot that way — so this, not AWAITING_INPUT, is the state most armed retries are
// actually sitting in. A sweep that also demands cancelRequestedAt: null finds none of them.
test('retries a session the failure settled FAILED', async () => {
  const { service, resumed } = makeService([
    row({ status: RunStatus.FAILED, cancelRequestedAt: PAST }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
});

test('backs off a FAILED session instead of stranding it', async () => {
  const { service, rows } = makeService([row({ status: RunStatus.FAILED, cancelRequestedAt: PAST })], {
    resume: async () => {
      throw new Error('runner offline');
    },
  });
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 1);
  assert.deepEqual(
    rows[0].retryAt,
    new Date(NOW.getTime() + 2 * 60_000),
    're-armed under the status it was parked in, not one it can never satisfy',
  );
});

test('skips an idle session that is being torn down', async () => {
  const { service, resumed } = makeService([row({ cancelRequestedAt: PAST })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'its owner asked for it to end; do not start a turn behind that');
});

test('leaves a live session alone', async () => {
  const { service, resumed } = makeService([row({ status: RunStatus.RUNNING })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'it is already working; nothing is waiting on us');
});

test('defers without spending an attempt while the snapshot still reports the quota spent', async () => {
  const { service, resumed, rows } = makeService([
    row({ assignedRunner: { planUsage: stillBlocked } }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'must not burn a turn against a quota known to be spent');
  assert.equal(rows[0].retryAttempts, 0, 'a deferral is not a failed attempt');
  assert.deepEqual(rows[0].retryAt, new Date(FUTURE), 're-armed for the reported reset');
});

// The reaper arms these: it finalized the session as 'runner offline' mid-turn. Waiting for
// that runner is the whole retry, so it must not look like the five-strikes dispatch backoff —
// a runner that takes four minutes to come back would otherwise exhaust the attempts and hand
// the session to the user having never once tried it.
test('waits for an offline runner without spending an attempt', async () => {
  const { service, resumed, rows } = makeService([
    row({ status: RunStatus.FAILED, cancelRequestedAt: PAST, assignedRunner: offlineRunner }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'resume() would only refuse it as RUNNER_OFFLINE');
  assert.equal(rows[0].retryAttempts, 0, 'still rebooting is not a failed attempt');
  assert.deepEqual(
    rows[0].retryAt,
    new Date(NOW.getTime() + 30_000),
    're-armed for the next sweep, which is what makes this a wait rather than a backoff',
  );
});

test('re-sends as soon as the runner is answering heartbeats again', async () => {
  const { service, resumed } = makeService([
    row({ status: RunStatus.FAILED, cancelRequestedAt: PAST, finishedAt: PAST }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(
    resumed,
    [{ id: 'session-1', content: 'the original message' }],
    'the runner came back, so the turn it killed goes out again on its own',
  );
});

test('gives up on a runner that never comes back', async () => {
  const { service, resumed, rows } = makeService([
    row({
      status: RunStatus.FAILED,
      cancelRequestedAt: PAST,
      assignedRunner: offlineRunner,
      finishedAt: new Date('2026-08-03T15:50:00Z'),
    }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, []);
  assert.equal(rows[0].retryAt, null, 'a machine down this long is not coming back on its own');
});

test('releases one session per (runner, provider) per sweep', async () => {
  const { service, resumed } = makeService([
    row({ id: 'a' }),
    row({ id: 'b' }),
    row({ id: 'c', assignedRunnerId: 'runner-2' }),
    row({ id: 'd', provider: 'codex' }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(
    resumed.map((r) => r.id).sort(),
    ['a', 'c', 'd'],
    'b shares a provider with a and waits for the next sweep',
  );
});

test('hands back to the user once the attempts are spent', async () => {
  const { service, resumed, rows, published, settled } = makeService([
    row({ status: RunStatus.FAILED, retryAttempts: 5 }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, []);
  assert.equal(rows[0].retryAt, null, 'disarmed');
  // Giving up moves no status, so this is the only moment the failure becomes the outcome —
  // the clients stop drawing "Retrying" and the owner is told, both off this one event.
  assert.deepEqual(published, [
    { id: 'session-1', payload: { status: RunStatus.FAILED, final: true } },
  ]);
  assert.deepEqual(settled(), ['session-1']);
});

test('a quota-parked session that gives up announces no failure', async () => {
  // AWAITING_INPUT is a session that idled, not one that failed: there is no outcome to settle
  // and nothing terminal to declare, only a card that lost its countdown.
  const { service, rows, published, settled } = makeService([
    row({ status: RunStatus.AWAITING_INPUT, retryAttempts: 5 }),
  ]);
  await service.sweep(NOW);
  assert.equal(rows[0].retryAt, null, 'disarmed');
  assert.deepEqual(published, [{ id: 'session-1', payload: {} }], 'a plain list refresh');
  assert.deepEqual(settled(), []);
});

test('spends an attempt on every dispatch, so a repeating failure runs out', async () => {
  // The count is reset only by a reply that is no longer one of these failures (on ingestion).
  // Refunding it here would restart the backoff after every retry and loop forever.
  const { service, rows } = makeService([row({ retryAttempts: 2 })]);
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 3);
});

test('backs off and stays armed when the resume itself fails', async () => {
  const { service, rows } = makeService([row()], {
    resume: async () => {
      throw new Error('runner offline');
    },
  });
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 1);
  assert.deepEqual(
    rows[0].retryAt,
    new Date(NOW.getTime() + 2 * 60_000),
    'first backoff step, measured from the sweep',
  );
});

test('does not re-send when there is nothing to re-send', async () => {
  const { service, resumed, rows } = makeService([row({ numTurns: 3 })], { events: [] });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'inventing a "continue" would be writing in the user’s voice');
  assert.equal(rows[0].retryAt, null);
});

// The message a retry re-sends sits behind everything the workspace did in response to it. Two
// real sessions were disarmed as "nothing to re-send" at the moment their quota came back,
// with the user's message 400+ events up the stream — while the transcript card, which reads
// the whole stream, went on offering to re-send exactly that message.
test('finds the user message behind a long turn', async () => {
  const buried = [
    { type: 'user' as const, payload: { text: 'the original message' } },
    ...Array.from({ length: 500 }, () => ({ type: 'tool_use' as const, payload: { name: 'Bash' } })),
    { type: 'assistant' as const, payload: { text: "You've hit your session limit" } },
  ];
  const { service, resumed } = makeService([row()], { events: buried });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
});

test('falls back to the opening prompt when the very first turn hit the limit', async () => {
  const { service, resumed } = makeService([row({ numTurns: 0 })], { events: [] });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'opening prompt' }]);
});

/** One image as the killed turn left it: stamped with the turn it was sent on. */
function image(over: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turnId: 'turn-9',
    mimeType: 'image/png',
    sizeBytes: 3,
    fileName: 'shot.png',
    data: Uint8Array.from([1, 2, 3]),
    createdAt: PAST,
    ...over,
  };
}

// The retry re-sent the words alone, so the agent answered about a screenshot it had never been
// shown — and the transcript showed a second bubble of the same sentence with the picture gone.
test('re-sends the images that went with the message', async () => {
  const { service, resumed, resumedAttachments, attachments } = makeService([row()], {
    events: [{ type: 'user', payload: { text: 'the original message' }, turnId: 'turn-9' }],
    attachments: [image()],
  });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
  assert.deepEqual(resumedAttachments, [['copy-1']]);
  const copy = attachments.find((a) => a.id === 'copy-1')!;
  assert.deepEqual(copy.data, Uint8Array.from([1, 2, 3]), 'the bytes, not a reference to a row');
  assert.equal(copy.fileName, 'shot.png');
  assert.equal(copy.sessionId, 'session-1');
  assert.equal(
    attachments.find((a) => a.id === 'att-1')!.turnId,
    'turn-9',
    'a copy, never a re-point: the attempt that failed keeps the image in its own bubble',
  );
});

// A message is text AND what was sent with it. An image-only turn carries no text, so the words
// come from further back — and taking the newest turn's images would re-send a pairing the
// person never wrote.
test('takes the images from the turn its text came from', async () => {
  const { service, resumedAttachments, attachments } = makeService([row()], {
    events: [
      { type: 'user', payload: { text: 'the original message' }, turnId: 'turn-8' },
      { type: 'user', payload: { text: '' }, turnId: 'turn-9' },
    ],
    attachments: [
      image({ id: 'att-8', turnId: 'turn-8', fileName: 'asked-about.png' }),
      image({ id: 'att-9', turnId: 'turn-9', fileName: 'sent-later.png' }),
    ],
  });
  await service.sweep(NOW);
  const sent = resumedAttachments[0].map(
    (id) => attachments.find((a) => a.id === id)!.fileName,
  );
  assert.deepEqual(sent, ['asked-about.png']);
});

test('leaves no copies behind when the re-send fails', async () => {
  const { service, attachments, rows } = makeService([row()], {
    events: [{ type: 'user', payload: { text: 'the original message' }, turnId: 'turn-9' }],
    attachments: [image()],
    resume: async () => {
      throw new Error('runner offline');
    },
  });
  await service.sweep(NOW);
  assert.deepEqual(
    attachments.map((a) => a.id),
    ['att-1'],
    'nothing was re-sent, so the copies made for it are bytes with no bubble',
  );
  assert.equal(rows[0].retryAttempts, 1, 'and the dispatch failure still backs off as it did');
});

// The 0-turn case: the quota or the outage answered the very first message, which the runner
// never got far enough to announce as a user event. Its uploads are the compose page's, parked
// on the seeded first turn — the prompt goes back out with them or the retry re-asks a question
// about nothing.
test('carries the opening prompt uploads on a first-run retry', async () => {
  const { service, resumed, resumedAttachments, attachments } = makeService(
    [row({ numTurns: 0 })],
    {
      events: [],
      seedTurnId: 'turn-seed',
      attachments: [image({ id: 'att-seed', turnId: 'turn-seed' })],
    },
  );
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'opening prompt' }]);
  assert.deepEqual(resumedAttachments, [['copy-1']]);
  assert.equal(attachments.find((a) => a.id === 'copy-1')!.fileName, 'shot.png');
});

test('loses the claim to a user message that lands first', async () => {
  const { service, resumed } = makeService([row({ retryAt: null })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'the user took over; a second turn must not appear behind them');
});

test('§13.1 AG6: a retry whose task became an aggregate parent stands down permanently', async () => {
  // The liveness half. Without this the sweep re-arms, backs off and re-arms until the whole retry
  // budget is gone — every attempt spent on a refusal that cannot lift, and none of them on the
  // RUN. The task's completion belongs to its subtasks now, so no amount of waiting changes it.
  const { service, resumed, rows } = makeService([
    row({
      status: RunStatus.FAILED,
      taskId: 'task-1',
      startsTaskWork: true,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    }),
  ], { aggregateParentIds: ['task-1'] });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'nothing is resumed');
  assert.equal(rows[0].retryAt, null, 'and it is DISARMED, not re-armed for another sweep');
  assert.equal(rows[0].retryAttempts, 0,
    'no attempt is spent: this retry never happened, so the budget is untouched');
});

test('§13.1 AG6: the compatibility boundaries still retry normally', async () => {
  // The owner-scoped EXISTS answers for the whole batch, so "not an aggregate parent" is simply
  // absence from its result — which is what a childless non-MANUAL task, a MANUAL parent and a
  // parent whose only child belongs to somebody else all produce.
  for (const name of ['childless non-MANUAL', 'MANUAL parent with children', 'cross-owner child']) {
    const { service, resumed } = makeService(
      [row({
        status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true,
        task: { terminalReason: null, supersededByTaskId: null, verifies: null },
      })],
      { aggregateParentIds: [] },
    );
    await service.sweep(NOW);
    assert.equal(resumed.length, 1, `${name} must still be retried`);
  }
});

test('§13.1 AG6: a NON-work session on an aggregate parent retries normally', async () => {
  // The negative control that matters. A salvage or conversation session hanging off a roll-up
  // node is a legitimate run — it is not doing the task's work, so the role invariant says nothing
  // about it, and standing it down would remove a way OUT of a stuck subtree rather than a way in.
  const { service, resumed, rows } = makeService(
    [row({
      status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: false,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    })],
    { aggregateParentIds: ['task-1'] },
  );
  await service.sweep(NOW);
  assert.equal(resumed.length, 1, 'it is resumed like any other retry');
  // A successful retry clears `retryAt` (the claim) and SPENDS an attempt. A stand-down clears it
  // and spends nothing — so the attempt counter, not the countdown, is what tells the two apart.
  assert.equal(rows[0].retryAttempts, 1, 'a real attempt was spent, not a permanent stand-down');
});

test('§13.1 AG6 commit race: the stand-down is decided by the CURRENT row, not the snapshot', async () => {
  // The session was the task's work when the sweep selected it, and has since been demoted to a
  // salvage conversation. The resume then fails for an unrelated, transient reason. Deciding on the
  // stale `true` would disarm a legitimate session for ever over a blip; the re-read is what keeps
  // that a normal backoff.
  const { service, rows } = makeService(
    [row({
      status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    })],
    {
      aggregateParentIds: [],
      resume: () => Promise.reject(new Error('runner went away mid-resume')),
      raceReadRow: {
        terminalReason: null, supersededByTaskId: null,
        subjectTerminalReason: null, subjectSupersededByTaskId: null,
        completionPolicy: 'ALL_CHILDREN_DONE', hasDirectChildren: true,
        startsTaskWork: false,
      },
    },
  );
  await service.sweep(NOW);
  assert.notEqual(rows[0].retryAt, null,
    'a transient failure on a non-work session is re-armed, not permanently disarmed');
});

test('§13.1 AG6: a shape released between the snapshot and the settle leaves the retry alone', async () => {
  // The TOCTOU negative control. The batch read said "aggregate parent", and before the disarm
  // lands somebody takes a release direction — policy back to MANUAL, or the last same-owner child
  // deleted. Clearing `retry_at` on that stale reading would destroy a retry that is legal again,
  // permanently and with no attempt spent. The condition lives in the WHERE clause precisely so
  // this case writes nothing.
  const { service, rows } = makeService(
    [row({
      status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    })],
    { aggregateParentIds: ['task-1'], aggregateAtSettle: false },
  );
  await service.sweep(NOW);
  // Left exactly as it was found. The batch hint said "aggregate parent" and the locked settle
  // disagreed, so this sweep knows only that its own reading is out of date — it does not get to
  // convert that into a claim. The next sweep is at most one interval away and reads afresh.
  assert.notEqual(rows[0].retryAt, null, 'still armed, on the same instant');
  assert.equal(rows[0].retryAttempts, 0, 'and no attempt was spent on a decision it did not make');
});

test('§13.1 AG6: a session demoted to non-work between snapshot and settle is not disarmed', async () => {
  // The same window, on the row's own role rather than the task's shape: the sweep selected a
  // work session, and by the time the settle holds its locks the row is a salvage conversation.
  const { service, rows } = makeService(
    [row({
      status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    })],
    { aggregateParentIds: ['task-1'], startsTaskWorkAtSettle: false },
  );
  await service.sweep(NOW);
  assert.notEqual(rows[0].retryAt, null,
    'the locked re-read sees the demotion, so nothing is disarmed and nothing is claimed');
  assert.equal(rows[0].retryAttempts, 0, 'and no attempt is spent');
});

test('a retry re-armed to a NEW instant is not stolen by the sweep that saw the old one', async () => {
  // cancel + re-arm. The sweep read an arm that has since been replaced; claiming on
  // `retryAt: { not: null }` would take the countdown somebody just set and spend an attempt on it.
  const session = row({ status: RunStatus.FAILED });
  const replacement = new Date('2026-08-03T18:00:00Z');
  const { service, resumed } = makeService([session], {
    // Genuinely after the read: the sweep decided from the arm it saw, and this replaces it before
    // the claim runs. Mutating the row before `sweep` would only change what the read itself saw.
    afterRead: () => { session.retryAt = replacement; },
  });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'the claim finds no row and nothing is resumed');
  assert.equal((session.retryAt as Date).getTime(), replacement.getTime(),
    'and the arm somebody set is exactly as they left it');
  assert.equal(session.retryAttempts, 0, 'with no attempt spent against it');
});

test('a failure backoff does not land on a row that was re-armed after the claim', async () => {
  // The other half: the claim succeeded, the resume failed, and between the two somebody armed the
  // row to a new time. The backoff must not overwrite that with its own.
  const session = row({ status: RunStatus.FAILED });
  const armed = new Date('2026-08-03T19:00:00Z');
  const { service } = makeService([session], {
    resume: async () => {
      session.retryAt = armed;         // lands between the claim and the failure
      session.retryAttempts = 0;
      throw new Error('runner went away');
    },
  });
  await service.sweep(NOW);
  assert.equal((session.retryAt as Date).getTime(), armed.getTime(),
    'the newer arm survives the backoff that was computed for the older one');
});

test('a session re-pointed at another task after the read is not claimed by this sweep', async () => {
  const session = row({ status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true });
  const { service, resumed } = makeService([session], {
    afterRead: () => { session.taskId = 'task-2'; },
  });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'the claim asserts the task it decided about');
  assert.notEqual(session.retryAt, null, 'and the arm is left where it was');
});

test('a session demoted to a salvage conversation after the read is not claimed either', async () => {
  const session = row({ status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true });
  const { service, resumed } = makeService([session], {
    afterRead: () => { session.startsTaskWork = false; },
  });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'the claim asserts the role it decided about');
  assert.notEqual(session.retryAt, null);
});

test('a session whose attempt count moved after the read is not claimed', async () => {
  const session = row({ status: RunStatus.FAILED, retryAttempts: 0 });
  const { service, resumed } = makeService([session], {
    afterRead: () => { session.retryAttempts = 2; },
  });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'somebody else advanced the generation; this sweep stands down');
});

test('§13.1 AG6: the lock refusal is recognised through the Prisma wrapper, not just the driver', async () => {
  // `pg` raises `code = '55P03'`; Prisma wraps the same failure as `P2010` and carries the driver's
  // SQLSTATE in `meta.code`. A predicate that knew only one shape would work in exactly one of
  // production and this spec — see `isLockNotAvailable`.
  for (const [name, error] of [
    ['driver', Object.assign(new Error('lock'), { code: '55P03' })],
    ['prisma wrapper', Object.assign(new Error('raw query failed'), {
      code: 'P2010', meta: { code: '55P03' },
    })],
    ['serialization', Object.assign(new Error('conflict'), { code: 'P2010', meta: { code: '40001' } })],
    ['deadlock', Object.assign(new Error('deadlock'), { code: 'P2010', meta: { code: '40P01' } })],
  ] as const) {
    const session = row({
      status: RunStatus.FAILED, taskId: 'task-1', startsTaskWork: true,
      task: { terminalReason: null, supersededByTaskId: null, verifies: null },
    });
    const { service, resumed } = makeService([session], {
      aggregateParentIds: ['task-1'],
      settleThrows: error,
    });
    await service.sweep(NOW);
    assert.deepEqual(resumed, [], `${name}: BUSY leaves the row alone rather than claiming it`);
    assert.notEqual(session.retryAt, null, `${name}: still armed`);
    assert.equal(session.retryAttempts, 0, `${name}: and nothing spent`);
  }
});
