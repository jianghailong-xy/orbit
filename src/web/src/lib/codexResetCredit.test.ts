import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_RATE_LIMIT_RESET_ENUMS,
  CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS,
  codexRateLimitResetOf,
  codexResetCreditDetails,
  codexResetRefusal,
  type CodexRateLimitResetRefusalCode,
} from '@orbit/shared';
import { ApiError } from '../api';
import {
  CODEX_RESET_REFUSAL_REASON,
  CODEX_RESET_UNREFRESHED_SPEND_REASON,
  clearCodexResetIntent,
  codexResetCard,
  codexResetCountLabel,
  codexResetCreateFailure,
  codexResetExpiry,
  codexResetFreshness,
  codexResetLookUp,
  codexResetResume,
  codexResetStatusCopy,
  decodeCodexResetOperation,
  decodeCodexResetOperations,
  readCodexResetIntent,
  writeCodexResetIntent,
  type CodexResetIntent,
  type CodexResetRunner,
} from './codexResetCredit';
import {
  OTHER_FINGERPRINT,
  RESET_FINGERPRINT,
  RESET_REQUEST_ID,
  resetBlock,
  resetCredit,
  resetOperation,
  resetRunner,
} from './codexResetCredit.fixtures';

const NOW = new Date('2026-09-11T12:00:00.000Z');
/** A formatter that shows exactly which instant a label was built from. */
const day = (iso: string) => iso.slice(0, 10);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('which reset entry a runner gets', () => {
  it('offers the button to an online default Codex account with a fresh block, credits, the capability and a lease', () => {
    const card = codexResetCard(resetRunner(NOW), NOW, false);
    expect(card?.availability).toEqual({ kind: 'ready' });
    expect(card?.accountFingerprint).toBe(RESET_FINGERPRINT);
  });

  const blocked: { name: string; runner: CodexResetRunner; code: CodexRateLimitResetRefusalCode }[] = [
    { name: 'the runner is offline', runner: resetRunner(NOW, { online: false }), code: 'RUNNER_OFFLINE' },
    { name: 'an older list omits online', runner: resetRunner(NOW, { online: undefined }), code: 'RUNNER_OFFLINE' },
    { name: 'the capability is not declared', runner: resetRunner(NOW, { capabilities: [] }), code: 'CAPABILITY_MISSING' },
    {
      name: 'an older control plane sends no capabilities',
      runner: resetRunner(NOW, { capabilities: undefined }),
      code: 'CAPABILITY_MISSING',
    },
    { name: 'there is no lease owner', runner: resetRunner(NOW, { heartbeatLeaseOwner: null }), code: 'NO_ACTIVE_LEASE' },
    { name: 'the runner is draining', runner: resetRunner(NOW, { heartbeatDraining: true }), code: 'RUNNER_DRAINING' },
    {
      name: 'the snapshot is 16 minutes old',
      runner: resetRunner(NOW, {}, resetBlock(NOW, { fetchedAt: minutesAgo(16) })),
      code: 'SNAPSHOT_STALE',
    },
    {
      name: 'the snapshot claims to come from 6 minutes ahead',
      runner: resetRunner(NOW, {}, resetBlock(NOW, { fetchedAt: minutesAgo(-6) })),
      code: 'SNAPSHOT_STALE',
    },
    {
      name: 'Codex has no credits summary',
      runner: resetRunner(NOW, {}, resetBlock(NOW, { support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null })),
      code: 'CREDITS_UNAVAILABLE',
    },
    {
      name: 'the count is zero',
      runner: resetRunner(NOW, {}, resetBlock(NOW, { rateLimitResetCredits: { availableCount: 0, credits: [] } })),
      code: 'NO_CREDIT_AVAILABLE',
    },
  ];
  for (const each of blocked) {
    it(`disables it with the reason when ${each.name}, on the create route's own answer`, () => {
      expect(codexResetCard(each.runner, NOW, false)?.availability).toEqual({
        kind: 'blocked',
        code: each.code,
        reason: CODEX_RESET_REFUSAL_REASON[each.code],
      });
      // The same function the API refuses with, over the inputs GET /runners carries.
      expect(
        codexResetRefusal({
          now: NOW,
          accountOverride: false,
          activeOperation: false,
          runnerOnline: each.runner.online === true,
          runnerCapabilities: each.runner.capabilities,
          heartbeatLeaseOwner: each.runner.heartbeatLeaseOwner,
          runnerDraining: each.runner.heartbeatDraining === true,
          rateLimitReset: codexRateLimitResetOf(each.runner.planUsage),
          expectedAccountFingerprint: RESET_FINGERPRINT,
        }),
      ).toBe(each.code);
    });
  }

  it('an operation already in flight takes the entry over first, even from an offline runner', () => {
    expect(codexResetCard(resetRunner(NOW, { online: false }), NOW, true)?.availability).toEqual({ kind: 'in-flight' });
  });

  it('checks in the contract order: offline outranks a stale snapshot and zero credits', () => {
    const runner = resetRunner(
      NOW,
      { online: false },
      resetBlock(NOW, { fetchedAt: minutesAgo(30), rateLimitResetCredits: { availableCount: 0, credits: [] } }),
    );
    expect(codexResetCard(runner, NOW, false)?.availability).toMatchObject({ code: 'RUNNER_OFFLINE' });
  });

  it('hides it where the contract hides it, or where there is nothing authoritative to show', () => {
    const hidden: CodexResetRunner[] = [
      { ...resetRunner(NOW), planUsage: null },
      resetRunner(NOW, {}, null),
      { ...resetRunner(NOW), planUsage: { claude: { fiveHour: { utilization: 40 } } } },
      ...(['UNSUPPORTED_AUTH', 'PROVIDER_UNSUPPORTED', 'ACCOUNT_UNIDENTIFIED'] as const).map((support) =>
        resetRunner(NOW, {}, resetBlock(NOW, { support, accountFingerprint: undefined, rateLimitResetCredits: null })),
      ),
      // A block that breaks the contract is not believed, count included.
      resetRunner(NOW, {}, resetBlock(NOW, { accountFingerprint: 'cxa1_NOT-A-FINGERPRINT' })),
      resetRunner(NOW, {}, resetBlock(NOW, { rateLimitResetCredits: { availableCount: -1, credits: null } })),
    ];
    for (const runner of hidden) expect(codexResetCard(runner, NOW, false)).toBeNull();
  });

  it('reads a single-provider flat Codex snapshot the same way', () => {
    const nested = resetRunner(NOW);
    const flat = { ...nested, planUsage: nested.planUsage!.codex };
    expect(codexResetCard(flat, NOW, false)?.availability).toEqual({ kind: 'ready' });
  });
});

