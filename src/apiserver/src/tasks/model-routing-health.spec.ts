/**
 * The router reading account health (docs/routing-account-health-design.md §7.1, §7.2, §7.4, §7.5): a blocked account
 * is removed with the provider's words, keys included; a model entry removes only that model's rows; a suspect account
 * ranks after every healthy one; a refused run is not counted for escalation; and a task nothing can run is held until
 * the first trial is due. Pure: value snapshots in, decisions out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  healthLine,
  routeSubagent,
  routeTaskRun,
  type ModelRoutingInput,
  type RoutingHealthEntry,
  type SubagentProvider,
  type SubagentRoutingInput,
} from './model-routing';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 22, 18, 0);
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const SOL = 'gpt-6.2-sol';
const PAYMENT = 'Add a payment method to continue';

const CATALOG: RunnerModelCatalog = {
  claude: [
    { value: OPUS, label: 'Opus 5.5', priority: 0 },
    { value: SONNET, label: 'Sonnet 5.5', priority: 2 },
  ],
  codex: [{ value: SOL, label: 'GPT-6.2 Sol' }],
};

/** One live health entry; the whole account unless `model` is named. */
const entry = (over: Partial<RoutingHealthEntry>): RoutingHealthEntry => ({
  state: 'blocked', model: null, kind: 'ACCOUNT_ACTION_REQUIRED', since: NOW - HOUR, last: NOW - HOUR, until: NOW + 3 * HOUR,
  trips: 1, subject: 'runner:r1:codex:default', ...over,
});

type Account = NonNullable<SubagentProvider['account']>;
const signIn = (engine: string, utilization: number, account: Partial<Account> = {}): SubagentProvider => ({
  slug: engine, billing: 'subscription', inScope: true, credential: { kind: 'login', engine }, engines: [{ engine }],
  account: { quota: { utilization, window: 'weekly' }, ...account },
});
const openaiKey = (account?: Account): SubagentProvider => ({
  slug: 'openai-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: 'openai' },
  engines: [{ engine: 'codex', prices: { [SOL]: 10 } }], ...(account ? { account } : {}),
});

function input(providers: SubagentProvider[], over: Partial<SubagentRoutingInput> = {}): SubagentRoutingInput {
  return {
    type: 'general', definitionName: 'general', caller: { size: 'L' }, definition: {}, optimizeFor: 'cost',
    parent: { engine: 'claude', provider: 'claude', model: OPUS, effort: 'high' },
    providers, blockedProviders: [],
    engines: { claude: { installed: true }, codex: { installed: true } },
    modelCatalog: CATALOG, runtimeDefaultModels: { codex: SOL }, now: NOW,
    ...over,
  };
}

const removedReason = (d: ReturnType<typeof routeSubagent>, provider: string, model: string | null = null) =>
  d.candidates.find((c) => c.provider === provider && c.model === model)?.reason;

test('engineVerdict: a blocked account is removed with a Why line for each kind', () => {
  const cases: Array<[Partial<RoutingHealthEntry>, string]> = [
    [{ kind: 'ACCOUNT_ACTION_REQUIRED', said: PAYMENT },
      `The account needs your action: Codex said "${PAYMENT}" (since 2026-11-22T17:00Z; tried again at 2026-11-22T21:00Z)`],
    [{ kind: 'CREDENTIAL_REFUSED' },
      "The provider refused the account's credential (since 2026-11-22T17:00Z; tried again at 2026-11-22T21:00Z)"],
    [{ kind: 'ACCESS_DENIED', said: 'Your organisation does not allow this' },
      'The provider does not allow this account to run: "Your organisation does not allow this" (since 2026-11-22T17:00Z; tried again at 2026-11-22T21:00Z)'],
    [{ state: 'cooldown', kind: 'USAGE_LIMIT', until: NOW + 5 * MINUTE },
      'The account hit its usage limit; used again from 2026-11-22T18:05Z'],
    [{ kind: 'UNCLASSIFIED_ADMISSION', until: NOW + 30 * MINUTE },
      'The account failed to start 2 runs in a row at no cost; tried again at 2026-11-22T18:30Z'],
    [{ state: 'trial-running' }, 'The account is being tried now by another run'],
  ];
  for (const [over, line] of cases) {
    const d = routeSubagent(input([signIn('codex', 10, { health: [entry(over)] }), signIn('claude', 60)]));
    assert.equal(removedReason(d, 'codex'), line, JSON.stringify(over));
    assert.equal(d.candidates.find((c) => c.provider === 'codex')?.health?.kind, over.kind ?? 'ACCOUNT_ACTION_REQUIRED');
    assert.equal(d.provider, 'claude', 'the run goes to the account that can run');
  }
});

test('engineVerdict: suspect and trial-due accounts stay in the pool', () => {
  for (const state of ['suspect', 'trial-due'] as const) {
    const d = routeSubagent(input([signIn('codex', 10, { health: [entry({ state })] })]));
    assert.equal(d.provider, 'codex', state);
    assert.equal(removedReason(d, 'codex'), undefined, state);
  }
});

