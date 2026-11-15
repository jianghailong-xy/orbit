// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import start from '../../../shared/src/wiki-start.fixture.json';
import { resetSnoozesForTest, type OwnerRequest } from '../lib/ownerRequests';
import { OwnerRequestCard, OwnerRequestResolved } from './OwnerRequestCard';

/**
 * The card an agent files for a wiki (docs/wiki-explicit-creation-design.md §3.6, board 46 part 3): what it will make
 * under Repository / Reads from / Maintenance, read from the shared fixture's `wikiCreateCard` cases, and its three
 * buttons — Create wiki through the owner's door, Change settings… into the Create wiki form on the filing workspace,
 * Not for this repository as the decline. What reaches the server is the claim: the api mock keeps every write.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-12T09:00:00.000Z');
const UP = '0196e300-0000-7000-8000-0000000000d1';
const DOWN = '0196e300-0000-7000-8000-0000000000d2';
const uuid = (index: number) => `0196e300-0000-7000-8000-0000000000${(0xa0 + index).toString(16)}`;
/** The fixture's workspaces under ids the server would give them. */
const ID: Record<string, string> = Object.fromEntries(start.workspaces.choices.map((choice, index) => [choice.id, uuid(index)]));
const WORKSPACES = start.workspaces.choices.map((choice) => {
  const [name, runner] = choice.label.split(' · ');
  return { id: ID[choice.id], name, repoUrl: choice.repoUrl, runner: { id: choice.online ? UP : DOWN, name: runner } };
});
const { labels, buttons, cases } = start.wikiCreateCard;

function wikiRequest(over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: 'req-wiki',
    kind: 'WIKI_CREATE',
    state: 'PENDING',
    title: 'Create a wiki for billing-api?',
    why: 'You asked for one here.',
    blocksTaskIds: [],
    ifUnanswered: null,
    options: null,
    recommendedOption: null,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: null,
    repoUrlNorm: 'github.com/acme/billing-api',
    workspaceId: ID.ba,
    expiresAt: null,
    askedBySessionId: '34uOqHiF7f3VmoARfQg6y',
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;
let writes: Array<{ path: string; body: unknown }> = [];

async function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => words(b) === name);
  if (!found) throw new Error(`no button named ${name}: ${host.textContent}`);
  return found;
};
const facts = (): Array<[string, string]> => {
  const terms = [...host.querySelectorAll('.owner-request-facts dt')];
  return terms.map((dt) => [words(dt), words(dt.nextElementSibling)]);
};
async function press(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSnoozesForTest();
  writes = [];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') {
      writes.push({ path, body: init.body });
      if (path.endsWith('/create-wiki')) {
        return wikiRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', answer: { spaceId: 's1', name: 'billing-api' } }) as never;
      }
      if (path.endsWith('/decline')) {
        return wikiRequest({ state: 'DECLINED', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', resolutionNote: (init.body as { reason: string }).reason }) as never;
      }
    }
    if (path === '/workspaces') return WORKSPACES as never;
    if (path === '/runners') return [{ id: UP, name: 'build-01', online: true }, { id: DOWN, name: 'build-02', online: false }] as never;
    if (path === '/wiki/spaces') return [] as never;
    if (path.startsWith('/owner-requests?')) return { requests: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

describe('the WIKI_CREATE card', () => {
  for (const row of cases) {
    it(`says what it makes: ${row.request.repoUrlNorm} read from ${row.request.workspaceId}`, async () => {
      await mount(
        <OwnerRequestCard
          now={NOW}
          request={wikiRequest({ repoUrlNorm: row.request.repoUrlNorm, workspaceId: ID[row.request.workspaceId!] ?? row.request.workspaceId })}
        />,
      );
      const { facts: expected } = row;
      expect(facts()).toEqual([
        [labels.repository, expected.repository!],
        [labels.readsFrom, `${expected.readsFrom ?? '—'}${expected.offline ? 'offline' : ''}`],
        [labels.maintenance, expected.maintenance],
      ]);
    });
  }

  it('offers its three buttons in order, and nothing else to press', async () => {
    await mount(<OwnerRequestCard now={NOW} request={wikiRequest()} />);
    const pressable = [...host.querySelectorAll('.owner-request-actions button')].map(words);
    expect(pressable).toEqual(buttons);
    expect(words(host.querySelector('.owner-request-kind'))).toBe('WIKI');
  });

  it('makes the wiki through the owner’s door on Create wiki, and reads as done', async () => {
    await mount(<OwnerRequestCard now={NOW} request={wikiRequest()} />);
    await press(button(buttons[0]!));
    expect(writes).toEqual([{ path: '/owner-requests/req-wiki/create-wiki', body: {} }]);
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Created the wiki billing-api');
  });

  it('opens the Create wiki form on the filing workspace from Change settings…', async () => {
    await mount(<OwnerRequestCard now={NOW} request={wikiRequest({ workspaceId: ID.eu, repoUrlNorm: 'github.com/acme/shop-cli' })} />);
    await press(button(buttons[1]!));
    const dialog = document.querySelector('.wk-setup-dialog')!;
    expect(words(dialog.querySelector('.orbit-overlay-title'))).toBe('Create wiki');
    expect(words(document.getElementById('wk-setup-workspace'))).toBe('shop-cli @ EU · build-02');
    expect(writes).toEqual([]);
  });

  it('declines in one press with Not for this repository', async () => {
    await mount(<OwnerRequestCard now={NOW} request={wikiRequest()} />);
    await press(button(buttons[2]!));
    expect(writes).toEqual([{ path: '/owner-requests/req-wiki/decline', body: { reason: 'Not for this repository' } }]);
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Declined: “Not for this repository”');
  });

  it('shows the server’s refusal and keeps the card', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new Error('This repository already has a wiki.');
      if (path === '/workspaces') return WORKSPACES as never;
      if (path === '/runners') return [] as never;
      if (path === '/wiki/spaces') return [] as never;
      return { requests: [] } as never;
    });
    await mount(<OwnerRequestCard now={NOW} request={wikiRequest()} />);
    await press(button(buttons[0]!));
    expect(words(host.querySelector('[role="alert"]'))).toContain('This repository already has a wiki.');
    expect(button(buttons[0]!)).toBeTruthy();
  });

  it('names the wiki it made once it has ended', async () => {
    await mount(
      <OwnerRequestResolved
        now={NOW}
        request={wikiRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', answer: { spaceId: 's1', name: 'lfs-builder' } })}
      />,
    );
    expect(words(host.querySelector('.owner-request-resolved-outcome'))).toBe('Created the wiki lfs-builder');
  });
});
