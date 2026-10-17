import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { WikiDocsDirectory, WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion } from '@orbit/shared';
import { ThemeProvider } from '../lib/theme';
import type { WikiChangeset, WikiEntry, WikiSpaceRow, WikiSpaceWithUsage, WikiTimeline } from '../lib/wiki';
import { wikiSeenKey } from '../lib/wiki';
import { wikiPlanPending } from '../lib/wikiPlan';
import { wikiProposalsWaiting, wikiWaiting } from '../lib/wikiSpace';
import { WikiPage } from '../pages/WikiPage';
import { TasksSidePanel } from './TasksSidePanel';

// The sidebar and the page read the browser as they render — the theme's media query, the sidebar's
// width, the "last looked" stamp — so the browser is stubbed before the imports are evaluated.
const browser = vi.hoisted(() => {
  const noop = (): void => undefined;
  const local = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
    removeItem: (key: string) => void local.delete(key),
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: noop, removeItem: noop });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    location: { host: 'localhost', origin: 'http://localhost', pathname: '/' },
  });
  return { local };
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * Activity (design §12.3.2–§12.3.3, mocks 31 ② ⑤ and 33 ④), over two spaces whose plans both wait on
 * the owner: orbit has a proposal and a plan draft to confirm, wikova two proposals and two plan
 * changes, wikids nothing.
 *
 * WHAT IT HOLDS: the home's blocks in the home's order — the status row, Review's banner or card, the
 * plan's, Recent decisions (read by kind, never out of the newest 200), Recently changed with what is new
 * since the reader last looked, Agents used the wiki.
 *
 * AND ONE NUMBER IN FOUR PLACES: the sidebar's Wiki row, the head's Activity badge and the sum of
 * Activity's amber banners are every space's proposals and plan things waiting; Activity's first banner
 * and Review's head are the proposals alone, the other spaces' share said on the banner's line.
 */

function planFixture(): { versions: { v1: WikiPlanVersion; v2: WikiPlanVersion }; proposals: WikiPlanProposal[]; jobs: Record<string, WikiPlanJob> } {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-docs.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')).plan;
}

const PLAN = planFixture();

