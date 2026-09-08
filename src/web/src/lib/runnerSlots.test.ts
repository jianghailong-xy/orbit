import { describe, expect, it } from 'vitest';
import {
  QUEUED_NOTICE_DELAY_MS,
  COMPACTING_TITLE,
  STARTING_DESCRIPTION,
  STARTING_NOTICE_DELAY_MS,
  STARTING_TITLE,
  activeSlotCount,
  pendingSlotDescription,
  queuedLabel,
  queuedNoticeVisible,
  queuedTitle,
  runnerSlotUsage,
  startingDescription,
  startingLabel,
  startingTitle,
  waitElapsedLabel,
} from './runnerSlots';

const sessions = (status: string, count: number) =>
  Array.from({ length: count }, () => ({ status }));

it('keeps transient queue and startup notices quiet for ten seconds', () => {
  expect(QUEUED_NOTICE_DELAY_MS).toBe(10_000);
  expect(STARTING_NOTICE_DELAY_MS).toBe(10_000);
});

describe('runner slot accounting', () => {
  it('does not count awaiting-input sessions, whether they are warm or cold', () => {
    const awaiting = Array.from({ length: 32 }, (_, index) => ({
      status: 'AWAITING_INPUT',
      runtimeState: index % 2 === 0 ? 'warm' : 'cold',
    }));

    expect(activeSlotCount(awaiting)).toBe(0);
    expect(runnerSlotUsage(awaiting, 32)).toEqual({ active: 0, atCapacity: false });
  });

  it('keeps the 31/32 and 32/32 running boundaries exact', () => {
    expect(runnerSlotUsage(sessions('RUNNING', 31), 32)).toEqual({
      active: 31,
      atCapacity: false,
    });
    expect(runnerSlotUsage(sessions('RUNNING', 32), 32)).toEqual({
      active: 32,
      atCapacity: true,
    });
  });

  it('only counts RUNNING in a mixed session list', () => {
    const mixed = [
      ...sessions('RUNNING', 2),
      ...sessions('AWAITING_INPUT', 32),
      ...sessions('PENDING', 4),
      ...sessions('INTERRUPTED', 1),
    ];

    expect(runnerSlotUsage(mixed, 3)).toEqual({ active: 2, atCapacity: false });
  });

  it('prefers runStatus while retaining the legacy status alias', () => {
    const mixed = [
      { runStatus: 'RUNNING', status: 'AWAITING_INPUT' },
      { runStatus: 'AWAITING_INPUT', status: 'RUNNING' },
      { runStatus: 'running' },
      { status: 'RUNNING' },
    ];

    expect(activeSlotCount(mixed)).toBe(3);
  });
});

