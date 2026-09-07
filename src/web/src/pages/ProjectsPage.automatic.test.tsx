// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycleState, SessionRunState } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * `Automatic` — the first control anywhere over `project.coordinatorEnabled`.
 *
 * The field decides whether a project starts its own ready tasks AND whether any of the six
 * producers may wake a judgment session. Twelve projects in production sit at
 * `coordinator_enabled = false` with an automation policy that says GUARDED_AUTO, and until this
 * switch no page could say why they were silent.
 *
 * `fetch` is stubbed rather than the `api` module, exactly as ProjectsPage.status.test.tsx does it,
 * so what these assert is the REQUEST that leaves the client: the method, the path and the JSON
 * body. Two halves of that body are load-bearing and neither is visible from "the mutation was
 * called" — `automationPolicy`, without which turning the switch ON is a 400, and
 * `expectedConfigRevision`, without which two editors silently overwrite each other. Each has a
 * red-proving negative recorded in the commit message: deleting either half from the
 * implementation turns exactly one assertion below red.
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
  configRevision: REVISION,
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

/** `GET /projects/:id/panorama` — where the count behind the Off warning comes from. */
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

/** The three reads the switch depends on, and the project's own PATCH. Every other card on this
 *  page gets a 500 and says so where it stands — the state the panorama suite already pins. */
function serve(document: Record<string, unknown>, ready = 0) {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url === `/api/projects/${PROJECT}`) {
      return method === 'PATCH'
        ? okJson({ id: P1, ...(JSON.parse(String(init.body)) as object) })
        : okJson(document);
    }
    if (url === `/api/projects/${PROJECT}/coordinator/status`) return okJson(status());
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

/** Tick until `ready` holds, rather than a fixed number of times. The project document, the
 *  coordinator status and the panorama each land on their own macrotask, and a suite running two
 *  files at once does not deliver them on a schedule this file can count — a fixed loop passes
 *  alone and fails beside its neighbours, which is the flake this avoids rather than assumes. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (ready()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
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
const toggle = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(
    (button) => button.getAttribute('aria-label') === 'Automatic',
  );

/** The card the switch lives on, so the Off consequence is read where it is drawn and not from
 *  some other sentence elsewhere on the page that happens to carry a number. */
const cardText = (): string =>
  container.querySelector('section[aria-label="Coordinator"]')?.textContent ?? '';

/** Press, then wait for the request it makes to have actually left — every press below is one
 *  write, and asserting its body before the mutation has run would read an empty list. */
async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await waitFor(() => writes().length > 0, 'the write the press makes');
  await tick();
}

describe('ProjectsPage — the Automatic switch', () => {
  it('draws it ON from a project whose coordinatorEnabled is true', async () => {
    serve(detail({ coordinatorEnabled: true }));
    await mount();

    expect(toggle()).toBeTruthy();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    const body = cardText();
    expect(body).toContain('Automatic');
    expect(body).toContain('On');
    expect(body).toContain('Starts ready tasks on its own');
    expect(body).toContain('opens a judgment session when a criterion needs a decision');
  });

  it('draws it OFF from a project whose coordinatorEnabled is false, and states the consequence', async () => {
    serve(detail({ coordinatorEnabled: false }));
    await mount();

    expect(toggle()).toBeTruthy();
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    // Off has to say what it COSTS. "Automatic: Off" is a setting; this is what it means.
    expect(cardText()).toContain('Nothing here starts or asks on its own');
  });

  it('counts the waiting work from the panorama, not from a constant', async () => {
    serve(detail({ coordinatorEnabled: false }), 4);
    await mount();
    expect(cardText()).toContain('4 ready tasks are waiting for someone to press Run');
    expect(cardText()).not.toContain('11 ready tasks');

    // The same page, the same switch, a different project state — and a different number. A
    // hard-coded warning passes the assertion above and fails this pair.
    await act(async () => root.unmount());
    container.remove();
    serve(detail({ coordinatorEnabled: false }), 11);
    await mount();
    expect(cardText()).toContain('11 ready tasks are waiting for someone to press Run');
    expect(cardText()).not.toContain('4 ready tasks');
  });

  it('turning it ON names the automation level in the SAME request', async () => {
    serve(detail({ coordinatorEnabled: false }));
    await mount();
    await press(toggle()!);

    expect(writes()).toHaveLength(1);
    const write = writes()[0];
    expect(write.method).toBe('PATCH');
    expect(write.url).toBe(`/api/projects/${PROJECT}`);
    // The server refuses a bare `coordinatorEnabled: true` with a 400 — turning a project automatic
    // without saying how far it may go would pick a level of automation on the reader's behalf.
    // Deleting the `automationPolicy` half of the body turns THIS assertion red.
    expect(write.body).toMatchObject({
      coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO',
    });
  });

  it('turning it ON fences the write against the revision it was drawn at', async () => {
    serve(detail({ coordinatorEnabled: false, configRevision: '42' }));
    await mount();
    await press(toggle()!);

    // Not "some revision" — the one the payload this switch was rendered from carried. Deleting
    // `expectedConfigRevision` from the body turns THIS assertion red.
    expect(writes()[0].body).toMatchObject({ expectedConfigRevision: '42' });
  });

  it('turning it OFF sends no level, because stopping needs no permission to be named', async () => {
    serve(detail({ coordinatorEnabled: true }));
    await mount();
    await press(toggle()!);

    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({
      coordinatorEnabled: false,
      expectedConfigRevision: REVISION,
    });
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
    await press(toggle()!);

    await waitFor(
      () => (container.textContent ?? '').includes('Automatic could not be changed'),
      'the refusal the server answered with',
    );
    const page = container.textContent ?? '';
    expect(page).toContain('Automatic could not be changed');
    expect(page).toContain('its coordination settings changed after you read them');
    // Refused means refused: the switch still reads the project's stored value, not the press.
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
  });
});
