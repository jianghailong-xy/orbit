// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A workspace says how large its Claude Code sessions' conversations get before they are compacted,
 * under the workspace form's Advanced. The choice is the CLI's own variable in the workspace's
 * environment, so the saved env is what each claim here is about.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const WORKSPACE_ID = '33zx0JhRhJo8rd25d3qAN';
const VARIABLE = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

const runner = (engines: Runner['engines'] = [{ engine: 'claude', installed: true, auth: 'yes' }]): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines,
});

const workspace = (env: Record<string, string> = {}) => ({
  id: WORKSPACE_ID,
  name: 'orbit',
  runnerId: RUNNER_ID,
  workDir: '/srv/orbit',
  env,
  createdAt: '2026-09-23T08:00:00.000Z',
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The account picker measures its box, and jsdom ships no layout to measure: nothing asserted
  // here depends on one.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
});

/** The runner's page, over one workspace. Every PATCH the page sends is collected. */
function mount(r: Runner, ws: ReturnType<typeof workspace>) {
  const patches: Array<Record<string, unknown>> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method === 'PATCH' && path === `/workspaces/${WORKSPACE_ID}`) {
      patches.push(options?.body as Record<string, unknown>);
      return { ...ws, ...(options?.body as object) };
    }
    if (path === '/runners') return [r];
    if (path === '/workspaces') return [ws];
    if (path === '/providers') return [];
    // The workspace rows' "N running" reads the sidebar's per-workspace tallies.
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'u', email: 'u@example.invalid', name: 'u', createdAt: '', preferences: {} };
    if (path.includes('permission-rules')) return [];
    if (path.includes('imported')) return { count: 0 };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [r]);
  qc.setQueryData(['workspaces'], [ws]);
  qc.setQueryData(['providers'], []);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/runners/:id" element={<RunnerDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return { patches };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const byText = (selector: string, text: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find(
    (el) => el.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no ${selector} reading "${text}"`);
  return found;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};
/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which a
 *  list option needs before it takes a click as a choice rather than a keyboard activation. */
const press = async (el: HTMLElement) => {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
};

/** Open the workspace's editor. */
async function openEditor() {
  await settle();
  await click(byText('.rd-workspace-name', 'orbit'));
}

/** Open the workspace's editor and its Advanced part. */
async function openAdvanced() {
  await openEditor();
  await click(document.body.querySelector<HTMLElement>('.rd-adv-toggle')!);
}

const field = () =>
  [...document.body.querySelectorAll<HTMLElement>('.rd-form-field')].find(
    (el) => el.querySelector('.rd-form-label')?.textContent === 'Compact Claude Code sessions at',
  );

/** The size picker, as its role names it. */
const picker = () => field()?.querySelector<HTMLElement>('[role="combobox"]');


/** Open the dropdown and read its options. */
async function options() {
  await click(picker()!);
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}
const pick = async (label: string) => {
  const option = (await options()).find((el) => el.textContent?.trim() === label);
  if (!option) throw new Error(`no option "${label}"`);
  await press(option);
};
const save = () => click(byText('button', 'Save'));

describe('how large a workspace lets its Claude Code conversations get', () => {
  it('leaves it to Claude Code until somebody picks a size, and saves the pick beside the rest of the env', async () => {
    const { patches } = mount(runner(), workspace({ TZ: 'Asia/Shanghai' }));
    await openAdvanced();
    expect(picker()?.textContent).toContain('Default');
    // An option like any other, not a field left empty: the neighbouring pickers read the same.
    expect(picker()?.querySelector('[data-placeholder]')).toBeNull();
    expect((await options()).map((el) => el.textContent?.trim())).toEqual(['Default', '700K tokens', '500K tokens', '300K tokens']);
    await click(picker()!);

    await pick('500K tokens');
    expect(picker()?.textContent).toContain('500K tokens');
    await save();
    expect(patches).toHaveLength(1);
    expect(patches[0].env).toEqual({ TZ: 'Asia/Shanghai', [VARIABLE]: '500000' });
  });

  it('says what a smaller size costs and when it applies', async () => {
    mount(runner(), workspace());
    await openAdvanced();
    const hint = field()?.querySelector('.rd-path-hint')?.textContent;
    expect(hint).toContain('spends less quota on long sessions, but they can lose detail');
    expect(hint).toContain('the next time a session starts');
  });

  it('shows a saved size, and Default takes the variable out again', async () => {
    const { patches } = mount(runner(), workspace({ TZ: 'Asia/Shanghai', [VARIABLE]: '300000' }));
    await openAdvanced();
    expect(picker()?.textContent).toContain('300K tokens');
    await pick('Default');
    await save();
    expect(patches[0].env).toEqual({ TZ: 'Asia/Shanghai' });
  });

  it('keeps a size typed under Environment variables, and offers it by what it is', async () => {
    const { patches } = mount(runner(), workspace({ [VARIABLE]: '250k' }));
    await openAdvanced();
    expect(picker()?.textContent).toContain('250k');
    await save();
    expect(patches[0].env).toEqual({ [VARIABLE]: '250k' });
  });

  it('is not offered on a machine without Claude Code', async () => {
    mount(runner([{ engine: 'codex', installed: true, auth: 'yes' }]), workspace());
    await openAdvanced();
    expect(field()).toBeUndefined();
  });
});
