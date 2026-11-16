// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_QUESTION_POINTER,
  DecisionStrip,
  questionPointer,
  revealQuestionCard,
  type ExceptionCardPointer,
  type PendingDecisionQueue,
  type PendingDecisionRow,
  type QuestionCardPointer,
} from './DecisionRail';

/**
 * A coordinator's open question on the pinned line (owner 2026-11-16,
 * docs/mocks/coordinator-question-jump). The header and the session row said "Question from
 * coordinator" while the line said nothing, so the reader had no way to the card that answers it.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const QUESTION = 'Nacos and RocketMQ are unavailable on the shared environment. Can you restore them?';
const ASKED: QuestionCardPointer = { itemId: '34yQN4tOBrdOBqh7FajW9', question: QUESTION, ageSeconds: 22 * 60 };

const PAUSED: ExceptionCardPointer = {
  row: {
    itemId: '6fWujE4NBkVyzMWkL975oc',
    kind: 'FUSE_PAUSED',
    title: 'The coordinator paused itself',
    assigneeReason: 'DEFAULT',
    waitingSince: '2026-10-02T00:40:00.000Z',
    escalatedAt: null,
  } as ExceptionCardPointer['row'] & Pick<ProjectOpenItemRow, 'kind'>,
  ageSeconds: 3600,
  above: true,
};

const EVIDENCE: PendingDecisionRow = {
  taskId: '34IovIcRNjv3rAC1vespN',
  title: 'the derived pending queue',
  projectId: '34ODoUKJGEsfbgcJDGS4q',
  criterion: { key: '3t4PyphGUWQtzDGfvOLY9R', text: 'the pending queue is derived from facts' },
  evidenceRevision: '2',
  ageSeconds: 5 * 3600,
  claim: 'the web render test passed',
  gaps: [],
  citations: [],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
};

const queue = (pending: PendingDecisionRow[] = []): PendingDecisionQueue => ({
  decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
  count: pending.length,
  oldestAgeSeconds: pending[0]?.ageSeconds ?? null,
  pending,
  waitingOnYou: [],
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('a coordinator question on the pinned line', () => {
  it('names it in the header’s word, then the question, with its wait and the way down', () => {
    const html = renderToStaticMarkup(
      <DecisionStrip queue={queue()} open={false} onToggle={() => {}} questions={[ASKED]} />,
    );
    expect(questionPointer(QUESTION)).toBe(`Question from coordinator · ${QUESTION}`);
    expect(html).toContain(`<span class="decision-strip-title">${COORDINATOR_QUESTION_POINTER} · ${QUESTION}</span>`);
    expect(html).toContain('<span class="decision-strip-quiet">22m</span>');
    expect(html).toContain('<span class="decision-strip-caret" aria-hidden="true">↓</span>');
    expect(html).toContain('aria-label="1 waiting: Question from coordinator');
  });

  it('draws nothing for a conversation with no question and nothing else waiting', () => {
    const html = renderToStaticMarkup(
      <DecisionStrip queue={queue()} open={false} onToggle={() => {}} questions={[]} />,
    );
    expect(html).toBe('');
  });

  it('goes after the owner’s exceptions and ahead of evidence, each press to the next card', () => {
    const went: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <DecisionStrip
        queue={queue([EVIDENCE])}
        open={false}
        hasCard={() => true}
        onToggle={() => {}}
        exceptions={[PAUSED]}
        questions={[ASKED]}
        onRevealException={(row) => went.push(`exception:${row.itemId}`)}
        onRevealQuestion={(itemId) => went.push(`question:${itemId}`)}
        onReveal={(row) => went.push(`evidence:${row.taskId}`)}
      />,
    ));
    const line = () => host!.querySelector<HTMLButtonElement>('.decision-strip-line')!;
    for (let i = 0; i < 3; i += 1) act(() => line().click());
    expect(went).toEqual([
      `exception:${PAUSED.row.itemId}`,
      `question:${ASKED.itemId}`,
      `evidence:${EVIDENCE.taskId}`,
    ]);
    // The line names the card the last press went to, and where it stands among the three.
    act(() => line().click());
    expect(line().textContent).toContain('The coordinator paused itself');
    act(() => line().click());
    expect(line().querySelector('.decision-strip-title')?.textContent).toBe(questionPointer(QUESTION));
    expect(line().textContent).toContain('2 of 3');
  });
});

describe('revealQuestionCard', () => {
  it('scrolls to the question’s card and opens its preview where it is drawn as one', () => {
    document.body.innerHTML = `
      <div class="review-card" id="question-${ASKED.itemId}">
        <button class="approval-card review-card-preview" aria-expanded="false"></button>
      </div>`;
    const card = document.getElementById(`question-${ASKED.itemId}`)!;
    const scrolled = vi.fn();
    card.scrollIntoView = scrolled;
    const preview = card.querySelector<HTMLButtonElement>('.review-card-preview')!;
    const opened = vi.fn();
    preview.addEventListener('click', opened);
    expect(revealQuestionCard(ASKED.itemId)).toBe(true);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('says it went nowhere when the card is not drawn', () => {
    expect(revealQuestionCard('missing')).toBe(false);
  });
});
