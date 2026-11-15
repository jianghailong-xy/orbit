// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpAskChoices, HelpArticleMeta, HelpIndex } from '@orbit/shared';
import { HelpDrawerProvider, useHelpDrawer } from '../../lib/helpDrawer';
import { HELP_ERROR_ATTR } from '../../lib/help/drawerArticles';
import type { RunEvent } from '../../lib/useSessionStream';
import { HelpDrawer } from '../HelpDrawer';

/**
 * The help drawer's Ask tab (docs/mocks/help-center board 02 ①–③): with no machine that can answer, "Ask needs a
 * machine" with Add a machine and three Get started articles (③A); otherwise Runs on, suggested questions from the
 * page and its errors, the page chip, Read-only, asking; and an answer with its tool line, [n] chips, sources, link
 * buttons and Did this answer it?. The real drawer over a stand-in server; the session's event stream is stood in.
 */

const streamed: { events: RunEvent[]; idle: boolean; streamingText: string } = { events: [], idle: true, streamingText: '' };
vi.mock('../../lib/useSessionStream', () => ({
  useSessionStream: () => streamed,
}));

const meta = (slug: string, over: Partial<HelpArticleMeta> = {}): HelpArticleMeta => ({
  slug,
  title: slug,
  summary: `About ${slug}.`,
  category: 'get-started',
  routes: [],
  errors: [],
  platforms: ['web'],
  common: false,
  updated: '2026-11-14',
  ...over,
});

const INDEX: HelpIndex = {
  categories: [
    { slug: 'get-started', title: 'Get started' },
    { slug: 'machines-and-engines', title: 'Machines & engines' },
  ],
  articles: [
    meta('orbit-in-five-minutes', { title: 'Orbit in five minutes' }),
    meta('add-your-first-machine', { title: 'Add a machine' }),
    meta('connect-a-model', { title: 'Connect a model: subscription or API key' }),
    meta('your-first-task', { title: 'Your first task' }),
    meta('a-machine-shows-offline', {
      title: 'A machine shows Offline', category: 'machines-and-engines', routes: ['/settings/machines'], errors: ['runner.offline'],
    }),
    meta('add-a-second-machine', { title: 'Add a second machine', category: 'machines-and-engines', routes: ['/settings/machines'] }),
  ],
};

const claude = { engine: 'claude', label: 'Claude Code', askable: true, model: null };
const codex = { engine: 'codex', label: 'Codex', askable: false, model: null };
const MIA = { id: 'r-mia', name: 'mia-macbook', online: true, supported: true, engines: [claude, codex] };
const BUILD = { id: 'r-build', name: 'build-box', online: false, supported: true, engines: [claude] };

