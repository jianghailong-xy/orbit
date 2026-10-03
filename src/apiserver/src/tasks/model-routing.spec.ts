import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODEL_ROUTING_POLICY_VERSION,
  routeTaskRun,
  type ModelRoutingDecision,
  type ModelRoutingInput,
  type ModelRoutingLevel,
  type ModelRoutingRun,
  type ModelRoutingSelection,
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

function assertDecision(
  actual: ModelRoutingDecision,
  expected: ModelRoutingSelection & { level: ModelRoutingLevel | null },
): void {
  const { reasons, ...selection } = actual;
  assert.deepEqual(selection, { policyVersion: 1, ...expected });
  assert.ok(reasons.length > 0);
  assert.ok(reasons.every((reason) => typeof reason === 'string' && reason.length > 0));
}

const claudeTiers: Array<[ModelRoutingLevel, string, string]> = [
  ['S', SONNET, 'low'], ['M', SONNET, 'medium'], ['L', OPUS, 'high'], ['XL', OPUS, 'max'],
];
for (const [level, model, effort] of claudeTiers) {
  test(`Claude suggestion ${level} selects its model family and effort`, () => {
    const value = input();
    value.task = { modelHint: level, modelHintReason: 'one service plus its spec' };
    const result = routeTaskRun(value);
    assertDecision(result, { level, provider: 'claude', model, effort });
    assert.match(result.reasons[0], /suggested by the coordinator.*one service plus its spec/);
  });
}

test('policy version is one', () => {
  assert.equal(MODEL_ROUTING_POLICY_VERSION, 1);
});

test('no suggestion preserves the full baseline for new and nonfailed runs', () => {
  for (const status of [null, 'SUCCEEDED', 'RUNNING', 'CANCELLED']) {
    const value = input();
    value.baseline.model = OPUS;
    if (status) {
      value.history = [
        { ordinal: 2, status, quotaFailure: false, level: 'S' },
        { ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'L' },
      ];
    }
    const result = routeTaskRun(value);
    assertDecision(result, { ...value.baseline, level: null });
    assert.match(result.reasons[0], /No suggestion/);
  }
});

test('baseline audit fields stay outside the routing result contract', () => {
  const value = input();
  const auditedBaseline = { ...value.baseline, providerSource: 'agent-seed', runtimeDefaultModel: OPUS };
  value.baseline = auditedBaseline;
  assertDecision(routeTaskRun(value), { level: null, provider: 'claude', model: null, effort: 'max' });
});

test('task model pin overrides suggestions, failures, catalog, Auto and quota constraints', () => {
  const value = input();
  value.task = { provider: 'claude-pool', model: 'owner-model', modelHint: 'XL' };
  value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'M' }];
  value.environment.modelCatalog = null;
  value.environment.defaultPermissionMode = 'auto';
  value.environment.planUsage = { claude: { sevenDayOpus: { utilization: 100 } } };
  const result = routeTaskRun(value);
  assertDecision(result, { level: null, provider: 'claude-pool', model: 'owner-model', effort: 'max' });
  assert.deepEqual(result.reasons, ['Task pin: owner-model']);
});

test('a provider pin fixes the engine and still routes model and effort', () => {
  const value = input();
  value.task = { provider: 'claude-pool', modelHint: 'S' };
  const result = routeTaskRun(value);
  assertDecision(result, { level: 'S', provider: 'claude-pool', model: SONNET, effort: 'low' });
  assert.ok(result.reasons.some((reason) => /Engine claude-pool: pinned on the task/.test(reason)));
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
  assert.equal(routeTaskRun(value).model, 'claude-sonnet-6');
  value.task.modelHint = 'XL';
  assert.equal(routeTaskRun(value).model, 'claude-opus-6');
});

test('Auto excludes an authoritative non-Auto row, then selects the eligible family priority', () => {
  const value = input();
  value.task.modelHint = 'M';
  value.environment.defaultPermissionMode = 'auto';
  value.environment.modelCatalog!.claude!.push(
    { value: 'claude-sonnet-6', label: 'Sonnet 6', priority: 0, permissionModes: ['default'] },
  );
  const result = routeTaskRun(value);
  assert.equal(result.model, SONNET);
  assert.ok(result.reasons.some((reason) => /Auto permission support/.test(reason)));
  value.environment.defaultPermissionMode = 'default';
  assert.equal(routeTaskRun(value).model, 'claude-sonnet-6');
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
  assert.equal(routeTaskRun(value).model, 'claude-sonnet-5');
});

