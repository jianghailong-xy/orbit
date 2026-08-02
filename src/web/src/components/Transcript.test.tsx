import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthErrorCtx, MD, type RunEvent, Transcript } from './Transcript';

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

  it('shows the message the retry would re-send', () => {
    const html = renderToStaticMarkup(
      <AuthErrorCtx.Provider
        value={{ provider: 'codex', onRetry: () => {}, retryText: 'ship the thing' }}
      >
        <Transcript events={[errorEvent(1, AUTH_FAILED)]} />
      </AuthErrorCtx.Provider>,
    );

    expect(html).toContain('ship the thing');
    expect(html).toContain('Retry — re-send my last message');
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

describe('runtime authentication help', () => {
  // The relay branch renders RunnerSignIn, which reads the query cache.
  const card = (provider: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthErrorCtx.Provider value={{ provider, runnerId: 'runner-1', runnerName: 'box' }}>
          <Transcript events={[errorEvent(1, AUTH_FAILED)]} />
        </AuthErrorCtx.Provider>
      </QueryClientProvider>,
    );

  it("names OpenCode's command instead of a relay button that cannot drive its login", () => {
    const html = card('opencode');

    // Still a runner-local sign-in, not a Providers API key...
    expect(html).toContain('Sign-in expired');
    // ...but its login picks a provider interactively, so the relay is not offered.
    expect(html).toContain('opencode auth login');
    expect(html).not.toContain('rsi-');
  });

  it('keeps the browser relay for the runtimes that support it', () => {
    const html = card('codex');

    expect(html).toContain('Sign-in expired');
    expect(html).toContain('rsi-');
    expect(html).not.toContain('opencode auth login');
  });

  it('still routes a configured provider to its API key', () => {
    const html = card('deepseek');

    expect(html).toContain('Provider authentication failed');
    expect(html).not.toContain('opencode auth login');
  });
});
