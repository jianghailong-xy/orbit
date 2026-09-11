import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCodexResetResult,
  CODEX_ACCOUNT_FINGERPRINT_MESSAGE_PREFIX,
  CODEX_ACCOUNT_FINGERPRINT_PATTERN,
  CODEX_ACCOUNT_READ_METHOD,
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  CODEX_RATE_LIMIT_RESET_CONSUME_METHOD,
  CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES,
  CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER,
  CODEX_RATE_LIMIT_RESET_ENUMS,
  CODEX_RATE_LIMIT_RESET_EXTENSIONS,
  CODEX_RATE_LIMIT_RESET_FORMATS,
  CODEX_RATE_LIMIT_RESET_LIMITS,
  CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS,
  CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION,
  CODEX_RATE_LIMIT_RESET_RESULT_KINDS,
  CODEX_RATE_LIMIT_RESET_TIMING,
  CODEX_RATE_LIMIT_RESET_TRANSITIONS,
  CODEX_RATE_LIMIT_RESET_WIRE,
  CODEX_RATE_LIMITS_READ_METHOD,
  codexRateLimitResetOf,
  codexRateLimitResetViolations,
  codexResetAccountOverride,
  codexResetCommand,
  codexResetCommandViolations,
  codexResetCreateReplay,
  codexResetCreditDetails,
  codexResetOperationStatus,
  codexResetOperationView,
  codexResetOperationViewViolations,
  codexResetRefusal,
  codexResetResultResponseViolations,
  codexResetResultViolations,
  codexResetSnapshotAccepted,
  codexResetTransitionViolations,
  createCodexResetRequestViolations,
  decideCodexResetDispatch,
  expireCodexResetOperation,
  newCodexResetOperation,
  orderCodexResetSnapshot,
  type CodexRateLimitResetOperationState,
  type CodexResetEligibilityInput,
  type CodexResetHeartbeat,
} from './codexRateLimitReset';
import type {
  CodexRateLimitResetCommand,
  CodexRateLimitResetConsumeOutcome,
  CodexRateLimitResetResultRequest,
  PlanUsage,
  PlanUsageRateLimitReset,
} from './dto';

/**
 * The shared half of docs/codex-rate-limit-reset-contract.md, against the repository files the Go
 * runner's codex_rate_limit_reset_test.go reads too: the contract, its wire fixtures and the Codex
 * app-server schema (codex-cli 0.154.0) it was defined against. Nothing here calls a provider.
 */

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
const CONTRACT = readJson('contracts/codex-rate-limit-reset.contract.json');
const FIXTURES = readJson('contracts/codex-rate-limit-reset.fixtures.json');
const evidence = (name: string) => readJson(`docs/evidence/codex-rate-limit-reset-0.154.0/${name}.json`);

const A = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
const B = '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const OPERATION_ID = '018f6d2a-7c3e-7a41-9b2d-5e6f7a8b9c0d';
const PROVIDER_KEY = '3d4e5f60-7182-4a93-8b04-c1d2e3f4a5b6';
const CLIENT_REQUEST = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const RUNNER = '018f6d29-1111-7222-8333-944455566677';
const OTHER_RUNNER = '018f6d29-2222-7222-8333-944455566677';
const OWNER = '018f6d28-aaaa-7bbb-8ccc-dddddddddddd';
const FP: string = FIXTURES.fingerprints[0].fingerprint;
const OTHER_FP: string = FIXTURES.fingerprints[1].fingerprint;
const T0 = Date.parse('2026-09-11T04:22:10.500Z');
const at = (ms: number) => new Date(T0 + ms);
const TIMING = CODEX_RATE_LIMIT_RESET_TIMING;

function block(overrides: Partial<PlanUsageRateLimitReset> = {}): PlanUsageRateLimitReset {
  return {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: FP,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    fetchedAt: at(-1_000).toISOString(),
    generation: A,
    sequence: 1,
    ...overrides,
  };
}

function created(): CodexRateLimitResetOperationState {
  return newCodexResetOperation({
    id: OPERATION_ID,
    ownerId: OWNER,
    runnerId: RUNNER,
    accountFingerprint: FP,
    clientRequestId: CLIENT_REQUEST,
    providerIdempotencyKey: PROVIDER_KEY,
    now: at(0),
  });
}

function heartbeat(overrides: Partial<CodexResetHeartbeat> = {}): CodexResetHeartbeat {
  return {
    runnerId: RUNNER,
    leaseOwner: A,
    draining: false,
    capabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
    rateLimitReset: block(),
    now: at(1_000),
    ...overrides,
  };
}

function delivered(op: CodexRateLimitResetOperationState, overrides: Partial<CodexResetHeartbeat> = {}) {
  const decision = decideCodexResetDispatch(op, heartbeat(overrides));
  if (decision.kind !== 'DELIVER') throw new Error(`expected DELIVER, got ${JSON.stringify(decision)}`);
  return decision;
}

function report(
  command: CodexRateLimitResetCommand,
  fields: Partial<CodexRateLimitResetResultRequest> & Pick<CodexRateLimitResetResultRequest, 'kind'>,
): CodexRateLimitResetResultRequest {
  return {
    protocolVersion: 1,
    operationId: command.operationId,
    leaseOwner: command.leaseOwner,
    claimGeneration: command.claimGeneration,
    phase: command.phase,
    ...fields,
  };
}

function applied(op: CodexRateLimitResetOperationState, result: unknown, now = at(2_000)) {
  const application = applyCodexResetResult(op, RUNNER, result, now);
  if (application.kind === 'REJECTED') throw new Error(`expected the result to apply, got ${application.rejection}`);
  return application;
}

/** Claimed by A at +1s, its outcome confirmed at +2s; the claim carries on into the refresh. */
function confirmed(outcome: CodexRateLimitResetConsumeOutcome) {
  const { operation, command } = delivered(created());
  return { operation: applied(operation, report(command, { kind: 'CONSUME_OUTCOME', outcome })).operation, command };
}

function eligible(overrides: Partial<CodexResetEligibilityInput> = {}): CodexResetEligibilityInput {
  return {
    now: at(0),
    accountOverride: false,
    activeOperation: false,
    runnerOnline: true,
    runnerCapabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
    heartbeatLeaseOwner: A,
    runnerDraining: false,
    rateLimitReset: block(),
    expectedAccountFingerprint: FP,
    ...overrides,
  };
}

