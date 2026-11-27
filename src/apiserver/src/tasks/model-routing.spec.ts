import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENGINE_QUOTA_LIMIT,
  MODEL_ROUTING_POLICY_VERSION,
  routeTaskRun,
  type ModelRoutingDecision,
  type ModelRoutingEngineState,
  type ModelRoutingInput,
  type ModelRoutingLevel,
  type ModelRoutingRun,
  type ModelRoutingSelection,
  type SubagentProvider,
  type SubagentRoutingInput,
} from './model-routing';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

function input(): ModelRoutingInput {
  return {
    task: {},
    baseline: { provider: 'claude', model: null, effort: 'max' },
    history: [],
    environment: {
      runtime: 'claude',
      modelCatalog: {
        claude: [
          { value: OPUS, label: 'Opus 5.5', priority: 0, permissionModes: ['default', 'auto'] },
          { value: SONNET, label: 'Sonnet 5.5', priority: 2, permissionModes: ['default', 'auto'] },
        ],
      },
    },
  };
}

function codexInput(provider = 'codex'): ModelRoutingInput {
  const value = input();
  value.baseline.provider = provider;
  value.environment = {
    runtime: 'codex',
    modelCatalog: {
      codex: [
        { value: 'gpt-first', label: 'First model', priority: 5, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
        { value: 'gpt-default', label: 'Default model', priority: 0, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      ],
    },
    runtimeDefaultModels: { codex: 'gpt-default' },
  };
  return value;
}

/** A sign-in provider named `slug` on `engine`. */
function builtin(slug: string, engine: string, extra: Partial<SubagentProvider> = {}): SubagentProvider {
  return { slug, billing: 'subscription', inScope: true, credential: { kind: 'login', engine }, engines: [{ engine }], ...extra };
}

/** The pool the SubAgent router reads for this input's runner: the baseline's provider on its own engine first,
 *  then a sign-in for every other engine the runner's catalogue lists, and a provider the task pins. */
function poolOf(value: ModelRoutingInput): SubagentRoutingInput {
  const catalog = value.environment.modelCatalog ?? null;
  const own = value.baseline.engine ?? value.environment.runtime;
  const providers = [builtin(value.baseline.provider, own)];
  for (const engine of Object.keys(catalog ?? {})) if (engine !== own) providers.push(builtin(engine, engine));
  const pinned = value.task.provider;
  if (pinned && !providers.some((p) => p.slug === pinned)) providers.push(builtin(pinned, value.task.engine ?? own));
  return {
    type: 'task', definitionName: 'the task', caller: {}, definition: {}, optimizeFor: 'cost',
    parent: { engine: own, provider: value.baseline.provider, model: '', effort: null },
    providers, blockedProviders: [], engines: null,
    modelCatalog: catalog, runtimeDefaultModels: value.environment.runtimeDefaultModels ?? null,
  };
}

/** routeTaskRun with the pool the input's runner would give it, unless the case sets its own. */
function route(value: ModelRoutingInput): ModelRoutingDecision {
  return routeTaskRun(value.pool === undefined ? { ...value, pool: poolOf(value) } : value);
}

/** The decision as `expected` states it. Its engine is checked where the case names one: elsewhere it is the
 *  engine the credential runs on, which every case below that moves a run names. */
function assertDecision(
  actual: ModelRoutingDecision,
  expected: ModelRoutingSelection & { level: ModelRoutingLevel | null; engine?: string },
): void {
  const { reasons, engine, ...selection } = actual;
  const { engine: expectedEngine, ...rest } = expected;
  assert.deepEqual(selection, { policyVersion: 4, ...rest });
  if (expectedEngine !== undefined) assert.equal(engine, expectedEngine);
  assert.ok(reasons.some((reason) => /^\[(coordinator|rule|escalate|not-routed)\]/.test(reason)));
  assert.ok(reasons.every((reason) => typeof reason === 'string' && reason.length > 0));
}

const claudeTiers: Array<[ModelRoutingLevel, string, string]> = [
  ['S', SONNET, 'low'], ['M', SONNET, 'medium'], ['L', OPUS, 'high'], ['XL', OPUS, 'max'],
];
for (const [level, model, effort] of claudeTiers) {
  test(`Claude suggestion ${level} selects its model family and effort`, () => {
    const value = input();
    value.task = { modelHint: level, modelHintReason: 'one service plus its spec' };
    const result = route(value);
    assertDecision(result, { level, provider: 'claude', model, effort });
    assert.match(result.reasons[0], /suggested by the coordinator.*one service plus its spec/);
  });
}

test('policy version is three: account health removes, ranks and holds', () => {
  assert.equal(MODEL_ROUTING_POLICY_VERSION, 4);
});

test('no suggestion preserves the full baseline for new and nonfailed runs', () => {
  for (const status of [null, 'SUCCEEDED', 'RUNNING', 'CANCELLED']) {
    const value = input();
    value.baseline.model = OPUS;
    if (status) {
      value.history = [
        { ordinal: 2, status, level: 'S' },
        { ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'L' },
      ];
    }
    const result = route(value);
    assertDecision(result, { ...value.baseline, level: null });
    assert.match(result.reasons[0], /No suggestion/);
  }
});

test('baseline audit fields stay outside the routing result contract', () => {
  const value = input();
  const auditedBaseline = { ...value.baseline, providerSource: 'agent-seed', runtimeDefaultModel: OPUS };
  value.baseline = auditedBaseline;
  assertDecision(route(value), { level: null, provider: 'claude', model: null, effort: 'max' });
});

test('task model pin overrides suggestions, failures, catalog, Auto and quota constraints', () => {
  const value = input();
  value.task = { provider: 'claude-pool', model: 'owner-model', modelHint: 'XL' };
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'M' }];
  value.environment.modelCatalog = null;
  value.environment.defaultPermissionMode = 'auto';
  value.environment.planUsage = { claude: { sevenDayOpus: { utilization: 100 } } };
  const result = route(value);
  assertDecision(result, { level: null, provider: 'claude-pool', model: 'owner-model', effort: 'max' });
  assert.deepEqual(result.reasons, ['[not-routed] Task pin: owner-model']);
});

