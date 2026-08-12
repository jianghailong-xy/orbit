import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AutoRetryCtx, type AutoRetryHelp, AuthErrorCtx, MD, type RunEvent, Transcript } from './Transcript';

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

// A provider that briefly cannot answer is a pause, not an error to act on: the transcript owes
// the reader a pending retry, not a red line they have to do something about. The distinction is
// made on the error text alone, so the two halves are tested together.
describe('transient provider error card', () => {
  const OVERLOADED =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const TOO_LONG =
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
    '"message":"prompt is too long: 234523 tokens > 200000 maximum"}}';

  const render = (text: string, help?: AutoRetryHelp) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider value={help ?? null}>
        <Transcript events={[{ seq: 1, type: 'assistant', payload: { text } }]} />
      </AutoRetryCtx.Provider>,
    );

  it('turns an overloaded API into a retry card carrying the error verbatim', () => {
    const html = render(OVERLOADED);

    expect(html).toContain('chat-quota');
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('overloaded_error');
    expect(html).not.toContain('chat-error');
  });

  it('leaves an error a re-send would reproduce as a plain error line', () => {
    const html = render(TOO_LONG);

    expect(html).toContain('chat-error');
    expect(html).toContain('prompt is too long');
    expect(html).not.toContain('Provider unavailable');
  });

  it('counts down to the armed retry', () => {
    const html = render(OVERLOADED, {
      provider: 'claude',
      retryAt: new Date(Date.now() + 30_000).toISOString(),
      attempts: 1,
    });

    expect(html).toContain('Retrying');
    expect(html).toContain('sec');
  });

  it('says so once the attempts are spent, rather than showing a dead countdown', () => {
    const html = render(OVERLOADED, { provider: 'claude', retryAt: null, attempts: 3 });

    expect(html).toContain('Auto-retry gave up');
    expect(html).toContain('the API is still failing');
  });
});

// Which window ran out is the whole point of the card: a 5-hour quota named as the weekly one
// tells the reader to come back in days for something that returns this evening.
describe('spent quota card', () => {
  const render = (text: string) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider value={{ provider: 'claude', runnerName: 'wikova' }}>
        <Transcript events={[{ seq: 1, type: 'assistant', payload: { text } }]} />
      </AutoRetryCtx.Provider>,
    );

  it('names the rolling window the runtime actually named', () => {
    const html = render("You've hit your session limit · resets 8:20pm (Europe/Berlin)");

    expect(html).toContain('Session limit reached');
    expect(html).toContain('The 5-hour quota');
    expect(html).not.toContain('Weekly limit');
  });

  it('names the weekly window only when the runtime does', () => {
    const html = render("You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)");

    expect(html).toContain('Weekly limit reached');
  });

  // The reply that surfaced this was an *answer* about a quota outage — it quoted the Codex
  // wording while explaining why a task had run 28 times. Read as the provider refusing to
  // answer, it vanished from the transcript behind a card announcing a limit nobody had hit.
  it('leaves an answer that merely quotes a quota error as the answer', () => {
    const html = render(
      'All 27 failed with the same codex error: "You\'ve hit your usage limit. Visit ' +
        'https://chatgpt.com/codex/settings/usage to purchase more credits." The weekly limit ' +
        'is not what stopped them.',
    );

    expect(html).not.toContain('chat-quota');
    expect(html).toContain('All 27 failed');
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

  // codex colours its stderr with tracing's ANSI layer. The ESC byte is invisible in HTML, so
  // an unstripped line reads as "[2m…[0m [31mERROR[0m" — every log line wrapped in garbage.
  const codexLine = (ts: string, message: string) =>
    `\x1b[2m${ts}\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mcodex_core::util\x1b[0m\x1b[2m:\x1b[0m ${message}\n`;
  const MISSING_OUTPUT = 'Custom tool call output is missing for call id: call_5zNG2';

  it('strips the ANSI colouring off an engine’s log line', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT))]} />,
    );

    expect(html).toContain(`ERROR codex_core::util: ${MISSING_OUTPUT}`);
    expect(html).not.toContain('[31m');
    expect(html).not.toContain('[0m');
  });

  // The same complaint is re-logged on every request for the rest of the conversation — 217
  // times in the session this came from, one per turn, between the turns doing the work.
  it('folds a re-logged line into one row with a count', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT)),
          stderrEvent(2, codexLine('2026-08-12T15:32:38.753979Z', MISSING_OUTPUT)),
          stderrEvent(3, codexLine('2026-08-12T15:33:47.965544Z', MISSING_OUTPUT)),
        ]}
      />,
    );

    expect(html.split('chat-error"').length - 1).toBe(1);
    expect(html).toContain('×3');
  });

  it('keeps a row per distinct line, and shows no count for a line seen once', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT)),
          stderrEvent(2, codexLine('2026-08-12T15:32:38.753979Z', 'Codex could not find bubblewrap on PATH')),
        ]}
      />,
    );

    expect(html.split('chat-error"').length - 1).toBe(2);
    expect(html).toContain('bubblewrap');
    expect(html).not.toContain('chat-error-repeat');
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
