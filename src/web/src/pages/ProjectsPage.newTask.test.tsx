// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SessionLifecycleState, SessionRunState } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorStatus } from '../components/ProjectCoordinatorCard';
import { encodeId } from '../lib/idCodec';
import { NEW_TASK_INTENT, ProjectTasks, coordinatorIntentPath } from './ProjectsPage';

/**
 * The project page's New task door: what the press costs, and which of the three answers it can
 * get.
 *
 * The dialog it used to open is gone (30362f33c — tasks are created by agents, and that form's
 * Completion criterion picker could write a row nothing can dispatch and nothing can settle), so
 * what is left of "add work to this project" is the one press that hands the reader to this
 * project's coordinator conversation. It resolves-or-creates through the SERVER like every other
 * link to a coordinator, and the three cases below are the three things that can come back: a
 * conversation that had never been opened, one that went to Trash, and a project with nowhere to
 * open one. None of them may be a button that does nothing.
 *
 * A real DOM rather than `react-dom/server`, for the reason the coordinator section's own suite
 * uses one: a button has to actually be pressed for what it does to mean anything. Mounting
 * `ProjectTasks` directly is that same argument's other half — the section the project page draws
 * below the graph, pressed without rendering the whole page around it.
 */
vi.mock('../api', async (importOriginal) => ({
  // `ApiError` REAL, not restated: the refusal below is rendered from `error.message`, and a
  // stand-in class here would let that pass against a shape the client never throws.
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  restoreSession: vi.fn(),
}));
const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT = encodeId('0195c0de-0000-7000-8000-000000000001');
/** The session the status read POINTS at — stale by construction in the trashed case. */
const POINTER = encodeId('0195c0de-0000-7000-8000-0000000000b1');
/** The session the SERVER hands back. A different id, which is the whole point of the POST. */
const SERVED = encodeId('0195c0de-0000-7000-8000-0000000000b2');

const READ_AT = '2026-09-20T07:00:00.000Z';

/** The 400 a project with no task to borrow a workspace from answers with, word for word as the
 *  service throws it: the sentence this door exists to hand back rather than swallow. */
const NO_LANDING_WORKSPACE =
  'no workspace to open the coordinator in — none of this project’s tasks has an assignee to ' +
  'borrow one from. Assign a task, or pass workspaceId.';

/** A project whose coordinator has never opened: nothing is bound, so a press creates one. */
function neverOpenedStatus(): CoordinatorStatus {
  return {
    projectId: PROJECT,
    readAt: READ_AT,
    state: 'NEVER_OPENED',
    coordination: {
      sessionId: null,
      sessionIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
      session: null,
      sessionAbsentReason: 'COORDINATOR_NEVER_OPENED',
      coordinatorGeneration: '0',
      workspaceId: null,
      workspaceIdAbsentReason: 'NO_COORDINATION_WORKSPACE',
      workspaceName: null,
      workspaceNameAbsentReason: 'NO_COORDINATION_WORKSPACE',
      agentId: null,
      agentIdAbsentReason: 'NO_COORDINATOR_AGENT',
      agentName: null,
      agentNameAbsentReason: 'NO_COORDINATOR_AGENT',
    },
    openability: {
      canOpen: true,
      willCreate: true,
      refusalCode: null,
      refusalDetail: null,
      refusalCodeAbsentReason: 'NOTHING_REFUSES',
      requiredAction: null,
      requiredActionAbsentReason: 'NOTHING_REFUSES',
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
        workspaceName: null,
        workspaceNameAbsentReason: 'COORDINATOR_NEVER_OPENED',
        agentId: null,
        agentName: null,
        fixed: false,
      },
    },
  };
}

/** A project whose coordinator conversation is in the Trash: the pointer resolves to a session
 *  that is still readable and cannot be continued, which is the one case a press replaces rather
 *  than resumes. */
