import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunnerLoginState } from '@orbit/shared';
import { RunnerSignIn } from './RunnerSignIn';

const RUNNER = 'runner-1';

const loginState = (over: Partial<RunnerLoginState>): RunnerLoginState => ({
  status: null,
  engine: null,
  url: null,
  userCode: null,
  message: null,
  ...over,
});

/** Render the card over a login state the runner already had when the card appeared. */
function open(state: RunnerLoginState, onUseApiKey?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runner-login', RUNNER], state);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RunnerSignIn runnerId={RUNNER} engine="codex" onUseApiKey={onUseApiKey} />
    </QueryClientProvider>,
  );
}

describe('RunnerSignIn on a runner with an earlier sign-in on record', () => {
  it("doesn't call a signed-out runner ready because an older sign-in succeeded", () => {
    const html = open(loginState({ status: 'done', engine: 'codex' }));

    expect(html).not.toContain('this runner is ready');
    expect(html).toContain('Sign in to Codex');
  });

  it("doesn't blame this failure on an older attempt's error", () => {
    const html = open(
      loginState({ status: 'failed', engine: 'codex', message: 'sign-in did not complete' }),
    );

    expect(html).not.toContain('sign-in did not complete');
    expect(html).toContain('Sign in to Codex');
  });

  // A device flow gets no auto-opened tab (its page is useless before the code exists), so the
  // card itself has to carry both halves of what the user does next.
  it('still shows a sign-in that is actually under way', () => {
    const html = open(
      loginState({
        status: 'awaiting_approval',
        engine: 'codex',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ZXHO-K06HC',
      }),
    );

    expect(html).toContain('ZXHO-K06HC');
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
  });
});

describe('RunnerSignIn choice of route', () => {
  it('offers the API key beside the sign-in while it is still a choice', () => {
    const html = open(loginState({}), () => {});

    expect(html).toContain('Sign in to Codex');
    expect(html).toContain('Use an API key instead');
  });

  it('drops the alternative once a sign-in is under way', () => {
    const html = open(
      loginState({
        status: 'awaiting_approval',
        engine: 'codex',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ZXHO-K06HC',
      }),
      () => {},
    );

    expect(html).not.toContain('Use an API key instead');
  });
});
