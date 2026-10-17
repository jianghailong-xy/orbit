// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_RECORD_COPY } from '@orbit/shared';
import { type RunEvent, EventFullCtx, Transcript } from './Transcript';

/**
 * An agent's question once it has ended (`docs/mocks/ask-question-card-ios/`). Folded, the card is
 * the record — what was asked, in its opening, and how it was answered — and it opens to every
 * question and option as asked, the pick highlighted, without the OUTPUT block that only says the
 * same again. A reply given in the conversation ("Chat about this") reaches the transcript as the
 * call's error, and is drawn as the person's reply rather than as a failure.
 *
 * The question and the result are the 10:14 screenshot's, word for word (claude 2.1.296's wording).
 */

const QUESTION =
  "On iPad, what should a swipe right from the left edge do? Today there are two places on the iPad where the swipe does nothing: (1) the hidden sidebar only opens from the toolbar button; (2) the in-column pages with a Back button (a folder's page, a project's sessions page, a task opened over its project, a runner's engine or name page) only go back from that button. On the iPhone the same swipe opens the drawer on a list page and goes back on a pushed page.";
const OPTIONS = [
  { label: 'Both, like the iPhone (Recommended)', description: 'Swiping right opens the sidebar on a list page and goes back on a pushed one.' },
  { label: 'Open the sidebar only', description: 'Going back still uses only the Back button.' },
  { label: 'Swipe back only', description: 'The sidebar still opens only from the toolbar button.' },
];
const ASK = { questions: [{ question: QUESTION, header: 'Swipe right', multiSelect: false, options: OPTIONS }] };
const TRAILER =
  '. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
const answered = (words: string, question = QUESTION) => `The user answered: "${question}"="${words}"${TRAILER}`;

const ev = (seq: number, type: string, payload: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent => ({
  seq,
  type,
  ts: `2026-10-10T02:14:${String(seq).padStart(2, '0')}.000Z`,
  payload,
  ...extra,
});
const call = (input: unknown = ASK) => ev(1, 'tool_use', { id: 'toolu_q', name: 'AskUserQuestion', input });
const result = (content: string, isError = false, extra: Partial<RunEvent> = {}) =>
  ev(2, 'tool_result', { toolUseId: 'toolu_q', content, ...(isError ? { isError: true } : {}) }, extra);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(events: RunEvent[], fetchFull: ((seq: number) => Promise<unknown>) | null = null) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <EventFullCtx.Provider value={fetchFull}>
          <Transcript events={events} />
        </EventFullCtx.Provider>
      </MemoryRouter>,
    );
  });
}
const card = () => container.querySelector<HTMLElement>('.chat-tool-card')!;
const text = (selector: string) => [...container.querySelectorAll(selector)].map((el) => el.textContent);
const open = () => act(async () => container.querySelector<HTMLElement>('.chat-tool-row')!.click());

