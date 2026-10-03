// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocsDirectory, WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion } from '@orbit/shared';
import { WikiPage } from '../pages/WikiPage';
import { ToastViewport } from './ToastViewport';
import { clearToasts } from '../lib/toastStore';

/**
 * The plan (criterion 11's owner half, criterion 10 revised: mocks 21, 22, 25, 26), driven through the real
 * routes and the owner's door: every state of its job — none, queued, drafting, held for the server's two
 * reasons or the runner offline (never the daily limit), failed, the documents being written, held or
 * stopped — Draft plan, Confirm plan, Accept (with no other draft waiting, accept then confirm: two
 * requests, none confirmed when the gate refuses; with one waiting, accept only), Reject, an edit in the
 * draft's shape, and the home's card and banner.
 *
 * The states are the shared fixture's (`wiki-docs.fixture.json`), which OrbitKit is held to as well.
 */

interface Spec {
  confirmed: 'v1' | null;
  draft: 'v2' | null;
  proposals: boolean;
  job: string | null;
  runnerOnline: boolean | null;
}

interface Shared {
  now: string;
  docs: { directory: { read: WikiDocsDirectory } };
  plan: {
    versions: { v1: WikiPlanVersion; v2: WikiPlanVersion };
    proposals: WikiPlanProposal[];
    jobs: Record<string, WikiPlanJob>;
    states: Record<string, { spec: Spec }>;
  };
}

function shared(): Shared {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json'),
  ].find((candidate) => existsSync(candidate))!;
  return JSON.parse(readFileSync(path, 'utf8')) as Shared;
}

const SHARED = shared();
const SPACE_ID = '0196f000-0000-7000-8000-000000000001';
const WORKSPACE_ID = '0196f000-0000-7000-8000-00000000000a';
const RUNNER_ID = '0196f000-0000-7000-8000-00000000000b';
const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: 'b'.repeat(40),
  settings: { maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 8, lookbackDays: 14, listId: null } },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pendingOps: 1,
};

/** The fixture's ids are names; a link the page builds needs a real id, so the ones it links by are given one. */
const RUN_SESSION = '0196f000-0000-7000-8000-0000000000c1';
const ENTRY_FACT = '0196f000-0000-7000-8000-0000000000c2';
const SESSION_FACT = '0196f000-0000-7000-8000-0000000000c3';
const linkable = (job: WikiPlanJob): WikiPlanJob => ({
  ...job,
  sessionId: job.sessionId ? RUN_SESSION : null,
  waitingFor: job.waitingFor ? { ...job.waitingFor, sessionId: RUN_SESSION } : null,
});
const PROPOSALS: WikiPlanProposal[] = SHARED.plan.proposals.map((proposal) => ({
  ...proposal,
  facts: proposal.facts.map((fact) => (fact.kind === 'entry' ? { ...fact, id: ENTRY_FACT } : fact.kind === 'session' ? { ...fact, id: SESSION_FACT } : fact)),
}));

function stateOf(name: string): WikiPlanState {
  const spec = SHARED.plan.states[name].spec;
  return {
    spaceId: SPACE_ID,
    confirmed: spec.confirmed ? SHARED.plan.versions.v1 : null,
    draft: spec.draft ? SHARED.plan.versions.v2 : null,
    proposals: spec.proposals ? PROPOSALS : [],
    job: spec.job ? linkable(SHARED.plan.jobs[spec.job]) : null,
  };
}

