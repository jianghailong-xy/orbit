/**
 * The Project and Task refusal wire contract (refusal-recovery.ts), held three ways:
 *
 *  - the table is `contracts/project-task-refusals.contract.json`, entry for entry;
 *  - every entry, served, reads back through the client parser (`@orbit/shared` parseRecovery, the
 *    same rules runner-go applies) as exactly what the server stated: the invariants never have to
 *    overrule the server, so the server and every client reach the same decision;
 *  - the real refusal builders (scope rules, project dispatch gates, coded bodies) produce only codes
 *    the table answers, and a body the table does not cover, a 404 above all, is left untouched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { parseRecovery, uuidToBase62 } from '@orbit/shared';

import { scopeRefusalBody } from '../projects/project-scope-admission';
import { SCOPE_RULES, SCOPE_REFUSAL_POLICY } from '../projects/project-scope-contract';
import {
  REFUSAL_RECOVERY,
  attachRefusalRecovery,
  codedRefusal,
  planFindingRecovery,
  refusalRecoveryFor,
} from './refusal-recovery';

const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = JSON.parse(readFileSync(path.join(REPO, 'contracts/project-task-refusals.contract.json'), 'utf8'));
const RECOVERY_CONTRACT = JSON.parse(readFileSync(path.join(REPO, 'contracts/recovery.contract.json'), 'utf8'));

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A body for one entry with every field its resources read filled in, as a throw site would. */
function bodyFor(entry: (typeof REFUSAL_RECOVERY)[number]): Record<string, unknown> {
  const body: Record<string, unknown> = { statusCode: entry.status, code: entry.code, message: 'prose nobody branches on' };
  if (entry.requiredAction) body.requiredAction = entry.requiredAction;
  entry.resources.forEach(([, field], i) => {
    const keys = field.split('.');
    let at = body;
    for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
    at[keys[keys.length - 1]!] = UUID(i + 1);
  });
  return body;
}

test('the table is the published wire contract, entry for entry', () => {
  assert.equal(CONTRACT.name, 'orbit.project-task-refusals');
  assert.equal(CONTRACT.recoveryContractVersion, RECOVERY_CONTRACT.contractVersion);
  assert.deepEqual(CONTRACT.refusals, REFUSAL_RECOVERY);
});

