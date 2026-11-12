import { describe, expect, it } from 'vitest';
import {
  type QueuedGate,
  RUNNER_UPDATING_TAG,
  pendingSlotDescription,
  queuedLabel,
  queuedTitle,
  runnerUpdatingDescription,
  runnerUpdatingMessageText,
  runnerUpdatingPlain,
  runnerUpdatingWaited,
} from './runnerSlots';

// The board 2 case (docs/mocks/runner-update-drain): studio-mac drains for 0.1.254 behind two turns.
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const gate: QueuedGate = {
  queuedReason: 'runner_updating',
  queuedActive: 2,
  queuedLimit: null,
  queuedRunnerUpdate: {
    targetVersion: '0.1.254',
    since: new Date(NOW - 38 * 60_000).toISOString(),
    turns: [
      { id: 'a1', title: 'Backfill missing shard rows' },
      { id: 'b2', title: 'Why are 11-08 metrics zero' },
    ],
  },
};

describe('a session held by its runner’s update', () => {
  it('names the update in the list chip and the page title', () => {
    expect(queuedLabel(gate)).toBe('Runner updating');
    expect(queuedTitle(gate)).toBe('Runner updating');
  });

  it('says what it waits for, with the turns as links, on the queued page', () => {
    const parts = runnerUpdatingDescription(gate, 'studio-mac');
    expect(parts).toEqual([
      'studio-mac is updating to 0.1.254. ',
      'It starts no new work until 2 turns finish: ',
      { id: 'a1', title: 'Backfill missing shard rows' },
      ' and ',
      { id: 'b2', title: 'Why are 11-08 metrics zero' },
      '. ',
      'This session starts right after.',
    ]);
    expect(runnerUpdatingPlain(parts)).toBe(
      'studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts right after.',
    );
    // The one-line transcript note reads the same sentence.
    expect(pendingSlotDescription(2, 8, gate, 'studio-mac')).toBe(runnerUpdatingPlain(parts));
  });

  it('counts the minutes it has waited', () => {
    expect(runnerUpdatingWaited(gate, NOW)).toBe('Waiting 38 min');
    const at = (minutes: number) =>
      runnerUpdatingWaited({ ...gate, queuedRunnerUpdate: { ...gate.queuedRunnerUpdate!, since: new Date(NOW - minutes * 60_000).toISOString() } }, NOW);
    expect(at(0)).toBe('Waiting less than a minute');
    expect(at(60)).toBe('Waiting 1 h');
    expect(at(125)).toBe('Waiting 2 h 5 min');
    expect(runnerUpdatingWaited({ ...gate, queuedRunnerUpdate: { ...gate.queuedRunnerUpdate!, since: null } }, NOW)).toBeNull();
  });

  it('gives the queued message’s foot-row tag and its popover the same account', () => {
    expect(RUNNER_UPDATING_TAG).toBe('runner updating');
    expect(runnerUpdatingMessageText(gate, 'studio-mac')).toBe(
      'studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.',
    );
  });

  it('names only the turns that are the reader’s, and counts the rest', () => {
    const shared = { ...gate, queuedActive: 3 };
    expect(runnerUpdatingPlain(runnerUpdatingDescription(shared, 'studio-mac'))).toBe(
      'studio-mac is updating to 0.1.254. It starts no new work until 3 turns finish: Backfill missing shard rows, Why are 11-08 metrics zero and 1 more. This session starts right after.',
    );
  });

  it('says less, not something false, when the runner reports less', () => {
    const old: QueuedGate = {
      queuedReason: 'runner_updating',
      queuedActive: 1,
      queuedRunnerUpdate: { targetVersion: null, since: null, turns: [{ id: 'a1', title: 'Backfill missing shard rows' }] },
    };
    expect(runnerUpdatingPlain(runnerUpdatingDescription(old, 'studio-mac'))).toBe(
      'studio-mac is updating. It starts no new work until 1 turn finishes: Backfill missing shard rows. This session starts right after.',
    );
    expect(runnerUpdatingMessageText(old, 'studio-mac')).toBe(
      'studio-mac starts no new turns until 1 turn finishes, then updates. This message is sent right after.',
    );
    // Nothing left in flight: the runner is about to restart, so no sentence about turns.
    const idle: QueuedGate = { ...old, queuedActive: 0, queuedRunnerUpdate: { ...old.queuedRunnerUpdate!, turns: [] } };
    expect(runnerUpdatingPlain(runnerUpdatingDescription(idle, 'studio-mac'))).toBe(
      'studio-mac is updating. This session starts right after.',
    );
  });
});
