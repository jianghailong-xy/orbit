// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycleState, SessionRunState } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import {
  RUN_AUTOMATIC_HINT_PROJECT_BRANCH,
  RUN_NOT_SAVED,
  RUN_SAVE,
} from '../lib/projectStart';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * `Automatic` — the project's `coordinatorEnabled`, as the project page's How it runs block sets it.
 *
 * It used to be a switch at the foot of the coordinator card whose off also stopped the project;
 * since Pause project is the one thing that stops a project (D1), Automatic is only whether the
 * coordinator runs it for its owner, and it lives with the other settings the start card set. So it
 * is written as `automatic` — never the older `coordinatorEnabled`, whose off the server still
 * reads as a pause from a client that knows no better — and written by Save, with the rest of the
 * block.
 *
 * `fetch` is stubbed rather than the `api` module, exactly as ProjectsPage.status.test.tsx does it,
 * so what these assert is the REQUEST that leaves the client: the method, the path and the JSON
 * body. Two facts about that body are load-bearing and neither is visible from "the mutation was
 * called". `expectedConfigRevision`, without which two editors silently overwrite each other — and
 * the absence of anything else: the `automationPolicy` the body used to carry went with the column,
 * and `coordinatorEnabled` would pause the project it was only meant to hand to its owner.
 */
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-000000000001';
const PROJECT = encodeId(P1);
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000b1');

/** The revision the switch is drawn at, and therefore the one the write has to fence against. */
const REVISION = '7';

/** `GET /projects/:id`. `coordinatorEnabled` and `configRevision` are not additions to the payload —
 *  the endpoint reads the row with `include`, so both columns have always been on the wire. */
const detail = (over: Record<string, unknown> = {}) => ({
  id: P1,
  title: 'Website Revamp',
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  instructions: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 8 },
  tasksByStatus: { OPEN: 2, DONE: 3 },
  acceptanceCriteriaItems: [],
  coordinatorEnabled: false,
  maxConcurrentTasks: 3,
  configRevision: REVISION,
  // Started: How it runs is a started project's block — the start card sets it before then.
  startedAt: '2026-09-07T06:00:00.000Z',
  pausedAt: null,
  ...over,
});

/** A LIVE coordinator, so the card draws its body rather than a spinner or an alert. Nothing below
 *  turns on WHICH of the four states it is: the switch is the project's, not the conversation's. */
const status = () => ({
  projectId: PROJECT,
  readAt: '2026-09-07T07:00:00.000Z',
  state: 'LIVE',
  coordination: {
    sessionId: SESSION,
    sessionIdAbsentReason: null,
    session: {
      id: SESSION,
      title: 'Coordinating Website Revamp',
      runStatus: 'AWAITING_INPUT',
      runState: SessionRunState.AWAITING_INPUT,
      lifecycleState: SessionLifecycleState.OPEN,
      filingState: 'OPEN',
      endReason: null,
      startedAt: '2026-09-07T06:48:00.000Z',
      finishedAt: null,
      completedAt: null,
      deletedAt: null,
      engineTurnActive: false,
      pendingApprovals: 0,
    },
    sessionAbsentReason: null,
    coordinatorGeneration: '1',
    workspaceId: WORKSPACE,
    workspaceIdAbsentReason: null,
    workspaceName: 'orbit-main',
    workspaceNameAbsentReason: null,
    agentId: WORKSPACE,
    agentIdAbsentReason: null,
    agentName: 'orbit',
    agentNameAbsentReason: null,
  },
  openability: {
    canOpen: true,
    willCreate: false,
    refusalCode: null,
    refusalDetail: null,
    refusalCodeAbsentReason: 'NOTHING_REFUSES',
    requiredAction: null,
    requiredActionAbsentReason: 'NOTHING_REFUSES',
    landing: {
      workspaceId: null,
      workspaceIdAbsentReason: 'COORDINATOR_ALREADY_LIVE',
      workspaceName: null,
      workspaceNameAbsentReason: 'COORDINATOR_ALREADY_LIVE',
      agentId: null,
      agentName: null,
      fixed: true,
    },
  },
});

