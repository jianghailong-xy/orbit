// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineHealth } from '@orbit/shared';
import { RunnerEngines, summaryOf } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * One Codex account on a runner: the Providers page draws the same row it draws for any engine,
 * plus the way to a second account.
 *
 * The group head and the account rows under it are for two accounts or more. One account is what
 * every machine had before accounts, so none of that may show for it: the card keeps one row per
 * engine, and the Codex row keeps its name, sub-line, status tag, quota and button. What it adds is
 * `Add account`, ahead of that button — without it a machine with Default alone could never get to
 * two. A runner too old to report accounts has one account, not none, and reads the same.
 *
 * Every ROW value is that engine row for the same fixture, held less `Add account`, which has a test
 * of its own. It was first the page before accounts existed (RunnerEngines.tsx at 864cad31c); since
 * 2026-10-02 every engine's row says whether its login can take a session ("Available", where it said
 * "Signed in"), lists each quota window with its reset, gives its version as a number, and offers
 * account maintenance in More. RunnerEngines.test.tsx keeps its own assertions, and this guard sits
 * beside them so single-account rows keep the same information as other engine rows.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it, and a
// placeholder would fail the render rather than an assertion.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

type Auth = RunnerEngineHealth['auth'];

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const runner = (codex: Partial<RunnerEngineHealth>, over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  // Codex's 5h window. The usage probe reads Default, which here is the only account there is.
  planUsage: {
    provider: 'codex',
    primary: { utilization: 62, windowDurationMins: 300 },
  } as PlanUsage,
  engines: [
    health({ engine: 'claude', version: '2.0.44' }),
    health({ engine: 'codex', version: '0.156.0', ...codex }),
    health({ engine: 'kimi', version: '0.41.0' }),
  ],
  ...over,
});

/** Each way a runner can tell the page it has one Codex account. */
const ONE_ACCOUNT: [string, (auth: Auth) => Partial<RunnerEngineHealth>][] = [
  // It lists its accounts, and Default is all there is — path and fingerprint included, neither
  // of which the row said before accounts.
  [
    'Default listed alone',
    (auth) => ({
      accounts: [
        { id: 'default', codexHome: '/root/.codex', auth, fingerprintPrefix: 'cxa1_9f3a41c7' },
      ],
    }),
  ],
  // Older than accounts, so it never mentions them.
  ['a runner too old to report accounts', () => ({})],
  // Says no more than that older runner. The apiserver sends nothing rather than this, but an
  // empty list is still not a machine with zero accounts.
  ['an empty account list', () => ({ accounts: [] })],
];

/** What the Codex row shows: its strings in reading order, the colour of its status tag, how far
 *  its quota bar is filled, and each button as `label · antd type`, with `· disabled` when it is. */
interface CodexRow {
  text: string[];
  tag: string | null;
  bar: string | null;
  buttons: string[];
}

