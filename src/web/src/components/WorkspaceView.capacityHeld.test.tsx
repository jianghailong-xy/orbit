// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapacityGate } from '../lib/queuedCapacity';
import { PendingTray } from './PendingTray';
import { CapacityHeldTag, QueuedTurnMeta, sessionLine, statusLabel } from './WorkspaceView';

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
    // Board choice 4: nothing to press in it.
    expect(pop?.querySelectorAll('button')).toHaveLength(0);
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