/** `GET /projects/:id/integration` — the other half of How it runs: where the tasks land. */
const integration = () => ({
  line: 'PROJECT_BRANCH',
  lineAbsentReason: null,
  ref: `project/${PROJECT}`,
  upstreamRef: 'main',
  source: 'EXPLICIT',
  locked: true,
  startedAt: '2026-09-07T05:00:00.000Z',
  mergeCheckCommand: 'npm test',
  mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: null,
  escalationSeconds: 7200,
  commitsAheadOfUpstream: 2,
  commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
  integratingCount: 0,
  queuedCount: 0,
  mergeCheckOnTip: 'PASSING',
  inFlight: null,
});

/** `GET /projects/:id/panorama` — the work overview beside it. */
const panorama = (ready: number) => ({
  buckets: {
    running: 0,
    ready,
    blocked: 0,
    awaitingVerification: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
  },
  shape: { taskCount: ready + 1, edgeCount: 0, ratio: 0, maxDepth: 0, form: 'chain' },
});

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (statusCode: number, body: unknown) =>
  ({ ok: false, status: statusCode, statusText: 'Error', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/** The reads the switch depends on, and the project's own PATCH. Every other card on this page gets
 *  a 500 and says so where it stands — the state the panorama suite already pins. */
function serve(document: Record<string, unknown>, ready = 0) {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url === `/api/projects/${PROJECT}`) {
      return method === 'PATCH'
        ? okJson({ id: P1, ...(JSON.parse(String(init.body)) as object) })
        : okJson(document);
    }
    if (url === `/api/projects/${PROJECT}/coordinator/status`) return okJson(status());
    if (url === `/api/projects/${PROJECT}/integration`) return okJson(integration());
    if (url === `/api/projects/${PROJECT}/panorama`) return okJson(panorama(ready));
    return failJson(500, { message: `unstubbed endpoint: ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Only the writes — reading the project is not a change to it. */
const writes = (): Array<{ method: string; url: string; body: unknown }> =>
  fetchMock.mock.calls
    .map(([url, init]) => {
      const options = init as RequestInit | undefined;
      return {
        method: options?.method ?? 'GET',
        url: String(url),
        body: options?.body === undefined ? undefined : JSON.parse(String(options.body)),
      };
    })
    .filter((call) => call.method !== 'GET');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Node ≥24 defines its own `localStorage` on globalThis, and vitest's jsdom environment leaves
  // that one in place — where it is `undefined`, so the token read every request begins with
  // throws and the page renders as a load failure. Stubbed here for the same reason
  // `matchMedia` is: the runtime is missing something this page reads on every request.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Tick until `ready` holds, for up to twenty seconds rather than a fixed number of ticks. The
 *  project document, the coordinator status and the panorama each land on their own macrotask, and
 *  a loaded host does not deliver them on a schedule this file can count — so the bound is time,
 *  and it sits well inside the cases' timeout below: a switch that never draws fails HERE, by name,
 *  rather than as a case vitest gave up on. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
          <Routes>
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/projects" element={<div>Projects</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitFor(() => toggle() !== undefined, 'the Automatic switch to be drawn');
}

/** The switch a reader would press, by the accessible name their screen reader announces. */
const toggle = (): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (button) => button.getAttribute('aria-label') === 'Automatic',
  );

/** The block the switch lives in, so what it says is read where it is drawn and not from some
 *  other sentence elsewhere on the page. */
const blockText = (): string =>
  container.querySelector('section[aria-label="How it runs"]')?.textContent ?? '';
const coordinatorText = (): string =>
  container.querySelector('section[aria-label="Coordinator"]')?.textContent ?? '';
const saveButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="How it runs"] button')].find(
    (button) => (button.textContent ?? '').trim() === RUN_SAVE,
  );

/** Move the switch: a change to the block, not yet a write. */
async function flip(): Promise<void> {
  await act(async () => {
    toggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await tick();
}

/** Save, then wait for the request it makes to have actually left — every Save below is one
 *  write, and asserting its body before the mutation has run would read an empty list. */
async function save(): Promise<void> {
  await act(async () => {
    saveButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await waitFor(() => writes().length > 0, 'the write the Save makes');
  await tick();
}

// Past the 5s default because each case mounts the WHOLE detail page through `act` on real timers,
// and the first mount on a loaded host takes several times that. Running out is not one red: vitest
// gives up on the case with its body still running, that body's `act()` calls overlap the next
// case's, and React's act scope is left unbalanced — later cases then queue renders that are never
// flushed and wait for a switch that is never drawn. That is how one slow mount read as six reds.
describe('ProjectsPage — the Automatic switch', { timeout: 60_000 }, () => {
  it('draws it ON in How it runs from a project whose coordinatorEnabled is true', async () => {
    serve(detail({ coordinatorEnabled: true }));
    await mount();

    expect(toggle()).toBeTruthy();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    const body = blockText();
    expect(body).toContain('Automatic');
    expect(body).toContain('On');
    // What Automatic means on a project branch: the coordinator runs it, merges included.
    expect(body).toContain(RUN_AUTOMATIC_HINT_PROJECT_BRANCH);
    // …and it is How it runs' alone: the coordinator card no longer carries it.
    expect(coordinatorText()).not.toContain('Automatic');
  });

  it('draws it OFF from a project whose coordinatorEnabled is false, without saying the project stopped', async () => {
    serve(detail({ coordinatorEnabled: false }));
    await mount();

    expect(toggle()).toBeTruthy();
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    expect(blockText()).toContain('Off');
    // Off is "every step asks you", not "nothing moves": Pause project is the one stop now.
    expect(container.textContent).not.toContain('Nothing here starts or asks on its own');
    expect(container.textContent).not.toContain('waiting for someone to press Run');
  });

  it('writes nothing until Save', async () => {
    serve(detail({ coordinatorEnabled: false }));
    await mount();
    expect(saveButton()!.disabled).toBe(true);
    await flip();

    expect(writes()).toHaveLength(0);
    expect(saveButton()!.disabled).toBe(false);
  });

  it('turning it ON sends `automatic` and nothing else', async () => {
    serve(detail({ coordinatorEnabled: false }));
    await mount();
    await flip();
    await save();

    expect(writes()).toHaveLength(1);
    const write = writes()[0];
    expect(write.method).toBe('PATCH');
    expect(write.url).toBe(`/api/projects/${PROJECT}`);
    // The whole body, not a subset. `coordinatorEnabled` would be the older client's switch, whose
    // off the server reads as a pause; `automationPolicy` went with its column.
    expect(write.body).toEqual({
      automatic: true,
      expectedConfigRevision: REVISION,
    });
    expect(write.body).not.toHaveProperty('coordinatorEnabled');
    expect(write.body).not.toHaveProperty('automationPolicy');
  });

  it('turning it ON fences the write against the revision it was drawn at', async () => {
    serve(detail({ coordinatorEnabled: false, configRevision: '42' }));
    await mount();
    await flip();
    await save();

    // Not "some revision" — the one the payload this switch was rendered from carried. Deleting
    // `expectedConfigRevision` from the body turns THIS assertion red.
    expect(writes()[0].body).toMatchObject({ expectedConfigRevision: '42' });
  });

  it('turning it OFF writes the same one field, and the fence — and pauses nothing', async () => {
    serve(detail({ coordinatorEnabled: true }));
    await mount();
    await flip();
    await save();

    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({
      automatic: false,
      expectedConfigRevision: REVISION,
    });
    expect(writes().some((write) => write.url.endsWith('/pause'))).toBe(false);
  });

  it('shows the server’s own words when the project moved under the reader', async () => {
    serve(detail({ coordinatorEnabled: false }));
    // The read stays as served; only the write is refused, which is the shape of the race this
    // fence exists for: something else wrote the authorization set after this page read it.
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === `/api/projects/${PROJECT}` && init.method === 'PATCH') {
        return failJson(409, {
          code: 'STALE_CONFIG_REVISION',
          message:
            'this project is at configRevision 9, not 7 — its coordination settings changed after you read them, so nothing was written',
        });
      }
      return base(url, init);
    });
    await mount();
    await flip();
    await save();

    await waitFor(
      () => (container.textContent ?? '').includes(RUN_NOT_SAVED),
      'the refusal the server answered with',
    );
    const page = container.textContent ?? '';
    expect(page).toContain(RUN_NOT_SAVED);
    expect(page).toContain('its coordination settings changed after you read them');
    // Refused means nothing was written, and the reader's choice is still there to send again once
    // they have seen the project as it now stands.
    expect(saveButton()!.disabled).toBe(false);
  });
});
