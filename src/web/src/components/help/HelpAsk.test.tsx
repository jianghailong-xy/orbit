// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpAskChoices, HelpAskStuck, HelpArticleMeta, HelpIndex } from '@orbit/shared';
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
const STUCK: HelpAskStuck = {
  admin: { name: 'Alex Li' },
  sentToAdmin: null,
  report: {
    repository: 'jianghailong-xy/orbit',
    machine: { name: 'mia-macbook', runnerVersion: '0.1.255', os: 'darwin', lastHeartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString() },
    privateNames: ['payments-api'],
  },
};
let stuck: HelpAskStuck = STUCK;
let posts: Array<{ url: string; body: unknown }> = [];
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // Signed in, as the drawer always is: link buttons resolve for the reader's account.
  localStorage.setItem('orbit_token', 'tok');
  posts = [];
  stuck = STUCK;
  streamed.events = [];
  streamed.idle = true;
  streamed.streamingText = '';
  // As Chromium answers it: a Promise. An effect that returns it hands React a cleanup that is not a function.
  Element.prototype.scrollIntoView = function scrollIntoView() {
    return Promise.resolve();
  } as unknown as Element['scrollIntoView'];
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
                      : url === '/api/help/ask/s-ask/stuck'
                        ? [200, stuck]
                        : url === '/api/help/ask/s-ask/admin' && init?.method === 'POST'
                          ? [201, { taskId: 't-admin', adminName: 'Alex Li', at: '2026-11-16T12:00:00.000Z' }]
                          : url === '/api/sessions/s-ask/turns' && init?.method === 'POST'
                            ? [201, { id: 'turn-2' }]
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

    expect(pane().querySelector('[data-help-still-stuck]')).toBeNull();
    await click(button('No')!);
    expect(pane().querySelector('[data-help-still-stuck]')).not.toBeNull();

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

describe('Still stuck (board 02 ② right frame, side note 5)', () => {
  const ANSWERED: RunEvent[] = [
    { seq: 1, type: 'user', payload: { text: 'Why is payments-api offline?' } },
    {
      seq: 2,
      type: 'assistant',
      payload: {
        text: [
          'mia-macbook went to sleep [1]. Your key OPENAI_API_KEY=sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12 is fine.',
          '',
          'Sources:',
          '[1] [A machine shows Offline](orbit:/help/machines-and-engines/a-machine-shows-offline)',
        ].join('\n'),
      },
    },
  ];
  const stuckCard = () => pane().querySelector<HTMLElement>('[data-help-still-stuck]');
  const row = (which: string) => pane().querySelector<HTMLButtonElement>(`[data-help-stuck="${which}"]`);

  async function answeredNo() {
    choices = { machines: [MIA], remembered: null };
    streamed.events = ANSWERED;
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(stuckCard()).toBeNull();
    await click(button('No')!);
    expect(stuckCard()).not.toBeNull();
  }

  it('offers the three ways out, in the board\'s words', async () => {
    await answeredNo();
    expect(stuckCard()!.textContent).toContain('Still stuck?');
    expect(stuckCard()!.textContent).toContain("Say what's still wrong and the agent tries again, or hand it to a person.");
    expect(row('retry')!.textContent).toContain("Tell it what's still wrong");
    expect(row('admin')!.textContent).toContain('Ask your admin');
    expect(row('admin')!.textContent).toContain('Alex Li · sends this chat as a task');
    expect(row('github')!.textContent).toContain('Report on GitHub');
    expect(row('github')!.textContent).toContain('Opens a prefilled issue. You review it first.');
  });

  it("Tell it what's still wrong puts the cursor in this Ask's composer, and the follow-up is a turn of the same session", async () => {
    await answeredNo();
    await click(row('retry')!);
    const box = pane().querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask a follow-up"]')!;
    expect(document.activeElement).toBe(box);
    expect(pane().dataset.helpAskSession).toBe('s-ask');

    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'It is awake and still shows Offline.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send')!);
    // A turn of this session (sendTurn's door, whichever of its routes it takes), and nothing else.
    expect(posts).toHaveLength(1);
    expect(posts[0].url.startsWith('/api/sessions/s-ask/turns')).toBe(true);
    expect(posts[0].body).toEqual(expect.objectContaining({ content: 'It is awake and still shows Offline.' }));
    // No new Ask was made: the follow-up went to the session already open.
    expect(posts.some((p) => p.url === '/api/help/ask')).toBe(false);
    expect(pane().dataset.helpAskSession).toBe('s-ask');
  });

  it('Ask your admin is not offered to an admin (the server names no admin for one)', async () => {
    stuck = { ...STUCK, admin: null };
    await answeredNo();
    expect(row('retry')).not.toBeNull();
    expect(row('github')).not.toBeNull();
    expect(row('admin')).toBeNull();
    expect(stuckCard()!.textContent).not.toContain('Ask your admin');
  });

  it('Ask your admin sends the conversation to the admin as a task, and says so', async () => {
    await answeredNo();
    await click(row('admin')!);
    expect(posts).toEqual([{
      url: '/api/help/ask/s-ask/admin',
      body: {
        exchanges: [{
          question: 'Why is payments-api offline?',
          answer: 'mia-macbook went to sleep [1]. Your key OPENAI_API_KEY=sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12 is fine.',
        }],
      },
    }]);
    expect(row('admin')!.textContent).toContain('Sent to Alex Li. It is in their tasks.');
    expect(row('admin')!.disabled).toBe(true);
    // Nothing of the removed Waiting on you inbox: no /waiting route is asked for or gone to.
    const asked = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => u);
    expect(asked.some((u) => u.includes('waiting'))).toBe(false);
    expect(where().path).toBe('/');
  });

  it('already sent, it says so and is not sent again', async () => {
    stuck = { ...STUCK, sentToAdmin: { adminName: 'Alex Li', at: '2026-11-15T10:00:00.000Z' } };
    await answeredNo();
    expect(row('admin')!.textContent).toContain('Sent to Alex Li.');
    expect(row('admin')!.disabled).toBe(true);
  });

  it('Report on GitHub shows exactly what the report carries first, then opens it prefilled on the release repository', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); return null; });
    await answeredNo();
    await click(row('github')!);
    expect(opened).toEqual([]);
    const shown = pane().querySelector('[data-help-report-body]')!.textContent!;
    expect(pane().querySelector('[data-help-report]')!.textContent).toContain('What a report includes');
    expect(pane().querySelector('[data-help-report]')!.textContent).toContain('Not included: repository names, file contents, keys');
    expect(shown).toMatch(/^Orbit \S+ · web$/mu);
    expect(shown).toContain('Machine: runner 0.1.255 · macOS');
    expect(shown).toContain('Last heartbeat: 3m ago');
    expect(shown).toContain('Why is [name removed] offline?');
    expect(shown).toContain('mia-macbook went to sleep [1].');
    expect(shown).not.toContain('payments-api');
    expect(shown).not.toContain('sk-proj-');

    await click(button('Open on GitHub')!);
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/jianghailong-xy/orbit/issues/new');
    expect(url.searchParams.get('body')).toBe(shown);
    expect(url.searchParams.get('title')).toBe('Help: Why is [name removed] offline?');
  });
});
