// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpAskConversation, HelpAskMessage, HelpAskStuck, HelpArticleMeta, HelpIndex } from '@orbit/shared';
import { HelpDrawerProvider, useHelpDrawer } from '../../lib/helpDrawer';
import { HELP_ERROR_ATTR } from '../../lib/help/drawerArticles';
import { HelpDrawer } from '../HelpDrawer';

/**
 * The help drawer's Ask tab (docs/mocks/help-center board 02 ①–②): suggested questions from the page and its errors,
 * the page chip, Read-only, asking; and an answer with its [n] chips, sources, link buttons and Did this answer it?.
 * The server answers on its own DeepSeek key; here the real drawer runs over a stand-in server.
 */

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

const AT = '2026-11-26T10:00:00.000Z';
const said = (role: HelpAskMessage['role'], text: string, error?: string): HelpAskMessage => ({ role, text, at: AT, ...(error ? { error } : {}) });
/** The Ask GET /api/help/ask/s-ask answers with. */
let conversation: HelpAskConversation = { id: 's-ask', title: '', page: null, status: 'answered', messages: [], createdAt: AT };
const ask = (messages: HelpAskMessage[], status: HelpAskConversation['status'] = 'answered') => {
  conversation = { id: 's-ask', title: messages[0]?.text ?? '', page: null, status, messages, createdAt: AT };
};

const STUCK: HelpAskStuck = {
  admin: { name: 'Alex Li' },
  sentToAdmin: null,
  report: { repository: 'jianghailong-xy/orbit', privateNames: ['payments-api'] },
};
let stuck: HelpAskStuck = STUCK;
let posts: Array<{ url: string; body: unknown }> = [];
/** Did this answer it?'s POST /api/help/feedback bodies, kept apart from `posts`. */
let votes: unknown[] = [];
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // Signed in, as the drawer always is: link buttons resolve for the reader's account.
  localStorage.setItem('orbit_token', 'tok');
  posts = [];
  votes = [];
  stuck = STUCK;
  ask([]);
  // As Chromium answers it: a Promise. An effect that returns it hands React a cleanup that is not a function.
  Element.prototype.scrollIntoView = function scrollIntoView() {
    return Promise.resolve();
  } as unknown as Element['scrollIntoView'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/help/feedback' && init?.method === 'POST') {
        votes.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'POST') posts.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url === '/api/help/ask/s-ask/messages' && init?.method === 'POST') {
        const { content } = JSON.parse(String(init.body)) as { content: string };
        ask([...conversation.messages, said('user', content)], 'working');
      }
      const answer: [number, unknown] =
        url === '/api/help'
          ? [200, INDEX]
          : url === '/api/help/articles/a-machine-shows-offline'
            ? [200, { ...INDEX.articles[4], body: 'A machine that sleeps stops beating.' }]
            : url === '/api/help/ask' && init?.method === 'POST'
              ? [201, { id: 's-ask' }]
              : url === '/api/help/ask/s-ask' || url === '/api/help/ask/s-ask/messages'
                ? [url.endsWith('/messages') ? 201 : 200, conversation]
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