describe('the contract file is what the code enforces', () => {
  it('names the baseline, version, capability, provider methods, timing and formats the code uses', () => {
    expect(CONTRACT.baseline.mainCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(CONTRACT.protocolVersion).toBe(CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION);
    expect(CONTRACT.capability).toBe(CODEX_RATE_LIMIT_RESET_CAPABILITY_V1);
    expect(CONTRACT.provider).toMatchObject({
      accountReadMethod: CODEX_ACCOUNT_READ_METHOD,
      readMethod: CODEX_RATE_LIMITS_READ_METHOD,
      consumeMethod: CODEX_RATE_LIMIT_RESET_CONSUME_METHOD,
      consumeParamKeys: ['idempotencyKey'],
    });
    expect(CONTRACT.provider.consumeOutcomes).toEqual([...CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES]);
    expect(CONTRACT.provider.outcomeEffects).toEqual(CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS);
    expect(CONTRACT.timing).toEqual(CODEX_RATE_LIMIT_RESET_TIMING);
    expect(CONTRACT.limits).toEqual(CODEX_RATE_LIMIT_RESET_LIMITS);
    expect(CONTRACT.formats).toEqual({
      uuid: CODEX_RATE_LIMIT_RESET_FORMATS.uuid.source,
      timestampMs: CODEX_RATE_LIMIT_RESET_FORMATS.timestampMs.source,
      timestampSeconds: CODEX_RATE_LIMIT_RESET_FORMATS.timestampSeconds.source,
    });
    expect(CONTRACT.accountFingerprint).toMatchObject({
      pattern: CODEX_ACCOUNT_FINGERPRINT_PATTERN.source,
      messagePrefix: CODEX_ACCOUNT_FINGERPRINT_MESSAGE_PREFIX,
    });
  });

  it('lists every enum, result kind, transition and eligibility check, in the code\'s order', () => {
    expect(Object.keys(CONTRACT.enums).sort()).toEqual(Object.keys(CODEX_RATE_LIMIT_RESET_ENUMS).sort());
    for (const [name, values] of Object.entries(CONTRACT.enums)) {
      expect([...CODEX_RATE_LIMIT_RESET_ENUMS[name as keyof typeof CODEX_RATE_LIMIT_RESET_ENUMS]], name).toEqual(values);
    }
    expect(CONTRACT.goEnums.every((name: string) => name in CONTRACT.enums)).toBe(true);
    expect(CONTRACT.resultKinds).toEqual(CODEX_RATE_LIMIT_RESET_RESULT_KINDS);
    expect(CONTRACT.transitions).toEqual(CODEX_RATE_LIMIT_RESET_TRANSITIONS);
    expect(CONTRACT.eligibilityOrder).toEqual([...CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER]);
  });

  it('declares every wire field with the presence and nullability dto.ts gives it', () => {
    expect(Object.keys(CONTRACT.wire).sort()).toEqual(Object.keys(CODEX_RATE_LIMIT_RESET_WIRE).sort());
    for (const [name, spec] of Object.entries<{ fields: unknown }>(CONTRACT.wire)) {
      expect(CODEX_RATE_LIMIT_RESET_WIRE[name as keyof typeof CODEX_RATE_LIMIT_RESET_WIRE], name).toEqual(spec.fields);
    }
    expect(
      Object.fromEntries(Object.entries<{ fields: unknown }>(CONTRACT.extensions).map(([name, spec]) => [name, spec.fields])),
    ).toEqual(CODEX_RATE_LIMIT_RESET_EXTENSIONS);
    // Go cannot tell an absent field from a null one, so no field may be both optional and nullable.
    for (const spec of Object.values<{ fields: Record<string, [string, string]> }>(CONTRACT.wire)) {
      for (const [presence, nullability] of Object.values(spec.fields)) {
        expect(presence === 'optional' && nullability === 'nullable').toBe(false);
      }
    }
  });

  it('derives exactly the twelve statuses the table lists and refuses every other checkpoint combination', () => {
    expect(CONTRACT.statusDerivation).toHaveLength(12);
    for (const consumeState of CODEX_RATE_LIMIT_RESET_ENUMS.consumeState) {
      for (const consumeOutcome of [null, ...CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES]) {
        for (const refreshState of CODEX_RATE_LIMIT_RESET_ENUMS.refreshState) {
          const row = CONTRACT.statusDerivation.find(
            (r: { consumeState: string; consumeOutcome: string | null; refreshState: string }) =>
              r.consumeState === consumeState && r.consumeOutcome === consumeOutcome && r.refreshState === refreshState,
          );
          expect(codexResetOperationStatus({ consumeState, consumeOutcome, refreshState }), `${consumeState}/${consumeOutcome}/${refreshState}`).toBe(
            row?.status ?? null,
          );
        }
      }
    }
  });
});

describe('the Codex app-server schema it was defined against (codex-cli 0.154.0)', () => {
  it('has exactly the four consume outcomes', () => {
    const response = evidence('ConsumeAccountRateLimitResetCreditResponse');
    const outcomes = response.definitions.ConsumeAccountRateLimitResetCreditOutcome.oneOf.flatMap((entry: { enum: string[] }) => entry.enum);
    expect(outcomes).toEqual([...CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES]);
    expect(response.required).toEqual(['outcome']);
  });

  it('requires only idempotencyKey and offers a creditId that protocol v1 never sends', () => {
    const params = evidence('ConsumeAccountRateLimitResetCreditParams');
    expect(params.required).toEqual(CONTRACT.provider.consumeParamKeys);
    expect(Object.keys(params.properties).sort()).toEqual(['creditId', 'idempotencyKey']);
    expect(params.properties.idempotencyKey.description).toContain('reuse the same value when retrying');
    expect(params.properties.creditId.description).toContain('When omitted, the backend selects');
  });

  it('reports rateLimitResetCredits as an optional, nullable top-level summary whose count is authoritative', () => {
    const read = evidence('GetAccountRateLimitsResponse');
    expect(read.required).toEqual(['rateLimits']);
    expect(read.properties.rateLimitResetCredits.anyOf).toEqual([
      { $ref: '#/definitions/RateLimitResetCreditsSummary' },
      { type: 'null' },
    ]);
    expect(read.properties.accountId.type).toEqual(['string', 'null']);
    const summary = read.definitions.RateLimitResetCreditsSummary;
    expect(summary.required).toEqual(['availableCount']);
    expect(summary.properties.credits.type).toEqual(['array', 'null']);
    expect(summary.properties.credits.description).toContain('`null` means only `availableCount` is known');
    expect(summary.properties.credits.description).toContain('its length can be less than `availableCount`');
    const credit = read.definitions.RateLimitResetCredit;
    expect(Object.keys(credit.properties).sort()).toEqual(Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.PlanUsageRateLimitResetCredit).sort());
    expect([...credit.required].sort()).toEqual(['grantedAt', 'id', 'resetType', 'status']);
  });

  it('tells a ChatGPT account from API-key and Bedrock auth', () => {
    const account = JSON.stringify(evidence('GetAccountResponse'));
    for (const type of ['chatgpt', 'apiKey', 'amazonBedrock']) expect(account).toContain(`"${type}"`);
  });
});