test('engineVerdict: a metered key the provider refused is removed too (G8)', () => {
  const d = routeSubagent(input([openaiKey({ health: [entry({ kind: 'CREDENTIAL_REFUSED', subject: 'provider:k1' })] }), signIn('claude', 50)]));
  assert.equal(removedReason(d, 'openai-key'), "The provider refused the account's credential (since 2026-11-22T17:00Z; tried again at 2026-11-22T21:00Z)");
  assert.ok(!d.fallbacks.some((f) => f.provider === 'openai-key'));
});

test('a model entry removes only that model\'s rows; the rest of the account stays', () => {
  const capacity = entry({ state: 'cooldown', kind: 'CAPACITY', model: OPUS, last: NOW - MINUTE, until: NOW + 4 * MINUTE, subject: 'runner:r1:claude:default' });
  const d = routeSubagent(input([signIn('claude', 10, { health: [capacity] })], { caller: { size: 'L' } }));
  assert.equal(removedReason(d, 'claude', OPUS),
    `${OPUS} was at capacity on this account at 2026-11-22T17:59Z; used again from 2026-11-22T18:04Z`);
  const models = [d.model, ...d.fallbacks.map((f) => f.model)];
  assert.ok(!models.includes(OPUS), JSON.stringify(models));
  assert.ok(models.includes(SONNET), 'Sonnet on the same account is still a candidate');
  // On Codex, whose tiers are one model at several efforts, the model entry takes every tier of that account.
  const codex = routeSubagent(input([signIn('codex', 10, { health: [{ ...capacity, model: SOL }] }), signIn('claude', 50)]));
  assert.ok(![codex.provider, ...codex.fallbacks.map((f) => f.provider)].includes('codex'));
});

test('a pool member health removes is out with the refused ones, named as needing action', () => {
  const pool: SubagentProvider = {
    slug: 'claude-pool', billing: 'subscription', inScope: true, credential: { kind: 'pool', engine: 'claude' }, engines: [{ engine: 'claude' }],
    pool: { members: [
      { label: 'a@x', quota: { utilization: 5, window: 'weekly' }, health: [entry({ said: PAYMENT })] },
      { label: 'b@x', quota: { utilization: 70, window: 'weekly' } },
    ] },
  };
  const d = routeSubagent(input([pool]));
  assert.equal(d.note, 'subscription pool, b@x with 30% quota left');
  const allOut = routeSubagent(input([{ ...pool, pool: { members: [pool.pool!.members[0]] } }]));
  assert.equal(removedReason(allOut, 'claude-pool'), 'No account in the pool can run: a@x needs action');
  assert.equal(allOut.candidates[0].health?.kind, 'ACCOUNT_ACTION_REQUIRED');
});

test('compareAccounts: a suspect account ranks after every healthy one, whatever its headroom', () => {
  const suspect = signIn('codex', 1, { health: [entry({ state: 'suspect', kind: 'UNCLASSIFIED_ADMISSION' })] });
  const d = routeSubagent(input([suspect, signIn('claude', 80)]));
  assert.equal(d.provider, 'claude', 'the healthy account with 20% left beats the suspect one with 99%');
  assert.ok(d.fallbacks.some((f) => f.provider === 'codex'), 'the suspect account is still a candidate');
  // Alone, it still runs.
  assert.equal(routeSubagent(input([suspect])).provider, 'codex');
  // Balance chooses the model first, then the account: the step that put the healthy account first says so.
  const twoAccounts = routeSubagent(input([
    { ...signIn('codex', 1, { health: [entry({ state: 'suspect' })] }), slug: 'codex' },
    { ...signIn('codex', 60), slug: 'codex-b' },
  ], { optimizeFor: 'balance' }));
  assert.equal(twoAccounts.provider, 'codex-b');
  assert.match(twoAccounts.reasons.find((r) => r.startsWith('Picked '))!, /account codex-b: codex failed to start its last run/);
});

test('a due trial ranks as healthy and the pick says it is the trial', () => {
  const due = entry({ state: 'trial-due', until: NOW - MINUTE, last: NOW - 2 * HOUR });
  const d = routeSubagent(input([signIn('codex', 5, { health: [due] }), signIn('claude', 50)]));
  assert.equal(d.provider, 'codex');
  assert.ok(d.reasons.includes('Trying codex again: it last refused a run at 2026-11-22T16:00Z'), JSON.stringify(d.reasons));
  assert.equal(d.trial?.subject, due.subject);
});

function taskInput(providers: SubagentProvider[], over: Partial<ModelRoutingInput> = {}): ModelRoutingInput {
  return {
    optimizeFor: 'cost',
    task: { modelHint: 'L' },
    baseline: { provider: 'codex', model: null, effort: null, engine: 'codex' },
    history: [],
    environment: { runtime: 'codex', modelCatalog: CATALOG },
    pool: { ...input(providers), type: 'task', caller: {} },
    ...over,
  };
}

