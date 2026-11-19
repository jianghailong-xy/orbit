// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';

/**
 * Add a runner (/runners/register) once the machine it waits for comes online: what it says the next
 * step is, and where its button goes. It is the one the approval page (/enroll) and an empty machine's
 * page name too: Start a session, on the machine's new session page (board rule 12).
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const { RunnerRegisterGuide } = await import('./RunnerRegisterGuide');

const RUNNER_ID = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69';
const OLD_ID = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a70';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function open(qc: QueryClient, inSettings = false): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[inSettings ? '/settings/machines/new' : '/runners/register']}>
          <Routes>
            <Route path="/runners/register" element={<RunnerRegisterGuide />} />
            <Route path="/settings/machines/new" element={<RunnerRegisterGuide inSettings />} />
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
  it('names the next step the approval page names, and Start a session opens its new session page', async () => {
    // The page opens with no machine online (an account that has one, offline); the next read finds the new one.
    let reads = 0;
    const old = { id: OLD_ID, name: 'hpc', online: false };
    vi.mocked(api).mockImplementation(async (path: string) => {
      expect(path).toBe('/runners');
      return reads++ === 0 ? [old] : [old, { id: RUNNER_ID, name: 'orbit@austin', online: true }];
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
      "It's now on the Machines & models page, under Machines. Next, start a session on it — you pick the " +
        'folder it works in and sign in a coding CLI there.',
    );
    const button = page.querySelector<HTMLButtonElement>('.runner-done-btn');
    expect(said(button)).toBe('Start a session');
    expect(page.textContent).not.toContain('Create a workspace');
    expect(page.textContent).not.toContain('Open machine');

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(page.querySelector('[data-testid="where"]')?.textContent).toBe(`/runners/${encodeId(RUNNER_ID)}/new`);
  });
});

/**
 * An account with no machine at all is a new one (docs/mocks/new-user-onboarding, P3): the guide is the first
 * step of its welcome card, and once the machine is online the page moves on to its setup card by itself.
 */
describe('Add a runner, for an account with no machine yet', () => {
  it('is the welcome card’s first step, and moves on to the machine’s new session page once it is online', async () => {
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/users/me') return { id: 'u', email: 'mia@example.com', name: 'Mia Chen', createdAt: '' };
      expect(path).toBe('/runners');
      return reads++ === 0 ? [] : [{ id: RUNNER_ID, name: 'orbit@austin', online: true }];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = await open(qc);
    const said = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
    await settle();
    expect(said(page.querySelector('.msc-title'))).toBe('Welcome to Orbit, Mia');
    const steps = [...page.querySelectorAll('.msc-step .msc-step-title')].map(said);
    expect(steps).toEqual(['A computer to work on', 'A model to think with', 'Your first message']);
    expect(page.querySelector('.runner-cmd-text')?.textContent).toContain('/install.sh');
    expect(page.textContent).toContain('Waiting for it to connect');
    expect(page.textContent).not.toContain('Add a runner');

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['runners'] });
    });
    await settle();
    expect(page.querySelector('[data-testid="where"]')?.textContent).toBe(`/runners/${encodeId(RUNNER_ID)}/new`);
  });
});

/**
 * Settings' own Add a runner (/settings/machines/new, docs/mocks/settings-add-machine): never the welcome card, even
 * for an account with no machine — a new account's first sign-in still gets that at /runners/register — and once the
 * machine is online it offers its Settings page beside Start a session, staying put until one is pressed.
 */
describe('Add a runner, in Settings', () => {
  it('is the plain guide for an account with no machine, and Machine settings opens the new machine’s page', async () => {
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      expect(path).toBe('/runners');
      return reads++ === 0 ? [] : [{ id: RUNNER_ID, name: 'orbit@austin', online: true }];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = await open(qc, true);
    const said = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
    expect(said(page.querySelector('.page-title'))).toBe('Add a runner');
    expect(page.querySelector('.welcome-card')).toBeNull();
    expect(page.textContent).toContain('It appears under Machines on the left once it comes online.');

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['runners'] });
    });
    await settle();
    expect(page.querySelector('[data-testid="where"]')).toBeNull();
    expect(said(page.querySelector('.runner-status-sub'))).toBe(
      "It's now under Machines on the left. Next, start a session on it — you pick the folder it works in and " +
        'sign in a coding CLI there.',
    );
    expect(said(page.querySelector('.runner-done-btn'))).toBe('Start a session');
    const settings = [...page.querySelectorAll('button')].find((b) => said(b) === 'Machine settings');
    await act(async () => {
      settings!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(page.querySelector('[data-testid="where"]')?.textContent).toBe(`/settings/machines/${encodeId(RUNNER_ID)}`);
  });
});
