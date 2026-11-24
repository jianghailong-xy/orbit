// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

import { type RunEvent, Transcript } from './Transcript';
import { resetDriveSyncs } from '../lib/driveSyncs';

/**
 * A drive_sync call is its sync's card, a row of its own rather than a step (board docs/mocks/drive-sync-card), and
 * so is a documents_sync call, its name while Drive was called Documents; an answer that names no sync, from a runner
 * before the card, stays a call in the steps line.
 */

const SYNC = {
  id: 's1', status: 'UPLOADING', sourceName: 'out', destPath: '/Reports/out', destEntryId: 'd1', session: null,
  filesSeen: 42, filesTotal: 42, filesDone: 12, filesSame: 0, filesDeleted: 0, bytesTotal: 900_000_000, bytesSent: 90_000_000,
  currentPath: 'charts/q3.png', failed: [], failedCount: 0, error: null,
  startedAt: '2026-11-24T10:00:00Z', updatedAt: '2026-11-24T10:00:10Z', endedAt: null,
};

const call = (answer: string, tool = 'drive_sync'): RunEvent[] => [
  { seq: 1, type: 'tool_use', payload: { id: 't1', name: `mcp__orbit__${tool}`, input: { localPath: 'out', path: '/Reports/out' } } },
  { seq: 2, type: 'tool_result', payload: { toolUseId: 't1', content: answer } },
  { seq: 3, type: 'assistant', payload: { text: 'The sync is running in the background.' } },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDriveSyncs();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => (path === '/drive/syncs' ? { syncs: [SYNC] } : SYNC) as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDriveSyncs();
});

const mount = async (events: RunEvent[]) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

describe.each(['drive_sync', 'documents_sync'])('a %s call', (tool) => {
  it('draws as its sync card, live from the server, from the receipt a runner answers with', async () => {
    await mount(
      call(
        JSON.stringify({
          receiptVersion: 1, ok: true, outcome: 'written', operation: tool, action: tool, entityType: 'file',
          id: 'bgj_1', status: 'running', entity: { jobId: 'bgj_1', status: 'running', syncId: 's1' },
        }),
        tool,
      ),
    );
    const card = container.querySelector('section.drive-sync');
    expect(card?.textContent).toContain('Syncing to Drive');
    expect(card?.textContent).toContain('12 of 42 files');
    expect(container.querySelector('.chat-steps-line')).toBeNull();
  });

  it('stays a call when its answer names no sync', async () => {
    await mount(call('{"jobId":"bgj_1","status":"running"}', tool));
    expect(container.querySelector('section.drive-sync')).toBeNull();
  });
});
