// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectDetailPage, ProjectsPage } from './ProjectsPage';

/**
 * Writing a project's own status from the web — the one write the product reserves to the account
 * owner and, until now, gave them no door onto.
 *
 * `fetch` is stubbed rather than the `api` module, so what these assert is the REQUEST that leaves
 * the client: the method, the path and the JSON body. A mocked `api` would let this file pass
 * against an argument list rather than against a PATCH.
 *
 * Every predicate below is over RENDERED OUTPUT — `container.textContent`, the portal antd puts a
 * modal in, the `disabled` property of the button a reader would press. None of it reads a prop or
 * a mutation object: a confirmation that holds the right numbers in state and draws none of them
 * is the exact defect this entry exists to avoid.
 */
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
// Toasts need antd's App context, which this page is mounted without.
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-000000000001';
/** The spelling the route carries and every URL below is built from. */
const PROJECT = encodeId(P1);
const TITLE = 'Website Revamp';

/**
 * The criteria the DONE confirmation has to account for, in the shape `GET /projects/:id` serves:
 * every one of them settled, and one of them with no receipt proving the work landed.
 *
 * That combination is not hypothetical — it is what project 34IUpy9PJxnqgJ6TGHP24 read on
 * 2026-09-05, and it is the case a confirmation showing `satisfied` alone would present as an
 * unbroken green.
 */
const CRITERIA = [
  {
    id: 'crit-1',
    ordinal: 1,
    text: 'The owner can write the project status from the project page',
    revision: 1,
    satisfied: true,
    landing: 'UNKNOWN' as const,
  },
  {
    id: 'crit-2',
    ordinal: 2,
    text: 'The confirmation states what the server can and cannot say',
    revision: 1,
    satisfied: true,
    landing: 'LANDED' as const,
  },
  {
    id: 'crit-3',
    ordinal: 3,
    text: 'Reopening a project asks once and asks for nothing',
    revision: 1,
    satisfied: true,
    landing: 'LANDED' as const,
  },
];

/** OPEN + IN_PROGRESS + FAILED = four tasks that have not ended, beside four that have. A FAILED
 *  task is a run's own report that it stopped short, so it is outstanding work by the only reading
 *  that matters to somebody abandoning the goal above it. */
const TASKS_BY_STATUS = { OPEN: 2, IN_PROGRESS: 1, FAILED: 1, DONE: 3, CANCELLED: 1 };
const UNFINISHED = 4;

const detail = (over: Record<string, unknown> = {}) => ({
  id: P1,
  title: TITLE,
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  instructions: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 8 },
  tasksByStatus: TASKS_BY_STATUS,
  acceptanceCriteriaItems: CRITERIA,
  ...over,
});

const P2 = '0195c0de-0000-7000-8000-000000000002';

/** A row of GET /projects, in the shape that endpoint always sends: seven buckets and a last
 *  activity even for a project with no tasks. Seeded so the list draws rows — a negative control
 *  over an empty list would pass whatever a row contains. */
