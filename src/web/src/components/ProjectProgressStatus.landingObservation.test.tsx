// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ProjectOpenItemRow, ProjectOpenItemsView } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPT_FAILED,
  ACTION_CONSEQUENCES,
  ItemAsCard,
  OBSERVE_FAILED,
  OBSERVE_MODAL_TITLE,
  ProjectOpenItems,
  exceptionCardRows,
  isOwnerExceptionCard,
  itemStandingLine,
  observingLine,
} from './ProjectProgressStatus';
import { projectOpenItemsQuery } from '../lib/queries';

/**
 * The two items of contract revision 29 (§10.7) and the doors on them (§10.8), as the coordinator's
 * conversation draws them:
 *
 *  - `LANDING_UNOBSERVED` — a finished task's work not seen on its line. Its card is headed by the
 *    item's own title (`Not on <branch> yet: <task>`), says what was seen and which commit in the
 *    server's detail line, and offers the server's doors, `Observe again` among them.
 *  - `LANDED_WITHOUT_CONFIRMATION` — work that reached main without the owner's confirmation. Its
 *    title is `Reached <branch> without your confirmation: <task>`, its detail line is the receipt,
 *    and Accept leads.
 *  - The item a project's failing observations open (`IE:observe:<projectId>`), whose one door is
 *    `Observe again`.
 *
 * Plus the handling line while an observation the owner asked for is in flight (`Observing main…`),
 * and the two writes: Accept to the item's own door, Observe again — with the reason it asks for —
 * to the project's observation door.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const PROJECT_ID = '34noHniU4wmCRkZJkR6df';
const COORDINATOR = '34nkUBJx4xYwNbGqVojH7';
const NOW = Date.parse('2026-10-29T03:00:00.000Z');
const MINUTE = 60 * 1000;

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

/** A finished task of an AGENT_PUSH project whose commit the observation did not find on main. */
const UNOBSERVED: ProjectOpenItemRow = {
  itemId: '4pLUnobserved00000001',
  kind: 'LANDING_UNOBSERVED',
  title: 'Not on main yet: Ship the delivery mode picker',
  detailLine: 'Its commit was not found on the line · delivered 9f1c2ab7e4d0',
  assignee: 'COORDINATOR',
  assigneeReason: 'DEFAULT',
  waitingSince: at(25 * MINUTE),
  escalateAt: new Date(NOW + 95 * MINUTE).toISOString(),
  escalatedAt: null,
  taskId: '34npDeliveryPicker001',
  sessionId: '1TtDeliveryPickerRun1',
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'DELIVERED', sessionId: COORDINATOR, at: at(24 * MINUTE) },
  // The cell's projection for the coordinator (`open-item-doors.ts`): OBSERVE before CANCEL_TASK.
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'OBSERVE', 'CANCEL_TASK'],
  requiredAction:
    'This task’s work is not on main yet — record the commit that carries it, or send the task back to push it.',
  primaryAction: 'OPEN_TASK_SESSION',
  question: null,
  facts: null,
  handling: null,
  outcome: null,
};

/** The same item, handed to the owner by the coordinator: the owner's projection of the cell. */
const UNOBSERVED_HANDED_OVER: ProjectOpenItemRow = {
  ...UNOBSERVED,
  itemId: '4pLUnobservedOwner001',
  assignee: 'OWNER',
  assigneeReason: 'HANDED_OVER',
  escalateAt: null,
  escalatedAt: at(5 * MINUTE),
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'OBSERVE', 'CANCEL_TASK'],
  primaryAction: 'ASK_COORDINATOR_AGAIN',
};

