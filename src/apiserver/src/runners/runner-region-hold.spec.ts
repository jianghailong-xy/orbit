/**
 * The server's holds and refusals for the Claude region check (docs/claude-region-check-contract.md §8–§12), as rules:
 * what the claim holds an Anthropic-bound Claude session with and when it lets go, the words of the create 409, the
 * sign-in refusal and the push, which check is the confirmed flip, the move a held session may make, and Claude's
 * sign-in door wired to them. The check route's push is runner-api/claude-region-push.spec.ts; the same rules on real
 * PostgreSQL, through the claim, finalize, turn-complete, create, move and sign-in, are queue/claude-region-hold.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunStatus } from '@prisma/client';
import {
  AgentProvider,
  CLAUDE_REGION_CARRY_OVER_MS,
  CLAUDE_REGION_UNSUPPORTED,
  CLAUDE_REGION_V1,
  claudeRegionRefusedError,
  claudeRegionStoppedError,
  type RunnerRegion,
} from '@orbit/shared';

import { MOVE_REFUSAL, sessionMoveVerdict, type SessionMoveFacts } from '../sessions/session-move';
import {
  blockedRunnerRegion,
  claudeRegionCreateRefusal,
  claudeRegionHold,
  claudeRegionPushBody,
  claudeRegionSignInRefusal,
  isClaudeRegionError,
  regionCredentialOf,
  regionFlipConfirmed,
} from './runner-region';
import { RunnersService } from './runners.service';

const NOW = new Date('2026-11-01T08:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function region(over: Partial<RunnerRegion> = {}): RunnerRegion {
  return {
    verdict: 'blocked',
    country: 'CN',
    regionCode: null,
    name: 'mainland China',
    viaProxy: false,
    decidedAt: ago(60_000),
    checkedAt: ago(60_000),
    blockedChecks: 2,
    ...over,
  };
}

const runner = (over: { region?: unknown; capabilities?: string[]; displayName?: string | null } = {}) => ({
  name: 'workstation-gpu',
  displayName: 'HPC',
  region: region(),
  capabilities: ['cursor-key-check/v1', CLAUDE_REGION_V1],
  ...over,
});

test('the claim holds an Anthropic-bound Claude session on a blocked runner with board 04’s refusal sentence', () => {
  assert.equal(
    claudeRegionHold(runner(), { error: null, runClaimedAt: null }, NOW),
    'CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.',
  );
  // The shared sentence, with the runner as Orbit names it: its display name, else what it registered as.
  assert.equal(
    claudeRegionHold(runner({ displayName: null }), { error: null, runClaimedAt: null }, NOW),
    claudeRegionRefusedError('workstation-gpu', 'mainland China'),
  );
  // Ukraine's excluded regions are blocked under their own name.
  assert.equal(
    claudeRegionHold(runner({ region: region({ country: 'UA', regionCode: 'UA-43', name: 'Crimea' }) }), { error: null, runClaimedAt: null }, NOW),
    claudeRegionRefusedError('HPC', 'Crimea'),
  );
});

test('the hold lets go on its own: an allowed check, a blocked verdict 24 hours old, a runner that does not check', () => {
  const fresh = { error: claudeRegionRefusedError('HPC', 'mainland China'), runClaimedAt: null };
  assert.equal(claudeRegionHold(runner({ region: region({ verdict: 'allowed', name: 'United States', country: 'US', blockedChecks: 0 }) }), fresh, NOW), null);
  assert.equal(claudeRegionHold(runner({ region: region({ decidedAt: ago(CLAUDE_REGION_CARRY_OVER_MS), checkedAt: ago(1000) }) }), fresh, NOW), null);
  assert.notEqual(claudeRegionHold(runner({ region: region({ decidedAt: ago(CLAUDE_REGION_CARRY_OVER_MS - 1000) }) }), fresh, NOW), null);
  // ⑤: no capability, no gate — whatever the row says.
  assert.equal(claudeRegionHold(runner({ capabilities: ['cursor-key-check/v1'] }), fresh, NOW), null);
  assert.equal(claudeRegionHold(runner({ capabilities: [] }), { error: null, runClaimedAt: null }, NOW), null);
  // No decided check, nothing to hold on.
  assert.equal(claudeRegionHold(runner({ region: null }), { error: null, runClaimedAt: null }, NOW), null);
  assert.equal(claudeRegionHold(runner({ region: { verdict: 'blocked' } }), { error: null, runClaimedAt: null }, NOW), null);
});

test('a refusal the runner reported while its row reads allowed waits for the next check, and never past the carry-over', () => {
  const allowed = region({ verdict: 'allowed', country: 'US', name: 'United States', blockedChecks: 0, decidedAt: ago(120_000), checkedAt: ago(120_000) });
  const refused = { error: claudeRegionRefusedError('workstation-gpu', 'mainland China'), runClaimedAt: new Date(NOW.getTime() - 60_000) };
  // The claim the runner refused came after the last check: held, with the runner's own words.
  assert.equal(claudeRegionHold(runner({ region: allowed }), refused, NOW), refused.error);
  // A check since then decides.
  assert.equal(claudeRegionHold(runner({ region: { ...allowed, checkedAt: ago(30_000) } }), refused, NOW), null);
  // The stopped sentence is a region sentence too.
  const stopped = { ...refused, error: claudeRegionStoppedError('HPC', 'mainland China') };
  assert.equal(claudeRegionHold(runner({ region: allowed }), stopped, NOW), stopped.error);
  // Not for ever: a refused claim older than the carry-over is tried again.
  const old = { ...refused, runClaimedAt: new Date(NOW.getTime() - CLAUDE_REGION_CARRY_OVER_MS) };
  assert.equal(claudeRegionHold(runner({ region: { ...allowed, checkedAt: ago(CLAUDE_REGION_CARRY_OVER_MS + 60_000) } }), old, NOW), null);
  // Any other error, or a session never claimed, is no refusal.
  assert.equal(claudeRegionHold(runner({ region: allowed }), { ...refused, error: 'Account paused until 2026-11-01T09:00:00.000Z' }, NOW), null);
  assert.equal(claudeRegionHold(runner({ region: allowed }), { ...refused, runClaimedAt: null }, NOW), null);
  // And still not on a runner that does not check.
  assert.equal(claudeRegionHold(runner({ region: allowed, capabilities: [] }), refused, NOW), null);
});

test('only the code-prefixed sentences are region errors', () => {
  assert.equal(isClaudeRegionError(claudeRegionRefusedError('HPC', 'Russia')), true);
  assert.equal(isClaudeRegionError(claudeRegionStoppedError('HPC', 'Russia')), true);
  assert.equal(isClaudeRegionError(CLAUDE_REGION_UNSUPPORTED), false);
  assert.equal(isClaudeRegionError('ENGINE_SIGNED_OUT: Claude Code is signed out'), false);
  assert.equal(isClaudeRegionError(null), false);
});

test('blockedRunnerRegion answers the decided row only while it gates', () => {
  assert.equal(blockedRunnerRegion(runner(), NOW)?.name, 'mainland China');
  assert.equal(blockedRunnerRegion(runner({ capabilities: [] }), NOW), null);
  assert.equal(blockedRunnerRegion(runner({ region: region({ verdict: 'allowed' }) }), NOW), null);
  assert.equal(blockedRunnerRegion(runner({ region: region({ decidedAt: ago(CLAUDE_REGION_CARRY_OVER_MS + 1) }) }), NOW), null);
});

test('the create 409, the sign-in refusal and the push carry board 04’s words', () => {
  assert.deepEqual(claudeRegionCreateRefusal(runner(), 'runner-1', NOW), {
    code: 'CLAUDE_REGION_UNSUPPORTED',
    message: 'Claude Code can’t use Anthropic on HPC: its connection is in mainland China, where Anthropic doesn’t offer Claude. Pick a key from another provider, or a workspace on another machine.',
    runnerId: 'runner-1',
  });
  assert.equal(claudeRegionCreateRefusal(runner({ capabilities: [] }), 'runner-1', NOW), null);
  assert.equal(claudeRegionCreateRefusal(runner({ region: region({ verdict: 'allowed' }) }), 'runner-1', NOW), null);
  assert.equal(
    claudeRegionSignInRefusal('HPC', 'Iran'),
    'Claude sign-in isn’t available on HPC: its connection to Anthropic is in Iran, where Anthropic doesn’t offer Claude.',
  );
  assert.equal(
    claudeRegionPushBody('HPC', 'Russia'),
    'Claude Code can’t use Anthropic on HPC — its connection is now in Russia. Sessions on Anthropic accounts or keys there wait until you switch provider or move them.',
  );
});

test('the confirmed flip is the blocked check that takes blockedChecks to 2, and only that one', () => {
  assert.equal(regionFlipConfirmed('blocked', region({ blockedChecks: 1 })), false, 'a single blocked check is no flip');
  assert.equal(regionFlipConfirmed('blocked', region({ blockedChecks: 2 })), true);
  assert.equal(regionFlipConfirmed('blocked', region({ blockedChecks: 3 })), false, 'the checks after it are the same flip');
  // An unknown check leaves the count at 2 right after a flip: it is not the flip again.
  assert.equal(regionFlipConfirmed('unknown', region({ blockedChecks: 2 })), false);
  assert.equal(regionFlipConfirmed('allowed', region({ verdict: 'allowed', blockedChecks: 0 })), false);
  assert.equal(regionFlipConfirmed('blocked', null), false);
});

test('a resolved credential is read for the region check as its key, sign-in or pool', () => {
  const row = { presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com' } as never;
  assert.deepEqual(regionCredentialOf({ kind: 'key', row, slug: 'anthropic', alias: null }), {
    kind: 'key', presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com',
  });
  assert.deepEqual(regionCredentialOf({ kind: 'legacy-dsh' }), { kind: 'key', presetSlug: null, baseUrl: null });
  assert.deepEqual(regionCredentialOf({ kind: 'login', engine: 'claude' }), { kind: 'login', engine: 'claude' });
  assert.deepEqual(regionCredentialOf({ kind: 'pool', slug: 'team', engine: AgentProvider.CLAUDE }), {
    kind: 'pool', slug: 'team', engine: AgentProvider.CLAUDE,
  });
});

function moveFacts(over: Partial<SessionMoveFacts> = {}): SessionMoveFacts {
  return {
    status: RunStatus.PENDING,
    deletedAt: null,
    completedAt: null,
    importSourceCwd: null,
    taskId: null,
    dispatchOrigin: 'USER',
    coordinatesProject: false,
    cancelRequestedAt: null,
    engineTurnActive: false,
    runningBgShells: [],
    liveApprovals: 0,
    queuedTurns: 1,
    mergeStatus: null,
    commitStatus: null,
    mergeRecoveryOpen: false,
    retryAt: null,
    runtime: AgentProvider.CLAUDE,
    ...over,
  };
}

test('a session the region check holds moves at once, with its waiting message; any other queued one must stop first', () => {
  assert.deepEqual(sessionMoveVerdict(moveFacts({ regionHeld: true })), { reason: null, needsEnd: false });
  assert.deepEqual(sessionMoveVerdict(moveFacts()), { reason: MOVE_REFUSAL.STOP, needsEnd: false });
  assert.equal(MOVE_REFUSAL.STOP, 'Stop the session first.');
  // Held, but something of it is still asking: not the hold's to waive.
  assert.equal(sessionMoveVerdict(moveFacts({ regionHeld: true, liveApprovals: 1 })).reason, MOVE_REFUSAL.STOP);
  assert.equal(sessionMoveVerdict(moveFacts({ regionHeld: true, cancelRequestedAt: new Date() })).reason, MOVE_REFUSAL.ENDING);
  // Only a queued session is held; an idle one still ends first, and the session's own refusals still stand.
  assert.deepEqual(sessionMoveVerdict(moveFacts({ regionHeld: true, status: RunStatus.AWAITING_INPUT, queuedTurns: 0 })), { reason: null, needsEnd: true });
  assert.equal(sessionMoveVerdict(moveFacts({ regionHeld: true, taskId: 'task-1' })).reason, MOVE_REFUSAL.TASK);
  assert.equal(sessionMoveVerdict(moveFacts({ regionHeld: true, mergeStatus: 'pending' })).reason, MOVE_REFUSAL.MERGE);
});

/** RunnersService on a runner row, recording whether a sign-in was started. */
function signIn(row: { capabilities: string[]; region: unknown }) {
  const writes: unknown[] = [];
  const prisma = {
    runner: {
      findFirst: async () => ({ id: 'runner-1', ownerId: 'owner-1', name: 'workstation-gpu', displayName: 'HPC', status: 'ONLINE', capabilitiesReportedAt: NOW, ...row }),
      update: async (args: { data: unknown }) => { writes.push(args.data); return { loginStatus: 'pending', loginEngine: 'claude' }; },
    },
  };
  return { service: new RunnersService(prisma as never), writes };
}

