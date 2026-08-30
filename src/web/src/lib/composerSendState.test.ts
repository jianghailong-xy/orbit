import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composerDraftAfterSend,
  logicalSendToken,
  resolveConflictLogicalSendToken,
} from './composerSendState';

afterEach(() => vi.unstubAllGlobals());

describe('composer draft after CURRENT_WORK routing', () => {
  it('clears only after an accepted server receipt', () => {
    expect(composerDraftAfterSend('adjust this', true)).toBe('');
  });

  it('preserves the draft after an explicit 409 rejection', () => {
    expect(composerDraftAfterSend('adjust this', false)).toBe('adjust this');
  });
});

describe('status-bar conflict resolution idempotency', () => {
  it('reuses one resume operation after commit-response loss and rotates it on an edited target', () => {
    let serial = 0;
    const mint = () => `resolve-${++serial}`;
    const payload = {
      sessionId: 's1',
      branch: 'orbit/work',
      target: 'main',
      content: 'rebase onto main',
    };
    const committedButLost = resolveConflictLogicalSendToken(null, payload, mint);
    const retry = resolveConflictLogicalSendToken(committedButLost, payload, mint);
    const edited = resolveConflictLogicalSendToken(retry, { ...payload, target: 'release' }, mint);

    expect(retry).toEqual(committedButLost);
    expect(edited.clientTurnId).not.toBe(retry.clientTurnId);
    expect(serial).toBe(2);
  });
});

describe('logical send idempotency token', () => {
  it('reuses the key after commit-response loss when the wire payload is unchanged', () => {
    let serial = 0;
    const mint = () => `operation-${++serial}`;
    const payload = { sessionId: 's1', content: 'adjust', intent: 'CURRENT_WORK' };
    const first = logicalSendToken(null, payload, mint);
    const retry = logicalSendToken(first, payload, mint);
    expect(retry).toEqual(first);
    expect(serial).toBe(1);
  });

  it('mints a new key only after the authored payload changes', () => {
    let serial = 0;
    const mint = () => `operation-${++serial}`;
    const first = logicalSendToken(null, { content: 'adjust' }, mint);
    const edited = logicalSendToken(first, { content: 'adjust this instead' }, mint);
    expect(edited.clientTurnId).not.toBe(first.clientTurnId);
    expect(serial).toBe(2);
  });

  it('uses the shared getRandomValues fallback and reuses it when randomUUID is absent', () => {
    let fill = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        fill += 1;
        bytes.set(Array.from({ length: 16 }, (_, index) => index + fill));
        return bytes;
      },
    });
    const payload = { sessionId: 's1', content: 'adjust', intent: 'CURRENT_WORK' };

    const first = logicalSendToken(null, payload);
    const retry = logicalSendToken(first, payload);

    expect(first.clientTurnId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retry).toEqual(first);
    expect(fill).toBe(1, 'an uncertain-response retry must not mint a second operation key');
  });
});