/** The owner pressed Observe again, and the observation it queued has not run yet (§10.8, H1). */
const UNOBSERVED_OBSERVING: ProjectOpenItemRow = {
  ...UNOBSERVED_HANDED_OVER,
  itemId: '4pLUnobservedSeen0001',
  handling: {
    sessionId: null,
    userId: '2p7QMFOwEGtL5oaTxZHihm',
    reason: 'I pushed the rebased commit to main by hand',
    startedAt: at(4 * MINUTE),
    jobId: '4pObserveJob000000001',
    jobKind: 'OBSERVE_LANDING',
    generation: 3,
    state: 'QUEUED',
  },
};

/** An observation's work, found on main without the owner's confirmation (§10.6 O-R3). */
const LANDED: ProjectOpenItemRow = {
  itemId: '4pULanded000000000001',
  kind: 'LANDED_WITHOUT_CONFIRMATION',
  title: 'Reached main without your confirmation: Fix the login redirect',
  detailLine: '7d3e9b01c2a4 is on main · seen by Orbit',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  waitingSince: at(2 * 60 * MINUTE),
  escalateAt: null,
  escalatedAt: null,
  taskId: '34npLoginRedirect0001',
  sessionId: '1TtLoginRedirectRun01',
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: COORDINATOR, at: null },
  actions: ['ACCEPT', 'OPEN_TASK_SESSION'],
  requiredAction:
    'This work reached main without your confirmation — accept it, or use Chat about this to have the '
    + 'coordinator file a task that reverts it.',
  primaryAction: 'ACCEPT',
  question: null,
  facts: null,
  handling: null,
  outcome: null,
};

/** The deploy-time pass's one item per project (§10.9, `UL:backfill:<projectId>`): no task. */
const LANDED_BACKFILL: ProjectOpenItemRow = {
  ...LANDED,
  itemId: '4pULandedBackfill0001',
  title: 'Reached main without your confirmation: 5 tasks',
  detailLine: 'On main: Fix the login redirect, Retry the export, Trim the logs and 2 more · seen by Orbit',
  taskId: null,
  sessionId: null,
  actions: ['ACCEPT'],
};

/** A project's observations failing three times running (§10.6 O-J4): about the line, no task. */
const OBSERVE_FAILING: ProjectOpenItemRow = {
  ...UNOBSERVED,
  itemId: '4pIEObserve0000000001',
  kind: 'INTEGRATION_ERROR',
  title: 'Integration error: observing main',
  detailLine: '',
  taskId: null,
  sessionId: null,
  actions: ['OBSERVE'],
  primaryAction: 'OBSERVE',
  requiredAction:
    'Finished work is not recorded as landed until an observation of main succeeds — let a runner reach '
    + 'the repository, then look again.',
};

function client(items: ProjectOpenItemsView): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, items);
  return qc;
}

