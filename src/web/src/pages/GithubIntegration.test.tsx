// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubAppSettings, GithubIntegration } from '@orbit/shared';

/**
 * GitHub-backed workspaces P0, the Web side of board 02 (docs/github-workspace-design.md §8): the GitHub App card in
 * Admin → Integrations, and Settings → Integrations → GitHub, with the summary its Settings row shows.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { GithubAppCard, githubConnectedText } = await import('./GithubAppCard');
const { GithubIntegrationPage, disconnectWarning } = await import('./GithubIntegrationPage');
const { installationText, installationSettingsUrl } = await import('../lib/githubIntegration');

let admin: GithubAppSettings;
let integration: GithubIntegration;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactNode, at = '/'): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return container;
}

const connected: GithubIntegration = {
  available: true,
  connected: true,
  login: 'octo-dev',
  connectedAt: '2026-11-11T08:00:00.000Z',
  needsReconnect: false,
  installations: [
    { id: 71, account: 'octo-dev', type: 'User', repositorySelection: 'selected', repositoryCount: 3 },
    { id: 72, account: 'orbit-labs', type: 'Organization', repositorySelection: 'all', repositoryCount: 11 },
  ],
  installUrl: 'https://github.com/apps/orbit-example/installations/new',
  workspaceCount: 2,
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(toast)) fn.mockReset();
  admin = {
    enabled: true, appId: '1043271', slug: 'orbit-example', clientId: 'Iv23liQ8xk2aPz7mHc1d', secretSaved: true, keySaved: true,
    secretUnreadable: false, callbackUrl: 'https://orbit.example.com/api/integrations/github/callback', connectedUsers: 7, clonedWorkspaces: 12,
  };
  integration = structuredClone(connected);
  calls = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ method, path, body: options.body });
    if (path === '/admin/integrations/github') return method === 'PUT' ? { ...admin, enabled: (options.body as { enabled: boolean }).enabled } : admin;
    if (path === '/integrations/github' && method === 'GET') return integration;
    if (path === '/integrations/github' && method === 'DELETE') return { ...integration, connected: false, login: null, installations: [] };
    throw new Error(`the stand-in server has no ${method} ${path}`);
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
});

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('Admin → Integrations → GitHub App', () => {
  it('draws the saved App as board 02 does, with secrets write-only', async () => {
    const page = await mount(<GithubAppCard />);
    const text = page.textContent ?? '';
    expect(text).toContain('Let people clone from GitHub');
    expect(text).toContain('Checked with GitHub when you save: orbit-example (github.com/apps/orbit-example)');
    expect(text).toContain('A key is saved (.pem)');
    expect(text).toContain('https://orbit.example.com/api/integrations/github/callback');
    expect(text).toContain('7 people have connected GitHub · 12 workspaces were cloned');
    expect(text).toContain('Register the app on GitHub');
    expect(text).toContain('Contents: Read and write');
    expect((page.querySelector('input[type="password"]') as HTMLInputElement).placeholder).toBe('A secret is saved. Enter a new one to replace it.');
    expect(button(page, 'Save')!.disabled).toBe(true);
  });

  it('saves a change without the secrets it was not given', async () => {
    const page = await mount(<GithubAppCard />);
    await act(async () => (page.querySelector('[role="switch"]') as HTMLButtonElement).click());
    await act(async () => button(page, 'Save')!.click());
    await settle();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/admin/integrations/github', body: { enabled: false, appId: '1043271', clientId: 'Iv23liQ8xk2aPz7mHc1d' } },
    ]);
  });

  it('after a key rotation, says so and reads Off', async () => {
    admin.secretUnreadable = true;
    const page = await mount(<GithubAppCard />);
    expect(page.textContent).toContain("The saved secret can't be read. Enter it again.");
    expect(page.querySelector('.orbit-badge')!.textContent).toBe('Off');
  });

  it('counts people and workspaces', () => {
    expect(githubConnectedText({ ...admin, connectedUsers: 1, clonedWorkspaces: 1 })).toBe('1 person has connected GitHub · 1 workspace was cloned');
    expect(githubConnectedText({ ...admin, connectedUsers: 0, clonedWorkspaces: 0 })).toBe('Nobody has connected GitHub · 0 workspaces were cloned');
  });
});

describe('Settings → Integrations → GitHub', () => {
  it('describes each installation and where it is configured', () => {
    expect(installationText(connected.installations![0])).toBe('Personal account · 3 selected repositories');
    expect(installationText(connected.installations![1])).toBe('Organization · All repositories (11)');
    expect(installationSettingsUrl(connected.installations![1])).toBe('https://github.com/organizations/orbit-labs/settings/installations/72');
    expect(disconnectWarning(2)).toBe('2 workspaces keep their folders. Clones and landings that need GitHub will stop until you connect again.');
  });

  it('lists the account and where the app is installed, and disconnects', async () => {
    const page = await mount(<GithubIntegrationPage />, '/settings/integrations/github');
    const text = page.textContent ?? '';
    expect(text).toContain('@octo-dev');
    expect(text).toContain('Connected');
    expect(text).toContain('Orbit sees only the repositories you install its app on.');
    expect(text).toContain('Where Orbit’s app is installed');
    expect(text).toContain('Install on another account');
    expect([...page.querySelectorAll('a')].filter((a) => a.textContent?.includes('Configure on GitHub')).map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/settings/installations/71',
      'https://github.com/organizations/orbit-labs/settings/installations/72',
    ]);
    await act(async () => button(page, 'Disconnect')!.click());
    await settle();
    expect(document.body.textContent).toContain(disconnectWarning(2));
  });

  it('asks to sign in again when GitHub stopped taking the tokens', async () => {
    integration.needsReconnect = true;
    const page = await mount(<GithubIntegrationPage />, '/settings/integrations/github');
    expect(page.textContent).toContain('@octo-dev needs to sign in again');
    expect(button(page, 'Reconnect')).toBeTruthy();
  });

  it('says why a connection came back refused', async () => {
    const page = await mount(<GithubIntegrationPage />, '/settings/integrations/github?github_error=GITHUB_ACCOUNT_IN_USE');
    expect(page.textContent).toContain('That GitHub account is already connected to another Orbit account.');
  });

  it('offers no Connect where no administrator set GitHub up', async () => {
    integration = { ...connected, available: false, connected: false, login: null, installations: [], installUrl: null, workspaceCount: 0 };
    const page = await mount(<GithubIntegrationPage />, '/settings/integrations/github');
    expect(page.textContent).toContain('Not set up on this Orbit — ask an administrator.');
    expect(button(page, 'Connect')).toBeUndefined();
  });
});
