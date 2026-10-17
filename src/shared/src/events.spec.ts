import { describe, expect, it } from 'vitest';
import {
  isApiErrorText,
  isAsyncAgentLaunchAck,
  isAuthErrorText,
  isBenignEngineStderr,
  isRateLimitApiErrorText,
  isRetryableApiErrorText,
  isUsageLimitErrorText,
  RATE_LIMIT_ENGINE_ERROR_PREFIX,
  RETRYABLE_ENGINE_ERROR_PREFIXES,
  toolResultText,
  workflowLaunchReceipt,
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

describe('workflowLaunchReceipt', () => {
  // Verbatim from a production session (claude 2.1.282), transcript dir shortened.
  const RECEIPT =
    'Workflow launched in background. Task ID: w2f3yv1s8\n' +
    'Summary: First-principles + web research on the right artifact form; 3 competing designs; 2 judges\n' +
    'Transcript dir: /root/.claude/projects/x/subagents/workflows/wf_37d4e19e-c97';

  it('reads the task id and summary off a launch receipt', () => {
    expect(workflowLaunchReceipt(RECEIPT)).toEqual({
      taskId: 'w2f3yv1s8',
      summary: 'First-principles + web research on the right artifact form; 3 competing designs; 2 judges',
    });
    expect(workflowLaunchReceipt([{ type: 'text', text: RECEIPT }])?.taskId).toBe('w2f3yv1s8');
  });

  it('is null for anything that is not the receipt itself', () => {
    expect(workflowLaunchReceipt('Error: script must begin with export const meta')).toBeNull();
    expect(workflowLaunchReceipt(`The tool said: ${RECEIPT}`)).toBeNull();
    expect(workflowLaunchReceipt(null)).toBeNull();
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

  // Verbatim from a DeepSeek session: the stream stayed silent until the runtime's watchdog gave
  // up, and the non-streaming request it fell back to was answered with something not a reply.
  it('flags the runtime’s non-streaming fallback failing after a dead stream', () => {
    expect(
      isRetryableApiErrorText(
        'API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy ' +
          'or gateway intercepting the request. Response: content-type json, body is JSON but ' +
          'not a Message, size unknown, request-id absent, server other, intermediary headers ' +
          'content-encoding transfer-encoding via x-amz-* x-cache. This was the non-streaming ' +
          'retry of streaming request (no Anthropic request-id), which failed with: watchdog; ' +
          '0 stream events received.',
      ),
    ).toBe(true);
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
    // The wrapper shape is equally authoritative.
    expect(
      isRetryableApiErrorText(
        'API Error: Request rejected (400) · Output blocked by content filtering policy',
      ),
    ).toBe(false);
  });

  // Codex words its own and reports it as the turn's error, with no `API Error` prefix.
  it('flags a runtime naming the overload in its own words', () => {
    expect(
      isRetryableApiErrorText('Selected model is at capacity. Please try a different model.'),
    ).toBe(true);
    expect(
      isRetryableApiErrorText('  Selected model is at capacity. Please try a different model.'),
    ).toBe(true);
    // Only as the whole message: a reply that investigates one quotes it mid-paragraph.
    expect(
      isRetryableApiErrorText(
        'The run died on "Selected model is at capacity. Please try a different model." — retrying.',
      ),
    ).toBe(false);
  });

  it('flags Codex exhausting its request retries on a 429', () => {
    const error = 'exceeded retry limit, last status: 429 Too Many Requests';
    expect(
      isRetryableApiErrorText(`${error}, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2`),
    ).toBe(true);
    expect(isRetryableApiErrorText(error)).toBe(true);
    expect(isRetryableApiErrorText(`  ${error}`)).toBe(true);
    expect(isRetryableApiErrorText(`The run failed with "${error}".`)).toBe(false);
    expect(isRetryableApiErrorText('exceeded retry limit')).toBe(false);
    expect(isRetryableApiErrorText('exceeded retry limit, last status: 400 Bad Request')).toBe(false);
    expect(isRetryableApiErrorText('exceeded retry limit, last status: 401 Unauthorized')).toBe(false);
  });

  it('tells a rate limit apart from the rest of the transient list — the one a pool can answer', () => {
    const error = 'exceeded retry limit, last status: 429 Too Many Requests';
    expect(isRateLimitApiErrorText(`${error}, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2`)).toBe(true);
    expect(isRateLimitApiErrorText(`  ${error}`)).toBe(true);
    // Still retryable: the pool's answer is preferred where there is one, not the classification replaced.
    expect(isRetryableApiErrorText(error)).toBe(true);
    // An overloaded model is transient too, and says nothing about the credential a session runs on — and
    // an unplaced 429 is not one codex worded this way.
    expect(isRateLimitApiErrorText('selected model is at capacity')).toBe(false);
    expect(isRateLimitApiErrorText('API Error: 529 overloaded_error')).toBe(false);
    expect(isRateLimitApiErrorText('exceeded retry limit')).toBe(false);
    expect(isRateLimitApiErrorText(null)).toBe(false);
    // The prefix is spelled twice on purpose: the list holds the literal so that macos/OrbitKit's
    // EngineErrorsParityTests, which parses that list's own source text, can see it — an entry that is a
    // reference, or one that arrives through a spread, is invisible to it. This is what keeps the two
    // spellings equal; without it, editing one and not the other is a silent drift between what Orbit
    // retries on and what it treats as a rate limit.
    expect(RETRYABLE_ENGINE_ERROR_PREFIXES).toContain(RATE_LIMIT_ENGINE_ERROR_PREFIX);
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
    // The account rate limit (an API key) in the runtime's wrapper shape, where the status sits
    // mid-sentence instead of leading — it is the same 429.
    [
      "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
      true,
    ],
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
  // Verbatim from a DeepSeek session's run_event rows: one per request the CLI issues, including
  // the internal one it makes to name its own resume entry. Six sessions here opened on a red row.
  it('flags the unrecognized-model notice a borrowed runtime’s model id provokes', () => {
    expect(
      isBenignEngineStderr(
        '[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}\n',
      ),
    ).toBe(true);
    expect(
      isBenignEngineStderr(
        '[claude-code:unrecognized_model] ' +
          '{"model":"deepseek-v4-pro","query_source":"generate_session_title"}\n',
      ),
    ).toBe(true);
  });
  it('keeps stderr that explains why a runtime failed', () => {
    expect(isBenignEngineStderr('No conversation found with session ID: abc')).toBe(false);
    // A model the endpoint itself rejects is a real failure, and says so in its own words.
    expect(isBenignEngineStderr('API Error: 400 model "deepseek-v4-pro" not found')).toBe(false);
    expect(isBenignEngineStderr('')).toBe(false);
    expect(isBenignEngineStderr(null)).toBe(false);
  });
});
