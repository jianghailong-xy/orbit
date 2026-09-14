// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerConfirmationQuery } from '../lib/queries';
import { DecisionStrip, ownerConfirmationPointer, type PendingDecisionQueue } from './DecisionRail';
import {
  OWNER_CONFIRMATION_HEADING,
  OWNER_CONFIRMATION_NO_CRITERIA,
  OWNER_CONFIRMATION_NO_REPORT,
  OWNER_CONFIRMATION_SHOW_ALL,
  OWNER_CONFIRMED_HEADING,
  OWNER_CONFIRM_ACTION,
  OWNER_SEND_ACTION,
  OWNER_SEND_BACK_ACTION,
  OWNER_SEND_BACK_HINT,
  OWNER_SEND_BACK_LABEL,
  OWNER_SENT_BACK_HEADING,
  OWNER_SHOW_WHAT_SETTLED_IT,
  WAITING_FOR_CONFIRMATION,
  WHAT_SETTLES_IT,
  WHAT_THE_RUN_REPORTED,
  OwnerConfirmationCard,
  OwnerDecisionReceipt,
  SessionOwnerConfirmationCard,
  ownerConfirmationWaitingIn,
  ownerDecisionReceiptLine,
  ownerDecisionReceiptsIn,
  ownerDecisionRefusal,
  ownerDecisionRequest,
  whatTheRunReported,
  type OwnerConfirmationView,
  type OwnerConfirmationWaiting,
  type RecordedOwnerDecision,
} from './OwnerConfirmationCard';
import { sessionLine, statusLabel } from './WorkspaceView';

/**
 * The owner-confirmation card (方案 A): what it draws, the one place it is drawn, what a press sends,
 * and — the half the design turned on — that nothing else on the web answers the same question. The
 * list row lights and says what it is waiting for, the pinned line points, and the card is the only
 * control that decides.
 *
 * Static renders carry most of it. The file runs under jsdom for the two presses, typed and pressed
 * through to the (mocked) `api()` call. `renderToStaticMarkup` escapes `'`, `&` and `<`, so text
 * assertions go through `escaped()`.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const TASK_ID = '34PfK2xQ9aB7cD1eF3gH5';
const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const OTHER_SESSION_ID = '34LWcmLItBx6ytdO26XXF';
const REQUEST_ID = '01920000-0000-7000-8000-0000000000f1';
const TITLE = '整理 9 月发票并归档 <Q3 & finance>';
const CRITERIA =
  'Every September invoice is in finance/2026-09/ named YYYY-MM-DD_vendor_amount.pdf, and summary.csv totals match the bank statement.';
const REPORT =
  'Done. 38 invoices are renamed and filed under `finance/2026-09/`; 2 duplicates moved to `_duplicates/`.';

function waiting(over: Partial<OwnerConfirmationWaiting> = {}): OwnerConfirmationWaiting {
  return {
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    requestedAt: '2026-09-13T10:39:00.000Z',
    report: { text: REPORT, reportedAt: '2026-09-13T10:39:00.000Z' },
    ...over,
  };
}

function view(over: Partial<OwnerConfirmationView> = {}): OwnerConfirmationView {
  return {
    taskId: TASK_ID,
    title: TITLE,
    status: 'OPEN',
    projectId: null,
    completionCriterion: 'OWNER_CONFIRMED',
    acceptanceCriteria: CRITERIA,
    waiting: waiting(),
    decisions: [],
    ...over,
  };
}

function decided(over: Partial<RecordedOwnerDecision> = {}): RecordedOwnerDecision {
  return {
    id: 'decision-1',
    decision: 'CONFIRM',
    note: null,
    decidedAt: '2026-09-13T10:42:00.000Z',
    decidedByType: 'USER',
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    report: { text: REPORT, reportedAt: '2026-09-13T10:39:00.000Z' },
    ...over,
  };
}

/** A string as it appears in the markup rather than as it is written in source. */
function escaped(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#x27;');
}

/** Every rendered button, as its opening tag and its text. Labels are compared exactly. */
function buttons(html: string): Array<{ tag: string; text: string }> {
  return [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/gu)].map((match) => ({
    tag: match[1],
    text: match[2].replace(/<[^>]*>/gu, ''),
  }));
}

const isDisabled = (tag: string): boolean => /\sdisabled(?:=|\s|>)/u.test(tag);

