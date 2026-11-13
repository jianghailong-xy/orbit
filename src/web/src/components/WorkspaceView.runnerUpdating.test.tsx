// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerUpdateLaterMenu } from './RunnerUpdateLater';
import type { QueuedGate } from '../lib/runnerSlots';
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
    const el = mount(<RunnerUpdatingTag gate={gate} machine="studio-mac" />);
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

  // WorkspaceView hands both the page and the popover the same Later ▾ for the session's runner.
  const later = <div className="runner-update-actions"><RunnerUpdateLaterMenu runnerId="34w8RunnerStudioMac0001" /></div>;
  const withQueries = (node: React.ReactNode) =>
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;

  it('the queued page offers Later ▾ under the wait', () => {
    const el = mount(withQueries(<RunnerUpdatingQueued gate={gate} machine="studio-mac" onOpenSession={() => {}} actions={later} />));
    const buttons = [...el.querySelectorAll('.runner-update-actions button')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Later']);
    expect(el.querySelector('.chat-queued-waited + .runner-update-actions')).not.toBeNull();
  });

  it('the queued message’s popover offers Later ▾ under why', async () => {
    const el = mount(withQueries(<RunnerUpdatingTag gate={gate} machine="studio-mac" actions={later} />));
    await act(async () => (el.querySelector('button.chat-runner-updating-reason') as HTMLButtonElement).click());
    const pop = document.querySelector('.runner-updating-pop');
    expect([...(pop?.querySelectorAll('.runner-update-actions button') ?? [])].map((b) => b.textContent?.trim())).toEqual(['Later']);
  });
});
