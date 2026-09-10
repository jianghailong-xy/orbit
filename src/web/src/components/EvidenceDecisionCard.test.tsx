// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingDecisionsQuery } from '../lib/queries';
import { CARD_ACTION_CLASS } from './CardAction';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import {
  decisionRowKey,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import {
  DECISION_ASK_HEADING,
  DECISION_CONFIRM_ACTION,
  DECISION_NO_CRITERION,
  DECISION_NO_GAPS,
  DECISION_SEND_ACTION,
  DECISION_SEND_BACK_ACTION,
  EVIDENCE_DECISION_ALREADY_DECIDED,
  EVIDENCE_DECISION_RECORDED_HEADING,
  EVIDENCE_DECISION_STALE_HEADING,
  EVIDENCE_DECISION_SUPERSEDED,
  EVIDENCE_DECISION_UNREAD_HEADING,
  EvidenceDecisionCard,
  SessionEvidenceDecisionCard,
  decisionGapsMore,
  evidenceDecisionRecordedLine,
  evidenceDecisionRefusal,
  evidenceDecisionRequest,
  evidenceDecisionStanding,
  sendEvidenceDecision,
  type EvidenceDecisionResult,
  type EvidenceDecisionStanding,
} from './EvidenceDecisionCard';

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
 * for the two things a static render cannot do: type a reason into the box before `退回` is asked
 * about, and press a button all the way through to the (mocked) `api()` call and the re-read after
 * it. `renderToStaticMarkup` writes `&` as `&amp;`, so every text assertion goes through
 * `escaped()` — the fixture's claim carries an ampersand and its title angle brackets to keep that
 * honest.
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
    <EvidenceDecisionCard standing={standing} onDecide={() => {}} {...over} />,
  );
}

/** Every rendered button, as its opening tag and its text. Labels are matched exactly: `退回` is a
 *  prefix of `退回重做`, so nothing here may match loosely. */
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

/** The wired cards over a read that has already come back. */
function sessionCards(rows: PendingDecisionRow[], projectId: string | null = PROJECT_ID): string {
  const qc = newClient();
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue(rows));
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={projectId} />
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

function action(scope: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').replace(/[▾▴]/gu, '') === label,
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

/** Typing, the way a controlled React field hears it. */
async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('a send-back needs its reason', () => {
  it('keeps 退回 disabled while the reason box is empty or blank, and sends the reason once it is not', async () => {
    const onDecide = vi.fn();
    const live = row();
    const rendered = await mount(
      <EvidenceDecisionCard
        standing={evidenceDecisionStanding(queue([live]), PROJECT_ID, live)}
        onDecide={onDecide}
      />,
    );

    // Nothing to press before the reason box exists.
    expect(action(rendered, DECISION_SEND_ACTION)).toBeUndefined();
    await click(press(rendered, DECISION_SEND_BACK_ACTION));
    expect(press(rendered, DECISION_SEND_ACTION).disabled).toBe(true);

    const field = rendered.querySelector<HTMLTextAreaElement>('textarea.decision-ask-note');
    expect(field).not.toBeNull();
    await type(field!, '   ');
    expect(press(rendered, DECISION_SEND_ACTION).disabled).toBe(true);
    await click(press(rendered, DECISION_SEND_ACTION));
    expect(onDecide).not.toHaveBeenCalled();

    // The lit twin of the two assertions above, in the same card.
    await type(field!, '把 pg spec 跑一遍');
    expect(press(rendered, DECISION_SEND_ACTION).disabled).toBe(false);
    await click(press(rendered, DECISION_SEND_ACTION));
    expect(onDecide.mock.calls).toEqual([['SEND_BACK', '把 pg spec 跑一遍']]);
  });
});

describe('where a card stands, and what it lets a reader press', () => {
  const live = row();

  it('DECIDABLE: both verdicts can be pressed, and there is nothing to explain', () => {
    const standing = evidenceDecisionStanding(queue([live]), PROJECT_ID, live);
    expect(standing.state).toBe('DECIDABLE');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(false);
    expect(isDisabled(html, DECISION_SEND_BACK_ACTION)).toBe(false);
    expect(html).toContain(DECISION_ASK_HEADING);
    expect(html).not.toContain('evidence-decision-stale');
  });

  it('ALREADY_DECIDED: the version has left the read, so nothing can be pressed and the refusal is named', () => {
    const standing = evidenceDecisionStanding(queue([]), PROJECT_ID, live);
    expect(standing.state).toBe('ALREADY_DECIDED');

    const html = card(standing);
    expect(isDisabled(html, DECISION_CONFIRM_ACTION)).toBe(true);
    expect(isDisabled(html, DECISION_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(html).toContain('已经答过');
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
    expect(isDisabled(html, DECISION_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_STALE_HEADING);
    expect(html).toContain('被顶掉');
    expect(html).toContain('第 3 版');
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
    expect(isDisabled(html, DECISION_SEND_BACK_ACTION)).toBe(true);
    expect(html).toContain(EVIDENCE_DECISION_UNREAD_HEADING);
    expect(html).toContain('没能读回来');
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
      expect(html, code).toContain('这张卡已过期');
      expect(html, code).toContain(escaped(evidenceDecisionRefusal(refused(code, message)).title));
      expect(html, code).toContain(escaped(message));
    }
  });

  it('says only that it was not recorded for any other refusal', () => {
    const html = card(standing, { error: refused(undefined, 'decidingSessionId is invalid') });

    expect(html).toContain('这次裁决没有记下');
    expect(html).toContain('decidingSessionId is invalid');
    expect(html).not.toContain('这张卡已过期');
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
        <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={PROJECT_ID} />
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
      expect(mark![1], standing.state).toContain('决定门');
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
    // remembered addresses would be drawn as stale cards in the next one opened.
    const element = source.slice(at, source.indexOf('/>', at));
    expect(element).toContain('key={selectedId}');
    expect(element).toContain('sessionId={selectedId}');
  });
});