describe('wire fixtures shared with the Go mirror', () => {
  const groups = [
    ['blocks', codexRateLimitResetViolations],
    ['commands', codexResetCommandViolations],
    ['results', codexResetResultViolations],
    ['resultResponses', codexResetResultResponseViolations],
    ['operationViews', codexResetOperationViewViolations],
  ] as const;

  for (const [group, violations] of groups) {
    it(`${group}: every valid fixture is accepted and every invalid one refused`, () => {
      expect(FIXTURES[group].valid.length).toBeGreaterThan(0);
      expect(FIXTURES[group].invalid.length).toBeGreaterThan(0);
      for (const fixture of FIXTURES[group].valid) expect(violations(fixture.value), fixture.name).toEqual([]);
      for (const fixture of FIXTURES[group].invalid) expect(violations(fixture.value).length, fixture.name).toBeGreaterThan(0);
    });
  }

  it('measures the message cap instead of listing a 501-character fixture', () => {
    const valid = FIXTURES.results.valid[0].value;
    expect(codexResetResultViolations({ ...valid, message: 'x'.repeat(CODEX_RATE_LIMIT_RESET_LIMITS.maxMessageLength) })).toEqual([]);
    expect(codexResetResultViolations({ ...valid, message: 'x'.repeat(CODEX_RATE_LIMIT_RESET_LIMITS.maxMessageLength + 1) }).length).toBeGreaterThan(0);
    expect(codexResetResultViolations({ ...valid, message: '' }).length).toBeGreaterThan(0);
  });

  it('reads a heartbeat from a runner that predates the contract as "reset not offered", never as zero credits', () => {
    const legacy = FIXTURES.heartbeats.legacy;
    expect(codexRateLimitResetOf(legacy.planUsage)).toBeUndefined();
    expect(codexResetCreditDetails(codexRateLimitResetOf(legacy.planUsage)).availableCount).toBeNull();
    expect(codexResetRefusal(eligible({ rateLimitReset: codexRateLimitResetOf(legacy.planUsage) }))).toBe('SNAPSHOT_MISSING');
    expect(FIXTURES.heartbeatResponses.legacy).not.toHaveProperty('codexRateLimitResetRequest');
  });

  it('finds the block nested under codex and in a flat Codex snapshot, never in a Claude one', () => {
    for (const name of ['nestedReset', 'flatReset']) {
      const beat = FIXTURES.heartbeats[name];
      const found = codexRateLimitResetOf(beat.planUsage);
      expect(found, name).toBeDefined();
      expect(codexRateLimitResetViolations(found), name).toEqual([]);
      expect(orderCodexResetSnapshot(null, found, beat.leaseOwner, new Date(found!.fetchedAt))).toBe('ACCEPT_FIRST');
    }
    const claudeOnly: PlanUsage = { provider: 'claude', rateLimitReset: block() };
    expect(codexRateLimitResetOf(claudeOnly)).toBeUndefined();
  });

  it('sends the persisted key, and only it, to the provider consume', () => {
    const consume = FIXTURES.heartbeatResponses[FIXTURES.consumeParams.heartbeatResponse].codexRateLimitResetRequest;
    expect(Object.keys(FIXTURES.consumeParams.expect)).toEqual(CONTRACT.provider.consumeParamKeys);
    expect(FIXTURES.consumeParams.expect.idempotencyKey).toBe(consume.providerIdempotencyKey);
    const refresh = FIXTURES.heartbeatResponses.refresh.codexRateLimitResetRequest;
    expect(codexResetCommandViolations(refresh)).toEqual([]);
    expect(refresh).not.toHaveProperty('providerIdempotencyKey');
  });
});

describe('counts and credit details', () => {
  it('maps every provider read to a valid block whose count is the provider\'s, whatever the rows say', () => {
    for (const read of FIXTURES.providerReads) {
      const summary = read.expect.rateLimitResetCredits;
      expect(read.expect.support === 'SUPPORTED', read.name).toBe(summary !== null);
      const value = {
        protocolVersion: 1,
        support: read.expect.support,
        ...(read.expect.accountId ? { accountFingerprint: FP } : {}),
        rateLimitResetCredits: summary,
        fetchedAt: at(0).toISOString(),
        generation: A,
        sequence: 1,
      };
      expect(codexRateLimitResetViolations(value), read.name).toEqual([]);
      expect(codexResetCreditDetails(value as PlanUsageRateLimitReset).availableCount, read.name).toBe(summary?.availableCount ?? null);
    }
  });

  it('says whether the details are unknown, complete or truncated, without touching the count', () => {
    const summaries = Object.fromEntries(
      FIXTURES.providerReads.map((read: { name: string; expect: { rateLimitResetCredits: unknown } }) => [read.name, read.expect.rateLimitResetCredits]),
    );
    const details = (name: string) => codexResetCreditDetails(block({ rateLimitResetCredits: summaries[name] }));
    expect(details('details-null-count-only')).toEqual({ availableCount: 3, details: 'UNKNOWN', nextExpiresAt: null });
    expect(details('details-truncated-count-exceeds-rows')).toEqual({ availableCount: 7, details: 'TRUNCATED', nextExpiresAt: '2026-09-21T14:13:20Z' });
    expect(details('details-complete')).toEqual({ availableCount: 2, details: 'COMPLETE', nextExpiresAt: '2026-09-21T14:13:20Z' });
    expect(details('details-empty-array')).toEqual({ availableCount: 0, details: 'COMPLETE', nextExpiresAt: null });
    expect(details('details-malformed-row-drops-details-not-count')).toEqual({ availableCount: 4, details: 'UNKNOWN', nextExpiresAt: null });
    expect(details('details-row-omits-nullable-keys-and-passes-unknown-values-through')).toEqual({
      availableCount: 1,
      details: 'COMPLETE',
      nextExpiresAt: null,
    });
    expect(codexResetCreditDetails(block({ support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null }))).toEqual({
      availableCount: null,
      details: 'UNKNOWN',
      nextExpiresAt: null,
    });
  });

  it('derives the fingerprint the Go runner derives, from a runner-local key and the account id alone', () => {
    const key = Buffer.from(FIXTURES.fingerprintKeyHex, 'hex');
    expect(key).toHaveLength(CONTRACT.accountFingerprint.keyBytes);
    for (const { accountId, fingerprint } of FIXTURES.fingerprints) {
      const hmac = createHmac('sha256', key).update(CODEX_ACCOUNT_FINGERPRINT_MESSAGE_PREFIX + accountId).digest('hex');
      expect(`cxa1_${hmac.slice(0, 32)}`).toBe(fingerprint);
      expect(fingerprint).toMatch(CODEX_ACCOUNT_FINGERPRINT_PATTERN);
      expect(fingerprint).not.toContain(accountId);
    }
  });
});

