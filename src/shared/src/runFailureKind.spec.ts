import { describe, expect, it } from 'vitest';
import {
  RunFailureKind,
  isLoginFailureText,
  legacyRunFailureKind,
  normalizeRunFailure,
  parseRunFailureKind,
  runFailureIs,
  runFailureKind,
} from './runFailureKind';

// The sentences are the recorded ones the legacy markers were written for (events.ts comments, the runner's
// cursorUsageLimitText, the 2026-11-13 edge block).
const CODEX_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 9th, 2026 1:26 PM.";
const CLAUDE_SESSION_LIMIT = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";
const CURSOR_LIMIT = `You've hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."`;
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const EDGE_BLOCK = 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare';
const SIGNED_OUT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const CODEX_SIGNED_OUT = 'Not logged in. Run codex login.';
const CURSOR_PAYMENT = `Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.`;

describe('runFailureKind', () => {
  it('prefers the structured kind the runner sent over what the text says', () => {
    expect(runFailureKind({ failureKind: 'ACCOUNT_ACTION_REQUIRED', error: CURSOR_PAYMENT }))
      .toBe(RunFailureKind.ACCOUNT_ACTION_REQUIRED);
    // The text reads as a usage limit, the adapter said otherwise: the adapter wins.
    expect(runFailureKind({ failureKind: 'REQUEST_REFUSED', error: CODEX_LIMIT })).toBe(RunFailureKind.REQUEST_REFUSED);
    expect(runFailureKind({ failureKind: 'TRANSPORT', error: SIGNED_OUT })).toBe(RunFailureKind.TRANSPORT);
  });

  it('reads every structured kind back as itself', () => {
    for (const kind of Object.values(RunFailureKind)) {
      expect(runFailureKind({ failureKind: kind, error: null })).toBe(kind);
    }
  });

  it('falls back to the legacy markers when the runner sent no kind (an older runner)', () => {
    expect(runFailureKind({ failureKind: null, error: CODEX_LIMIT })).toBe(RunFailureKind.USAGE_LIMIT);
    expect(runFailureKind({ failureKind: null, error: CLAUDE_SESSION_LIMIT })).toBe(RunFailureKind.USAGE_LIMIT);
    expect(runFailureKind({ failureKind: null, error: CURSOR_LIMIT })).toBe(RunFailureKind.USAGE_LIMIT);
    expect(runFailureKind({ failureKind: null, error: CAPACITY })).toBe(RunFailureKind.CAPACITY);
    expect(runFailureKind({ failureKind: null, error: EDGE_BLOCK })).toBe(RunFailureKind.TRANSPORT);
    expect(runFailureKind({ failureKind: null, error: SIGNED_OUT })).toBe(RunFailureKind.CREDENTIAL_REFUSED);
    expect(runFailureKind({ failureKind: null, error: CODEX_SIGNED_OUT })).toBe(RunFailureKind.CREDENTIAL_REFUSED);
    // A run row from before the column, and a SubAgent body with no field, read the same way.
    expect(runFailureKind({ error: CODEX_LIMIT })).toBe(RunFailureKind.USAGE_LIMIT);
  });

  it('adds no markers: the incident sentence with no kind stays unclassified', () => {
    expect(runFailureKind({ failureKind: null, error: CURSOR_PAYMENT })).toBeNull();
    expect(runFailureKind({ failureKind: null, error: 'Cursor CLI failed this turn: Error: boom' })).toBeNull();
    expect(runFailureKind({ failureKind: null, error: null })).toBeNull();
    expect(runFailureKind({ failureKind: null, error: '' })).toBeNull();
  });

  it('keeps the usage-limit anchor: a reply quoting the sentence further in is not a spent quota', () => {
    const quoted = `I looked into the earlier failure in detail and the log there said: ${CODEX_LIMIT}`;
    expect(runFailureKind({ failureKind: null, error: quoted })).toBeNull();
  });

  it('reads a kind this server does not know through the markers, as an older server would', () => {
    expect(runFailureKind({ failureKind: 'SOMETHING_NEWER', error: CODEX_LIMIT })).toBe(RunFailureKind.USAGE_LIMIT);
    expect(runFailureKind({ failureKind: 'SOMETHING_NEWER', error: CURSOR_PAYMENT })).toBeNull();
  });

  it('never reads an edge block as a sign-in', () => {
    expect(legacyRunFailureKind(EDGE_BLOCK)).toBe(RunFailureKind.TRANSPORT);
    expect(isLoginFailureText(EDGE_BLOCK)).toBe(false);
  });
});

