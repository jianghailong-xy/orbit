// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectsPage } from './ProjectsPage';

/**
 * The toolbar as the reader drives it: pressing a segment, typing a search, starting a project.
 *
 * Mounted into a real DOM rather than rendered with `react-dom/server`, because every question
 * here is about what happens AFTER an interaction — and a static render invokes no `queryFn`, so
 * "the filter goes to the server" would pass on a page that never made the request. The page's
 * shape (rows, sections, empty copy) is asserted in ProjectsPage.test.tsx; what is only observable
 * here is which URLs the presses put on the wire, and which they do not.
 */
vi.mock('../api', () => ({ api: vi.fn() }));
// The detail page's graph reaches React Flow through a `lazy()` boundary, and importing this
// module pulls the whole file in. Stubbed for the reason the other project suites stub it: React
// Flow measures with a ResizeObserver jsdom does not have, and nothing here renders a graph.
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// Real UUIDs: the row link runs each id through encodeId, which throws on anything that is neither
// spelling — a placeholder here would fail the render rather than the assertion.
const P1 = '0195c0de-0000-7000-8000-000000000001';
const P2 = '0195c0de-0000-7000-8000-000000000002';
const P3 = '0195c0de-0000-7000-8000-000000000003';
const R1 = '0195c0de-0000-7000-8000-0000000000c1';
const R2 = '0195c0de-0000-7000-8000-0000000000c2';
const W_SHARED = '0195c0de-0000-7000-8000-0000000000d0';
const W1 = '0195c0de-0000-7000-8000-0000000000d1';
const W2 = '0195c0de-0000-7000-8000-0000000000d2';

/**
 * Goals written the way project goals actually are — as Markdown, because that is how they are
 * rendered on the project's own page. `**Ship**` and `## Move` are what make the search assertions
 * mean something: the phrase a reader would type is only present once the marks are gone.
 */
const REVAMP = {
  id: P1,
  title: 'Website Revamp',
  status: 'OPEN',
  goal: '**Ship** the new marketing site',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 1 },
  // Something running, so the row lands in a section that is expanded by default and its goal is
  // on the page for the search assertions to find. See lib/projectAttention.
  buckets: { running: 1, ready: 0, blocked: 0, done: 0, cancelled: 0 },
  lastActivityAt: new Date().toISOString(),
};
const CLEANUP = {
  id: P2,
  title: 'Legacy Cleanup',
  status: 'DONE',
  goal: 'Retire the old admin',
  createdAt: '2026-01-03T00:00:00Z',
  updatedAt: '2026-01-04T00:00:00Z',
  _count: { tasks: 1 },
  buckets: { running: 0, ready: 0, blocked: 0, done: 1, cancelled: 0 },
  lastActivityAt: '2026-01-04T00:00:00Z',
};
const LEDGER = {
  id: P3,
  title: 'Ledger Migration',
  status: 'OPEN',
  goal: '## Plan\n\nMove the `ledger` to Postgres',
  createdAt: '2026-01-05T00:00:00Z',
  updatedAt: '2026-01-06T00:00:00Z',
  _count: { tasks: 2 },
  buckets: { running: 1, ready: 0, blocked: 0, done: 1, cancelled: 0 },
  lastActivityAt: '2026-01-06T00:00:00Z',
};

/**
 * The projects collection, narrowed by `?status=` exactly the way the endpoint narrows it.
 *
 * Keyed by the WHOLE url, query string included — the point of these tests is which url was asked
 * for, so a mock that ignored the query string could not tell a filtered read from an unfiltered
 * one. Anything unrouted rejects, so a request this page should not be making shows up as a
 * failure rather than as a silently empty list.
 */
function serve(
  rows: Record<string, unknown[]>,
  navigation: { workspaces?: unknown[]; runners?: unknown[] } = {},
) {
  const answers: Record<string, unknown[]> = {
    '/workspaces': navigation.workspaces ?? [
      { id: W1, runnerId: R1, createdAt: '2026-01-01T00:00:00Z' },
    ],
    '/runners': navigation.runners ?? [{ id: R1 }],
    ...rows,
  };
  apiMock.mockImplementation((path: string) => {
    const answer = answers[path];
    if (!answer) return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    return Promise.resolve(answer) as Promise<never>;
  });
}

