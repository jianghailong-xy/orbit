// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { hearClone, resetCloneHeard } from '../lib/workspaceClone';
import { CLONE_FAILED_WAIT, pendingSlotDescription } from '../lib/runnerSlots';
import { CloneWaitNotice, useCloneWait, type CloneWaitWorkspace } from './CloneWaitNotice';
import { sessionLine } from './WorkspaceView';

/**
 * A session held by its workspace's clone (board docs/mocks/clone-progress-wait-card): the waiting card names the
 * repository and machine and draws git's percentage, and the list row says the percentage.
 */

const WORKSPACE = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a70';
const SESSION = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a71';
const REPO_URL = 'https://github.com/orbit-labs/orbit-web.git';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetCloneHeard();
});

function Probe({ workspace }: { workspace: CloneWaitWorkspace }) {
  const clone = useCloneWait(SESSION, workspace);
  return clone ? <CloneWaitNotice clone={clone} machine="orbit-ws03" /> : <span>plain</span>;
}

function draw(workspace: CloneWaitWorkspace): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient();
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <Probe workspace={workspace} />
      </QueryClientProvider>,
    ),
  );
  return host;
}

describe('the waiting card of a session held by its clone', () => {
  it('names the repository and machine before git says a percentage, with no bar', () => {
    const el = draw({ id: WORKSPACE, repoUrl: REPO_URL, cloneState: 'PENDING' });
    expect(el.querySelector('.chat-queued-title')?.textContent).toBe(' Waiting to clone orbit-labs/orbit-web');
    expect(el.querySelector('.chat-queued-desc')?.textContent).toBe('On orbit-ws03. This session starts when the clone is done.');
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('draws the percentage the stream relays, and follows it', () => {
    const el = draw({ id: WORKSPACE, repoUrl: REPO_URL, cloneState: 'CLONING' });
    act(() => {
      hearClone(WORKSPACE, { state: 'CLONING', progress: 42 });
    });
    expect(el.querySelector('.chat-queued-title')?.textContent).toBe('Cloning orbit-labs/orbit-web');
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(el.querySelector('.msc-clone-pct')?.textContent).toBe('42%');
    act(() => {
      hearClone(WORKSPACE, { state: 'CLONING', progress: 87 });
    });
    expect(el.querySelector('.msc-clone-pct')?.textContent).toBe('87%');
  });

  it('leaves a failed or finished clone, and a workspace not from GitHub, to the plain words', () => {
    expect(draw({ id: WORKSPACE, repoUrl: REPO_URL, cloneState: 'FAILED' }).textContent).toBe('plain');
    act(() => root?.unmount());
    expect(draw({ id: WORKSPACE, repoUrl: REPO_URL, cloneState: 'READY' }).textContent).toBe('plain');
    act(() => root?.unmount());
    expect(draw({ id: WORKSPACE, repoUrl: null, cloneState: null }).textContent).toBe('plain');
  });

  it('no longer sends a failed clone to a first line the session may not have', () => {
    expect(pendingSlotDescription(0, 4, { queuedReason: 'WORKSPACE_CLONE_FAILED' })).toBe(CLONE_FAILED_WAIT);
    expect(CLONE_FAILED_WAIT).not.toMatch(/first line/);
  });
});

describe('the list row of a session held by its clone', () => {
  const row = { id: SESSION, status: 'PENDING', queuedReason: 'WORKSPACE_CLONING', workspace: { id: WORKSPACE } };

  it('says the percentage once one is heard, and the wait before', () => {
    expect(sessionLine(row, true).text).toBe('Waiting for the clone');
    hearClone(WORKSPACE, { state: 'CLONING', progress: 42 });
    expect(sessionLine(row, true)).toEqual({ text: 'Cloning · 42%', tone: 'queued' });
  });
});
