// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingDecisionsQuery } from '../lib/queries';
import type { SessionStateSource } from '../lib/sessionState';
import { CARD_ACTION_CLASS } from './CardAction';
import { ENTER_HINT } from './CardHotkey';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import {
  DecisionStrip,
  decisionRowKey,
  needsDecisionCount,
  type PendingDecisionQueue,
  type PendingDecisionRow,
  type SentToCoordinatorRow,
} from './DecisionRail';
import {
  DECISION_ASK_HEADING,
  DECISION_CONFIRM_ACTION,
  DECISION_CRITERION_HEADING,
  DECISION_DECIDE_MYSELF_ACTION,
  DECISION_NO_CLAIM,
  DECISION_NO_CRITERION,
  DECISION_NO_GAPS,
  DECISION_SEND_BACK_ACTION,
  DECISION_SEND_BACK_HINT,
  EVIDENCE_DECISION_ALREADY_DECIDED,
  EVIDENCE_DECISION_COORDINATOR_BACK,
  EVIDENCE_DECISION_QUEUED_HEADING,
  EVIDENCE_DECISION_QUEUED_NOTE,
  EVIDENCE_DECISION_QUEUED_OPEN_NOTE,
  EVIDENCE_DECISION_RECORDED_HEADING,
  EVIDENCE_DECISION_STALE_HEADING,
  EVIDENCE_DECISION_SUPERSEDED,
  EVIDENCE_DECISION_UNREAD_HEADING,
  EvidenceDecisionCard,
  SessionEvidenceDecisionCard,
  coordinatorPause,
  coordinatorPauseLine,
  decisionClaimFold,
  decisionGapsMore,
  decisionReceiptTime,
  evidenceDecidingSession,
  evidenceDecisionCardRows,
  evidenceDecisionRecordedLine,
  evidenceDecisionRefusal,
  evidenceDecisionRequest,
  evidenceDecisionStanding,
  sendEvidenceDecision,
  sentToCoordinatorLine,
  type EvidenceDecisionResult,
  type EvidenceDecisionStanding,
} from './EvidenceDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * The evidence-decision card as a system card: what it draws from the pending read, what one press
 * sends to the decision door, and — the half most of this file is about — what it refuses to offer
 * once the version it was drawn for has moved on.
 *
 * Every standing is fed as a DERIVED READ plus an address, never as a hand-built standing, because
 * "the card notices" is a claim about what it concludes from that read. Assertions are predicates
 * over the rendered output — this control is disabled, that code is named, this claim is absent —
 * and every `disabled` assertion has a lit twin in the same fixture, so a card that rendered every
 * button dead could not pass.
 *
 * Static renders carry most of it, as in `CriteriaDecisionCard.test.tsx`. The file runs under jsdom
 * for the things a static render cannot do: open a fold, and press a button all the way through to
 * the (mocked) `api()` call and the re-read it. The second answer is asserted as the handoff it is
 * — the view is called with the row, and no textarea exists anywhere on the card, because the place
 * a reason is typed is the composer this press arms. `renderToStaticMarkup` writes `&` as `&amp;`,
 * so every text assertion goes through `escaped()` — the fixture's claim carries an ampersand and
 * its title angle brackets to keep that honest.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const PROJECT_ID = '34MPiBgZ80YpSKt0lmTQA';
const OTHER_PROJECT_ID = '34LWcmLItBx6ytdO26XXF';
const TASK_ID = '34MQU2Y12ag8HVafcL8qL';

/** Four, because the card shows three and counts the rest. */
const GAPS = [
  '没有在真浏览器里点过按钮，只跑了静态渲染与 jsdom。',
  '服务端停投递是兄弟任务的活，本分支上 coordinator 仍会发起 AskUserQuestion。',
  '没有跑 full-api，web 只跑了点名的测试文件。',
  '合并归 coordinator，改动停在任务分支。',
];

const CLAIM = '证据卡从待决读渲染 & 按钮直连决定门，点击到落库不再经过 LLM。';

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_ID,
    title: 'Web：证据裁决卡改为系统卡 <从待决读渲染>',
    projectId: PROJECT_ID,
    criterion: { key: '7L4At4DOupG7FwgxfXykzS', text: 'Web 会话里的证据裁决卡由待决读直接渲染' },
    evidenceRevision: '2',
    ageSeconds: 10 * 60,
    claim: CLAIM,
    gaps: GAPS,
    citations: [
      {
        kind: 'TOOL_CALL',
        ref: 'toolu_held',
        resolved: true,
        reason: null,
        label: 'Bash · npx vitest run',
      },
    ],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

function queue(rows: PendingDecisionRow[]): PendingDecisionQueue {
  return {
    decidingSessionId: SESSION_ID,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    pending: rows,
    waitingOnYou: [],
  };
}

