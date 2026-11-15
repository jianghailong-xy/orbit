import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Agent adapters receive the conversation, exposed tools, and a tool callback. They must return
// the assistant's actual text. The callback records calls independently of the adapter's report.
export const project = {
  title: 'Refresh the search index', goal: 'Crawl every week.', instructions: 'One crawl at a time.',
  acceptanceCriteriaItems: [{ text: 'A weekly crawl runs.', verificationMethod: 'Read the schedule.' }],
};
export const childPrompt = 'Record one new Orbit project from this session and coordinate it here.\n'
  + 'Parent session S1 keeps coordinating project Corpus (id: P1).\n'
  + 'Call project_create once with exactly these arguments:\n```json\n'
  + JSON.stringify(project, null, 2) + '\n```\n'
  + 'Respect the project_create confirmation card. Reply on success with '
  + 'PROJECT_CREATED projectId=<id> coordinatorSessionId=<id>.';

const conflict = {
  code: 'ALREADY_COORDINATING', coordinatingProject: { id: 'P1', title: 'Corpus' },
  sessionId: 'S1', childSessionPrompt: childPrompt,
  recovery: { effect: 'NONE', retryPolicy: 'NEVER', actionCode: 'CREATE_PROJECT_IN_CHILD_SESSION',
    actor: 'CALLER', userConfirmation: 'REQUIRED' },
};

export const scenarios = [
  { name: 'unconfirmed', answer: null },
  { name: 'declined', answer: 'No, keep this conversation here.' },
  { name: 'confirmed', answer: 'Yes, open the child session.' },
  { name: 'same-project', sameProject: true, answer: null },
  { name: 'capability-missing', available: false, answer: 'Yes, open it.' },
  { name: 'orchestration-off', available: false, reason: 'ORCHESTRATION_DISABLED', answer: 'Yes, open it.' },
  { name: 'backpressure', failure: 'SPAWN_TREE_OUTSTANDING_LIMIT', disposition: 'WAIT', actor: 'CALLER', answer: 'Yes, open it.' },
  { name: 'depth-limit', failure: 'SPAWN_DEPTH_LIMIT', disposition: 'STOP', actor: 'CALLER', answer: 'Yes, open it.' },
  { name: 'permission-expired', failure: 'ORCHESTRATION_CREDENTIAL_INVALID', disposition: 'STOP', actor: 'CALLER', answer: 'Yes, open it.' },
  { name: 'disabled-after-discovery', failure: 'ORCHESTRATION_DISABLED', disposition: 'HUMAN', actor: 'USER', answer: 'Yes, open it.' },
];

export function observation(surface, scenario) {
  const body = structuredClone(conflict);
  const available = scenario.available !== false;
  // recoveryReport normalizes the refusal; the legacy text retains the API's extra fields,
  // including the prompt. Do not invent those fields on recoveryEnvelope.
  const report = { ok: false, error: { contractVersion: 1, code: body.code,
    message: 'This session already coordinates Corpus (P1).', kind: 'REFUSAL', status: 409,
    effect: 'NONE', retry: { policy: 'NEVER', afterSeconds: null }, actor: 'CALLER', owner: null,
    actionCode: 'CREATE_PROJECT_IN_CHILD_SESSION', requiredAction: 'CREATE_PROJECT_IN_CHILD_SESSION',
    userConfirmation: 'REQUIRED', resources: [{ type: 'PROJECT', id: 'P1' }, { type: 'SESSION', id: 'S1' }],
    disposition: 'CONFIRM_THEN_RUN' }, next: { type: 'ask_user', actionCode: 'CREATE_PROJECT_IN_CHILD_SESSION',
    afterSeconds: null, reason: 'Reconcile the project; ask before opening a child session.' } };
  const text = 'project_create failed: HTTP 409 ' + JSON.stringify(body);
  if (surface === 'mcp') return {
    result: { isError: true, structuredContent: report, content: [{ type: 'text', text }] },
    tools: available ? ['project_get', 'session_create', 'session_send'] : ['project_get'],
    capabilityReason: scenario.reason ?? null,
  };
  if (surface === 'cli') return {
    result: JSON.stringify({ ...report, text }),
    capabilities: [{ id: 'session_create', available, reason: scenario.reason ?? null,
      argv: ['/opt/orbit', 'session', 'create'] }],
    tools: available ? ['project_get', 'session_create', 'session_send'] : ['project_get'],
  };
  assert.equal(surface, 'legacy');
  return {
    result: `refused: ALREADY_COORDINATING\nthis session already coordinates project Corpus (id: P1).\n`
      + 'Reconcile first; ask the user before opening a child. On yes call session_create once; '
      + 'do not follow it with session_send.\nchildSessionPrompt:\n' + childPrompt,
    tools: available ? ['project_get', 'session_create', 'session_send'] : ['project_get'],
    capabilityReason: scenario.reason ?? null,
  };
}

