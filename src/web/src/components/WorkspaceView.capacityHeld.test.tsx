// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { slotWaitGate, type CapacityGate } from '../lib/queuedCapacity';
import { waitingNoticeFor } from '../lib/runnerSlots';
import { PendingTray } from './PendingTray';
import type { AcceptedUserTurn } from '../lib/acceptedUserTurn';
import { cancellableHeldTurn, CapacityHeldTag, HeldFoot, QueuedTurnMeta, sessionLine, statusLabel } from './WorkspaceView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// docs/mocks/queued-card-runner-full ③: HPC on 11-15, 10 turns and 6 slots held by bg_run jobs, of 16.
const gate: CapacityGate = {
  queuedReason: 'runner_at_capacity',
  queuedActive: 16,
  queuedLimit: 16,
  queuedHeldByJobs: 6,
  lastTurnAt: new Date(Date.now() - 15 * 60_000 - 5_000).toISOString(),
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe('a session a full runner, run or batch holds', () => {
  // Board session-row-runner-full, the owner's pick C: the list says it in plain words with no clock (the
  // row's own time counts the wait); its tooltip says what is full. The header keeps the gate's name.
  it('reads Waiting for a free slot in the list, with the gate in its tooltip, and Runner full in the header', () => {
    const row = { status: 'PENDING', ...gate };
    expect(sessionLine(row, true, null, true, 'HPC')).toEqual({
      text: 'Waiting for a free slot',
      tone: 'queued',
      hint:
        'Runner full\nHPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.\nWaiting 15 min',
    });
    expect(statusLabel(row)).toBe('Runner full');
    const run = sessionLine({ status: 'PENDING', queuedReason: 'tree_at_capacity' }, true);
    expect([run.text, run.hint?.split('\n')[0]]).toEqual(['Waiting for a free slot', 'Run full']);
    const batch = sessionLine({ status: 'PENDING', queuedReason: 'batch_at_capacity' }, true);
    expect([batch.text, batch.hint?.split('\n')[0]]).toEqual(['Waiting for a free slot', 'Batch full']);
  });

  it('tags the waiting message `Queued · runner full`, and a press opens how the slots are taken', async () => {
    const el = mount(<CapacityHeldTag gate={gate} machine="HPC" />);
    expect(el.textContent).toBe('Queued·runner full');
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    const pop = document.querySelector('.runner-updating-pop');
    expect(pop?.textContent).toBe(
      'HPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.Waiting 15 min.',
    );
    expect(document.body.textContent).toContain('Runner full');
    // A server that predates Run now supplies no action or refusal.
    expect(pop?.querySelectorAll('button')).toHaveLength(0);
  });

  it.each(['runner_at_capacity', 'tree_at_capacity', 'batch_at_capacity'])(
    'offers Run now for %s and describes the next slot on the runner',
    async (queuedReason) => {
      const queuedActive = queuedReason === 'runner_at_capacity' ? 16 : 3;
      const el = mount(<CapacityHeldTag
        gate={{ ...gate, queuedReason, queuedActive, queuedLimit: queuedActive, runNowAvailable: true }}
        machine="HPC" runnerActive={16} runnerLimit={16} onRunNow={() => {}}
      />);
      await act(async () => el.querySelector('button')!.click());
      const pop = document.querySelector('.runner-updating-pop');
      expect(pop?.querySelector('button')?.textContent).toBe('Run now');
      expect(pop?.querySelector('button')?.disabled).toBe(false);
      expect(pop?.querySelector('.queued-run-now-note')?.textContent).toBe(
        'Starts it as the 17th session on HPC. This turn only; the limit stays 16.',
      );
    },
  );

  it.each(['runner_offline', 'runner_updating', 'disk_below_floor', 'WORKSPACE_CLONING', 'worktree_op_pending', null])(
    'offers no Run now for %s even if availability is stale',
    (queuedReason) => {
      const el = mount(<CapacityHeldTag gate={{ queuedReason, runNowAvailable: true }} onRunNow={() => {}} />);
      expect(el.querySelector('button')).toBeNull();
    },
  );

  it.each([
    'HPC is already 2 over its limit, the most it can take. Wait, or stop another session.',
    'HPC takes no sessions over its limit: its Extra sessions on demand is 0.',
  ])('disables Run now and shows the exact refusal: %s', async (runNowRefusal) => {
    const el = mount(<CapacityHeldTag gate={{ ...gate, runNowAvailable: false, runNowRefusal }} machine="HPC" onRunNow={() => {}} />);
    await act(async () => el.querySelector('button')!.click());
    const pop = document.querySelector('.runner-updating-pop');
    expect(pop?.querySelector('button')?.textContent).toBe('Run now');
    expect(pop?.querySelector('button')?.disabled).toBe(true);
    expect(pop?.querySelector('.queued-run-now-note')?.textContent).toBe(runNowRefusal);
  });

  it('a run that is full says run full', () => {
    const el = mount(<CapacityHeldTag gate={{ queuedReason: 'tree_at_capacity', queuedActive: 13, queuedLimit: 13 }} machine="HPC" />);
    expect(el.textContent).toBe('Queued·run full');
  });

  it('a card Orbit queued reads `Queued · runner full` with Cancel beside it (board ④)', () => {
    const cancelled: string[] = [];
    const el = mount(
      <QueuedTurnMeta placement="queued" held={<CapacityHeldTag gate={gate} machine="HPC" />} onCancel={() => cancelled.push('t1')} />,
    );
    expect(el.textContent).toBe('Queued·runner fullCancel');
    act(() => (el.querySelector('a') as HTMLElement).click());
    expect(cancelled).toEqual(['t1']);
  });

  it('a message accepted but not yet taken reads `Queued · runner full · Cancel`, and Cancel takes it back', () => {
    let cancelled = 0;
    const el = mount(<HeldFoot tag={<CapacityHeldTag gate={gate} machine="HPC" />} onCancel={() => { cancelled += 1; }} />);
    expect(el.textContent).toBe('Queued·runner full·Cancel');
    act(() => (el.querySelector('button.chat-held-cancel') as HTMLButtonElement).click());
    expect(cancelled).toBe(1);
  });

  it('only an accepted placeholder with an id, never the opening prompt nor an echoed message, is cancellable', () => {
    const turn = (over: Partial<AcceptedUserTurn>): AcceptedUserTurn => ({
      key: 'k', sessionId: 's', source: 'activeSnapshot', turnId: 't2', text: 'Why is task 6 still queued?',
      acceptedAt: '2026-11-20T00:00:00.000Z', attachments: [], ...over,
    });
    const events = [{ type: 'user', seq: 3, turnId: 't1' }, { type: 'result', seq: 4 }, { type: 'user', seq: 4.5, turnId: 't2' }];
    expect(cancellableHeldTurn(events, 4.5, [turn({})])?.turnId).toBe('t2');
    expect(cancellableHeldTurn(events, 4.5, [turn({ opening: true })])).toBeNull();
    expect(cancellableHeldTurn(events, 3, [turn({})])).toBeNull();
    expect(cancellableHeldTurn([{ type: 'user', seq: 1.5, turnId: 'k' }], 1.5, [turn({ key: 'k', turnId: undefined })])).toBeNull();
  });

  it('the reader’s own waiting message in the tray says it in place of `Queued for next turn` (board ②)', () => {
    const el = mount(
      <PendingTray
        rows={[{
          key: 't1', heading: 'next', text: 'the screenshot request', previews: [], imageIds: [], files: 0,
          state: <CapacityHeldTag gate={gate} machine="HPC" />, onWithdraw: () => {},
        }]}
      />,
    );
    expect(el.querySelector('.pending-tray-state')?.textContent).toBe('Queued·runner full');
    expect(el.textContent).not.toContain('Queued for next turn');
  });
});

// Runner cdvn0, 2026-11-27: four sessions running background jobs filled its four slots. A claim the full runner could
// not give back — a message already handed out under it — waits for its slot RUNNING, and the control plane names that
// wait (enginePhase waiting_for_slot, with the runner's counts). It is the same wait as a claim it did give back, which
// waits queued (runner_at_capacity), so it reads in the same words, by the same tag: never "Getting the session ready".
describe('a claim a full runner keeps waiting for its slot', () => {
  const waiting = {
    status: 'RUNNING',
    engineStartedAt: null,
    enginePhase: 'waiting_for_slot',
    enginePhaseSince: new Date(Date.now() - 28 * 60_000 - 5_000).toISOString(),
    runClaimedAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    slotWait: { active: 4, heldByJobs: 4, limit: 4 },
  };

  it('reads as the queued row a full runner holds: Waiting for a free slot, its counts, Runner full', () => {
    expect(waitingNoticeFor(waiting)).toBeNull();
    expect(sessionLine(waiting, true, null, true, 'cdvn0')).toEqual({
      text: 'Waiting for a free slot',
      tone: 'queued',
      hint:
        'Runner full\ncdvn0 is using all 4 slots: 0 sessions are running a turn and 4 hold a slot with a background job. This message is sent as soon as one frees up.\nWaiting 28 min',
    });
    expect(statusLabel(waiting)).toBe('Runner full');
  });

  it('tags the waiting message `Queued · runner full`, with the same popover and no Run now', async () => {
    const el = mount(<CapacityHeldTag gate={slotWaitGate(waiting)!} machine="cdvn0" onRunNow={() => {}} />);
    expect(el.textContent).toBe('Queued·runner full');
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    const pop = document.querySelector('.runner-updating-pop');
    expect(pop?.textContent).toBe(
      'cdvn0 is using all 4 slots: 0 sessions are running a turn and 4 hold a slot with a background job. This message is sent as soon as one frees up.Waiting 28 min.',
    );
    expect(pop?.querySelectorAll('button')).toHaveLength(0);
  });

  it('without the counts (an older server) still says the runner is full', () => {
    const bare = { ...waiting, slotWait: undefined };
    expect(sessionLine(bare, true, null, true, 'cdvn0').hint?.split('\n').slice(0, 2)).toEqual([
      'Runner full',
      'cdvn0 is using all its slots. This message is sent as soon as one frees up.',
    ]);
  });

  it('is no wait once the slot is granted and the phase is gone', () => {
    expect(slotWaitGate({ ...waiting, enginePhase: null })).toBeNull();
    expect(slotWaitGate({ ...waiting, status: 'AWAITING_INPUT' })).toBeNull();
  });
});