function card(over: { busy?: boolean; waiting?: OwnerConfirmationWaiting; view?: OwnerConfirmationView } = {}): string {
  const v = over.view ?? view();
  return renderToStaticMarkup(
    <OwnerConfirmationCard
      view={v}
      waiting={over.waiting ?? v.waiting ?? waiting()}
      busy={over.busy}
      onDecide={() => {}}
    />,
  );
}

const clients: QueryClient[] = [];
function newClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
  clients.push(qc);
  return qc;
}

/** The wired card for one session, over a read that has already come back. */
function sessionCard(read: OwnerConfirmationView | null, sessionId = SESSION_ID, taskId: string | null = TASK_ID): string {
  const qc = newClient();
  if (read) qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, read);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionOwnerConfirmationCard sessionId={sessionId} taskId={taskId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  for (const qc of clients.splice(0)) qc.clear();
  apiMock.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const nextRoot = createRoot(node);
  container = node;
  root = nextRoot;
  await act(async () => nextRoot.render(ui));
  return node;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].filter((button) => button.textContent === label);
  expect(found.length, `buttons labelled ${label}`).toBe(1);
  return found[0] as HTMLButtonElement;
}

async function press(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // One macrotask for the settled mutation's re-read to be scheduled.
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the confirmation card', () => {
  it('asks in its own frame, with the task, what settles it and what the run reported', () => {
    const html = card();
    expect(html).toContain(OWNER_CONFIRMATION_HEADING);
    expect(html).toContain('FROM ORBIT');
    expect(html).toContain(escaped(TITLE));
    expect(html).toContain(`${TASK_ID} · OWNER_CONFIRMED`);
    // In the order the owner decides in: the task, then what settles it, then the report.
    const settles = html.indexOf(WHAT_SETTLES_IT);
    const reported = html.indexOf(WHAT_THE_RUN_REPORTED);
    expect(html.indexOf(escaped(TITLE))).toBeLessThan(settles);
    expect(settles).toBeGreaterThan(-1);
    expect(reported).toBeGreaterThan(settles);
    expect(html).toContain(escaped(CRITERIA));
    expect(html).toContain(escaped(whatTheRunReported(waiting().report)));
    // The report is the run's words with the Markdown marks taken off.
    expect(html).toContain(escaped('Done. 38 invoices are renamed and filed under finance/2026-09/'));
    expect(html).toContain(`data-owner-confirmation="${REQUEST_ID}"`);
  });

  it('has exactly two answers, Confirm done and Send back…, and both can be pressed', () => {
    const answers = buttons(card()).filter((button) => button.text !== OWNER_CONFIRMATION_SHOW_ALL);
    expect(answers.map((button) => button.text)).toEqual([OWNER_CONFIRM_ACTION, OWNER_SEND_BACK_ACTION]);
    expect(answers.map((button) => isDisabled(button.tag))).toEqual([false, false]);
    // The primary look belongs to Confirm done.
    expect(answers[0].tag).toContain('card-action--primary');
    // And while a press is on its way, neither is pressable again.
    const busy = buttons(card({ busy: true })).filter((button) => button.text !== OWNER_CONFIRMATION_SHOW_ALL);
    expect(busy.map((button) => isDisabled(button.tag))).toEqual([true, true]);
  });

  it('folds a long report behind Show all, and says so when there is nothing to show', () => {
    const long = card({ waiting: waiting({ report: { text: 'word '.repeat(120), reportedAt: '2026-09-13T10:39:00.000Z' } }) });
    expect(buttons(long).map((button) => button.text)).toContain(OWNER_CONFIRMATION_SHOW_ALL);
    expect(long).toContain('…');
    const short = card();
    expect(buttons(short).map((button) => button.text)).not.toContain(OWNER_CONFIRMATION_SHOW_ALL);

    const bare = card({ view: view({ acceptanceCriteria: null }), waiting: waiting({ report: null }) });
    expect(bare).toContain(OWNER_CONFIRMATION_NO_CRITERIA);
    expect(bare).toContain(OWNER_CONFIRMATION_NO_REPORT);
  });
});

