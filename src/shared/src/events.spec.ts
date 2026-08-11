import { describe, expect, it } from 'vitest';
import {
  isApiErrorText,
  isAsyncAgentLaunchAck,
  isAuthErrorText,
  isBenignEngineStderr,
  isRetryableApiErrorText,
  isUsageLimitErrorText,
  toolResultText,
} from './events';

describe('toolResultText', () => {
  it('passes a plain string through', () => {
    expect(toolResultText('running in background with ID: abc')).toBe(
      'running in background with ID: abc',
    );
  });

  it('flattens an array of text blocks', () => {
    expect(toolResultText([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])).toBe(
      'hello world',
    );
  });

  it('is empty for null / non-text content', () => {
    expect(toolResultText(null)).toBe('');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText([{ type: 'image' }])).toBe('');
  });
});

describe('isAsyncAgentLaunchAck', () => {
  it('flags the async-agent launch acknowledgement (array form)', () => {
    const ack = [
      {
        type: 'text',
        text: 'Async agent launched successfully. (This tool result is internal metadata …) agentId: a56fe4c708d8c5292',
      },
    ];
    expect(isAsyncAgentLaunchAck(ack)).toBe(true);
  });

  it('does not flag a synchronous sub-agent completion report', () => {
    const report = [{ type: 'text', text: 'I now have a complete picture. Here is my research report.' }];
    expect(isAsyncAgentLaunchAck(report)).toBe(false);
  });

  it('does not flag an ordinary tool result', () => {
    expect(isAsyncAgentLaunchAck('/path/to/file.swift')).toBe(false);
    expect(isAsyncAgentLaunchAck(null)).toBe(false);
  });
});

describe('isApiErrorText', () => {
  it('flags an API Error prefix', () => {
    expect(isApiErrorText('API Error: 500')).toBe(true);
    expect(isApiErrorText('   API Error: overloaded')).toBe(true);
  });
  it('ignores normal text', () => {
    expect(isApiErrorText('all good')).toBe(false);
    expect(isApiErrorText(null)).toBe(false);
  });
});

