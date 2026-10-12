// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import type { ProjectCrossingRow } from '../lib/attribution';
import {
  MOVE_TASK_APPROVE_CONSEQUENCE,
  MOVE_TASK_STATE_MEANING,
  ProjectCrossingsCard,
} from './ProjectCrossingsCard';

/**
 * The card as the account owner uses it on a request to MOVE a task: the first press only asks,
 * the second sends the answer with the crossing key, and the answer is the move. When the server
 * refuses the confirmation — the task is being landed at that moment — nothing moved, the row says
 * why in the server's own words, and the same request can be confirmed again.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const PROJECT = 'AAATo';
const KEY = 'c'.repeat(64);
const LANDING =
  'task AAAMovedTask is being landed (LAND_TASK AAAJob is RUNNING), and a landing belongs to the '
  + 'project the task is in — nothing was written and the request is still waiting. Confirm it '
  + 'again once that job has ended, or deny it.';

function moveRow(over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  return {
    id: 'AAACrossing',
    publicId: 'AAACrossing',
    fromProjectId: 'AAAFrom',
    fromProjectPublicId: 'AAAFrom',
    toProjectId: PROJECT,
    toProjectPublicId: PROJECT,
    fromProject: { title: 'Coordinator control loop', status: 'DONE' },
    toProject: { title: 'Runner hardening', status: 'OPEN' },
    kind: 'MOVE_TASK',
    subjectTaskId: 'AAAMovedTask',
    subjectTaskPublicId: 'AAAMovedTask',
    subjectTask: { id: 'AAAMovedTask', publicId: 'AAAMovedTask', title: 'Wire the drain watchdog' },
    requestedCriterion: { key: 'AAATargetCriterion', text: 'A wedged drain restarts within a minute.' },
    withdrawnCriterion: null,
    crossingKey: KEY,
    state: 'PENDING',
    title: 'Wire the drain watchdog',
    reason: 'the watchdog belongs to the runner goal',
    requestedAt: '2026-10-06T09:00:00.000Z',
    decidedAt: null,
    expiresAt: null,
    ...over,
  };
}

const server: { row: ProjectCrossingRow; decide: () => Promise<unknown> } = {
  row: moveRow(),
  decide: async () => ({}),
};
const answers: unknown[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  server.row = moveRow();
  server.decide = async () => ({});
  answers.length = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST' && path === `/projects/${PROJECT}/handoffs/AAACrossing/decision`) {
      answers.push(init.body);
      return server.decide();
    }
    if (path === `/projects/${PROJECT}/handoffs`) return [server.row];
    throw new Error(`nothing is stubbed at ${path}`);
  }) as unknown as typeof api);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  await client?.cancelQueries();
  client?.clear();
  client = null;
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 300 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

async function mount(): Promise<HTMLElement> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  client = qc;
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  const tree = createRoot(node);
  root = tree;
  await act(async () => {
    tree.render(
      <QueryClientProvider client={qc}>
        <ProjectCrossingsCard projectId={PROJECT} />
      </QueryClientProvider>,
    );
  });
  await until(() => (node.textContent ?? '').includes('Wire the drain watchdog'), 'the move request');
  return node;
}

const buttonIn = (node: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...node.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );

async function press(node: HTMLElement, label: string): Promise<void> {
  const button = buttonIn(node, label);
  expect(button, `the ${label} button`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

describe('ProjectCrossingsCard — confirming a move, live', () => {
  it('asks first, then sends the answer with the crossing key, and the answer is the move', async () => {
    const node = await mount();
    expect(node.textContent).toContain(MOVE_TASK_STATE_MEANING.PENDING);

    await press(node, 'Approve…');
    // The first press only asks: nothing went to the server.
    expect(answers).toEqual([]);
    expect(node.textContent).toContain(
      'Approve moving “Wire the drain watchdog” from Coordinator control loop to Runner hardening?',
    );
    expect(node.textContent).toContain(MOVE_TASK_APPROVE_CONSEQUENCE);

    server.decide = async () => {
      server.row = moveRow({ state: 'APPLIED', decidedAt: '2026-10-06T10:00:00.000Z' });
      return server.row;
    };
    await press(node, 'Yes, approve');
    await until(
      () => (node.textContent ?? '').includes(MOVE_TASK_STATE_MEANING.APPLIED),
      'the request read back as applied',
    );
    expect(answers).toEqual([{ decision: 'APPROVE', acknowledgedCrossingKey: KEY }]);
    expect(buttonIn(node, 'Approve…')).toBeUndefined();
    expect(buttonIn(node, 'Yes, approve')).toBeUndefined();
  });

  it('cancelling the second press sends nothing', async () => {
    const node = await mount();
    await press(node, 'Approve…');
    await press(node, 'Cancel');
    expect(answers).toEqual([]);
    expect(node.textContent).not.toContain(MOVE_TASK_APPROVE_CONSEQUENCE);
    expect(buttonIn(node, 'Approve…')).toBeDefined();
  });

  it('shows why a confirmation was refused, and lets the same request be confirmed again', async () => {
    const node = await mount();
    await press(node, 'Approve…');
    server.decide = async () => {
      throw new ApiError(LANDING, 409, 'MOVE_TASK_LANDING_IN_FLIGHT', {
        code: 'MOVE_TASK_LANDING_IN_FLIGHT',
        requiredAction: 'WAIT_FOR_THE_LANDING',
        message: LANDING,
      });
    };
    await press(node, 'Yes, approve');
    await until(
      () => (node.textContent ?? '').includes('That answer was not recorded'),
      'the refusal on the row',
    );
    const alert = node.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('MOVE_TASK_LANDING_IN_FLIGHT');
    expect(alert?.textContent).toContain(LANDING);
    // Nothing moved: the row still waits, and the second step is still open on it.
    expect(node.textContent).toContain(MOVE_TASK_STATE_MEANING.PENDING);
    expect(node.textContent).toContain(MOVE_TASK_APPROVE_CONSEQUENCE);

    // Once the landing has ended, the same request is confirmed from where it stands.
    server.decide = async () => {
      server.row = moveRow({ state: 'APPLIED', decidedAt: '2026-10-06T10:05:00.000Z' });
      return server.row;
    };
    await press(node, 'Yes, approve');
    await until(
      () => (node.textContent ?? '').includes(MOVE_TASK_STATE_MEANING.APPLIED),
      'the request read back as applied',
    );
    expect(answers).toHaveLength(2);
    expect(node.textContent).not.toContain('That answer was not recorded');
  });
});
