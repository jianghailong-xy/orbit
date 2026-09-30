// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIntegrationView } from '@orbit/shared';
import { api, ApiError } from '../api';
import {
  RUN_APPLIES_FROM_NEXT_TASK,
  RUN_AUTOMATIC_HINT_MAIN,
  RUN_AUTOMATIC_HINT_PROJECT_BRANCH,
  RUN_ESCALATE_HINT,
  RUN_LINE_MAIN_HINT,
  RUN_MERGE_CHECK_HINT,
  RUN_NO_MERGE_CHECK_WARNING,
  RUN_NOT_SAVED,
  RUN_PAUSE,
  RUN_PAUSE_HINT,
  RUN_RESUME,
  RUN_SAVE,
  START_HOW_IT_RUNS,
  runLineLocked,
} from '../lib/projectStart';
import { ProjectRunSettings, type RunSettingsProject } from './ProjectRunSettings';

/**
 * "How it runs" — the settings a start card set, in one block once the project is started (mock
 * board3 ③④): the line (choosable until the first landing, read-only with its reason after),
 * Automatic, At most, the merge check, Escalate after, and Pause project / Resume project.
 *
 * `../api` is stubbed at the function the component calls, so what these assert is the request
 * each press puts on the wire — method, path and body — and, as much, what a Save leaves OFF it:
 * Automatic is written as `automatic`, never as the older `coordinatorEnabled` whose off also
 * pauses the project, and nothing unchanged rides along.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const PROJECT = '34WvwUS8YMXfOfWbMqVuu';

function viewOf(over: Partial<ProjectIntegrationView> = {}): ProjectIntegrationView {
  return {
    line: 'PROJECT_BRANCH',
    lineAbsentReason: null,
    ref: `project/${PROJECT}`,
    upstreamRef: 'main',
    source: 'EXPLICIT',
    locked: true,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    mergeCheckCommand: 'cd src/web && npx tsc -b && npx vitest run',
    mergeCheckCommandAbsentReason: null,
    mergeCheckTimeoutSeconds: null,
    escalationSeconds: 7200,
    commitsAheadOfUpstream: 3,
    commitsAheadOfUpstreamAbsentReason: null,
    lastUpstreamSyncAt: null,
    lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
    integratingCount: 0,
    queuedCount: 0,
    mergeCheckOnTip: 'PASSING',
    inFlight: null,
    ...over,
  };
}

/** A line nobody has decided: the default rule has not run, and nothing has landed. */
const undecided = (): ProjectIntegrationView =>
  viewOf({
    line: null,
    lineAbsentReason: 'NOT_DECIDED',
    ref: null,
    source: null,
    locked: false,
    startedAt: null,
    commitsAheadOfUpstream: null,
    commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET',
  });

const projectOf = (over: Partial<RunSettingsProject> = {}): RunSettingsProject => ({
  coordinatorEnabled: true,
  maxConcurrentTasks: 3,
  configRevision: '7',
  pausedAt: null,
  ...over,
});

const server: {
  view: ProjectIntegrationView;
  door: (method: string, path: string, body: unknown) => Promise<unknown>;
} = { view: viewOf(), door: async () => ({}) };
const writes: Array<{ method: string; path: string; body: unknown }> = [];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  server.view = viewOf();
  server.door = async () => ({});
  writes.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body });
      return server.door(method, path, init?.body);
    }
    if (path === `/projects/${PROJECT}/integration`) return server.view;
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

/** React Query hands every change on its own scheduler; a turn waits for one hand-off of its own. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 300 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

async function mount(project: RunSettingsProject = projectOf()): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
        <ProjectRunSettings projectId={PROJECT} project={project} />
      </QueryClientProvider>,
    );
  });
  await until(() => node.querySelector('.project-integration-setting') !== null, 'the settings rows');
  return node;
}

const settingRow = (node: ParentNode, label: string): HTMLElement => {
  const row = [...node.querySelectorAll<HTMLElement>('.project-integration-setting')]
    .find((each) => each.querySelector('.project-integration-setting-label')?.textContent === label);
  if (!row) throw new Error(`no "${label}" row`);
  return row;
};
const labels = (node: ParentNode): string[] =>
  [...node.querySelectorAll('.project-integration-setting-label')].map((label) => label.textContent ?? '');
function button(node: ParentNode, label: string): HTMLButtonElement {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(
    (each) => (each.textContent ?? '').trim() === label,
  );
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}
const lineInput = (node: ParentNode, line: 'MAIN' | 'PROJECT_BRANCH'): HTMLInputElement =>
  settingRow(node, 'Tasks land on').querySelector<HTMLInputElement>(`input[value="${line}"]`)!;
const automaticSwitch = (node: ParentNode): HTMLButtonElement =>
  settingRow(node, 'Automatic').querySelector<HTMLButtonElement>('[role="switch"]')!;

/** Types into an input the way the browser does: the native setter, then the event React reads. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

/** Press Save, and wait for the writes it makes to have left. */
async function save(node: HTMLElement, count: number): Promise<void> {
  await press(button(node, RUN_SAVE));
  await until(() => writes.length >= count, `${count} write(s)`);
  for (let n = 0; n < 5; n += 1) await turn();
}