describe('why a queued session has not started', () => {
  // The case the whole thing exists for: the machine has room, the run does not. Reading the
  // runner's own numbers here would say "plenty of slots" and explain nothing.
  it('blames the run, not the machine, when the tree is what is full', () => {
    expect(
      pendingSlotDescription(3, 16, {
        queuedReason: 'tree_at_capacity',
        queuedActive: 3,
        queuedLimit: 3,
      }),
    ).toBe(
      'This run is already using all its slots (3/3). The next sub-session starts as one finishes.',
    );
  });

  it('names the batch when a batch run is what is full', () => {
    expect(
      pendingSlotDescription(1, 16, {
        queuedReason: 'batch_at_capacity',
        queuedActive: 5,
        queuedLimit: 5,
      }),
    ).toBe('This batch is running its maximum (5/5). This session starts as soon as a slot frees up.');
  });

  it('uses the numbers the server judged on, not the ones this page can see', () => {
    // The list holds one workspace's page; the runner-wide count it can derive is not the count
    // the claim actually compared against.
    expect(
      pendingSlotDescription(2, 16, {
        queuedReason: 'runner_at_capacity',
        queuedActive: 16,
        queuedLimit: 16,
      }),
    ).toBe('Runner at capacity (16/16). This session starts as soon as a slot frees up.');
  });

  // The case this deployment is almost always in, and the one the old copy got wrong: the
  // server checked every gate and found none, so nothing is contended and nothing about
  // capacity is worth reporting. It is simply not picked up yet.
  it('does not blame capacity when the server found no gate at all', () => {
    expect(pendingSlotDescription(1, 16, { queuedReason: null })).toBe(
      'Waiting for the runner to pick it up.',
    );
  });

  it('names an offline runner, which no count can explain', () => {
    expect(pendingSlotDescription(0, 16, { queuedReason: 'runner_offline' })).toBe(
      'The assigned runner is offline. This session starts when it comes back.',
    );
  });

  it('names the git operation fencing the checkout', () => {
    expect(pendingSlotDescription(0, 16, { queuedReason: 'worktree_op_pending' })).toBe(
      'A merge or commit is finishing on this session\u2019s checkout. It starts as soon as that settles.',
    );
  });

  // A null and an absent value are different claims and must not collapse into one another:
  // one is "no gate", the other is "nobody asked". Only the first may be reported as a plain
  // queue — reporting the second that way would state, on an old server, something it never said.
  it('keeps null and undefined apart', () => {
    expect(queuedTitle({ queuedReason: null })).toBe('Queued');
    expect(queuedTitle(undefined)).toBe('Waiting for a free slot');
    expect(queuedTitle(null)).toBe('Waiting for a free slot');
    expect(queuedLabel({ queuedReason: null })).toBe('Queued');
    expect(queuedLabel(undefined)).toBe('Waiting for slot');
  });

  it('keeps slot wording only for the gates that really are slots', () => {
    expect(queuedTitle({ queuedReason: 'runner_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'tree_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'batch_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'runner_offline' })).toBe('Runner offline');
    expect(queuedTitle({ queuedReason: 'worktree_op_pending' })).toBe(
      'Waiting for a git operation',
    );
  });

  // A server that predates the field sends nothing; the old runner-capacity reading stands in.
  it('falls back to the local reading for an older payload', () => {
    expect(pendingSlotDescription(16, 16, null)).toBe(
      'Runner at capacity (16/16). This session starts as soon as a slot frees up.',
    );
    expect(pendingSlotDescription(3, 16, undefined)).toBe(
      'This session starts as soon as a slot frees up.',
    );
  });
});

describe('when the transcript explains a queued session', () => {
  it('waits before painting an ordinary or not-yet-resolved queue', () => {
    expect(queuedNoticeVisible({ queuedReason: null }, false)).toBe(false);
    expect(queuedNoticeVisible(undefined, false)).toBe(false);
    expect(queuedNoticeVisible({}, false)).toBe(false);

    expect(queuedNoticeVisible({ queuedReason: null }, true)).toBe(true);
    expect(queuedNoticeVisible(undefined, true)).toBe(true);
  });

  it('shows every explicit gate immediately', () => {
    for (const queuedReason of [
      'runner_offline',
      'runner_at_capacity',
      'tree_at_capacity',
      'batch_at_capacity',
      'worktree_op_pending',
      'a_future_gate',
    ]) {
      expect(queuedNoticeVisible({ queuedReason }, false), queuedReason).toBe(true);
    }
  });
});

describe('what the starting notice is allowed to claim', () => {
  const copy = () => `${STARTING_TITLE} ${STARTING_DESCRIPTION}`.toLowerCase();

  // sessionIsStarting is `engineStartedAt === null` — an absence, and every claim clears the
  // column. The same absence therefore covers a cold checkout, a warm process that is merely
  // between turns, and an engine compacting a conversation that no longer fits before it can
  // read the message. Whichever cause the copy names is a guess that is wrong in the two it
  // did not name; the wording this replaced named three of them at once.
  it('names no cause, because the state it labels is an absence', () => {
    for (const cause of ['checkout', 'workspace up', 'tools', 'compact', 'install', 'clon'])
      expect(copy()).not.toContain(cause);
  });

  // Paired with the clause above, which silence would also satisfy: '' names no cause either.
  // These are the three things that ARE known from a null engineStartedAt.
  it('still says who holds it, what has not happened, and that it may not be quick', () => {
    expect(STARTING_DESCRIPTION).toMatch(/runner has this session/i);
    expect(STARTING_DESCRIPTION).toMatch(/engine has not started your message yet/i);
    expect(STARTING_DESCRIPTION).toMatch(/seconds/i);
    expect(STARTING_DESCRIPTION).toMatch(/minutes/i);
  });
});

describe('how long a wait the user cannot shorten has been going', () => {
  const claimedAt = '2026-09-07T12:00:00.000Z';
  const after = (ms: number) => Date.parse(claimedAt) + ms;

  it('counts plain seconds below the first minute', () => {
    expect(waitElapsedLabel(claimedAt, after(0))).toBe('0s');
    expect(waitElapsedLabel(claimedAt, after(11_400))).toBe('11s');
    expect(waitElapsedLabel(claimedAt, after(59_999))).toBe('59s');
  });

  // Zero-padded so the ticking second does not change the label's width and shove the title
  // next to it sideways once a second.
  it('pads the seconds once minutes are on screen', () => {
    expect(waitElapsedLabel(claimedAt, after(60_000))).toBe('1m 00s');
    expect(waitElapsedLabel(claimedAt, after(246_000))).toBe('4m 06s');
    expect(waitElapsedLabel(claimedAt, after(59 * 60_000 + 59_000))).toBe('59m 59s');
  });

  it('drops to hours and minutes once seconds stop being the story', () => {
    expect(waitElapsedLabel(claimedAt, after(3_600_000))).toBe('1h 00m');
    expect(waitElapsedLabel(claimedAt, after(3_600_000 + 4 * 60_000))).toBe('1h 04m');
  });

  // A '0s' here would be a measurement, and neither an old payload nor a skewed clock has made
  // one. Saying nothing is the only honest answer; the notice renders without it.
  it('says nothing about a wait it cannot measure', () => {
    expect(waitElapsedLabel(null, after(60_000))).toBeNull();
    expect(waitElapsedLabel(undefined, after(60_000))).toBeNull();
    expect(waitElapsedLabel('', after(60_000))).toBeNull();
    expect(waitElapsedLabel('not a timestamp', after(60_000))).toBeNull();
  });

  it('does not invent a zero for a clock that runs ahead of the server', () => {
    expect(waitElapsedLabel(claimedAt, after(-5_000))).toBeNull();
  });
});

describe('when the runner names what a starting session is doing', () => {
  // Allowed to name a cause exactly because the runner said so — the same division of labour as
  // queuedReason, where only the server can see which gate holds a queued row.
  it('says compaction when compaction is what it is', () => {
    const compacting = { enginePhase: 'compacting' };
    expect(startingTitle(compacting)).toBe(COMPACTING_TITLE);
    expect(startingLabel(compacting)).toBe('Compacting');
    expect(startingDescription(compacting)).toMatch(/no longer fits/i);
    expect(startingDescription(compacting)).toMatch(/few minutes/i);
  });

  // The generic copy is what an unnamed phase gets, and it must stay reachable: it is the answer
  // for a cold checkout, a warm handover, and every runner too old to name anything at all.
  it('falls back to the copy that names nothing when no phase was reported', () => {
    for (const session of [null, undefined, {}, { enginePhase: null }]) {
      expect(startingTitle(session)).toBe(STARTING_TITLE);
      expect(startingLabel(session)).toBe('Starting');
      expect(startingDescription(session)).toBe(STARTING_DESCRIPTION);
    }
  });

  // A runner self-updates on its own schedule and outlives a release, so it can name a phase this
  // client has never heard of. Printing a word it cannot explain is worse than the generic line.
  it('does not print a phase it cannot explain', () => {
    const unknown = { enginePhase: 'reticulating' };
    expect(startingTitle(unknown)).toBe(STARTING_TITLE);
    expect(startingLabel(unknown)).toBe('Starting');
    expect(startingDescription(unknown)).toBe(STARTING_DESCRIPTION);
  });
});
