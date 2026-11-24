/**
 * A pin on an account health set aside (docs/routing-account-health-design.md §7.5, phase 2 of §10): with the owner's
 * relaxBlockedPins off the task holds with the pin named and the setting linked; with it on the pin is relaxed one step
 * at a time (provider, then engine), the tier is kept, a named model is never swapped, and the owner's blocked
 * providers are never reached. Relaxation is for health only. Pure: value snapshots in, decisions out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  baselineHealth,
  healthLine,
  routeTaskRun,
  type ModelRoutingInput,
  type RoutingHealthEntry,
  type SubagentProvider,
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

const blocked: RoutingHealthEntry = {
  state: 'blocked', model: null, kind: 'ACCOUNT_ACTION_REQUIRED', said: PAYMENT, since: NOW - HOUR, last: NOW - HOUR,
  until: NOW + 3 * HOUR, trips: 1, subject: 'runner:r1:codex:default',
};
const LINE = healthLine(blocked, 'codex');

type Account = NonNullable<SubagentProvider['account']>;
const signIn = (engine: string, utilization: number, account: Partial<Account> = {}): SubagentProvider => ({
  slug: engine, billing: 'subscription', inScope: true, credential: { kind: 'login', engine }, engines: [{ engine }],
  account: { quota: { utilization, window: 'weekly' }, ...account },
});
/** A second Codex credential: a key on the Codex engine. */
const codexKey: SubagentProvider = {
  slug: 'openai-key', billing: 'key', inScope: true, credential: { kind: 'key', presetSlug: 'openai' },
  engines: [{ engine: 'codex', prices: { [SOL]: 10 } }],
};

function taskInput(
  providers: SubagentProvider[],
  over: Partial<ModelRoutingInput> & { blockedProviders?: string[] } = {},
): ModelRoutingInput {
  const { blockedProviders = [], ...rest } = over;
  return {
    optimizeFor: 'cost',
    task: { modelHint: 'L', provider: 'codex' },
    baseline: { provider: 'codex', model: null, effort: null, engine: 'codex' },
    history: [],
    environment: { runtime: 'codex', modelCatalog: CATALOG },
    pool: {
      type: 'task', definitionName: 'the task', caller: {}, definition: {}, optimizeFor: 'cost',
      parent: { engine: 'codex', provider: 'codex', model: '', effort: null },
      providers, blockedProviders,
      engines: { claude: { installed: true }, codex: { installed: true } },
      modelCatalog: CATALOG, runtimeDefaultModels: { codex: SOL }, now: NOW,
    },
    ...rest,
  };
}

const codexBlocked = () => signIn('codex', 5, { health: [blocked] });

test('switch off: a pinned task holds with the pin named, and the hold links the setting', () => {
  const d = routeTaskRun(taskInput([codexBlocked(), codexKey, signIn('claude', 10)]));
  assert.equal(d.hold?.kind, 'ACCOUNT_NEEDS_ACTION');
  assert.equal(d.hold?.reason, `Pinned to codex, which can't run now (${LINE}). Next try at 2026-11-22T21:00Z.`);
  assert.equal(d.hold?.setting, 'orbit-settings:relaxBlockedPins');
  assert.equal(d.hold?.until, new Date(NOW + 3 * HOUR).toISOString());
});