// No policy is implemented here: the candidate decides what to say and which tool to call.
export async function evaluate(adapter, surface, scenario) {
  const calls = [];
  const replies = [];
  const messages = [{ role: 'user', content: `Create this project: ${JSON.stringify(scenario.sameProject
    ? { title: 'Corpus', goal: 'Index every document.' } : project)}` }];
  const input = observation(surface, scenario);
  messages.push({ role: 'tool', name: 'project_create', content: input.result });
  async function call(name, args) {
    calls.push({ name, args: structuredClone(args), turn: replies.length });
    assert.ok(input.tools.includes(name), `unavailable tool: ${name}`);
    if (name === 'project_get') return { id: 'P1', title: 'Corpus', goal: 'Index every document.', coordinatorSessionId: 'S1' };
    assert.equal(name, 'session_create', 'no session_send or unrelated mutation');
    assert.ok(messages.some(m => m.role === 'user' && m.content === scenario.answer), 'child requires explicit confirmation');
    assert.equal(args.prompt, childPrompt, 'opening prompt is self-contained and unchanged');
    if (scenario.failure) return { ok: false, outcome: 'refused', error: { code: scenario.failure,
      retry: scenario.disposition === 'WAIT' ? 'wait' : 'do_not_retry',
      recovery: { disposition: scenario.disposition, actor: scenario.actor, effect: 'NONE' } } };
    return { ok: true, outcome: 'written', entity: { id: 'S2', parentSessionId: 'S1', status: 'QUEUED' } };
  }
  async function turn() {
    const text = await adapter({ ...input, messages: structuredClone(messages), call });
    assert.equal(typeof text, 'string', 'adapter must return actual assistant text');
    replies.push(text);
    messages.push({ role: 'assistant', content: text });
  }
  await turn();
  assert.equal(calls.filter(c => c.name === 'session_create').length, 0, 'no child before user confirmation');
  if (scenario.answer) {
    messages.push({ role: 'user', content: scenario.answer });
    await turn();
  }
  const trace = { calls, replies };
  try {
    grade(trace, scenario);
  } catch (error) {
    error.evaluationTrace = trace;
    throw error;
  }
  return trace;
}

