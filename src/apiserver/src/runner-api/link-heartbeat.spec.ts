import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { RunnerHeartbeatRequest, RunnerHeartbeatResponse } from '@orbit/shared';
import { preparedStatementName } from '../prisma/prisma-client';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import {
  changedReports,
  factsHashOf,
  HEADERS_FACT,
  HEARTBEAT_DELIVERIES,
  HEARTBEAT_FACTS,
  heartbeatAnswerHandsOut,
  LINK_RECONCILE_EVERY_MS,
  linkBeatDigests,
  linkBeatVerdict,
  periodicReconcileDue,
  quietHeartbeatAnswer,
  readFactsHash,
  readLinkBeat,
  reconcileHashOf,
  reconcilePhaseMs,
  RUNNER_ROW_FACTS,
} from './link-heartbeat';

/**
 * The link heartbeat answered from runner_presence (link-heartbeat.ts): what it classifies, how it decides, and the
 * census that holds every field a heartbeat delivers to a writer that marks the runner changed.
 */

const SRC = path.resolve(__dirname, '../../src');
const SHARED_DTO = path.resolve(__dirname, '../../../shared/src/dto.ts');
const RUNNER = '0190a0b0-0000-7000-8000-00000000000a';
const PROCESS = '0190a0b0-0000-7000-8000-0000000000aa';
const SESSION_A = '0190a0b0-0000-7000-8000-000000000001';
const SESSION_B = '0190a0b0-0000-7000-8000-000000000002';

/** The members of an exported interface of @orbit/shared's dto.ts, as its source declares them. */
function interfaceMembers(name: string): string[] {
  const source = readFileSync(SHARED_DTO, 'utf8');
  const start = source.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `${name} is declared in src/shared/src/dto.ts`);
  const lines = source.slice(start).split('\n');
  const members: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (depth === 1) {
      const member = /^ {2}([A-Za-z][A-Za-z0-9]*)\??:/.exec(line);
      if (member) members.push(member[1]);
    }
    depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length;
    if (depth === 0 && members.length > 0) break;
  }
  return members.sort();
}

test('every member of a heartbeat\'s body is classified, and only those', () => {
  assert.deepEqual(Object.keys(HEARTBEAT_FACTS).sort(), interfaceMembers('RunnerHeartbeatRequest'));
  // What the runner row is written from is a set of those, and the headers.
  for (const kind of RUNNER_ROW_FACTS) {
    assert.ok(kind === HEADERS_FACT || kind in HEARTBEAT_FACTS, `${kind} is a member of the body`);
  }
});

test('every field a heartbeat delivers says how a beat answered from runner_presence learns of it', () => {
  assert.deepEqual(
    Object.keys(HEARTBEAT_DELIVERIES).filter((field) => field !== 'linkHints').sort(),
    interfaceMembers('RunnerHeartbeatResponse'),
    'a field added to RunnerHeartbeatResponse is classified in HEARTBEAT_DELIVERIES before it ships',
  );
});

// ── The writers of what a heartbeat delivers mark the runner changed ──────────────────────────────────