let choices: HelpAskChoices = { machines: [], remembered: null };
let posts: Array<{ url: string; body: unknown }> = [];
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // Signed in, as the drawer always is: link buttons resolve for the reader's account.
  localStorage.setItem('orbit_token', 'tok');
  posts = [];
  streamed.events = [];
  streamed.idle = true;
  streamed.streamingText = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
      const answer: [number, unknown] =
        url === '/api/help'
          ? [200, INDEX]
          : url === '/api/help/articles/a-machine-shows-offline'
            ? [200, { ...INDEX.articles[4], body: 'A machine that sleeps stops beating.' }]
          : url === '/api/help/ask/choices'
            ? [200, choices]
            : url === '/api/help/ask' && init?.method === 'POST'
              ? [201, { sessionId: 's-ask' }]
              : url === '/api/sessions/s-ask'
                ? [200, { id: 's-ask', title: 'Why is build-box offline?', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', costUsd: 0.01, assignedRunnerId: 'r-mia', engine: 'claude', model: 'Sonnet 5.5' }]
                : url === '/api/users/me'
                  ? [200, { id: 'u1', email: 'ada@example.com', name: 'Ada', createdAt: '', role: 'MEMBER', preferences: {} }]
                  : url === '/api/runners'
                    ? [200, [{ id: 'r-build', name: 'build-box', lastHeartbeatAt: null }]]
                    : url === '/api/workspaces'
                      ? [200, []]
                      : [404, { statusCode: 404, message: `Cannot GET ${url}` }];
      return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function Where() {
  const location = useLocation();
  const help = useHelpDrawer();
  return <div data-testid="where" data-path={location.pathname} data-tab={help.tab} data-slug={help.slug ?? ''} />;
}

function Opener({ at }: { at: Parameters<ReturnType<typeof useHelpDrawer>['openHelp']>[0] }) {
  const help = useHelpDrawer();
  return !help.open ? <button type="button" data-testid="open" onClick={() => help.openHelp(at)} /> : null;
}

async function mount(path: string, at: Parameters<ReturnType<typeof useHelpDrawer>['openHelp']>[0] = { tab: 'ask' }, errorCard = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <HelpDrawerProvider>
            <Routes>
              <Route path="*" element={errorCard ? <div {...{ [HELP_ERROR_ATTR]: 'runner.offline' }}>build-box is offline</div> : <main />} />
            </Routes>
            <Where />
            <Opener at={at} />
            <HelpDrawer />
          </HelpDrawerProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await click(container.querySelector<HTMLElement>('[data-testid="open"]')!);
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await settle();
}

const pane = () => container.querySelector<HTMLElement>('[data-help-pane="ask"]')!;
const where = () => container.querySelector<HTMLElement>('[data-testid="where"]')!.dataset;
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

describe('Ask with no machine that can answer (board 02 ③A)', () => {
  it.each([
    ['no machine at all', { machines: [], remembered: null }],
    ['only an offline machine', { machines: [BUILD], remembered: null }],
  ])('%s: Ask needs a machine, Add a machine, and three Get started articles', async (_what, given) => {
    choices = given as HelpAskChoices;
    await mount('/settings/machines');
    expect(pane().dataset.helpAskState).toBe('needs-machine');
    expect(pane().querySelector('h3')!.textContent).toBe('Ask needs a machine');
    expect(pane().textContent).toContain('An agent answers your questions, and agents run on your machines.');
    expect(pane().querySelector('textarea')).toBeNull();
    const rows = [...pane().querySelectorAll('.help-ask-start-row')].map((r) => r.textContent?.replace(/^\d/u, ''));
    expect(rows).toEqual(['Orbit in five minutes', 'Add a machine', 'Connect a model: subscription or API key']);

    await click(button('Add a machine')!);
    expect(where().path).toBe('/settings/machines/new');
  });

  it('a Get started article opens on the Articles tab', async () => {
    choices = { machines: [], remembered: null };
    await mount('/');
    await click([...pane().querySelectorAll<HTMLElement>('.help-ask-start-row')][1]);
    expect(where().tab).toBe('articles');
    expect(where().slug).toBe('add-your-first-machine');
  });

  it('an online machine on a runner too old to answer read-only says to update it', async () => {
    choices = { machines: [{ ...MIA, supported: false }], remembered: null };
    await mount('/');
    expect(pane().dataset.helpAskState).toBe('needs-machine');
    expect(pane().textContent).toContain('Update the Orbit runner on one');
  });
});

describe('a new question (board 02 ①)', () => {
  it('Runs on, suggestions from the page and its errors, the page chip, Read-only, and asking', async () => {
    choices = { machines: [MIA, BUILD], remembered: null };
    await mount('/settings/machines', { tab: 'ask' }, true);
    expect(pane().querySelector('.help-ask-runs-on')!.textContent).toContain('mia-macbook');
    expect(pane().querySelector('.help-ask-runs-on')!.textContent).toContain('Claude Code');
    const suggestions = [...pane().querySelectorAll('.help-ask-suggestion')].map((b) => b.textContent);
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toBe('Why is build-box offline?');
    expect(suggestions).toContain('How do I add a second machine?');
    expect(pane().querySelector('[data-help-ask-chip]')!.textContent).toContain('Settings → Machines');
    expect(pane().querySelector('.help-ask-readonly')!.textContent).toBe('Read-only');

    await click(pane().querySelectorAll<HTMLElement>('.help-ask-suggestion')[0]);
    expect(posts).toEqual([{
      url: '/api/help/ask',
      body: {
        content: 'Why is build-box offline?',
        runnerId: 'r-mia',
        engine: 'claude',
        page: { route: '/settings/machines', label: 'Settings → Machines', errors: ['runner.offline'] },
      },
    }]);
    expect(pane().dataset.helpAskSession).toBe('s-ask');
  });

  it('the chip comes off and the question is sent without the page', async () => {
    choices = { machines: [MIA], remembered: null };
    await mount('/settings/machines');
    await click(button('Remove Settings → Machines')!);
    expect(pane().querySelector('[data-help-ask-chip]')).toBeNull();
    await click(pane().querySelectorAll<HTMLElement>('.help-ask-suggestion')[0]);
    expect((posts[0].body as { page: unknown }).page).toBeNull();
  });

  it('takes a query handed over from the Articles tab, and an article as its chip', async () => {
    choices = { machines: [MIA], remembered: { runnerId: 'r-mia', engine: 'claude' } };
    await mount('/', { tab: 'ask', query: 'pool account' });
    expect(pane().querySelector('textarea')!.value).toBe('pool account');
    await act(async () => root!.unmount());
    root = null;
    container.remove();

    await mount('/', { slug: 'a-machine-shows-offline' });
    await click(button('Ask instead')!);
    // Ask instead keeps the article the reader was on: it rides as the chip.
    expect(container.querySelector('[data-help-ask-chip]')!.textContent).toContain('Article: A machine shows Offline');
    await click(pane().querySelectorAll<HTMLElement>('.help-ask-suggestion')[0]);
    expect((posts[0].body as { page: unknown }).page).toEqual({
      route: '/help/machines-and-engines/a-machine-shows-offline', label: 'Article: A machine shows Offline', errors: [],
    });
  });
});

describe('an answer (board 02 ②)', () => {
  it('the tool line, [n] chips opening the article, sources, link buttons, and Did this answer it?', async () => {
    choices = { machines: [MIA], remembered: null };
    streamed.events = [
      { seq: 1, type: 'user', payload: { text: 'Why is build-box offline?' } },
      { seq: 2, type: 'tool_use', payload: { id: 't1', name: 'Grep', input: { pattern: 'offline' } } },
      { seq: 3, type: 'tool_use', payload: { id: 't2', name: 'Read', input: { file_path: '/h/articles/machines-and-engines/a-machine-shows-offline.md' } } },
      { seq: 4, type: 'tool_use', payload: { id: 't3', name: 'Read', input: { file_path: '/h/articles/machines-and-engines/keep-a-machine-awake.md' } } },
      { seq: 5, type: 'tool_use', payload: { id: 't4', name: 'mcp__orbit__help_machines', input: {} } },
      {
        seq: 6,
        type: 'assistant',
        payload: {
          text: [
            'build-box last checked in **2 h 4 min ago**, so it most likely went to sleep [1].',
            '',
            '1. Wake build-box [1].',
            '2. Turn off sleep while plugged in [2].',
            '',
            '[Open build-box](orbit:/settings/machines/r-build)',
            '',
            'Sources:',
            '[1] [A machine shows Offline](orbit:/help/machines-and-engines/a-machine-shows-offline)',
            '[2] [Keep a machine awake for long tasks](orbit:/help/machines-and-engines/keep-a-machine-awake)',
          ].join('\n'),
        },
      },
    ];
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-question')!.textContent).toBe('Why is build-box offline?');
    expect(pane().querySelector('.help-ask-tool-line')!.textContent).toContain('Read 2 articles · Checked machines');
    expect(pane().querySelector('.help-ask-meta')!.textContent).toBe('mia-macbook · Claude Code · Sonnet 5.5 · $0.01');
    const chips = [...pane().querySelectorAll<HTMLElement>('.help-ask-answer-body .help-ask-cite')];
    expect(chips.map((c) => c.textContent)).toEqual(['1', '1', '2']);
    expect([...pane().querySelectorAll('.help-ask-source')].map((s) => s.textContent)).toEqual([
      'A machine shows Offline', 'Keep a machine awake for long tasks',
    ]);
    expect(pane().querySelector('.help-ask-answer-body')!.textContent).not.toContain('Sources');
    const open = pane().querySelector<HTMLElement>('.help-ask-button')!;
    expect(open.textContent).toBe('Open build-box ›');
    expect(open.dataset.orbitLink).toBe('orbit:/settings/machines/r-build');

    expect(pane().querySelector('[data-help-still-stuck-slot]')).toBeNull();
    await click(button('No')!);
    expect(pane().querySelector('[data-help-still-stuck-slot]')).not.toBeNull();

    await click([...pane().querySelectorAll<HTMLElement>('.help-ask-answer-body .help-ask-cite')][2]);
    expect(where().tab).toBe('articles');
    expect(where().slug).toBe('keep-a-machine-awake');
  });

  it('a link button goes where it points, inside Orbit', async () => {
    choices = { machines: [MIA], remembered: null };
    streamed.events = [
      { seq: 1, type: 'user', payload: { text: 'Where are paused sessions?' } },
      { seq: 2, type: 'assistant', payload: { text: 'They are under [Paused sessions](orbit:/sessions).' } },
    ];
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-answer-body')!.textContent).toBe('They are under Paused sessions.');
    await click(pane().querySelector<HTMLElement>('.help-ask-button')!);
    expect(where().path).toBe('/sessions');
  });
});
