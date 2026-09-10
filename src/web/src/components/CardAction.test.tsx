import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { ApprovalPanel } from './ApprovalPanel';
import { CARD_ACTIONS_CLASS, CARD_ACTION_CLASS } from './CardAction';
import type { PendingDecisionQueue, PendingDecisionRow } from './DecisionRail';
import { EvidenceDecisionCard, evidenceDecisionStanding } from './EvidenceDecisionCard';

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
 * 2026-09-09, so the rail was reduced to a counter and a pointer. The judgment went first onto an
 * `AskUserQuestion` a coordinator turn raised, and since 2026-09-10 onto Orbit's own card,
 * `EvidenceDecisionCard.tsx`, drawn from the pending read — so that is the second card now, and the
 * third claim below still holds: the rail declares no action, imports none, and renders none,
 * because it has nothing to act on.
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

const PROJECT_ID = 'project-1';

const decisionRow = (): PendingDecisionRow => ({
  taskId: 'task-1',
  title: 'the derived pending queue',
  projectId: PROJECT_ID,
  criterion: { key: '3t4PyphGUWQtzDGfvOLY9R', text: 'the rail is derived from the facts' },
  evidenceRevision: '2',
  ageSeconds: 5_400,
  claim: 'the web render test passed',
  gaps: [],
  citations: [],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
});

const decisionQueue = (rows: PendingDecisionRow[]): PendingDecisionQueue => ({
  decidingSessionId: 'coordinator-session',
  count: rows.length,
  oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
  pending: rows,
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

/** The evidence card for that row: still in the read, or answered elsewhere and gone from it. */
const decisionCard = (over: { answered?: boolean } = {}): string => {
  const row = decisionRow();
  const read = decisionQueue(over.answered ? [] : [row]);
  return renderToStaticMarkup(
    <EvidenceDecisionCard standing={evidenceDecisionStanding(read, PROJECT_ID, row)} onDecide={() => {}} />,
  );
};

describe('both cards get their actions from one component', () => {
  it('is imported by each of them, and declared by neither', () => {
    for (const file of ['ApprovalPanel.tsx', 'EvidenceDecisionCard.tsx']) {
      expect(source(file), `${file} does not take its actions from CardAction`).toMatch(
        /from '\.\/CardAction'/,
      );
    }
    // The button element and its sizes live in exactly one file. A card that went back to writing
    // its own would show up here as a class nobody else can see or an inline size.
    expect(source('CardAction.tsx')).toContain('<button');
    for (const file of ['ApprovalPanel.tsx', 'EvidenceDecisionCard.tsx', 'DecisionRail.tsx']) {
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

    // And the decision card's — a version answered elsewhere, so the door would refuse any answer.
    const dead = decisionCard({ answered: true });
    expect(actions(dead).length).toBeGreaterThan(0);
    for (const button of actions(dead)) {
      expect(button, 'a decision the door would refuse is still pressable').toMatch(
        /\sdisabled(?:=|\s|>)/,
      );
    }
    // The same card while somebody IS listening: lit, so this is a difference between the two
    // states rather than a card whose actions are never pressable.
    expect(actions(decisionCard()).some((button) => !/\sdisabled(?:=|\s|>)/.test(button))).toBe(true);
  });
});
