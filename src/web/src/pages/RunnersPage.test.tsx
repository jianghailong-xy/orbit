// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import type { RunnerAttentionInput } from '../lib/runnerAttention';
import cases from '../lib/runnerAttention.cases.json';
import { RunnersPage } from './RunnersPage';

/**
 * The Runners list's one new line: under a card's tags, the first two things that machine needs a
 * person for, in the words runnerAttention writes — and nothing new on an offline card, whose
 * existing "Offline · last seen" line already says what there is to say.
 *
 * The runners are runnerAttention.cases.json's, the same readings its own test and OrbitKit's run.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

interface AttentionCase {
  name: string;
  input: RunnerAttentionInput;
}
const CASES = cases as unknown as AttentionCase[];
const caseNamed = (prefix: string): AttentionCase => {
  const found = CASES.find((c) => c.name.startsWith(prefix));
  if (!found) throw new Error(`runnerAttention.cases.json has no case starting ${JSON.stringify(prefix)}`);
  return found;
};

/** A case's runner as GET /runners answers it, and its workspaces as GET /workspaces does. */
function machine(prefix: string, id: string) {
  const { runner, workspaces } = caseNamed(prefix).input;
  return {
    runner: { ...runner, id } as Runner,
    workspaces: workspaces.map((workspace) => ({ ...workspace, runnerId: id })),
  };
}

// Every real case is read at the same instant, so the list is too.
const NOW = caseNamed('real wikova').input.nowMs;
const WIKOVA = machine('real wikova', '33zx0JhRhJo8rd25d3qA1');
const WORKSTATION = machine('real workstation:', '33zx0JhRhJo8rd25d3qA2');
const MAC_MINI = machine('real longdeMac-mini.local', '33zx0JhRhJo8rd25d3qA3');
const LAB = machine('everything at once', '33zx0JhRhJo8rd25d3qA4');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What /dl/version.json publishes; null = the deployment has none (it answers the SPA's HTML). */
let published: string | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/dl/version.json' || published === null) throw new Error(`no ${url} here`);
      return { ok: true, json: async () => ({ version: published }) };
    }),
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  published = null;
  document.body.innerHTML = '';
});

async function mount(machines: Array<ReturnType<typeof machine>>) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/runners') return machines.map((m) => m.runner);
    if (path === '/workspaces') return machines.flatMap((m) => m.workspaces);
    return [];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/runners']}>
            <RunnersPage />
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>,
    ),
  );
  // The runners, their workspaces and the published release each arrive on their own.
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const card = (name: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>('.runner-card')].find(
    (el) => el.querySelector('.runner-name')?.textContent === name,
  );
  if (!found) throw new Error(`no runner card named ${name}`);
  return found;
};

describe('the Runners list’s third line', () => {
  it('says what a machine needs, under its tags, in amber with a warning triangle', async () => {
    await mount([WIKOVA, WORKSTATION, MAC_MINI, LAB]);
    const line = card('wikova').querySelector<HTMLElement>('.runner-attention');
    expect(line?.textContent).toBe('Claude weekly limit 98% · Disk 95% full');
    expect(line?.className).toBe('runner-attention warn');
    expect(line?.querySelector('.anticon-warning')).not.toBeNull();
    // A line of its own, after the tags — the rest of the card is as it was.
    expect(line?.previousElementSibling?.className).toBe('runner-tags');
    expect(line?.previousElementSibling?.textContent).toBe('vmi3129740');
    expect(card('wikova').querySelector('.runner-sub')?.textContent).toBe('Online · 4 / 12 running');
    expect(card('wikova').querySelector('.runner-util')).not.toBeNull();
    expect(card('wikova').querySelector('.runner-version')?.textContent).toBe('0.1.197');
  });

  it('is red when what it says already stops sessions, and names only the first two', async () => {
    await mount([LAB]);
    const line = card('lab').querySelector<HTMLElement>('.runner-attention');
    expect(line?.className).toBe('runner-attention bad');
    expect(line?.textContent).toBe('Claude signed out · app checkout stuck in a rebase');
  });

  it('stays away when nothing on the machine depends on what is wrong with it', async () => {
    // Claude is signed out on workstation, and none of its workspaces run on Claude.
    await mount([WORKSTATION]);
    expect(WORKSTATION.runner.engines?.find((e) => e.engine === 'claude')?.auth).toBe('no');
    expect(card('workstation').querySelector('.runner-attention')).toBeNull();
  });

  it('leaves an offline card at its own "Offline · last seen" line', async () => {
    await mount([WIKOVA, MAC_MINI]);
    const mac = card('longdeMac-mini.local');
    expect(mac.querySelector('.runner-sub')?.textContent).toBe('Offline · last seen 14d ago');
    // It can't update itself either, and says so on its page — not as a third line here.
    expect(mac.querySelector('.runner-attention')).toBeNull();
    expect(mac.querySelector('.runner-util')).toBeNull();
    expect(mac.querySelector('.runner-version')?.textContent).toBe('0.1.155');
  });

  it('knows the latest release from /dl/version.json, and does without it when it cannot be read', async () => {
    // Not root and on 0.1.190, with no other runner in the account to say a newer one exists.
    const alone = machine('not root and behind', '33zx0JhRhJo8rd25d3qA5');
    const version = alone.runner.version as string;
    published = caseNamed('not root and behind').input.latestVersion;
    expect(published).not.toBe(version);
    await mount([alone]);
    expect(card(alone.runner.name).querySelector('.runner-attention')?.textContent).toBe('Can’t update itself');

    act(() => root?.unmount());
    host?.remove();
    published = null;
    await mount([alone]);
    expect(card(alone.runner.name).querySelector('.runner-attention')).toBeNull();
  });
});