/** The door's receipt, in the shape `TaskEvidenceDecisionDto` reads back. */
function receipt(over: Partial<EvidenceDecisionResult> = {}): EvidenceDecisionResult {
  return {
    taskId: TASK_ID,
    evidenceRevision: '2',
    decision: 'CONFIRM',
    note: null,
    decidedAt: '2026-09-10T14:30:00.000Z',
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

function card(
  standing: EvidenceDecisionStanding,
  over: { error?: Error | null; recorded?: EvidenceDecisionResult | null } = {},
): string {
  return renderToStaticMarkup(
    <EvidenceDecisionCard
      standing={standing}
      onConfirm={() => {}}
      onChatAbout={() => {}}
      {...over}
    />,
  );
}

/** Every rendered button, as its opening tag and its text. Labels are matched exactly: the
 *  card's actions are two whole sentences, and nothing here may match loosely. */
function buttons(html: string): Array<{ tag: string; text: string }> {
  return [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/gu)].map((match) => ({
    tag: match[1],
    text: match[2].replace(/<[^>]*>/gu, ''),
  }));
}

function isDisabled(html: string, label: string): boolean {
  const found = buttons(html).filter((button) => button.text === escaped(label));
  expect(found.length, `controls labelled ${label}`).toBe(1);
  return /\sdisabled(?:=|\s|>)/u.test(found[0].tag);
}

/** The cards' root addresses, in render order. */
function roots(html: string): string[] {
  return [...html.matchAll(/data-decision-row="([^"]*)"/gu)].map((match) => match[1]);
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

/** The wired cards over a read that has already come back. The send-back arms the composer one
 *  level up, so it is a callback the view supplies and this asserts nothing about. */
function sessionCards(
  rows: PendingDecisionRow[],
  projectId: string | null = PROJECT_ID,
  onSendBack: (row: PendingDecisionRow) => void = () => {},
): string {
  const qc = newClient();
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue(rows));
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionEvidenceDecisionCard
        sessionId={SESSION_ID}
        projectId={projectId}
        onSendBack={onSendBack}
      />
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

/** React Query hands settled results over on a macrotask, and `act` alone only drains microtasks. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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

/** One keypress, as the browser delivers it: on the window, with whatever focus is standing. */
async function key(init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

function action(scope: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => labelOf(button).replace(/[▾▴]/gu, '') === label,
  );
}

function press(scope: HTMLElement, label: string): HTMLButtonElement {
  const button = action(scope, label);
  if (!button) throw new Error(`no control on the card labelled: ${label}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the card is drawn from the row the pending read published', () => {
  it('shows the row’s title, claim, version, criterion and gaps, and counts the gaps it folded', () => {
    const live = row();
    const html = card(evidenceDecisionStanding(queue([live]), PROJECT_ID, live));

    expect(html).toContain(DECISION_ASK_HEADING);
    expect(html).toContain(escaped(live.title));
    expect(html).toContain(escaped(live.claim));
    expect(html).toContain(escaped(`${live.taskId} · rev ${live.evidenceRevision} · `));
    expect(html).toContain(live.criterion!.key);
    for (const gap of GAPS.slice(0, 3)) expect(html).toContain(escaped(gap));
    // The fourth is folded and COUNTED, not dropped.
    expect(html).not.toContain(escaped(GAPS[3]));
    expect(html).toContain(decisionGapsMore(1));
  });

  it('carries the criterion’s own text, not only its key, and leads the card with it', () => {
    // The judgment is whether this evidence settles THAT sentence. The key identifies it; only the
    // text lets somebody answer, and it used to be two disclosures down inside a machine check.
    const live = row();
    const html = card(evidenceDecisionStanding(queue([live]), PROJECT_ID, live));

    expect(html).toContain(DECISION_CRITERION_HEADING);
    expect(html).toContain(escaped(live.criterion!.text));
    // The order a person decides in: the standard, then what the submitter admits is missing, and
    // the account they wrote about it last.
    const standard = html.indexOf(escaped(live.criterion!.text));
    expect(standard).toBeLessThan(html.indexOf(escaped(GAPS[0])));
    expect(html.indexOf(escaped(GAPS[0]))).toBeLessThan(html.indexOf(escaped(live.claim)));
  });

  it('says what a different row says, and nothing of the first', () => {
    // The negative control for the case above: were any of those strings constants that merely
    // matched the fixture, they would still be here.
    const first = row();
    const other = row({
      taskId: '34LVWtmeCNjbcCbCF2wDd',
      title: '另一条任务',
      evidenceRevision: '7',
      claim: '另一条主张',
      gaps: [],
      criterion: null,
    });
    const html = card(evidenceDecisionStanding(queue([other]), PROJECT_ID, other));

    expect(html).toContain('另一条任务');
    expect(html).toContain('另一条主张');
    expect(html).toContain(escaped(`${other.taskId} · rev 7 · `));
    expect(html).toContain(DECISION_NO_CRITERION);
    expect(html).toContain(DECISION_NO_GAPS);
    expect(html).not.toContain(escaped(first.title));
    expect(html).not.toContain(escaped(first.claim));
    expect(html).not.toContain(first.criterion!.key);
    expect(html).not.toContain(escaped(GAPS[0]));
  });

  it('folds a long claim to a line naming its length, and gives all of it back on request', async () => {
    const tail = '这句话在折叠时看不到';
    const claim = `${CLAIM}${'补充说明。'.repeat(40)}${tail}`;
    const long = row({ claim });
    const rendered = await mount(
      <EvidenceDecisionCard
        standing={evidenceDecisionStanding(queue([long]), PROJECT_ID, long)}
        onConfirm={() => {}}
        onChatAbout={() => {}}
      />,
    );

    // Folded, none of it is on screen — not even its first line. What stands in its place says how
    // much there is to read, so a thousand-word account cannot push the actions off a phone.
    expect(rendered.querySelector('.decision-ask-claim')).toBeNull();
    expect(rendered.textContent).toContain(decisionClaimFold(claim.length));
    await click(press(rendered, decisionClaimFold(claim.length)));
    expect(rendered.querySelector('.decision-ask-claim')?.textContent).toContain(tail);
    // And what it opens onto is the whole thing once, not the fold's preview plus the rest.
    expect(rendered.querySelector('.decision-ask-claim')?.textContent).toBe(claim);
  });

  it('says so when a revision carries no claim at all, rather than rendering a blank', () => {
    const empty = row({ claim: '' });
    expect(card(evidenceDecisionStanding(queue([empty]), PROJECT_ID, empty))).toContain(DECISION_NO_CLAIM);
  });

  it('counts the machine checks off the row’s own fields, and opens onto the three it counted', async () => {
    // One citation of two resolved, so one of the three checks did not hold.
    const live = row({
      citations: [
        { kind: 'TOOL_CALL', ref: 'toolu_held', resolved: true, reason: null, label: 'Bash · npx vitest run' },
        {
          kind: 'TOOL_CALL',
          ref: 'toolu_missing',
          resolved: false,
          reason: 'no tool call with that id under this task',
          label: null,
        },
      ],
    });
    const rendered = await mount(
      <EvidenceDecisionCard
        standing={evidenceDecisionStanding(queue([live]), PROJECT_ID, live)}
        onConfirm={() => {}}
        onChatAbout={() => {}}
      />,
    );

    await click(press(rendered, '2 checked for you · 1 did not hold'));
    const checks = [...rendered.querySelectorAll('.decision-ask-check-list > li')];
    expect(checks).toHaveLength(3);
    expect(checks[0].textContent).toContain(live.criterion!.text);
    expect(checks[1].textContent).toContain('1/2 citations resolved');
    expect(checks[1].textContent).toContain('no tool call with that id under this task');
    expect(checks[2].textContent).toContain('the decider is independent of this submission');
  });
});

describe('what one press sends to the door', () => {
  it('sends CONFIRM to the task’s own decision door, naming the deciding session and the version read', () => {
    const request = evidenceDecisionRequest(row(), SESSION_ID, 'CONFIRM');

    expect(request.path).toBe(`/tasks/${TASK_ID}/evidence/decision`);
    // Strict, because a `note: undefined` riding along passes `toEqual` and is still a key.
    expect(request.body).toStrictEqual({
      decidingSessionId: SESSION_ID,
      evidenceRevision: '2',
      decision: 'CONFIRM',
    });
  });

  it('puts the task id into the path encoded, not raw', () => {
    expect(evidenceDecisionRequest(row({ taskId: 'a/b?c' }), SESSION_ID, 'CONFIRM').path)
      .toBe('/tasks/a%2Fb%3Fc/evidence/decision');
  });

  it('sends SEND_BACK with its reason, trimmed', () => {
    const request = evidenceDecisionRequest(
      row(),
      SESSION_ID,
      'SEND_BACK',
      '  把 pg spec 跑一遍，贴出改前先红的输出  ',
    );

    expect(request.path).toBe(`/tasks/${TASK_ID}/evidence/decision`);
    expect(request.body).toStrictEqual({
      decidingSessionId: SESSION_ID,
      evidenceRevision: '2',
      decision: 'SEND_BACK',
      note: '把 pg spec 跑一遍，贴出改前先红的输出',
    });
  });

  it('goes out through the browser’s own authenticated call as a POST of exactly that request', async () => {
    apiMock.mockResolvedValueOnce(receipt({ decision: 'SEND_BACK', note: '补一条阴性对照' }) as never);
    await sendEvidenceDecision(row(), SESSION_ID, 'SEND_BACK', '补一条阴性对照');

    expect(apiMock.mock.calls).toEqual([
      [
        `/tasks/${TASK_ID}/evidence/decision`,
        {
          method: 'POST',
          body: {
            decidingSessionId: SESSION_ID,
            evidenceRevision: '2',
            decision: 'SEND_BACK',
            note: '补一条阴性对照',
          },
        },
      ],
    ]);
  });
});

describe('the second answer is a composer handoff', () => {
  it('is the same word the other cards use, printed under the buttons with what pressing it does not do', () => {
    const live = row();
    const html = card(evidenceDecisionStanding(queue([live]), PROJECT_ID, live));

    // One control, one name: the confirmation card, the question card, the settlement card and the
    // create/restructure cards all say this, and a card that declared its own word would be the
    // sixth name for one thing. `DECISION_SEND_BACK_ACTION` is what the RECORD says about an answer
    // already given, not what the button says.
    expect(buttons(html).map((button) => button.text)).toContain(OWNER_SEND_BACK_ACTION);
    expect(OWNER_SEND_BACK_ACTION).not.toBe(DECISION_SEND_BACK_ACTION);
    // The promise, on the card rather than in a tooltip: a touch screen never shows a hover.
    expect(html).toContain(escaped(DECISION_SEND_BACK_HINT));
    expect(html).toContain('The task stays open.');
  });

  it('grows no box — the card holds no textarea, and the reason is typed at the composer', async () => {
    const onChatAbout = vi.fn();
    const onConfirm = vi.fn();
    const live = row();
    const rendered = await mount(
      <EvidenceDecisionCard
        standing={evidenceDecisionStanding(queue([live]), PROJECT_ID, live)}
        onConfirm={onConfirm}
        onChatAbout={onChatAbout}
      />,
    );

    expect(rendered.querySelector('textarea')).toBeNull();
    await click(press(rendered, OWNER_SEND_BACK_ACTION));
    // Arming the composer is the whole of the press: the card presses no door and stays put, and
    // its own confirm is still the other way out.
    expect(onChatAbout).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(action(rendered, DECISION_CONFIRM_ACTION)).not.toBeUndefined();
    expect(press(rendered, DECISION_CONFIRM_ACTION).disabled).toBe(false);
  });

  it('offers it exactly where the card can be answered, dead in every standing where nothing can', () => {
    const live = row();
    expect(isDisabled(card(evidenceDecisionStanding(queue([live]), PROJECT_ID, live)),
      OWNER_SEND_BACK_ACTION)).toBe(false);
    for (const dead of [
      evidenceDecisionStanding(queue([]), PROJECT_ID, live),
      evidenceDecisionStanding(queue([row({ evidenceRevision: '3' })]), PROJECT_ID, live),
      evidenceDecisionStanding(null, PROJECT_ID, live),
    ]) {
      expect(isDisabled(card(dead), OWNER_SEND_BACK_ACTION), dead.state).toBe(true);
    }
  });
});

describe('where a card stands, and what it lets a reader press', () => {
  const live = row();

  it('DECIDABLE: both verdicts can be pressed, and there is nothing to explain', () => {
    const standing = evidenceDecisionStanding(queue([live]), PROJECT_ID, live);
    expect(standing.state).toBe('DECIDABLE');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(false);
    expect(isDisabled(html, OWNER_SEND_BACK_ACTION)).toBe(false);
    expect(html).toContain(DECISION_ASK_HEADING);
    expect(html).not.toContain('evidence-decision-stale');
  });

  it('ALREADY_DECIDED: the version has left the read, so nothing can be pressed and the refusal is named', () => {
    const standing = evidenceDecisionStanding(queue([]), PROJECT_ID, live);
    expect(standing.state).toBe('ALREADY_DECIDED');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(true);
    expect(isDisabled(html, OWNER_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(html).toContain('Already answered');
    expect(html).toContain(EVIDENCE_DECISION_ALREADY_DECIDED);
    // The address, and no frozen copy of what the version said.
    expect(html).toContain(escaped(`${live.taskId} · rev ${live.evidenceRevision}`));
    expect(html).not.toContain(escaped(live.claim));
  });

  it('SUPERSEDED: a later revision of the same task is in the read, and this version can no longer be answered', () => {
    const later = row({ evidenceRevision: '3', claim: '第三版的主张' });
    const standing = evidenceDecisionStanding(queue([later]), PROJECT_ID, live);
    expect(standing.state).toBe('SUPERSEDED');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(true);
    expect(isDisabled(html, OWNER_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(html).toContain('Superseded');
    expect(html).toContain('version 3');
    expect(html).toContain(EVIDENCE_DECISION_SUPERSEDED);
    // Neither version's content: this one is not published any more, and the later one has its
    // own card.
    expect(html).not.toContain(escaped(live.claim));
    expect(html).not.toContain('第三版的主张');
  });

  it('compares revisions as numbers written in digits, so rev 10 displaces rev 9 and rev 1 displaces nothing', () => {
    expect(
      evidenceDecisionStanding(queue([row({ evidenceRevision: '10' })]), PROJECT_ID,
        row({ evidenceRevision: '9' })).state,
    ).toBe('SUPERSEDED');
    expect(
      evidenceDecisionStanding(queue([row({ evidenceRevision: '1' })]), PROJECT_ID,
        row({ evidenceRevision: '2' })).state,
    ).toBe('ALREADY_DECIDED');
  });

  it('UNREAD: the read has not come back, so nothing is offered and nothing is claimed about the evidence', () => {
    const standing = evidenceDecisionStanding(null, PROJECT_ID, live);
    expect(standing.state).toBe('UNREAD');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(true);
    expect(isDisabled(html, OWNER_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_UNREAD_HEADING);
    expect(html).toContain('The pending read did not come back just now');
    // A failed read is not an answer: the card must not tell the reader somebody decided.
    expect(html).not.toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(html).not.toContain(EVIDENCE_DECISION_ALREADY_DECIDED);
    expect(html).not.toContain(escaped(live.claim));
  });

  it('once answered from this card, says what was recorded instead of offering the verdicts again', () => {
    const recorded = receipt({ decision: 'SEND_BACK', note: '补一条阴性对照' });
    const html = card(evidenceDecisionStanding(queue([]), PROJECT_ID, live), { recorded });

    expect(html).toContain(EVIDENCE_DECISION_RECORDED_HEADING);
    expect(html).toContain(escaped(evidenceDecisionRecordedLine(recorded)));
    expect(buttons(html).filter((button) => button.tag.includes(CARD_ACTION_CLASS))).toHaveLength(0);
    // Its own answer is not "answered at another end".
    expect(html).not.toContain(EVIDENCE_DECISION_ALREADY_DECIDED);
  });
});

describe('a press the door refused', () => {
  const live = row();
  const standing = evidenceDecisionStanding(queue([live]), PROJECT_ID, live);
  const refused = (code: string | undefined, message: string): Error =>
    Object.assign(new Error(message), { code });

  it('explains ALREADY_DECIDED and EVIDENCE_SUPERSEDED as a card gone stale, with the door’s own words', () => {
    for (const code of [EVIDENCE_DECISION_ALREADY_DECIDED, EVIDENCE_DECISION_SUPERSEDED]) {
      const message = `revision 2 of this task's evidence was refused: ${code} & nothing was written`;
      const html = card(standing, { error: refused(code, message) });

      expect(evidenceDecisionRefusal(refused(code, message)).stale, code).toBe(true);
      expect(html, code).toContain('out of date');
      expect(html, code).toContain(escaped(evidenceDecisionRefusal(refused(code, message)).title));
      expect(html, code).toContain(escaped(message));
    }
  });

  it('says only that it was not recorded for any other refusal', () => {
    const html = card(standing, { error: refused(undefined, 'decidingSessionId is invalid') });

    expect(html).toContain('Not recorded');
    expect(html).toContain('decidingSessionId is invalid');
    expect(html).not.toContain('out of date');
  });
});

