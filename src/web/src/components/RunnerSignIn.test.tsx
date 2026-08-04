import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunnerLoginState } from '@orbit/shared';
import { probeReportsSignedIn, RunnerSignIn } from './RunnerSignIn';

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

// What ends the wait for the runner to re-report after a sign-in lands. Getting this wrong is
// what left a signed-in engine reading "Signed out" under a card saying it was ready.
describe('waiting for the runner to confirm a sign-in', () => {
  const runners = (auth: 'yes' | 'no' | 'unknown') => [
    { id: 'other', engines: [{ engine: 'kimi' as const, installed: true, auth: 'yes' as const }] },
    {
      id: RUNNER,
      engines: [
        { engine: 'claude' as const, installed: true, auth: 'yes' as const },
        { engine: 'kimi' as const, installed: true, auth },
      ],
    },
  ];

  it('ends once that machine reports this engine signed in', () => {
    expect(probeReportsSignedIn(runners('yes'), RUNNER, 'kimi')).toBe(true);
  });

  it('keeps waiting while the runner still reports the pre-sign-in probe', () => {
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'kimi')).toBe(false);
    // A CLI that wouldn't answer is not a yes — the wait is bounded, not ended, by this.
    expect(probeReportsSignedIn(runners('unknown'), RUNNER, 'kimi')).toBe(false);
  });

  it('answers for this runner and this engine, not another that happens to be signed in', () => {
    expect(probeReportsSignedIn(runners('no'), 'other', 'kimi')).toBe(true);
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'claude')).toBe(true);
  });

  it('keeps waiting on a runner that has reported nothing yet', () => {
    expect(probeReportsSignedIn(undefined, RUNNER, 'kimi')).toBe(false);
    expect(probeReportsSignedIn([{ id: RUNNER, engines: null }], RUNNER, 'kimi')).toBe(false);
    expect(probeReportsSignedIn([], RUNNER, 'kimi')).toBe(false);
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