test('a provider pin fixes the engine and still routes model and effort', () => {
  const value = input();
  value.task = { provider: 'claude-pool', modelHint: 'S' };
  const result = route(value);
  assertDecision(result, { level: 'S', provider: 'claude-pool', model: SONNET, effort: 'low' });
  assert.equal(result.engine, 'claude');
});

test('family matching uses value prefixes and minimum priority, returning exact ids', () => {
  const value = input();
  value.environment.modelCatalog = { claude: [
    { value: 'claude-opus-5', label: 'Opus 5', priority: 8 },
    { value: 'sonnet', label: 'Sonnet alias', priority: -10 },
    { value: 'claude-sonnet-5', label: 'Sonnet 5', priority: 9 },
    { value: 'claude-sonnet-6', label: 'Sonnet 6', priority: 1 },
    { value: 'claude-opus-6', label: 'Opus 6', priority: 2 },
    { value: 'claude-sonnet-7', label: 'Sonnet 7' },
    { value: 'claude-fable-6', label: 'Opus label is not a model family', priority: -20 },
  ] };
  value.task.modelHint = 'M';
  assert.equal(route(value).model, 'claude-sonnet-6');
  value.task.modelHint = 'XL';
  assert.equal(route(value).model, 'claude-opus-6');
});

test('Auto excludes an authoritative non-Auto row, then selects the eligible family priority', () => {
  const value = input();
  value.task.modelHint = 'M';
  value.environment.defaultPermissionMode = 'auto';
  value.environment.modelCatalog!.claude!.push(
    { value: 'claude-sonnet-6', label: 'Sonnet 6', priority: 0, permissionModes: ['default'] },
  );
  const result = route(value);
  assert.equal(result.model, SONNET);
  assert.ok(result.reasons.some((reason) => /Auto permission support/.test(reason)));
  value.environment.defaultPermissionMode = 'default';
  assert.equal(route(value).model, 'claude-sonnet-6');
});