describe('after a reset that may have used a credit no refresh confirmed', () => {
  /** What the create route answers for this runner, given the readRequiredAfter it reads for the account
   *  (CodexRateLimitResetRepository.unrefreshedSpendSettledAt). */
  const admission = (runner: CodexResetRunner, readRequiredAfter: string | null) =>
    codexResetRefusal({
      now: NOW,
      accountOverride: false,
      activeOperation: false,
      runnerOnline: runner.online === true,
      runnerCapabilities: runner.capabilities,
      heartbeatLeaseOwner: runner.heartbeatLeaseOwner,
      runnerDraining: runner.heartbeatDraining === true,
      rateLimitReset: codexRateLimitResetOf(runner.planUsage),
      expectedAccountFingerprint: RESET_FINGERPRINT,
      readRequiredAfter,
    });
  const readAt = (fetchedAt: string) => resetRunner(NOW, {}, resetBlock(NOW, { fetchedAt }));
  const shifted = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

  // consumeState UNRESOLVED, and consumeState CONFIRMED with refreshState FAILED: both settle 30 s before NOW.
  for (const settled of [resetOperation('UNRESOLVED'), resetOperation('REFRESH_FAILED')]) {
    const completedAt = settled.completedAt!;
    const operations = { active: null, latest: settled };

    it(`${settled.status}: a block read no later than completedAt is blocked as SNAPSHOT_STALE, as the create route refuses it`, () => {
      for (const fetchedAt of [minutesAgo(2), shifted(completedAt, -1), completedAt]) {
        const runner = readAt(fetchedAt);
        expect({ fetchedAt, availability: codexResetCard(runner, NOW, false, operations)?.availability }).toEqual({
          fetchedAt,
          availability: { kind: 'blocked', code: 'SNAPSHOT_STALE', reason: CODEX_RESET_UNREFRESHED_SPEND_REASON },
        });
        expect({ fetchedAt, admission: admission(runner, completedAt) }).toEqual({ fetchedAt, admission: 'SNAPSHOT_STALE' });
      }
    });

    it(`${settled.status}: a block read after completedAt is ready, as the create route admits it`, () => {
      const runner = readAt(shifted(completedAt, 1));
      expect(codexResetCard(runner, NOW, false, operations)?.availability).toEqual({ kind: 'ready' });
      expect(admission(runner, completedAt)).toBeNull();
    });
  }

  it('asks for no newer read after another account’s settlement, or after one that spent nothing or was refreshed', () => {
    const runner = readAt(minutesAgo(2));
    const latest = [
      resetOperation('UNRESOLVED', { accountFingerprint: OTHER_FINGERPRINT }),
      resetOperation('REFRESH_FAILED', { accountFingerprint: OTHER_FINGERPRINT }),
      ...(['SUCCEEDED', 'NOTHING_TO_RESET', 'NO_CREDIT', 'NOT_ATTEMPTED'] as const).map((status) => resetOperation(status)),
    ];
    for (const op of latest) {
      const availability = codexResetCard(runner, NOW, false, { active: null, latest: op })?.availability;
      expect({ status: op.status, account: op.accountFingerprint, availability }).toEqual({
        status: op.status,
        account: op.accountFingerprint,
        availability: { kind: 'ready' },
      });
    }
    // None of them is a row the create route's readRequiredAfter reads for this account.
    expect(admission(runner, null)).toBeNull();
  });

  it('keeps the out-of-date reason for a block past the freshness window, whatever settled before it', () => {
    const operations = { active: null, latest: resetOperation('UNRESOLVED') };
    expect(codexResetCard(readAt(minutesAgo(16)), NOW, false, operations)?.availability).toEqual({
      kind: 'blocked',
      code: 'SNAPSHOT_STALE',
      reason: CODEX_RESET_REFUSAL_REASON.SNAPSHOT_STALE,
    });
  });

  it('tells the reader a credit may be gone and when to try again, and never that none was used', () => {
    expect(CODEX_RESET_UNREFRESHED_SPEND_REASON).toContain('may have used a credit');
    expect(CODEX_RESET_UNREFRESHED_SPEND_REASON).toContain('Try again once the runner refreshes it');
    expect(CODEX_RESET_UNREFRESHED_SPEND_REASON).not.toMatch(/no credit|not used|out of date/i);
  });
});