describe('an answered question, folded', () => {
  it('is what was asked and how it was answered, with no OUTPUT', async () => {
    await show([call(), result(answered('Both, like the iPhone (Recommended)'))]);
    expect(card().classList.contains('is-open')).toBe(false);
    expect(text('.chat-q-lead')).toEqual([QUESTION]);
    expect(text('.chat-q-answer-words')).toEqual(['Both, like the iPhone (Recommended)']);
    expect(container.querySelector('.chat-tool-status.ok')).not.toBeNull();
    expect(container.textContent).not.toContain('The user answered');
    expect(container.querySelector('.chat-q-opt')).toBeNull();
  });

  it('opens to every option as asked, the pick highlighted, and still no OUTPUT', async () => {
    await show([call(), result(answered('Open the sidebar only'))]);
    await open();
    expect(card().classList.contains('is-open')).toBe(true);
    expect(container.querySelector('.chat-q-folded')).toBeNull();
    expect(text('.chat-q-text')).toEqual([QUESTION]);
    expect(text('.chat-q-opt-label')).toEqual(OPTIONS.map((o) => o.label));
    expect(text('.chat-q-opt-desc')).toEqual(OPTIONS.map((o) => o.description));
    expect(text('.chat-q-opt.is-picked .chat-q-opt-label')).toEqual(['Open the sidebar only']);
    expect(container.querySelector('.chat-result')).toBeNull();
    expect(container.textContent).not.toContain('The user answered');
  });

  it('opens from its record lines too, as from its row', async () => {
    await show([call(), result(answered('Swipe back only'))]);
    await act(async () => container.querySelector<HTMLElement>('.chat-q-folded')!.click());
    expect(card().classList.contains('is-open')).toBe(true);
    await open();
    expect(card().classList.contains('is-open')).toBe(false);
  });

  it('quotes words typed instead of an option, and boxes them once open', async () => {
    const typed = 'Only on list pages for now; leave going back to the button.';
    await show([call(), result(answered(typed))]);
    expect(text('.chat-q-answer-words')).toEqual([`“${typed}”`]);
    await open();
    expect(container.querySelector('.chat-q-opt.is-picked')).toBeNull();
    expect(text('.chat-q-words')).toEqual([`${QUESTION_RECORD_COPY.yourAnswer}${typed}`]);
  });

  it('names every pick of a multi-select question, in the order offered', async () => {
    const question = 'Which clients should get the new card in this change?';
    const input = {
      questions: [
        {
          question,
          header: 'Clients',
          multiSelect: true,
          options: [{ label: 'iOS and macOS' }, { label: 'Web' }, { label: 'Android' }],
        },
      ],
    };
    await show([call(input), result(answered('Web,iOS and macOS', question))]);
    expect(text('.chat-q-answer-words')).toEqual(['iOS and macOS · Web']);
    await open();
    expect(text('.chat-q-opt.is-picked .chat-q-opt-label')).toEqual(['iOS and macOS', 'Web']);
    expect(text('.chat-q-multi')).toEqual([QUESTION_RECORD_COPY.multipleChoice]);
  });

  it('gives each of several questions one line, and its own answer', async () => {
    const second = 'What should the top-left button be on a project page opened from the session list?';
    const input = {
      questions: [
        ...ASK.questions,
        { question: second, header: 'Top-left', multiSelect: false, options: [{ label: '‹ Back (Recommended)' }, { label: 'Keep ☰' }] },
      ],
    };
    await show([
      call(input),
      result(`The user answered: "${QUESTION}"="Both, like the iPhone (Recommended)", "${second}"="Keep ☰"${TRAILER}`),
    ]);
    expect(container.querySelectorAll('.chat-q-lead.is-one-line')).toHaveLength(2);
    expect(text('.chat-q-answer-words')).toEqual(['Both, like the iPhone (Recommended)', 'Keep ☰']);
  });
});

describe('a question answered in the conversation instead', () => {
  const reply = "Before I pick: does the left swipe still close the sidebar once it's open?";

  it('is the reply, not a failure', async () => {
    await show([call(), result(reply, true)]);
    expect(container.querySelector('.chat-tool-status.err')).toBeNull();
    expect(container.querySelector('.chat-tool-status.replied')).not.toBeNull();
    expect(text('.chat-q-answer-words')).toEqual([`“${reply}”`]);
    expect(text('.chat-q-answer-note')).toEqual([QUESTION_RECORD_COPY.repliedInChat]);
    await open();
    expect(container.querySelector('.chat-result.is-error')).toBeNull();
    expect(container.querySelector('.chat-q-opt.is-picked')).toBeNull();
    expect(text('.chat-q-words')).toEqual([`${QUESTION_RECORD_COPY.repliedInChat}${reply}`]);
  });
});

describe('a question whose result is not an answer', () => {
  it('stays a failure when the call failed: red, folded, the error behind a click', async () => {
    await show([call(), result('<tool_use_error>InputValidationError: questions[0].options</tool_use_error>', true)]);
    expect(container.querySelector('.chat-tool-status.err')).not.toBeNull();
    expect(card().classList.contains('is-open')).toBe(false);
    expect(container.querySelector('.chat-q-answer')).toBeNull();
    await open();
    expect(container.querySelector('.chat-result.is-error')?.textContent).toContain('InputValidationError');
  });

  it('opens on the result when this client cannot read it, so nothing is lost', async () => {
    await show([call(), result('The user did not answer the questions.')]);
    expect(card().classList.contains('is-open')).toBe(true);
    expect(container.querySelector('.chat-result')?.textContent).toContain('The user did not answer the questions.');
  });
});

describe('a clipped answer', () => {
  it('is read whole while the card is still folded', async () => {
    const fetchFull = vi.fn(async () => ({ payload: { content: answered('Swipe back only') } }));
    await show([call(), result(answered('Swipe back only').slice(0, 300), false, { truncated: true })], fetchFull);
    expect(fetchFull).toHaveBeenCalledWith(2);
    expect(card().classList.contains('is-open')).toBe(false);
    expect(text('.chat-q-answer-words')).toEqual(['Swipe back only']);
  });
});