for (const [level, , effort] of claudeTiers) {
  test(`${level} keeps its tier when the desired family is missing or cannot use Auto`, () => {
    for (const unavailable of ['missing', 'auto']) {
      const value = input();
      value.task.modelHint = level;
      const wantsOpus = level === 'L' || level === 'XL';
      const wantedModel = wantsOpus ? OPUS : SONNET;
      if (unavailable === 'missing') {
        value.environment.modelCatalog!.claude = value.environment.modelCatalog!.claude!
          .filter((row) => row.value !== wantedModel);
      } else {
        value.environment.defaultPermissionMode = 'auto';
        value.environment.modelCatalog!.claude!.find((row) => row.value === wantedModel)!.permissionModes = [];
      }
      const result = routeTaskRun(value);
      assertDecision(result, {
        level, provider: 'claude', model: wantsOpus ? SONNET : OPUS, effort: wantsOpus ? 'xhigh' : effort,
      });
      assert.ok(result.reasons.some((reason) => /is unavailable — using/.test(reason)));
    }
  });
}

for (const level of ['L', 'XL'] as const) {
  for (const utilization of [89.9, 90, 100]) {
    test(`${level} with Opus weekly utilization ${utilization}% obeys the inclusive threshold`, () => {
      const value = input();
      value.task.modelHint = level;
      value.environment.planUsage = { claude: { sevenDayOpus: { utilization } } };
      const result = routeTaskRun(value);
      assertDecision(result, {
        level, provider: 'claude', model: utilization >= 90 ? SONNET : OPUS,
        effort: utilization >= 90 ? 'xhigh' : level === 'L' ? 'high' : 'max',
      });
      assert.ok(result.reasons.some((reason) => reason.includes(`Opus weekly quota at ${utilization}%`)));
    });
  }
}

test('a missing Opus window does not trigger step-down', () => {
  const value = input();
  value.task.modelHint = 'L';
  value.environment.planUsage = { claude: { sevenDay: { utilization: 100 }, fiveHour: { utilization: 100 } } };
  assert.equal(routeTaskRun(value).model, OPUS);
});

test('unavailable catalogs or both unavailable families keep the baseline with a null tier', () => {
  for (const scenario of ['absent', 'empty', 'other-family', 'auto', 'quota']) {
    const value = input();
    value.task.modelHint = 'L';
    if (scenario === 'absent') value.environment.modelCatalog = undefined;
    if (scenario === 'empty') value.environment.modelCatalog = { claude: [] };
    if (scenario === 'other-family') {
      value.environment.modelCatalog = { claude: [{ value: 'claude-haiku-5', label: 'Haiku 5' }] };
    }
    if (scenario === 'auto') {
      value.environment.defaultPermissionMode = 'auto';
      value.environment.modelCatalog!.claude!.forEach((row) => { row.permissionModes = []; });
    }
    if (scenario === 'quota') {
      value.environment.modelCatalog!.claude = value.environment.modelCatalog!.claude!.filter((row) => row.value === OPUS);
      value.environment.planUsage = { claude: { sevenDayOpus: { utilization: 90 } } };
      // Quota also prevents an S/M fallback from selecting Opus.
      value.task.modelHint = 'S';
    }
    const result = routeTaskRun(value);
    assertDecision(result, { ...value.baseline, level: null });
    assert.match(result.reasons[0], /Tier [LS]/);
    assert.ok(result.reasons.some((reason) => /has not reported|Neither Sonnet nor Opus/.test(reason)));
  }
});