describe('the count and expiry say what Codex reported and nothing more', () => {
  const blockWith = (availableCount: number, credits: ReturnType<typeof resetCredit>[] | null) =>
    resetBlock(NOW, { rateLimitResetCredits: { availableCount, credits } });

  it('with no credit details, keeps the count and says expiry was not reported', () => {
    const block = blockWith(7, null);
    expect(codexResetCountLabel(codexResetCreditDetails(block))).toBe('7 available');
    expect(codexResetExpiry(block, day)).toEqual({ label: 'Expiry not reported', at: null });
  });

  it('with a capped list, counts from availableCount and marks the earliest date as only the listed ones', () => {
    const block = blockWith(5, [
      resetCredit({ id: 'a', expiresAt: '2026-09-20T00:00:00Z' }),
      resetCredit({ id: 'b', expiresAt: '2026-09-16T09:00:00Z' }),
    ]);
    const label = codexResetCountLabel(codexResetCreditDetails(block));
    expect(label).toBe('5 available');
    expect(label).not.toBe(`${block.rateLimitResetCredits!.credits!.length} available`);
    expect(codexResetExpiry(block, day)).toEqual({
      label: 'Earliest listed expires 2026-09-16 · partial list',
      at: '2026-09-16T09:00:00Z',
    });
  });

  it('with the whole list, names the one expiry or the next of several', () => {
    expect(codexResetExpiry(blockWith(1, [resetCredit()]), day)?.label).toBe('Expires 2026-09-16');
    const several = blockWith(3, [
      resetCredit({ id: 'a', expiresAt: '2026-09-30T00:00:00Z' }),
      resetCredit({ id: 'b', expiresAt: '2026-09-16T09:00:00Z' }),
      resetCredit({ id: 'c', expiresAt: null }),
    ]);
    expect(codexResetExpiry(several, day)?.label).toBe('Next expires 2026-09-16');
  });

  it('says a credit does not expire only when every available credit is listed without an expiry', () => {
    expect(
      codexResetExpiry(blockWith(2, [resetCredit({ id: 'a', expiresAt: null }), resetCredit({ id: 'b', expiresAt: null })]), day)
        ?.label,
    ).toBe('Doesn’t expire');
    // One listed credit is mid-redeem: the list holds fewer available credits than the count.
    const mixed = blockWith(2, [
      resetCredit({ id: 'a', expiresAt: null }),
      resetCredit({ id: 'b', status: 'redeeming', expiresAt: '2026-09-12T00:00:00Z' }),
    ]);
    expect(codexResetExpiry(mixed, day)?.label).toBe('Listed credits don’t expire · partial list');
    // Nothing listed is available at all: no claim about expiry either way.
    expect(codexResetExpiry(blockWith(1, [resetCredit({ status: 'redeeming' })]), day)?.label).toBe('Expiry not reported');
    expect(codexResetExpiry(blockWith(3, []), day)?.label).toBe('Expiry not reported');
  });

  it('draws no expiry for zero credits, and no count when Codex has no summary', () => {
    const zero = blockWith(0, []);
    expect(codexResetCountLabel(codexResetCreditDetails(zero))).toBe('0 available');
    expect(codexResetExpiry(zero, day)).toBeNull();
    const unavailable = resetBlock(NOW, { support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null });
    expect(codexResetCountLabel(codexResetCreditDetails(unavailable))).toBe('Count unavailable');
    expect(codexResetExpiry(unavailable, day)).toBeNull();
  });
});