describe('isRetryableApiErrorText', () => {
  it('flags the provider being briefly unable to answer', () => {
    expect(
      isRetryableApiErrorText(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe(true);
    expect(
      isRetryableApiErrorText(
        'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      ),
    ).toBe(true);
    expect(isRetryableApiErrorText('API Error: 503 Service Unavailable')).toBe(true);
  });

  it('flags a call that never reached a status code', () => {
    // Verbatim from the turn-complete fixture — the stream died mid-reply. All three wordings
    // have been observed on FAILED sessions.
    expect(isRetryableApiErrorText('API Error: Connection closed mid-response.')).toBe(true);
    expect(
      isRetryableApiErrorText(
        'API Error: Connection lost mid-response. The response above may be incomplete.',
      ),
    ).toBe(true);
    expect(
      isRetryableApiErrorText(
        'API Error: Response stalled mid-stream. The response above may be incomplete.',
      ),
    ).toBe(true);
    expect(isRetryableApiErrorText('API Error: Connection error.')).toBe(true);
    expect(isRetryableApiErrorText('API Error: Request timed out.')).toBe(true);
  });

  it('leaves alone the errors a re-send reproduces exactly', () => {
    expect(
      isRetryableApiErrorText(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
          '"message":"prompt is too long: 234523 tokens > 200000 maximum"}}',
      ),
    ).toBe(false);
    expect(
      isRetryableApiErrorText('API Error: 400 Output blocked by content filtering policy'),
    ).toBe(false);
    expect(isRetryableApiErrorText('API Error: 401 Unauthorized')).toBe(false);
  });

  // The status wins over anything the body happens to say: a 400 is a 400.
  it('does not let body wording override the status', () => {
    expect(isRetryableApiErrorText('API Error: 400 the request timed out earlier')).toBe(false);
  });

  it('does not retry what it cannot place', () => {
    expect(isRetryableApiErrorText('API Error: something new nobody has seen')).toBe(false);
    expect(isRetryableApiErrorText('all good')).toBe(false);
    expect(isRetryableApiErrorText(null)).toBe(false);
  });

  // Every distinct `API Error:` reply in the production database, verbatim, with the call this
  // classifier has to make on each. Guessing at wording is what the marker list forbids, so the
  // list of things actually seen in the wild is the test: a new one shows up here first.
  it.each([
    ['API Error: 400 Output blocked by content filtering policy', false],
    ['API Error: Output blocked by content filtering policy', false],
    ['API Error: 402 Insufficient Balance', false],
    ['API Error: an image in the conversation could not be processed and was removed.', false],
    ['API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again', true],
    ['API Error: Overloaded', true],
    ['API Error: 500 Internal server error. This is a server-side issue, usually temporary', true],
    // The same failure without a status: the runtime prints one only when it got a response.
    ['API Error: Internal server error', true],
    ['API Error: Connection closed mid-response. The response above may be incomplete.', true],
  ])('%s → retryable: %s', (text, retryable) => {
    expect(isRetryableApiErrorText(text as string)).toBe(retryable);
  });
});

describe('isAuthErrorText', () => {
  it('flags the expired-OAuth text the runtime emits', () => {
    expect(
      isAuthErrorText('Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toBe(true);
    expect(isAuthErrorText('  Failed to authenticate: invalid API key')).toBe(true);
  });
  it('ignores normal text', () => {
    expect(isAuthErrorText('all good')).toBe(false);
    expect(isAuthErrorText(null)).toBe(false);
  });
  // The two are disjoint: each drives a different UI (bare error line vs sign-in guidance).
  it('does not overlap with isApiErrorText', () => {
    expect(isApiErrorText('Failed to authenticate: OAuth session expired')).toBe(false);
    expect(isAuthErrorText('API Error: 500')).toBe(false);
  });
});

describe('isUsageLimitErrorText', () => {
  // Verbatim from a FAILED session's `error`, the Codex app-server wording.
  const codex =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to " +
    'purchase more credits or try again at Aug 9th, 2026 1:26 PM.';
  it('flags a spent provider quota', () => {
    expect(isUsageLimitErrorText(codex)).toBe(true);
    expect(isUsageLimitErrorText(codex.toUpperCase())).toBe(true);
  });
  it('ignores failures that are about the run itself', () => {
    expect(isUsageLimitErrorText('API Error: 500')).toBe(false);
    expect(isUsageLimitErrorText('run failed')).toBe(false);
    expect(isUsageLimitErrorText(null)).toBe(false);
  });
  // A reply that investigates a quota outage quotes the provider's sentence mid-paragraph.
  // Reading that as the provider refusing to answer replaced the answer, in the transcript,
  // with a card announcing a limit the account had not hit.
  it('does not mistake an answer *about* a quota outage for one', () => {
    expect(
      isUsageLimitErrorText(
        '27 of the 28 runs failed, all with the same error from codex: ' + `"${codex}"`,
      ),
    ).toBe(false);
  });
  it('still reads a reply whose sentence is only led into', () => {
    expect(isUsageLimitErrorText('\n\n' + codex)).toBe(true);
    expect(isUsageLimitErrorText('You have hit your weekly limit · resets 1pm (Europe/Berlin)')).toBe(
      true,
    );
  });
});

describe('isBenignEngineStderr', () => {
  // Verbatim from `claude -p` started with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN set — i.e.
  // every turn of every session on a configured provider.
  it('flags the connectors notice Orbit’s own env injection provokes', () => {
    expect(
      isBenignEngineStderr(
        '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth ' +
          'source is set and takes precedence over your claude.ai login · Unset it to load ' +
          "your organization's connectors\n",
      ),
    ).toBe(true);
  });
  it('keeps stderr that explains why a runtime failed', () => {
    expect(isBenignEngineStderr('No conversation found with session ID: abc')).toBe(false);
    expect(isBenignEngineStderr('')).toBe(false);
    expect(isBenignEngineStderr(null)).toBe(false);
  });
});