describe('where the card is drawn, and what a decision leaves', () => {
  it('is drawn only in the session whose run is waiting', () => {
    expect(sessionCard(view())).toContain(OWNER_CONFIRMATION_HEADING);
    // Another conversation of the same account, the task's other sessions included: no card.
    expect(sessionCard(view(), OTHER_SESSION_ID)).toBe('');
    // An ordinary conversation runs no task: no card, and no read.
    expect(sessionCard(view(), SESSION_ID, null)).toBe('');
    // Nothing waiting — never ran, already answered, or settled — no card.
    expect(sessionCard(view({ waiting: null }))).toBe('');
    expect(sessionCard(null)).toBe('');

    expect(ownerConfirmationWaitingIn(view(), SESSION_ID)?.requestId).toBe(REQUEST_ID);
    expect(ownerConfirmationWaitingIn(view(), OTHER_SESSION_ID)).toBeNull();
    expect(ownerConfirmationWaitingIn(view({ waiting: null }), SESSION_ID)).toBeNull();
  });

  it('leaves a receipt in the session it answered, and the receipt answers nothing', () => {
    const confirm = decided();
    const sendBack = decided({ id: 'decision-0', decision: 'SEND_BACK', note: 'still missing an amount' });
    const panel = decided({ id: 'decision-2', requestId: null, sessionId: null, report: null });
    const all = view({ waiting: null, decisions: [sendBack, confirm, panel] });
    expect(ownerDecisionReceiptsIn(all, SESSION_ID).map((each) => each.id)).toEqual(['decision-0', 'decision-1']);
    expect(ownerDecisionReceiptsIn(all, OTHER_SESSION_ID)).toEqual([]);

    const confirmed = renderToStaticMarkup(<OwnerDecisionReceipt view={all} decided={confirm} />);
    expect(confirmed).toContain(OWNER_CONFIRMED_HEADING);
    expect(confirmed).toContain(escaped(ownerDecisionReceiptLine(confirm)));
    expect(ownerDecisionReceiptLine(confirm)).toMatch(/^Confirmed done by you · /u);
    // The buttons are gone: its only control opens what settled it.
    expect(buttons(confirmed).map((button) => button.text)).toEqual([`${OWNER_SHOW_WHAT_SETTLED_IT} ▾`]);

    const sentBack = renderToStaticMarkup(<OwnerDecisionReceipt view={all} decided={sendBack} />);
    expect(sentBack).toContain(OWNER_SENT_BACK_HEADING);
    expect(ownerDecisionReceiptLine(sendBack)).toMatch(/^Sent back by you · /u);
    expect(buttons(sentBack)).toEqual([]);
  });
});

describe('what a press sends', () => {
  it('names the report it answers, and carries a reason only with a send-back', () => {
    expect(ownerDecisionRequest(TASK_ID, REQUEST_ID, 'CONFIRM')).toEqual({
      path: `/tasks/${TASK_ID}/owner-confirmation`,
      body: { decision: 'CONFIRM', requestId: REQUEST_ID },
    });
    expect(ownerDecisionRequest(TASK_ID, REQUEST_ID, 'SEND_BACK', '  take the amount from the bank line  ')).toEqual({
      path: `/tasks/${TASK_ID}/owner-confirmation`,
      body: { decision: 'SEND_BACK', requestId: REQUEST_ID, note: 'take the amount from the bank line' },
    });
    // The task panel answers "no run is waiting".
    expect(ownerDecisionRequest(TASK_ID, null, 'CONFIRM').body).toEqual({ decision: 'CONFIRM', requestId: null });
  });

  it('reads a refusal for staleness as an out-of-date card', () => {
    for (const code of ['OWNER_CONFIRMATION_STALE', 'OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK', 'OWNER_CONFIRMATION_TASK_SETTLED']) {
      expect(ownerDecisionRefusal(Object.assign(new Error('x'), { code })).stale).toBe(true);
    }
    expect(ownerDecisionRefusal(Object.assign(new Error('x'), { code: 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER' })).stale).toBe(false);
  });

  it('Send back… opens the reason, which has to be written before it can be sent', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view());
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'SEND_BACK' });
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard sessionId={SESSION_ID} taskId={TASK_ID} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(scope.querySelector('textarea')).toBeNull();
    await press(buttonIn(scope, OWNER_SEND_BACK_ACTION));

    expect(scope.textContent).toContain(OWNER_SEND_BACK_LABEL);
    expect(scope.textContent).toContain(OWNER_SEND_BACK_HINT);
    const send = buttonIn(scope, OWNER_SEND_ACTION);
    expect(send.disabled).toBe(true);
    await type(scope.querySelector('textarea')!, '   ');
    expect(buttonIn(scope, OWNER_SEND_ACTION).disabled).toBe(true);
    await type(scope.querySelector('textarea')!, '  The 09-17 invoice still has no amount.  ');
    expect(buttonIn(scope, OWNER_SEND_ACTION).disabled).toBe(false);

    await press(buttonIn(scope, OWNER_SEND_ACTION));
    expect(apiMock).toHaveBeenCalledWith(`/tasks/${TASK_ID}/owner-confirmation`, {
      method: 'POST',
      body: { decision: 'SEND_BACK', requestId: REQUEST_ID, note: 'The 09-17 invoice still has no amount.' },
    });
  });

  it('Confirm done posts the owner\'s decision about the report on the card, and re-reads', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view());
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'CONFIRM', completed: true });
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard sessionId={SESSION_ID} taskId={TASK_ID} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await press(buttonIn(scope, OWNER_CONFIRM_ACTION));
    // One press is one decision...
    const posts = apiMock.mock.calls.filter(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posts).toEqual([[`/tasks/${TASK_ID}/owner-confirmation`, {
      method: 'POST',
      body: { decision: 'CONFIRM', requestId: REQUEST_ID },
    }]]);
    expect(apiMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    // ...and the read the card is drawn from is asked again once the door has answered.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task', TASK_ID] });
    expect(apiMock.mock.calls.slice(1).map(([path]) => path)).toContain(`/tasks/${TASK_ID}/owner-confirmation`);
  });
});