describe('snapshot freshness', () => {
  it('reads the age off fetchedAt and marks what admission would call stale', () => {
    expect(codexResetFreshness(resetBlock(NOW, { fetchedAt: minutesAgo(0.5) }), NOW)).toEqual({
      label: 'Updated just now',
      stale: false,
    });
    expect(codexResetFreshness(resetBlock(NOW, { fetchedAt: minutesAgo(2) }), NOW)).toEqual({
      label: 'Updated 2 min ago',
      stale: false,
    });
    expect(codexResetFreshness(resetBlock(NOW, { fetchedAt: minutesAgo(16) }), NOW)).toEqual({
      label: 'Updated 16 min ago · out of date',
      stale: true,
    });
    expect(codexResetFreshness(resetBlock(NOW, { fetchedAt: minutesAgo(190) }), NOW).label).toBe(
      'Updated 3 h ago · out of date',
    );
    expect(codexResetFreshness(resetBlock(NOW, { fetchedAt: minutesAgo(-6) }), NOW)).toEqual({
      label: "Updated at a time ahead of this device's clock",
      stale: true,
    });
  });
});

describe('what an operation tells the person who confirmed it', () => {
  const online = { runnerOnline: true, accountChanged: false };

  it('says a credit was used exactly when the consume is confirmed with reset or alreadyRedeemed', () => {
    const statuses = CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus;
    for (const status of statuses) {
      for (const outcome of ['reset', 'alreadyRedeemed'] as const) {
        const op = resetOperation(status, { outcome, failureCode: status === 'REFRESH_FAILED' ? 'REFRESH_EXPIRED' : undefined });
        const copy = codexResetStatusCopy(op, online);
        const consumed =
          op.consumeState === 'CONFIRMED' &&
          op.consumeOutcome !== null &&
          CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[op.consumeOutcome].consumed;
        expect({ status, outcome, yes: copy.spent === 'yes' }).toEqual({ status, outcome, yes: consumed });
        // "No credit was used" is only ever said where the checkpoints prove it.
        expect({ status, says: copy.detail.includes('No credit was used') }).toEqual({ status, says: copy.spent === 'no' });
      }
    }
  });

  it('never calls a confirmed consume whose refresh failed unused', () => {
    for (const outcome of ['reset', 'alreadyRedeemed'] as const) {
      for (const failureCode of ['REFRESH_EXPIRED', 'ACCOUNT_CHANGED', 'ACCOUNT_MISMATCH'] as const) {
        const copy = codexResetStatusCopy(resetOperation('REFRESH_FAILED', { outcome, failureCode }), online);
        expect(copy).toMatchObject({ tone: 'warning', spent: 'yes', title: 'Limits reset — usage not refreshed' });
        expect(copy.detail).toContain('1 credit');
        expect(copy.detail).toContain("couldn't read the updated usage");
        expect(copy.detail).not.toMatch(/no credit|not used|wasn't used|nothing was reset/i);
      }
    }
    expect(
      codexResetStatusCopy(resetOperation('REFRESH_FAILED', { failureCode: 'ACCOUNT_CHANGED' }), online).detail,
    ).toContain("because the runner's Codex account changed");
  });

  it('draws each of the four provider outcomes as what it was', () => {
    expect(codexResetStatusCopy(resetOperation('SUCCEEDED'), online)).toEqual({
      tone: 'success',
      spent: 'yes',
      title: 'Usage limits reset',
      detail: '1 credit used. Plan usage has been refreshed.',
    });
    expect(codexResetStatusCopy(resetOperation('SUCCEEDED', { outcome: 'alreadyRedeemed' }), online).detail).toBe(
      'Codex had already applied this reset, so no extra credit was used. Plan usage has been refreshed.',
    );
    expect(codexResetStatusCopy(resetOperation('NOTHING_TO_RESET'), online)).toMatchObject({
      tone: 'info',
      spent: 'no',
      title: 'Nothing to reset',
    });
    expect(codexResetStatusCopy(resetOperation('NO_CREDIT'), online)).toMatchObject({
      tone: 'info',
      spent: 'no',
      title: 'No reset credit available',
    });
    expect(codexResetStatusCopy(resetOperation('REFRESHING', { outcome: 'alreadyRedeemed' }), online).title).toBe(
      'Reset already applied — refreshing usage…',
    );
  });

  it('keeps pending honest about the runner being offline, the account moving, and a recoverable error', () => {
    expect(codexResetStatusCopy(resetOperation('PENDING'), online).detail).toBe(
      'Waiting for the runner to pick this up. No credit has been used yet.',
    );
    expect(codexResetStatusCopy(resetOperation('PENDING'), { runnerOnline: false, accountChanged: false }).detail).toBe(
      'Waiting for the runner to come back online. No credit has been used yet.',
    );
    expect(codexResetStatusCopy(resetOperation('PENDING'), { runnerOnline: true, accountChanged: true }).detail).toBe(
      "The runner's Codex account changed, so this reset will stop without using a credit.",
    );
    const retrying = codexResetStatusCopy(resetOperation('CONSUMING', { lastErrorCode: 'PROVIDER_TIMEOUT' }), online);
    expect(retrying).toMatchObject({ tone: 'progress', spent: 'not-yet', title: 'Using reset credit…' });
    expect(retrying.detail).toBe('Codex took too long to answer. Retrying the same request, so at most 1 credit is used.');
    expect(
      codexResetStatusCopy(resetOperation('REFRESHING', { lastErrorCode: 'READ_FAILED' }), online).detail,
    ).toBe(
      "Codex used 1 credit and reset your eligible usage windows. The runner couldn't read the Codex account; retrying the usage refresh.",
    );
    expect(codexResetStatusCopy(resetOperation('REFRESHING'), { runnerOnline: false, accountChanged: false }).detail).toBe(
      'Codex used 1 credit and reset your eligible usage windows. Usage refreshes once the runner reconnects.',
    );
  });

  it('settles account changes, expiry and lost results without guessing', () => {
    expect(codexResetStatusCopy(resetOperation('NOT_ATTEMPTED', { failureCode: 'ACCOUNT_CHANGED' }), online)).toEqual({
      tone: 'warning',
      spent: 'no',
      title: 'Codex account changed',
      detail: 'The runner is signed in to a different Codex account, so nothing was reset. No credit was used.',
    });
    expect(codexResetStatusCopy(resetOperation('NOT_ATTEMPTED', { failureCode: 'CONSUME_EXPIRED' }), online).title).toBe(
      "Reset didn't start",
    );
    const unknown = codexResetStatusCopy(resetOperation('UNRESOLVED', { failureCode: 'ACCOUNT_CHANGED' }), online);
    expect(unknown).toMatchObject({ tone: 'error', spent: 'maybe', title: 'Result unknown' });
    expect(unknown.detail).toContain('A credit may have been used');
  });
});

describe('the operation view as the user API sends it', () => {
  it('drops the public-id twins and any field the contract does not name, then holds the rest to the contract', () => {
    const op = resetOperation('CONSUMING');
    const decoded = decodeCodexResetOperation({
      ...op,
      publicId: op.id,
      runnerPublicId: op.runnerId,
      providerIdempotencyKey: '5f0c4f7e-0d3b-4a1c-9d2e-3b4c5d6e7f80',
    });
    expect(decoded).toEqual(op);
    expect(decoded).not.toHaveProperty('providerIdempotencyKey');
    expect(decodeCodexResetOperation({ ...op, status: 'SUCCEEDED' })).toBeNull();
    expect(decodeCodexResetOperation({ ...op, clientRequestId: 'not-a-uuid' })).toBeNull();
    expect(decodeCodexResetOperations({ active: null, latest: { ...op, publicId: op.id } })).toEqual({ active: null, latest: op });
    expect(decodeCodexResetOperations({ active: { ...op, status: 'NO_CREDIT' }, latest: null })).toBeNull();
  });
});

describe('what a failed create proves', () => {
  it('reads 409 refusals and other 4xx as nothing created, and anything unanswered as unknown', () => {
    expect(
      codexResetCreateFailure(new ApiError('Conflict', 409, 'OPERATION_IN_FLIGHT', { code: 'OPERATION_IN_FLIGHT', operationId: 'op-uuid' })),
    ).toEqual({ kind: 'refused', code: 'OPERATION_IN_FLIGHT', operationId: 'op-uuid' });
    expect(codexResetCreateFailure(new ApiError('Conflict', 409, 'NO_CREDIT_AVAILABLE', { code: 'NO_CREDIT_AVAILABLE' }))).toEqual({
      kind: 'refused',
      code: 'NO_CREDIT_AVAILABLE',
    });
    expect(codexResetCreateFailure(new ApiError('Conflict', 409, 'SOMETHING_NEW'))).toEqual({ kind: 'rejected', status: 409 });
    expect(codexResetCreateFailure(new ApiError('Bad Request', 400))).toEqual({ kind: 'rejected', status: 400 });
    expect(codexResetCreateFailure(new ApiError('Not Found', 404))).toEqual({ kind: 'rejected', status: 404 });
    for (const status of [408, 429, 500, 502, 503]) {
      expect(codexResetCreateFailure(new ApiError('x', status))).toEqual({ kind: 'unanswered' });
    }
    expect(codexResetCreateFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'unanswered' });
    expect(codexResetCreateFailure(new DOMException('The operation was aborted.', 'AbortError'))).toEqual({ kind: 'unanswered' });
  });
});