test('switch on, step 1: the provider is dropped and the engine kept, at the same tier', () => {
  const d = routeTaskRun(taskInput([codexBlocked(), codexKey, signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(d.hold, undefined);
  assert.equal(d.relaxed, true);
  assert.equal(d.engine, 'codex');
  assert.equal(d.provider, 'openai-key');
  assert.equal(d.level, 'L', 'the tier is the task\'s size, not part of the pin');
  assert.ok(d.reasons.includes(
    `Pinned to codex, which can't run now (${LINE}); runs on openai-key instead, on the same engine, at tier L`,
  ), JSON.stringify(d.reasons));
});

test('switch on, step 2: with no other account on the engine, engine and provider are both dropped', () => {
  const d = routeTaskRun(taskInput([codexBlocked(), signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(d.hold, undefined);
  assert.equal(d.engine, 'claude');
  assert.equal(d.provider, 'claude');
  assert.equal(d.level, 'L');
  assert.equal(d.model, OPUS, 'the ordinary fit order inside the widened pool: tier L on Claude is Opus');
  assert.ok(d.reasons.includes(
    `Pinned to codex on codex, where no account can run now (${LINE}); runs on ${OPUS} on claude instead, at tier L`,
  ), JSON.stringify(d.reasons));
  // An engine pin alone goes straight to step 2.
  const engineOnly = routeTaskRun(taskInput([codexBlocked(), signIn('claude', 10)], {
    relaxBlockedPins: true, task: { modelHint: 'XL', engine: 'codex' },
  }));
  assert.equal(engineOnly.provider, 'claude');
  assert.equal(engineOnly.level, 'XL');
});

test('switch on: the tier is kept at every step, including the highest', () => {
  for (const modelHint of ['S', 'M', 'L', 'XL'] as const) {
    const d = routeTaskRun(taskInput([codexBlocked(), signIn('claude', 10)], {
      relaxBlockedPins: true, task: { modelHint, provider: 'codex' },
    }));
    assert.equal(d.level, modelHint, modelHint);
  }
});

test('the owner\'s blocked providers are never reached by a relaxed pin', () => {
  const d = routeTaskRun(taskInput([codexBlocked(), signIn('claude', 10)], {
    relaxBlockedPins: true, blockedProviders: ['claude'],
  }));
  assert.equal(d.hold?.kind, 'ACCOUNT_NEEDS_ACTION', 'the only other provider is blocked: the task holds');
  assert.notEqual(d.provider, 'claude');
  const shared = routeTaskRun(taskInput([codexBlocked(), { ...signIn('claude', 10), inScope: false }], { relaxBlockedPins: true }));
  assert.equal(shared.hold?.kind, 'ACCOUNT_NEEDS_ACTION', 'a shared provider out of scope stays out');
  // And with one allowed and one blocked, it goes to the allowed one only.
  const kept = routeTaskRun(taskInput([codexBlocked(), codexKey, signIn('claude', 10)], {
    relaxBlockedPins: true, blockedProviders: ['openai-key'],
  }));
  assert.equal(kept.provider, 'claude');
});

test('a model pin is kept exactly: on another provider that lists it, or held', () => {
  const pin = { model: SOL, provider: 'codex' };
  // Off: held, naming the model and the provider.
  const off = routeTaskRun(taskInput([codexBlocked(), codexKey], { task: pin }));
  assert.equal(off.hold?.reason, `Pinned to ${SOL} on codex, which can't run now (${LINE}). Next try at 2026-11-22T21:00Z.`);
  assert.equal(off.model, SOL);
  // On: the same model id on the other provider that lists it.
  const on = routeTaskRun(taskInput([codexBlocked(), codexKey, signIn('claude', 10)], { task: pin, relaxBlockedPins: true }));
  assert.equal(on.hold, undefined);
  assert.equal(on.model, SOL);
  assert.equal(on.provider, 'openai-key');
  assert.equal(on.relaxed, true);
  assert.ok(on.reasons.includes(`Pinned to ${SOL} on codex, which can't run now (${LINE}); runs the same model on openai-key`));
  // On, but nobody else lists it: held, never swapped for Claude's models.
  const held = routeTaskRun(taskInput([codexBlocked(), signIn('claude', 10)], { task: pin, relaxBlockedPins: true }));
  assert.equal(held.hold?.kind, 'ACCOUNT_NEEDS_ACTION');
  assert.equal(held.model, SOL);
  assert.equal(held.hold?.setting, undefined, 'the switch is already on: nothing to link');
  // A model pin whose account is healthy runs as pinned, as before.
  assert.equal(routeTaskRun(taskInput([signIn('codex', 5), codexKey], { task: pin, relaxBlockedPins: true })).provider, 'codex');
  // A model entry on that one model holds it too.
  const modelOut = { ...blocked, model: SOL, state: 'cooldown' as const, kind: 'CAPACITY', until: NOW + 5 * MINUTE };
  const capacity = routeTaskRun(taskInput([signIn('codex', 5, { health: [modelOut] })], { task: pin }));
  assert.equal(capacity.hold?.kind, 'ACCOUNT_NEEDS_ACTION');
});

test('relaxation is for health only: a pinned account paused or at its quota behaves as today', () => {
  const paused = routeTaskRun(taskInput([signIn('codex', 5, { paused: true }), signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(paused.hold, undefined);
  assert.equal(paused.relaxed, undefined);
  assert.equal(paused.provider, 'codex', 'keeps the agent\'s model, as it did before health');
  assert.ok(paused.reasons.includes("[not-routed] No provider can run it at this tier — keeps the agent's model"));
  const spent = routeTaskRun(taskInput([signIn('codex', 95), signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(spent.relaxed, undefined);
  assert.equal(spent.provider, 'codex');
});

test('a pinned task returns to its pin once its account is due its trial: it takes the trial', () => {
  const due = { ...blocked, state: 'trial-due' as const, until: NOW - MINUTE };
  const d = routeTaskRun(taskInput([signIn('codex', 5, { health: [due] }), codexKey, signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(d.provider, 'codex');
  assert.equal(d.relaxed, undefined);
  assert.deepEqual(d.trial, { subject: blocked.subject, scopeModel: '', provider: 'codex' });
  // And healthy again after the trial: the pin, with nothing relaxed.
  const healthy = routeTaskRun(taskInput([signIn('codex', 5), codexKey, signIn('claude', 10)], { relaxBlockedPins: true }));
  assert.equal(healthy.provider, 'codex');
  assert.equal(healthy.relaxed, undefined);
});

test('baselineHealth (routing off): the baseline account set aside holds; a due trial is claimed; nothing is relaxed', () => {
  const routingOff = { task: {}, relaxBlockedPins: true };
  const held = baselineHealth(taskInput([codexBlocked(), signIn('claude', 10)], routingOff));
  assert.equal(held.hold?.reason, `Waiting for an account: ${LINE}. Next try at 2026-11-22T21:00Z.`);
  const due = baselineHealth(taskInput([signIn('codex', 5, { health: [{ ...blocked, state: 'trial-due', until: NOW - MINUTE }] })], routingOff));
  assert.equal(due.hold, undefined);
  assert.deepEqual(due.trial, { subject: blocked.subject, scopeModel: '', provider: 'codex' });
  assert.deepEqual(baselineHealth(taskInput([signIn('codex', 5)], routingOff)), {});
  const pinned = baselineHealth(taskInput([codexBlocked()], { task: { provider: 'codex' } }));
  assert.match(pinned.hold?.reason ?? '', /^Pinned to codex, which can't run now/);
  assert.equal(pinned.hold?.setting, 'orbit-settings:relaxBlockedPins');
});
