// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OwnerConfirmationIfConfirmed } from '@orbit/shared';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerConfirmationQuery } from '../lib/queries';
import { ENTER_HINT } from './CardHotkey';
import { DecisionStrip, ownerConfirmationPointer, type PendingDecisionQueue } from './DecisionRail';
import {
  IF_CONFIRMED_AUTO_MAIN,
  IF_CONFIRMED_ENDS_SESSION,
  IF_CONFIRMED_LINE_THEN_OWNER,
  IF_CONFIRMED_NO_RECORD_ON_MAIN,
  IF_CONFIRMED_NOT_ON_MAIN,
  IF_YOU_CONFIRM,
  OWNER_CONFIRMATION_HEADING,
  OWNER_CONFIRMATION_NO_CRITERIA,
  OWNER_CONFIRMATION_NO_REPORT,
  OWNER_CONFIRMATION_SHOW_ALL,
  OWNER_CONFIRMATION_YOURS,
  OWNER_CONFIRMED_HEADING,
  OWNER_CONFIRM_ACTION,
  OWNER_SEND_BACK_ACTION,
  OWNER_SEND_BACK_HINT,
  OWNER_SEND_BACK_LABEL,
  OWNER_SENT_BACK_HEADING,
  OWNER_SHOW_WHAT_SETTLED_IT,
  REPORT_CLAMP,
  WAITING_FOR_CONFIRMATION,
  WHAT_SETTLES_IT,
  WHAT_THE_RUN_REPORTED,
  OwnerConfirmationCard,
  OwnerDecisionReceipt,
  SessionOwnerConfirmationCard,
  criteriaItemsLabel,
  ifConfirmedRows,
  ownerConfirmationWaitingIn,
  ownerDecisionReceiptLine,
  ownerDecisionReceiptsIn,
  ownerDecisionRefusal,
  ownerDecisionRequest,
  whatTheRunReported,
  type IfConfirmedRow,
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

function card(over: { busy?: boolean; waiting?: OwnerConfirmationWaiting; view?: OwnerConfirmationView; onSendBack?: () => void } = {}): string {
  const v = over.view ?? view();
  return renderToStaticMarkup(
    <OwnerConfirmationCard
      view={v}
      waiting={over.waiting ?? v.waiting ?? waiting()}
      busy={over.busy}
      onDecide={() => {}}
      onSendBack={over.onSendBack ?? (() => {})}
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
        <SessionOwnerConfirmationCard sessionId={sessionId} taskId={taskId} onSendBack={() => {}} />
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

/** The words ON a button. The key hint the card draws inside it (`CardHotkey.ts`) is a span of its
 *  own and is not part of the action's label — a label is what the button does, not what presses it. */
function labelOf(button: HTMLButtonElement): string {
  const hint = button.querySelector<HTMLElement>('.approval-kbd');
  const text = button.textContent ?? '';
  return (hint?.textContent ? text.replace(hint.textContent, '') : text).trim();
}

/** What a control draws INSIDE itself to say which key presses it, or nothing. */
const hintOn = (button: HTMLElement): string | null =>
  button.querySelector('.approval-kbd')?.textContent ?? null;

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].filter((button) => labelOf(button) === label);
  expect(found.length, `buttons labelled ${label}`).toBe(1);
  return found[0] as HTMLButtonElement;
}


/** One keypress, as the browser delivers it: on the window, with whatever focus is standing. */
async function key(init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
    );
  });
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function press(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // One macrotask for the settled mutation's re-read to be scheduled.
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

describe('the confirmation card', () => {
  it('asks in its own frame, with the task, what settles it and what the run reported', () => {
    const html = card();
    expect(html).toContain(OWNER_CONFIRMATION_HEADING);
    expect(html).toContain('FROM ORBIT');
    expect(html).toContain(escaped(TITLE));
    // Whose call this is, in words — and the id kept beside it. The enum `OWNER_CONFIRMED` is how
    // the record spells this criterion, not something a reader of the card has to know.
    expect(html).toContain(OWNER_CONFIRMATION_YOURS);
    expect(html).toContain(TASK_ID);
    expect(html).not.toContain('OWNER_CONFIRMED');
    // In the order the owner decides in: the task, then what settles it, then the report.
    const settles = html.indexOf(WHAT_SETTLES_IT);
    const reported = html.indexOf(WHAT_THE_RUN_REPORTED);
    expect(html.indexOf(escaped(TITLE))).toBeLessThan(settles);
    expect(settles).toBeGreaterThan(-1);
    expect(reported).toBeGreaterThan(settles);
    // What settles it is one row at rest, saying how much is behind it; it opens in place.
    expect(html).toContain('>1 item<');
    expect(html).not.toContain(escaped(CRITERIA));
    expect(html).toContain(escaped(whatTheRunReported(waiting().report)));
    // The report is the run's words with the Markdown marks taken off.
    expect(html).toContain(escaped('Done. 38 invoices are renamed and filed under finance/2026-09/'));
    expect(html).toContain(`data-owner-confirmation="${REQUEST_ID}"`);
  });

  it('has exactly two answers, Confirm done and Chat about this, and both can be pressed', () => {
    // The folds are not answers: Show all, and the row what counts as done is folded into.
    const isFold = (button: { text: string }): boolean =>
      button.text === OWNER_CONFIRMATION_SHOW_ALL || button.text.startsWith(WHAT_SETTLES_IT);
    const answers = buttons(card()).filter((button) => !isFold(button));
    expect(answers.map((button) => button.text)).toEqual([OWNER_CONFIRM_ACTION, OWNER_SEND_BACK_ACTION]);
    expect(answers.map((button) => isDisabled(button.tag))).toEqual([false, false]);
    // The primary look belongs to Confirm done.
    expect(answers[0].tag).toContain('card-action--primary');
    // And while a press is on its way, neither is pressable again.
    const busy = buttons(card({ busy: true })).filter((button) => !isFold(button));
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

  it('keeps the paragraphs and list items of both boxes on lines of their own', async () => {
    // Flattened, a report written as a lead and a list read as one run-on line — on the phone with
    // the list's dashes still in it.
    const v = view({ acceptanceCriteria: '## Done when\n\n- all filed\n- totals match' });
    const w = waiting({ report: { text: 'Done.\n\n- **renamed**: 38\n- **moved**: 2', reportedAt: '2026-09-13T10:39:00.000Z' } });
    expect(card({ view: v, waiting: w })).toContain('>Done.\n\n• renamed: 38\n• moved: 2<');
    // What counts as done is behind its fold; opened, it keeps its lines too.
    const scope = await mount(<OwnerConfirmationCard view={v} waiting={w} onDecide={() => {}} onSendBack={() => {}} />);
    await press(scope.querySelector<HTMLElement>('.owner-confirmation-fold')!);
    expect(scope.querySelector('.owner-confirmation-value')?.textContent).toBe('Done when\n\n• all filed\n• totals match');
  });

  it('folds what counts as done into one row that says how much is behind it, and opens it in place', async () => {
    const v = view({ acceptanceCriteria: '1. One\n2. Two\n3. Three\n4. Four\n5. Five\n6. Six' });
    const scope = await mount(<OwnerConfirmationCard view={v} waiting={waiting()} onDecide={() => {}} onSendBack={() => {}} />);
    const fold = scope.querySelector<HTMLButtonElement>('.owner-confirmation-fold')!;
    expect(fold.textContent).toBe(`${WHAT_SETTLES_IT}6 items`);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(scope.textContent).not.toContain('1. One');

    await press(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    // In place: the criteria open inside the same box, right under the row.
    expect(fold.nextElementSibling?.textContent).toBe('1. One\n2. Two\n3. Three\n4. Four\n5. Five\n6. Six');

    await press(fold);
    expect(scope.textContent).not.toContain('1. One');
  });

  it('draws If you confirm right above Confirm done, white and without an author', async () => {
    const ifConfirmed: OwnerConfirmationIfConfirmed = {
      startsTasks: [{ id: 't2', title: 'Draw the card on iOS', starts: 'NOW' }],
      startsAfterLanding: false,
      branch: { name: 'orbit/p1-1c207b', linesAdded: 9432, linesRemoved: 11, files: 41, onMain: 'NO' },
      landing: 'NONE',
      endsSession: { sessionId: SESSION_ID, runningBgJobs: 0 },
    };
    const html = card({ view: view({ ifConfirmed }) });
    // Under the report, over the buttons.
    expect(html.indexOf(IF_YOU_CONFIRM)).toBeGreaterThan(html.indexOf(WHAT_THE_RUN_REPORTED));
    expect(html.indexOf(IF_YOU_CONFIRM)).toBeLessThan(html.indexOf(OWNER_CONFIRM_ACTION));
    expect(html).toContain('Starts 1 task waiting on this one');
    expect(html).toContain(`${IF_CONFIRMED_NOT_ON_MAIN} · <span class="owner-confirmation-if-added">+9,432</span>`);
    expect(html).toContain('orbit/p1-1c207b — confirming doesn’t merge it');
    expect(html).toContain(`>${IF_CONFIRMED_ENDS_SESSION}<`);
    // Nobody's words: no "what the agent said" over it, and no name on it.
    const block = html.slice(html.indexOf('class="owner-confirmation-if"'), html.indexOf(OWNER_CONFIRM_ACTION));
    expect(block).not.toContain(WHAT_THE_RUN_REPORTED);

    // Pressed for real, it is the last thing before the row Confirm done is in.
    const scope = await mount(
      <OwnerConfirmationCard view={view({ ifConfirmed })} waiting={waiting()} onDecide={() => {}} onSendBack={() => {}} />,
    );
    const next = scope.querySelector('.approval-body')?.nextElementSibling as HTMLElement | null;
    expect(next?.querySelector('button')?.textContent).toContain(OWNER_CONFIRM_ACTION);
  });

  it('leaves out what the read left out, and the whole block when nothing is left', () => {
    // An older server, nothing waiting, every item unread, nothing to say: no block.
    expect(card()).not.toContain(IF_YOU_CONFIRM);
    expect(card({ view: view({ ifConfirmed: null }) })).not.toContain(IF_YOU_CONFIRM);
    expect(card({ view: view({ ifConfirmed: {} }) })).not.toContain(IF_YOU_CONFIRM);
    expect(card({
      view: view({ ifConfirmed: { startsTasks: [], startsAfterLanding: false, branch: null, landing: 'NONE', endsSession: null } }),
    })).not.toContain(IF_YOU_CONFIRM);
    // Only the run could be read: only its row.
    const ends = card({ view: view({ ifConfirmed: { endsSession: { sessionId: SESSION_ID, runningBgJobs: 2 } } }) });
    expect(ends).toContain(IF_YOU_CONFIRM);
    expect(ends).toContain('Ends this session · 2 background jobs stop');
    expect(ends).not.toContain(IF_CONFIRMED_NOT_ON_MAIN);
    expect(ends.match(/owner-confirmation-if-row/gu)?.length).toBe(1);
  });

  it('folds at the ceiling without leaving the … on a line of its own', () => {
    const text = `${'x'.repeat(REPORT_CLAMP - 1)}\n\nthe rest`;
    const html = card({ waiting: waiting({ report: { text, reportedAt: '2026-09-13T10:39:00.000Z' } }) });
    expect(html).toContain(`>${'x'.repeat(REPORT_CLAMP - 1)}…<`);
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
    expect(ownerDecisionReceiptLine(sendBack)).toMatch(/^Asked for more by you · /u);
    expect(buttons(sentBack)).toEqual([]);
  });

  it('opens a receipt straight to what counted as done, with no second fold inside its own', async () => {
    const scope = await mount(<OwnerDecisionReceipt view={view({ waiting: null })} decided={decided()} />);
    await press(buttonIn(scope, `${OWNER_SHOW_WHAT_SETTLED_IT} ▾`));
    expect(scope.textContent).toContain(CRITERIA);
    expect(scope.querySelector('.owner-confirmation-fold')).toBeNull();
    expect(scope.textContent).not.toContain(IF_YOU_CONFIRM);
  });
});

/**
 * If you confirm and the folded criteria row, proved against `owner-confirmation-if-confirmed.fixture.json`
 * — the same cases the native client's `OwnerConfirmationIfConfirmedTests` proves its own against, so
 * the browser, the Mac and the phone say one thing about what a confirmation sets off.
 */
describe('If you confirm, in the words both clients say', () => {
  const fixture = JSON.parse(
    readFileSync(
      [
        resolve(process.cwd(), '../shared/src/owner-confirmation-if-confirmed.fixture.json'),
        resolve(process.cwd(), 'src/shared/src/owner-confirmation-if-confirmed.fixture.json'),
      ].find(existsSync)!,
      'utf8',
    ),
  ) as {
    rows: Array<{ case: string; ifConfirmed: OwnerConfirmationIfConfirmed | null; rows: IfConfirmedRow[] }>;
    criteria: Array<{ case: string; acceptanceCriteria: string | null; label: string | null }>;
  };

  it('draws the rows the read describes, in order, and none for what it left out', () => {
    expect(fixture.rows.length).toBeGreaterThan(10);
    for (const c of fixture.rows) {
      expect(ifConfirmedRows(c.ifConfirmed), c.case).toEqual(c.rows);
    }
  });

  it('counts what counts as done the way the folded row says it', () => {
    expect(fixture.criteria.length).toBeGreaterThan(8);
    for (const c of fixture.criteria) {
      expect(criteriaItemsLabel(c.acceptanceCriteria), c.case).toBe(c.label);
    }
  });
});

/** The rows that say main, said of the project's main branch the read names (`ifConfirmed.mainBranch`). */
describe('If you confirm, by the project’s main branch', () => {
  const unmerged = { name: 'orbit/p1-1c207b', linesAdded: 12, linesRemoved: 1, files: 2, onMain: 'NO' } as const;
  const unplaced = { ...unmerged, onMain: 'UNKNOWN' } as const;
  const leads = (ifConfirmed: OwnerConfirmationIfConfirmed) => ifConfirmedRows(ifConfirmed).map((row) => row.lead);

  it('names the branch and the landing rows by the main branch the read names', () => {
    expect(leads({ branch: unmerged, landing: 'LINE_THEN_OWNER', mainBranch: 'master' })).toEqual([
      'Not on master yet',
      'Goes onto the integration line; merging into master asks you again',
    ]);
    expect(leads({ branch: unplaced, landing: 'AUTO_MAIN', mainBranch: 'master' })).toEqual([
      'No record of this branch on master',
      'Lands on master by itself if the checks pass',
    ]);
    const html = card({ view: view({ ifConfirmed: { branch: unmerged, landing: 'LINE_THEN_OWNER', mainBranch: 'master' } }) });
    expect(html).toContain('Not on master yet · <span class="owner-confirmation-if-added">+12</span>');
    expect(html).toContain('merging into master asks you again');
    expect(html).not.toContain(IF_CONFIRMED_NOT_ON_MAIN);
  });

  it('says them as before for a project on main, with no repository bound, or from an older server', () => {
    for (const mainBranch of ['main', null, undefined]) {
      expect(leads({ branch: unmerged, landing: 'LINE_THEN_OWNER', mainBranch }), String(mainBranch))
        .toEqual([IF_CONFIRMED_NOT_ON_MAIN, IF_CONFIRMED_LINE_THEN_OWNER]);
      expect(leads({ branch: unplaced, landing: 'AUTO_MAIN', mainBranch }), String(mainBranch))
        .toEqual([IF_CONFIRMED_NO_RECORD_ON_MAIN, IF_CONFIRMED_AUTO_MAIN]);
    }
  });
});

describe('what a press sends', () => {
  it('names the report it answers, and carries a reason only with a send-back', () => {
    // A confirmation always names the review record its card drew — null when it drew none — which
    // is how the door knows this client knows about reviews (contract §7 Q3); a send-back does not.
    expect(ownerDecisionRequest(TASK_ID, REQUEST_ID, 'CONFIRM')).toEqual({
      path: `/tasks/${TASK_ID}/owner-confirmation`,
      body: { decision: 'CONFIRM', requestId: REQUEST_ID, reviewRecordId: null },
    });
    expect(ownerDecisionRequest(TASK_ID, REQUEST_ID, 'SEND_BACK', '  take the amount from the bank line  ')).toEqual({
      path: `/tasks/${TASK_ID}/owner-confirmation`,
      body: { decision: 'SEND_BACK', requestId: REQUEST_ID, note: 'take the amount from the bank line' },
    });
    // The task panel answers "no run is waiting".
    expect(ownerDecisionRequest(TASK_ID, null, 'CONFIRM').body)
      .toEqual({ decision: 'CONFIRM', requestId: null, reviewRecordId: null });
  });

  it('reads a refusal for staleness as an out-of-date card', () => {
    for (const code of ['OWNER_CONFIRMATION_STALE', 'OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK', 'OWNER_CONFIRMATION_TASK_SETTLED']) {
      expect(ownerDecisionRefusal(Object.assign(new Error('x'), { code })).stale).toBe(true);
    }
    expect(ownerDecisionRefusal(Object.assign(new Error('x'), { code: 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER' })).stale).toBe(false);
  });

  it('Chat about this hands the reason to the composer, and presses nothing itself', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view());
    const armed: Array<[string, string]> = [];
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard
            sessionId={SESSION_ID}
            taskId={TASK_ID}
            onSendBack={(w, title) => armed.push([w.requestId, title])}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The card takes no text — that is the whole change. It never did before the press either, so
    // the assertion that means something is the one after it.
    expect(scope.querySelector('textarea')).toBeNull();

    await press(buttonIn(scope, OWNER_SEND_BACK_ACTION));

    // Still no box, and nothing was sent: the door is pressed by the send that follows, at the
    // composer, with whatever is typed there.
    expect(scope.querySelector('textarea')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    // What the composer is handed is the request this card was drawn for, and the task's own title
    // for its bar — not the task id, which names nothing a reader recognises.
    expect(armed).toEqual([[REQUEST_ID, TITLE]]);
  });

  it('says what the press promises where the reason box used to say it', () => {
    // The sentence did not survive as a line under a box, because there is no box. It survives as
    // the button's own tooltip, so "the task stays open" is still readable before pressing.
    const html = card();
    expect(html).toContain(escaped(OWNER_SEND_BACK_HINT));
    // And the reason's label is still declared, because the composer asks with it.
    expect(OWNER_SEND_BACK_LABEL).toBe("What's missing?");
  });

  it('Confirm done posts the owner\'s decision about the report on the card, and re-reads', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view());
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'CONFIRM', completed: true });
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard sessionId={SESSION_ID} taskId={TASK_ID} onSendBack={() => {}} />
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
      body: { decision: 'CONFIRM', requestId: REQUEST_ID, reviewRecordId: null },
    }]]);
    expect(apiMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    // ...and the read the card is drawn from is asked again once the door has answered.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task', TASK_ID] });
    expect(apiMock.mock.calls.slice(1).map(([path]) => path)).toContain(`/tasks/${TASK_ID}/owner-confirmation`);
  });

  it('confirms on Enter and leaves Chat about this without a shortcut', async () => {
    const qc = newClient();
    qc.setQueryData(ownerConfirmationQuery(TASK_ID).queryKey, view());
    apiMock.mockResolvedValue({ id: 'decision-1', decision: 'CONFIRM', completed: true });
    const armed: Array<[string, string]> = [];
    const scope = await mount(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionOwnerConfirmationCard
            sessionId={SESSION_ID}
            taskId={TASK_ID}
            onSendBack={(w, title) => armed.push([w.requestId, title])}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // One card asking, so it holds the keys — and says which key presses which control, on the
    // controls themselves, because a shortcut nobody can see is a shortcut nobody has.
    expect(hintOn(buttonIn(scope, OWNER_CONFIRM_ACTION))).toBe(ENTER_HINT);
    expect(hintOn(buttonIn(scope, OWNER_SEND_BACK_ACTION))).toBeNull();

    await key({ metaKey: true });
    await key({ ctrlKey: true });
    expect(armed).toEqual([]);
    expect(apiMock).not.toHaveBeenCalled();
    expect(buttonIn(scope, OWNER_CONFIRM_ACTION).disabled).toBe(false);

    // And the bare key is the first: the same POST one press makes, and none of its own.
    await key();
    const posts = apiMock.mock.calls.filter(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posts).toEqual([[`/tasks/${TASK_ID}/owner-confirmation`, {
      method: 'POST',
      body: { decision: 'CONFIRM', requestId: REQUEST_ID, reviewRecordId: null },
    }]]);
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
    // No second control that decides: not the card's actions, not its two labels, and exactly one
    // card mounted. That is what "one place to answer" means and it is unchanged.
    expect(source).not.toMatch(/\bOWNER_CONFIRM_ACTION\b|\bOWNER_SEND_BACK_ACTION\b|OwnerConfirmationActions/u);
    expect(source).not.toMatch(/['"`]Confirm done['"`]/u);
    expect(source).not.toMatch(/\bownerDecisionRequest\b/u);
    expect(source.match(/<SessionOwnerConfirmationCard\b/gu)?.length).toBe(1);
    // What this file DOES press is the send the composer completes, and it may only ever send a
    // report back. A confirmation from here would be the second answer this rule exists to prevent
    // — the card's own Confirm done is the only one — so `'CONFIRM'` must not appear beside it.
    expect(source.match(/\bsendOwnerDecision\b/gu)?.length).toBe(2); // the import, and the one call
    expect(source).toMatch(/decision: 'SEND_BACK'/u);
    expect(source).not.toMatch(/decision: 'CONFIRM'/u);
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

// The card's content/decision contract is tested inline; real dialogs are covered in ReviewCard.test.tsx.
vi.mock('./ReviewCard', () => import('../test/inlineReviewCard'));
