import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childPrompt, evaluate, grade, project, scenarios } from '../scripts/already-coordinating-eval.mjs';

// A reference adapter exercises the evaluator, not a claim that an LLM followed the contract.
// Candidate engines use exactly the same callback and observations through the module's CLI.
function referenceAgent() {
  return async ({ messages, tools, capabilityReason, capabilities, call }) => {
    const users = messages.filter(m => m.role === 'user');
    await call('project_get', { projectId: 'P1' });
    if (users[0].content.includes('"title":"Corpus"')) return 'Corpus (P1) is already recorded.';
    const manual = () => 'You can start a new session and send this opening prompt:\n' + childPrompt
      + '\nCLI cannot bypass the same permission gate.'
      + ((capabilityReason ?? capabilities?.[0]?.reason) === 'ORCHESTRATION_DISABLED'
        ? '\nThe account owner can enable Settings -> Session orchestration.' : '');
    if (users.length === 1) return 'This session keeps coordinating Corpus (P1). Open a child session?'
      + (tools.includes('session_create') ? '' : '\n' + manual());
    if (users.at(-1).content.startsWith('No')) return 'No child was created.';
    if (!tools.includes('session_create')) return manual();
    const result = await call('session_create', { prompt: childPrompt });
    if (result.ok) return 'Child session S2 was opened; its first prompt will record the project.';
    const { code, recovery } = result.error;
    const shared = ' CLI cannot bypass the same permission gate.';
    if (recovery.disposition === 'WAIT') return `${code}: I will wait for outstanding children to finish.${shared}`;
    if (recovery.disposition === 'STOP') return `${code}: I must stop here.${shared}`;
    return manual() + '\nThe account owner can enable Settings -> Session orchestration.';
  };
}

for (const surface of ['mcp', 'cli', 'legacy']) {
  for (const scenario of scenarios) {
    test(`Agent contract ${surface}/${scenario.name}`, async () => {
      await evaluate(referenceAgent(), surface, scenario);
    });
  }
}

const confirmed = scenarios.find(s => s.name === 'confirmed');
const valid = () => ({ replies: ['Corpus (P1) stays here. Open a child session?', 'Opened S2.'],
  calls: [{ name: 'project_get', args: { projectId: 'P1' }, turn: 0 },
    { name: 'session_create', args: { prompt: childPrompt }, turn: 1 }] });
const mutations = {
  'child before confirmation': t => { t.calls[1].turn = 0; },
  'duplicate child': t => { t.calls.push(structuredClone(t.calls[1])); },
  'immediate session_send': t => { t.calls.push({ name: 'session_send', args: { sessionId: 'S2' }, turn: 1 }); },
  'manual-only conclusion': t => { t.replies[1] = 'You must manually open a session.'; },
  'lost project arguments': t => { t.calls[1].args.prompt = 'Create the project discussed above.'; },
  'no confirmation question': t => { t.replies[0] = 'Corpus (P1) stays here.'; },
  'multiple confirmation questions': t => { t.replies[0] += ' Which workspace?'; },
  'no child despite confirmation': t => { t.calls = []; },
  'CLI permission bypass': t => { t.calls.push({ name: 'Bash', args: { command: 'orbit session create' }, turn: 1 }); },
  'missing project identity': t => { t.replies[0] = 'Open a child session?'; },
  'no reconciliation': t => { t.calls.shift(); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`reject Agent regression: ${name}`, () => {
    const trace = valid();
    mutate(trace);
    assert.throws(() => grade(trace, confirmed), assert.AssertionError);
  });
}

test('confirmation gate language is not mistaken for a manual-only conclusion', () => {
  const trace = valid();
  trace.replies[0] = 'Corpus (P1) stays here. I cannot open a session until you confirm. Open a child session?';
  grade(trace, confirmed);
});