test('routeTaskRun: a run its account refused is not counted, so the tier is not raised', () => {
  const providers = [signIn('codex', 5, { health: [entry({ said: PAYMENT })] }), signIn('claude', 50)];
  const d = routeTaskRun(taskInput(providers, {
    history: [
      { ordinal: 2, status: 'FAILED', outcome: 'FAILED', notCounted: 'account', level: 'L' },
      { ordinal: 1, status: 'FAILED', outcome: 'FAILED', notCounted: 'account', level: 'L' },
    ],
  }));
  assert.equal(d.level, 'L', 'two refusals do not escalate L to XL');
  assert.ok(d.reasons.includes('Run 2 was refused by its account before it started — not counted'), JSON.stringify(d.reasons));
  assert.ok(!d.reasons.some((r) => r.startsWith('[escalate]')));
  assert.equal(d.provider, 'claude', 'and it routes off the refused account');
  // The other values of §7.4 skip with their own words; an ordinary failure still escalates.
  const lines = routeTaskRun(taskInput(providers, {
    history: [
      { ordinal: 4, status: 'FAILED', outcome: 'FAILED', notCounted: 'transport', level: 'L' },
      { ordinal: 3, status: 'FAILED', outcome: 'FAILED', notCounted: 'admission', level: 'L' },
      { ordinal: 2, status: 'FAILED', outcome: 'FAILED', notCounted: 'account', trialOf: 'codex', level: 'L' },
      { ordinal: 1, status: 'FAILED', outcome: 'FAILED', level: 'L' },
    ],
  }));
  assert.ok(lines.reasons.includes('Run 4 lost its connection — not counted'));
  assert.ok(lines.reasons.includes('Run 3 failed to start at no cost — not counted'));
  assert.ok(lines.reasons.includes('Run 2 was a trial of codex, which refused it — not counted'));
  assert.equal(lines.level, 'XL', 'run 1 failed on its own and is counted');
});

test('routeTaskRun: when nothing can run, the task is held until the first trial is due', () => {
  const blocked = entry({ said: PAYMENT, until: NOW + 3 * HOUR });
  const only = routeTaskRun(taskInput([signIn('codex', 5, { health: [blocked] })]));
  assert.equal(only.hold?.kind, 'ACCOUNT_NEEDS_ACTION');
  assert.equal(only.hold?.until, new Date(NOW + 3 * HOUR).toISOString());
  assert.equal(only.hold?.reason,
    `Waiting for an account: ${healthLine(blocked, 'codex')}. Next try at 2026-11-22T21:00Z.`);
  assert.deepEqual(only.hold?.accounts.map((a) => a.provider), ['codex']);
  // Pinned to the blocked provider: the pin is named.
  const pinned = routeTaskRun(taskInput([signIn('codex', 5, { health: [blocked] }), signIn('claude', 10)], {
    task: { modelHint: 'L', provider: 'codex' },
  }));
  assert.match(pinned.hold?.reason ?? '', /^Pinned to codex, which can't run now \(The account needs your action/);
  // With no tier decided the run keeps the Agent's own model, which is held as well when its account cannot run.
  const untiered = routeTaskRun(taskInput([signIn('codex', 5, { health: [blocked] })], { task: {} }));
  assert.equal(untiered.level, null);
  assert.equal(untiered.hold?.kind, 'ACCOUNT_NEEDS_ACTION');
  // Another account can run it: no hold.
  assert.equal(routeTaskRun(taskInput([signIn('codex', 5, { health: [blocked] }), signIn('claude', 10)])).hold, undefined);
  // Once the block has run out the account is a trial due: it is picked, and the decision names the trial to claim.
  const due = routeTaskRun(taskInput([signIn('codex', 5, { health: [{ ...blocked, state: 'trial-due', until: NOW - MINUTE }] })]));
  assert.equal(due.hold, undefined);
  assert.equal(due.provider, 'codex');
  assert.deepEqual(due.trial, { subject: blocked.subject, scopeModel: '', provider: 'codex' });
});

test('routeTaskRun: the Agent\'s own engine is not kept when its account is suspect and another can run', () => {
  const suspect = entry({ state: 'suspect', kind: 'UNCLASSIFIED_ADMISSION' });
  const d = routeTaskRun(taskInput([signIn('codex', 5, { health: [suspect] }), signIn('claude', 50)]));
  assert.equal(d.provider, 'claude', 'one unclassified refusal demotes the own account, so run 2 goes elsewhere');
  assert.ok(!d.reasons.some((r) => r.startsWith('Engine codex: this agent\'s own engine')));
  // Alone, the suspect account still takes the run.
  assert.equal(routeTaskRun(taskInput([signIn('codex', 5, { health: [suspect] })])).provider, 'codex');
  // Healthy, the own engine keeps it, as before.
  assert.equal(routeTaskRun(taskInput([signIn('codex', 5), signIn('claude', 50)])).provider, 'codex');
});