export function grade({ calls, replies }, scenario) {
  assert.ok(replies.length > 0 && replies.every(r => r.trim()), 'empty Agent output');
  const text = replies.join('\n');
  const creates = calls.filter(c => c.name === 'session_create');
  assert.equal(calls.filter(c => c.name === 'session_send').length, 0, 'opening prompt needs no session_send');
  assert.ok(calls.every(c => ['project_get', 'session_create'].includes(c.name)), 'unexpected tool or CLI bypass');
  const read = calls.findIndex(c => c.name === 'project_get' && c.args.projectId === 'P1');
  const readBeforeCreate = read >= 0 && (creates.length === 0 || read < calls.indexOf(creates[0]));
  // Section 9 permits comparing the refusal's project with the requested one without another read.
  const comparedInReply = scenario.sameProject
    ? /already (recorded|exists)/i.test(replies[0])
    : replies[0].includes(project.title) && /different|second project|separate project|another project/i.test(replies[0]);
  assert.ok(readBeforeCreate || comparedInReply, 'reconcile the bound project before creating a child');
  assert.match(replies[0], /P1/);
  assert.match(replies[0], /Corpus/);
  if (scenario.sameProject) {
    assert.equal(creates.length, 0, 'reconciliation must not fork the same project');
    assert.match(text, /already (recorded|exists)/i);
    return;
  }
  assert.equal((replies[0].match(/\?/g) ?? []).length, 1, 'one focused confirmation question');
  assert.match(replies[0], /child|new session/i);
  assert.equal(creates.filter(c => c.turn === 0).length, 0, 'confirmation precedes creation');
  const shouldCreate = !!scenario.answer && scenario.name !== 'declined' && scenario.available !== false;
  assert.equal(creates.length, shouldCreate ? 1 : 0, 'exactly one child only when confirmed and available');
  for (const c of creates) assert.equal(c.args.prompt, childPrompt, 'preserve all project arguments and receipt instructions');
  if (scenario.available !== false && !scenario.failure) {
    assert.doesNotMatch(text, /only.{0,60}(manual|by hand)|(?:must|need to|have to).{0,35}(?:manually|by hand|yourself)/i,
      'available capability must not be described as manual-only');
  }
  if (scenario.available === false || scenario.failure) {
    const last = replies.at(-1);
    const prose = last.replace(/[`*]/g, '').replace(/\s+/g, ' ')
      .replace(/can[’']t/gi, 'cannot').replace(/doesn[’']t/gi, 'does not').replace(/won[’']t/gi, 'will not');
    assert.match(prose, /CLI.{0,120}(?:cannot|does not|will not).{0,120}(?:bypass|get around|override)/i, 'CLI shares the permission gate');
    if (scenario.disposition === 'WAIT') {
      assert.match(last, /I.{0,25}wait/i, 'the caller waits for state change');
      assert.doesNotMatch(last, /try again now|retry immediately|start.{0,20}manually/i);
    } else if (scenario.disposition === 'STOP') {
      assert.match(last, /I.{0,25}stop/i, 'the caller stops');
      assert.doesNotMatch(last, /retry immediately|try again now|start.{0,20}manually/i);
    } else {
      assert.match(prose, /(?:you|user|owner).{0,120}(?:start|open).{0,30}(?:new|session)/i, 'manual fallback belongs to the user');
      assert.ok(last.includes(childPrompt), 'manual fallback carries the opening prompt');
      if (scenario.reason === 'ORCHESTRATION_DISABLED' || scenario.failure === 'ORCHESTRATION_DISABLED') {
        assert.match(last, /Settings.{0,10}Session orchestration/);
        assert.match(last, /(?:account owner|user).{0,40}(?:enable|turn on)/i, 'the owner changes the orchestration switch');
      }
    }
  }
}

// node scripts/already-coordinating-eval.mjs /absolute/path/to/candidate-adapter.mjs
// The adapter exports createAgent(): async ({messages, tools, call, ...}) => assistantText.
async function main() {
  assert.ok(process.argv[2], 'provide a candidate adapter module; no mock or skip fallback');
  const { createAgent } = await import(pathToFileURL(process.argv[2]).href);
  let failures = 0;
  for (const surface of ['mcp', 'cli', 'legacy']) {
    for (const scenario of scenarios) {
      try {
        const trace = await evaluate(await createAgent(), surface, scenario);
        console.log(`PASS ${surface}/${scenario.name} ${JSON.stringify(trace)}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${surface}/${scenario.name} ${error.message} ${JSON.stringify(error.evaluationTrace ?? null)}`);
      }
    }
  }
  process.exitCode = failures ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