/** The server-execution fixture (P9): the Plan card's line while the server executes this account's wiki. */
function serverFixture(): { plan: { note: string } } {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-server-execution.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-server-execution.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-server-execution.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const SERVER = serverFixture();
const ORBIT = '0196e100-0000-7000-8000-000000000001';
const WIKOVA = '0196e100-0000-7000-8000-000000000002';
const WIKIDS = '0196e100-0000-7000-8000-000000000003';
const HOUR = 3_600_000;
const NOW = Date.now();
/** The reader last looked at orbit five hours ago: the run three hours ago is new, the change a day ago is not. */
const SEEN = NOW - 5 * HOUR;

/** orbit's plan waits on a draft to confirm; wikova's on its two changes — what each space's planWaiting says. */
const ORBIT_PLAN: WikiPlanState = { spaceId: ORBIT, confirmed: PLAN.versions.v1, draft: PLAN.versions.v2, proposals: [], job: PLAN.jobs.revised };
const WIKOVA_PLAN: WikiPlanState = { spaceId: WIKOVA, confirmed: PLAN.versions.v1, draft: null, proposals: PLAN.proposals, job: PLAN.jobs.built };

function row(id: string, repo: string, pendingOps: number, planWaiting: number, written: number): WikiSpaceRow {
  const slug = repo.split('/').pop()!;
  return {
    id,
    slug,
    title: `github-com-jianghailong-xy-${slug}`,
    repoUrlNorm: repo,
    rootCommitSha: 'b'.repeat(40),
    settings: { push: true, autoAcceptReinforce: true },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    pendingOps,
    planWaiting,
    workspaceIds: [],
    docs: { written, total: 35 },
  };
}

const SPACES: WikiSpaceRow[] = [
  row(ORBIT, 'github.com/jianghailong-xy/orbit', 1, 1, 5),
  row(WIKOVA, 'github.com/jianghailong-xy/wikova', 2, 2, 12),
  row(WIKIDS, 'github.com/jianghailong-xy/wikids', 0, 0, 0),
];

const DECISION = {
  id: '0196e100-0000-7000-8000-0000000000d1',
  spaceId: ORBIT,
  kind: 'decision',
  status: 'active',
  trust: 'owner',
  currentRevision: 1,
  title: 'Remove wiki auto-push rather than reshape it',
  summary: 'The whole auto-attach feature is gone.',
  fields: {},
  topics: ['wiki'],
  aliases: [],
  anchors: [],
  anchorState: 'unchecked',
  anchorCheckedRef: null,
  anchorCheckedAt: null,
  tainted: false,
  challenged: false,
  unsupported: false,
  pinned: false,
  supersedesId: null,
  supersededById: null,
  validFrom: '2026-10-06T00:00:00.000Z',
  validTo: null,
  recordedAt: '2026-10-06T00:00:00.000Z',
  retiredAt: null,
} as unknown as WikiEntry;

const TIMELINE: WikiTimeline = {
  items: [
    {
      opId: 'op-run',
      op: 'add',
      decision: 'accepted',
      origin: 'maintenance',
      at: new Date(NOW - 3 * HOUR).toISOString(),
      entryId: null,
      title: 'ScheduleWakeup is lost on engine recycle',
      kind: 'pitfall',
      status: 'active',
      trust: 'auto',
      supersededById: null,
      supersededByTitle: null,
      reason: null,
      appliedByMode: 'automatic',
      changesetId: '0196e100-0000-7000-8000-0000000000c1',
      changesetAppliedByMode: 'automatic',
    },
    {
      opId: 'op-old',
      op: 'add',
      decision: 'accepted',
      origin: 'agent',
      at: new Date(NOW - 24 * HOUR).toISOString(),
      entryId: null,
      title: 'Cut a release with release.sh from the main checkout',
      kind: 'recipe',
      status: 'active',
      trust: 'confirmed',
      supersededById: null,
      supersededByTitle: null,
      reason: null,
    },
  ],
};

let serial = 0;
/** A changeset of one session, its ops all waiting for the owner. */
function changeset(spaceId: string, titles: string[]): WikiChangeset {
  serial += 1;
  return {
    id: `cs-${serial}`,
    spaceId,
    origin: 'agent',
    sessionId: `0196e100-0000-7000-8000-0000000005${String(serial).padStart(2, '0')}`,
    toolCallId: null,
    rationale: 'a session',
    status: 'pending',
    createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    decidedAt: null,
    expiresAt: null,
    ops: titles.map((title, index) => ({
      id: `op-${serial}-${index}`,
      changesetId: `cs-${serial}`,
      seq: index,
      op: 'add',
      entryId: null,
      baseRevision: null,
      payload: { entry: { kind: 'pitfall', title } },
      similar: [],
      tainted: false,
      decision: 'pending',
      decisionReason: null,
      decisionNote: null,
      resultEntryId: null,
      resultRevision: null,
      decidedAt: null,
    })),
  } as unknown as WikiChangeset;
}

const ORBIT_REVIEW = [changeset(ORBIT, ['Secret redaction lets ENV_VAR=value secrets through'])];
const WIKOVA_REVIEW = [changeset(WIKOVA, ['A wikova pitfall', 'A wikova recipe'])];

function client(spaces: WikiSpaceRow[] = SPACES): QueryClient {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['wiki', 'spaces'], spaces);
  cache.setQueryData(['wiki', 'space', ORBIT], { ...spaces[0], usage: { days: 7, sessionsPushed: 692, searches: 0, gets: 0, entries: [{ entryId: '0196e100-0000-7000-8000-0000000000e1', title: 'ScheduleWakeup is lost on engine recycle', total: 1753, pushed: 1753, searched: 0, fetched: 0 }] } } satisfies WikiSpaceWithUsage);
  // The newest 200 entries of every kind hold no decision: Recent decisions has to read its own kind.
  cache.setQueryData(['wiki', 'space', ORBIT, 'entries'], []);
  cache.setQueryData(['wiki', 'space', ORBIT, 'entries', 'decision', 4], [DECISION]);
  cache.setQueryData(['wiki', 'space', ORBIT, 'timeline'], TIMELINE);
  cache.setQueryData(['wiki', 'space', ORBIT, 'plan'], ORBIT_PLAN);
  cache.setQueryData(['wiki', 'space', WIKOVA, 'plan'], WIKOVA_PLAN);
  cache.setQueryData(['wiki', 'review', ORBIT], ORBIT_REVIEW);
  cache.setQueryData(['wiki', 'review', null], [...ORBIT_REVIEW, ...WIKOVA_REVIEW]);
  // The sidebar's own reads.
  cache.setQueryData(['user', 'me'], { id: 'user', email: 'a@b.c', name: 'wikova', createdAt: '', role: 'MEMBER' });
  cache.setQueryData(['workspaces'], []);
  cache.setQueryData(['runners'], []);
  cache.setQueryData(['session-counts'], []);
  cache.setQueryData(['tasklists'], []);
  return cache;
}