test('other runtimes and configured model spaces have no tier table', () => {
  for (const runtime of ['kimi', 'opencode', 'antigravity', 'vendor-runtime', 'claude', 'codex']) {
    const value = input();
    value.baseline = { provider: 'vendor', model: 'vendor-model', effort: 'vendor-effort' };
    value.task.modelHint = 'XL';
    value.environment.runtime = runtime;
    value.environment.hasOwnModelSpace = runtime === 'claude' || runtime === 'codex';
    value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'M' }];
    const result = routeTaskRun(value);
    assertDecision(result, { ...value.baseline, level: null });
    assert.match(result.reasons[0], /No tier table/);
  }
});

for (const provider of ['codex', 'codex-pool']) {
  for (const [level, effort] of [['S', 'low'], ['M', 'medium'], ['L', 'high'], ['XL', 'xhigh']] as const) {
    test(`${provider} uses runtime codex at ${level} with the reported default`, () => {
      const value = codexInput(provider);
      value.task = { provider, modelHint: level };
      value.environment.defaultPermissionMode = 'auto';
      const result = routeTaskRun(value);
      assertDecision(result, { level, provider, model: 'gpt-default', effort });
    });
  }
}

test('Codex falls back to the catalog first row, including when the default is absent from it', () => {
  for (const defaultModel of [undefined, 'not-in-catalog']) {
    const value = codexInput();
    value.task.modelHint = 'M';
    value.environment.runtimeDefaultModels = { codex: defaultModel };
    const result = routeTaskRun(value);
    assertDecision(result, { level: 'M', provider: 'codex', model: 'gpt-first', effort: 'medium' });
    if (defaultModel) assert.ok(result.reasons.some((reason) => /not in its model catalog/.test(reason)));
  }
  const value = codexInput();
  value.task.modelHint = 'M';
  value.environment.modelCatalog = {};
  assertDecision(routeTaskRun(value), { ...value.baseline, level: null });
});

const efforts: Array<[ModelRoutingLevel, string[], string | null]> = [
  ['S', ['medium', 'high'], 'medium'],
  ['M', ['high', 'low'], 'high'],
  ['L', ['low', 'medium'], 'medium'],
  ['XL', ['low', 'high'], 'high'],
  ['L', ['low', 'xhigh'], 'xhigh'],
  ['S', ['none', 'minimal'], 'minimal'],
  ['M', [], null],
];
for (const [level, reasoningLevels, expected] of efforts) {
  test(`Codex ${level} effort respects ${JSON.stringify(reasoningLevels)} with nearest/higher tie-breaking`, () => {
    const value = codexInput();
    value.task.modelHint = level;
    value.environment.modelCatalog!.codex![1].reasoningLevels = reasoningLevels;
    const result = routeTaskRun(value);
    assertDecision(result, { level, provider: 'codex', model: 'gpt-default', effort: expected });
    assert.ok(result.reasons.some((reason) => /does not support .* effort/.test(reason)));
  });
}

test('reasoningLevels absent leaves the tier effort, and Claude declarations also constrain effort', () => {
  const value = codexInput();
  value.task.modelHint = 'XL';
  delete value.environment.modelCatalog!.codex![1].reasoningLevels;
  assert.equal(routeTaskRun(value).effort, 'xhigh');
  const claude = input();
  claude.task.modelHint = 'XL';
  claude.environment.modelCatalog!.claude![0].reasoningLevels = ['low', 'high'];
  assert.equal(routeTaskRun(claude).effort, 'high');
});

for (const [previous, expected] of [['S', 'M'], ['M', 'L'], ['L', 'XL'], ['XL', 'XL']] as const) {
  test(`nonquota failure escalates ${previous} to ${expected} without needing a suggestion`, () => {
    const value = input();
    value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: previous }];
    const result = routeTaskRun(value);
    assert.equal(result.level, expected);
    assert.match(result.reasons[0], /run 1 .* failed/);
    if (previous === 'XL') assert.match(result.reasons[0], /already the highest tier/);
  });
}

test('escalation takes the higher of previous tier plus one and the current suggestion', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'M' }];
  value.task.modelHint = 'S';
  assert.equal(routeTaskRun(value).level, 'L');
  value.task = { modelHint: 'XL', modelHintReason: 'high cost of a wrong result' };
  const result = routeTaskRun(value);
  assert.equal(result.level, 'XL');
  assert.ok(result.reasons.some((reason) => /Coordinator suggested tier XL: high cost/.test(reason)));
});

