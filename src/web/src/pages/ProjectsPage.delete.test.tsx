// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * Deleting a project from the web, which until now could only be done from the CLI.
 *
 * `fetch` is stubbed rather than the `api` module, so what is asserted is the REQUEST — the method
 * and the URL that actually leave the client — instead of the arguments one internal helper was
 * called with. It is also what keeps the third question honest: the sentence the reader has to see
 * is the server's own response BODY, and `api()` is the thing that turns that body into the
 * message rendered. Hand-throwing an `Error` from a mocked module would assert that a string the
 * test wrote reaches the page, which is not the same claim.
 */
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
// Toasts need antd's App context, which this page is mounted without. Stubbed so a successful
// delete's confirmation is observable as a call rather than as a portal that has to be found.
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-000000000001';
/** The spelling the route carries and every URL below is built from — `routeId` normalizes the
 *  route param to it, so a fixture keyed any other way would answer a request nobody makes. */
const PROJECT = encodeId(P1);
const TITLE = 'Website Revamp';

const DETAIL = {
  id: P1,
  title: TITLE,
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  instructions: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 0 },
  tasksByStatus: { OPEN: 0 },
  acceptanceCriteriaItems: [],
};

/** The sentence the server actually answers a held-down project with (projects.service `remove`),
 *  not a placeholder: what is asserted below is that THIS prose reaches the reader intact. */
const HELD_DOWN =
  'This project still holds one or more task(s) and cannot be deleted — ' +
  'move them to another project or delete them first';

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (status: number, body: unknown) =>
  ({ ok: false, status, statusText: 'Error', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * The whole page's wire.
 *
 * Only the project document and its own DELETE are answered; every other card on this page reads
 * its own endpoint and gets a 500, which is the state the panorama suite pins — each card carries
 * its own failure and the page stands. Keeping them unanswered is deliberate: a fixture for six
 * cards would be six more ways for this file to fail for a reason that is not deletion.
 */
function serve(deleteAnswer: () => Response = () => okJson({ ok: true })) {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url === `/api/projects/${PROJECT}`) {
      return method === 'DELETE' ? deleteAnswer() : okJson(DETAIL);
    }
    return failJson(500, { message: `unstubbed endpoint: ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Every request the page put on the wire, as `METHOD url`. */
const wire = (): string[] =>
  fetchMock.mock.calls.map(
    ([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`,
  );

let container: HTMLDivElement;
let root: Root;

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const currentLocation = (): string | null =>
  container.querySelector('[data-testid="location"]')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toast.success.mockReset();
  // antd's responsive controls subscribe to breakpoints on mount and jsdom ships no matchMedia;
  // "no breakpoint matches" is the desktop reading, and layout is not this file's subject.
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

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    // A failed read has to reach its card's error branch on the first answer rather than after
    // three silent retries, and a refused DELETE has to reach the page's.
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // React Query delivers an answered query on a macrotask, so a microtask flush would leave the
  // assertions looking at a spinner. Twice over: the cards below the project document only mount
  // once IT has landed, so their reads are answered a tick later than its.
  for (let i = 0; i < 3; i += 1) await tick();
}

const page = (): ReactElement => (
  <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
      <Route path="/projects" element={<div>Projects</div>} />
    </Routes>
    <RouteProbe />
  </MemoryRouter>
);

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The page's delete entry, found the way a reader's assistive technology finds it. */
const deleteEntry = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[aria-label*="Delete"]');

/** The confirmation's own Delete, in the portal antd puts it in — never `container`. */
const confirmButton = (): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>('.ant-popconfirm .ant-btn-primary');

// Past the 5s default because each case mounts the WHOLE detail page through `act` on real timers.
// Not a hang budget: a slow-render one.
describe('ProjectDetailPage — deleting a project', { timeout: 20_000 }, () => {
  it('offers a delete entry that names the project it would remove', async () => {
    serve();
    await mount(page());

    const entry = deleteEntry();
    expect(entry, 'the project detail page has no delete entry').not.toBeNull();
    // The accessible name, not the visible label: this is the string a screen reader announces,
    // and it is what tells two projects' delete buttons apart.
    expect(entry!.getAttribute('aria-label')).toContain('Delete');
    expect(entry!.getAttribute('aria-label')).toContain(TITLE);

    // Nothing is deleted by rendering the page, and nothing is deleted by finding the button.
    expect(wire().filter((call) => call.startsWith('DELETE'))).toEqual([]);
  });

  it('asks first — naming the project — before sending DELETE /projects/:id', async () => {
    serve();
    await mount(page());

    await click(deleteEntry()!);

    // The confirmation names the project. A press on the wrong row costs the whole project and
    // cannot be undone, so the question has to say which one is about to go.
    const asked = document.body.textContent ?? '';
    expect(asked).toContain(`Delete “${TITLE}”?`);
    expect(asked).toContain('cannot be undone');
    // Opening the question is not answering it: the wire is still clean.
    expect(wire().filter((call) => call.startsWith('DELETE'))).toEqual([]);

    await click(confirmButton()!);
    await tick();
    await tick();

    expect(wire()).toContain(`DELETE /api/projects/${PROJECT}`);
    const [, init] = fetchMock.mock.calls.find(
      ([, options]) => (options as RequestInit | undefined)?.method === 'DELETE',
    ) as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    // A deleted project is not a project the reader is left staring at.
    expect(toast.success).toHaveBeenCalledWith('Project deleted');
    expect(currentLocation()).toBe('/projects');
  });

  // 409 is the refusal this endpoint actually answers with (a task, or a session a coordinator
  // dispatched from one of this project's actions, still points at it); 403 is the other refusal a
  // person can meet. Both carry a `message`, and the page's job is the same for either: show it.
  for (const status of [409, 403]) {
    it(`shows the server's own ${status} message instead of failing silently`, async () => {
      const refusal = status === 409 ? HELD_DOWN : 'You do not own this project';
      serve(() => failJson(status, { message: refusal, statusCode: status }));
      await mount(page());

      await click(deleteEntry()!);
      await click(confirmButton()!);
      await tick();
      await tick();

      expect(container.textContent).toContain(refusal);
      // Still on the project, so the sentence is next to the button that earned it.
      expect(currentLocation()).toBe(`/projects/${PROJECT}`);
      expect(toast.success).not.toHaveBeenCalled();
    });
  }
});
