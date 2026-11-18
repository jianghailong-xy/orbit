// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../TasksSidePanel';
import { SettingsWorkspacePage } from './WorkspaceSettingsPage';

/**
 * A workspace's Settings page (board-5): Location, Sessions, Agent environment and Danger zone, each
 * row saved on its own (owner's choice D1) with one PATCH carrying only the field it edits; the long
 * ones edited in a drawer. And New workspace: the machine first, then the folder, then its page.
 */

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  api: vi.fn(),
  askClaudeHistory: vi.fn(),
  getClaudeHistory: vi.fn(),
  importClaudeHistory: vi.fn(),
  revokeWorkspacePermissionRule: vi.fn(),
}));
const { api, askClaudeHistory, getClaudeHistory, importClaudeHistory, revokeWorkspacePermissionRule } = await import(
  '../../api'
);
const apiMock = vi.mocked(api);

// What the page says when a row saves, or fails to.
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../lib/toast', () => ({ useToast: () => toast }));

// Public ids, the spelling the web holds every id in (= uuidToBase62 of a v7 uuid).
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const OTHER_RUNNER_ID = '33zx0JhRhJo8rd25d3qAR';
const ORBIT = '33zx0JhRhJo8rd25d3qAN';
const SITE = '33zx0JhRhJo8rd25d3qAP';
const MADE = '33zx0JhRhJo8rd25d3qAS';

const RUNNER: Runner = {
  id: RUNNER_ID,
  name: 'gpu-box',
  online: true,
  lastHeartbeatAt: new Date().toISOString(),
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] },
  runtimeDefaultModels: { claude: 'claude-opus-5-5' },
};
const OTHER: Runner = { id: OTHER_RUNNER_ID, name: 'studio-mac', online: true, lastHeartbeatAt: new Date().toISOString() };

const workspace = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  runnerId: RUNNER_ID,
  workDir: `/home/me/src/${name}`,
  repoUrl: `github.com/acme/${name}`,
  enableWorktree: true,
  enabled: true,
  lastProvider: 'claude',
  env: { GOFLAGS: '-mod=mod', NODE_OPTIONS: '--max-old-space-size=8192' },
  appendSystemPrompt: 'Run the tests before you commit.',
  createdAt: '2026-09-23T08:00:00.000Z',
  ...over,
});

const HISTORY = {
  conversations: 3,
  transcripts: [
    { id: 't1', title: 'Fix the flaky spec', lastActiveAt: '2026-11-10T08:00:00.000Z', messages: 12, bytes: 2048 },
    { id: 't2', title: 'Plan', lastActiveAt: '2026-11-09T08:00:00.000Z', messages: 4, bytes: 1024 },
  ],
  windowDays: 30,
  bytes: 3072,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let location = '';

function RouterProbe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.mocked(askClaudeHistory).mockReset();
  vi.mocked(getClaudeHistory).mockReset();
  vi.mocked(importClaudeHistory).mockReset();
  vi.mocked(revokeWorkspacePermissionRule).mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  document.body.innerHTML = '';
});

type Sent = { method: string; path: string; body?: Record<string, unknown> };

