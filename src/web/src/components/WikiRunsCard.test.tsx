// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiJobCallView, WikiJobView, WikiSpaceHealth, WikiSystemModelStatus } from '@orbit/shared';
import type { WikiSpaceRow } from '../lib/wiki';
import { WikiRunsCard } from './WikiRunsCard';

/**
 * Activity's Runs card, driven in a document (design §2.2, mock 35 ④⑤): a row a server run in the fixture's words,
 * a row that opens its call log — each call's state, how long it waited and ran, its tokens and its error — the
 * run View run names opened by itself, the System model's state on the head, and nothing linking to a task or a
 * session. Drawn only while the server executes the account's wiki, or once it ran something for the space.
 *
 * THE WORDS ARE THE FIXTURE'S (`src/shared/src/wiki-server-execution.fixture.json`), which OrbitKit's
 * `WikiServerExecutionCopyParityTests` reads too.
 */

interface Fixture {
  now: string;
  runs: {
    title: string;
    none: string;
    columns: string[];
    cases: Array<{ name: string; job: WikiJobView; kind: string; state: string; text: string; when: string; foot: string }>;
    calls: Array<{ name: string; call: WikiJobCallView; row: { call: string; state: string; retries: string | null; tone: string; waited: string; ran: string; tokens: string; line: string; error: string | null } }>;
  };
}

function fixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-server-execution.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-server-execution.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-server-execution.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();
const SPACE_ID = '0196b300-0000-7000-8000-0000000000aa';
const SPACE = { id: SPACE_ID, slug: 'orbit', title: 'orbit' } as WikiSpaceRow;
const MODEL: WikiSystemModelStatus = { state: 'up', model: 'qwen3.8-27b-fp8', since: null, checkedAt: null, workerSeenAt: null };

function health(serverExecutes: boolean, systemModel: WikiSystemModelStatus | null = serverExecutes ? MODEL : null): WikiSpaceHealth {
  return {
    spaceId: SPACE_ID,
    entries: 0,
    maintenance: {
      look: 'off', enabled: false, lastOkAt: null, lastRunAt: null, consecutiveFailures: 0, backlog: 0, oldestPendingAt: null,
      lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null,
    },
    executor: { mode: serverExecutes ? 'canary' : 'runner', serverExecutes },
    systemModel,
  };
}

/** A run with the fixture's calls in its log, as the read answers it. */
function logged(): WikiJobView {
  const running = shared.runs.cases[0].job;
  return { ...running, id: 'run-with-calls', requests: shared.runs.calls.map((one) => one.call) };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(shared.now));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(read: WikiSpaceHealth, jobs: WikiJobView[] | null, path = '/wiki/orbit/activity'): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } });
  client.setQueryData(['wiki', 'space', SPACE_ID, 'health'], read);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'jobs'], jobs === null ? null : { spaceId: SPACE_ID, jobs });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <WikiRunsCard space={SPACE} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const words = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the Runs card', () => {
  it('draws a row a run in the fixture’s words, newest first as the read gives them', async () => {
    await mount(health(true), shared.runs.cases.map((one) => one.job));
    const card = container.querySelector('.wk-runs-card')!;
    expect(words(card.querySelector('.project-open-items-title'))).toBe(shared.runs.title);
    const rows = [...card.querySelectorAll('.wk-run-row')];
    expect(rows).toHaveLength(shared.runs.cases.length);
    shared.runs.cases.forEach((one, i) => {
      expect(words(rows[i].querySelector('.k')), one.name).toBe(one.kind);
      expect(words(rows[i].querySelector('.s')), one.name).toBe(one.text ? `${one.state} · ${one.text}` : one.state);
      expect(words(rows[i].querySelector('.when')), one.name).toBe(one.when);
      expect(rows[i].getAttribute('aria-expanded'), one.name).toBe('false');
    });
    // The head says the System model and its state, never where it answers.
    expect(words(card.querySelector('.project-open-items-hint'))).toBe('System model · qwen3.8-27b-fp8Up');
  });

  it('opens a run’s call log: each call’s state, waits, run time, tokens and error, and the line under it', async () => {
    const run = logged();
    await mount(health(true), [run]);
    expect(container.querySelector('.wk-run-calls')).toBeNull();
    await act(async () => (container.querySelector('.wk-run-row') as HTMLButtonElement).click());
    const log = container.querySelector('.wk-run.open .wk-run-calls')!;
    expect(container.querySelector('.wk-run-row')?.getAttribute('aria-expanded')).toBe('true');
    expect([...log.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(shared.runs.columns);
    const rows = [...log.querySelectorAll('tbody tr:not(.why)')];
    expect(rows).toHaveLength(shared.runs.calls.length);
    shared.runs.calls.forEach((one, i) => {
      const cells = rows[i].querySelectorAll('td');
      expect(words(cells[0]), one.name).toBe(one.row.call);
      expect(words(cells[1]), one.name).toBe(one.row.retries ? `${one.row.state} · ${one.row.retries}` : one.row.state);
      expect(cells[1].querySelector('span')?.className, one.name).toBe(one.row.tone);
      expect([words(cells[2]), words(cells[3]), words(cells[4])], one.name).toEqual([one.row.waited, one.row.ran, one.row.tokens]);
      expect(words(rows[i].querySelector('td.line')), one.name).toBe(one.row.line);
      const why = rows[i].nextElementSibling?.classList.contains('why') ? rows[i].nextElementSibling : null;
      expect(why ? words(why) : null, one.name).toBe(one.row.error);
    });
    expect(words(log.querySelector('.wk-run-foot'))).toBe(`${run.calls.total} calls · 2,592 tokens in, 607 out so far`);
    // Pressed again, the log folds.
    await act(async () => (container.querySelector('.wk-run-row') as HTMLButtonElement).click());
    expect(container.querySelector('.wk-run-calls')).toBeNull();
  });

  it('opens the run View run names, and links to no task and no session', async () => {
    const run = logged();
    const other = { ...shared.runs.cases[10].job, id: 'another-run' };
    await mount(health(true), [other, run], `/wiki/orbit/activity?run=${run.id}`);
    const open = container.querySelectorAll('.wk-run.open');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(`wk-run-${run.id}`);
    expect(container.querySelector('.wk-runs-card a[href*="/sessions/"], .wk-runs-card a[href*="/tasks/"]')).toBeNull();
  });

  it('is drawn while the server executes the wiki, with nothing yet — and not under runner', async () => {
    await mount(health(true), []);
    expect(words(container.querySelector('.wk-runs-card .wk-empty'))).toBe(shared.runs.none);
    act(() => root.unmount());
    root = createRoot(container);
    await mount(health(false), []);
    expect(container.querySelector('.wk-runs-card')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    // A control plane from before the read answers null, and an account the server never ran anything for draws nothing.
    await mount(health(false), null);
    expect(container.querySelector('.wk-runs-card')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    // Runs the server made before the switch went back to runner are still the space's to see.
    await mount(health(false), [shared.runs.cases[10].job]);
    expect(container.querySelectorAll('.wk-runs-card .wk-run-row')).toHaveLength(1);
  });

  it('says the model’s state on its head as the settings page does', async () => {
    await mount(health(true, { ...MODEL, state: 'auth_failed' }), [shared.runs.cases[0].job]);
    const head = container.querySelector('.wk-runs-card .project-open-items-hint .wk-model-state');
    expect(words(head)).toBe('Key refused');
    expect(head?.className).toBe('wk-model-state error');
  });
});