function trashedStatus(): CoordinatorStatus {
  const s = neverOpenedStatus();
  return {
    ...s,
    state: 'TRASHED',
    coordination: {
      ...s.coordination,
      sessionId: POINTER,
      sessionIdAbsentReason: null,
      session: {
        id: POINTER,
        title: 'Coordinating Website Revamp',
        runStatus: 'AWAITING_INPUT',
        runState: SessionRunState.AWAITING_INPUT,
        lifecycleState: SessionLifecycleState.TRASH,
        filingState: 'TRASH',
        endReason: null,
        startedAt: '2026-09-20T06:48:00.000Z',
        finishedAt: null,
        completedAt: null,
        deletedAt: '2026-09-20T06:52:00.000Z',
        engineTurnActive: false,
        pendingApprovals: 0,
      },
      sessionAbsentReason: null,
      coordinatorGeneration: '1',
      workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
      workspaceIdAbsentReason: null,
      workspaceName: 'orbit-main',
      workspaceNameAbsentReason: null,
      agentId: '3CuIHiSJZBQ7nLVUwc7ekz',
      agentIdAbsentReason: null,
      agentName: 'orbit',
      agentNameAbsentReason: null,
    },
  };
}

/** Never opened, and nothing to borrow: no task in this project has an assignee, so the read
 *  already knows an empty-bodied press will 400 — and so does the press. */
function nowhereToOpenStatus(): CoordinatorStatus {
  const s = neverOpenedStatus();
  return {
    ...s,
    openability: {
      ...s.openability,
      canOpen: false,
      refusalCode: 'NO_LANDING_WORKSPACE',
      refusalDetail: 'NO_TASK_ASSIGNEE',
      refusalCodeAbsentReason: null,
      requiredAction: NO_LANDING_WORKSPACE,
      requiredActionAbsentReason: null,
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: 'LANDING_REFUSED',
        workspaceName: null,
        workspaceNameAbsentReason: 'LANDING_REFUSED',
        agentId: null,
        agentName: null,
        fixed: false,
      },
    },
  };
}

/** The one page of top-level tasks this section reads. EMPTY: the door is offered on a project
 *  whose tasks have not been created yet, which is exactly where "add work" matters most. */
const TASK_PAGE = { items: [], nextCursor: null };

/** `GET /projects/:id/integration`, as the endpoint sends it — every absence naming its reason.
 *  Answered because the section reads it, not because anything below asserts on it. */
const INTEGRATION = {
  line: null,
  lineAbsentReason: 'NOT_DECIDED',
  ref: null,
  upstreamRef: null,
  source: null,
  locked: false,
  startedAt: null,
  mergeCheckCommand: null,
  mergeCheckCommandAbsentReason: 'NOT_CONFIGURED',
  mergeCheckTimeoutSeconds: null,
  escalationSeconds: 3600,
  commitsAheadOfUpstream: null,
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET',
  lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
  integratingCount: 0,
  queuedCount: 0,
  mergeCheckOnTip: 'UNKNOWN',
};

/** What the press is answered with, per test. `body` is captured rather than assumed: the request
 *  is part of what a press costs. */
type Write = (path: string, body: unknown) => Promise<unknown>;

/** Answer each read with the payload its own endpoint serves, and every write through `write` —
 *  so a status read cannot be answered with the task page, which is a payload with no
 *  `coordination` in it. */
function serve(status: CoordinatorStatus, write: Write) {
  apiMock.mockImplementation((path: string, init?: unknown) => {
    if (init) return write(path, (init as { body?: unknown }).body) as Promise<never>;
    if (path.endsWith('/coordinator/status')) return Promise.resolve(status) as Promise<never>;
    if (path.endsWith('/integration')) return Promise.resolve(INTEGRATION) as Promise<never>;
    return Promise.resolve(TASK_PAGE) as Promise<never>;
  });
}

let container: HTMLDivElement;
let root: Root;
/** Where the reader ENDED UP, query string included: the intent this door carries is in the URL
 *  and nowhere else, so a probe reading `pathname` alone could not see it. */