test('Auto follows autoAvailable static fallback only when permissionModes is absent', () => {
  const value = input();
  value.task.modelHint = 'M';
  value.environment.defaultPermissionMode = 'auto';
  value.environment.modelCatalog = { claude: [
    { value: 'claude-sonnet-6', label: 'Sonnet 6', priority: 0 },
    { value: 'claude-sonnet-5', label: 'Sonnet 5', priority: 1 },
    { value: OPUS, label: 'Opus 5.5', permissionModes: [] },
  ] };
  assert.equal(route(value).model, 'claude-sonnet-5');
});

for (const provider of ['codex', 'codex-pool']) {
  for (const [level, effort] of [['S', 'low'], ['M', 'medium'], ['L', 'high'], ['XL', 'xhigh']] as const) {
    test(`${provider} uses runtime codex at ${level} with the reported default`, () => {
      const value = codexInput(provider);
      value.task = { provider, modelHint: level };
      value.environment.defaultPermissionMode = 'auto';
      const result = route(value);
      assertDecision(result, { level, provider, model: 'gpt-default', effort });
    });
  }
}

test('Codex falls back to the catalog first row, including when the default is absent from it', () => {
  for (const defaultModel of [undefined, 'not-in-catalog']) {
    const value = codexInput();
    value.task.modelHint = 'M';
    value.environment.runtimeDefaultModels = { codex: defaultModel };
    const result = route(value);
    assertDecision(result, { level: 'M', provider: 'codex', model: 'gpt-first', effort: 'medium' });
  }
  const value = codexInput();
  value.task.modelHint = 'M';
  value.environment.modelCatalog = {};
  assertDecision(route(value), { ...value.baseline, level: null });
});

for (const [previous, expected] of [['S', 'M'], ['M', 'L'], ['L', 'XL'], ['XL', 'XL']] as const) {
  test(`nonquota failure escalates ${previous} to ${expected} without needing a suggestion`, () => {
    const value = input();
    value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: previous }];
    const result = route(value);
    assert.equal(result.level, expected);
    assert.match(result.reasons[0], /run 1 .* failed/);
    if (previous === 'XL') assert.match(result.reasons[0], /already the highest tier/);
  });
}

test('escalation takes the higher of previous tier plus one and the current suggestion', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'M' }];
  value.task.modelHint = 'S';
  assert.equal(route(value).level, 'L');
  value.task = { modelHint: 'XL', modelHintReason: 'high cost of a wrong result' };
  const result = route(value);
  assert.equal(result.level, 'XL');
  assert.ok(result.reasons.some((reason) => /Coordinator suggested tier XL: high cost/.test(reason)));
});

test('acceptance failure, verifier FAIL and owner SEND_BACK all escalate', () => {
  for (const outcome of ['ACCEPTANCE_FAILED', 'VERIFICATION_FAILED', 'SENT_BACK'] as const) {
    const value = input();
    value.history = [{ ordinal: 1, status: outcome === 'ACCEPTANCE_FAILED' ? 'FAILED' : 'SUCCEEDED', level: 'M', outcome }];
    const result = route(value);
    assert.equal(result.level, 'L');
    assert.match(result.reasons[0], /acceptance command|verifier|owner/);
  }
});

test('prior decision tier takes precedence over the actual model, including shadow tiers', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'S', model: OPUS }];
  assert.equal(route(value).level, 'M');
});

