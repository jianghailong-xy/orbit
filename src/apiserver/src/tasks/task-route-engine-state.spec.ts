/**
 * engineState reads an engine's quota where the runner reports it. Antigravity's buckets travel with its
 * engine health (RunnerEngineHealth.planUsage), not in the heartbeat's planUsage, so it is folded in
 * (withEnginePlanUsage) as every other quota reader does: without that, the SubAgent router took a
 * reporting Antigravity for "quota unknown" and ranked it after every engine whose quota it could read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineState, type RouteAgent, type RouteRunner } from './task-route-decision';

const NOW = new Date('2026-11-20T08:00:00Z');

const agent = {
  runnerId: 'r', effort: null, modelRouting: null, modelRoutingProviders: null, env: null,
  codexAccount: null, claudeAccount: null, kimiAccount: null, antigravityAccount: null, cursorAccount: null,
} as unknown as RouteAgent;

function runner(buckets: Array<{ id: string; window: string; remainingFraction: number; resetTime?: string }>): RouteRunner {
  return {
    modelCatalog: null, runtimeDefaultModels: null, planUsage: null,
    name: 'hpc', displayName: null, status: 'ONLINE', lastHeartbeatAt: NOW, presence: { lastBeatAt: NOW },
    engines: [{
      // As HPC's runner reports it: the reading is kept only for a Google sign-in (sanitizeGooglePlanUsage).
      engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google',
      accounts: [{ id: 'default', auth: 'yes', home: '/root/.orbit/antigravity/google' }],
      planUsage: { provider: 'antigravity', fetchedAt: NOW.toISOString(), buckets },
    }],
    accountNames: null, accountPauses: null, defaultRemoved: null, capabilities: null, region: null,
  } as unknown as RouteRunner;
}

const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

test("Antigravity's buckets on its engine health are read: its shared groups cap it, a model's own does not", () => {
  const state = engineState('antigravity', agent, runner([
    { id: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: later(160) },
    { id: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: later(5) },
    { id: '3p-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: later(150) },
    { id: '3p-5h', window: '5h', remainingFraction: 1, resetTime: later(5) },
    // Argon's own weekly bucket, spent: it rules out Argon only, not the engine.
    { id: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0, resetTime: later(160) },
  ]), NOW);
  assert.equal(state.quotaUnread, undefined, 'a reported reading is not "unread"');
  assert.deepEqual(state.quota, { utilization: 25, window: 'weekly' });
  assert.equal(state.signedOut, false);
});

test('an Antigravity that reports no buckets stays unread', () => {
  const state = engineState('antigravity', agent, runner([]), NOW);
  assert.equal(state.quotaUnread, true);
  assert.equal(state.quota, null);
});
