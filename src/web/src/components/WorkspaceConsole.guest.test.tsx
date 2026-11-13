// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One address per session (board docs/mocks/share-links/11-guest-one-link, D8/D9): `/sessions/<id>` draws the
 * owner's console for a session of yours; for one someone invited you to reply in — the owner's read 404s — it asks
 * the guest door and draws the guest view in the same pane; and for one that is neither, it still says the session
 * was not found. Your own sessions never ask the guest door.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
  getGuestSession: vi.fn(),
}));
vi.mock('./WorkspaceView', () => ({ WorkspaceView: () => <p>the owner console</p> }));
vi.mock('../pages/GuestSessionPage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pages/GuestSessionPage')>()),
  GuestSessionView: ({ sessionId }: { sessionId: string }) => <p>the guest view of {sessionId}</p>,
}));
vi.mock('../lib/managedRunner', () => ({
  useManagedRunner: () => ({ managed: null, settled: true }),
  useFollowFirstSessionProvider: () => {},
}));

const { api, ApiError, getSession, getGuestSession } = await import('../api');
const { WorkspaceConsole } = await import('./WorkspaceConsole');
const { encodeId } = await import('../lib/idCodec');

const ID = encodeId('0196f8a2-7c1e-7b3a-9d4e-5f6a7b8c9d0e');
const RUNNER = { id: encodeId('0196f8a2-7c1e-7b3a-9d4e-5f6a7b8c9d01'), name: 'wikova', online: true };

let container: HTMLDivElement;
let root: Root;

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<WorkspaceConsole />}>
              <Route path="sessions/:id" element={null} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api).mockImplementation(async (path: string) => (path === '/runners' ? [RUNNER] : []) as never);
  vi.mocked(getSession).mockReset();
  vi.mocked(getGuestSession).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('/sessions/<id>, one address for its owner and its guests', () => {
  it('a session of yours draws your console and never asks the guest door', async () => {
    vi.mocked(getSession).mockResolvedValue({ id: ID, assignedRunnerId: RUNNER.id } as never);
    await visit(`/sessions/${ID}`);
    expect(container.textContent).toContain('the owner console');
    expect(getGuestSession).not.toHaveBeenCalled();
  });

  it('a session shared with you draws the guest view in the pane', async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError('Session not found', 404));
    vi.mocked(getGuestSession).mockResolvedValue({ id: ID, ownerName: 'Lin Wei', events: [] } as never);
    await visit(`/sessions/${ID}`);
    expect(getGuestSession).toHaveBeenCalledWith(ID, 200);
    expect(container.textContent).toBe(`the guest view of ${ID}`);
  });

  it('a session that is neither still says it was not found', async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError('Session not found', 404));
    vi.mocked(getGuestSession).mockRejectedValue(new ApiError('This conversation is no longer shared with you.', 404));
    await visit(`/sessions/${ID}`);
    expect(container.textContent).toContain('Session not found');
    expect(container.textContent).not.toContain('guest view');
  });
});
