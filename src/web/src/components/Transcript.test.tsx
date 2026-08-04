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

describe('engine stderr', () => {
  const stderrEvent = (seq: number, stderr: string): RunEvent => ({
    seq,
    type: 'system',
    payload: { stderr },
  });

  // Claude Code prints this whenever an auth token is in its environment — i.e. on every
  // session of every configured provider, whose API key Orbit injects that way.
  it('drops the connectors notice Orbit’s own env injection provokes', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(
            1,
            '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth ' +
              'source is set and takes precedence over your claude.ai login · Unset it to load ' +
              "your organization's connectors\n",
          ),
        ]}
      />,
    );

    expect(html).not.toContain('connectors are disabled');
    expect(html).not.toContain('chat-error');
  });

  it('still shows stderr that explains why a runtime failed', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, 'No conversation found with session ID: abc\n')]} />,
    );

    expect(html).toContain('No conversation found with session ID: abc');
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

// `MD breaks` is the renderer for hand-laid-out text: composer messages and the task
// panel's Description. Both used to be shown pre-wrapped, so formatting has to render
// *and* the author's own line breaks have to survive.
describe('hand-typed Markdown', () => {
  it('renders the markup while keeping single newlines as line breaks', () => {
    const html = renderToStaticMarkup(
      <MD breaks>{'## Goal\nMake `tdp-prose` render\nKeep this on its own row\n- one\n- two'}</MD>,
    );

    expect(html).toContain('<h2>Goal</h2>');
    expect(html).toContain('<code>tdp-prose</code>');
    expect(html).toContain('<li>one</li>');
    // The two adjacent prose lines are one paragraph — without hard breaks CommonMark
    // would join them with a space.
    expect(html).toContain('render<br/>');
  });
});

// Claude's Bash calls carry a prose `description` that fills the folded row; Codex's carry none
// and wrap the command in `/bin/bash -lc "…"`, so its rows used to read as a bare "Bash".
describe('Bash folded row', () => {
  const bashRow = (input: Record<string, unknown>) =>
    renderToStaticMarkup(
      <Transcript events={[{ seq: 1, type: 'tool_use', payload: { id: 't1', name: 'Bash', input } }]} />,
    );

  it('falls back to the command when the runtime sends no description', () => {
    const html = bashRow({ command: `/bin/bash -lc "orbit task get 'x' --json"` });

    expect(html).toContain('<span class="chat-tool-summary mono">orbit task get &#x27;x&#x27; --json</span>');
  });

  it('still prefers the description when there is one', () => {
    const html = bashRow({ command: 'grep -rn x src/', description: 'Find x' });

    expect(html).toContain('<span class="chat-tool-summary">Find x</span>');
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