test('every entry names a code, a status, at least one door, resources, and values of the recovery contract', () => {
  const enums = RECOVERY_CONTRACT.enums;
  const seen = new Set<string>();
  for (const entry of REFUSAL_RECOVERY) {
    const key = `${entry.code}/${entry.requiredAction ?? ''}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
    assert.match(entry.code, /^[A-Z][A-Z0-9_]*$/);
    assert.ok([400, 403, 409].includes(entry.status), key);
    assert.ok(entry.endpoints.length > 0 && entry.endpoints.every((e) => /^(GET|POST|PATCH|PUT|DELETE) \//.test(e)), key);
    assert.ok(entry.resources.length > 0, `${key} names no resource`);
    const r = entry.recovery;
    assert.ok(enums.effect.includes(r.effect), key);
    assert.ok(enums.retryPolicy.includes(r.retryPolicy), key);
    assert.ok(enums.actor.includes(r.actor), key);
    assert.ok(enums.userConfirmation.includes(r.userConfirmation), key);
    assert.ok(enums.disposition.includes(r.disposition), key);
    assert.ok(r.actionCode === null || r.actionCode in RECOVERY_CONTRACT.actionCodes, `${key}: ${r.actionCode} is not registered`);
  }
});

test('served, every entry reads back through the client parser as exactly what the server stated', () => {
  for (const entry of REFUSAL_RECOVERY) {
    const body = bodyFor(entry);
    attachRefusalRecovery(body);
    const env = parseRecovery({ source: 'HTTP', status: entry.status, body: JSON.stringify(body) });
    assert.ok(env, entry.code);
    const key = `${entry.code}/${entry.requiredAction ?? ''}`;
    assert.equal(env.kind, 'REFUSAL', key);
    assert.equal(env.effect, entry.recovery.effect, key);
    assert.equal(env.retry.policy, entry.recovery.retryPolicy, key);
    assert.equal(env.actionCode, entry.recovery.actionCode, key);
    assert.equal(env.actor, entry.recovery.actor, key);
    assert.equal(env.userConfirmation, entry.recovery.userConfirmation, key);
    assert.equal(env.disposition, entry.recovery.disposition, key);
    // The ids are public, in the order the entry reads them, and only the ones the body carried.
    assert.deepEqual(env.resources, entry.resources.map(([type], i) => ({ type, id: uuidToBase62(UUID(i + 1)) })), key);
  }
});

test('the five dispositions are each reached, and the target recoveries read first where they must', () => {
  const by = (code: string, requiredAction?: string) =>
    REFUSAL_RECOVERY.find((e) => e.code === code && e.requiredAction === requiredAction)!.recovery;
  assert.deepEqual(new Set(REFUSAL_RECOVERY.map((e) => e.recovery.disposition)),
    new Set(['AUTOMATIC', 'WAIT', 'CONFIRM_THEN_RUN', 'HUMAN', 'STOP']));
  // Stale config: read the project, then decide again; never the identical write.
  assert.equal(by('STALE_CONFIG_REVISION').actionCode, 'REREAD_AND_DECIDE');
  assert.equal(by('STALE_CONFIG_REVISION').retryPolicy, 'NEVER');
  // Dependencies: read the graph, then recompute.
  assert.equal(by('DEPENDENCY_CYCLE').actionCode, 'READ_GRAPH_AND_REPLAN');
  assert.equal(by('DEPENDENCY_DUPLICATE').actionCode, 'READ_GRAPH_AND_REPLAN');
  // Delete and every cross-project action wait for the owner's confirmation.
  for (const code of ['PROJECT_NOT_EMPTY', 'CROSS_PROJECT_APPROVAL_REQUIRED', 'APPROVAL_PENDING', 'APPROVAL_EXPIRED']) {
    assert.equal(by(code).userConfirmation, 'REQUIRED', code);
    assert.equal(by(code).disposition, 'CONFIRM_THEN_RUN', code);
  }
});

test('every refusal a scope rule can serve is answered by its own entry, not by inference', () => {
  for (const rule of SCOPE_RULES) {
    if (!rule.code) continue;
    const body = scopeRefusalBody({
      decision: SCOPE_REFUSAL_POLICY[rule.code].decision,
      rule: rule.id,
      code: rule.code,
      responsible: SCOPE_REFUSAL_POLICY[rule.code].responsible,
      requiredAction: rule.requiredAction,
      blockerKind: null,
      ends: { from: UUID(1), to: UUID(2) },
      crossing: true,
    } as never, UUID(3));
    const exact = REFUSAL_RECOVERY.find((e) => e.code === rule.code
      && (e.requiredAction === undefined || e.requiredAction === rule.requiredAction));
    assert.ok(exact, `${rule.id} (${rule.code}/${rule.requiredAction}) has no entry`);
    const recovery = refusalRecoveryFor(body as unknown as Record<string, unknown>);
    assert.ok(recovery, rule.id);
    assert.equal(recovery.disposition, exact.recovery.disposition, rule.id);
    assert.ok(recovery.resources.length > 0, `${rule.id} names nothing to read`);
  }
});

test('a STALE_CONFIG_REVISION is read first: its next step is the project it names', () => {
  const body = codedRefusal(409, 'STALE_CONFIG_REVISION', 'moved', { projectId: UUID(7), configRevision: '4' });
  attachRefusalRecovery(body);
  assert.deepEqual((body.recovery as { resources: unknown }).resources, [{ type: 'PROJECT', id: uuidToBase62(UUID(7)) }]);
});

test('a body the table does not cover, and a 404 above all, is left exactly as it was', () => {
  const notFound = new NotFoundException('task not found').getResponse() as Record<string, unknown>;
  const before = JSON.stringify(notFound);
  attachRefusalRecovery(notFound);
  assert.equal(JSON.stringify(notFound), before);

  const unknown = { code: 'SOME_OTHER_REFUSAL', message: 'x', taskId: UUID(1) };
  attachRefusalRecovery(unknown);
  assert.equal('recovery' in unknown, false);

  const own = { code: 'DEPENDENCY_CYCLE', message: 'x', recovery: { effect: 'UNKNOWN' } };
  attachRefusalRecovery(own);
  assert.deepEqual(own.recovery, { effect: 'UNKNOWN' }, 'a body that states its own block keeps it');
});

test('a recovery block never names an id the body did not already carry', () => {
  for (const entry of REFUSAL_RECOVERY) {
    const body: Record<string, unknown> = { code: entry.code, message: 'x' };
    if (entry.requiredAction) body.requiredAction = entry.requiredAction;
    attachRefusalRecovery(body);
    assert.deepEqual((body.recovery as { resources: unknown[] }).resources, [], entry.code);
  }
});

test('plan findings: scope codes keep their entry, PLAN_* codes are a changed plan unless a person owns the fix', () => {
  assert.equal(planFindingRecovery('CROSS_PROJECT_APPROVAL_REQUIRED', 'AWAIT_HANDOFF_APPROVAL').disposition, 'CONFIRM_THEN_RUN');
  assert.equal(planFindingRecovery('PLAN_PARENT_CROSSES_PROJECT').actionCode, 'FIX_REQUEST');
  assert.equal(planFindingRecovery('PLAN_ASSIGNEE_HAS_NO_RUNNER').disposition, 'HUMAN');
});