const METHOD = /^ {2}(?:private |protected |public |static |readonly |abstract )*(?:async )?(?:\*)?([A-Za-z0-9_$]+)\s*[(<]/;
const FUNCTION = /^export (?:async )?function ([A-Za-z0-9_$]+)|^(?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)\s*[=:]/;
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try']);
/** What tells a link heartbeat that something it delivers changed (RealtimeService, realtime/runner-wake.ts). */
const MARKS = /\b(?:markRunnerChanged|markSessionRunnerChanged|notifyRunnerWake|notifyRunnerWakeOnCommit|requestCancel)\(/;

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/** The code of each declaration of a source, by name: a method's lines run to the next declaration. */
function declarations(source: string): Map<string, string> {
  const code = withoutComments(source);
  const out = new Map<string, string>();
  let unit = '(module)';
  for (const line of code.split('\n')) {
    const asMethod = METHOD.exec(line);
    if (asMethod && !NOT_A_METHOD.has(asMethod[1])) unit = asMethod[1];
    else {
      const asFunction = FUNCTION.exec(line);
      if (asFunction) unit = asFunction[1] ?? asFunction[2] ?? asFunction[3];
    }
    out.set(unit, `${out.get(unit) ?? ''}${line}\n`);
  }
  return out;
}

/** The MARKED writers that do not mark, each as `path#declaration: why`. */
function unmarkedWriters(read: (rel: string) => string): string[] {
  const problems: string[] = [];
  for (const [field, delivery] of Object.entries(HEARTBEAT_DELIVERIES)) {
    if (delivery.how !== 'MARKED') continue;
    for (const writer of delivery.writers) {
      const [rel, name] = writer.split('#');
      const body = declarations(read(rel)).get(name);
      if (body === undefined) problems.push(`${writer} (${field}): no such declaration`);
      else if (!MARKS.test(body)) problems.push(`${writer} (${field}): it does not mark the runner changed`);
    }
  }
  return problems;
}

test('each writer named for a delivered field marks the runner changed, after its commit', () => {
  assert.deepEqual(unmarkedWriters((rel) => readFileSync(path.join(SRC, rel), 'utf8')), []);
});

test('a writer that stops marking, or is renamed, is reported', () => {
  const real = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');
  const stripped = (rel: string) =>
    rel === 'runners/runners.service.ts'
      ? real(rel).replace(/this\.realtime\?\.markRunnerChanged\(id\);/g, '')
      : rel === 'workspaces/workspaces.service.ts'
        ? real(rel).replace('async requestRepoCleanup(', 'async askForRepoCleanup(')
        : real(rel);
  const problems = unmarkedWriters(stripped);
  assert.ok(problems.includes('runners/runners.service.ts#startInstall (installRequest): it does not mark the runner changed'), problems.join('\n'));
  assert.ok(problems.includes('runners/runners.service.ts#requestClaudeHistory (claudeHistoryRequest): it does not mark the runner changed'));
  assert.ok(problems.includes('runners/runners.service.ts#requestDirProbe (dirProbeRequest): it does not mark the runner changed'));
  assert.ok(problems.includes('workspaces/workspaces.service.ts#requestRepoCleanup (repoCleanupRequest): no such declaration'));
});

// ── Digests ──────────────────────────────────────────────────────────────────────────────────────────

const BODY: RunnerHeartbeatRequest = {
  status: 'ONLINE',
  idleCapacity: 3,
  version: '0.1.237',
  leaseOwner: PROCESS,
  supervisedSessionIds: [SESSION_A, SESSION_B],
  commands: [{ name: 'review' }],
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  planUsage: { provider: 'claude' },
  agentDirProbes: [{ agentId: SESSION_A, exists: true, isGitRepo: true, freeBytes: 1_000 }],
} as RunnerHeartbeatRequest;
const HEADERS = { capabilities: 'integration-job/v1', providers: 'claude', os: 'linux' };

test('a beat\'s digests: one per member it carries, the supervised sessions as a set, idleCapacity left out', () => {
  const digests = linkBeatDigests(BODY, HEADERS);
  assert.deepEqual(
    Object.keys(digests.facts).sort(),
    [HEADERS_FACT, 'agentDirProbes', 'commands', 'engines', 'leaseOwner', 'planUsage', 'status', 'supervisedSessionIds', 'version'],
  );
  const reordered = linkBeatDigests(
    { ...BODY, idleCapacity: 0, supervisedSessionIds: [SESSION_B.toUpperCase(), SESSION_A], leaseOwner: PROCESS.toUpperCase() },
    HEADERS,
  );
  assert.deepEqual(reordered, digests, 'the same sessions in another order, another capacity: the same beat');
  // A report that moves changes its own digest and nothing that decides deliveries.
  const probed = linkBeatDigests({ ...BODY, agentDirProbes: [{ ...BODY.agentDirProbes![0], freeBytes: 999 }] }, HEADERS);
  assert.notEqual(probed.facts.agentDirProbes, digests.facts.agentDirProbes);
  assert.equal(probed.delivery, digests.delivery);
  // What does decide deliveries moves the delivery digest.
  for (const changed of [
    linkBeatDigests({ ...BODY, draining: true }, HEADERS),
    linkBeatDigests({ ...BODY, supervisedSessionIds: [SESSION_A] }, HEADERS),
    linkBeatDigests({ ...BODY, engines: [] }, HEADERS),
    linkBeatDigests(BODY, { ...HEADERS, capabilities: 'integration-job/v1,wiki-repo-op/v1' }),
  ]) {
    assert.notEqual(changed.delivery, digests.delivery);
  }
  // Left out is not the same as null: an absent member keeps what the server holds.
  assert.notDeepEqual(linkBeatDigests({ ...BODY, selfUpdate: null } as never, HEADERS).facts, digests.facts);
});

test('facts_hash round-trips, and anything else reads as no record', () => {
  const { facts } = linkBeatDigests(BODY, HEADERS);
  assert.deepEqual(readFactsHash(factsHashOf(facts)), facts);
  for (const stored of [null, '', 'not json', '[]', '"x"']) assert.equal(readFactsHash(stored), null);
  assert.deepEqual(changedReports(facts, facts), []);
  const { facts: moved } = linkBeatDigests({ ...BODY, planUsage: { provider: 'codex' }, commands: [] } as RunnerHeartbeatRequest, HEADERS);
  assert.deepEqual(changedReports(facts, moved).sort(), ['commands', 'planUsage']);
  // A report the beat no longer carries has changed too: the one write that cares, selfUpdate's, writes NULL.
  const { facts: without } = linkBeatDigests({ ...BODY, commands: undefined }, HEADERS);
  assert.deepEqual(changedReports(facts, without), ['commands']);
});

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────────

/** A minute into this runner's current period, and the last full reconcile at its start: nothing periodic is due. */
const PERIOD_START = (() => {
  const at = Date.parse('2026-10-26T06:00:00.000Z');
  const phase = reconcilePhaseMs(RUNNER);
  return Math.floor((at - phase) / LINK_RECONCILE_EVERY_MS) * LINK_RECONCILE_EVERY_MS + phase;
})();
const NOW = PERIOD_START + 60_000;

function recorded(over: Partial<Parameters<typeof linkBeatVerdict>[1]> = {}) {
  const digests = linkBeatDigests(BODY, HEADERS);
  const row = {
    inserted: false,
    changes: '7',
    factsHash: factsHashOf(digests.facts),
    reconcileHash: reconcileHashOf(digests.delivery, '7'),
    reconciledMs: PERIOD_START + 1,
    nowMs: NOW,
    leasesHeld: 2,
    ...over,
  };
  return { row, digests };
}

test('a beat that says what the last reconcile covered, with nothing changed since, is answered quietly', () => {
  const { row, digests } = recorded();
  assert.deepEqual(linkBeatVerdict(RUNNER, row, digests, 2), { answer: 'QUIET' });
});

test('a beat reconciles in full on a new row, no record, a lost lease, a moved count, new inputs or a new period', () => {
  const { digests } = recorded();
  const verdict = (over: Partial<Parameters<typeof linkBeatVerdict>[1]>, supervised = 2) =>
    linkBeatVerdict(RUNNER, recorded(over).row, digests, supervised);
  assert.deepEqual(verdict({ inserted: true }), { answer: 'FULL', reason: 'NO_RECORD' });
  assert.deepEqual(verdict({ reconciledMs: null }), { answer: 'FULL', reason: 'NO_RECORD' }, 'a row a failover emptied and re-made');
  assert.deepEqual(verdict({ reconcileHash: null }), { answer: 'FULL', reason: 'NO_RECORD' }, 'the last reconcile left work pending');
  assert.deepEqual(verdict({ factsHash: null }), { answer: 'FULL', reason: 'NO_RECORD' }, 'an HTTPS beat wrote the row');
  assert.deepEqual(verdict({ leasesHeld: 1 }), { answer: 'FULL', reason: 'LEASE' });
  assert.deepEqual(verdict({ changes: '8' }), { answer: 'FULL', reason: 'CHANGED' });
  assert.deepEqual(verdict({ reconcileHash: reconcileHashOf('another', '7') }), { answer: 'FULL', reason: 'INPUTS' });
  assert.deepEqual(verdict({ reconciledMs: NOW - LINK_RECONCILE_EVERY_MS }), { answer: 'FULL', reason: 'PERIOD' });
});

test('a beat whose reports alone moved writes them, and only them', () => {
  const { row } = recorded();
  const moved = linkBeatDigests(
    { ...BODY, agentDirProbes: [{ ...BODY.agentDirProbes![0], freeBytes: 2_000 }], planUsage: { provider: 'codex' } } as RunnerHeartbeatRequest,
    HEADERS,
  );
  const verdict = linkBeatVerdict(RUNNER, row, moved, 2);
  assert.equal(verdict.answer, 'REPORT');
  assert.deepEqual(verdict.answer === 'REPORT' ? [...verdict.reports].sort() : [], ['agentDirProbes', 'planUsage']);
});

test('the periodic reconcile: at least once in five minutes, once per period, and spread across the fleet', () => {
  // Five minutes after the last one, it is always due.
  for (let at = 0; at < LINK_RECONCILE_EVERY_MS; at += 7_919) {
    assert.equal(periodicReconcileDue(RUNNER, NOW + at, NOW + at + LINK_RECONCILE_EVERY_MS), true);
  }
  // Within one period it is due at most once: right after the reconcile, never.
  assert.equal(periodicReconcileDue(RUNNER, NOW, NOW + 1), false);
  let due = 0;
  let last = NOW;
  for (let at = NOW; at < NOW + 10 * LINK_RECONCILE_EVERY_MS; at += 30_000) {
    if (periodicReconcileDue(RUNNER, last, at)) {
      due += 1;
      last = at;
    }
  }
  assert.ok(due >= 9 && due <= 10, `ten periods of 30 s beats reconcile ${due} times`);
  // A fleet that reconciled together does not come due together again.
  const phases = Array.from({ length: 1_000 }, (_, i) =>
    reconcilePhaseMs(`0190a0b0-0000-7000-8000-${String(i).padStart(12, '0')}`));
  const buckets = new Array(10).fill(0);
  for (const phase of phases) buckets[Math.floor(phase / (LINK_RECONCILE_EVERY_MS / 10))] += 1;
  assert.ok(buckets.every((n) => n > 50 && n < 150), `phases spread over the period: ${buckets.join(' ')}`);
});

// ── The answers ──────────────────────────────────────────────────────────────────────────────────────

test('the quiet answer hands out nothing and states the runner\'s settings, with no directory list', () => {
  const hints = { inboxSessionIds: [SESSION_A], claim: false, approvals: [] };
  const quiet = quietHeartbeatAnswer({ maxConcurrent: 4, minFreeDiskMb: 2048 }, { cursorKeyChecks: [], linkHints: hints });
  assert.deepEqual(quiet, {
    cancelSessionIds: [],
    leaseLostSessionIds: [],
    maxConcurrent: 4,
    minFreeDiskMb: 2048,
    mergeRequests: [],
    commitRequests: [],
    artifactRequests: [],
    linkHints: hints,
  });
  assert.equal(heartbeatAnswerHandsOut(quiet), false);
  assert.equal('agentDirs' in quiet, false, 'a runner keeps scanning the directories it has (runloop.go)');
  // A floor that is not set is said as null, which the runner reads as no floor — what it has.
  assert.equal(quietHeartbeatAnswer({ maxConcurrent: 1, minFreeDiskMb: null }, {}).minFreeDiskMb, null);
});

test('the quiet answer is, to the byte, what the runner\'s own test applies (src/runner-go/testdata/o1-quiet-answer.json)', () => {
  const fixture = readFileSync(path.resolve(__dirname, '../../../runner-go/testdata/o1-quiet-answer.json'), 'utf8').trim();
  assert.equal(JSON.stringify(quietHeartbeatAnswer({ maxConcurrent: 4, minFreeDiskMb: 2048 }, {})), fixture);
});

test('the beat statement is a prepared one: it opens with the mark, and its text is one of two whatever the beat says', async () => {
  const texts = new Set<string>();
  const prisma = {
    $queryRaw: (...args: unknown[]) => {
      texts.add(renderRawQuery(args).text);
      return Promise.resolve([]);
    },
  };
  const beats = [
    { runnerId: RUNNER, processId: PROCESS, gatewayId: 'gateway-1', sessions: [SESSION_A, SESSION_B], planUsageDigest: 'AAAAAAAAAAAAAAAA' },
    { runnerId: '0190a0b0-0000-7000-8000-00000000000b', processId: null, gatewayId: null, sessions: [], planUsageDigest: null },
    { runnerId: RUNNER, processId: PROCESS, gatewayId: 'gateway-2', sessions: [SESSION_B], planUsageDigest: null },
    { runnerId: RUNNER, processId: null, gatewayId: null, sessions: [SESSION_A], planUsageDigest: 'BBBBBBBBBBBBBBBB' },
  ];
  for (const b of beats) {
    await readLinkBeat(prisma as never, {
      runnerId: b.runnerId, ownerId: '0190a0b0-0000-7000-8000-0000000000ff', credential: 'c'.repeat(32), processId: b.processId,
      gatewayId: b.gatewayId, namedSessionIds: b.sessions, supervisedSessionIds: b.sessions, planUsageDigest: b.planUsageDigest,
    });
  }
  assert.equal(texts.size, 2, 'with and without a plan usage to compare: two statements, each prepared once per connection');
  for (const text of texts) assert.ok(preparedStatementName({ sql: text }), `not prepared: ${text.slice(0, 80)}`);
});

test('an answer that carries any command, cancellation or lost lease hands something out', () => {
  const base: RunnerHeartbeatResponse = { cancelSessionIds: [], maxConcurrent: 2, agentDirs: [{ agentId: SESSION_A, workDir: '/w' }] };
  assert.equal(heartbeatAnswerHandsOut(base), false, 'the directory list and the settings are no command');
  for (const extra of [
    { cancelSessionIds: [SESSION_A] },
    { leaseLostSessionIds: [SESSION_A] },
    { mergeRequests: [{} as never] },
    { commitRequests: [{} as never] },
    { artifactRequests: [{} as never] },
    { integrationJobs: [{} as never] },
    { wikiRepoOps: [{} as never] },
    { cursorKeyChecks: [{} as never] },
    { loginRequest: {} as never },
    { accountRemoveRequest: {} as never },
    { codexAccountRemoveRequest: {} as never },
    { installRequest: {} as never },
    { repoCleanupRequest: {} as never },
    { claudeHistoryRequest: {} as never },
    { dirProbeRequest: {} as never },
    { codexRateLimitResetRequest: {} as never },
    { managedSleep: {} as never },
    { refreshModelCatalog: true },
    { checkSelfUpdate: true },
  ] as Array<Partial<RunnerHeartbeatResponse>>) {
    assert.equal(heartbeatAnswerHandsOut({ ...base, ...extra }), true, JSON.stringify(extra));
  }
});