/** The conversation's host, as `WorkspaceView` draws these cards: one per row of the read. */
function ExceptionCards({ projectId, now }: { projectId: string; now: number }): JSX.Element {
  const items = useQuery({ ...projectOpenItemsQuery(projectId), enabled: true });
  return (
    <>
      {exceptionCardRows(items.data, []).map(({ row }) => (
        <ItemAsCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
    </>
  );
}

function view(row: ProjectOpenItemRow): ProjectOpenItemsView {
  return row.assignee === 'OWNER'
    ? { needsYou: [row], withCoordinator: [] }
    : { needsYou: [], withCoordinator: [row] };
}

function card(row: ProjectOpenItemRow): Document {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client(view(row))}>
        <ExceptionCards projectId={PROJECT_ID} now={NOW} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

type Weight = 'primary' | 'secondary' | 'link';

/** The card's doors in the order drawn, each with its weight and the line saying what it does. */
function doors(doc: Document): Array<{ label: string; weight: Weight; consequence: string }> {
  return Array.from(doc.querySelectorAll('.project-open-item-actions > .project-open-item-door')).map((door) => {
    const press = door.querySelector<HTMLElement>('button, a')!;
    const variant = press.className.match(/orbit-button-(primary|default|link)\b/)?.[1];
    const weight: Weight = press.tagName === 'A' || variant === 'link'
      ? 'link'
      : variant === 'primary' ? 'primary' : 'secondary';
    return {
      label: press.textContent?.trim() ?? '',
      weight,
      consequence: door.querySelector('.project-open-item-consequence')?.textContent ?? '',
    };
  });
}

describe('LANDING_UNOBSERVED — work not seen on its line (§10.7)', () => {
  it('is headed by its own title and says what was seen, with the short delivered commit', () => {
    const doc = card(UNOBSERVED);
    const head = doc.querySelector('.project-open-item-heading');
    expect(head?.textContent).toBe('Not on main yet: Ship the delivery mode picker');
    // The server's one sentence about what has to happen next leads the card…
    expect(doc.querySelector('.project-open-item-required-action')?.textContent).toBe(UNOBSERVED.requiredAction);
    // …and its detail line is the reason the observation gave and the delivered commit, short.
    expect(doc.querySelector('.project-open-item-detail')?.textContent)
      .toBe('Its commit was not found on the line · delivered 9f1c2ab7e4d0');
    expect(doc.querySelector('.project-open-item-card')?.className).toContain('is-coordinator');
  });

  it('draws the server’s doors, Observe again among them, and Chat about this under them', () => {
    const doc = card(UNOBSERVED);
    expect(doors(doc)).toEqual([
      // The lead press is the server's (`primaryAction`), unchanged by the new door.
      { label: 'Open task session', weight: 'primary', consequence: ACTION_CONSEQUENCES.OPEN_TASK_SESSION },
      { label: 'Open coordinator', weight: 'link', consequence: ACTION_CONSEQUENCES.OPEN_COORDINATOR },
      { label: 'Observe again', weight: 'link', consequence: 'An observation of the line is queued with your reason.' },
      { label: 'Cancel task', weight: 'link', consequence: ACTION_CONSEQUENCES.CANCEL_TASK },
    ]);
    expect(doc.querySelector('.project-open-item-chat button')?.textContent).toBe('Chat about this');
    // No hand-close: `open_item_resolve` refuses this kind (OPEN_ITEM_HAS_ITS_OWN_DOOR).
    expect(doc.body.textContent).not.toContain('Mark as handled');
  });

  it('keeps its title as the first line once the heading says how it became the owner’s', () => {
    const doc = card(UNOBSERVED_HANDED_OVER);
    expect(doc.querySelector('.project-open-item-heading')?.textContent)
      .toBe('Now yours — the coordinator handed it over');
    const lines = Array.from(doc.querySelectorAll('.project-open-item-detail')).map((line) => line.textContent);
    expect(lines).toEqual([
      'Not on main yet: Ship the delivery mode picker',
      'Its commit was not found on the line · delivered 9f1c2ab7e4d0',
    ]);
    expect(doc.querySelector('.project-open-item-card')?.className).toContain('is-owner');
    expect(doors(doc).map((door) => [door.label, door.weight])).toEqual([
      ['Ask the coordinator again', 'primary'],
      ['Open task session', 'secondary'],
      ['Observe again', 'link'],
      ['Cancel task', 'link'],
    ]);
    // The pinned strip points at it: it is a card the owner answers by pressing.
    expect(isOwnerExceptionCard(UNOBSERVED_HANDED_OVER)).toBe(true);
  });

  it('says an observation is in flight in its own words, never as the rerun of a landing', () => {
    const doc = card(UNOBSERVED_OBSERVING);
    const handling = doc.querySelector('.project-open-item-handling');
    expect(handling?.textContent).toContain('Observing main… — queued · asked 4m ago');
    expect(handling?.textContent).toContain('I pushed the rebased commit to main by hand');
    expect(doc.body.textContent).not.toContain('the rerun of the landing');
    expect(doc.body.textContent).not.toContain('generation 3');

    // Running, it says so; and a chat about the item carries the same line.
    const running = { ...UNOBSERVED_OBSERVING, handling: { ...UNOBSERVED_OBSERVING.handling!, state: 'RUNNING' as const } };
    expect(card(running).querySelector('.project-open-item-handling')?.textContent)
      .toContain('Observing main… — running · asked 4m ago');
    expect(itemStandingLine(UNOBSERVED_OBSERVING, NOW)).toContain('Observing main… — queued · asked 4m ago');
    expect(observingLine('feature/v1.1.1')).toBe('Observing feature/v1.1.1…');
  });

  it('says the same on the project page’s Open items row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client({ needsYou: [UNOBSERVED_OBSERVING], withCoordinator: [] })}>
          <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('Not on main yet: Ship the delivery mode picker');
    expect(html).toContain('Observing main… — queued · asked 4m ago');
    expect(html).not.toContain('the rerun of the landing');
  });
});

describe('the item a project’s failing observations open (IE:observe, §10.6 O-J4)', () => {
  it('leads with Observe again, its one door', () => {
    const doc = card(OBSERVE_FAILING);
    expect(doc.querySelector('.project-open-item-required-action')?.textContent).toBe(OBSERVE_FAILING.requiredAction);
    expect(doors(doc)).toEqual([
      { label: 'Observe again', weight: 'primary', consequence: ACTION_CONSEQUENCES.OBSERVE },
    ]);
  });
});

describe('LANDED_WITHOUT_CONFIRMATION — work that reached main without the owner (§10.7)', () => {
  it('is the owner’s card: its title, the receipt, and Accept in the lead', () => {
    const doc = card(LANDED);
    expect(doc.querySelector('.project-open-item-heading')?.textContent)
      .toBe('Reached main without your confirmation: Fix the login redirect');
    expect(doc.querySelector('.project-open-item-card')?.className).toContain('is-owner');
    expect(doc.querySelector('.project-open-item-required-action')?.textContent).toBe(LANDED.requiredAction);
    // The receipt: the commit that is on main, and how Orbit knows.
    expect(doc.querySelector('.project-open-item-detail')?.textContent).toBe('7d3e9b01c2a4 is on main · seen by Orbit');
    expect(doors(doc)).toEqual([
      { label: 'Accept', weight: 'primary', consequence: 'You accept the work as it landed, and this item closes.' },
      { label: 'Open task session', weight: 'secondary', consequence: ACTION_CONSEQUENCES.OPEN_TASK_SESSION },
    ]);
    // Undoing it is a chat with the coordinator, not a door.
    expect(doc.querySelector('.project-open-item-chat button')?.textContent).toBe('Chat about this');
    expect(doc.body.textContent).not.toContain('Mark as handled');
    expect(doc.querySelector('.project-open-item-foot')?.textContent).toBe('Owner: you · waiting 2h');
    expect(isOwnerExceptionCard(LANDED)).toBe(true);
  });

  it('draws the deploy-time pass’s one item, which names no task, with Accept alone', () => {
    const doc = card(LANDED_BACKFILL);
    expect(doc.querySelector('.project-open-item-heading')?.textContent)
      .toBe('Reached main without your confirmation: 5 tasks');
    expect(doc.querySelector('.project-open-item-detail')?.textContent).toBe(LANDED_BACKFILL.detailLine);
    expect(doors(doc).map((door) => [door.label, door.weight])).toEqual([['Accept', 'primary']]);
  });

  it('leaves the Accept to the card: the Open items row is a way in', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client({ needsYou: [LANDED], withCoordinator: [] })}>
          <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('Reached main without your confirmation: Fix the login redirect');
    expect(html).toContain('7d3e9b01c2a4 is on main · seen by Orbit');
    expect(html).toContain('Open task session');
    expect(html).not.toContain('>Accept<');
  });
});

