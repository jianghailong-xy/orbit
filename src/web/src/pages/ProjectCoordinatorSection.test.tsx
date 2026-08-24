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
import { ProjectCoordinatorSection } from './ProjectsPage';

/**
 * What each press on the coordinator card COSTS — the half of this surface the card itself cannot
 * have.
 *
 * `ProjectCoordinatorCard.test.tsx` asserts what the four states put on screen from a payload
 * handed straight in; that file mocks nothing and presses nothing, on purpose. Everything below is
 * the part a static render cannot reach: the request a press makes, where it navigates to, and the
 * two answers that change what the reader is offered next.
 *
 * A real DOM rather than `react-dom/server`, for the reason the assembly suite uses one: a button
 * has to actually be pressed for what it does to mean anything.
 */
vi.mock('../api', async (importOriginal) => ({
  // `ApiError` real, because the refusal branch turns on `instanceof` plus a status and a code:
  // a stand-in class here would let it pass against a shape the client never throws.
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  restoreSession: vi.fn(),
}));
const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT = encodeId('0195c0de-0000-7000-8000-000000000001');
/** The session the project document POINTS at — stale by construction in the trashed case. */
const POINTER = encodeId('0195c0de-0000-7000-8000-0000000000b1');
/** The session the SERVER hands back. A different id, which is the whole point of the POST. */
const SERVED = encodeId('0195c0de-0000-7000-8000-0000000000b2');

const READ_AT = '2026-08-24T07:00:00.000Z';