for (const [model, expected] of [[SONNET, 'L'], [OPUS, 'XL'], ['sonnet', 'L'], ['opus', 'XL']] as const) {
  test(`without a decision tier the actual ${model} family determines escalation`, () => {
    const value = input();
    value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: null, model }];
    const result = route(value);
    assert.equal(result.level, expected);
    const label = model === SONNET ? 'Sonnet 5.5' : model === OPUS ? 'Opus 5.5' : model;
    assert.ok(result.reasons.some((reason) => reason.startsWith(`[escalate] Run 1 used ${label}, which counts as tier`)));
  });
}

for (const [effort, expected] of [['low', 'M'], ['medium', 'L'], ['high', 'XL'], ['xhigh', 'XL']] as const) {
  test(`Codex actual effort ${effort} determines its prior tier`, () => {
    const value = codexInput();
    value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', model: 'gpt-default', effort, runtime: 'codex' }];
    assert.equal(route(value).level, expected);
  });
}

test('an unknown prior tier falls back to the suggestion or preserves baseline', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', model: 'unknown' }];
  assertDecision(route(value), { ...value.baseline, level: null });
  value.task.modelHint = 'S';
  assert.equal(route(value).level, 'S');
});

test('quota-only failures do not escalate with or without a suggestion', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', notCounted: 'usage-limit', level: 'XL' }];
  assertDecision(route(value), { ...value.baseline, level: null });
  value.task.modelHint = 'M';
  const result = route(value);
  assert.equal(result.level, 'M');
  assert.ok(result.reasons.some((reason) => /usage limit — not counted/.test(reason)));
});

test('quota failures neither add escalation nor interrupt the preceding failure chain', () => {
  const value = input();
  const prior: ModelRoutingRun = { ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'M' };
  value.history = [
    { ordinal: 3, status: 'FAILED', outcome: 'FAILED', notCounted: 'usage-limit', level: 'XL' },
    { ordinal: 2, status: 'FAILED', outcome: 'FAILED', notCounted: 'usage-limit', level: 'L' },
    prior,
  ];
  const result = route(value);
  assert.equal(result.level, 'L');
  assert.match(result.reasons[0], /run 1 \(M\)/);
  assert.equal(result.reasons.filter((reason) => /not counted/.test(reason)).length, 2);
  value.history = [{ ordinal: 2, status: 'SUCCEEDED', level: 'S' }, prior];
  assertDecision(route(value), { ...value.baseline, level: null });
});