describe('which rows get a card in this conversation', () => {
  const mine = row();
  const elsewhere = row({
    taskId: '34LVWtmeCNjbcCbCF2wDd',
    projectId: OTHER_PROJECT_ID,
    claim: '别的项目的主张',
  });
  const unfiled = row({ taskId: '34LMiluvx0jK63cj8arWl', projectId: null, claim: '不在任何项目里的主张' });
  const notIndependent = row({
    taskId: '34KzKd0m1xU0FJ1xWkMFz',
    claim: '本会话自己做的活',
    independence: {
      independent: false,
      disqualification: 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION',
      requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
    },
  });

  it('draws one card per row of this project the session may answer, rooted on that row’s address', () => {
    const html = sessionCards([mine, elsewhere, unfiled, notIndependent]);

    expect(roots(html)).toEqual([decisionRowKey(mine)]);
    // On the card's ROOT, which is what the rail's pointer scrolls into view.
    expect(html.startsWith(
      `<div class="approval-card decision-ask evidence-decision" data-decision-row="${decisionRowKey(mine)}">`,
    )).toBe(true);
    expect(html).toContain(escaped(mine.claim));
    for (const other of [elsewhere, unfiled, notIndependent]) {
      expect(html).not.toContain(escaped(other.claim));
    }
  });

  it('draws nothing for a row of another project, of no project, or one this session may not answer — each on its own', () => {
    expect(sessionCards([elsewhere])).toBe('');
    expect(sessionCards([unfiled])).toBe('');
    expect(sessionCards([notIndependent])).toBe('');
    expect(sessionCards([
      row({ decidability: { decidable: false, refusal: 'EVIDENCE_JUDGMENT_CRITERION_MOVED', requiredAction: null } }),
    ])).toBe('');
    // The same task filed under this project does get its card, so the empty renders above are the
    // filter and not a render that draws nothing at all.
    expect(roots(sessionCards([row({ taskId: elsewhere.taskId })]))).toEqual([`${elsewhere.taskId}@2`]);
  });

  it('draws nothing in a session that coordinates no project', () => {
    expect(sessionCards([mine], null)).toBe('');
    expect(roots(sessionCards([mine], PROJECT_ID))).toEqual([decisionRowKey(mine)]);
  });
});