test('a Claude sign-in is refused on a blocked runner with board 04’s sentence, and nothing is sent', async () => {
  const blocked = signIn({ capabilities: [CLAUDE_REGION_V1], region: region({ decidedAt: new Date().toISOString() }) });
  await assert.rejects(blocked.service.startLogin('owner-1', 'runner-1', { engine: 'claude' }), (error: { getStatus(): number; getResponse(): unknown }) => {
    assert.equal(error.getStatus(), 409);
    assert.deepEqual(error.getResponse(), {
      code: CLAUDE_REGION_UNSUPPORTED,
      message: 'Claude sign-in isn’t available on HPC: its connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.',
      runnerId: 'runner-1',
    });
    return true;
  });
  assert.deepEqual(blocked.writes, [], 'no login request was recorded for the heartbeat to carry');
  // Another engine's sign-in on the same runner, and Claude's on one that does not check, go ahead (⑥, ⑤).
  const codex = signIn({ capabilities: [CLAUDE_REGION_V1], region: region({ decidedAt: new Date().toISOString() }) });
  await codex.service.startLogin('owner-1', 'runner-1', { engine: 'codex' });
  assert.equal(codex.writes.length, 1);
  const old = signIn({ capabilities: [], region: region({ decidedAt: new Date().toISOString() }) });
  await old.service.startLogin('owner-1', 'runner-1', { engine: 'claude' });
  assert.equal(old.writes.length, 1);
});