let landedOn = '';

function Probe() {
  const location = useLocation();
  landedOn = `${location.pathname}${location.search}`;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  landedOn = '';
  // antd's Modal/Select siblings subscribe to breakpoints on mount and jsdom ships no matchMedia.
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        {/* The toast surface: without it AntD's `App.useApp()` hands back no-ops, and the one
            sentence a re-opened conversation has to produce would go nowhere — silently. */}
        <AntApp>
          <MemoryRouter initialEntries={['/projects/x']}>
            <Routes>
              <Route path="*" element={node} />
            </Routes>
            <Probe />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** React Query answers on a macrotask, and antd's message layer paints on another. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(label: RegExp): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) =>
    label.test((b.textContent ?? '').trim()),
  );
  expect(button, `a button matching ${label}`).toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await settle();
}

const section = (): ReactElement => <ProjectTasks projectId={PROJECT} />;

describe('the project page’s New task door', () => {
  it('opens a coordinator that has never been opened, and lands in the conversation it names', async () => {
    const posts: Array<[string, unknown]> = [];
    serve(neverOpenedStatus(), (path, body) => {
      posts.push([path, body]);
      return Promise.resolve({ sessionId: SERVED, created: true, workspaceId: 'w1' });
    });
    await mount(section());
    await press(/^New task$/);

    // The press asks the SERVER rather than following the status read it was drawn from, and an
    // empty body is the whole request: where a first coordinator opens is the server's to borrow.
    expect(posts).toEqual([[`/projects/${PROJECT}/coordinator`, {}]]);
    // And the reader lands in the conversation the ANSWER named, with why they came in the URL.
    expect(landedOn).toBe(coordinatorIntentPath(SERVED, NEW_TASK_INTENT));
    expect(landedOn).toBe(`/sessions/${SERVED}?intent=${NEW_TASK_INTENT}`);
    // A first coordinator replaced nothing, so the sentence about a conversation that did not come
    // along would be a lie about one that never existed.
    expect(document.body.textContent ?? '').not.toMatch(/did not come with it/i);
  });

  it('re-opens a coordinator that went to Trash, and says the conversation it opens is a new one', async () => {
    serve(trashedStatus(), () =>
      Promise.resolve({ sessionId: SERVED, created: true, workspaceId: 'w1' }),
    );
    await mount(section());
    await press(/^New task$/);

    // The id the reader is sent to is the SERVER's: on a trashed binding the pointer on screen and
    // the conversation that answer names are two different sessions, and only one of them is live.
    expect(landedOn).toBe(`/sessions/${SERVED}?intent=${NEW_TASK_INTENT}`);
    expect(landedOn).not.toContain(POINTER);
    // Said somewhere that survives the navigation — the page it was pressed on is gone.
    const notice = document.body.textContent ?? '';
    expect(notice).toMatch(/NEW coordinator conversation/i);
    expect(notice).toMatch(/history did not come with it/i);
  });

  it('hands back the server’s own sentence when there is nowhere to open one', async () => {
    serve(nowhereToOpenStatus(), () =>
      Promise.reject(new ApiError(NO_LANDING_WORKSPACE, 400, 'NO_LANDING_WORKSPACE')),
    );
    await mount(section());
    await press(/^New task$/);

    // Nothing navigated: the reader stays on the page the door is on, holding the one sentence
    // that says what would change the answer. Its words are the SERVER's, not this page's.
    expect(landedOn).toBe('/projects/x');
    const shown = document.body.textContent ?? '';
    expect(shown).toContain(
      'no workspace to open the coordinator in — none of this project’s tasks has an assignee to borrow one from. Assign a task, or pass workspaceId.',
    );
    // ...and the door is still there to press again once that sentence has been acted on: a refusal
    // that took the control away would be a dead end dressed as feedback.
    expect([...container.querySelectorAll('button')].map((b) => b.textContent?.trim())).toContain(
      'New task',
    );
  });
});