/** The page at `path`, over `workspaces` on gpu-box (and an empty studio-mac). Every write is collected. */
async function mount(
  path: string,
  workspaces = [workspace(ORBIT, 'orbit'), workspace(SITE, 'site')],
  { rules = 2, preferences = {} as Record<string, unknown>, sessions = [] as unknown[] } = {},
) {
  const sent: Sent[] = [];
  let rows = workspaces;
  apiMock.mockImplementation(async (url: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    const body = options?.body as Record<string, unknown> | undefined;
    if (method !== 'GET') {
      sent.push({ method, path: url, ...(body ? { body } : {}) });
      if (method === 'PATCH') {
        rows = rows.map((w) => (url === `/workspaces/${w.id}` ? { ...w, ...body } : w));
        return rows.find((w) => url === `/workspaces/${w.id}`);
      }
      if (method === 'POST' && url === '/workspaces') {
        const made = workspace(MADE, String(body?.name), body);
        rows = [...rows, made];
        return made;
      }
      return {};
    }
    if (url === '/runners') return [RUNNER, OTHER];
    if (url === '/workspaces') return rows;
    const one = rows.find((w) => url === `/workspaces/${w.id}`);
    if (one) return { ...one, sessionCount: 37, lastActiveAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    if (url === '/providers') return [];
    if (url === '/users/me') return { id: 'u', email: 'u@example.invalid', name: 'u', createdAt: '', preferences };
    if (url.includes('permission-rules')) {
      return Array.from({ length: rules }, (_, i) => ({ id: `r${i}`, toolName: 'Bash', ruleContent: `npm test:${i}` }));
    }
    if (url.includes('imported')) return { count: 0 };
    if (url.startsWith('/sessions')) return sessions;
    return [];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings/workspaces/:id" element={<SettingsWorkspacePage />} />
            <Route path="/settings/machines/:id" element={<div data-testid="machine-page" />} />
          </Routes>
          <RouterProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle(5);
  return { sent };
}

const settle = async (times = 1) => {
  for (let i = 0; i < times; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const $$ = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<T & Element>(selector)] as T[];
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const section = (title: string) => {
  const found = $$('.settings-section').find((s) => text(s.querySelector('.settings-section-title')) === title);
  if (!found) throw new Error(`no section "${title}"`);
  return found;
};
const row = (title: string) => {
  const found = $$('.settings-row').find((r) => text(r.querySelector('.settings-row-title')) === title);
  if (!found) throw new Error(`no row "${title}"`);
  return found;
};
const button = (label: string, scope: ParentNode = document.body) => {
  const found = $$<HTMLButtonElement>('button', scope).find((b) => text(b) === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
};
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle(3);
};
const press = async (el: HTMLElement) => {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle(3);
};
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const enter = async (input: HTMLElement) => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle(3);
};
const blur = async (input: HTMLElement) => {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
  });
  await settle(3);
};
const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const toggle = (label: string) => document.body.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!;
const drawer = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

describe('a workspace’s Settings page', () => {
  it('heads with its name and where it runs, then Location, Sessions, Agent environment and Danger zone', async () => {
    await mount(`/settings/workspaces/${ORBIT}`);
    expect(text(document.querySelector('.settings-header-title'))).toBe('orbit');
    expect(text(document.querySelector('.settings-header-description'))).toBe('On gpu-box · 37 sessions · last used 2h ago');
    expect($$('.settings-section-title').map(text)).toEqual(['Location', 'Sessions', 'Agent environment', 'Danger zone']);
    expect($$('.settings-row-title', section('Location')).map(text)).toEqual([
      'Name',
      'Machine',
      'Working directory',
      'Repository URL',
    ]);
    expect(field('Name').value).toBe('orbit');
    expect(field('Working directory').value).toBe('/home/me/src/orbit');
    expect(field('Repository URL').value).toBe('github.com/acme/orbit');
    // The machine is read-only: a link to its own page.
    const machine = row('Machine').querySelector('a');
    expect(text(machine)).toBe('gpu-box');
    expect(machine?.getAttribute('href')).toBe(`/settings/machines/${RUNNER_ID}`);
    expect($$('.settings-row-title', section('Agent environment')).map(text)).toEqual([
      'Environment variables',
      'Instructions',
      'Agent tools',
      'Always allowed',
    ]);
    expect(text(row('Environment variables').querySelector('.settings-row-description'))).toBe('GOFLAGS, NODE_OPTIONS');
    expect(text(row('Instructions').querySelector('.settings-row-description'))).toBe(
      "Added to every run's runtime instructions · 32 characters",
    );
    expect(text(row('Always allowed').querySelector('.settings-row-description'))).toBe(
      '2 tools you said “don’t ask again” for',
    );
    // What agents here are given, read-only, in a drawer: the row holds a View button, never a switch.
    expect(text(row('Agent tools').querySelector('.settings-row-description'))).toBe(
      "What agents here are given: Orbit's tools, the instructions they read and in what order, and the playbooks.",
    );
    expect(row('Agent tools').querySelector('[role="switch"]')).toBeNull();
    const view = Array.from(row('Agent tools').querySelectorAll('button')).find((b) => text(b) === 'View');
    await act(async () => {
      view?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const drawer = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => text(d).includes('Agent tools · orbit'));
    expect(drawer).toBeTruthy();
    expect(text(drawer?.querySelector('.agent-tools-layers') ?? null)).toContain("This workspace's runtime instructions");
    expect($$('.settings-row-title', section('Danger zone')).map(text)).toEqual(['Disable workspace', 'Delete workspace']);
    // No whole-form Save on this page.
    expect($$('button').some((b) => text(b) === 'Save')).toBe(false);
  });

  it('shows smart selection, Optimize for and its engines only while the account has it on', async () => {
    await mount(`/settings/workspaces/${ORBIT}`);
    expect($$('.settings-row-title', section('Sessions')).map(text)).toEqual(['Worktree isolation', 'Model']);
    act(() => root?.unmount());
    host?.remove();
    await mount(`/settings/workspaces/${ORBIT}`, undefined, { preferences: { modelRouting: true } });
    expect($$('.settings-row-title', section('Sessions')).map(text)).toEqual([
      'Worktree isolation',
      'Smart model selection for tasks',
      'Optimize for',
      'Model',
    ]);
    expect(text(section('Sessions').querySelector('.rd-engines-label'))).toBe('Engines it may use');
  });

  it('says so for a workspace that does not exist', async () => {
    await mount(`/settings/workspaces/33zx0JhRhJo8rd25d3qAQ`);
    expect(document.body.textContent).toContain("This workspace doesn't exist, or isn't yours.");
  });
});

describe('every edit is one PATCH carrying only that field', () => {
  const only = (sent: Sent[]) => sent.map(({ method, path, body }) => ({ method, path, body }));

  it('a toggle when it changes', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await click(toggle('Worktree isolation'));
    expect(only(sent)).toEqual([{ method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { enableWorktree: false } }]);
    expect(toggle('Worktree isolation').getAttribute('aria-checked')).toBe('false');
    expect(toast.success).toHaveBeenCalledWith('Setting saved');
  });

  it('a select when it changes, and each engine ticked', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`, undefined, { preferences: { modelRouting: true } });
    await click(toggle('Smart model selection for tasks'));
    await click(document.body.querySelector('[aria-label="Optimize for"]')!);
    await press($$('[role="option"]').find((o) => text(o) === 'Balance')!);
    const codex = $$('.rd-engines-list [role="checkbox"]').find((c) => text(c.closest('label')) === 'Codex')!;
    await click(codex);
    expect(only(sent)).toEqual([
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { modelRouting: true } },
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { modelRoutingOptimizeFor: 'balance' } },
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { modelRoutingProviders: ['codex'] } },
    ]);
  });

  it('a text field on blur, and on Enter — once, though the blur follows the Enter', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await type(field('Name'), 'orbit-main');
    expect(sent).toEqual([]);
    await blur(field('Name'));
    await type(field('Working directory'), '/srv/orbit');
    await enter(field('Working directory'));
    await blur(field('Working directory'));
    expect(only(sent)).toEqual([
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { name: 'orbit-main' } },
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { workDir: '/srv/orbit' } },
    ]);
  });

  it('nothing for a field left as it was, and an emptied one goes back to what is saved', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await type(field('Repository URL'), 'github.com/acme/orbit');
    await blur(field('Repository URL'));
    await type(field('Name'), '   ');
    await blur(field('Name'));
    expect(sent).toEqual([]);
    expect(field('Name').value).toBe('orbit');
  });

  it('Environment variables: edited in a drawer, saved on its Save as the one env field', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await click(button('Edit', row('Environment variables')));
    expect(text(drawer()?.querySelector('h2, [class*="title"]'))).toContain('Environment variables');
    const keys = $$<HTMLInputElement>('.rd-env-row input[placeholder="KEY"]', drawer()!);
    expect(keys.map((k) => k.value)).toEqual(['GOFLAGS', 'NODE_OPTIONS']);
    await click($$('.rd-env-row', drawer()!)[0].querySelector('[aria-label="Remove"]')!);
    await click(button('Add variable', drawer()!));
    const [, newKey] = $$<HTMLInputElement>('.rd-env-row input[placeholder="KEY"]', drawer()!);
    await type(newKey, 'PLAYWRIGHT_BROWSERS_PATH');
    const [, newValue] = $$<HTMLInputElement>('.rd-env-row input[placeholder="value"]', drawer()!);
    await type(newValue, '/opt/pw');
    expect(sent).toEqual([]);
    await click(button('Save', drawer()!));
    expect(only(sent)).toEqual([
      {
        method: 'PATCH',
        path: `/workspaces/${ORBIT}`,
        body: { env: { NODE_OPTIONS: '--max-old-space-size=8192', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } },
      },
    ]);
  });

  it('Instructions: edited in a drawer, and Cancel sends nothing', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await click(button('Edit', row('Instructions')));
    const area = drawer()!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(area.value).toBe('Run the tests before you commit.');
    await type(area, 'Draft that is dropped.');
    await click(button('Cancel', drawer()!));
    expect(sent).toEqual([]);
    await click(button('Edit', row('Instructions')));
    await type(drawer()!.querySelector<HTMLTextAreaElement>('textarea')!, '  Answer in English.  ');
    await click(button('Save', drawer()!));
    expect(only(sent)).toEqual([
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { appendSystemPrompt: 'Answer in English.' } },
    ]);
  });

  it('Always allowed: managed in a drawer, where a revoke acts at once', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await click(button('Manage', row('Always allowed')));
    expect($$('.rd-rule-token', drawer()!).map(text)).toEqual(['Bash(npm test:0)', 'Bash(npm test:1)']);
    await click($$('[aria-label="Ask about this again"]', drawer()!)[0]);
    expect(vi.mocked(revokeWorkspacePermissionRule)).toHaveBeenCalledWith(ORBIT, 'r0');
    expect(sent).toEqual([]);
  });

  it('Disable workspace is the enabled toggle, saying what disabling does', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    expect(toggle('Disable workspace').getAttribute('aria-checked')).toBe('false');
    await click(toggle('Disable workspace'));
    expect(only(sent)).toEqual([{ method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { enabled: false } }]);
    expect(toast.success).toHaveBeenCalledWith(
      'Workspace disabled — new sessions and task runs are refused. Running sessions continue.',
    );
  });

  it('a refused save says so and puts the old value back', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    const answer = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (url, options) => {
      if ((options as { method?: string } | undefined)?.method === 'PATCH') {
        sent.push({ method: 'PATCH', path: url });
        throw new Error('runner is gone');
      }
      return answer(url, options);
    });
    await click(toggle('Worktree isolation'));
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the setting", 'runner is gone');
    expect(toggle('Worktree isolation').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Worktree isolation asks first (main checkout board 04)', () => {
  it('turning it off with an unmerged worktree session asks, and saves only on Turn off', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`, undefined, {
      sessions: [{ id: 's1', title: 'Fix it', isolationStatus: 'worktree', branch: 'orbit/fix-it', status: 'IDLE' }],
    });
    await click(toggle('Worktree isolation'));
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain('Turn off worktree isolation?');
    await click(button('Turn off'));
    expect(sent.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PATCH', path: `/workspaces/${ORBIT}`, body: { enableWorktree: false } },
    ]);
  });
});