describe('a task a session dispatched outside any project: its card is where the read says', () => {
  // The B line (apiserver tasks/evidence-review.ts): the read names the one conversation the owner's
  // card for such a row is drawn in (`ownerCard`), and the session its decision is recorded as —
  // the dispatching session, which did none of the work, even when the card has moved to the run.
  const DISPATCHER_ID = '34N1DispatchingSessAa';
  const dispatched = row({
    taskId: '34N2TaskOutsideProjectX',
    projectId: null,
    claim: '项目外由派活会话审的活',
    ownerCard: { sessionId: SESSION_ID, decidingSessionId: SESSION_ID },
  });
  const inTheRun = row({
    ...dispatched,
    ownerCard: { sessionId: SESSION_ID, decidingSessionId: DISPATCHER_ID },
  });

  it('draws its card in the conversation its ownerCard names, whether or not that one coordinates a project', () => {
    expect(roots(sessionCards([dispatched], null))).toEqual([decisionRowKey(dispatched)]);
    expect(roots(sessionCards([dispatched], PROJECT_ID))).toEqual([decisionRowKey(dispatched)]);
    expect(roots(sessionCards([inTheRun], null))).toEqual([decisionRowKey(inTheRun)]);
  });

  it('draws none in any other conversation, nor for one this session may not answer', () => {
    expect(sessionCards([row({ ...dispatched, ownerCard: { sessionId: DISPATCHER_ID, decidingSessionId: DISPATCHER_ID } })], null))
      .toBe('');
    expect(sessionCards([row({
      ...dispatched,
      independence: {
        independent: false,
        disqualification: 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION',
        requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
      },
    })], null)).toBe('');
    // A row in no project with no ownerCard is the population nobody dispatched: no card anywhere.
    expect(sessionCards([row({ ...dispatched, ownerCard: null })], null)).toBe('');
  });

  it('re-derives its standing through the same filter', () => {
    const read = queue([dispatched]);
    expect(evidenceDecisionStanding(read, null, dispatched, SESSION_ID).state).toBe('DECIDABLE');
    expect(evidenceDecisionStanding(read, null, dispatched, DISPATCHER_ID).state).toBe('ALREADY_DECIDED');
  });

  it('a press decides as the session the card names, which is not the run it is drawn in', async () => {
    expect(evidenceDecidingSession(inTheRun, SESSION_ID)).toBe(DISPATCHER_ID);
    expect(evidenceDecidingSession(dispatched, SESSION_ID)).toBe(SESSION_ID);
    expect(evidenceDecidingSession(row(), SESSION_ID)).toBe(SESSION_ID);

    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([inTheRun]));
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt({ taskId: inTheRun.taskId }) : queue([])) as never);
    const rendered = await mount(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={null} onSendBack={() => {}} />
      </QueryClientProvider>,
    );
    await click(press(rendered, DECISION_CONFIRM_ACTION));
    await settle();
    const posts = apiMock.mock.calls.filter(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posts).toEqual([
      [
        `/tasks/${inTheRun.taskId}/evidence/decision`,
        {
          method: 'POST',
          body: { decidingSessionId: DISPATCHER_ID, evidenceRevision: '2', decision: 'CONFIRM' },
        },
      ],
    ]);
    // And the read it re-derives from is still this conversation's.
    expect(
      apiMock.mock.calls.filter(([path]) =>
        String(path) === `/tasks/evidence-decisions/pending?decidingSessionId=${SESSION_ID}`),
    ).toHaveLength(1);
  });
});