test('reconciliation can compare the refusal with the requested project without another read', () => {
  const trace = valid();
  trace.calls.shift();
  trace.replies[0] = 'Corpus (P1) is different from Refresh the search index. Open a child session?';
  grade(trace, confirmed);
});

test('reconciliation can recognize the same project from the refusal without another read', () => {
  grade({ calls: [], replies: ['Corpus (P1) already exists.'] }, scenarios.find(s => s.sameProject));
});

test('unconfirmed interaction cannot invoke even one child', async () => {
  await assert.rejects(evaluate(async ({ call }) => {
    await call('session_create', { prompt: childPrompt });
    return 'Opened.';
  }, 'mcp', scenarios[0]), /explicit confirmation/);
});

for (const name of ['backpressure', 'permission-expired', 'orchestration-off', 'capability-missing']) {
  test(`reject wrong fallback or actor: ${name}`, async () => {
    const scenario = scenarios.find(s => s.name === name);
    const trace = await evaluate(referenceAgent(), 'mcp', scenario);
    trace.replies[trace.replies.length - 1] = 'Try again now using CLI to bypass the gate.';
    assert.throws(() => grade(trace, scenario), assert.AssertionError);
  });
}

for (const [name, text] of [
  ['backpressure', 'The user must wait for children to finish. CLI cannot bypass the same permission gate.'],
  ['permission-expired', 'The user must stop. CLI cannot bypass the same permission gate.'],
  ['orchestration-off', `You can start a new session and send this prompt: ${childPrompt}\n`
    + 'I will enable Settings -> Session orchestration. CLI cannot bypass the same permission gate.'],
  ['capability-missing', `I will start a new session with ${childPrompt}\nCLI cannot bypass the same permission gate.`],
]) {
  test(`reject fallback assigned to the wrong actor: ${name}`, async () => {
    const scenario = scenarios.find(s => s.name === name);
    const trace = await evaluate(referenceAgent(), 'mcp', scenario);
    trace.replies[trace.replies.length - 1] = text;
    assert.throws(() => grade(trace, scenario), assert.AssertionError);
  });
}

test('opening prompt carries exact parameters and success receipt', () => {
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(childPrompt)[1]), project);
  assert.match(childPrompt, /PROJECT_CREATED projectId=<id> coordinatorSessionId=<id>/);
  assert.match(childPrompt, /Parent session S1 keeps coordinating project Corpus \(id: P1\)/);
});

test('production guidance and server fixture retain the chain exercised by the eval', () => {
  const service = readFileSync(new URL('../src/apiserver/src/projects/projects.service.ts', import.meta.url), 'utf8');
  for (const text of ['coordinatingProject', 'childSessionPrompt', 'Otherwise ask the user first',
    'call session_create once', 'do not follow it with', 'session_send']) assert.ok(service.includes(text), text);
  const fixture = readFileSync(new URL('../src/apiserver/src/runner-api/already-coordinating-child-chain.pg.spec.ts', import.meta.url), 'utf8');
  for (const text of ['bRow.coordinatorSessionId, childId', 'childRow.parentSessionId, parent',
    'the parent still coordinates the original Project', 'no session_send follows the create']) assert.ok(fixture.includes(text), text);
});

test('candidate adapter CLI runs all interactions and refuses a missing adapter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'already-coordinating-'));
  try {
    const evaluator = fileURLToPath(new URL('../scripts/already-coordinating-eval.mjs', import.meta.url));
    const adapter = join(dir, 'adapter.mjs');
    writeFileSync(adapter, `import { childPrompt } from ${JSON.stringify(new URL('../scripts/already-coordinating-eval.mjs', import.meta.url).href)};\n`
      + `export const createAgent = ${referenceAgent.toString()};\n`);
    const run = spawnSync(process.execPath, [evaluator, adapter], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.split('\n').filter(line => line.startsWith('PASS ')).length, scenarios.length * 3);
    const absent = spawnSync(process.execPath, [evaluator], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /provide a candidate adapter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