describe('parseRunFailureKind', () => {
  it('accepts only the known kinds', () => {
    expect(parseRunFailureKind('CAPACITY')).toBe(RunFailureKind.CAPACITY);
    expect(parseRunFailureKind('capacity')).toBeNull();
    expect(parseRunFailureKind(undefined)).toBeNull();
    expect(parseRunFailureKind(42)).toBeNull();
  });
});

describe('normalizeRunFailure', () => {
  it('keeps a known kind, a known scope and the provider words clipped to 300 characters', () => {
    expect(normalizeRunFailure({ kind: 'CAPACITY', scope: 'model', said: 'Selected model is at capacity' }))
      .toEqual({ kind: RunFailureKind.CAPACITY, scope: 'model', said: 'Selected model is at capacity' });
    expect(normalizeRunFailure({ kind: 'ACCOUNT_ACTION_REQUIRED', said: 'x'.repeat(400) })?.said).toHaveLength(300);
  });

  it('drops an unknown scope and an empty said', () => {
    expect(normalizeRunFailure({ kind: 'USAGE_LIMIT', scope: 'planet', said: '  ' }))
      .toEqual({ kind: RunFailureKind.USAGE_LIMIT, scope: null, said: null });
  });

  it('is null for an absent, malformed or unknown failure', () => {
    expect(normalizeRunFailure(undefined)).toBeNull();
    expect(normalizeRunFailure('USAGE_LIMIT')).toBeNull();
    expect(normalizeRunFailure({ kind: 'NEWER_KIND' })).toBeNull();
  });
});

describe('runFailureIs and the per-caller legacy reading', () => {
  const LATE = `Nothing answered this message across 3 deliveries of it to the engine.\n\n${CODEX_LIMIT}`;

  it("reads a usage-limit marker where each replaced site read it", () => {
    expect(LATE.toLowerCase().indexOf('hit your usage limit')).toBeGreaterThan(40);
    // The route history and the SQL filters matched a substring anywhere.
    expect(runFailureIs({ error: LATE }, [RunFailureKind.USAGE_LIMIT], { usageLimit: 'anywhere' })).toBe(true);
    // isUsageLimitErrorText's callers matched it at the opening only.
    expect(runFailureIs({ error: LATE }, [RunFailureKind.USAGE_LIMIT])).toBe(false);
    expect(runFailureIs({ error: CODEX_LIMIT }, [RunFailureKind.USAGE_LIMIT])).toBe(true);
  });

  it('reads a refused credential as isAuthErrorText alone where that was the test', () => {
    for (const opening of [CODEX_SIGNED_OUT, 'OAuth session expired']) {
      expect(runFailureIs({ error: opening }, [RunFailureKind.CREDENTIAL_REFUSED], { credential: 'authenticate' })).toBe(false);
      expect(runFailureIs({ error: opening }, [RunFailureKind.CREDENTIAL_REFUSED])).toBe(true);
    }
    expect(runFailureIs({ error: SIGNED_OUT }, [RunFailureKind.CREDENTIAL_REFUSED], { credential: 'authenticate' })).toBe(true);
    expect(runFailureIs({ error: EDGE_BLOCK }, [RunFailureKind.CREDENTIAL_REFUSED], { credential: 'authenticate' })).toBe(false);
  });

  it('tests each kind on its own, so a text with two markers answers both', () => {
    const both = `${CODEX_LIMIT} The model is at capacity too.`;
    expect(runFailureIs({ error: both }, [RunFailureKind.USAGE_LIMIT])).toBe(true);
    expect(runFailureIs({ error: both }, [RunFailureKind.CAPACITY])).toBe(true);
  });

  it("lets the runner's kind decide over every reading", () => {
    expect(runFailureIs({ failureKind: 'CAPACITY', error: LATE }, [RunFailureKind.USAGE_LIMIT], { usageLimit: 'anywhere' })).toBe(false);
    expect(runFailureIs({ failureKind: 'CREDENTIAL_REFUSED', error: CODEX_SIGNED_OUT }, [RunFailureKind.CREDENTIAL_REFUSED],
      { credential: 'authenticate' })).toBe(true);
    // A kind this server does not know reads through the words.
    expect(runFailureIs({ failureKind: 'NEWER', error: CODEX_LIMIT }, [RunFailureKind.USAGE_LIMIT])).toBe(true);
  });
});