describe('a press, end to end inside the browser', () => {
  it('posts straight to the door, re-reads the queue, and leaves the card saying what it recorded', async () => {
    const live = row();
    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([live]));
    // The door records it; the re-read that follows no longer lists it.
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt() : queue([])) as never);

    const rendered = await mount(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard
          sessionId={SESSION_ID}
          projectId={PROJECT_ID}
          onSendBack={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(apiMock).not.toHaveBeenCalled();
    await click(press(rendered, DECISION_CONFIRM_ACTION));
    await settle();

    const posts = apiMock.mock.calls.filter(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posts).toEqual([
      [
        `/tasks/${TASK_ID}/evidence/decision`,
        {
          method: 'POST',
          body: { decidingSessionId: SESSION_ID, evidenceRevision: '2', decision: 'CONFIRM' },
        },
      ],
    ]);
    expect(
      apiMock.mock.calls.filter(([path]) => String(path).startsWith('/tasks/evidence-decisions/pending')),
    ).toHaveLength(1);

    expect(rendered.textContent).toContain(EVIDENCE_DECISION_RECORDED_HEADING);
    expect(rendered.textContent).toContain(evidenceDecisionRecordedLine(receipt()));
    expect(rendered.querySelectorAll(`button.${CARD_ACTION_CLASS}`)).toHaveLength(0);
    expect(rendered.querySelectorAll('[data-decision-row]')).toHaveLength(1);
  });

  it('hands the send-back to the view with the row it is about, and asks the door for nothing itself', async () => {
    const live = row();
    const onSendBack = vi.fn();
    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([live]));

    const rendered = await mount(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard
          sessionId={SESSION_ID}
          projectId={PROJECT_ID}
          onSendBack={onSendBack}
        />
      </QueryClientProvider>,
    );
    await click(press(rendered, OWNER_SEND_BACK_ACTION));
    await settle();

    // The row, whole: the composer needs its address, and the bar it draws needs the title.
    expect(onSendBack.mock.calls).toEqual([[live]]);
    // Arming is not answering: nothing has gone to the door, and the card is still there to press.
    expect(apiMock).not.toHaveBeenCalled();
    expect(rendered.querySelectorAll('[data-decision-row]')).toHaveLength(1);
    expect(press(rendered, DECISION_CONFIRM_ACTION).disabled).toBe(false);
  });

  it('confirms on Enter and leaves Chat about this without a shortcut', async () => {
    const live = row();
    const onSendBack = vi.fn();
    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([live]));
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt() : queue([])) as never);

    const rendered = await mount(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard
          sessionId={SESSION_ID}
          projectId={PROJECT_ID}
          onSendBack={onSendBack}
        />
      </QueryClientProvider>,
    );

    // One card asking, so it holds the keys — and each control says which key presses it, on the
    // control itself: a shortcut nobody can see is a shortcut nobody has.
    expect(hintOn(press(rendered, DECISION_CONFIRM_ACTION))).toBe(ENTER_HINT);
    expect(hintOn(press(rendered, OWNER_SEND_BACK_ACTION))).toBeNull();

    await key({ metaKey: true });
    await key({ ctrlKey: true });
    expect(onSendBack).not.toHaveBeenCalled();
    expect(apiMock, 'the chord reached the door').not.toHaveBeenCalled();
    expect(press(rendered, DECISION_CONFIRM_ACTION).disabled).toBe(false);

    // And the bare key is the press itself: the same request the button sends, about the version
    // the card was drawn for.
    await key();
    const posts = apiMock.mock.calls.filter(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posts).toEqual([
      [
        `/tasks/${TASK_ID}/evidence/decision`,
        {
          method: 'POST',
          body: { decidingSessionId: SESSION_ID, evidenceRevision: '2', decision: 'CONFIRM' },
        },
      ],
    ]);
  });

  it('gives the keys to the higher of two versions asking at once, and decides only that one', async () => {
    // This is the one card of the four that can be on screen more than once — one per version of
    // the evidence — and one press answers one question: the keys are held by the highest card
    // asking, and its hint is the only one on screen (`CardHotkey.ts`).
    const first = row();
    const second = row({ evidenceRevision: '3', claim: 'A newer version of the same evidence.' });
    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([first, second]));
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt() : queue([second])) as never);

    const rendered = await mount(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard
          sessionId={SESSION_ID}
          projectId={PROJECT_ID}
          onSendBack={() => {}}
        />
      </QueryClientProvider>,
    );
    const cards = [...rendered.querySelectorAll<HTMLElement>('[data-decision-row]')];
    expect(cards, 'both versions were asking').toHaveLength(2);
    expect(
      cards.map((card) =>
        [...card.querySelectorAll<HTMLElement>('button.card-action')].map(hintOn).filter(Boolean)),
      'only the higher card shows a key',
    ).toEqual([[ENTER_HINT], []]);

    await key();
    const decided = apiMock.mock.calls
      .filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST')
      .map(([, options]) => (options as { body: { evidenceRevision: string } }).body.evidenceRevision);
    expect(decided, 'one press decided one version, the one drawn higher').toEqual([first.evidenceRevision]);
  });
});

describe('the provenance mark', () => {
  it('is on the card in every standing, and says no agent wrote the card or relays its press', () => {
    const live = row();
    for (const standing of [
      evidenceDecisionStanding(queue([live]), PROJECT_ID, live),
      evidenceDecisionStanding(queue([row({ evidenceRevision: '3' })]), PROJECT_ID, live),
      evidenceDecisionStanding(queue([]), PROJECT_ID, live),
      evidenceDecisionStanding(null, PROJECT_ID, live),
    ]) {
      const html = card(standing);
      const mark = /<span class="criteria-provenance" title="([^"]*)">([^<]*)<\/span>/u.exec(html);
      expect(mark, standing.state).not.toBeNull();
      expect(mark![2], standing.state).toBe(PROVENANCE_LABEL);
      expect(mark![1], standing.state).toContain('agent');
      expect(mark![1], standing.state).toContain('decision door');
    }
  });
});