describe('a new question (board 02 ①)', () => {
  it('suggestions from the page and its errors, the page chip, Read-only, and asking: no machine to pick', async () => {
    await mount('/settings/machines', { tab: 'ask' }, true);
    expect(pane().querySelector('.help-ask-runs-on')).toBeNull();
    const suggestions = [...pane().querySelectorAll('.help-ask-suggestion')].map((b) => b.textContent);
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toBe('Why is build-box offline?');
    expect(suggestions).toContain('How do I add a second machine?');
    expect(pane().querySelector('[data-help-ask-chip]')!.textContent).toContain('Settings → Machines');
    expect(pane().querySelector('.help-ask-readonly')!.textContent).toBe('Read-only');

    ask([said('user', 'Why is build-box offline?')], 'working');
    await click(pane().querySelectorAll<HTMLElement>('.help-ask-suggestion')[0]);
    expect(posts).toEqual([{
      url: '/api/help/ask',
      body: {
        content: 'Why is build-box offline?',
        page: { route: '/settings/machines', label: 'Settings → Machines', errors: ['runner.offline'] },
      },
    }]);
    expect(pane().dataset.helpAskSession).toBe('s-ask');
  });

  it('the chip comes off and the question is sent without the page', async () => {
    await mount('/settings/machines');
    await click(button('Remove Settings → Machines')!);
    expect(pane().querySelector('[data-help-ask-chip]')).toBeNull();
    await click(pane().querySelectorAll<HTMLElement>('.help-ask-suggestion')[0]);
    expect((posts[0].body as { page: unknown }).page).toBeNull();
  });

  it('takes a query handed over from the Articles tab, and an article as its chip', async () => {
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
  it('[n] chips opening the article, sources, link buttons, and Did this answer it?', async () => {
    ask([
      said('user', 'Why is build-box offline?'),
      said('assistant', [
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
      ].join('\n')),
    ]);
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-question')!.textContent).toBe('Why is build-box offline?');
    expect(pane().querySelector('.help-ask-meta')).toBeNull();
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
    expect(votes).toEqual([]);
    await click(button('Yes')!);
    // The answer's Yes / No, by the Ask and the question's place in it, and nothing of either's words.
    expect(votes).toEqual([{ kind: 'answer', id: 's-ask:0', helpful: true }]);
    await click(button('No')!);
    expect(votes).toEqual([{ kind: 'answer', id: 's-ask:0', helpful: true }, { kind: 'answer', id: 's-ask:0', helpful: false }]);
    expect(pane().querySelector('[data-help-still-stuck]')).not.toBeNull();

    await click([...pane().querySelectorAll<HTMLElement>('.help-ask-answer-body .help-ask-cite')][2]);
    expect(where().tab).toBe('articles');
    expect(where().slug).toBe('keep-a-machine-awake');
  });

  it('a link button goes where it points, inside Orbit', async () => {
    ask([said('user', 'Where are paused sessions?'), said('assistant', 'They are under [Paused sessions](orbit:/sessions).')]);
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-answer-body')!.textContent).toBe('They are under Paused sessions.');
    await click(pane().querySelector<HTMLElement>('.help-ask-button')!);
    expect(where().path).toBe('/sessions');
  });

  it('while the server answers: Looking…, and no follow-up until it has', async () => {
    ask([said('user', 'Why is build-box offline?')], 'working');
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-working')!.textContent).toBe('Looking…');
    expect(pane().querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask a follow-up"]')).not.toBeNull();
    expect(button('Send')!.disabled).toBe(true);
    expect(button('Yes')).toBeUndefined();
  });

  it('an answer that did not come says why, and the question can be asked again', async () => {
    ask([said('user', 'Why is build-box offline?'), said('assistant', '', 'DeepSeek answered 503. Ask again in a moment.')], 'failed');
    await mount('/', { tab: 'ask', askSession: 's-ask' });
    expect(pane().querySelector('.help-ask-error')!.textContent).toBe('DeepSeek answered 503. Ask again in a moment.');
    expect(button('Yes')).toBeUndefined();
    const box = pane().querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask a follow-up"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'Try again');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Send')!.disabled).toBe(false);
  });
});

describe('Still stuck (board 02 ② right frame, side note 5)', () => {
  const ANSWERED: HelpAskMessage[] = [
    said('user', 'Why is payments-api offline?'),
    said('assistant', [
      'mia-macbook went to sleep [1]. Your key OPENAI_API_KEY=sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12 is fine.',
      '',
      'Sources:',
      '[1] [A machine shows Offline](orbit:/help/machines-and-engines/a-machine-shows-offline)',
    ].join('\n')),
  ];
  const stuckCard = () => pane().querySelector<HTMLElement>('[data-help-still-stuck]');
  const row = (which: string) => pane().querySelector<HTMLButtonElement>(`[data-help-stuck="${which}"]`);

  async function answeredNo() {
    ask(ANSWERED);
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

  it("Tell it what's still wrong puts the cursor in this Ask's composer, and the follow-up is the same Ask's next question", async () => {
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
    expect(posts).toEqual([{ url: '/api/help/ask/s-ask/messages', body: { content: 'It is awake and still shows Offline.' } }]);
    expect(pane().dataset.helpAskSession).toBe('s-ask');
    // The follow-up shows at once, being answered.
    expect([...pane().querySelectorAll('.help-ask-question')].map((q) => q.textContent)).toEqual([
      'Why is payments-api offline?', 'It is awake and still shows Offline.',
    ]);
    expect(pane().querySelector('.help-ask-working')!.textContent).toBe('Looking…');
  });

  it('Ask your admin is not offered to an admin (the server names no admin for one)', async () => {
    stuck = { ...STUCK, admin: null };
    await answeredNo();
    expect(row('retry')).not.toBeNull();
    expect(row('github')).not.toBeNull();
    expect(row('admin')).toBeNull();
    expect(stuckCard()!.textContent).not.toContain('Ask your admin');
  });

  it('Ask your admin has the server send the conversation to the admin as a task, and says so', async () => {
    await answeredNo();
    await click(row('admin')!);
    expect(posts).toEqual([{ url: '/api/help/ask/s-ask/admin', body: undefined }]);
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
    expect(shown).not.toContain('Machine:');
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
