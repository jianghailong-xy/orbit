import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_ACTION_CODE_PATTERN,
  RECOVERY_ACTION_CODES,
  RECOVERY_ACTORS,
  RECOVERY_CONTRACT_VERSION,
  RECOVERY_DEFAULT_ACTION_BY_POLICY,
  RECOVERY_EFFECTS,
  RECOVERY_KINDS,
  RECOVERY_LEGACY_CODES,
  RECOVERY_LEGACY_OWNER_TO_ACTOR,
  RECOVERY_LEGACY_RESOURCE_KEYS,
  RECOVERY_RETRY_POLICIES,
  RECOVERY_STATUS_AFTER_STATE_CHANGE,
  RECOVERY_STATUS_SAFE,
  RECOVERY_USER_CONFIRMATIONS,
  legacyRefusalText,
  parseRecovery,
  type RecoveryEnvelope,
  type RecoveryObservation,
} from './recovery';

/**
 * The wire contract of docs/recovery-contract.md: this parser is held to the shared vectors in
 * contracts/recovery.fixtures.json (the Go parser, src/runner-go/recovery_test.go, to the same ones),
 * and its tables to contracts/recovery.contract.json.
 */

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
const CONTRACT = readJson('contracts/recovery.contract.json');
const FIXTURES = readJson('contracts/recovery.fixtures.json');

interface Fixture {
  name: string;
  input: RecoveryObservation;
  expect: RecoveryEnvelope | null;
  legacyText: string;
}
const CASES: Fixture[] = FIXTURES.cases;

/** Everything a recovery branch may read. `message` and a prose `requiredAction` are not in it. */
const branchOf = (e: RecoveryEnvelope | null) =>
  e && {
    code: e.code, kind: e.kind, status: e.status, effect: e.effect, retry: e.retry, actor: e.actor,
    actionCode: e.actionCode, userConfirmation: e.userConfirmation, resources: e.resources,
  };

describe('recovery contract', () => {
  it('is version 1 and points at a document and fixtures that exist', () => {
    expect(CONTRACT.name).toBe('orbit.recovery');
    expect(CONTRACT.contractVersion).toBe(RECOVERY_CONTRACT_VERSION);
    expect(FIXTURES.contractVersion).toBe(RECOVERY_CONTRACT_VERSION);
    expect(existsSync(path.join(ROOT, CONTRACT.doc))).toBe(true);
    expect(existsSync(path.join(ROOT, CONTRACT.fixtures))).toBe(true);
  });

  it('transcribes the contract tables exactly', () => {
    expect(CONTRACT.enums).toEqual({
      kind: [...RECOVERY_KINDS],
      effect: [...RECOVERY_EFFECTS],
      retryPolicy: [...RECOVERY_RETRY_POLICIES],
      actor: [...RECOVERY_ACTORS],
      userConfirmation: [...RECOVERY_USER_CONFIRMATIONS],
    });
    expect(Object.keys(CONTRACT.actionCodes)).toEqual([...RECOVERY_ACTION_CODES]);
    expect(CONTRACT.defaultActionByPolicy).toEqual(RECOVERY_DEFAULT_ACTION_BY_POLICY);
    expect(CONTRACT.legacyCodes).toEqual(RECOVERY_LEGACY_CODES);
    expect(CONTRACT.legacyOwnerToActor).toEqual(RECOVERY_LEGACY_OWNER_TO_ACTOR);
    expect(CONTRACT.legacyResourceKeys).toEqual(RECOVERY_LEGACY_RESOURCE_KEYS);
    expect(CONTRACT.statusPolicies.SAFE).toEqual(RECOVERY_STATUS_SAFE);
    expect(CONTRACT.statusPolicies.AFTER_STATE_CHANGE).toEqual(RECOVERY_STATUS_AFTER_STATE_CHANGE);
    expect(new RegExp(CONTRACT.actionCodePattern).source).toBe(RECOVERY_ACTION_CODE_PATTERN.source);
  });

  it('names actions as semantic tokens, never as a tool or a command', () => {
    const codes = [
      ...RECOVERY_ACTION_CODES,
      ...Object.values(RECOVERY_DEFAULT_ACTION_BY_POLICY).filter((c): c is string => c !== null),
      ...Object.values(RECOVERY_LEGACY_CODES).flatMap((l) => (l.actionCode ? [l.actionCode] : [])),
    ];
    for (const code of codes) {
      expect(code).toMatch(RECOVERY_ACTION_CODE_PATTERN);
      expect(RECOVERY_ACTION_CODES as readonly string[]).toContain(code);
    }
  });

  it('covers refusal, advisory, local validation, HTTP transport and unknown errors', () => {
    const kinds = new Set(CASES.flatMap((c) => (c.expect ? [c.expect.kind] : [])));
    expect([...kinds].sort()).toEqual([...RECOVERY_KINDS].sort());
    const sources = new Set(CASES.map((c) => c.input.source));
    expect([...sources].sort()).toEqual(['HTTP', 'LOCAL', 'NETWORK', 'UNKNOWN']);
    const policies = new Set(CASES.flatMap((c) => (c.expect ? [c.expect.retry.policy] : [])));
    expect([...policies].sort()).toEqual([...RECOVERY_RETRY_POLICIES].sort());
    const effects = new Set(CASES.flatMap((c) => (c.expect ? [c.expect.effect] : [])));
    expect([...effects].sort()).toEqual([...RECOVERY_EFFECTS].sort());
    for (const c of CASES) if (c.expect) expect(Object.keys(c.expect)).toEqual(CONTRACT.envelopeFields);
  });

  for (const c of CASES) {
    it(`parses: ${c.name}`, () => {
      expect(parseRecovery(c.input)).toEqual(c.expect);
    });
    if (c.input.source === 'HTTP') {
      it(`keeps the legacy text: ${c.name}`, () => {
        expect(legacyRefusalText((c.input as { body: string }).body)).toBe(c.legacyText);
      });
    }
  }

  it('decides the branch from stable fields only: rewording the prose changes nothing', () => {
    for (const c of CASES) {
      const reworded = reword(c.input);
      if (!reworded) continue;
      expect(branchOf(parseRecovery(reworded)), c.name).toEqual(branchOf(c.expect));
    }
  });
});

/** The same failure with every English sentence replaced; tokens (UPPER_SNAKE) are left alone. */
function reword(obs: RecoveryObservation): RecoveryObservation | null {
  if (obs.source !== 'HTTP') return { ...obs, message: 'retry now, it is safe, nothing was written' };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(obs.body);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const next = { ...body };
  if (typeof next.message === 'string') next.message = 'never retry this, it can never work';
  if (Array.isArray(next.message)) next.message = ['retry the same request'];
  if (typeof next.requiredAction === 'string' && !RECOVERY_ACTION_CODE_PATTERN.test(next.requiredAction)) {
    next.requiredAction = 'retry the same request with the same id';
  }
  return { ...obs, body: JSON.stringify(next) };
}