describe('where the card is mounted', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const workspaceView = (): string => {
    const found = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    if (!found) throw new Error(`WorkspaceView.tsx is not under ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('is mounted once, in the conversation beside the criteria card, keyed by the session whose addresses it keeps', () => {
    // Read as text, as `WorkspaceView.decisionStrip.test.tsx` reads the strip's mount: the view
    // needs a router, a live session and a runner before it renders at all.
    const source = workspaceView();
    const at = source.indexOf('<SessionEvidenceDecisionCard');
    expect(at, 'the card is not mounted at all').toBeGreaterThan(-1);
    expect(source.split('<SessionEvidenceDecisionCard').length - 1).toBe(1);
    // In the scrolling conversation, after the criteria card it sits beside.
    expect(at).toBeGreaterThan(source.indexOf('<div className="workspace-scroll-wrap">'));
    expect(at).toBeGreaterThan(source.indexOf('<SessionCriteriaDecisionCard'));
    // The view outlives navigation between sessions, so without the key one conversation's
    // remembered addresses would be drawn as stale cards in the next one opened. Not the bare
    // session id, which is the criteria card's key: see WorkspaceView.criteriaDecisionCard.test.tsx.
    const element = source.slice(at, source.indexOf('/>', at));
    expect(element).toContain('key={`evidence:${selectedId}`}');
    expect(element).toContain('sessionId={selectedId}');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   A version waiting for the coordinator
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The versions a paused coordinator is owed (`waitingOnCoordinator`) and the ones handed to it since
 * (`sentToCoordinator`): folded while one waits, opened in place into the card above by Decide it
 * myself, one line once it is sent. What the folded card says about the pause is read off the
 * coordinator conversation's own row — its run state, its error, its armed retry — as the page hands
 * it over, and the words are the project's (its instructions' copy section), pinned literally here.
 */
const QUEUED_TASK_ID = '3kurFew9WWOLA9F0fp8dtZ';
const LATER_TASK_ID = 'OzUP5aliVUIv4unAopIJ5';
const SUBMITTED_AT = '2026-10-09T11:59:30.000Z';
const RESETS_AT = '2026-10-12T11:00:00.000Z';
const RETRIES_AT = '2026-10-09T12:02:30.000Z';
const NOW = new Date('2026-10-09T12:02:00.000Z');
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)";

function queuedRow(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return row({
    taskId: QUEUED_TASK_ID,
    title: 'Queue cards for the coordinator',
    submittedAt: SUBMITTED_AT,
    ...over,
  });
}

function sentRow(over: Partial<SentToCoordinatorRow> = {}): SentToCoordinatorRow {
  return {
    taskId: QUEUED_TASK_ID,
    title: 'Queue cards for the coordinator',
    projectId: PROJECT_ID,
    evidenceRevision: '2',
    deliveredAt: '2026-10-09T12:05:00.000Z',
    ...over,
  };
}

/** The read a coordinator conversation gets while its coordinator is paused. */
function coordinatorQueue(over: Partial<PendingDecisionQueue> = {}): PendingDecisionQueue {
  return { ...queue([]), waitingOnCoordinator: [queuedRow()], sentToCoordinator: [], ...over };
}

/** The coordinator conversation as the page holds it: FAILED on Claude's weekly limit, with the
 *  retry armed for the reset — the evening of 2026-10-09 the project was filed for. */
function coordinator(over: SessionStateSource = {}): SessionStateSource {
  return { runState: 'FAILED', lifecycleState: 'OPEN', error: WEEKLY_LIMIT, retryAt: RESETS_AT, ...over };
}

function coordinatorCards(
  read: PendingDecisionQueue,
  session: SessionStateSource | null = coordinator(),
  projectId: string | null = PROJECT_ID,
): string {
  const qc = newClient();
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, read);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionEvidenceDecisionCard
        sessionId={SESSION_ID}
        projectId={projectId}
        coordinator={session}
        onSendBack={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function mountCoordinatorCards(
  read: PendingDecisionQueue,
  onSendBack: (row: PendingDecisionRow) => void = () => {},
): Promise<{ qc: QueryClient; rendered: HTMLElement }> {
  const qc = newClient();
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, read);
  const rendered = await mount(
    <QueryClientProvider client={qc}>
      <SessionEvidenceDecisionCard
        sessionId={SESSION_ID}
        projectId={PROJECT_ID}
        coordinator={coordinator()}
        onSendBack={onSendBack}
      />
    </QueryClientProvider>,
  );
  return { qc, rendered };
}

/** The next read, as a poll would bring it. */
async function reread(qc: QueryClient, read: PendingDecisionQueue): Promise<void> {
  await act(async () => {
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, read);
  });
  await settle();
}

/** What each slot of the conversation is drawn as, in order: folded, one line, or a card. */
function slots(scope: HTMLElement): string[] {
  return [...scope.children].map((node) => {
    const element = node as HTMLElement;
    if (element.dataset.queuedRow) return `waiting ${element.dataset.queuedRow}`;
    if (element.dataset.sentRow) return `sent ${element.dataset.sentRow}`;
    return `card ${element.dataset.decisionRow ?? '?'}`;
  });
}

function posts(): unknown[] {
  return apiMock.mock.calls.filter(
    ([, options]) => (options as { method?: string } | undefined)?.method === 'POST',
  );
}

describe('a version waiting for the coordinator: why it waits', () => {
  const at = (iso: string): string => decisionReceiptTime(iso, NOW);
  const cases: Array<[string, SessionStateSource, string]> = [
    ['a weekly limit, with the reset it armed a retry for', coordinator(),
      `Coordinator paused · weekly limit · resets ${at(RESETS_AT)}`],
    ['a 5-hour limit, with its reset',
      coordinator({ error: "You've hit your session limit · resets 6:20pm (Europe/Berlin)" }),
      `Coordinator paused · 5-hour limit · resets ${at(RESETS_AT)}`],
    ['a weekly limit with no retry armed', coordinator({ retryAt: null }),
      'Coordinator paused · weekly limit'],
    ['a usage limit that names no window, with no retry armed',
      coordinator({
        error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase "
          + 'more credits or try again at Aug 9th, 2026 1:26 PM.',
        retryAt: null,
      }),
      'Coordinator paused · usage limit'],
    ['a provider error it will retry',
      coordinator({
        error: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
        retryAt: RETRIES_AT,
      }),
      `Coordinator paused · retries ${at(RETRIES_AT)}`],
    ['a runner that went away, with nothing armed', coordinator({ error: 'runner offline', retryAt: null }),
      'Coordinator paused'],
    ['a limit parked waiting for input, with its retry armed',
      coordinator({ runState: 'AWAITING_INPUT', error: null }),
      `Coordinator paused · retries ${at(RESETS_AT)}`],
    // The transcript's own judgment: a reply that only QUOTES the limit is not one.
    ['a failure that only quotes a limit',
      coordinator({ error: `The earlier run stopped on this line from the runtime: ${WEEKLY_LIMIT}`, retryAt: null }),
      'Coordinator paused'],
    ['back, and running', coordinator({ runState: 'RUNNING', error: null, retryAt: null }),
      'Coordinator is back · it gets this when its current turn ends'],
    ['back, and waiting for its reader', coordinator({ runState: 'AWAITING_INPUT', error: null, retryAt: null }),
      'Coordinator is back · it gets this when its current turn ends'],
  ];

  it.each(cases)('%s', (_name, session, line) => {
    expect(coordinatorPauseLine(coordinatorPause(session), NOW)).toBe(line);
  });

  it('is said on the folded card, amber while the coordinator is paused and quiet once it is back', () => {
    for (const [name, session] of cases) {
      const html = coordinatorCards(coordinatorQueue(), session);
      expect(html, name).toContain(escaped(coordinatorPauseLine(coordinatorPause(session))));
      expect(html.includes('evidence-queued-pause is-paused'), name)
        .toBe(coordinatorPause(session).state === 'PAUSED');
    }
  });

  it('is paused for a reason nobody knows when there is no conversation to read', () => {
    expect(coordinatorPauseLine(coordinatorPause(null), NOW)).toBe('Coordinator paused');
  });
});

describe('a version waiting for the coordinator, folded', () => {
  it('says what waits and when it came, the task, why it waits, and that the reader may still decide — in that order', () => {
    const html = coordinatorCards(coordinatorQueue());
    const order = [
      EVIDENCE_DECISION_QUEUED_HEADING,
      decisionReceiptTime(SUBMITTED_AT),
      'Queue cards for the coordinator',
      coordinatorPauseLine(coordinatorPause(coordinator())),
      EVIDENCE_DECISION_QUEUED_NOTE,
      DECISION_DECIDE_MYSELF_ACTION,
    ].map((text) => html.indexOf(escaped(text)));
    expect(order.every((index) => index >= 0), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The time is the heading line's right-hand end, not a line of its own.
    const head = /<div class="approval-head evidence-queued-head">([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? '';
    expect(head).toContain(`>${EVIDENCE_DECISION_QUEUED_HEADING}<`);
    expect(head).toContain(`<span class="evidence-queued-time">${escaped(decisionReceiptTime(SUBMITTED_AT))}</span>`);
  });

  it('uses the project’s own words, each declared where the native clients read the card’s copy', () => {
    expect(EVIDENCE_DECISION_QUEUED_HEADING).toBe('Waiting for the coordinator');
    expect(EVIDENCE_DECISION_QUEUED_NOTE).toBe('It goes to the coordinator when it’s back. You can still decide now.');
    expect(DECISION_DECIDE_MYSELF_ACTION).toBe('Decide it myself');
    expect(EVIDENCE_DECISION_QUEUED_OPEN_NOTE)
      .toBe('It gets this when it’s back. Decide here only if you don’t want to wait.');
    expect(EVIDENCE_DECISION_COORDINATOR_BACK).toBe('Coordinator is back · it gets this when its current turn ends');
    expect(sentToCoordinatorLine(sentRow().deliveredAt, NOW))
      .toBe(`Sent to the coordinator · ${decisionReceiptTime(sentRow().deliveredAt, NOW)}`);

    // `NAME = '…'` once a wrapped value is pulled up onto its line: the shape the Swift copy parity
    // tests read this card's constants in (`EvidenceDecisionCopyParityTests.flatWebCard`).
    const flat = cardSource()
      .replace(/['`]\s*\+\s*['`]/gu, '')
      .replace(/=\s*\n\s*'/gu, "= '");
    for (const [name, value] of [
      ['EVIDENCE_DECISION_QUEUED_HEADING', 'Waiting for the coordinator'],
      ['EVIDENCE_DECISION_QUEUED_NOTE', 'It goes to the coordinator when it’s back. You can still decide now.'],
      ['DECISION_DECIDE_MYSELF_ACTION', 'Decide it myself'],
      ['EVIDENCE_DECISION_QUEUED_OPEN_NOTE', 'It gets this when it’s back. Decide here only if you don’t want to wait.'],
      ['EVIDENCE_DECISION_COORDINATOR_PAUSED', 'Coordinator paused'],
      ['EVIDENCE_DECISION_COORDINATOR_BACK', 'Coordinator is back · it gets this when its current turn ends'],
      ['DECISION_PAUSE_FIVE_HOUR_LIMIT', '5-hour limit'],
      ['DECISION_PAUSE_WEEKLY_LIMIT', 'weekly limit'],
      ['DECISION_PAUSE_USAGE_LIMIT', 'usage limit'],
      ['EVIDENCE_DECISION_SENT_TO_COORDINATOR', 'Sent to the coordinator'],
    ]) {
      expect(flat).toContain(`export const ${name} = '${value}';`);
    }
  });

  it('is grey, asks nothing, carries no address the pinned strip could point at, and holds no key', () => {
    const html = coordinatorCards(coordinatorQueue());
    expect(html).toContain('class="approval-card evidence-queued"');
    expect(html).not.toContain('approval-card decision-ask evidence-decision');
    expect(html).not.toContain('data-decision-row');
    expect(html).not.toContain('approval-kbd');
    // Its one control opens it; neither verdict is on it while it is folded.
    expect(buttons(html).map((button) => button.text)).toEqual([DECISION_DECIDE_MYSELF_ACTION]);
  });

  it('is drawn for this project’s versions only, and in a conversation that coordinates one', () => {
    const elsewhere = coordinatorQueue({
      waitingOnCoordinator: [queuedRow({ projectId: OTHER_PROJECT_ID })],
      sentToCoordinator: [sentRow({ projectId: OTHER_PROJECT_ID })],
    });
    expect(coordinatorCards(elsewhere)).toBe('');
    expect(coordinatorCards(coordinatorQueue({ sentToCoordinator: [sentRow()] }), coordinator(), null)).toBe('');
  });
});

