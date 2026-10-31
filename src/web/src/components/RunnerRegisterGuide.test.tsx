// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';

/**
 * Add a runner (/runners/register) once the machine it waits for comes online: what it says the next
 * step is, and where its button goes. Until the first session can be started from the machine's own new
 * session page, that next step is the one the approval page (/enroll) names too — sign in a coding CLI
 * and add a workspace, both on the machine's page (project 34pLjYBjU6ILsehatEjJs, contract 6).
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const { RunnerRegisterGuide } = await import('./RunnerRegisterGuide');

const RUNNER_ID = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function open(qc: QueryClient): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/runners/register']}>
          <Routes>
            <Route path="/runners/register" element={<RunnerRegisterGuide />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api).mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Add a runner, once the machine comes online', () => {
  it('names the next step the approval page names, and Open machine opens its page', async () => {
    // The page opens with no machine online; the next read finds the new one.
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      expect(path).toBe('/runners');
      return reads++ === 0 ? [] : [{ id: RUNNER_ID, name: 'orbit@austin', online: true }];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = await open(qc);
    expect(page.textContent).toContain('Waiting for your first runner to come online');

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['runners'] });
    });
    await settle();

    const said = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
    expect(said(page.querySelector('.runner-status-title'))).toBe('Runner online — “orbit@austin” is ready');
    expect(said(page.querySelector('.runner-status-sub'))).toBe(
      "It's now on the Machines & models page, under Machines. Next, sign in a coding CLI on it and add a " +
        'workspace — the folder it runs tasks in.',
    );
    const button = page.querySelector<HTMLButtonElement>('.runner-done-btn');
    expect(said(button)).toBe('Open machine');
    expect(page.textContent).not.toContain('Create a workspace');

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(page.querySelector('[data-testid="where"]')?.textContent).toBe(`/runners/${encodeId(RUNNER_ID)}`);
  });
});