describe('creating an operation', () => {
  it('checks in the contract order, one refusal per failed condition', () => {
    let input = eligible({
      accountOverride: true,
      activeOperation: true,
      runnerOnline: false,
      runnerCapabilities: [],
      heartbeatLeaseOwner: null,
      runnerDraining: true,
      rateLimitReset: undefined,
      expectedAccountFingerprint: OTHER_FP,
      now: at(TIMING.snapshotMaxAgeMs + 60_000),
    });
    const unidentified = { accountFingerprint: undefined, rateLimitResetCredits: null };
    const repairs: Array<(i: CodexResetEligibilityInput) => CodexResetEligibilityInput> = [
      (i) => ({ ...i, accountOverride: false }),
      (i) => ({ ...i, activeOperation: false }),
      (i) => ({ ...i, runnerOnline: true }),
      (i) => ({ ...i, runnerCapabilities: [' Codex-Rate-Limit-Reset-V1 '] }),
      (i) => ({ ...i, heartbeatLeaseOwner: A }),
      (i) => ({ ...i, runnerDraining: false }),
      (i) => ({ ...i, rateLimitReset: block({ support: 'UNSUPPORTED_AUTH', ...unidentified }) }),
      (i) => ({ ...i, rateLimitReset: block({ support: 'PROVIDER_UNSUPPORTED', ...unidentified }) }),
      (i) => ({ ...i, rateLimitReset: block({ support: 'ACCOUNT_UNIDENTIFIED', ...unidentified }) }),
      (i) => ({ ...i, rateLimitReset: block({ support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null }) }),
      (i) => ({ ...i, expectedAccountFingerprint: FP }),
      (i) => ({ ...i, now: at(0) }),
      (i) => ({ ...i, rateLimitReset: block({ rateLimitResetCredits: { availableCount: 0, credits: [] } }) }),
      (i) => ({ ...i, rateLimitReset: block({ rateLimitResetCredits: { availableCount: 1, credits: null } }) }),
    ];
    const answers = [];
    for (const repair of repairs) {
      answers.push(codexResetRefusal(input));
      input = repair(input);
    }
    answers.push(codexResetRefusal(input));
    expect(answers).toEqual([...CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER, null]);
  });

  it('never lets the detail rows stand in for the count', () => {
    const rows = FIXTURES.blocks.valid.find((fixture: { name: string }) => fixture.name === 'supported-details-complete').value.rateLimitResetCredits.credits;
    expect(codexResetRefusal(eligible({ rateLimitReset: block({ rateLimitResetCredits: { availableCount: 0, credits: rows } }) }))).toBe('NO_CREDIT_AVAILABLE');
    expect(codexResetRefusal(eligible({ rateLimitReset: block({ rateLimitResetCredits: { availableCount: 5, credits: [] } }) }))).toBeNull();
  });

  it('treats a block dated beyond the skew window as stale', () => {
    const future = block({ fetchedAt: at(TIMING.snapshotFutureSkewMs + 1_000).toISOString() });
    expect(codexResetRefusal(eligible({ rateLimitReset: future }))).toBe('SNAPSHOT_STALE');
  });

  it('refuses reset from a context that does not run on the runner\'s default Codex account', () => {
    expect(codexResetAccountOverride({})).toBe(false);
    expect(codexResetAccountOverride({ provider: 'codex', env: { PATH: '/usr/bin', CODEX_HOME: '  ' } })).toBe(false);
    expect(codexResetAccountOverride({ provider: 'codex', env: { CODEX_HOME: '/srv/other-codex' } })).toBe(true);
    expect(codexResetAccountOverride({ env: { OPENAI_BASE_URL: 'https://example.invalid/v1' } })).toBe(true);
    expect(codexResetAccountOverride({ env: { CODEX_API_KEY: 'sk-fixture' } })).toBe(true);
    expect(codexResetAccountOverride({ provider: 'deepseek' })).toBe(true);
  });

  it('accepts a create body of a UUID clientRequestId and a fingerprint, and nothing provider-facing', () => {
    const body = { clientRequestId: CLIENT_REQUEST, accountFingerprint: FP };
    expect(createCodexResetRequestViolations(body)).toEqual([]);
    expect(createCodexResetRequestViolations({ ...body, workspaceId: 'workspace' })).toEqual([]);
    expect(createCodexResetRequestViolations({ ...body, providerIdempotencyKey: PROVIDER_KEY }).length).toBeGreaterThan(0);
    expect(createCodexResetRequestViolations({ ...body, creditId: 'rlrc_fixture_1' }).length).toBeGreaterThan(0);
    expect(createCodexResetRequestViolations({ ...body, clientRequestId: 'click-1' }).length).toBeGreaterThan(0);
  });
});

describe('two idempotency keys with two jobs', () => {
  it('replays a repeated clientRequestId, and refuses it for another runner or account', () => {
    const op = created();
    expect(codexResetCreateReplay(op, { runnerId: RUNNER, accountFingerprint: FP })).toBe('REPLAY');
    expect(codexResetCreateReplay(op, { runnerId: OTHER_RUNNER, accountFingerprint: FP })).toBe('REQUEST_ID_REUSED');
    expect(codexResetCreateReplay(op, { runnerId: RUNNER, accountFingerprint: OTHER_FP })).toBe('REQUEST_ID_REUSED');
  });

  it('creates a PENDING operation around a canonical provider key that no view shows', () => {
    const op = created();
    expect(op).toMatchObject({ consumeState: 'PENDING', refreshState: 'NONE', claimGeneration: 0, claimsWithUnknownCall: 0 });
    const view = codexResetOperationView(op);
    expect(Object.keys(view).sort()).toEqual(Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetOperationView).sort());
    expect(JSON.stringify(view)).not.toContain(PROVIDER_KEY);
    expect(codexResetOperationViewViolations(view)).toEqual([]);
    const base = { id: OPERATION_ID, ownerId: OWNER, runnerId: RUNNER, accountFingerprint: FP, clientRequestId: CLIENT_REQUEST, now: at(0) };
    for (const providerIdempotencyKey of ['', 'attempt-1', PROVIDER_KEY.toUpperCase()]) {
      expect(() => newCodexResetOperation({ ...base, providerIdempotencyKey })).toThrow();
    }
  });

  it('hands every claim of the operation the same key, and none once the consume is confirmed', () => {
    const first = delivered(created());
    expect(first.command.providerIdempotencyKey).toBe(PROVIDER_KEY);
    const takeover = delivered(first.operation, { leaseOwner: B, now: at(1_000 + TIMING.claimTakeoverAfterMs) });
    expect(takeover.command).toMatchObject({ leaseOwner: B, claimGeneration: 2, providerIdempotencyKey: PROVIDER_KEY });
    const confirmedByB = applied(takeover.operation, report(takeover.command, { kind: 'CONSUME_OUTCOME', outcome: 'alreadyRedeemed' }), at(62_000));
    const refresh = codexResetCommand(confirmedByB.operation);
    expect(refresh).toMatchObject({ phase: 'REFRESH', leaseOwner: B, claimGeneration: 2 });
    expect(refresh).not.toHaveProperty('providerIdempotencyKey');
  });

  it('refuses any write that changes the key, the request id, the account, the runner or the owner', () => {
    const op = created();
    for (const change of [
      { providerIdempotencyKey: '5d4e5f60-7182-4a93-8b04-c1d2e3f4a5b6' },
      { clientRequestId: '1a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d' },
      { accountFingerprint: OTHER_FP },
      { runnerId: OTHER_RUNNER },
      { ownerId: OTHER_RUNNER },
    ]) {
      expect(codexResetTransitionViolations(op, { ...op, ...change }).length, JSON.stringify(change)).toBeGreaterThan(0);
    }
  });
});