describe('Decide it myself', () => {
  it('opens the folded card in place into today’s card, saying why it waits and what deciding here means', async () => {
    const { rendered } = await mountCoordinatorCards(coordinatorQueue());
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));

    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`]);
    const card = rendered.firstElementChild as HTMLElement;
    expect(card.querySelector('.evidence-decision-heading')?.textContent).toBe(DECISION_ASK_HEADING);
    // The pause line first, then what deciding here means — then the card as it always reads.
    const notice = card.querySelector<HTMLElement>('.evidence-queued-notice');
    expect(notice?.textContent)
      .toBe(`${coordinatorPauseLine(coordinatorPause(coordinator()))}${EVIDENCE_DECISION_QUEUED_OPEN_NOTE}`);
    expect(card.querySelector('.decision-ask-standard-text')?.textContent).toBe(queuedRow().criterion!.text);
    expect(press(card, DECISION_CONFIRM_ACTION).disabled).toBe(false);
    expect(press(card, OWNER_SEND_BACK_ACTION).disabled).toBe(false);
    // Nobody is being asked it yet, so it takes no key: its buttons are its only presses.
    expect(hintOn(press(card, DECISION_CONFIRM_ACTION))).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('confirms through the decision door from this conversation, as today’s card does', async () => {
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST'
        ? receipt({ taskId: QUEUED_TASK_ID })
        : coordinatorQueue({ waitingOnCoordinator: [] })) as never);
    const { rendered } = await mountCoordinatorCards(coordinatorQueue());
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));
    await click(press(rendered, DECISION_CONFIRM_ACTION));
    await settle();

    // The same row, the same deciding session — the coordinator conversation it is drawn in.
    expect(posts()).toEqual([
      [
        `/tasks/${QUEUED_TASK_ID}/evidence/decision`,
        {
          method: 'POST',
          body: { decidingSessionId: SESSION_ID, evidenceRevision: '2', decision: 'CONFIRM' },
        },
      ],
    ]);
    expect(
      apiMock.mock.calls.filter(([path]) => String(path).startsWith('/tasks/evidence-decisions/pending')),
    ).toHaveLength(1);
    expect(rendered.textContent).toContain(evidenceDecisionRecordedLine(receipt({ taskId: QUEUED_TASK_ID })));
    // Decided here, it no longer goes to the coordinator, and the card stops saying it will.
    expect(rendered.querySelector('.evidence-queued-notice')).toBeNull();
  });

  it('hands Chat about this to the composer with the row, and asks the door for nothing itself', async () => {
    const onSendBack = vi.fn();
    const { rendered } = await mountCoordinatorCards(coordinatorQueue(), onSendBack);
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));
    await click(press(rendered, OWNER_SEND_BACK_ACTION));
    await settle();

    expect(onSendBack.mock.calls).toEqual([[queuedRow()]]);
    expect(apiMock).not.toHaveBeenCalled();
    expect(press(rendered, DECISION_CONFIRM_ACTION).disabled).toBe(false);
  });

  it('leaves the keys to a question below it', async () => {
    const asked = row({ evidenceRevision: '5', title: 'Asked of the owner' });
    apiMock.mockImplementation((async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? receipt({ evidenceRevision: '5' }) : coordinatorQueue()) as never);
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue());
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));
    // A question arrives under the opened card: drawn lower, it is still the one the keys answer.
    await reread(qc, coordinatorQueue({ pending: [asked] }));

    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`, `card ${TASK_ID}@5`]);
    const cards = [...rendered.querySelectorAll<HTMLElement>('[data-decision-row]')];
    expect(cards.map((card) =>
      [...card.querySelectorAll<HTMLElement>('button.card-action')].map(hintOn).filter(Boolean)))
      .toEqual([[], [ENTER_HINT]]);
    await key();
    expect(posts().map(([path]) => path)).toEqual([`/tasks/${TASK_ID}/evidence/decision`]);
  });
});