// ── The two writes ──────────────────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  // The reason field grows with its text, measured with a ResizeObserver jsdom lacks — the stub the
  // Mark as handled suite carries for the same field.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
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
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  apiMock.mockReset();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountCards(items: ProjectOpenItemsView, write: (path: string) => unknown): Promise<void> {
  apiMock.mockImplementation(async (path: string) =>
    String(path).endsWith('/open-items') ? items : write(String(path)));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  const next = createRoot(node);
  root = next;
  await act(async () => next.render(
    <MemoryRouter>
      <QueryClientProvider client={client(items)}>
        <ExceptionCards projectId={PROJECT_ID} now={NOW} />
      </QueryClientProvider>
    </MemoryRouter>,
  ));
  await settle();
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button'))
    .filter((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement[];
}

/** The `atLeast`-th button with this label, once the dialog that repeats it has mounted. */
async function buttonAppears(label: string, atLeast: number): Promise<HTMLButtonElement | undefined> {
  for (let turn = 0; turn < 50; turn += 1) {
    const found = buttons(label);
    if (found.length >= atLeast) return found.at(-1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return undefined;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function posts(): unknown[][] {
  return apiMock.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST');
}

describe('Accept, through the item’s own door', () => {
  it('posts to /projects/:id/open-items/:itemId/accept, with nothing to confirm first', async () => {
    await mountCards({ needsYou: [LANDED], withCoordinator: [] }, () => ({ itemId: LANDED.itemId }));
    await click(buttons('Accept')[0]!);

    expect(apiMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/open-items/${LANDED.itemId}/accept`,
      { method: 'POST' },
    );
    expect(posts()).toHaveLength(1);
  });

  it('says a refusal in the server’s own words', async () => {
    await mountCards({ needsYou: [LANDED], withCoordinator: [] }, () => {
      throw new Error('this item is no longer open: it was accepted on another device.');
    });
    await click(buttons('Accept')[0]!);

    expect(document.body.textContent).toContain(ACCEPT_FAILED);
    expect(document.body.textContent).toContain('this item is no longer open: it was accepted on another device.');
  });
});

describe('Observe again, through the project’s observation door', () => {
  async function openDialog(row: ProjectOpenItemRow, write: (path: string) => unknown = () => ({})): Promise<HTMLElement> {
    await mountCards(view(row), write);
    await click(buttons('Observe again')[0]!);
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(OBSERVE_MODAL_TITLE);
    return dialog!;
  }

  it('asks for the reason, and sends it to /projects/:id/integration/observe', async () => {
    const dialog = await openDialog(UNOBSERVED);
    await type(dialog.querySelector('textarea')!, '  I pushed the rebased commit to main by hand  ');
    const confirm = await buttonAppears('Observe again', 2);
    expect(confirm?.disabled).toBe(false);
    await click(confirm!);

    expect(apiMock).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/integration/observe`,
      { method: 'POST', body: { reason: 'I pushed the rebased commit to main by hand' } },
    );
    expect(posts()).toHaveLength(1);
    // Taken: the dialog closes.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('sends nothing while the reason is empty or blank', async () => {
    const dialog = await openDialog(OBSERVE_FAILING);
    expect((await buttonAppears('Observe again', 2))?.disabled).toBe(true);
    await type(dialog.querySelector('textarea')!, '   ');
    const confirm = await buttonAppears('Observe again', 2);
    expect(confirm?.disabled).toBe(true);
    await click(confirm!);

    expect(posts()).toEqual([]);
  });

  it('keeps the dialog open over the server’s refusal', async () => {
    const refusal = 'this project has no repository bound, so there is no line to look at.';
    const dialog = await openDialog(OBSERVE_FAILING, () => {
      throw new Error(refusal);
    });
    await type(dialog.querySelector('textarea')!, 'the runner can reach the repository again');
    await click((await buttonAppears('Observe again', 2))!);

    const open = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(open?.textContent).toContain(OBSERVE_FAILED);
    expect(open?.textContent).toContain(refusal);
  });
});