const listRow = (id: string, title: string) => ({
  id,
  title,
  status: 'OPEN',
  goal: `The goal of ${title}`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 2 },
  buckets: {
    running: 0,
    ready: 1,
    blocked: 0,
    awaitingVerification: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
  },
  lastActivityAt: '2026-01-02T00:00:00Z',
  attention: {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
  },
});

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (status: number, body: unknown) =>
  ({ ok: false, status, statusText: 'Error', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/** The project document, and its own PATCH. Every other card on this page reads its own endpoint
 *  and gets a 500 — the state the panorama suite pins, where each card carries its own failure and
 *  the page stands. */
function serve(document: Record<string, unknown>) {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url === `/api/projects/${PROJECT}`) {
      return method === 'PATCH'
        ? okJson({ id: P1, ...(JSON.parse(String(init.body)) as object) })
        : okJson(document);
    }
    return failJson(500, { message: `unstubbed endpoint: ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Every request the page put on the wire: method, url, and the parsed body where it sent one. */
const wire = (): Array<{ method: string; url: string; body: unknown }> =>
  fetchMock.mock.calls.map(([url, init]) => {
    const options = init as RequestInit | undefined;
    return {
      method: options?.method ?? 'GET',
      url: String(url),
      body: options?.body === undefined ? undefined : JSON.parse(String(options.body)),
    };
  });

/** Only the writes — a read of the project document is not a status change. */
const writes = () => wire().filter((call) => call.method !== 'GET');

let container: HTMLDivElement;
let root: Root;

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
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // React Query delivers an answered query on a macrotask, and the cards below the project
  // document only mount once IT has landed.
  for (let i = 0; i < 3; i += 1) await tick();
}

const page = (): ReactElement => (
  <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
      <Route path="/projects" element={<div>Projects</div>} />
    </Routes>
  </MemoryRouter>
);

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** A status entry on the page itself, found by the accessible name a reader's assistive technology
 *  announces rather than by the class the button happens to carry. */
const entry = (label: RegExp): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) =>
    label.test(button.getAttribute('aria-label') ?? ''),
  );

/** The open confirmation, in the portal antd puts it in — never `container`. */
const dialog = (): HTMLElement | null => document.body.querySelector('.ant-modal');
const dialogText = (): string => dialog()?.textContent ?? '';

/** The confirmation's own confirm, matched on the words the reader reads on it. */
const confirmButton = (label: RegExp): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find((button) =>
    label.test((button.textContent ?? '').trim()),
  );

/** Open one of the page's status confirmations and hand back what it drew. */
async function open(label: RegExp): Promise<string> {
  const press = entry(label);
  expect(press, `the project page offers no ${label} entry`).toBeTruthy();
  await click(press!);
  return dialogText();
}

// Past the 5s default because each case mounts the WHOLE detail page through `act` on real timers.
describe('ProjectDetailPage — recording the project’s own status', { timeout: 20_000 }, () => {
  it('offers the status write on the project page, and offers a REOPEN once one was written', async () => {
    serve(detail());
    await mount(page());

    // An open project can be recorded either way, from the page that shows what it is for.
    expect(entry(/Record .* as done/), 'no way to record the goal as met').toBeTruthy();
    expect(entry(/Record .* as cancelled/), 'no way to stop pursuing the goal').toBeTruthy();
    // Rendering the page writes nothing, and neither does finding the button.
    expect(writes()).toEqual([]);

    // ...and only there. Every row of the projects LIST is one full-width `<Link>`, so a status
    // press inside it would be interactive content nested in an anchor — the same reason the
    // delete beside it lives on the project's own page rather than on its row. The list is seeded
    // with real rows first: a negative control over a page that drew no rows at all would pass
    // whatever a row contains.
    const client = new QueryClient();
    client.setQueryData(['projects', 'OPEN'], [listRow(P1, TITLE), listRow(P2, 'Legacy Cleanup')]);
    const list = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects?status=OPEN']}>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(list, 'the list drew no rows, so it can contradict nothing').toContain(TITLE);
    expect(list).toContain('Legacy Cleanup');
    expect(list).not.toContain('Record as done');
    expect(list).not.toContain('Reopen project');

    await act(async () => root.unmount());
    container.remove();

    // A project already recorded DONE offers the way BACK, and does not offer the same claim
    // twice: the correction path is what a written status needs, not a second press of itself.
    serve(detail({ status: 'DONE' }));
    await mount(page());
    expect(entry(/Reopen/), 'a completed project offers no way back').toBeTruthy();
    expect(entry(/Record .* as done/)).toBeUndefined();
    expect(container.textContent).not.toContain('Record as done');
  });

  it('puts BOTH facts in the confirmation: what settled, and what has a receipt', async () => {
    serve(detail());
    await mount(page());

    const asked = await open(/Record .* as done/);

    // The count of settled criteria — and, in the same breath, the count with no receipt proving
    // the work reached the default branch. Settlement alone is the false green this exists to
    // prevent: it is derived inside each task's own worktree and says nothing about main.
    expect(asked).toContain('3 stated criteria');
    expect(asked).toContain('3 settled by the work filed under them');
    expect(asked).toContain('1 with no merge receipt');
    // And per criterion, not only as a tally: each row carries its own two facts.
    expect(asked).toContain('Settled · No merge receipt');
    expect(asked).toContain('Settled · Landed — merge receipt');
    expect(asked).toContain('The owner can write the project status from the project page');
    // Opening the question is not answering it.
    expect(writes()).toEqual([]);
  });

  it('never spells a missing receipt as a finding that the work is not on main', async () => {
    serve(detail());
    await mount(page());

    const asked = await open(/Record .* as done/);

    // UNKNOWN is the absence of evidence, and the server's own type omits NOT_LANDED so that
    // nobody can assert it. The confirmation may not assert it in prose either.
    expect(asked).not.toMatch(/not merged/i);
    expect(asked).not.toMatch(/unmerged/i);
    expect(asked).not.toContain('未合并');
    expect(asked).not.toContain('NOT_LANDED');
    // What it says instead, in both languages the copy is written in.
    expect(asked).toContain('Orbit holds no receipt proving that work landed');
    expect(asked).toContain('这是证据缺席');
  });

  it('leaves the press enabled with a receipt missing, and sends PATCH {status: DONE}', async () => {
    serve(detail());
    await mount(page());
    await open(/Record .* as done/);

    // A claim is the person's to make on incomplete evidence. Missing receipts are something they
    // are told, never something that takes the decision off them.
    const confirm = confirmButton(/^Record as done$/);
    expect(confirm, 'the confirmation has no confirm').toBeTruthy();
    expect(confirm!.disabled, 'a missing receipt disabled the press').toBe(false);
    expect(confirm!.className).not.toContain('ant-btn-disabled');

    await click(confirm!);
    await tick();
    await tick();

    expect(writes()).toEqual([
      { method: 'PATCH', url: `/api/projects/${PROJECT}`, body: { status: 'DONE' } },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Recorded as done');
  });

  it('asks a different question to stop pursuing a goal: unfinished work, not criteria', async () => {
    serve(detail());
    await mount(page());

    const asked = await open(/Record .* as cancelled/);

    // Giving up on a goal is not a statement about whether it was met, so the evidence behind that
    // claim has no place here...
    expect(document.body.querySelector('.project-status-evidence')).toBeNull();
    expect(asked).not.toContain('settled by the work filed under them');
    expect(asked).not.toContain('merge receipt');
    // ...and what the reader does need is how much unfinished work they are walking away from.
    expect(asked).toContain(`${UNFINISHED} unfinished tasks stay filed under it.`);
    expect(asked).toContain(`项目下还有 ${UNFINISHED} 个任务没有结束`);

    await click(confirmButton(/^Record as cancelled$/)!);
    await tick();
    await tick();

    expect(writes()).toEqual([
      { method: 'PATCH', url: `/api/projects/${PROJECT}`, body: { status: 'CANCELLED' } },
    ]);
  });

  it('reopens without evidence friction, and sends PATCH {status: OPEN}', async () => {
    serve(detail({ status: 'DONE' }));
    await mount(page());

    const asked = await open(/Reopen/);

    // Reopening is reversible and is the correction path. Making somebody read an evidence table
    // to undo a status they wrote by mistake would strand exactly the person it is there for.
    expect(document.body.querySelector('.project-status-evidence')).toBeNull();
    expect(asked).not.toContain('merge receipt');
    expect(asked).not.toContain('settled by the work filed under them');
    expect(asked).not.toContain('Settled ·');

    await click(confirmButton(/^Reopen$/)!);
    await tick();
    await tick();

    expect(writes()).toEqual([
      { method: 'PATCH', url: `/api/projects/${PROJECT}`, body: { status: 'OPEN' } },
    ]);
  });

  it('says “record”, never “mark complete”, and says it in both of the app’s languages', async () => {
    // Every string this entry added, as the reader actually receives it: the page's own buttons
    // plus all three confirmations. Scanned rather than grepped out of the source, so copy that is
    // written and never drawn cannot pass, and copy that is drawn cannot hide.
    const drawn: string[] = [];

    serve(detail());
    await mount(page());
    drawn.push(container.textContent ?? '');
    drawn.push(await open(/Record .* as done/));
    await click(confirmButton(/^Back$/)!);
    drawn.push(await open(/Record .* as cancelled/));
    await act(async () => root.unmount());
    container.remove();

    serve(detail({ status: 'DONE' }));
    await mount(page());
    drawn.push(container.textContent ?? '');
    drawn.push(await open(/Reopen/));

    const copy = drawn.join('\n');
    // `mark` reads as filing a status the system already holds. A task's DONE is derived
    // everywhere in this product; this one project field is not, and the verb has to say so.
    expect(copy.match(/mark complete/gi) ?? []).toEqual([]);
    expect(copy).toContain('Record as done');

    // Both sides of the app's copy, asserted over what was rendered rather than over the English
    // half alone — a scan that only knows English reads a Chinese sentence as silence.
    expect(copy).toMatch(/[一-鿿]/);
    expect(copy).toContain('按下即是你在为这个目标作出主张');
    expect(copy).toContain('这表示不再追求这个目标');
    expect(copy).toContain('重开只是把项目改回 Open');
    expect(copy).toContain('Recording it is a claim you are making about the goal');
    expect(copy).toContain('This records that the goal is no longer being pursued');
    expect(copy).toContain('Reopening puts this project back to Open');
  });
});