function wiki(path: string, cache: QueryClient = client()): string {
  browser.local.set(wikiSeenKey('orbit', 'home'), String(SEEN));
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/wiki/review" element={<WikiPage route="review" />} />
          <Route path="/wiki/:space" element={<WikiPage route="home" />} />
          <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function sidebar(cache: QueryClient = client()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/wiki/orbit/activity']}>
          <TasksSidePanel />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** Every amber banner's part of the number: `data-waiting` on the banner. Blue ones carry none. */
function amberBanners(html: string): Array<{ text: string; waiting: number }> {
  return [...html.matchAll(/<a [^>]*class="wk-banner[^"]*"[^>]*data-waiting="(\d+)"[^>]*>[\s\S]*?<span class="t">([^<]*)<\/span>/g)].map(
    (match) => ({ waiting: Number(match[1]), text: match[2] }),
  );
}

const at = (html: string, needle: string): number => {
  const index = html.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

describe('Activity', () => {
  it('draws the home’s blocks in the home’s order, under Review’s head', () => {
    const html = wiki('/wiki/orbit/activity');
    const order = [
      'class="wk-crumb wk-crumb--back"',
      '<h1 class="page-title">Activity</h1>',
      '<span class="wk-space-tag">orbit</span>',
      'class="project-integration wk-status-row"',
      '>3 proposals to review · 2 in wikova<',
      '>Plan draft ready to confirm<',
      '>2 plan changes to review · in wikova<',
      'wk-review-card',
      'wk-plan-card',
      '>Recent decisions<',
      '>Recently changed<',
      '>Agents used the wiki<',
    ].map((needle) => at(html, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The status row moved under the title: the frame draws none of its own here.
    expect(html.match(/class="project-integration wk-status-row"/g)).toHaveLength(1);
    // `← Wiki` goes back to the space's home; the page is its own, not a reading page.
    expect(html).toContain('href="/wiki/orbit"');
    expect(html).toContain('class="wk-page wk-page--activity"');
    // The directory stands beside it with none of its rows lit.
    expect(html).toContain('class="wk-dir-col"');
    expect(html).not.toMatch(/wk-toc-item[^"]* active/);
    // Principles are content: they stay on the home.
    expect(html).not.toContain('>Principles<');
  });

  it('draws the server’s runs after Review and Plan while the server runs the wiki, and nothing of them under runner (mock 35 ④)', () => {
    const cache = client();
    const maintenance = {
      look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null,
      lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null,
    };
    cache.setQueryData(['wiki', 'space', ORBIT, 'health'], {
      spaceId: ORBIT, entries: 3, maintenance,
      executor: { mode: 'canary', serverExecutes: true },
      systemModel: { state: 'up', model: 'qwen3.8-27b-fp8', since: null, checkedAt: null, workerSeenAt: null },
    });
    cache.setQueryData(['wiki', 'space', ORBIT, 'jobs'], {
      spaceId: ORBIT,
      jobs: [{
        id: 'job-1', kind: 'verify', state: 'succeeded', waitingFor: null, priority: 1, attempts: 0, createdAt: new Date(NOW - HOUR).toISOString(),
        updatedAt: new Date(NOW - HOUR).toISOString(), startedAt: new Date(NOW - HOUR).toISOString(), endedAt: new Date(NOW - HOUR + 48_000).toISOString(),
        nextAttemptAt: null, failureKind: null, error: null, ahead: null, progress: null,
        calls: { total: 4, queued: 0, running: 0, succeeded: 4, failed: 0, cancelled: 0, inputTokens: 5000, outputTokens: 1120 }, nextCall: null, requests: [],
      }],
    });
    const html = wiki('/wiki/orbit/activity', cache);
    const order = ['wk-review-card', 'wk-plan-card', 'wk-jobs-card', '>Runs<', '>Verification<', '>Recent decisions<', '>Recently changed<']
      .map((needle) => at(html, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('<b>Done</b> · 4 calls · 6,120 tokens · took 48s');
    // Under runner: no card at all.
    expect(wiki('/wiki/orbit/activity')).not.toContain('wk-jobs-card');
  });

  it('names the System model under Draft plan while the server runs the wiki, and the provider under runner (mock 35’s Plan card)', () => {
    const spaces = [row(ORBIT, 'github.com/jianghailong-xy/orbit', 0, 0, 0)];
    spaces[0].settings = { ...spaces[0].settings, maintenance: { provider: 'local-vllm', workspaceId: null } };
    const cache = client(spaces);
    cache.setQueryData(['wiki', 'space', ORBIT, 'plan'], { spaceId: ORBIT, confirmed: null, draft: null, proposals: [], job: null } satisfies WikiPlanState);
    const note = (html: string): string => card(html, 'wk-plan-card').match(/<span class="hint">([^<]*)<\/span>/)![1];
    // Under runner the line is the provider maintenance is pinned to, word for word as before.
    expect(note(wiki('/wiki/orbit/activity', cache))).toBe('local-vllm · about 1–2 hours');
    // The server drafts with the System model (`health.executor.serverExecutes`): the shared fixture's line.
    cache.setQueryData(['wiki', 'space', ORBIT, 'health'], {
      spaceId: ORBIT, entries: 0,
      maintenance: {
        look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null,
        lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null,
      },
      executor: { mode: 'canary', serverExecutes: true },
    });
    expect(note(wiki('/wiki/orbit/activity', cache))).toBe(SERVER.plan.note);
  });

  it('stands under the home’s head on a desktop: the title, the line saying what the space holds, the search (mock 33 ④)', () => {
    const cache = client();
    cache.setQueryData(['wiki', 'space', ORBIT, 'docs'], {
      spaceId: ORBIT,
      plan: { version: 13, confirmedAt: '2026-10-06T00:00:00.000Z' },
      docs: { total: 35, written: 5 },
      categories: [],
    } satisfies WikiDocsDirectory);
    const html = wiki('/wiki/orbit/activity', cache);
    const order = ['<h1 class="page-title">Wiki</h1>', '<div class="wk-home-state">35 documents · 5 written</div>', 'class="wk-search"', 'class="wk-crumb wk-crumb--back"'].map(
      (needle) => at(html, needle),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reads Recent decisions by kind, not out of the newest 200 entries', () => {
    const html = wiki('/wiki/orbit/activity');
    expect(html).toContain('Remove wiki auto-push rather than reshape it');
    expect(html).toContain('All decisions ›');
  });

  it('marks what changed since the reader last looked, and says how many', () => {
    const html = wiki('/wiki/orbit/activity');
    expect(html).toContain('<span class="wk-new-hint"><span class="wk-new"></span>1 new since you last looked</span>');
    // The run three hours ago: a blue dot. The change a day ago: grey.
    expect(html).toMatch(/<li class="wk-tl-run"><span class="wk-dot confirmed"/);
    expect(html).toMatch(/<li class=""><span class="wk-dot proposed"/);
  });

  it('says nothing of what is new when nothing is', () => {
    browser.local.set(wikiSeenKey('orbit', 'home'), String(NOW));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={['/wiki/orbit/activity']}>
          <Routes>
            <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain('new since you last looked');
    expect(html).not.toMatch(/<li class="wk-tl-run"><span class="wk-dot confirmed"/);
  });

  it('says what the agents used: the usage card', () => {
    const html = wiki('/wiki/orbit/activity');
    expect(html).toContain('>692<');
    expect(html).toContain('>1753×<');
    expect(html).toContain('sessions received wiki context');
  });
});

describe('one number in four places, over two spaces whose plans wait', () => {
  it('sidebar = head badge = the sum of Activity’s amber banners = every proposal and plan thing waiting', () => {
    const cache = client();
    const page = wiki('/wiki/orbit/activity', cache);
    const side = sidebar(cache);
    const waiting = wikiWaiting(SPACES);
    // 1 + 2 proposals, and 1 + 2 things the plans wait on.
    expect(waiting).toBe(6);
    expect(wikiPlanPending(ORBIT_PLAN, null) + wikiPlanPending(WIKOVA_PLAN, null)).toBe(3);

    expect(side).toContain(`title="${waiting} waiting on you" aria-label="${waiting} waiting on you">${waiting}</span>`);
    const badge = page.match(/class="orbit-button[^"]*wk-activity-btn[^"]*"[\s\S]*?class="tp-rail-badge needs-you" title="(\d+) waiting on you" aria-label="\d+ waiting on you">(\d+)</);
    expect(badge?.[1]).toBe(String(waiting));
    expect(badge?.[2]).toBe(String(waiting));

    const banners = amberBanners(page);
    expect(banners.map((banner) => banner.text)).toEqual([
      '3 proposals to review · 2 in wikova',
      'Plan draft ready to confirm',
      '2 plan changes to review · in wikova',
    ]);
    expect(banners.reduce((sum, banner) => sum + banner.waiting, 0)).toBe(waiting);
  });

  it('Activity’s first banner = Review’s head = every space’s proposals, and it opens Review over all of them', () => {
    const page = wiki('/wiki/orbit/activity');
    const proposals = wikiProposalsWaiting(SPACES);
    expect(proposals).toBe(3);
    const first = amberBanners(page)[0];
    expect(first.waiting).toBe(proposals);
    expect(first.text.startsWith(`${proposals} proposals to review`)).toBe(true);
    expect(page).toMatch(/<a class="wk-banner" data-waiting="3" href="\/wiki\/review"/);

    const review = wiki('/wiki/review');
    expect(review).toContain(`<div class="rv-sub">${proposals} proposals from 2 sessions · oldest`);
  });

  it('says only the count when every proposal is the current space’s', () => {
    const spaces = [row(ORBIT, 'github.com/jianghailong-xy/orbit', 1, 1, 5), row(WIKOVA, 'github.com/jianghailong-xy/wikova', 0, 0, 12)];
    const page = wiki('/wiki/orbit/activity', client(spaces));
    expect(amberBanners(page).map((banner) => banner.text)).toEqual(['1 proposal to review', 'Plan draft ready to confirm']);
  });

  it('draws no banner, and no badge, when nothing waits anywhere', () => {
    const spaces = [row(ORBIT, 'github.com/jianghailong-xy/orbit', 0, 0, 5), row(WIKOVA, 'github.com/jianghailong-xy/wikova', 0, 0, 12)];
    const cache = client(spaces);
    cache.setQueryData(['wiki', 'space', ORBIT, 'plan'], { ...ORBIT_PLAN, draft: null });
    cache.setQueryData(['wiki', 'space', WIKOVA, 'plan'], { ...WIKOVA_PLAN, proposals: [] });
    cache.setQueryData(['wiki', 'review', ORBIT], []);
    const page = wiki('/wiki/orbit/activity', cache);
    expect(amberBanners(page)).toEqual([]);
    expect(page).not.toContain('tp-rail-badge');
    expect(sidebar(cache)).not.toContain('waiting on you');
  });
});

/** A card of Activity's, by its class: everything inside its `<section>`. */
function card(html: string, className: string): string {
  const match = html.match(new RegExp(`<section class="project-open-items wk-card ${className}[^"]*">([\\s\\S]*?)</section>`));
  expect(match, className).not.toBeNull();
  return match![1];
}

/** A card's amber count, beside its title. */
const cardCount = (html: string, className: string): number =>
  Number(card(html, className).match(/<span class="tp-count needs-you">(\d+)<\/span>/)?.[1] ?? 0);

/**
 * A desktop draws this space's Review and Plan as cards and hides the phone's banners (mock 33 ④ ⑤), so
 * over two spaces what waits elsewhere has to be on it too (§12.3.3: everything W counts can be found):
 * the Review card counts every space's proposals and says the others' shares as the first banner does,
 * and the other spaces' plan banners stand over the cards. With one space it is mock 33's as it was.
 */
describe('a desktop over two spaces: what waits elsewhere is on it too', () => {
  it('counts every space’s proposals on the Review card, says wikova’s share, and lists this space’s', () => {
    const page = wiki('/wiki/orbit/activity');
    const review = card(page, 'wk-review-card');
    expect(cardCount(page, 'wk-review-card')).toBe(wikiProposalsWaiting(SPACES));
    expect(review).toContain('<div class="project-open-items-hint wk-review-sub">1 proposal from 1 session · 2 in wikova</div>');
    expect(review).toContain('Secret redaction lets ENV_VAR=value secrets through');
    expect(review).not.toContain('A wikova pitfall');
    // Its button is Review over every space, the first banner's door.
    expect(review).toMatch(/<button[^>]*class="orbit-button orbit-button-primary[^"]*"[^>]*><span>Review<\/span><\/button>/);
  });

  it('draws the other spaces’ plan banners, and only theirs, over the cards', () => {
    const page = wiki('/wiki/orbit/activity');
    const elsewhere = [...page.matchAll(/<a class="wk-banner wk-plan-banner amber elsewhere" data-waiting="(\d+)"[^>]*>[\s\S]*?<span class="t">([^<]*)<\/span>/g)];
    expect(elsewhere.map((match) => [match[2], Number(match[1])])).toEqual([['2 plan changes to review · in wikova', 2]]);
    expect(page.indexOf('wk-plan-banner amber elsewhere')).toBeLessThan(at(page, 'class="wk-act-cards"'));
    // This space's own plan is its card on a desktop: its banner is the phone's alone.
    expect(page).toContain('<a class="wk-banner wk-plan-banner amber" data-waiting="1"');
  });

  it('shows every thing the badge counts: Review’s count, this space’s Plan card and the other spaces’ banners', () => {
    const page = wiki('/wiki/orbit/activity');
    const banners = [...page.matchAll(/class="wk-banner wk-plan-banner amber elsewhere" data-waiting="(\d+)"/g)].map((match) => Number(match[1]));
    const shown = cardCount(page, 'wk-review-card') + cardCount(page, 'wk-plan-card') + banners.reduce((sum, n) => sum + n, 0);
    expect(shown).toBe(wikiWaiting(SPACES));
  });

  it('with nothing to review here, says the first banner’s sentence and still opens Review', () => {
    const spaces = [row(ORBIT, 'github.com/jianghailong-xy/orbit', 0, 1, 5), row(WIKOVA, 'github.com/jianghailong-xy/wikova', 2, 2, 12)];
    const cache = client(spaces);
    cache.setQueryData(['wiki', 'review', ORBIT], []);
    const page = wiki('/wiki/orbit/activity', cache);
    const review = card(page, 'wk-review-card');
    expect(cardCount(page, 'wk-review-card')).toBe(2);
    expect(review).toContain('<div class="project-open-items-hint wk-review-sub">2 proposals to review · 2 in wikova</div>');
    expect(review).not.toContain('wk-rv-row');
    expect(review).toContain('<span>Review</span></button>');
    expect(review).not.toContain('Nothing is waiting for you.');
  });

  it('with one space, is mock 33’s: this space’s count, no share, no banner over the cards', () => {
    const spaces = [row(ORBIT, 'github.com/jianghailong-xy/orbit', 1, 1, 5)];
    const page = wiki('/wiki/orbit/activity', client(spaces));
    expect(cardCount(page, 'wk-review-card')).toBe(1);
    expect(card(page, 'wk-review-card')).toContain('<div class="project-open-items-hint wk-review-sub">1 proposal from 1 session</div>');
    expect(page).not.toMatch(/wk-plan-banner [a-z]+ elsewhere/);
  });

  it('names the cards the desktop grid places, Agents used the wiki right after Recently changed', () => {
    const page = wiki('/wiki/orbit/activity');
    const cards = page.slice(at(page, 'class="wk-act-cards"'));
    expect([...cards.matchAll(/<section class="project-open-items wk-card ?([^"]*)">/g)].map((match) => match[1].split(' ')[0])).toEqual([
      'wk-review-card',
      'wk-plan-card',
      'wk-decisions-card',
      'wk-changed-card',
      '',
    ]);
    expect(card(page, 'wk-changed-card')).toContain('>Recently changed<');
    expect(cards).toMatch(/<\/section><section class="project-open-items wk-card"><div class="project-open-items-head"><span class="project-open-items-title">Agents used the wiki</);
  });
});

describe('the head’s Activity button', () => {
  it('comes after Contents and before Settings and New entry, with the badge, and is pressed on Activity', () => {
    const home = wiki('/wiki/orbit');
    const order = ['wk-contents-btn', 'wk-activity-btn', 'aria-label="Settings"', 'aria-label="New entry"'].map((needle) => at(home, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(home).toMatch(/<button(?=[^>]*aria-label="Activity")(?=[^>]*aria-describedby="[^"]+")[^>]*class="[^"]*wk-activity-btn">/);
    const activity = wiki('/wiki/orbit/activity');
    expect(activity).toMatch(/<button(?=[^>]*aria-label="Activity")(?=[^>]*aria-current="page")(?=[^>]*aria-describedby="[^"]+")[^>]*class="[^"]*wk-activity-btn on">/);
  });
});