test('a Codex run that found the model at capacity keeps the tier; a genuine failure still raises it', () => {
  const value = codexInput();
  const prior: ModelRoutingRun = {
    ordinal: 1, status: 'FAILED', outcome: 'FAILED', model: 'gpt-default', effort: 'low', runtime: 'codex',
  };
  value.history = [
    { ordinal: 2, status: 'FAILED', outcome: 'FAILED', notCounted: 'capacity', model: 'gpt-default', effort: 'medium', runtime: 'codex' },
  ];
  const kept = route(value);
  assert.equal(kept.level, null);
  assert.equal(kept.effort, value.baseline.effort);
  assert.ok(kept.reasons.some((reason) => /Run 2 found the model at capacity — not counted/.test(reason)));

  // Behind it, the run before still decides: one genuine failure at S (effort low) raises to M, once.
  value.history = [...value.history, prior];
  const raised = route(value);
  assert.equal(raised.level, 'M');
  assert.equal(raised.effort, 'medium');
  assert.match(raised.reasons[0], /run 1 \(S\)/);
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('routing is deterministic and does not mutate the task, history, catalogs or baseline', () => {
  const value = input();
  value.task = { provider: 'claude-pool', modelHint: 'M' };
  value.environment.defaultPermissionMode = 'auto';
  value.environment.planUsage = { claude: { sevenDayOpus: { utilization: 93 } } };
  value.history = [
    { ordinal: 2, status: 'FAILED', outcome: 'FAILED', notCounted: 'usage-limit', level: 'L' },
    { ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'M' },
  ];
  const before = structuredClone(value);
  freeze(value);
  const first = route(value);
  assertDecision(first, { level: 'L', provider: 'claude-pool', model: OPUS, effort: 'high' });
  assert.deepEqual(route(value), first);
  first.reasons.push('caller changed its copy');
  assert.ok(!route(value).reasons.includes('caller changed its copy'));
  assert.deepEqual(value, before);
});

test('rule inference follows structural thresholds and abstains on missing or invalid inputs', () => {
  const cases: Array<[ModelRoutingInput['features'], ModelRoutingLevel | null]> = [
    [{ isForeman: true }, 'L'], [{ verifiesTask: true }, 'L'],
    [{ completionCriterion: 'OWNER_CONFIRMED' }, 'L'], [{ completionCriterion: 'VERIFICATION' }, 'L'],
    [{ dependents: 3 }, 'L'], [{ promptChars: 8000 }, 'L'],
    [{ completionCriterion: 'EXECUTABLE', hasAcceptanceCommand: true, dependents: 0, promptChars: 2000 }, 'S'],
    [{ completionCriterion: 'EXECUTABLE', hasAcceptanceCommand: true, dependents: 0, promptChars: 2001 }, 'M'],
    [{ completionCriterion: 'EXECUTABLE', hasAcceptanceCommand: true }, 'M'],
    [{ dependents: -1, promptChars: NaN }, null], [{}, null],
  ];
  for (const [features, level] of cases) {
    const value = input();
    value.features = features;
    const before = structuredClone(value);
    const decision = route(value);
    assert.equal(decision.level, level, JSON.stringify(features));
    if (level) assert.match(decision.reasons[0], /\[rule\] Rule inference/);
    assert.deepEqual(value, before);
  }
});

test('rules preserve hint and pin precedence and cannot lower failure escalation', () => {
  const value = input();
  value.features = { isForeman: true };
  value.task.modelHint = 'S';
  assert.equal(route(value).level, 'S');
  value.task.model = 'pinned';
  assert.equal(route(value).model, 'pinned');
  assert.equal(route(value).level, null);
  value.task = {};
  value.features = { completionCriterion: 'EXECUTABLE', hasAcceptanceCommand: true, dependents: 0, promptChars: 100 };
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'L' }];
  assert.equal(route(value).level, 'XL');
  value.history[0].notCounted = 'capacity';
  assert.equal(route(value).level, 'S');
});


test('reason tags identify coordinator, rule, escalation and every not-routed exit', () => {
  const value = input();
  value.task.modelHint = 'XL';
  assert.match(route(value).reasons[0], /^\[coordinator\]/);
  value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'S' }];
  let reasons = route(value).reasons;
  assert.ok(reasons.some((reason) => /^\[escalate\]/.test(reason)));
  assert.ok(reasons.some((reason) => /^\[coordinator\]/.test(reason)));
  value.task = {};
  value.features = { isForeman: true };
  reasons = route(value).reasons;
  assert.ok(reasons.some((reason) => /^\[rule\]/.test(reason)));
  assert.ok(reasons.some((reason) => /^\[escalate\]/.test(reason)));

  const notRouted: ModelRoutingInput[] = [];
  notRouted.push(input());
  const pinned = input();
  pinned.task.model = 'pinned';
  notRouted.push(pinned);
  const missingCatalog = input();
  missingCatalog.task.modelHint = 'M';
  missingCatalog.environment.modelCatalog = {};
  notRouted.push(missingCatalog);
  const unread = input();
  unread.task.modelHint = 'L';
  unread.pool = null;
  notRouted.push(unread);
  for (const candidate of notRouted) {
    const decision = route(candidate);
    assert.equal(decision.level, null);
    assert.ok(decision.reasons.some((reason) => /^\[not-routed\]/.test(reason)), JSON.stringify(decision));
  }
});