describe('Delete workspace', () => {
  it('asks with today’s words, then deletes and opens its machine', async () => {
    const { sent } = await mount(`/settings/workspaces/${ORBIT}`);
    await click(button('Delete', row('Delete workspace')));
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(text(dialog)).toContain('Delete workspace “orbit”?');
    expect(text(dialog)).toContain(
      'The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it. To park one you still use, disable it instead.',
    );
    await click(button('Delete', dialog));
    await settle(3);
    expect(sent).toEqual([{ method: 'DELETE', path: `/workspaces/${ORBIT}` }]);
    expect(location).toBe(`/settings/machines/${RUNNER_ID}`);
  });
});

describe('Import Claude Code history', () => {
  it('is not there when the directory has no history to import', async () => {
    vi.mocked(askClaudeHistory).mockResolvedValue(undefined as never);
    vi.mocked(getClaudeHistory).mockResolvedValue({ status: 'done', result: { ...HISTORY, conversations: 0, transcripts: [] } } as never);
    await mount(`/settings/workspaces/${ORBIT}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3200)));
    await settle(3);
    expect($$('.settings-row-title', section('Sessions')).map(text)).not.toContain('Import Claude Code history');
  });

  it('shows at the end of Sessions when there is, and imports what is picked in its drawer', async () => {
    vi.mocked(askClaudeHistory).mockResolvedValue(undefined as never);
    vi.mocked(getClaudeHistory).mockResolvedValue({ status: 'done', result: HISTORY } as never);
    vi.mocked(importClaudeHistory).mockResolvedValue({ imported: 1 } as never);
    await mount(`/settings/workspaces/${ORBIT}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3200)));
    await settle(3);
    expect(vi.mocked(askClaudeHistory)).toHaveBeenCalledWith(RUNNER_ID, '/home/me/src/orbit');
    expect($$('.settings-row-title', section('Sessions')).map(text).at(-1)).toBe('Import Claude Code history');
    await click(button('Import', row('Import Claude Code history')));
    await click($$('.rd-history-choices [role="radio"]', drawer()!)[2]);
    await click($$('button', drawer()!).filter((b) => text(b) === 'Import').at(-1)!);
    expect(vi.mocked(importClaudeHistory)).toHaveBeenCalledWith({ workspaceId: ORBIT, transcripts: HISTORY.transcripts });
  }, 15_000);
});