test('acceptance failure, verifier FAIL and owner SEND_BACK all escalate', () => {
  for (const outcome of ['ACCEPTANCE_FAILED', 'VERIFICATION_FAILED', 'SENT_BACK'] as const) {
    const value = input();
    value.history = [{ ordinal: 1, status: outcome === 'ACCEPTANCE_FAILED' ? 'FAILED' : 'SUCCEEDED', quotaFailure: false, level: 'M', outcome }];
    const result = routeTaskRun(value);
    assert.equal(result.level, 'L');
    assert.match(result.reasons[0], /acceptance command|verifier|owner/);
  }
});

test('prior decision tier takes precedence over the actual model, including shadow tiers', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'S', model: OPUS }];
  assert.equal(routeTaskRun(value).level, 'M');
});

for (const [model, expected] of [[SONNET, 'L'], [OPUS, 'XL'], ['sonnet', 'L'], ['opus', 'XL']] as const) {
  test(`without a decision tier the actual ${model} family determines escalation`, () => {
    const value = input();
    value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, level: null, model }];
    const result = routeTaskRun(value);
    assert.equal(result.level, expected);
    const label = model === SONNET ? 'Sonnet 5.5' : model === OPUS ? 'Opus 5.5' : model;
    assert.ok(result.reasons.some((reason) => reason.startsWith(`Run 1 used ${label}, which counts as tier`)));
  });
}

for (const [effort, expected] of [['low', 'M'], ['medium', 'L'], ['high', 'XL'], ['xhigh', 'XL']] as const) {
  test(`Codex actual effort ${effort} determines its prior tier`, () => {
    const value = codexInput();
    value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, model: 'gpt-default', effort, runtime: 'codex' }];
    assert.equal(routeTaskRun(value).level, expected);
  });
}

test('an unknown prior tier falls back to the suggestion or preserves baseline', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: false, model: 'unknown' }];
  assertDecision(routeTaskRun(value), { ...value.baseline, level: null });
  value.task.modelHint = 'S';
  assert.equal(routeTaskRun(value).level, 'S');
});

test('quota-only failures do not escalate with or without a suggestion', () => {
  const value = input();
  value.history = [{ ordinal: 1, status: 'FAILED', quotaFailure: true, level: 'XL' }];
  assertDecision(routeTaskRun(value), { ...value.baseline, level: null });
  value.task.modelHint = 'M';
  const result = routeTaskRun(value);
  assert.equal(result.level, 'M');
  assert.ok(result.reasons.some((reason) => /usage limit — not counted/.test(reason)));
});

test('quota failures neither add escalation nor interrupt the preceding failure chain', () => {
  const value = input();
  const prior: ModelRoutingRun = { ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'M' };
  value.history = [
    { ordinal: 3, status: 'FAILED', quotaFailure: true, level: 'XL' },
    { ordinal: 2, status: 'FAILED', quotaFailure: true, level: 'L' },
    prior,
  ];
  const result = routeTaskRun(value);
  assert.equal(result.level, 'L');
  assert.match(result.reasons[0], /run 1 \(M\)/);
  assert.equal(result.reasons.filter((reason) => /not counted/.test(reason)).length, 2);
  value.history = [{ ordinal: 2, status: 'SUCCEEDED', quotaFailure: false, level: 'S' }, prior];
  assertDecision(routeTaskRun(value), { ...value.baseline, level: null });
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
    { ordinal: 2, status: 'FAILED', quotaFailure: true, level: 'L' },
    { ordinal: 1, status: 'FAILED', quotaFailure: false, level: 'M' },
  ];
  const before = structuredClone(value);
  freeze(value);
  const first = routeTaskRun(value);
  assertDecision(first, { level: 'L', provider: 'claude-pool', model: SONNET, effort: 'xhigh' });
  assert.deepEqual(routeTaskRun(value), first);
  first.reasons.push('caller changed its copy');
  assert.ok(!routeTaskRun(value).reasons.includes('caller changed its copy'));
  assert.deepEqual(value, before);
});