/** Every project-list path the page asked for, in order. Workspace and runner reads resolve the
 *  New project destination and are deliberately outside the status-filter assertions. */
const reads = () =>
  apiMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method !== 'POST')
    .map(([path]) => String(path))
    .filter((path) => path === '/projects' || path.startsWith('/projects?'));

let container: HTMLDivElement;
let root: Root;
let landedOn = '';

function RouteProbe() {
  const location = useLocation();
  landedOn = `${location.pathname}${location.search}`;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  landedOn = '';
  // antd's responsive controls subscribe to breakpoints on mount and jsdom ships no matchMedia. The
  // stub answers "no breakpoint matches", which is the desktop reading; layout is not the subject.
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
  // Some antd controls observe their boxes and jsdom ships no ResizeObserver. Their layout is not
  // the subject of these interaction tests.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects']}>
          <ProjectsPage />
          <RouteProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

/** One macrotask, so a resolved query's re-render lands before the assertion — an `await act` on
 *  its own only drains microtasks, which is not where react-query's state settles. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The whole mounted page as text. */
const text = () => document.body.textContent ?? '';

function segment(label: string): HTMLInputElement {
  const item = [...container.querySelectorAll('.ant-segmented-item')].find((el) =>
    el.textContent?.trim().startsWith(label),
  );
  expect(item, `segment ${label}`).toBeTruthy();
  return item!.querySelector('input')! as HTMLInputElement;
}

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found! as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

/** Type into a controlled antd field. React tracks the DOM value itself, so the native setter has
 *  to be called before the event or the change is swallowed as a no-op. */
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

const searchBox = () =>
  container.querySelector('input[aria-label="Search projects"]') as HTMLInputElement;

describe('ProjectsPage — status filter', () => {
  it('asks the server for the status that was pressed, instead of filtering the rows it holds', async () => {
    serve({
      '/projects': [REVAMP, CLEANUP, LEDGER],
      '/projects?status=OPEN': [REVAMP, LEDGER],
      '/projects?status=DONE': [CLEANUP],
    });
    await mount();
    // The unnarrowed read sends no parameter at all — which is how the endpoint spells "all".
    expect(reads()).toEqual(['/projects']);

    await click(segment('Open'));
    expect(reads()).toEqual(['/projects', '/projects?status=OPEN']);

    await click(segment('Completed'));
    expect(reads()).toEqual(['/projects', '/projects?status=OPEN', '/projects?status=DONE']);
    // The answer on screen is the one the server just gave, not a slice of the first read.
    expect(text()).toContain('Legacy Cleanup');
    expect(text()).not.toContain('Website Revamp');

    // ...and back to All, which is a request of its own rather than "show what was hidden".
    await click(segment('All'));
    expect(reads()).toEqual([
      '/projects',
      '/projects?status=OPEN',
      '/projects?status=DONE',
      '/projects',
    ]);
  }, 10_000);

  it('keeps each filter in its own cache entry, so switching back does not show the other one’s rows', async () => {
    serve({
      '/projects': [REVAMP, CLEANUP, LEDGER],
      '/projects?status=DONE': [CLEANUP],
    });
    await mount();
    await click(segment('Completed'));

    // The completed read replaced what is on screen rather than being merged into it: the open
    // projects are gone, which they could not be if both answers shared one entry.
    expect(text()).toContain('Legacy Cleanup');
    expect(text()).not.toContain('Ledger Migration');
  });
});

describe('ProjectsPage — search', () => {
  it('matches the goal with its Markdown removed, which is what the row shows', async () => {
    serve({ '/projects': [REVAMP, CLEANUP, LEDGER] });
    await mount();
    const before = reads().length;

    // The phrase is only present once `**Ship**` has become `Ship` — the raw goal does not
    // contain "ship the new marketing site" anywhere, so a search over the source text fails this.
    await type(searchBox(), 'ship the new marketing site');
    expect(text()).toContain('Website Revamp');
    expect(text()).not.toContain('Ledger Migration');

    // Same again across a heading and an inline-code span, in the other project's goal.
    await type(searchBox(), 'move the ledger to postgres');
    expect(text()).toContain('Ledger Migration');
    expect(text()).not.toContain('Website Revamp');

    // Titles too, since that is what most searches actually are.
    await type(searchBox(), 'revamp');
    expect(text()).toContain('Website Revamp');
    expect(text()).not.toContain('Ledger Migration');

    // And not one further request for any of it: the rows are already here, and eighteen projects
    // do not need a round trip per keystroke.
    expect(reads().length).toBe(before);
  });

  it('searches inside a folded section too, rather than only what is expanded', async () => {
    serve({ '/projects': [REVAMP, CLEANUP, LEDGER] });
    await mount();
    // Completed folds by default, so this project is a pill rather than a row — and still has to
    // be findable, which it would not be if the search only saw what was expanded.
    await type(searchBox(), 'retire the old admin');
    expect(text()).toContain('Legacy Cleanup');
    expect(text()).not.toContain('Website Revamp');
  });
});

describe('ProjectsPage — empty states', () => {
  it('tells "you have no projects" apart from "nothing here matches", and offers the way out of each', async () => {
    serve({ '/projects': [REVAMP, CLEANUP, LEDGER] });
    await mount();

    await type(searchBox(), 'zzzz');
    // The account HAS projects, so the sentence that says otherwise would be a lie — and the
    // control it comes with (create a project) would be the one thing that does not help.
    expect(text()).toContain('No projects match “zzzz”');
    expect(text()).not.toContain('No projects yet');
    // And nothing of the list survives beside it — every section is a header that would be
    // counting zero. ("Completed" is a segment as well as a section, which is why this asks the
    // DOM rather than the page text.)
    expect(container.querySelector('section')).toBeNull();

    // The way out is the search that caused it, not a new project.
    await click(button('Clear search'));
    expect(searchBox().value).toBe('');
    expect(text()).toContain('Website Revamp');
    expect(text()).toContain('Ledger Migration');
  });

  it('names the filter when that is what emptied the list', async () => {
    serve({ '/projects': [REVAMP, LEDGER], '/projects?status=DONE': [] });
    await mount();
    await click(segment('Completed'));

    expect(text()).toContain('No completed projects');
    expect(text()).not.toContain('No projects yet');

    // Show all projects puts the filter back where it started, and the rows with it.
    await click(button('Show all projects'));
    expect(text()).toContain('Website Revamp');
  });

  it('offers a create CTA on an account with nothing in it', async () => {
    serve({ '/projects': [] });
    await mount();

    expect(text()).toContain('No projects yet');
    const empty = container.querySelector('.ant-empty')!;
    // In the empty state itself, not only up in the toolbar: a reader who has never seen this page
    // is looking at the middle of it, and that is where the dead end used to be.
    const cta = button('New project', empty);
    await click(cta);
    // The empty-state CTA is wired to the same project-intent compose as the toolbar button.
    expect(landedOn).toBe(`/workspaces/${encodeId(W1)}/new?intent=project`);
  });
});

describe('ProjectsPage — starting a project', () => {
  it('opens project-intent compose in firstOpenableWorkspace order', async () => {
    serve(
      { '/projects': [REVAMP] },
      {
        // The first row cannot open, and R2 appears before R1 in workspace order. Runner order
        // still puts W1 first — exactly the choice firstOpenableWorkspace makes for DefaultLanding.
        workspaces: [
          { id: W_SHARED, runnerId: null, position: 0, createdAt: '2026-01-01T00:00:00Z' },
          { id: W2, runnerId: R2, position: 1, createdAt: '2026-01-02T00:00:00Z' },
          { id: W1, runnerId: R1, position: 2, createdAt: '2026-01-03T00:00:00Z' },
        ],
        runners: [{ id: R1 }, { id: R2 }],
      },
    );
    await mount();

    await click(button('New project', container));

    expect(landedOn).toBe(`/workspaces/${encodeId(W1)}/new?intent=project`);
  });

  it.each([
    { label: 'registration guide', runners: [], expected: '/runners/register' },
    { label: 'only runner', runners: [{ id: R1 }], expected: `/runners/${encodeId(R1)}` },
    { label: 'runner picker', runners: [{ id: R1 }, { id: R2 }], expected: '/runners' },
  ])('uses the DefaultLanding $label when no workspace can open', async ({ runners, expected }) => {
    serve(
      { '/projects': [REVAMP] },
      {
        workspaces: [
          { id: W_SHARED, runnerId: null, createdAt: '2026-01-01T00:00:00Z' },
        ],
        runners,
      },
    );
    await mount();

    await click(button('New project', container));

    expect(landedOn).toBe(expected);
  });
});