let plan: WikiPlanState = stateOf('none');
let runnerOnline: boolean | null = true;
/** What each write answers: an override per path, else a plain success. */
let answers: Record<string, () => Response> = {};
const writes: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0];
  const method = init?.method ?? 'GET';
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  if (method !== 'GET') {
    writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, headers: { ...(init?.headers as Record<string, string>) } });
    if (answers[path]) return answers[path]();
    if (path === `${space}/plan/redraft`) return reply(200, { created: true, job: SHARED.plan.jobs.queued });
    if (path.endsWith('/decide')) return reply(200, { proposal: SHARED.plan.proposals[0], draft: { ...SHARED.plan.versions.v2, version: 2 } });
    if (/\/plan\/versions\/\d+\/confirm$/.test(path)) return reply(200, { ...SHARED.plan.versions.v2, status: 'confirmed' });
    if (path === `${space}/plan/edits`) return reply(200, { ...SHARED.plan.versions.v2, version: 3 });
    return reply(404, { message: `${method} ${url} is not in this fixture` });
  }
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/plan`) return reply(200, plan);
  if (path === `${space}/plan/versions`) return reply(200, { spaceId: SPACE_ID, versions: [] });
  if (path === `${space}/docs`) return reply(200, plan.confirmed ? SHARED.docs.directory.read : { ...SHARED.docs.directory.read, plan: null, categories: [] });
  if (path === `${space}/articles`) return reply(200, { spaceId: SPACE_ID, categories: [], uncategorized: [] });
  if (path === `${space}/entries`) return reply(200, []);
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path === `${space}/health`) return reply(404, {});
  if (path.startsWith('/api/wiki/review')) {
    return reply(200, [
      {
        id: 'cs', spaceId: SPACE_ID, origin: 'agent', sessionId: 's', toolCallId: null, rationale: 'r', status: 'pending',
        createdAt: '2026-09-25T12:00:00.000Z', decidedAt: null, expiresAt: null,
        ops: [{ id: 'op', changesetId: 'cs', seq: 0, op: 'add', entryId: null, baseRevision: null, payload: { entry: { kind: 'pitfall', title: 'One' } }, similar: [], tainted: false, decision: 'pending' }],
      },
    ]);
  }
  if (path === '/api/workspaces') return reply(200, [{ id: WORKSPACE_ID, name: 'orbit', runner: { id: RUNNER_ID, displayName: 'wikova' } }]);
  if (path === '/api/runners') return reply(200, runnerOnline === null ? [] : [{ id: RUNNER_ID, online: runnerOnline }]);
  return reply(404, { message: `${url} is not in this fixture` });
}

let phone = false;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.setSystemTime(new Date(SHARED.now));
  phone = false;
  plan = stateOf('none');
  runnerOnline = true;
  answers = {};
  writes.length = 0;
  mounted = false;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && /max-width/.test(query), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    clearToasts();
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function Where() {
  const location = useLocation();
  return <output data-where={`${location.pathname}${location.search}`} />;
}

let mounted = false;

async function open(path: string): Promise<void> {
  // Each open is a fresh page: a second one in a test must not inherit the first's router or reads.
  if (mounted) {
    act(() => root.unmount());
    root = createRoot(container);
  }
  mounted = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <Routes>
              <Route path="/wiki/:space" element={<WikiPage route="home" />} />
              <Route path="/wiki/:space/plan" element={<WikiPage route="plan" />} />
              <Route path="/wiki/:space/plan/d/:doc" element={<WikiPage route="planDoc" />} />
              <Route path="/wiki/:space/plan/d/:doc/:section" element={<WikiPage route="planSection" />} />
              <Route path="/wiki/:space/settings" element={<span>settings</span>} />
              <Route path="/wiki/review" element={<span>review</span>} />
              <Route path="/runners" element={<span>runners</span>} />
              <Route path="/sessions/:id" element={<span>session</span>} />
            </Routes>
            <Where />
          </AntApp>
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const text = (selector: string, scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
const planPage = (): HTMLElement => container.querySelector<HTMLElement>('.wk-main .wk-pl-page')!;
const button = (label: string, scope: ParentNode = container): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.replace(/\s+/g, ' ').trim() === label);
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
/** A node's words as a reader hears them: its parts one space apart, the way the page lays them out. */
const spaced = (node: Node): string =>
  [...node.childNodes].every((child) => child.nodeType === Node.TEXT_NODE)
    ? (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    : [...node.childNodes].map(spaced).filter(Boolean).join(' ');
const jobCard = (): string[] => [...planPage().querySelectorAll('.wk-pl-job .h')].map(spaced);

describe('the plan page, by what its job is doing', () => {
  it('with no plan, offers Draft plan, which asks the owner’s door for a draft', async () => {
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-empty')).toBeTruthy());
    const empty = planPage().querySelector('.wk-pl-empty')!;
    expect(text('b', empty)).toEqual(['No plan yet']);
    expect(text('.note', empty)).toEqual([
      'Runs as a task in the Wiki maintenance list, on orbit · wikova with local-vllm — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles.',
    ]);
    await press(button('Draft plan', empty));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual([`POST /api/wiki/spaces/${SPACE_ID}/plan/redraft`]);
    expect(writes[0].body).toEqual({});
    // The owner's door only: nothing here speaks for a session.
    expect(Object.keys(writes[0].headers).filter((name) => /session/i.test(name))).toEqual([]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Redraft asked for — it runs as a Wiki maintenance task'));
  });

  it('says what a draft on its way is doing: queued, drafting, held — for the server’s reasons or the runner offline', async () => {
    const cases: Array<[string, boolean | null, string[]]> = [
      ['noneQueued', true, ['Queued starts after the Wiki maintenance run that’s going now (started 4m ago) View run']],
      ['noneDrafting', true, ['Drafting local-vllm · attempt 1 of 3 · started 12m ago View run']],
      ['noneHeld', true, ['Held No maintenance workspace is set up — a draft runs where maintenance runs. Set up maintenance']],
      ['noneOffline', false, ['Held The maintenance runner is offline — the draft starts once it’s back. View runners']],
    ];
    for (const [name, online, card] of cases) {
      plan = stateOf(name);
      runnerOnline = online;
      await open('/wiki/orbit/plan');
      await vi.waitFor(() => expect(jobCard()).toEqual(card));
      expect(planPage().textContent).not.toMatch(/daily|limit/iu);
    }
  });

  it('shows the documents of the version in force being written, how many and the one now, with its run', async () => {
    plan = stateOf('writing');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(jobCard()).toEqual(['Writing documents 2 of 5 written · started 40m ago View run']));
    expect([...planPage().querySelectorAll('.wk-pl-prog .next')].map(spaced)).toEqual(['Writing now: 3.2 会话状态生命周期']);
    expect(planPage().querySelector('.wk-pl-prog .bar i')?.getAttribute('style')).toContain('width: 40%');
  });

  it('says the writing is held for want of a setting, or stopped short, on the version in force', async () => {
    plan = stateOf('writingHeld');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() =>
      expect(jobCard()).toEqual(['Held No usable maintenance provider is set up — documents are written on the provider maintenance uses. Set up maintenance']),
    );
    await press(planPage().querySelector('.wk-pl-job a'));
    expect(where()).toBe('/wiki/orbit/settings');

    plan = stateOf('writingStopped');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() =>
      expect(jobCard()).toEqual(['Writing documents didn’t finish the run was cut off at 120 turns · Wiki maintenance writes what’s left on its next run View run']),
    );
  });

  it('shows a draft that failed the gate with its report, and will not confirm it', async () => {
    plan = stateOf('draftFailed');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-check.fail:not(.wk-pl-job)')).toBeTruthy());
    expect(text('.wk-pl-hint', planPage())).toEqual(['Confirm needs a passing check. Redraft with what to change — v1 stays in force until you confirm.']);
    expect(jobCard()).toEqual(['Didn’t pass the plan check 3 of 4 checks failed · after 3 attempts · 5 errors listed below']);
    expect(button('Confirm plan', planPage())?.disabled).toBe(true);
    const gate = planPage().querySelector('.wk-pl-check.fail:not(.wk-pl-job)')!;
    expect(text('.wk-pl-ck .n', gate)).toEqual(['Documents', 'Protected documents', 'References', 'Fields']);
    expect(text('.wk-pl-err .at', gate)).toEqual(['2.1 §2', '3.1 §1', '2.1 §2']);
  });
});

describe('confirming, and the changes proposed', () => {
  it('confirms a draft that passed the gate on the owner’s door', async () => {
    plan = stateOf('draftReady');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(button('Confirm plan', planPage())).toBeTruthy());
    expect(text('.wk-pl-check.pass .h b', planPage())).toEqual(['Passed the plan check']);
    await press(button('Confirm plan', planPage()));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual([`POST /api/wiki/spaces/${SPACE_ID}/plan/versions/2/confirm`]);
  });

  it('with no other draft waiting, Accept accepts and then confirms the draft it made — two requests', async () => {
    plan = stateOf('changes');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-prop')).toBeTruthy());
    const card = planPage().querySelector('.wk-pl-prop')!;
    expect(text('.note', card)).toEqual(['Accepting confirms plan v2 · Wiki maintenance writes the section next']);
    await press(button('Accept', card));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual([
      'POST /api/wiki/plan-proposals/pp1/decide',
      `POST /api/wiki/spaces/${SPACE_ID}/plan/versions/2/confirm`,
    ]);
    expect(writes[0].body).toEqual({ action: 'accept' });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Plan v2 confirmed'));
  });

  it('when the gate refuses the change, lists its errors and confirms nothing', async () => {
    plan = stateOf('changes');
    answers['/api/wiki/plan-proposals/pp1/decide'] = () =>
      reply(422, { code: 'WIKI_PLAN_GATE', message: '1 error', errors: [{ check: 'references', path: 'plan.docs[1].sections[2].sources.code[0]', message: 'no such file' }] });
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-prop')).toBeTruthy());
    await press(button('Accept', planPage().querySelector('.wk-pl-prop')!));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual(['POST /api/wiki/plan-proposals/pp1/decide']);
    await vi.waitFor(() => expect(text('.wk-pl-refused', planPage())[0]).toContain('plan.docs[1].sections[2].sources.code[0] no such file'));
    expect(text('.wk-pl-refused b', planPage())).toEqual(['This change no longer passes the plan check, so nothing was confirmed:']);
  });

  it('with a draft waiting, Accept only accepts, and the page moves to the new draft', async () => {
    plan = stateOf('draftReady');
    answers['/api/wiki/plan-proposals/pp1/decide'] = () => reply(200, { proposal: SHARED.plan.proposals[0], draft: { ...SHARED.plan.versions.v2, version: 3 } });
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-prop')).toBeTruthy());
    const card = planPage().querySelector('.wk-pl-prop')!;
    expect(text('.note', card)).toEqual(['Draft v2 is waiting for you — accepting adds this change to a new draft, v3, for you to confirm']);
    await press(button('Accept', card));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual(['POST /api/wiki/plan-proposals/pp1/decide']);
    expect(where()).toBe('/wiki/orbit/plan?v=3');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Change added to draft v3'));
  });

  it('Reject rejects, and nothing else', async () => {
    plan = stateOf('changes');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-prop')).toBeTruthy());
    await press(button('Reject', planPage().querySelector('.wk-pl-prop')!));
    expect(writes.map((row) => `${row.method} ${row.path} ${JSON.stringify(row.body)}`)).toEqual(['POST /api/wiki/plan-proposals/pp1/decide {"action":"reject"}']);
  });

  it('sends an edit in the draft’s shape: no ids or positions, a session condition’s projects by id', async () => {
    plan = stateOf('inForce');
    await open('/wiki/orbit/plan');
    await vi.waitFor(() => expect(planPage()?.querySelector('.wk-pl-doc')).toBeTruthy());
    await press(planPage().querySelector('.wk-pl-doc .caret[aria-label="会话运行模型与长连接"]'));
    await press(button('Edit', planPage()));
    await vi.waitFor(() => expect(document.querySelector('.wk-pl-drawer .wk-pl-form')).toBeTruthy());
    await press(button('Save draft', document.querySelector('.wk-pl-drawer')!));
    expect(writes.map((row) => `${row.method} ${row.path}`)).toEqual([`POST /api/wiki/spaces/${SPACE_ID}/plan/edits`]);
    const body = writes[0].body as { baseVersion: number; docSlug: string; doc: { sections: Array<{ sources: { sessions?: { projects: unknown[] } | null } }> } };
    expect(body.baseVersion).toBe(1);
    expect(body.docSlug).toBe('session-runtime');
    expect(JSON.stringify(body)).not.toMatch(/"id":|"position":/u);
    expect(body.doc.sections.map((section) => section.sources.sessions?.projects ?? null)).toEqual([null, null, ['pr1', 'pr-gone'], ['pr3']]);
  });
});

describe('the plan on the home', () => {
  it('is the phone’s second banner, under Review’s', async () => {
    phone = true;
    plan = stateOf('changes');
    await open('/wiki/orbit');
    await vi.waitFor(() => expect(container.querySelector('.wk-plan-banner')).toBeTruthy());
    const banners = [...container.querySelectorAll('.wk-banner')];
    expect(banners).toHaveLength(2);
    expect(banners[1].classList.contains('wk-plan-banner')).toBe(true);
    expect(banners[1].textContent?.trim()).toBe('2 plan changes to review');
    await press(container.querySelector('.wk-plan-banner'));
    expect(where()).toBe('/wiki/orbit/plan');
  });

  it('tops the desktop’s right rail as a card, over Review', async () => {
    plan = stateOf('changes');
    await open('/wiki/orbit');
    await vi.waitFor(() => expect(container.querySelector('.wk-plan-card')).toBeTruthy());
    const rail = container.querySelectorAll('.wk-col')[1];
    expect(rail.firstElementChild?.classList.contains('wk-plan-card')).toBe(true);
    expect(text('.wk-plan-card .wk-review-sub', rail)).toEqual(['2 changes to review · v1 in force']);
  });

  it('says a held draft sends the owner to Maintenance', async () => {
    phone = true;
    plan = stateOf('noneHeld');
    await open('/wiki/orbit');
    await vi.waitFor(() => expect(container.querySelector('.wk-plan-banner')).toBeTruthy());
    expect(text('.wk-plan-banner .t')).toEqual(['Plan draft held — set up maintenance']);
    await press(container.querySelector('.wk-plan-banner'));
    expect(where()).toBe('/wiki/orbit/settings');
  });
});