/** A LIVE payload: the pointer resolves, and the card offers `Open coordinator`. */
function liveStatus(): CoordinatorStatus {
  return {
    projectId: PROJECT,
    readAt: READ_AT,
    state: 'LIVE',
    coordination: {
      sessionId: POINTER,
      sessionIdAbsentReason: null,
      session: {
        id: POINTER,
        title: 'Coordinating Website Revamp',
        runStatus: 'AWAITING_INPUT',
        runState: SessionRunState.AWAITING_INPUT,
        lifecycleState: SessionLifecycleState.OPEN,
        filingState: 'OPEN',
        endReason: null,
        startedAt: '2026-08-24T06:48:00.000Z',
        finishedAt: null,
        completedAt: null,
        deletedAt: null,
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
  };
}

/** The workspace this project is tied to is disabled: the read already says no press can win. */
function unavailableStatus(): CoordinatorStatus {
  const s = liveStatus();
  return {
    ...s,
    state: 'UNAVAILABLE',
    openability: {
      ...s.openability,
      canOpen: false,
      refusalCode: 'COORDINATOR_UNAVAILABLE',
      refusalDetail: 'WORKSPACE_DISABLED',
      refusalCodeAbsentReason: null,
      requiredAction:
        "Enable workspace orbit-main, or rebind this project's coordination workspace, then open the coordinator again.",
      requiredActionAbsentReason: null,
    },
  };
}

let container: HTMLDivElement;
let root: Root;
/** The route the section navigated to, read off the router rather than off a spy: what matters is
 *  where a reader ENDS UP, not which function was called with what. */
let landedOn = '';

function Probe() {
  landedOn = useLocation().pathname;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  landedOn = '';
  // antd's message layer measures nothing, but its Modal/Select siblings subscribe to breakpoints
  // on mount and jsdom ships no matchMedia.
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
  // The Select's dropdown measures itself before it will paint a single option, and jsdom ships
  // no ResizeObserver. Inert: nothing here is about where the list lands, only what is in it.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
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
        {/* The toast surface. Without it AntD's `App.useApp()` hands back no-ops and the one
            sentence a replaced conversation has to produce would go nowhere — silently. */}
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

/** Answer the status read with `status`, and every write with `write`. */
function serve(status: CoordinatorStatus, write?: (path: string) => Promise<unknown>) {
  apiMock.mockImplementation((path: string, init?: unknown) => {
    if (!init) return Promise.resolve(status) as Promise<never>;
    return (write?.(path) ?? Promise.reject(new Error(`unstubbed write: ${path}`))) as Promise<never>;
  });
}

const section = (): ReactElement => (
  <ProjectCoordinatorSection projectId={PROJECT} layout="desktop" openTaskCount={2} />
);

/** Every button on the card and the alerts under it, by the words on it. */
const buttonLabels = (): string[] =>
  [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

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

describe('ProjectCoordinatorSection — what a press costs', () => {
  it('opens through the SERVER and follows the id it answers with, not the pointer it was drawn from', async () => {
    const posts: Array<[string, unknown]> = [];
    serve(liveStatus(), (path) => {
      posts.push([path, apiMock.mock.calls.at(-1)?.[1]]);
      return Promise.resolve({ sessionId: SERVED, created: false, workspaceId: 'w1' });
    });
    await mount(section());

    // The card was drawn from a payload that names POINTER, and the card says so.
    expect(container.innerHTML).toContain('Coordinating Website Revamp');

    await press(/Open coordinator/);

    // One write, to the resolve-or-create door, with the empty body that lets the server pick.
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`/projects/${PROJECT}/coordinator`);
    expect(posts[0][1]).toEqual({ method: 'POST', body: {} });

    // ...and the reader lands on what the SERVER answered. Following the pointer instead is how a
    // press used to land inside Trash: the server is the half of this that repairs a stale one.
    expect(landedOn).toBe(`/sessions/${SERVED}`);
    expect(landedOn).not.toBe(`/sessions/${POINTER}`);
  });

  it('says a replaced conversation did not come with it — and only when one was replaced', async () => {
    // Bound before the press (`sessionId` is set) and `created` true after it: the server did not
    // reuse the conversation the card was showing, it opened a different one.
    serve(liveStatus(), () =>
      Promise.resolve({ sessionId: SERVED, created: true, workspaceId: 'w1' }),
    );
    await mount(section());
    await press(/Open coordinator/);

    expect(landedOn).toBe(`/sessions/${SERVED}`);
    // Said somewhere that survives the navigation — the page it was pressed on is gone.
    const notice = document.body.textContent ?? '';
    expect(notice).toMatch(/NEW coordinator conversation/i);
    expect(notice).toMatch(/history did not come with it/i);
  });

  it('stays quiet when the same conversation was handed back', async () => {
    serve(liveStatus(), () =>
      Promise.resolve({ sessionId: SERVED, created: false, workspaceId: 'w1' }),
    );
    await mount(section());
    await press(/Open coordinator/);

    expect(landedOn).toBe(`/sessions/${SERVED}`);
    expect(document.body.textContent ?? '').not.toMatch(/did not come with it/i);
  });

  it('says nothing about a replacement on a FIRST coordinator, which replaced nothing', async () => {
    // `created` is true here too — and it is the only thing that is. Nothing was bound, so nothing
    // was lost, and the sentence would be a lie about a conversation that never existed.
    const first = liveStatus();
    first.state = 'NEVER_OPENED';
    first.coordination.sessionId = null;
    first.coordination.sessionIdAbsentReason = 'COORDINATOR_NEVER_OPENED';
    first.coordination.session = null;
    first.coordination.sessionAbsentReason = 'COORDINATOR_NEVER_OPENED';
    first.openability.landing = {
      workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
      workspaceIdAbsentReason: null,
      workspaceName: 'orbit-main',
      workspaceNameAbsentReason: null,
      agentId: null,
      agentName: null,
      fixed: false,
    };
    serve(first, () => Promise.resolve({ sessionId: SERVED, created: true, workspaceId: 'w1' }));
    await mount(section());
    await press(/Start coordinator/);

    expect(landedOn).toBe(`/sessions/${SERVED}`);
    expect(document.body.textContent ?? '').not.toMatch(/did not come with it/i);
  });

  it('offers a repair, never a Retry, when the press is refused with COORDINATOR_UNAVAILABLE', async () => {
    serve(liveStatus(), () =>
      Promise.reject(
        new ApiError(
          "Rebind this project's coordination workspace, then open the coordinator again.",
          409,
          'COORDINATOR_UNAVAILABLE',
        ),
      ),
    );
    await mount(section());
    await press(/Open coordinator/);

    // The server's own sentence, and the write it names...
    expect(container.textContent).toMatch(/rebind this project/i);
    expect(buttonLabels().some((l) => /Rebind/i.test(l))).toBe(true);
    // ...and NOT a Retry. The refusal is a property of committed rows: the same press returns the
    // same 409 forever, so an affordance that only repeats it is an affordance that cannot work.
    expect(buttonLabels().some((l) => /^Retry$/i.test(l))).toBe(false);
    // Nowhere near the destination either — a refused press navigates to nothing.
    expect(landedOn).toBe('/projects/x');
  });

  it('keeps Retry for a failure that a second press really could answer', async () => {
    // 503, no code: the server did not refuse this request, it failed to answer it. Pressing again
    // is exactly the right thing to offer — which is what makes the case above a decision.
    serve(liveStatus(), () => Promise.reject(new ApiError('Service Unavailable', 503)));
    await mount(section());
    await press(/Open coordinator/);

    expect(container.textContent).toContain('Service Unavailable');
    expect(buttonLabels().some((l) => /^Retry$/i.test(l))).toBe(true);
    expect(buttonLabels().some((l) => /Rebind/i.test(l))).toBe(false);
  });

  // The one test here that drives antd's own machinery — a Modal portal, a Select dropdown and
  // two more paints — rather than just this section's. Given room past the 5s default because
  // what it is waiting on is a loaded machine's render, not a hang.
  it('rebinds the landing rather than retrying, from a read that already says no press can win', { timeout: 20_000 }, async () => {
    const writes: Array<[string, unknown]> = [];
    serve(unavailableStatus(), (path) => {
      writes.push([path, apiMock.mock.calls.at(-1)?.[1]]);
      return Promise.resolve({
        projectId: PROJECT,
        coordinatorWorkspaceId: 'w-other',
        coordinatorSessionId: null,
        moved: true,
      });
    });
    await mount(section());

    // The card says so before anything is pressed, and offers no Retry to press.
    expect(buttonLabels().some((l) => /^Retry$/i.test(l))).toBe(false);

    // The picker reads the workspace list, which nothing asked for until now.
    apiMock.mockImplementation((path: string, init?: unknown) => {
      if (path === '/workspaces') {
        return Promise.resolve([
          { id: 'w-other', name: 'orbit-spare' },
          { id: '3CuIHiSJZBQ7nLVUwc7ekz', name: 'orbit-main' },
        ]) as Promise<never>;
      }
      if (!init) return Promise.resolve(unavailableStatus()) as Promise<never>;
      writes.push([path, init]);
      return Promise.resolve({
        projectId: PROJECT,
        coordinatorWorkspaceId: 'w-other',
        coordinatorSessionId: null,
        moved: true,
      }) as Promise<never>;
    });

    await press(/Rebind workspace/);
    expect(document.body.textContent).toContain('Rebind coordination workspace');

    // Pick the spare and confirm. The dialog is a portal, so the option is found on the document.
    await act(async () => {
      (document.querySelector('.ant-select-content') as HTMLElement | null)?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    await settle();
    const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
      (o.textContent ?? '').includes('orbit-spare'),
    );
    expect(option, 'the spare workspace is offered').toBeTruthy();
    await act(async () => {
      (option as HTMLElement).click();
    });
    await settle();

    const ok = [...document.querySelectorAll('.ant-modal button')].find((b) =>
      /^Rebind$/.test((b.textContent ?? '').trim()),
    );
    expect(ok, 'the dialog confirms with Rebind').toBeTruthy();
    await act(async () => {
      (ok as HTMLElement).click();
    });
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`/projects/${PROJECT}/coordinator/rebind`);
    expect(writes[0][1]).toEqual({ method: 'POST', body: { workspaceId: 'w-other' } });
  });
});