test('Optimize For floors only missing hints, with the same escalation and pin precedence', () => {
  for (const [optimizeFor, bounded, abstained] of [
    ['cost', 'S', null], ['balance', 'M', 'M'], ['intelligence', 'L', 'L'],
  ] as const) {
    const value = input();
    value.optimizeFor = optimizeFor;
    value.task.modelHint = null;
    value.features = { completionCriterion: 'EXECUTABLE', hasAcceptanceCommand: true, dependents: 0, promptChars: 100 };
    const before = JSON.stringify(value);
    assert.equal(route(value).level, bounded);
    assert.equal(JSON.stringify(value), before, 'routing does not mutate its snapshot');
    value.features = { isForeman: true };
    assert.equal(route(value).level, 'L', 'mode floors never lower the rule tier');
    value.features = {};
    assert.equal(route(value).level, abstained);
    value.task.modelHint = 'S';
    assert.equal(route(value).level, 'S');
    value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'M' }];
    assert.equal(route(value).level, 'L');
    value.history = [{ ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'XL' }];
    assert.equal(route(value).level, 'XL');
    value.task.model = 'pinned';
    assert.equal(route(value).model, 'pinned');
    assert.equal(route(value).level, null);
  }
});

// ─── The pick: the SubAgent router's pool at the task's tier ───

/** An Agent on claude whose runner also reports Codex, both signed in. */
function crossInput(): ModelRoutingInput {
  const value = input();
  value.task = { modelHint: 'M' };
  value.environment.modelCatalog!.codex = codexInput().environment.modelCatalog!.codex;
  value.environment.runtimeDefaultModels = { codex: 'gpt-default' };
  return value;
}

/** crossInput's pool, with what the runner said of each engine and each sign-in's quota. */
function crossPool(
  value: ModelRoutingInput,
  engines: SubagentRoutingInput['engines'],
  quota: Record<string, number> = {},
): SubagentRoutingInput {
  const pool = poolOf(value);
  return {
    ...pool,
    engines,
    providers: pool.providers.map((p) => (quota[p.slug] === undefined ? p
      : { ...p, account: { quota: { utilization: quota[p.slug], window: 'weekly' } } })),
  };
}

test('without a pool read, a tiered run keeps the agent\'s model', () => {
  const value = input();
  value.task.modelHint = 'L';
  value.pool = null;
  const result = routeTaskRun(value);
  assertDecision(result, { ...value.baseline, level: null });
  assert.ok(result.reasons.includes("[not-routed] No providers were read — keeps the agent's model"));
});

test('the agent\'s own engine keeps the run while it can take it at the tier, whatever the router ranks first', () => {
  const value = crossInput();
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true } });
  assertDecision(route(value), { level: 'M', engine: 'claude', provider: 'claude', model: SONNET, effort: 'medium' });
  // Codex ranks first now, and the run still stays on claude, saying why.
  value.pool = { ...value.pool, providers: [...value.pool.providers].reverse() };
  const result = route(value);
  assertDecision(result, { level: 'M', engine: 'claude', provider: 'claude', model: SONNET, effort: 'medium' });
  assert.ok(result.reasons.includes("Engine claude: this agent's own engine, which can take the run at tier M"));
  // The router's "Picked …" named codex, which this run is not on: it is not among the reasons.
  assert.ok(!result.reasons.some((reason) => reason.startsWith('Picked ')), JSON.stringify(result.reasons));
  assert.ok(result.reasons.some((reason) => reason.startsWith(`Runs on ${SONNET} · medium on claude`)));
  // Only at the tier asked: an own engine with no model of that tier gives way to the router's pick.
  value.environment.modelCatalog!.claude = value.environment.modelCatalog!.claude!.filter((row) => row.value !== SONNET);
  value.pool = { ...crossPool(value, { claude: { installed: true }, codex: { installed: true } }) };
  assertDecision(route(value), { level: 'M', engine: 'codex', provider: 'codex', model: 'gpt-default', effort: 'medium' });
});

