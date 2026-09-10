// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalInfo } from '../api';
import {
  ApprovalPanel,
  DECISION_CHAT_ACTION,
  DECISION_FULL_LABEL,
  evidenceDecisionRows,
} from './ApprovalPanel';
import {
  DECISION_ASK_HEADING,
  DECISION_CONFIRM_ACTION,
  DECISION_SEND_ACTION,
  DECISION_SEND_BACK_ACTION,
  decisionGapsMore,
} from './EvidenceDecisionCard';
import {
  CONFIRM_LABEL,
  SEND_BACK_LABEL,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * The completion decision, rendered from the ROW rather than from the string it was flattened into.
 *
 * The whole file turns on one fixture decision: the question text the approval carries says
 * something ELSE. `coordinator-evidence-ask.ts` composes the real body out of the same fields the
 * row has, so a card reading the string and a card reading the row would render identically and no
 * test could tell them apart. Here the body is a decoy — the claim, the criterion and the gaps in
 * it are the word DECOY — and every assertion below is that the card says what the ROW says. Point
 * the render back at `question` and the decoy is what appears on screen, which is the negative
 * control acceptance §1 asks for.
 *
 * The other half is that this is ONE special case, not the first of many: the last describe block
 * renders questions that are ordinary AskUserQuestions and asserts they are still the option-list
 * form with a Submit under it, including the two near misses — a question naming a pending row but
 * offering other options, and one offering these options about no row this session may decide.
 */

const TASK_ID = '34LMiluvx0jK63cj8arWl';
const CRITERION_KEY = '6KG2mjp63PrtVvGwxRLvFY';
const APPROVAL_ID = 'approval-decision-1';

/** Five, because the card shows three and counts the rest. */
const GAPS = [
  '「句子说清楚了没有」是人读的判断，本次证据不能替它作答。',
  '那条普查 spec 的绿本身不证明注释正确——它只保证没有把 0229 删掉的名字写进活代码行。',
  '没有跑 pg spec，也没有跑 full-api 整轮，跑的是中间档。',
  '改动停在任务分支，尚未落 main；合并归 coordinator。',
  '顺手发现但按范围没在本任务里改的那条文档，已另开任务记着。',
];

const CLAIM = '把 update() 的头注释改成同时说清两件事：带 acting session 时整条请求被拒，不带时 dto.status 原样写入。';

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_ID,
    title: "删掉 update() 头注释里的 the evaluator's acceptance projection",
    criterion: {
      key: CRITERION_KEY,
      text: '提交一条完成证据后，该任务所属项目的 coordinator 会话的 inbox 里会多出一个 turn。',
    },
    evidenceRevision: '1',
    ageSeconds: 15 * 60,
    claim: CLAIM,
    gaps: GAPS,
    citations: [
      { kind: 'TOOL_CALL', ref: 'toolu_held', resolved: true, reason: null, label: 'Bash · git diff' },
      {
        kind: 'TOOL_CALL',
        ref: 'toolu_missing',
        resolved: false,
        reason: 'no tool call with that id under this task',
        label: null,
      },
    ],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

/** The word that appears on screen if anything is read out of the question text. */
const DECOY = 'DECOY-这段是从字符串里读来的';

/**
 * The tool input, shaped exactly as `buildEvidenceQuestion` shapes it — same two option labels,
 * same trailing identity line, which is the only part of it the card is allowed to read.
 */
function questionBody(r: PendingDecisionRow): string {
  return (
    `${DECOY}\n\nAgainst criterion ${DECOY}: ${DECOY}\n\n`
    + `Declared gaps:\n${GAPS.map(() => `- ${DECOY}`).join('\n')}\n\n`
    + `${r.title} — task ${r.taskId}, evidence rev ${r.evidenceRevision}`
  );
}

function decisionApproval(rows: PendingDecisionRow[]): ApprovalInfo {
  return {
    id: APPROVAL_ID,
    toolName: 'AskUserQuestion',
    input: {
      questions: rows.map((r) => ({
        question: questionBody(r),
        header: 'Completion',
        options: [
          { label: CONFIRM_LABEL, description: 'This evidence settles the criterion it quotes.' },
          { label: SEND_BACK_LABEL, description: 'It does not settle it.' },
        ],
        multiSelect: false,
      })),
    },
  } as ApprovalInfo;
}

function queue(rows: PendingDecisionRow[]): PendingDecisionQueue {
  return {
    decidingSessionId: 'coordinator-session',
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    pending: rows,
    waitingOnYou: [],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
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

/** Rendered with everything the real page hands it. */
async function card(
  over: Partial<PendingDecisionRow> = {},
  onDecide: (...args: unknown[]) => void = () => {},
  onChatAbout?: (id: string, question: string) => void,
): Promise<HTMLElement> {
  const r = row(over);
  return mount(
    <ApprovalPanel
      approval={decisionApproval([r])}
      decisions={queue([r])}
      onDecide={onDecide as never}
      onChatAbout={onChatAbout}
    />,
  );
}

/** A button by its exact label, less the caret a disclosure draws — `退回` and `退回重做` differ by
 *  a substring, so nothing here matches loosely. */
function action(scope: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').replace(/[▾▴]/g, '') === label,
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

describe('the decision card is built from the pending row', () => {
  it('renders the row’s gaps as their own nodes and counts the ones it did not show', async () => {
    const shown = (await card()).querySelectorAll('.decision-ask-gaps-list > li');

    expect([...shown].map((item) => item.textContent)).toEqual(GAPS.slice(0, 3));
    expect((await card()).textContent).toContain(decisionGapsMore(2));
  });

  it('leads with the row’s claim and names the row’s criterion', async () => {
    const rendered = await card();

    expect(rendered.querySelector('.decision-ask-claim')?.textContent).toContain(CLAIM.slice(0, 40));
    expect(rendered.textContent).toContain(CRITERION_KEY);
    expect(rendered.textContent).toContain(TASK_ID);
    expect(rendered.textContent).toContain(DECISION_ASK_HEADING);
  });

  it('says nothing the question text says — the string is not the source', async () => {
    // The negative control for the whole file: this body's claim, criterion and gaps are all the
    // decoy. Read the row and none of it can appear; read `question` and all of it does.
    expect((await card()).textContent).not.toContain(DECOY);
  });

  it('keeps the full text one press away instead of dropping it', async () => {
    const rendered = await card();
    await click(press(rendered, DECISION_FULL_LABEL));

    // Opened, the fold shows the tool's own string verbatim — which is exactly where the decoy is.
    expect(rendered.querySelector('.decision-ask-full-body')?.textContent).toContain(DECOY);
  });

  it('counts the machine checks off the row’s own fields', async () => {
    // One citation of two resolved, so one of the three checks did not hold. Both numbers are read
    // off `citations`, which is the field acceptance §1 names.
    const rendered = await card();
    expect(rendered.textContent).toContain('2 项机器已核 · 1 项没过');

    // Folded to a line, and the line opens onto the three statements it counted — each one a field
    // of the row, none of them a sentence about it.
    await click(press(rendered, '2 项机器已核 · 1 项没过'));
    const checks = [...rendered.querySelectorAll('.decision-ask-check-list > li')];
    expect(checks).toHaveLength(3);
    expect(checks[1].textContent).toContain('1/2 条引用解析成功');
    expect(checks[1].textContent).toContain('no tool call with that id under this task');
    expect(checks[0].textContent).toContain(row().criterion!.text);
    expect(checks[2].textContent).toContain('裁决人独立于这次提交');
  });

  it('folds a long claim and gives back all of it on request', async () => {
    const tail = '这句话在折叠时看不到';
    const long = `${CLAIM}${'补充说明。'.repeat(40)}${tail}`;
    const rendered = await card({ claim: long });

    expect(rendered.querySelector('.decision-ask-claim')?.textContent).not.toContain(tail);
    await click(press(rendered, '展开全文'));
    expect(rendered.querySelector('.decision-ask-claim')?.textContent).toContain(tail);
  });

  it('says so when a revision carries no claim at all, rather than rendering a blank', async () => {
    expect((await card({ claim: '' })).textContent).toContain('这一版证据没有写下主张');
  });
});

describe('the actions are a verdict, not a form', () => {
  const body = questionBody(row());

  it('confirms on one press, with nothing selected first', async () => {
    const onDecide = vi.fn();
    const rendered = await card({}, onDecide);
    const confirm = press(rendered, DECISION_CONFIRM_ACTION);

    // Pressable straight away: the pick-then-Submit step is the thing this card removes, so a
    // primary action that needed a selection first would be the old form wearing new words.
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    expect(onDecide.mock.calls).toEqual([
      [APPROVAL_ID, 'allow', { [body]: [CONFIRM_LABEL] }],
    ]);
    // And there is no second step anywhere on the card to have skipped.
    expect(action(rendered, 'Submit')).toBeUndefined();
  });

  it('will not send a send-back until it carries a reason', async () => {
    const onDecide = vi.fn();
    const rendered = await card({}, onDecide);

    // Nothing to press before the reason box exists.
    expect(action(rendered, DECISION_SEND_ACTION)).toBeUndefined();
    await click(press(rendered, DECISION_SEND_BACK_ACTION));

    // The door refuses a SEND_BACK with no note and writes nothing, so the control that would send
    // one is not pressable. Asserted on the element's own availability, never on a CSS rule.
    expect(press(rendered, DECISION_SEND_ACTION).disabled).toBe(true);

    const field = rendered.querySelector<HTMLTextAreaElement>('textarea.decision-ask-note');
    expect(field).not.toBeNull();
    await type(field!, '把 pg spec 跑一遍，并给出改前先红的原始输出');

    expect(press(rendered, DECISION_SEND_ACTION).disabled).toBe(false);
    await click(press(rendered, DECISION_SEND_ACTION));

    // The reason rides back with the pick, in the shape the generic form has always used for a
    // typed answer beside a chosen one — `evidenceDecisionFromAnswers` reads SEND_BACK off it.
    expect(onDecide.mock.calls).toEqual([
      [
        APPROVAL_ID,
        'allow',
        { [body]: [SEND_BACK_LABEL, '把 pg spec 跑一遍，并给出改前先红的原始输出'] },
      ],
    ]);
  });

  it('offers chatting about it as the third answer, through the same path as before', async () => {
    const onChat = vi.fn();
    const rendered = await card({}, () => {}, onChat);
    await click(press(rendered, DECISION_CHAT_ACTION));

    expect(onChat.mock.calls).toEqual([[APPROVAL_ID, row().title]]);
  });

  it('holds a dead card to the same rule as every other card: no action can be pressed', async () => {
    const r = row();
    const rendered = await mount(
      <ApprovalPanel
        approval={decisionApproval([r])}
        decisions={queue([r])}
        onDecide={() => {}}
        answerable={false}
      />,
    );

    // The verdicts, and only the verdicts: the disclosures answer nothing, so reading stays
    // possible on a card whose answer would reach nobody.
    for (const button of rendered.querySelectorAll<HTMLButtonElement>('button.card-action')) {
      expect(button.disabled, `a dead card still offers: ${button.textContent}`).toBe(true);
    }
    expect(rendered.querySelectorAll('button.card-action').length).toBeGreaterThan(0);
  });

  it('holds the answers until every row on the card has one', async () => {
    // A delivery that found two waiting rows asks about both in one call, and a tool call is
    // answered once — so the first press records and the second sends both.
    const onDecide = vi.fn();
    const first = row();
    const second = row({ taskId: '34LVWtmeCNjbcCbCF2wDd', evidenceRevision: '2', claim: '第二条证据' });
    const rendered = await mount(
      <ApprovalPanel
        approval={decisionApproval([first, second])}
        decisions={queue([first, second])}
        onDecide={onDecide}
      />,
    );

    const sections = rendered.querySelectorAll<HTMLElement>('.decision-ask-q');
    expect(sections).toHaveLength(2);
    await click(press(sections[0], DECISION_CONFIRM_ACTION));
    expect(onDecide).not.toHaveBeenCalled();
    expect(sections[0].textContent).toContain(`已选「${DECISION_CONFIRM_ACTION}」`);

    await click(press(rendered.querySelectorAll<HTMLElement>('.decision-ask-q')[1], DECISION_CONFIRM_ACTION));
    expect(onDecide.mock.calls).toEqual([
      [
        APPROVAL_ID,
        'allow',
        { [questionBody(first)]: [CONFIRM_LABEL], [questionBody(second)]: [CONFIRM_LABEL] },
      ],
    ]);
  });
});

describe('every other question is still the generic form', () => {
  const plain = (over: Record<string, unknown> = {}): ApprovalInfo =>
    ({
      id: 'q1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'which one?',
            options: [{ label: 'this' }, { label: 'that' }],
            ...over,
          },
        ],
      },
    }) as ApprovalInfo;

  const generic = async (approval: ApprovalInfo): Promise<HTMLElement> =>
    mount(<ApprovalPanel approval={approval} decisions={queue([row()])} onDecide={() => {}} />);

  it('renders option rows and a Submit, even while a decision is pending in the same session', async () => {
    const rendered = await generic(plain());

    expect(rendered.querySelectorAll('.chat-q-opt-btn')).toHaveLength(2);
    expect(action(rendered, 'Submit')).toBeDefined();
    expect(rendered.querySelector('.decision-ask-q')).toBeNull();
    expect(rendered.textContent).not.toContain(DECISION_CONFIRM_ACTION);
  });

  it('is not fooled by a question that merely names the same task', async () => {
    // The coordinator asking something else about the row it is judging: same task id in the text,
    // options of its own. Recognition needs both halves.
    const rendered = await generic(
      plain({ question: `再确认一下 task ${TASK_ID}, evidence rev 1 的分支`, options: [{ label: '合' }, { label: '不合' }] }),
    );

    expect(rendered.querySelector('.decision-ask-q')).toBeNull();
    expect(action(rendered, 'Submit')).toBeDefined();
  });

  it('is not fooled by the two labels over a row this session cannot decide', async () => {
    // The options are the decision's own, but the queue has nothing this question is about — the
    // row was answered elsewhere, or belongs to another session. Nothing to render a card FROM.
    const r = row();
    const rendered = await mount(
      <ApprovalPanel approval={decisionApproval([r])} decisions={queue([])} onDecide={() => {}} />,
    );

    expect(rendered.querySelector('.decision-ask-q')).toBeNull();
    expect(action(rendered, 'Submit')).toBeDefined();
  });

  it('recognises nothing at all without the queue', async () => {
    const r = row();
    expect(evidenceDecisionRows(decisionApproval([r]), null)).toBeNull();
    expect(evidenceDecisionRows(decisionApproval([r]), queue([r]))).toEqual([r]);
    // All or nothing: one unmatched question makes the whole ask an ordinary form.
    const other = row({ taskId: '34LVWtmeCNjbcCbCF2wDd', evidenceRevision: '2' });
    expect(evidenceDecisionRows(decisionApproval([r, other]), queue([r]))).toBeNull();
  });
});