/** Each state of the one account, and what its engine row says for it. */
const ROW: {
  state: string;
  auth: Auth;
  over?: Partial<Runner>;
  codex: CodexRow;
  count: string;
  folded: string;
}[] = [
  {
    state: 'signed in',
    auth: 'yes',
    codex: {
      text: ['Codex', '0.156.0', 'Available', '5h limit', '62%'],
      tag: 'green',
      bar: '62%',
      buttons: ['More actions · text'],
    },
    count: '1 runner · 3 signed in',
    folded: 'All signed in',
  },
  {
    state: 'signed out',
    auth: 'no',
    codex: {
      text: ['Codex', '0.156.0', 'Signed out', 'Sign in to see quota', 'Sign in'],
      tag: 'orange',
      bar: null,
      buttons: ['Sign in · primary'],
    },
    count: '1 runner · 2 signed in',
    folded: '2 of 3 signed in',
  },
  {
    state: "the CLI wouldn't say",
    auth: 'unknown',
    codex: {
      text: ['Codex', "0.156.0 · the CLI wouldn't say", 'Unknown', '—', 'Sign in'],
      tag: 'default',
      bar: null,
      buttons: ['Sign in · primary'],
    },
    count: '1 runner · 2 signed in',
    folded: '2 of 3 signed in',
  },
  {
    state: 'signed in, on a runner that is offline',
    auth: 'yes',
    over: { online: false },
    codex: {
      text: ['Codex', '0.156.0', 'Available', '5h limit', '62%'],
      tag: 'green',
      bar: '62%',
      buttons: ['More actions · text'],
    },
    count: '1 runner · 3 signed in',
    folded: 'All signed in',
  },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

// Tells React this is a test that drives updates through act(), so it flushes them there.
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

/** Mount the section over these runners, their cards open, the way a user who opened them sees it. */
function mount(runners: Runner[]) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  apiMock.mockImplementation(async (path: string) => (path === '/runners' ? runners : null));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/providers']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

/** Every string under an element, in reading order: one per element holding text of its own, so it
 *  reads the same however React splits a string into text nodes. */
const strings = (scope: Element) =>
  [scope, ...scope.querySelectorAll('*')]
    .map((el) =>
      [...el.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim(),
    )
    .filter(Boolean);

/** Which antd preset an element was drawn with: `ant-tag-green` is green, `ant-btn-text` text. */
const preset = (el: Element, pattern: RegExp) =>
  [...el.classList].map((c) => pattern.exec(c)?.[1]).find(Boolean) ?? null;

/** A button as `label · antd type`, with `· disabled` when it is — the label being the name of a
 *  mark that has no words (Re-sign in). */
const described = (button: HTMLButtonElement) =>
  [
    button.textContent?.trim() || button.getAttribute('aria-label'),
    preset(button, /^ant-btn-(primary|default|dashed|text|link)$/),
    button.disabled && 'disabled',
  ]
    .filter(Boolean)
    .join(' · ');

const addAccount = (row: Element) =>
  [...row.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Add account');

function codexRowOf(page: HTMLElement): HTMLElement {
  const row = [...page.querySelectorAll<HTMLElement>('.re-row')].find(
    (el) => el.querySelector('.re-name')?.textContent === 'Codex',
  );
  if (!row) throw new Error(`no Codex row in ${page.textContent}`);
  return row;
}

/** The Codex row as it reads less `Add account`: one button taken out of a copy, and only that one. */
function codexRow(page: HTMLElement): CodexRow {
  const row = codexRowOf(page).cloneNode(true) as HTMLElement;
  addAccount(row)?.remove();
  const tag = row.querySelector('.ant-tag');
  return {
    text: strings(row),
    tag: tag && preset(tag, /^ant-tag-(?!filled$|outlined$|solid$|borderless$)(.+)$/),
    bar: row.querySelector<HTMLElement>('.runner-util-fill')?.style.width ?? null,
    buttons: [...row.querySelectorAll('button')].map(described),
  };
}

describe.each(ONE_ACCOUNT)('one Codex account — %s', (_, accountsOf) => {
  it.each(ROW)(
    '$state: the Codex row is the row every engine has, and nothing of a group',
    ({ auth, over, codex, count, folded }) => {
      const box = runner({ auth, ...accountsOf(auth) }, over);
      const page = mount([box]);

      // No account rows: none of the marks an account row or its group head carries...
      expect(page.querySelectorAll('.re-acct, .re-grp, .re-rail, .re-chip')).toHaveLength(0);
      // ...and no row of any other kind either: the card is its head and one row per engine.
      expect([...page.querySelector('.re-card')!.children].map((el) => el.className)).toEqual([
        're-head',
        're-row',
        're-row',
        're-row',
        're-row',
      ]);
      // Pause is available inside More and adds no visible button or text to this row.
      expect(codexRow(page)).toEqual(codex);
      // One account counts once, as the engine always did: on the section, and on a folded card.
      expect(page.querySelector('.re-sec-count')?.textContent).toBe(count);
      expect(summaryOf(box)).toBe(folded);
    },
  );

  it.each(ROW)(
    '$state: Add account leads the Codex row, and opens the name for a second account',
    async ({ auth, over, codex }) => {
      const page = mount([runner({ auth, ...accountsOf(auth) }, over)]);
      const row = codexRowOf(page);
      const offline = over?.online === false;

      // The group head's button, ahead of the row's own — and, like that one, not pressable while
      // the machine is offline.
      expect([...row.querySelectorAll<HTMLButtonElement>('.re-act button')].map(described)).toEqual([
        offline ? 'Add account · default · disabled' : 'Add account · default',
        ...codex.buttons,
      ]);
      if (offline) return;

      await act(async () => {
        addAccount(row)!.click();
      });
      // The panel the group head opens — a name, then the same sign-in as every other here — under
      // this row and no other. Still one account: no head, no account rows.
      expect(page.querySelectorAll('.re-add input')).toHaveLength(1);
      expect(row.querySelector('.re-add input')).not.toBeNull();
      expect(page.querySelectorAll('.re-acct, .re-grp, .re-rail, .re-chip')).toHaveLength(0);
    },
  );
});