for (const [why, engines, quota] of [
  ['signed out', { claude: { installed: true, signedOut: true }, codex: { installed: true } }, {}],
  ['region blocked', { claude: { installed: true, regionBlocked: true }, codex: { installed: true } }, {}],
  ['not installed', { codex: { installed: true } }, {}],
  [`at ${ENGINE_QUOTA_LIMIT}% of its quota`, { claude: { installed: true }, codex: { installed: true } }, { claude: ENGINE_QUOTA_LIMIT }],
] as const) {
  test(`the agent's own engine ${why} on the runner moves the run to another provider at the same tier`, () => {
    const value = crossInput();
    value.task = { modelHint: 'XL' };
    value.pool = crossPool(value, engines, quota);
    const result = route(value);
    assertDecision(result, { level: 'XL', engine: 'codex', provider: 'codex', model: 'gpt-default', effort: 'xhigh' });
    assert.ok(result.reasons[0].startsWith('[coordinator] Tier XL'));
    assert.ok(!result.reasons.some((reason) => reason.includes('set by the caller')));
  });
}

test('no provider can take the run: it keeps the agent\'s model and says so', () => {
  const value = crossInput();
  value.pool = crossPool(value, { claude: { installed: true, signedOut: true }, codex: { installed: true, signedOut: true } });
  const result = route(value);
  assertDecision(result, { ...value.baseline, level: null });
  assert.ok(result.reasons.includes("[not-routed] No provider can run it at this tier — keeps the agent's model"));
  // Nothing only a SubAgent says: no caller set this tier, and nothing is refused.
  assert.ok(!result.reasons.some((reason) => /set by the caller|SubAgent/.test(reason)), JSON.stringify(result.reasons));
});

test('a provider pin or an engine pin keeps the pick on it, even when another provider ranks first', () => {
  const value = crossInput();
  value.task = { provider: 'codex', modelHint: 'M' };
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true } });
  assertDecision(route(value), { level: 'M', engine: 'codex', provider: 'codex', model: 'gpt-default', effort: 'medium' });
  value.task = { engine: 'codex', modelHint: 'M' };
  assertDecision(route(value), { level: 'M', engine: 'codex', provider: 'codex', model: 'gpt-default', effort: 'medium' });
  // A pinned engine nobody can run on keeps the agent's model.
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true, signedOut: true } });
  assert.equal(route(value).level, null);
});

test('a verification run prefers an engine the task it verifies did not last run on', () => {
  const value = crossInput();
  value.engines = { verifiedRunEngine: 'claude' };
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true } });
  let result = route(value);
  assertDecision(result, { level: 'M', engine: 'codex', provider: 'codex', model: 'gpt-default', effort: 'medium' });
  assert.ok(result.reasons.includes('Engine codex: the task it verifies last ran on claude'));

  // The other engine cannot take it: a preference, never a reason to pick one that cannot run.
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true, signedOut: true } });
  result = route(value);
  assertDecision(result, { level: 'M', engine: 'claude', provider: 'claude', model: SONNET, effort: 'medium' });
  assert.ok(result.reasons.includes('Engine claude: no other engine it may use is available; the task it verifies last ran on claude'));
});

test('an Agent on an engine without a tier table is routed onto the pool too', () => {
  const value = input();
  value.baseline = { provider: 'kimi', model: null, effort: null };
  value.environment.runtime = 'kimi';
  value.task.modelHint = 'L';
  value.pool = { ...poolOf(value), engines: { claude: { installed: true } } };
  assertDecision(route(value), { level: 'L', engine: 'claude', provider: 'claude', model: OPUS, effort: 'high' });
});

test('in Auto mode the pick skips a Claude model that cannot use Auto for the next candidate', () => {
  const value = crossInput();
  value.environment.defaultPermissionMode = 'auto';
  value.environment.modelCatalog!.claude!.find((row) => row.value === SONNET)!.permissionModes = ['default'];
  value.pool = crossPool(value, { claude: { installed: true }, codex: { installed: true } });
  const result = route(value);
  assert.notEqual(result.model, SONNET);
  assert.ok(result.reasons.includes('Models without Auto permission support were excluded'));
});
