/**
 * Every refusal of work on a settled project names the way through (docs/project-reopen-request-design.md §4.4): the
 * agent asks the account owner with project_request_reopen, then retries its write. Four sites refuse it — the scope
 * admission's REOPEN_PROJECT_FIRST (R8, R8B), the owner's confirmation of a task move (tasks.service), the filing of a
 * move (project-handoff.service) and a criterion move (criterion-move) — and the served body carries
 * `nextTool: "project_request_reopen"` beside its recovery block (refusal-recovery.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PROJECT_REOPEN_TOOL } from '@orbit/shared';

import { attachRefusalRecovery, codedRefusal } from '../common/refusal-recovery';
import { planCriterionMove } from './criterion-move';
import { REQUEST_REOPEN_NEXT_STEP } from './project-acceptance';
import { scopeRefusalBody } from './project-scope-admission';
import { SCOPE_REFUSAL_POLICY, SCOPE_RULE_BY_ID } from './project-scope-contract';

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRC = path.resolve(__dirname, '../../src');

test('the next step names the tool, the project id, why, the planned work, and the retry', () => {
  assert.equal(PROJECT_REOPEN_TOOL, 'project_request_reopen');
  assert.equal(
    REQUEST_REOPEN_NEXT_STEP,
    'To ask them, call project_request_reopen with the project id, why, and the work you plan to add, then retry '
      + 'this write once the request is answered.',
  );
});

test('R8 and R8B (REOPEN_PROJECT_FIRST) name project_request_reopen, and the served body names it as nextTool', () => {
  for (const ruleId of ['R8_SETTLED_PROJECT', 'R8B_SETTLED_CRITERION_SERVED']) {
    const rule = SCOPE_RULE_BY_ID[ruleId]!;
    assert.equal(rule.requiredAction, 'REOPEN_PROJECT_FIRST');
    const body = scopeRefusalBody({
      decision: SCOPE_REFUSAL_POLICY[rule.code!].decision,
      rule: rule.id,
      code: rule.code,
      responsible: SCOPE_REFUSAL_POLICY[rule.code!].responsible,
      requiredAction: rule.requiredAction,
      blockerKind: null,
      ends: { from: UUID(1), to: UUID(2) },
      crossing: ruleId === 'R8B_SETTLED_CRITERION_SERVED',
    } as never, UUID(3)) as unknown as Record<string, unknown>;
    assert.match(String(body.message), /project_request_reopen/, ruleId);
    assert.ok(String(body.message).includes(REQUEST_REOPEN_NEXT_STEP), ruleId);
    attachRefusalRecovery(body);
    assert.equal(body.nextTool, PROJECT_REOPEN_TOOL, ruleId);
    assert.ok(body.recovery, `${ruleId} keeps its recovery block`);
  }
  // R8 keeps the routing rule for a finding that changes no criterion.
  const r8 = SCOPE_RULE_BY_ID.R8_SETTLED_PROJECT!;
  const body = scopeRefusalBody({
    decision: SCOPE_REFUSAL_POLICY[r8.code!].decision, rule: r8.id, code: r8.code,
    responsible: SCOPE_REFUSAL_POLICY[r8.code!].responsible, requiredAction: r8.requiredAction, blockerKind: null,
    ends: { from: null, to: UUID(2) }, crossing: false,
  } as never, null);
  assert.match(body.message, /If it changes no criterion, create a separate project\./);
});

test('a coded PROJECT_REOPEN_REQUIRED or MOVE_TASK_SERVES_SETTLED_CRITERION body gains nextTool; others do not', () => {
  for (const code of ['PROJECT_REOPEN_REQUIRED', 'MOVE_TASK_SERVES_SETTLED_CRITERION']) {
    const body = codedRefusal(403, code, 'settled', { taskId: UUID(4) });
    attachRefusalRecovery(body);
    assert.equal(body.nextTool, PROJECT_REOPEN_TOOL, code);
  }
  const stale = codedRefusal(409, 'STALE_CONFIG_REVISION', 'moved', { projectId: UUID(7) });
  attachRefusalRecovery(stale);
  assert.equal('nextTool' in stale, false);
  // A body that already states one keeps its own.
  const own = { ...codedRefusal(403, 'PROJECT_REOPEN_REQUIRED', 'settled'), nextTool: 'something_else' };
  attachRefusalRecovery(own);
  assert.equal(own.nextTool, 'something_else');
});

test('a criterion move out of or into a settled project names project_request_reopen', () => {
  const base = {
    criterion: { satisfied: false },
    servingTasks: [],
    liveRuns: [],
  };
  const source = planCriterionMove({ ...base, source: { id: UUID(1), status: 'DONE' }, target: null } as never);
  assert.ok('refusal' in source);
  assert.equal(source.refusal.code, 'CRITERION_MOVE_SOURCE_NOT_OPEN');
  assert.match(source.refusal.message, /project_request_reopen/);
  const target = planCriterionMove({
    ...base, source: { id: UUID(1), status: 'OPEN' }, target: { id: UUID(2), status: 'CANCELLED' },
  } as never);
  assert.ok('refusal' in target);
  assert.equal(target.refusal.code, 'CRITERION_MOVE_TARGET_NOT_OPEN');
  assert.match(target.refusal.message, /project_request_reopen/);
});

test('the move confirmation and the move filing name project_request_reopen in their settled-project refusals', () => {
  // Both are thrown from inside a locked transaction, which only a database reaches; their wording is held here at
  // the throw site, next to the code it is thrown with.
  const tasks = readFileSync(path.join(SRC, 'tasks/tasks.service.ts'), 'utf8');
  const confirm = tasks.slice(tasks.indexOf("throw refuse(acceptance.refusal, 'REOPEN_PROJECT_FIRST',"));
  assert.ok(confirm.length > 0);
  assert.match(confirm.slice(0, 900), /\$\{PROJECT_REOPEN_TOOL\} \(the project id, why, and the work it plans to add\)/);

  const handoff = readFileSync(path.join(SRC, 'projects/project-handoff.service.ts'), 'utf8');
  const filing = handoff.slice(handoff.indexOf("'a settled project takes no work until the account owner reopens it'"));
  assert.ok(filing.length > 0);
  assert.match(filing.slice(0, 300), /\+ REQUEST_REOPEN_NEXT_STEP/);
});