describe('New workspace', () => {
  it('picks the machine first, then takes today’s create form, then opens the new workspace’s page', async () => {
    const { sent } = await mount('/settings/workspaces/new');
    expect(text(document.querySelector('.settings-header-title'))).toBe('New workspace');
    expect($$('.workspace-machine-choice .settings-row-title').map(text)).toEqual(['gpu-box', 'studio-mac']);
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull();

    await click($$('.workspace-machine-choice')[1]);
    expect(location).toBe(`/settings/workspaces/new?machine=${OTHER_RUNNER_ID}`);
    expect(text(document.querySelector('.settings-header-description'))).toBe('On studio-mac · Change machine');
    const create = () => button('Create');
    expect(create().disabled).toBe(true);
    await type(field('Name'), 'website');
    // Enter in the name creates nothing while the folder is missing.
    await enter(field('Name'));
    expect(create().disabled).toBe(true);
    await type(field('Working directory'), '~/code/website');
    await type(field('Repository URL'), 'github.com/acme/website');
    expect(sent).toEqual([]);
    await click(create());
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/workspaces',
        body: { name: 'website', workDir: '~/code/website', repoUrl: 'github.com/acme/website', runnerId: OTHER_RUNNER_ID },
      },
    ]);
    await settle(3);
    expect(location).toBe(`/settings/workspaces/${MADE}`);
  });

  it('opens on the create form when the machine is named', async () => {
    await mount(`/settings/workspaces/new?machine=${RUNNER_ID}`);
    expect(text(document.querySelector('.settings-header-description'))).toBe('On gpu-box · Change machine');
    expect(field('Working directory').placeholder).toBe('/path/to/project on the runner');
    await click(button('Change machine'));
    expect(location).toBe('/settings/workspaces/new');
  });
});