describe('handed to the coordinator', () => {
  it('is one line saying when, with nothing to press', () => {
    const html = coordinatorCards(coordinatorQueue({ waitingOnCoordinator: [], sentToCoordinator: [sentRow()] }));
    expect(html).toContain(escaped(sentToCoordinatorLine(sentRow().deliveredAt)));
    expect(html).toContain(`data-sent-row="${QUEUED_TASK_ID}@2"`);
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain('data-decision-row');
    expect(html).not.toContain('evidence-queued');
  });

  it('takes the place its folded card had', async () => {
    const later = queuedRow({ taskId: LATER_TASK_ID, title: 'Send waited revisions' });
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue({ waitingOnCoordinator: [queuedRow(), later] }));
    expect(slots(rendered)).toEqual([`waiting ${QUEUED_TASK_ID}@2`, `waiting ${LATER_TASK_ID}@2`]);

    // The second one goes first: a fresh read would list the line ahead of the card still waiting,
    // and the conversation keeps each where it was.
    await reread(qc, coordinatorQueue({
      waitingOnCoordinator: [queuedRow()],
      sentToCoordinator: [sentRow({ taskId: LATER_TASK_ID, title: later.title })],
    }));
    expect(slots(rendered)).toEqual([`waiting ${QUEUED_TASK_ID}@2`, `sent ${LATER_TASK_ID}@2`]);

    // And a card the reader opened collapses to its line just the same once it is handed over.
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));
    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`, `sent ${LATER_TASK_ID}@2`]);
    await reread(qc, coordinatorQueue({
      waitingOnCoordinator: [],
      sentToCoordinator: [sentRow(), sentRow({ taskId: LATER_TASK_ID, title: later.title })],
    }));
    expect(slots(rendered)).toEqual([`sent ${QUEUED_TASK_ID}@2`, `sent ${LATER_TASK_ID}@2`]);
  });
});

describe('a version moving between the coordinator and its owner', () => {
  it('leaves nothing behind when it only ever waited and a later revision replaced it', async () => {
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue());
    await reread(qc, coordinatorQueue({ waitingOnCoordinator: [queuedRow({ evidenceRevision: '3' })] }));
    expect(slots(rendered)).toEqual([`waiting ${QUEUED_TASK_ID}@3`]);
    expect(rendered.textContent).not.toContain(EVIDENCE_DECISION_STALE_HEADING);
  });

  it('says an opened one was superseded, by the version waiting in its place', async () => {
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue());
    await click(press(rendered, DECISION_DECIDE_MYSELF_ACTION));
    await reread(qc, coordinatorQueue({ waitingOnCoordinator: [queuedRow({ evidenceRevision: '3' })] }));

    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`, `waiting ${QUEUED_TASK_ID}@3`]);
    const stale = rendered.firstElementChild as HTMLElement;
    expect(stale.textContent).toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(stale.textContent).toContain(EVIDENCE_DECISION_SUPERSEDED);
    expect(stale.textContent).toContain('version 3');
    expect(press(stale, DECISION_CONFIRM_ACTION).disabled).toBe(true);
  });

  it('folds a question that goes back to wait for its coordinator, rather than calling it answered', async () => {
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue({
      waitingOnCoordinator: [],
      pending: [queuedRow()],
    }));
    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`]);
    await reread(qc, coordinatorQueue());
    expect(slots(rendered)).toEqual([`waiting ${QUEUED_TASK_ID}@2`]);
    expect(rendered.textContent).not.toContain(EVIDENCE_DECISION_STALE_HEADING);
  });

  it('draws one that became the owner’s question as today’s card, in the place it waited in', async () => {
    const later = queuedRow({ taskId: LATER_TASK_ID });
    const { qc, rendered } = await mountCoordinatorCards(coordinatorQueue({ waitingOnCoordinator: [queuedRow(), later] }));
    await reread(qc, coordinatorQueue({ waitingOnCoordinator: [later], pending: [queuedRow()] }));

    expect(slots(rendered)).toEqual([`card ${QUEUED_TASK_ID}@2`, `waiting ${LATER_TASK_ID}@2`]);
    const card = rendered.firstElementChild as HTMLElement;
    expect(card.querySelector('.evidence-queued-notice')).toBeNull();
    expect(hintOn(press(card, DECISION_CONFIRM_ACTION))).toBe(ENTER_HINT);
  });
});

describe('with nothing waiting for the coordinator', () => {
  it('draws what it drew before the queue existed, whatever the read and the conversation say', () => {
    const rows = [row(), row({ taskId: 'task-two', evidenceRevision: '4' })];
    const before = sessionCards(rows);
    expect(roots(before)).toEqual([`${TASK_ID}@2`, 'task-two@4']);
    for (const session of [null, coordinator(), coordinator({ runState: 'RUNNING', error: null, retryAt: null })]) {
      expect(coordinatorCards({ ...queue(rows), waitingOnCoordinator: [], sentToCoordinator: [] }, session))
        .toBe(before);
      expect(coordinatorCards(queue(rows), session)).toBe(before);
    }
    expect(before).not.toContain('evidence-queued');
    expect(before).not.toContain('evidence-sent');
  });
});

/** This card's source, for the declarations the native clients read. */
function cardSource(): string {
  const found = ['src/components/EvidenceDecisionCard.tsx', 'src/web/src/components/EvidenceDecisionCard.tsx']
    .map((each) => resolve(process.cwd(), each))
    .find(existsSync);
  if (!found) throw new Error(`EvidenceDecisionCard.tsx is not under ${process.cwd()}`);
  return readFileSync(found, 'utf8');
}

/**
 * The read as the server sends it to a coordinator conversation: the evidence queue of the fixture
 * every client reads (`src/shared/src/interaction-cards.fixture.json`) — one question, one version
 * waiting for the coordinator, one handed to it.
 */
describe('the shared fixture’s evidence queue', () => {
  const fixture = sharedFixture();
  const read = fixture.snapshot.standing.evidenceDecisions as PendingDecisionQueue;
  const asked = read.pending[0]!;
  const waiting = read.waitingOnCoordinator![0]!;
  const sent = read.sentToCoordinator![0]!;

  it('draws the question as its card, the waiting version folded, and the sent one as its line', () => {
    const qc = newClient();
    qc.setQueryData(pendingDecisionsQuery(fixture.sessionId).queryKey, read);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SessionEvidenceDecisionCard
          sessionId={fixture.sessionId}
          projectId={fixture.projectId}
          coordinator={coordinator()}
          onSendBack={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(roots(html)).toEqual([decisionRowKey(asked)]);
    expect(html).toContain(`data-queued-row="${decisionRowKey(waiting)}"`);
    expect(html).toContain(escaped(waiting.title));
    expect(html).toContain(escaped(decisionReceiptTime(waiting.submittedAt!)));
    expect(html).toContain(`data-sent-row="${decisionRowKey(sent)}"`);
    expect(html).toContain(escaped(sentToCoordinatorLine(sent.deliveredAt)));
    // The question first, then the version handed over, then the one still waiting.
    const at = (needle: string): number => html.indexOf(needle);
    expect(at(`data-decision-row="${decisionRowKey(asked)}"`)).toBeLessThan(at('data-sent-row='));
    expect(at('data-sent-row=')).toBeLessThan(at('data-queued-row='));
  });

  it('puts the one question on the pinned line, and neither of the others', () => {
    const cards = new Set(
      evidenceDecisionCardRows(read, fixture.projectId, fixture.sessionId).map(decisionRowKey),
    );
    const html = renderToStaticMarkup(
      <DecisionStrip
        queue={read}
        open={false}
        hasCard={(row) => cards.has(decisionRowKey(row))}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain(`aria-label="${needsDecisionCount(1)}: ${escaped(asked.title)}"`);
    expect(html).not.toContain(escaped(waiting.title));
    expect(html).not.toContain(escaped(sent.title));
  });
});

/** The fixture every client reads the server's interaction cards from. */
function sharedFixture(): {
  sessionId: string;
  projectId: string;
  snapshot: { standing: { evidenceDecisions: unknown } };
} {
  const found = [
    resolve(process.cwd(), '../shared/src/interaction-cards.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/interaction-cards.fixture.json'),
  ].find(existsSync);
  if (!found) throw new Error(`interaction-cards.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(found, 'utf8'));
}
