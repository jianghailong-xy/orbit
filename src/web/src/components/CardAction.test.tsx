import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { ApprovalPanel } from './ApprovalPanel';
import { CARD_ACTIONS_CLASS, CARD_ACTION_CLASS } from './CardAction';
import { DecisionCard, type PendingDecisionRow } from './DecisionRail';

/**
 * The approval card and the decision card render the same button, and are held to the same rule.
 *
 * Two claims, and they are different in kind. The structural one is that neither card has its own
 * private button any more: the sizes were settled once, by three rounds of beta and a screenshot,
 * and a second card that redeclares them is a second card that drifts. The rendered one is that
 * the token actually reaches the markup — a shared import that both files then override in CSS
 * would satisfy a grep and fix nothing.
 *
 * What is deliberately NOT asserted here is that the two cards LOOK the same or behave the same.
 * They are different objects: an approval blocks a running turn and dies when it is answered; a
 * decision row is a derived read of durable facts that any independent session may answer at any
 * time. Only the affordance is shared.
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

/** Every rendered `<button>`, so a claim about "the buttons" is about all of them. */
function buttons(html: string): string[] {
  return html
    .split('<button')
    .slice(1)
    .map((chunk) => `<button${chunk.split('</button>')[0]}</button>`);
}

describe('both cards get their actions from one component', () => {
  it('is imported by each of them, and declared by neither', () => {
    for (const file of ['ApprovalPanel.tsx', 'DecisionRail.tsx']) {
      expect(source(file), file).toMatch(/from '\.\/CardAction'/);
    }
    // The button element and its sizes live in exactly one file. A card that went back to writing
    // its own would show up here as a class nobody else can see or an inline size.
    const shared = source('CardAction.tsx');
    expect(shared).toContain('<button');
    for (const file of ['ApprovalPanel.tsx', 'DecisionRail.tsx']) {
      const text = source(file);
      expect(text, `${file} declares its own action button`).not.toMatch(/className="approval-btn/);
      expect(text, `${file} sizes a button itself`).not.toMatch(/<Button\s/);
    }
  });

  it('puts the same size token on the buttons both cards actually render', () => {
    const approvalHtml = renderToStaticMarkup(
      <ApprovalPanel approval={approval()} onDecide={() => {}} />,
    );
    const decisionHtml = renderToStaticMarkup(
      <DecisionCard
        row={decisionRow()}
        narrow={false}
        note=""
        busy={false}
        error={null}
        onNote={() => {}}
        onDecide={() => {}}
      />,
    );

    for (const [name, html] of [['approval', approvalHtml], ['decision', decisionHtml]] as const) {
      const rendered = buttons(html);
      expect(rendered.length, `${name} card rendered no button`).toBeGreaterThan(0);
      for (const button of rendered) {
        expect(button, `${name} card's action is not on the shared token`).toContain(
          `class="${CARD_ACTION_CLASS}`,
        );
      }
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

    // And the decision card's — evidence the door would refuse whatever was pressed.
    const blocked = renderToStaticMarkup(
      <DecisionCard
        row={{
          ...decisionRow(),
          criterion: null,
          decidability: {
            decidable: false,
            refusal: 'this evidence quotes no project criterion',
            requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
          },
        }}
        narrow={false}
        note=""
        busy={false}
        error={null}
        onNote={() => {}}
        onDecide={() => {}}
      />,
    );
    for (const button of buttons(blocked)) {
      expect(button, 'a decision nobody can record is still pressable').toMatch(
        /\sdisabled(?:=|\s|>)/,
      );
    }
  });
});