describe('a confirmation remembered across reloads', () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const intent = (overrides: Partial<CodexResetIntent> = {}): CodexResetIntent => ({
    v: 1,
    runnerId: 'Runner1',
    accountFingerprint: RESET_FINGERPRINT,
    confirmedAt: minutesAgo(1),
    clientRequestId: RESET_REQUEST_ID,
    workspaceId: 'Workspace1',
    ...overrides,
  });

  it('round-trips per runner and forgets anything malformed', () => {
    writeCodexResetIntent(intent());
    expect(readCodexResetIntent('Runner1')).toEqual(intent());
    expect(readCodexResetIntent('Runner2')).toBeNull();
    localStorage.setItem('orbit.codexReset:Runner1', '{not json');
    expect(readCodexResetIntent('Runner1')).toBeNull();
    for (const broken of [
      intent({ clientRequestId: 'nope' }),
      intent({ accountFingerprint: OTHER_FINGERPRINT.toUpperCase() }),
      intent({ clientRequestId: undefined }),
      intent({ settledAt: minutesAgo(0) }),
    ]) {
      localStorage.setItem('orbit.codexReset:Runner1', JSON.stringify(broken));
      expect(readCodexResetIntent('Runner1')).toBeNull();
      expect(localStorage.getItem('orbit.codexReset:Runner1')).toBeNull();
    }
    writeCodexResetIntent(intent());
    clearCodexResetIntent('Runner1');
    expect(readCodexResetIntent('Runner1')).toBeNull();
  });

  it('sends an unanswered create again only inside the consume deadline, and after it only looks', () => {
    expect(codexResetResume(intent(), NOW)).toBe('send-again');
    expect(codexResetResume(intent({ confirmedAt: minutesAgo(10) }), NOW)).toBe('send-again');
    expect(codexResetResume(intent({ confirmedAt: minutesAgo(11) }), NOW)).toBe('look-up');
    expect(codexResetResume(intent({ operationId: 'Op1', confirmedAt: minutesAgo(500) }), NOW)).toBe('follow-operation');
    expect(codexResetResume(intent({ operationId: 'Op1', settledAt: minutesAgo(60) }), NOW)).toBe('follow-operation');
    expect(codexResetResume(intent({ operationId: 'Op1', settledAt: minutesAgo(25 * 60) }), NOW)).toBe('forget');
  });

  it('looks an unanswered confirmation up by its own clientRequestId and nothing else', () => {
    const mine = resetOperation('SUCCEEDED', { id: 'Op1' });
    const other = resetOperation('PENDING', { id: 'Op2', clientRequestId: '11111111-1111-4111-8111-111111111111' });
    expect(codexResetLookUp(intent(), { active: other, latest: mine })).toEqual(mine);
    expect(codexResetLookUp(intent(), { active: other, latest: other })).toBeNull();
  });
});
