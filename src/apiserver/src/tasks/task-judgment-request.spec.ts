import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { routeTaskJudgment } from './task-judgment-request';

const OWNER = '00000000-0000-7000-8000-000000000011';
const SESSION = '00000000-0000-7000-8000-000000000012';
const REQUEST = '00000000-0000-7000-8000-000000000013';

test('the three completion criteria route to peer consumers with no fallback chain', () => {
  assert.deepEqual(routeTaskJudgment('EXECUTABLE', {
    ownerId: OWNER, sourceSessionId: SESSION, requestId: REQUEST,
  }), {
    kind: 'EXECUTABLE',
    recipientType: 'SYSTEM_EXECUTABLE_EVALUATOR',
    recipientId: SESSION,
  });
  assert.deepEqual(routeTaskJudgment('VERIFICATION', {
    ownerId: OWNER, sourceSessionId: SESSION, requestId: REQUEST,
  }), {
    kind: 'VERIFICATION',
    recipientType: 'VERIFIER_TASK',
    recipientId: REQUEST,
  });
  assert.deepEqual(routeTaskJudgment('HUMAN_SIGNOFF', {
    ownerId: OWNER, sourceSessionId: SESSION, requestId: REQUEST,
  }), {
    kind: 'HUMAN_SIGNOFF',
    recipientType: 'ACCOUNT_OWNER',
    recipientId: OWNER,
  });

  const source = readFileSync('src/tasks/task-judgment-request.ts', 'utf8');
  assert.doesNotMatch(source, /default\s*:/, 'adding a default would hide a new unhandled criterion');
  assert.doesNotMatch(source, /\[\s*['"]EXECUTABLE['"][\s\S]*['"]VERIFICATION['"][\s\S]*['"]HUMAN_SIGNOFF['"]\s*\]/,
    'routing must not encode an ordered fallback list');
});

test('each request kind reaches only its own judgment fact writer', () => {
  const evidence = readFileSync('src/tasks/task-completion-evidence.service.ts', 'utf8');
  const tasks = readFileSync('src/tasks/tasks.service.ts', 'utf8');
  const runner = readFileSync('src/runner-api/runner-api.controller.ts', 'utf8');

  assert.match(evidence, /kind === 'VERIFICATION'[\s\S]*ensureJudgmentVerification/);
  assert.match(tasks, /id: judgment\?\.requestId[\s\S]*verifiesTaskId: taskId/);
  assert.match(tasks, /judgmentRequest\.kind !== 'VERIFICATION'/);
  assert.match(runner, /kind: 'EXECUTABLE'[\s\S]*taskExecutableJudgmentResult\.create/);
  assert.match(runner,
    /requestBelongsToThisEvaluator\s*=\s*request == null \|\| request\.recipientId === sessionId/,
    'an explicit executable request is consumed only by its named Session');
  assert.match(runner,
    /const changed = requestBelongsToThisEvaluator[\s\S]*task\.updateMany/,
    'the legacy status path is fenced by that same recipient fact');
  assert.match(tasks, /request\.kind !== 'HUMAN_SIGNOFF'[\s\S]*taskHumanSignoff\.create/);
});

function productionTypeScript(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) productionTypeScript(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

test('only the human-signoff domain boundary can insert a HUMAN_SIGNOFF event', () => {
  const writers = productionTypeScript('src')
    .filter((path) => /taskHumanSignoff\.create\(/.test(readFileSync(path, 'utf8')))
    .map((path) => path.replaceAll('\\', '/'));
  assert.deepEqual(writers, ['src/tasks/tasks.service.ts']);

  const boundary = readFileSync(writers[0], 'utf8');
  assert.match(boundary, /if \(actingSessionId\)[\s\S]*HUMAN_SIGNOFF_REQUIRES_USER/);
  assert.match(boundary, /request\.recipientType !== 'ACCOUNT_OWNER'/);
  assert.match(boundary, /deriveTaskCompletionStatus\([\s\S]*humanSignoff: true/);
});