describe('the list row and the pinned line only signal', () => {
  const parked = { status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', pendingApprovals: 1 };

  it('says Waiting for your confirmation in the approval amber, when that is what it counts', () => {
    const waitingRow = { ...parked, waitingKind: 'OWNER_CONFIRMATION' };
    expect(sessionLine(waitingRow, true)).toEqual({ text: WAITING_FOR_CONFIRMATION, tone: 'approval' });
    expect(statusLabel(waitingRow)).toBe(WAITING_FOR_CONFIRMATION);
    expect(WAITING_FOR_CONFIRMATION).toBe('Waiting for your confirmation');
    // Anything else waiting on the owner keeps the approval wording.
    expect(sessionLine(parked, true)).toEqual({ text: 'Waiting for approval', tone: 'approval' });
    expect(statusLabel({ ...parked, waitingKind: null })).toBe('Waiting for approval');
    // Nothing counted, nothing said.
    expect(statusLabel({ ...parked, pendingApprovals: 0, waitingKind: 'OWNER_CONFIRMATION' }))
      .not.toBe(WAITING_FOR_CONFIRMATION);
  });

  it('puts no way to answer on the session list: the view mounts the card, and nothing that decides', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/WorkspaceView.tsx'), 'utf8');
    // The only piece of the card the list's own file takes is the card itself, mounted in the
    // conversation, plus the words and the read. The press, its request and its labels are not there.
    expect(source).not.toMatch(/\bsendOwnerDecision\b|\bownerDecisionRequest\b/u);
    expect(source).not.toMatch(/\bOWNER_CONFIRM_ACTION\b|\bOWNER_SEND_BACK_ACTION\b|OwnerConfirmationActions/u);
    expect(source).not.toMatch(/['"`]Confirm done['"`]|['"`]Send back…['"`]/u);
    expect(source.match(/<SessionOwnerConfirmationCard\b/gu)?.length).toBe(1);
  });

  it('pins one line that points at the card in its own words, and answers nothing', () => {
    const queue: PendingDecisionQueue = {
      decidingSessionId: SESSION_ID,
      count: 0,
      oldestAgeSeconds: null,
      pending: [],
    };
    const html = renderToStaticMarkup(
      <DecisionStrip
        queue={queue}
        open={false}
        onToggle={() => {}}
        ownerConfirmation={{ title: TITLE, ageSeconds: 30 }}
      />,
    );
    const line = buttons(html);
    expect(line.length).toBe(1);
    expect(line[0].text).toContain(escaped(ownerConfirmationPointer(TITLE)));
    expect(ownerConfirmationPointer(TITLE)).toBe(`Confirm done: ${TITLE}`);
    // Not a number first, and not the words the WAITING ON YOU group uses for a resubmission.
    expect(line[0].text).not.toMatch(/^\s*\d/u);
    expect(html).not.toContain('WAITING ON YOU');
    // A pointer, not an answer: no control on it is one of the card's.
    expect(line.map((button) => button.text)).not.toContain(OWNER_CONFIRM_ACTION);
    expect(line.map((button) => button.text)).not.toContain(OWNER_SEND_BACK_ACTION);
    // With nothing waiting in this session there is no line at all.
    expect(renderToStaticMarkup(
      <DecisionStrip queue={queue} open={false} onToggle={() => {}} ownerConfirmation={null} />,
    )).toBe('');
  });
});
