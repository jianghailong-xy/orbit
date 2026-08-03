import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MD, type RunEvent, Transcript } from './Transcript';

const AUTH_FAILED =
  'Failed to authenticate: Codex is installed on this runner but not signed in — sign in from here, or run `codex login` on that machine.';

const errorEvent = (seq: number, message: string): RunEvent => ({
  seq,
  type: 'error',
  payload: { message },
});

const cards = (html: string) => html.split('chat-authfix"').length - 1;

describe('transcript sign-in cards', () => {
  it('folds a re-reported sign-in failure into the card already there', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[errorEvent(1, AUTH_FAILED), errorEvent(2, AUTH_FAILED)]} />,
    );

    expect(cards(html)).toBe(1);
  });

  it('keeps a card per failure when the runner reports different ones', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          errorEvent(1, AUTH_FAILED),
          errorEvent(2, 'Failed to authenticate: OAuth session expired and could not be refreshed'),
        ]}
      />,
    );

    expect(cards(html)).toBe(2);
  });
});

describe('transcript Markdown links', () => {
  it('opens ordinary links in a new tab without exposing the opener', () => {
    const html = renderToStaticMarkup(<MD>[Orbit](https://example.com/docs)</MD>);

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