describe('How it runs — what the block says', () => {
  it('draws the six settings of the mock, in its order, under its own heading', async () => {
    const node = await mount();
    const text = node.textContent ?? '';

    expect(node.querySelector('section')?.getAttribute('aria-label')).toBe(START_HOW_IT_RUNS);
    expect(node.querySelector('.project-open-items-title')?.textContent).toBe('How it runs');
    expect(node.querySelector('.project-open-items-hint')?.textContent).toBe(RUN_APPLIES_FROM_NEXT_TASK);
    expect(RUN_APPLIES_FROM_NEXT_TASK).toBe('applies from the next task');
    expect(labels(node)).toEqual(['Tasks land on', 'Automatic', 'At most', 'Merge check', 'Escalate after']);
    // The lines by their start-card names, the branch shortened the way every line names one.
    expect(settingRow(node, 'Tasks land on').textContent).toContain('A project branch · project/34Wvw…');
    expect(settingRow(node, 'Tasks land on').textContent).toContain('Directly into main');
    expect(settingRow(node, 'At most').textContent).toContain('tasks at a time');
    expect(settingRow(node, 'At most').querySelector<HTMLInputElement>('input')!.value).toBe('3');
    expect(settingRow(node, 'Merge check').querySelector<HTMLInputElement>('input')!.value)
      .toBe('cd src/web && npx tsc -b && npx vitest run');
    expect(settingRow(node, 'Merge check').textContent).toContain(RUN_MERGE_CHECK_HINT);
    expect(settingRow(node, 'Escalate after').textContent).toContain('2 hours');
    expect(settingRow(node, 'Escalate after').textContent).toContain(RUN_ESCALATE_HINT);
    expect(RUN_ESCALATE_HINT).toBe('Items the coordinator hasn’t handled by then come to you.');
    // The press that is not a setting, and what it does, in the copy table's words.
    expect(button(node, RUN_PAUSE)).toBeTruthy();
    expect(text).toContain(RUN_PAUSE_HINT);
    expect(RUN_PAUSE_HINT).toBe('Stops new tasks, wake-ups and merges into main. Running tasks finish.');
  });

  it('carries Automatic as the project stores it, with the sentence for the line it is on', async () => {
    const node = await mount();
    expect(automaticSwitch(node).getAttribute('aria-checked')).toBe('true');
    expect(settingRow(node, 'Automatic').textContent).toContain('On');
    expect(settingRow(node, 'Automatic').textContent).toContain(RUN_AUTOMATIC_HINT_PROJECT_BRANCH);
    expect(RUN_AUTOMATIC_HINT_PROJECT_BRANCH).toContain(
      'merges the branch into main once the merge check passes — with a receipt you can revert',
    );
  });

  it('says the merge half is always asked about on a project that lands on main', async () => {
    server.view = viewOf({ line: 'MAIN', ref: 'main' });
    const node = await mount();
    expect(settingRow(node, 'Automatic').textContent).toContain(RUN_AUTOMATIC_HINT_MAIN);
    expect(settingRow(node, 'Automatic').textContent).not.toContain(RUN_AUTOMATIC_HINT_PROJECT_BRANCH);
  });

  it('marks the merge check amber when Automatic would merge the branch unchecked', async () => {
    server.view = viewOf({ mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED' });
    const node = await mount();
    expect(settingRow(node, 'Merge check').classList.contains('is-warn')).toBe(true);
    expect(settingRow(node, 'Merge check').textContent).toContain(RUN_NO_MERGE_CHECK_WARNING);

    // Off, nothing merges by itself, and there is nothing to warn about.
    await press(automaticSwitch(node));
    expect(settingRow(node, 'Merge check').classList.contains('is-warn')).toBe(false);
  });
});

describe('How it runs — the line', () => {
  it('is read-only once the project has started integrating, and says why', async () => {
    const node = await mount();
    for (const line of ['PROJECT_BRANCH', 'MAIN'] as const) {
      expect(lineInput(node, line).disabled, line).toBe(true);
    }
    expect(lineInput(node, 'PROJECT_BRANCH').checked).toBe(true);
    const row = settingRow(node, 'Tasks land on').textContent ?? '';
    expect(row).toContain(runLineLocked('2h ago'));
    expect(row).toContain(
      'This project started integrating 2h ago, so the line it lands on can no longer change. '
      + 'Merge it into main, or give up the branch, to start another.',
    );
  });

  it('can be chosen while nobody has decided it — none is drawn as chosen, and the pick is what a Save writes', async () => {
    server.view = undecided();
    const node = await mount();
    // The block is there — the old integration row drew nothing at all until a line was decided.
    expect(lineInput(node, 'PROJECT_BRANCH').disabled).toBe(false);
    expect(lineInput(node, 'MAIN').disabled).toBe(false);
    expect(lineInput(node, 'PROJECT_BRANCH').checked).toBe(false);
    expect(lineInput(node, 'MAIN').checked).toBe(false);
    expect(settingRow(node, 'Tasks land on').textContent).toContain(RUN_LINE_MAIN_HINT);
    expect(settingRow(node, 'Tasks land on').textContent).not.toContain('started integrating');
    expect(button(node, RUN_SAVE).disabled).toBe(true);

    await press(lineInput(node, 'MAIN'));
    expect(button(node, RUN_SAVE).disabled).toBe(false);
    // The sentence under Automatic follows the line being chosen.
    expect(settingRow(node, 'Automatic').textContent).toContain(RUN_AUTOMATIC_HINT_MAIN);
    await save(node, 1);

    expect(writes).toEqual([
      { method: 'PATCH', path: `/projects/${PROJECT}/integration`, body: { line: 'MAIN' } },
    ]);
  });
});

describe('How it runs — what a Save writes', () => {
  it('writes nothing until something changed', async () => {
    const node = await mount();
    expect(button(node, RUN_SAVE).disabled).toBe(true);
  });

  it('turns Automatic on as `automatic`, fenced by the revision it was drawn at, and nothing else', async () => {
    const node = await mount(projectOf({ coordinatorEnabled: false, configRevision: '42' }));
    expect(automaticSwitch(node).getAttribute('aria-checked')).toBe('false');
    await press(automaticSwitch(node));
    await save(node, 1);

    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/projects/${PROJECT}`,
        body: { automatic: true, expectedConfigRevision: '42' },
      },
    ]);
    // The older switch's field pauses a project with its off; this block never writes it.
    expect(writes[0]!.body).not.toHaveProperty('coordinatorEnabled');
  });

  it('turns Automatic off the same way — off is not a pause', async () => {
    const node = await mount();
    await press(automaticSwitch(node));
    await save(node, 1);

    expect(writes).toEqual([
      { method: 'PATCH', path: `/projects/${PROJECT}`, body: { automatic: false, expectedConfigRevision: '7' } },
    ]);
    expect(writes.some((write) => write.path.endsWith('/pause'))).toBe(false);
  });

  it('writes At most with Automatic, and the merge check and escalation window to the integration door', async () => {
    const node = await mount();
    await type(settingRow(node, 'At most').querySelector<HTMLInputElement>('input')!, '5');
    await type(settingRow(node, 'Merge check').querySelector<HTMLInputElement>('input')!, 'npm test');
    await save(node, 2);

    // The line first: it is the one that can have locked since the block was drawn. A locked line
    // is never sent at all — the trigger refuses even its own value.
    expect(writes).toEqual([
      { method: 'PATCH', path: `/projects/${PROJECT}/integration`, body: { mergeCheckCommand: 'npm test' } },
      { method: 'PATCH', path: `/projects/${PROJECT}`, body: { maxConcurrentTasks: 5, expectedConfigRevision: '7' } },
    ]);
  });

  it('clears the merge check as null, not as an empty command', async () => {
    const node = await mount(projectOf({ coordinatorEnabled: false }));
    await type(settingRow(node, 'Merge check').querySelector<HTMLInputElement>('input')!, '  ');
    await save(node, 1);
    expect(writes).toEqual([
      { method: 'PATCH', path: `/projects/${PROJECT}/integration`, body: { mergeCheckCommand: null } },
    ]);
  });

  it('holds Save while At most is empty', async () => {
    const node = await mount();
    await type(settingRow(node, 'At most').querySelector<HTMLInputElement>('input')!, '');
    expect(button(node, RUN_SAVE).disabled).toBe(true);
  });

  it('says a refused Save in the door’s own words', async () => {
    server.door = async () => {
      throw new ApiError(
        'this project is at configRevision 9, not 7 — its coordination settings changed after you read them, so nothing was written',
        409,
        'STALE_CONFIG_REVISION',
      );
    };
    const node = await mount();
    await press(automaticSwitch(node));
    await save(node, 1);
    await until(() => (node.textContent ?? '').includes(RUN_NOT_SAVED), 'the refusal');

    expect(node.textContent).toContain(RUN_NOT_SAVED);
    expect(node.textContent).toContain('its coordination settings changed after you read them');
  });
});

describe('How it runs — Pause project', () => {
  it('pauses with the pause door, at once, and nothing else', async () => {
    const node = await mount();
    await press(button(node, RUN_PAUSE));
    await until(() => writes.length > 0, 'the pause');

    expect(writes).toEqual([{ method: 'POST', path: `/projects/${PROJECT}/pause`, body: undefined }]);
  });

  it('offers Resume project on a paused project, says since when, and resumes with the resume door', async () => {
    const node = await mount(projectOf({ pausedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
    expect(() => button(node, RUN_PAUSE)).toThrow();
    expect(node.textContent).toContain('Paused 20m ago.');
    await press(button(node, RUN_RESUME));
    await until(() => writes.length > 0, 'the resume');

    expect(writes).toEqual([{ method: 'POST', path: `/projects/${PROJECT}/resume`, body: undefined }]);
  });
});
