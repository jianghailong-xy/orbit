import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalPanel } from './ApprovalPanel';
import { Transcript, type RunEvent } from './Transcript';
import type { ApprovalInfo } from '../api';

/**
 * A multi-line question has to still be multi-line on screen.
 *
 * `AskUserQuestion` carries one plain-text string, and an agent writing more than a sentence
 * writes it with line breaks — options laid out one per line, a paragraph split from its heading.
 * `QuestionForm` puts that string in a `<div>` unchanged, so whether the breaks survive is decided
 * entirely by the stylesheet: without a `white-space` that preserves them, HTML collapses every
 * run of whitespace and the whole thing lands as one paragraph.
 *
 * WHY THE ASSERTION IS A COMPUTED STYLE AND NOT A GREP. "the stylesheet mentions `white-space`"
 * is a predicate that can pass while the screen is still wrong: it says nothing about which rule
 * carries it, whether that rule matches the element the component rendered, or whether a later
 * rule wins. So the question text is rendered by the real component, mounted under the real
 * `index.css`, and the property is READ BACK OFF THAT ELEMENT — the same two inputs (markup,
 * stylesheet) a browser is given, resolved by a CSS engine rather than by this file's idea of the
 * cascade. Delete the declaration and this goes red on its own, which is how it was written: it
 * failed against the stylesheet as it stood, reporting `whiteSpace: ''`.
 */

/** Values under which a line break in the text is a line break on screen. `normal` and `nowrap`
 *  collapse it; `''` is what jsdom computes when nothing declares the property at all. */
const PRESERVES_BREAKS = ['pre-wrap', 'pre-line', 'pre', 'break-spaces'];
/** Either spelling of "a token longer than the card may be broken", so this pins the effect and
 *  not one of the two properties that produce it. */
const BREAKS_LONG_TOKENS = ['break-word', 'break-all', 'anywhere'];

const QUESTION = [
  'Which branch should this land on?',
  '',
  'Context: the fix is one CSS declaration, and the test that holds it is new.',
  '  - main: ships with the next release',
  '  - orbit/chat-q-text-white-space: stays put until somebody merges it',
  '',
  'Reference: https://example.invalid/orbit/runs/01JQZ8X4N7V2C6M9K3RTB5PWDA/artifacts',
].join('\n');

const QUESTIONS = [
  {
    header: 'Branch',
    question: QUESTION,
    options: [
      { label: 'main', description: 'Land it on the default branch' },
      { label: 'this branch', description: 'Leave it where it is' },
    ],
  },
];

const approval = (): ApprovalInfo =>
  ({
    id: 'ap1',
    sessionId: 's1',
    toolName: 'AskUserQuestion',
    input: { questions: QUESTIONS },
    status: 'PENDING',
    createdAt: '2026-09-09T10:00:00Z',
  }) as ApprovalInfo;

const stylesheet = (): string => {
  // The web suite runs from `src/web`; a runner invoking vitest from the repo root does not.
  const found = ['src/index.css', 'src/web/src/index.css']
    .map((each) => resolve(process.cwd(), each))
    .find(existsSync);
  if (!found) throw new Error(`index.css not found from ${process.cwd()}`);
  return readFileSync(found, 'utf8');
};

/** The question as it comes out the other end: the text of the element holding it — found BY that
 *  text, not by a class name this file assumed — and the style a CSS engine resolves for it. */
const asShown = (html: string, text: string): { text: string; whiteSpace: string; wordBreak: string } => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { document } = dom.window;
  const style = document.createElement('style');
  style.textContent = stylesheet();
  document.head.appendChild(style);
  document.body.innerHTML = html;

  const holders = [...document.querySelectorAll('*')].filter((el) => el.textContent === text);
  const innermost = holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
  if (innermost.length !== 1) {
    throw new Error(`expected one element holding the question, found ${innermost.length}`);
  }
  const computed = dom.window.getComputedStyle(innermost[0]);
  return {
    text: innermost[0].textContent ?? '',
    whiteSpace: computed.whiteSpace,
    wordBreak: computed.wordBreak,
  };
};

describe('a multi-line AskUserQuestion in the generic form', () => {
  it('keeps its line breaks on screen', () => {
    const html = renderToStaticMarkup(<ApprovalPanel approval={approval()} onDecide={() => {}} />);

    const shown = asShown(html, QUESTION);

    // The render carries the breaks…
    expect(shown.text).toContain('\n  - main:');
    // …and the stylesheet is what decides whether anyone sees them.
    expect(PRESERVES_BREAKS).toContain(shown.whiteSpace);
    // A URL or an id with no break opportunity in it would otherwise widen the card past its
    // column instead of wrapping.
    expect(BREAKS_LONG_TOKENS).toContain(shown.wordBreak);
  });
});

describe('the same question read back in the transcript', () => {
  it('keeps its line breaks there too, off the same class', () => {
    // The historical card is a second renderer of the same text (`Questions` in `Transcript.tsx`),
    // and it reaches the same stylesheet rule — so it is fixed by the same declaration and would
    // break with it. Asserting it here is what makes that a checked claim rather than a guess.
    const events: RunEvent[] = [
      { seq: 1, type: 'tool_use', payload: { id: 't1', name: 'AskUserQuestion', input: { questions: QUESTIONS } } },
      { seq: 2, type: 'tool_result', payload: { toolUseId: 't1', content: 'The user answered: "Branch"="main".' } },
    ];
    const html = renderToStaticMarkup(<Transcript events={events} />);

    const shown = asShown(html, QUESTION);

    expect(shown.text).toContain('\n  - main:');
    expect(PRESERVES_BREAKS).toContain(shown.whiteSpace);
  });
});
