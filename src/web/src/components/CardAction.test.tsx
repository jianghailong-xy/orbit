import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { ApprovalPanel } from './ApprovalPanel';
import { CARD_ACTIONS_CLASS, CARD_ACTION_CLASS } from './CardAction';
import {
  CONFIRM_LABEL,
  SEND_BACK_LABEL,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * The approval card and the decision card render the same button, and are held to the same rule.
 *
 * Two claims, and they are different in kind. The structural one is that neither card has its own
 * private button: the sizes were settled once, by three rounds of beta and a screenshot, and a
 * second card that redeclares them is a second card that drifts. The rendered one is that the
 * token actually reaches the markup — a shared import that both files then override in CSS would
 * satisfy a grep and fix nothing.
 *
 * WHERE THE SECOND CARD IS NOW
 * ----------------------------
 * It used to be `DecisionRail`'s: the pinned strip carried `Confirm completion` and `Send back`
 * and posted them itself. That made two decision surfaces for one fact and they raced on
 * 2026-09-09, so the rail was reduced to a counter and a pointer and the judgment moved onto the
 * `AskUserQuestion` card the coordinator raises — which is an approval card, and lives in
 * `ApprovalPanel.tsx` beside the plain one. So the two cards this file is about are both there,
 * and the third claim below is the new one: the rail declares no action, imports none, and renders
 * none, because it no longer has anything to act on.
 *
 * What is deliberately NOT asserted here is that the two cards LOOK the same or behave the same.
 * They are different objects: a plain approval is a permission prompt about a tool call; a
 * decision is a judgment about a durable row the server publishes in full. Only the affordance is
 * shared.
 */

const source = (file: string): string =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

const approval = (): ApprovalInfo =>
  ({ id: 'a1', toolName: 'Bash', input: { command: 'npm test' } }) as ApprovalInfo;

const decisionRow = (): PendingDecisionRow => ({
  taskId: 'task-1',
  title: 'the derived pending queue',
  criterion: { key: '3t4PyphGUWQtzDGfvOLY9R', text: 'the rail is derived from the facts' },
  evidenceRevision: '2',
  ageSeconds: 5_400,
  claim: 'the web render test passed',
  gaps: [],
  citations: [],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
});

/** The ask the coordinator raises over that row, shaped the way `buildEvidenceQuestion` shapes it:
 *  the two option labels, and the trailing identity line the card recognises it by. */
const decisionApproval = (row: PendingDecisionRow): ApprovalInfo =>
  ({
    id: 'd1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [{
        question: `${row.title} — task ${row.taskId}, evidence rev ${row.evidenceRevision}`,
        header: 'Completion',
        options: [{ label: CONFIRM_LABEL }, { label: SEND_BACK_LABEL }],
      }],
    },
  }) as ApprovalInfo;

const decisionQueue = (row: PendingDecisionRow): PendingDecisionQueue => ({
  decidingSessionId: 'coordinator-session',
  count: 1,
  oldestAgeSeconds: row.ageSeconds,
  pending: [row],
  waitingOnYou: [],
});

/** Every rendered `<button>`, so a claim about "the buttons" is about all of them. */
function buttons(html: string): string[] {
  return html
    .split('<button')
    .slice(1)
    .map((chunk) => `<button${chunk.split('</button>')[0]}</button>`);
}

/** The ones that ACT, as opposed to the disclosures that fold a section open. */
const actions = (html: string): string[] =>
  buttons(html).filter((button) => button.includes(`class="${CARD_ACTION_CLASS}`));

const decisionCard = (over: { answerable?: boolean } = {}): string => {
  const row = decisionRow();
  return renderToStaticMarkup(
    <ApprovalPanel
      approval={decisionApproval(row)}
      decisions={decisionQueue(row)}
      answerable={over.answerable ?? true}
      onDecide={() => {}}
    />,
  );
};

describe('both cards get their actions from one component', () => {
  it('is imported by each of them, and declared by neither', () => {
    expect(source('ApprovalPanel.tsx')).toMatch(/from '\.\/CardAction'/);
    // The button element and its sizes live in exactly one file. A card that went back to writing
    // its own would show up here as a class nobody else can see or an inline size.
    expect(source('CardAction.tsx')).toContain('<button');
    for (const file of ['ApprovalPanel.tsx', 'DecisionRail.tsx']) {
      const text = source(file);
      expect(text, `${file} declares its own action button`).not.toMatch(/className="approval-btn/);
      expect(text, `${file} sizes a button itself`).not.toMatch(/<Button\s/);
    }
  });

  it('leaves the pinned strip with no action to share', () => {
    // The third surface, and the reason there are only two cards here now. It renders controls —
    // the fold, and a row that points at its card — but nothing that answers anything, so it has
    // no use for the shared action and does not import one.
    const rail = source('DecisionRail.tsx');
    expect(rail).not.toMatch(/from '\.\/CardAction'/);
    expect(rail).not.toContain('CardActionButton');
  });

  it('puts the same size token on the buttons both cards actually render', () => {
    const approvalHtml = renderToStaticMarkup(
      <ApprovalPanel approval={approval()} onDecide={() => {}} />,
    );
    const decisionHtml = decisionCard();

    for (const [name, html] of [['approval', approvalHtml], ['decision', decisionHtml]] as const) {
      const rendered = buttons(html);
      expect(rendered.length, `${name} card rendered no button`).toBeGreaterThan(0);
      for (const button of rendered) {
        // Every button is either an action on the shared token or a disclosure that folds a
        // section open — a census, so a card growing a third kind of control is caught here.
        expect(
          button.includes(`class="${CARD_ACTION_CLASS}`)
            || button.includes('decision-ask-toggle'),
          `${name} card's control is neither the shared action nor a disclosure`,
        ).toBe(true);
      }
      expect(actions(html).length, `${name} card rendered no action`).toBeGreaterThan(0);
      expect(html, `${name} card's action row is not the shared one`).toContain(CARD_ACTIONS_CLASS);
    }
  });

  it('holds both cards to one rule: an action that cannot succeed is disabled', () => {
    // The approval card's own instance of the rule — a question with nothing picked yet.
    const question = renderToStaticMarkup(
      <ApprovalPanel
        approval={{
          id: 'q1',
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'which?', options: [{ label: 'this' }, { label: 'that' }] }] },
        } as ApprovalInfo}
        onDecide={() => {}}
      />,
    );
    const submit = buttons(question).find((button) => button.includes('Submit'));
    expect(submit).toBeDefined();
    expect(submit).toMatch(/\sdisabled(?:=|\s|>)/);

    // And the decision card's — a card whose turn has ended, so an answer would reach nobody.
    const dead = decisionCard({ answerable: false });
    expect(actions(dead).length).toBeGreaterThan(0);
    for (const button of actions(dead)) {
      expect(button, 'a decision nobody is listening for is still pressable').toMatch(
        /\sdisabled(?:=|\s|>)/,
      );
    }
    // The same card while somebody IS listening: lit, so this is a difference between the two
    // states rather than a card whose actions are never pressable.
    expect(actions(decisionCard()).some((button) => !/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
  });
});