describe('claims and delivery', () => {
  it('claims an unclaimed operation for the heartbeat process', () => {
    const { operation, command } = delivered(created());
    expect(operation).toMatchObject({
      consumeState: 'CLAIMED',
      claimLeaseOwner: A,
      claimGeneration: 1,
      claimedAt: at(1_000).toISOString(),
      claimsWithUnknownCall: 1,
    });
    expect(command).toEqual({
      protocolVersion: 1,
      operationId: OPERATION_ID,
      leaseOwner: A,
      claimGeneration: 1,
      phase: 'CONSUME',
      accountFingerprint: FP,
      providerIdempotencyKey: PROVIDER_KEY,
      requestedAt: at(0).toISOString(),
    });
    expect(codexResetCommandViolations(command)).toEqual([]);
  });

  it('redelivers the same command to the claiming process without a new claim', () => {
    const first = delivered(created());
    const again = delivered(first.operation, { now: at(20_000) });
    expect(again.operation).toBe(first.operation);
    expect(again.command).toEqual(first.command);
  });

  it('leaves another process\'s fresh claim alone and takes over a stale one with a higher generation', () => {
    const first = delivered(created());
    expect(decideCodexResetDispatch(first.operation, heartbeat({ leaseOwner: B, now: at(30_000) }))).toEqual({ kind: 'NONE', reason: 'CLAIM_HELD' });
    const takeover = delivered(first.operation, { leaseOwner: B, now: at(1_000 + TIMING.claimTakeoverAfterMs) });
    expect(takeover.operation).toMatchObject({ claimLeaseOwner: B, claimGeneration: 2, claimsWithUnknownCall: 2 });
  });

  it('never delivers without a lease, the capability or a usable block, or to a draining process or another runner', () => {
    const op = created();
    const unidentified = block({ support: 'ACCOUNT_UNIDENTIFIED', accountFingerprint: undefined, rateLimitResetCredits: null });
    expect(decideCodexResetDispatch(op, heartbeat({ leaseOwner: null }))).toEqual({ kind: 'NONE', reason: 'NO_ACTIVE_LEASE' });
    expect(decideCodexResetDispatch(op, heartbeat({ capabilities: ['session-worktree-ops-v1'] }))).toEqual({ kind: 'NONE', reason: 'CAPABILITY_MISSING' });
    expect(decideCodexResetDispatch(op, heartbeat({ draining: true }))).toEqual({ kind: 'NONE', reason: 'RUNNER_DRAINING' });
    expect(decideCodexResetDispatch(op, heartbeat({ rateLimitReset: undefined }))).toEqual({ kind: 'NONE', reason: 'SNAPSHOT_MISSING' });
    expect(decideCodexResetDispatch(op, heartbeat({ rateLimitReset: unidentified }))).toEqual({ kind: 'NONE', reason: 'SNAPSHOT_MISSING' });
    expect(decideCodexResetDispatch(op, heartbeat({ runnerId: OTHER_RUNNER }))).toEqual({ kind: 'NONE', reason: 'RUNNER_MISMATCH' });
  });

  it('settles an account change as NOT_ATTEMPTED before any claim, and as UNRESOLVED once a claim may have called', () => {
    const changed = { rateLimitReset: block({ accountFingerprint: OTHER_FP }) };
    const unclaimed = decideCodexResetDispatch(created(), heartbeat(changed));
    expect(unclaimed.kind === 'SETTLE' && unclaimed.operation).toMatchObject({
      consumeState: 'NOT_ATTEMPTED',
      refreshState: 'NOT_REQUIRED',
      failureCode: 'ACCOUNT_CHANGED',
    });
    const claimed = delivered(created()).operation;
    expect(decideCodexResetDispatch(claimed, heartbeat({ ...changed, now: at(30_000) }))).toEqual({ kind: 'NONE', reason: 'CLAIM_HELD' });
    const later = decideCodexResetDispatch(claimed, heartbeat({ ...changed, now: at(1_000 + TIMING.claimTakeoverAfterMs) }));
    expect(later.kind === 'SETTLE' && later.operation).toMatchObject({ consumeState: 'UNRESOLVED', failureCode: 'ACCOUNT_CHANGED' });
  });

  it('delivers REFRESH without the key after a confirmed consume, and fails only the refresh on an account change', () => {
    const { operation } = confirmed('reset');
    const refresh = delivered(operation, { now: at(3_000) });
    expect(refresh.operation).toBe(operation);
    expect(refresh.command.phase).toBe('REFRESH');
    expect(refresh.command).not.toHaveProperty('providerIdempotencyKey');
    const changed = decideCodexResetDispatch(operation, heartbeat({ rateLimitReset: block({ accountFingerprint: OTHER_FP }), now: at(62_000) }));
    expect(changed.kind === 'SETTLE' && changed.operation).toMatchObject({
      consumeState: 'CONFIRMED',
      consumeOutcome: 'reset',
      refreshState: 'FAILED',
      failureCode: 'ACCOUNT_CHANGED',
    });
  });
});

