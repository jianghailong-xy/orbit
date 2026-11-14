// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerUpdateLaterMenu } from './RunnerUpdateLater';
import { SELF_UPDATE_NOW_V1 } from '@orbit/shared';
import type { QueuedGate } from '../lib/runnerSlots';
import type { Runner } from './TasksSidePanel';
import { RunnerUpdatingQueued, RunnerUpdatingTag, sessionLine, statusLabel } from './WorkspaceView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Board 2 of docs/mocks/runner-update-drain: studio-mac drains for 0.1.254 behind two turns.
const gate: QueuedGate = {
  queuedReason: 'runner_updating',
  queuedActive: 2,
  queuedLimit: null,
  queuedRunnerUpdate: {
    targetVersion: '0.1.254',
    since: new Date(Date.now() - 38 * 60_000 - 5_000).toISOString(),
    turns: [
      { id: 'a1', title: 'Backfill missing shard rows' },
      { id: 'b2', title: 'Why are 11-08 metrics zero' },
    ],
  },
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

const withQueries = (node: React.ReactNode) =>
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;

describe('a session held by its runner’s update', () => {
  it('reads Runner updating in the list, in the warning colour', () => {
    const row = { status: 'PENDING', ...gate };
    expect(sessionLine(row, true)).toEqual({ text: 'Runner updating', tone: 'warning' });
    expect(statusLabel(row)).toBe('Runner updating');
    // The paired negative: any other queue word stays grey.
    expect(sessionLine({ status: 'PENDING', queuedReason: 'runner_offline' }, true)).toEqual({
      text: 'Runner offline',
      tone: 'queued',
    });
  });

  it('draws the queued page: title, the turns as links, the wait, and no buttons yet', () => {
    const opened: string[] = [];
    const el = mount(<RunnerUpdatingQueued gate={gate} machine="studio-mac" onOpenSession={(id) => opened.push(id)} />);
    expect(el.querySelector('.chat-queued-title')?.textContent).toBe('Runner updating');
    expect(el.querySelector('.chat-queued-desc')?.textContent).toBe(
      'studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts right after.',
    );
    const links = [...el.querySelectorAll('.chat-queued-desc a')];
    expect(links.map((a) => a.textContent)).toEqual(['Backfill missing shard rows', 'Why are 11-08 metrics zero']);
    act(() => (links[1] as HTMLElement).click());
    expect(opened).toEqual(['b2']);
    expect(el.querySelector('.chat-queued-waited')?.textContent).toBe('Waiting 38 min');
    // Without actions nothing is drawn below the wait; WorkspaceView hands it Later ▾ (next case).
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });

  it('tags the waiting message `Queued · runner updating`, and a press opens why', async () => {
    const el = mount(withQueries(<RunnerUpdatingTag gate={gate} machine="studio-mac" />));
    expect(el.textContent).toBe('Queued·runner updating');
    const reason = el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement;
    expect(reason.textContent).toBe('runner updating');
    await act(async () => reason.click());
    const pop = document.querySelector('.runner-updating-pop');
    expect(pop?.textContent).toBe(
      'studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.Waiting 38 min.',
    );
    expect(document.body.textContent).toContain('Runner updating');
    expect(pop?.querySelectorAll('button')).toHaveLength(0);
  });

  // WorkspaceView hands both the page and the popover the same Later ▾ for the session's runner; the popover
  // draws its own row around it.
  const later = <div className="runner-update-actions"><RunnerUpdateLaterMenu runnerId="34w8RunnerStudioMac0001" /></div>;

  it('the queued page offers Later ▾ under the wait', () => {
    const el = mount(withQueries(<RunnerUpdatingQueued gate={gate} machine="studio-mac" onOpenSession={() => {}} actions={later} />));
    const buttons = [...el.querySelectorAll('.runner-update-actions button')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Later']);
    expect(el.querySelector('.chat-queued-waited + .runner-update-actions')).not.toBeNull();
  });

  it('the queued message’s popover offers Later ▾ under why', async () => {
    const el = mount(withQueries(<RunnerUpdatingTag gate={gate} machine="studio-mac" actions={<RunnerUpdateLaterMenu runnerId="34w8RunnerStudioMac0001" />} />));
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    const pop = document.querySelector('.runner-updating-pop');
    expect([...(pop?.querySelectorAll('.runner-update-actions button') ?? [])].map((b) => b.textContent?.trim())).toEqual(['Later']);
  });

  it('the queued message’s Update Now… closes the popover and confirms outside it', async () => {
    const studio = { id: '34w8RunnerStudioMac0001', name: 'studio-mac', online: true, capabilities: [SELF_UPDATE_NOW_V1],
      selfUpdate: { state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.259', turnsInFlight: 1 },
      updateTurns: [{ id: 'turn1', title: 'Backfill missing shard rows', startedAt: null }] } as Runner;
    const el = mount(withQueries(<RunnerUpdatingTag gate={gate} machine="studio-mac" updateNow={studio} />));
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    await act(async () => document.querySelector<HTMLButtonElement>('.runner-updating-pop button.runner-update-now-button')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const confirm = document.querySelector('.orbit-confirm');
    expect(confirm?.textContent).toContain('Interrupt 1 Turn and Update');
    expect(confirm?.closest('.orbit-floating-positioner')).toBeNull();
    expect(document.querySelector('.runner-updating-pop')).toBeNull();
  });
});

// docs/mocks/runner-stopping: the runner drains because its process is stopping, not for a release.
describe('a session held by a runner that is stopping', () => {
  const stopping: QueuedGate = { ...gate, queuedRunnerUpdate: { ...gate.queuedRunnerUpdate!, stopping: true, targetVersion: null } };

  it('reads Runner stopping in the list, in the warning colour', () => {
    const row = { status: 'PENDING', ...stopping };
    expect(sessionLine(row, true)).toEqual({ text: 'Runner stopping', tone: 'warning' });
    expect(statusLabel(row)).toBe('Runner stopping');
  });

  it('titles the queued page Runner stopping and says it starts once the runner is back', () => {
    const el = mount(<RunnerUpdatingQueued gate={stopping} machine="HPC" onOpenSession={() => {}} />);
    expect(el.querySelector('.chat-queued-title')?.textContent).toBe('Runner stopping');
    expect(el.querySelector('.chat-queued-desc')?.textContent).toBe(
      'HPC is stopping. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts once HPC is back.',
    );
  });

  it('tags the waiting message `Queued · runner stopping`, and the popover says why', async () => {
    const el = mount(withQueries(<RunnerUpdatingTag gate={stopping} machine="HPC" />));
    expect(el.textContent).toBe('Queued·runner stopping');
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    expect(document.querySelector('.runner-updating-pop')?.textContent).toBe(
      'HPC starts no new turns until 2 turns finish, then stops. This message is sent once it is back.Waiting 38 min.',
    );
    expect(document.body.textContent).toContain('Runner stopping');
  });
});