describe('results', () => {
  it('records each provider outcome on the consume checkpoint and decides the refresh separately', () => {
    const expected = {
      reset: ['REFRESHING', 'PENDING', 'REFRESH'],
      alreadyRedeemed: ['REFRESHING', 'PENDING', 'REFRESH'],
      nothingToReset: ['NOTHING_TO_RESET', 'NOT_REQUIRED', 'STOP'],
      noCredit: ['NO_CREDIT', 'NOT_REQUIRED', 'STOP'],
    } as const;
    for (const outcome of CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES) {
      const { operation, command } = delivered(created());
      const result = applied(operation, report(command, { kind: 'CONSUME_OUTCOME', outcome }));
      const [status, refreshState, next] = expected[outcome];
      expect(result.kind, outcome).toBe('APPLIED');
      expect(result.response, outcome).toEqual({ disposition: 'APPLIED', status, next });
      expect(result.operation, outcome).toMatchObject({
        consumeState: 'CONFIRMED',
        consumeOutcome: outcome,
        consumeConfirmedAt: at(2_000).toISOString(),
        refreshState,
        completedAt: refreshState === 'PENDING' ? null : at(2_000).toISOString(),
      });
    }
  });

  it('answers a redelivered result as a duplicate, from the current claim or a stale one', () => {
    const { operation, command } = confirmed('reset');
    const same = applyCodexResetResult(operation, RUNNER, report(command, { kind: 'CONSUME_OUTCOME', outcome: 'reset' }), at(3_000));
    expect(same).toEqual({ kind: 'DUPLICATE', operation, response: { disposition: 'DUPLICATE', status: 'REFRESHING', next: 'REFRESH' } });
    // A process that retried the same key after losing its receipt hears alreadyRedeemed: the same fact.
    const retried = applyCodexResetResult(operation, RUNNER, report(command, { kind: 'CONSUME_OUTCOME', outcome: 'alreadyRedeemed' }), at(3_000));
    expect(retried.kind).toBe('DUPLICATE');
    const stale = applyCodexResetResult(
      operation,
      RUNNER,
      { ...report(command, { kind: 'CONSUME_OUTCOME', outcome: 'reset' }), leaseOwner: B, claimGeneration: 2 },
      at(3_000),
    );
    expect(stale.kind === 'DUPLICATE' && stale.response.next).toBe('STOP');
  });

  it('refuses a result that contradicts the recorded outcome', () => {
    const { operation, command } = confirmed('reset');
    expect(applyCodexResetResult(operation, RUNNER, report(command, { kind: 'CONSUME_OUTCOME', outcome: 'nothingToReset' }), at(3_000))).toEqual({
      kind: 'REJECTED',
      rejection: 'OUTCOME_CONFLICT',
    });
  });

  it('fences new facts to the current leaseOwner and claimGeneration, and to the operation\'s phase', () => {
    const first = delivered(created());
    const takeover = delivered(first.operation, { leaseOwner: B, now: at(1_000 + TIMING.claimTakeoverAfterMs) });
    expect(applyCodexResetResult(takeover.operation, RUNNER, report(first.command, { kind: 'CONSUME_OUTCOME', outcome: 'reset' }), at(62_000))).toEqual({
      kind: 'REJECTED',
      rejection: 'STALE_CLAIM',
    });
    const refreshTooEarly = report(takeover.command, { phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'READ_FAILED' });
    expect(applyCodexResetResult(takeover.operation, RUNNER, refreshTooEarly, at(62_000))).toEqual({ kind: 'REJECTED', rejection: 'PHASE_MISMATCH' });
  });

  it('refuses malformed results and results for another runner or operation', () => {
    const { operation, command } = delivered(created());
    const good = report(command, { kind: 'CONSUME_OUTCOME', outcome: 'reset' });
    expect(applyCodexResetResult(operation, RUNNER, { ...good, creditId: 'rlrc_fixture_1' }, at(2_000))).toEqual({ kind: 'REJECTED', rejection: 'INVALID_RESULT' });
    expect(applyCodexResetResult(operation, OTHER_RUNNER, good, at(2_000))).toEqual({ kind: 'REJECTED', rejection: 'OPERATION_NOT_FOUND' });
    expect(applyCodexResetResult(operation, RUNNER, { ...good, operationId: '018f6d2a-7c3e-7a41-9b2d-5e6f7a8b9c0e' }, at(2_000))).toEqual({
      kind: 'REJECTED',
      rejection: 'OPERATION_NOT_FOUND',
    });
  });

  it('settles NOT_ATTEMPTED only when no claim may have reached the provider', () => {
    const first = delivered(created());
    const refused = applied(first.operation, report(first.command, { kind: 'CONSUME_NOT_CALLED', code: 'ACCOUNT_MISMATCH' }));
    expect(refused.operation).toMatchObject({ consumeState: 'NOT_ATTEMPTED', failureCode: 'ACCOUNT_MISMATCH', claimsWithUnknownCall: 0 });
    expect(refused.response).toEqual({ disposition: 'APPLIED', status: 'NOT_ATTEMPTED', next: 'STOP' });
    const takeover = delivered(delivered(created()).operation, { leaseOwner: B, now: at(1_000 + TIMING.claimTakeoverAfterMs) });
    const afterTakeover = applied(takeover.operation, report(takeover.command, { kind: 'CONSUME_NOT_CALLED', code: 'ACCOUNT_MISMATCH' }), at(62_000));
    expect(afterTakeover.operation).toMatchObject({ consumeState: 'UNRESOLVED', failureCode: 'ACCOUNT_MISMATCH', claimsWithUnknownCall: 1 });
  });

  it('lets a draining process hand its claim back without settling, forgetting only its own uncertainty', () => {
    const first = delivered(created());
    const released = applied(first.operation, report(first.command, { kind: 'RELEASED', code: 'RUNNER_DRAINING' }));
    expect(released.operation).toMatchObject({
      consumeState: 'CLAIMED',
      claimLeaseOwner: null,
      claimGeneration: 1,
      claimsWithUnknownCall: 0,
      lastErrorCode: 'RUNNER_DRAINING',
    });
    expect(released.response).toEqual({ disposition: 'APPLIED', status: 'CONSUMING', next: 'STOP' });
    const successor = delivered(released.operation, { leaseOwner: B, now: at(3_000) });
    expect(successor.operation).toMatchObject({ claimLeaseOwner: B, claimGeneration: 2, claimsWithUnknownCall: 1 });
    const releasedAgain = applied(successor.operation, report(successor.command, { kind: 'RELEASED', code: 'RUNNER_DRAINING' }), at(4_000));
    expect(expireCodexResetOperation(releasedAgain.operation, at(TIMING.consumeDeadlineMs))).toMatchObject({
      consumeState: 'NOT_ATTEMPTED',
      failureCode: 'CONSUME_EXPIRED',
    });
  });

  it('keeps an operation active through recoverable errors, remembering the last one', () => {
    const first = delivered(created());
    const retrying = applied(first.operation, report(first.command, { kind: 'CONSUME_RETRYING', code: 'PROVIDER_TIMEOUT' }));
    expect(retrying.response).toEqual({ disposition: 'APPLIED', status: 'CONSUMING', next: 'RETRY_CONSUME' });
    expect(retrying.operation).toMatchObject({ consumeState: 'CLAIMED', lastErrorCode: 'PROVIDER_TIMEOUT' });
    const { operation } = confirmed('alreadyRedeemed');
    const failedRead = applied(operation, report(codexResetCommand(operation), { kind: 'REFRESH_FAILED', code: 'READ_FAILED' }), at(3_000));
    expect(failedRead.response).toEqual({ disposition: 'APPLIED', status: 'REFRESHING', next: 'RETRY_REFRESH' });
    expect(failedRead.operation).toMatchObject({ consumeOutcome: 'alreadyRedeemed', refreshState: 'PENDING', lastErrorCode: 'READ_FAILED' });
  });

  it('completes the refresh only with a block for the bound account, and a terminal refresh failure keeps the consume', () => {
    const { operation } = confirmed('reset');
    const command = codexResetCommand(operation);
    const refreshed = (fingerprint: string) =>
      report(command, {
        kind: 'REFRESHED',
        rateLimitReset: block({
          accountFingerprint: fingerprint,
          generation: command.leaseOwner,
          fetchedAt: at(2_500).toISOString(),
          sequence: 2,
          rateLimitResetCredits: { availableCount: 1, credits: null },
        }),
      });
    expect(applyCodexResetResult(operation, RUNNER, refreshed(OTHER_FP), at(3_000))).toEqual({ kind: 'REJECTED', rejection: 'ACCOUNT_MISMATCH' });
    const done = applied(operation, refreshed(FP), at(3_000));
    expect(done.response).toEqual({ disposition: 'APPLIED', status: 'SUCCEEDED', next: 'STOP' });
    expect(done.operation).toMatchObject({ consumeState: 'CONFIRMED', refreshState: 'SUCCEEDED', completedAt: at(3_000).toISOString() });
    const terminal = applied(operation, report(command, { kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' }), at(3_000));
    expect(terminal.operation).toMatchObject({ consumeState: 'CONFIRMED', consumeOutcome: 'reset', refreshState: 'FAILED', failureCode: 'ACCOUNT_MISMATCH' });
    expect(terminal.response.status).toBe('REFRESH_FAILED');
  });

  it('never changes a settled operation', () => {
    const { operation, command } = confirmed('noCredit');
    for (const late of [
      report(command, { kind: 'CONSUME_RETRYING', code: 'PROVIDER_ERROR' }),
      report(command, { kind: 'RELEASED', code: 'RUNNER_DRAINING' }),
      report(command, { kind: 'CONSUME_OUTCOME', outcome: 'reset' }),
    ]) {
      const result = applyCodexResetResult(operation, RUNNER, late, at(9_000));
      expect(result.kind === 'REJECTED' || result.operation === operation, late.kind).toBe(true);
    }
    expect(decideCodexResetDispatch(operation, heartbeat({ now: at(9_000) }))).toEqual({ kind: 'NONE', reason: 'SETTLED' });
    expect(expireCodexResetOperation(operation, at(TIMING.consumeDeadlineMs * 10))).toBeNull();
  });
});

describe('deadlines', () => {
  it('settles an unconfirmed consume at its deadline, once no fresh claim still holds it', () => {
    const pending = created();
    expect(expireCodexResetOperation(pending, at(TIMING.consumeDeadlineMs - 1))).toBeNull();
    expect(expireCodexResetOperation(pending, at(TIMING.consumeDeadlineMs))).toMatchObject({ consumeState: 'NOT_ATTEMPTED', failureCode: 'CONSUME_EXPIRED' });
    const lateClaim = delivered(pending, { now: at(TIMING.consumeDeadlineMs - 1_000) }).operation;
    expect(expireCodexResetOperation(lateClaim, at(TIMING.consumeDeadlineMs + 1_000))).toBeNull();
    expect(expireCodexResetOperation(lateClaim, at(TIMING.consumeDeadlineMs - 1_000 + TIMING.claimTakeoverAfterMs))).toMatchObject({
      consumeState: 'UNRESOLVED',
      failureCode: 'CONSUME_EXPIRED',
    });
  });

  it('fails a refresh at its deadline and leaves the confirmed consume alone', () => {
    const { operation } = confirmed('reset');
    expect(expireCodexResetOperation(operation, at(2_000 + TIMING.refreshDeadlineMs - 1))).toBeNull();
    expect(expireCodexResetOperation(operation, at(2_000 + TIMING.refreshDeadlineMs))).toMatchObject({
      consumeState: 'CONFIRMED',
      consumeOutcome: 'reset',
      refreshState: 'FAILED',
      failureCode: 'REFRESH_EXPIRED',
    });
  });
});

describe('monotonic writes', () => {
  it('refuses backwards, sideways and settled-state writes', () => {
    const { operation } = confirmed('reset');
    const back = { ...operation, consumeState: 'CLAIMED', consumeOutcome: null, consumeConfirmedAt: null, refreshState: 'NONE' } as const;
    expect(codexResetTransitionViolations(operation, back).length).toBeGreaterThan(0);
    expect(codexResetTransitionViolations(operation, { ...operation, consumeOutcome: 'alreadyRedeemed' }).length).toBeGreaterThan(0);
    expect(codexResetTransitionViolations(operation, { ...operation, claimGeneration: 0 }).length).toBeGreaterThan(0);
    const settled = applied(operation, report(codexResetCommand(operation), { kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' }), at(3_000)).operation;
    expect(codexResetTransitionViolations(settled, { ...settled, refreshState: 'SUCCEEDED', failureCode: null }).length).toBeGreaterThan(0);
    expect(codexResetTransitionViolations(settled, { ...settled, lastErrorCode: 'READ_FAILED' }).length).toBeGreaterThan(0);
    expect(codexResetTransitionViolations(settled, settled)).toEqual([]);
  });
});

describe('snapshot compare-and-set', () => {
  const now = new Date('2026-09-11T04:22:00.000Z');
  const stored = block({ fetchedAt: '2026-09-11T04:21:30.123Z', generation: A, sequence: 7 });
  const cases: Array<[string, unknown, PlanUsageRateLimitReset, string, string]> = [
    ['nothing stored yet', null, stored, A, 'ACCEPT_FIRST'],
    ['a stored value that is not a v1 block', { availableCount: 3 }, stored, A, 'ACCEPT_FIRST'],
    ['a later read by the same process', stored, { ...stored, fetchedAt: '2026-09-11T04:21:31.000Z', sequence: 8 }, A, 'ACCEPT_NEWER'],
    ['a new process whose first read is later', stored, { ...stored, fetchedAt: '2026-09-11T04:21:40.000Z', generation: B, sequence: 1 }, B, 'ACCEPT_NEWER'],
    ['an out-of-order heartbeat carrying an earlier read', stored, { ...stored, fetchedAt: '2026-09-11T04:21:29.000Z', sequence: 6 }, A, 'REJECT_OLDER'],
    ['an old process still reporting a read older than the stored one', stored, { ...stored, fetchedAt: '2026-09-11T04:20:00.000Z', generation: B, sequence: 41 }, B, 'REJECT_OLDER'],
    ['the same read on the next heartbeat', stored, { ...stored }, A, 'REJECT_DUPLICATE'],
    ['the same millisecond, a later read of the same process', stored, { ...stored, sequence: 8 }, A, 'ACCEPT_NEWER'],
    ['the same millisecond from another process', stored, { ...stored, generation: B, sequence: 99 }, B, 'REJECT_OLDER'],
    ['a block relayed by a process that did not read it', stored, { ...stored, fetchedAt: '2026-09-11T04:21:40.000Z', sequence: 8 }, B, 'REJECT_INVALID'],
    ['an invalid block', stored, { ...stored, sequence: 0 }, A, 'REJECT_INVALID'],
    ['a future-dated stored block, replaced by a sane read', { ...stored, fetchedAt: '2026-09-11T05:30:00.000Z' }, stored, A, 'ACCEPT_REPLACES_UNTRUSTED'],
    ['a future-dated read over a sane stored block', stored, { ...stored, fetchedAt: '2026-09-11T05:30:00.000Z', sequence: 8 }, A, 'REJECT_UNTRUSTED'],
  ];

  it.each(cases)('%s', (_name, previous, incoming, transport, expected) => {
    expect(orderCodexResetSnapshot(previous, incoming, transport, now)).toBe(expected);
  });

  it('accepts exactly the ACCEPT_ orders', () => {
    for (const order of CODEX_RATE_LIMIT_RESET_ENUMS.snapshotOrder) {
      expect(codexResetSnapshotAccepted(order), order).toBe(order.startsWith('ACCEPT_'));
    }
  });
});

interface FakeProvider {
  credits: number;
  eligible: boolean;
  redeemed: Set<string>;
  keys: Set<string>;
}

/** A provider with the documented semantics: one reset per key, answered again as alreadyRedeemed. */
function consumeAt(provider: FakeProvider, key: string): CodexRateLimitResetConsumeOutcome {
  provider.keys.add(key);
  if (provider.redeemed.has(key)) return 'alreadyRedeemed';
  if (provider.credits === 0) return 'noCredit';
  if (!provider.eligible) return 'nothingToReset';
  provider.credits -= 1;
  provider.redeemed.add(key);
  return 'reset';
}

/** Two runner processes, lost and repeated receipts, account flips, draining, deadlines: every
 *  interleaving a seeded walk reaches, checked write by write. */
function walk(seed: number): void {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const provider: FakeProvider = { credits: 1 + Math.floor(random() * 2), eligible: random() < 0.8, redeemed: new Set(), keys: new Set() };
  const initialCredits = provider.credits;
  let op = created();
  let clock = 0;
  const inbox = new Map<string, CodexRateLimitResetCommand>();
  const sent: CodexRateLimitResetResultRequest[] = [];
  const reads = new Map<string, number>();
  const write = (next: CodexRateLimitResetOperationState, what: string) => {
    expect(codexResetTransitionViolations(op, next), `seed ${seed}: ${what}`).toEqual([]);
    op = next;
  };
  const deliver = (result: CodexRateLimitResetResultRequest) => {
    const before = op;
    const beforeStatus = codexResetOperationStatus(before);
    const application = applyCodexResetResult(op, RUNNER, result, at(clock));
    if (application.kind === 'REJECTED') return;
    if (beforeStatus && !CODEX_RATE_LIMIT_RESET_ENUMS.activeOperationStatus.includes(beforeStatus)) {
      expect(application.kind, `seed ${seed}: a settled operation only hears duplicates`).toBe('DUPLICATE');
    }
    if (application.kind === 'DUPLICATE') expect(application.operation).toBe(before);
    write(application.operation, result.kind);
  };

  for (let step = 0; step < 150; step += 1) {
    clock += Math.floor(random() * 40_000);
    const process = random() < 0.5 ? A : B;
    const roll = random();
    if (roll < 0.4) {
      const decision = decideCodexResetDispatch(op, {
        runnerId: RUNNER,
        leaseOwner: random() < 0.95 ? process : null,
        draining: random() < 0.1,
        capabilities: random() < 0.95 ? [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1] : [],
        rateLimitReset: block({ accountFingerprint: random() < 0.97 ? FP : OTHER_FP, generation: process, fetchedAt: at(clock - 500).toISOString() }),
        now: at(clock),
      });
      if (decision.kind === 'NONE') continue;
      if (decision.kind === 'DELIVER') {
        if (decision.command.phase === 'CONSUME') {
          expect(op.consumeState, `seed ${seed}: CONSUME after confirmation`).not.toBe('CONFIRMED');
          expect(decision.command.providerIdempotencyKey).toBe(PROVIDER_KEY);
        } else {
          expect(decision.operation.consumeState).toBe('CONFIRMED');
          expect(decision.command).not.toHaveProperty('providerIdempotencyKey');
        }
        expect(codexResetCommandViolations(decision.command)).toEqual([]);
        inbox.set(process, decision.command);
      }
      write(decision.operation, decision.kind);
    } else if (roll < 0.8) {
      const command = inbox.get(process);
      if (!command) continue;
      const envelope = {
        protocolVersion: 1,
        operationId: command.operationId,
        leaseOwner: command.leaseOwner,
        claimGeneration: command.claimGeneration,
        phase: command.phase,
      };
      const pick = random();
      let result: CodexRateLimitResetResultRequest;
      if (command.phase === 'CONSUME') {
        const key = command.providerIdempotencyKey as string;
        if (pick < 0.1) result = { ...envelope, kind: 'RELEASED', code: 'RUNNER_DRAINING' };
        else if (pick < 0.2) result = { ...envelope, kind: 'CONSUME_NOT_CALLED', code: 'ACCOUNT_MISMATCH' };
        else if (pick < 0.35) {
          if (random() < 0.5) consumeAt(provider, key); // the call landed; its answer did not
          result = { ...envelope, kind: 'CONSUME_RETRYING', code: 'PROVIDER_TIMEOUT' };
        } else result = { ...envelope, kind: 'CONSUME_OUTCOME', outcome: consumeAt(provider, key) };
      } else if (pick < 0.1) result = { ...envelope, kind: 'RELEASED', code: 'RUNNER_DRAINING' };
      else if (pick < 0.25) result = { ...envelope, kind: 'REFRESH_FAILED', code: 'READ_FAILED' };
      else if (pick < 0.3) result = { ...envelope, kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' };
      else {
        const sequence = (reads.get(command.leaseOwner) ?? 0) + 1;
        reads.set(command.leaseOwner, sequence);
        result = {
          ...envelope,
          kind: 'REFRESHED',
          rateLimitReset: block({
            generation: command.leaseOwner,
            fetchedAt: at(clock).toISOString(),
            sequence,
            rateLimitResetCredits: { availableCount: provider.credits, credits: null },
          }),
        };
      }
      expect(codexResetResultViolations(result)).toEqual([]);
      sent.push(result);
      deliver(result);
    } else if (roll < 0.9) {
      if (sent.length > 0) deliver(sent[Math.floor(random() * sent.length)]);
    } else {
      const expired = expireCodexResetOperation(op, at(clock));
      if (expired) write(expired, 'expiry');
    }
  }
  expect(initialCredits - provider.credits, `seed ${seed}: credits consumed`).toBeLessThanOrEqual(1);
  expect([...provider.keys].every((key) => key === PROVIDER_KEY), `seed ${seed}: keys sent`).toBe(true);
}

describe('invariants under arbitrary interleavings', () => {
  it('never re-keys, never consumes twice, never consumes after confirmation, never moves backwards', () => {
    for (let seed = 1; seed <= 250; seed += 1) walk(seed);
  });
});
