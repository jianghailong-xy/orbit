/**
 * 0225 without a database: the startup-context table and the rollout gate are gone from the tree.
 *
 * Its sibling `session-send-startup-removal.pg.spec.ts` proves the same removal against real rows
 * and over real HTTP. These are the halves decided by reading what ships — that the table, its
 * Prisma delegate and its raw-SQL name are absent at every door, that no send can be answered with
 * `SESSION_TURN_PROTOCOL_DISABLED` any more because nothing in the tree can raise it, and that the
 * change is a subtraction — so they run wherever the suite runs, with or without a server.
 *
 * What is deliberately NOT removed, and is asserted present below: `conversation_turn`, and the
 * exact-target CURRENT_WORK steer that joins a turn already running.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/** build/sessions -> build -> apiserver -> src -> repository root. */
function repoRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8' }).trim();
}

const REMOVAL_MIGRATION =
  'src/apiserver/prisma/migrations/0225_session_current_work_startup_fragment_removal/migration.sql';

// ── (a) the startup-fragment table and the functions over it are gone ──────────────────────────

test('(a) the migration drops the table and the column that pointed at it', () => {
  const removal = read(REMOVAL_MIGRATION);
  assert.match(removal, /DROP TABLE "conversation_turn_startup_fragment";/);
  assert.match(removal, /ALTER TABLE "attachment" DROP COLUMN "startup_fragment_id";/);
  assert.match(removal, /DROP CONSTRAINT "attachment_startup_fragment_id_fkey"/);
  assert.match(removal, /DROP CONSTRAINT "attachment_single_message_owner_check"/);
  // Fail closed rather than destroying authored input: the drop refuses to run on a database that
  // has rows in it, which is the whole reason it is safe to state this as a removal at all.
  assert.match(removal, /SESSION_STARTUP_FRAGMENT_REMOVAL_HAS_ROWS/);
  // An explicit transaction would report "transaction is aborted" and hide that message.
  assert.doesNotMatch(removal.replace(/^--.*$/gm, ''), /^\s*(BEGIN|COMMIT)\s*;/mi);
});

test('(a) the model, its relations and the delivery functions over it are gone', () => {
  const schema = read('src/apiserver/prisma/schema.prisma');
  assert.doesNotMatch(schema, /model ConversationTurnStartupFragment/);
  assert.doesNotMatch(schema, /startupFragment/);
  assert.doesNotMatch(schema, /startup_fragment/);
  // ...and the table it hung off is still here, with its own rows untouched by this change.
  assert.match(schema, /model ConversationTurn \{/);
  assert.match(schema, /@@map\("conversation_turn"\)/);

  const delivery = read('src/apiserver/src/sessions/current-work-delivery.ts');
  assert.doesNotMatch(delivery, /terminalizePendingStartupContexts/);
  assert.doesNotMatch(delivery, /CurrentWorkStartupTransaction/);
  assert.doesNotMatch(delivery, /conversationTurnStartupFragment/);
  // The live-turn half it was bundled with stays, and stays reachable under its own name.
  assert.match(delivery, /export async function terminalizePendingCurrentWorkSteers/);
});

// ── (b) the 503 rollout gate is gone ───────────────────────────────────────────────────────────

test('(b) no door can answer a send with SESSION_TURN_PROTOCOL_DISABLED', () => {
  const service = read('src/apiserver/src/sessions/sessions.service.ts');
  assert.doesNotMatch(service, /SESSION_TURN_PROTOCOL_DISABLED/);
  assert.doesNotMatch(service, /assertSessionTurnProtocolEnabled/);
  assert.doesNotMatch(service, /ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED/);
  // The gate's other half: the orchestration send that hard-coded the intent the gate refused.
  const runnerSessions = read('src/apiserver/src/runner-api/runner-sessions.controller.ts');
  assert.doesNotMatch(runnerSessions, /intent:\s*'CURRENT_WORK'/);
  // And the deployment no longer carries the flag that decided it.
  assert.doesNotMatch(read('docker-compose.yml'), /ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED/);
});

// ── (c) nothing in the tree still names the dropped table, raw SQL included ────────────────────

test('(c) the whole repository is free of references to the dropped table and column', () => {
  // Tracked plus untracked-but-not-ignored: a scanner that read only the index would go green on a
  // file this change had just created and not yet committed.
  const files = git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean);
  assert.ok(files.length > 500, 'the residual scan must actually have read the repository');
  const offenders: string[] = [];
  for (const file of files) {
    // Migrations are append-only history: 0210 must still be able to CREATE what 0225 drops.
    if (file.startsWith('src/apiserver/prisma/migrations/')) continue;
    // This spec and its sibling are where the absence is asserted, so they must name it.
    if (file.includes('startup-removal')) continue;
    // The Release DAG contract's `reason` fields are an immutable record of attempts that already
    // happened. One of them narrates the day a transaction double stopped modelling this delegate.
    // Rewriting audit history to make a scan pass would be the more expensive mistake.
    if (file === 'contracts/outcome-reconciler-release-dag.json') continue;
    if (!/\.(ts|tsx|js|mjs|cjs|go|sql|json|ya?ml|sh|md|swift)$/.test(file)) continue;
    let source: string;
    try {
      source = readFileSync(path.join(repoRoot(), file), 'utf8');
    } catch {
      continue;
    }
    for (const [index, line] of source.split('\n').entries()) {
      // A USE, not a mention: the table or column name where SQL would read or write it, or the
      // Prisma delegate/model/field that stands for it. `$queryRaw` and `$executeRaw` are plain
      // template strings the compiler cannot check, which is exactly why this scan is textual.
      const uses = /"?conversation_turn_startup_fragment|"?startup_fragment_id/i.test(line)
        || /\bconversationTurnStartupFragment\b|\bConversationTurnStartupFragment\b/.test(line)
        || /\bstartupFragments?\b|\bstartupFragmentId\b|\bstartupTurnFragments\b/.test(line)
        || /\bappendStartupTurnFragments\b/.test(line);
      if (!uses) continue;
      // A line that records what was removed is history, not a reference.
      if (/0210|0225|removal|removed|deleted/i.test(line)) continue;
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('(c) the rollout gate has no residual reference either', () => {
  const files = git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean);
  const offenders: string[] = [];
  for (const file of files) {
    // 0225's own comment says which flag it is removing; that is the record, not a reader of it.
    if (file.startsWith('src/apiserver/prisma/migrations/')) continue;
    if (file.includes('startup-removal')) continue;
    if (!/\.(ts|tsx|js|mjs|cjs|go|sql|json|ya?ml|sh|md|swift)$/.test(file)) continue;
    let source: string;
    try {
      source = readFileSync(path.join(repoRoot(), file), 'utf8');
    } catch {
      continue;
    }
    for (const [index, line] of source.split('\n').entries()) {
      if (!/ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED|SESSION_TURN_PROTOCOL_DISABLED/.test(line)) {
        continue;
      }
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ── (h) this change is a subtraction ───────────────────────────────────────────────────────────

const GATE_FILES = [
  'docker-compose.yml',
  'src/apiserver/prisma/schema.prisma',
  'src/apiserver/src/common/db-write-inventory.ts',
  'src/apiserver/src/queue/queue.service.ts',
  'src/apiserver/src/realtime/reaper.service.ts',
  'src/apiserver/src/runner-api/runner-api.controller.ts',
  'src/apiserver/src/runner-api/runner-sessions.controller.ts',
  'src/apiserver/src/sessions/auto-retry.service.ts',
  'src/apiserver/src/sessions/current-work-delivery.ts',
  'src/apiserver/src/sessions/sessions.service.ts',
  'src/apiserver/src/test-support/prisma-transaction-double.ts',
  'src/shared/src/codec.ts',
  'src/shared/src/dto.ts',
];

test('(h) no compose service, no resident process, and the files it lived in shrank', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services, [
    'postgres', 'pgbackup', 'apiserver', 'web', 'gateway', 'pg-socket',
  ], 'the removal must not have added a service');

  const apiPackage = JSON.parse(read('src/apiserver/package.json')) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(Object.keys(apiPackage.scripts).filter((name) => name.startsWith('start:')),
    ['start:dev'],
    'the removal must not have added a long-running entrypoint');

  // A removal migration that adds schema is not a removal.
  const statements = read(REMOVAL_MIGRATION).replace(/^--.*$/gm, '');
  assert.doesNotMatch(statements, /CREATE TABLE/i);
  assert.doesNotMatch(statements, /ADD COLUMN/i);
  assert.doesNotMatch(statements, /CREATE TYPE/i);
  assert.doesNotMatch(statements, /CREATE EXTENSION|pg_cron|\bLISTEN\b|\bNOTIFY\b/);

  // And the line tally over the files the startup protocol actually lived in. Naming them is the
  // point: a whole-diff count would be dominated by the specs written to prove this removal.
  const commits = git('log', '--format=%H', '--', REMOVAL_MIGRATION).split('\n').filter(Boolean);
  const numstat = commits.length > 0
    ? commits.map((sha) => git('show', '--numstat', '--format=', sha)).join('\n')
    : git('diff', '--numstat', 'HEAD');
  let added = 0;
  let deleted = 0;
  const measured = new Set<string>();
  for (const line of numstat.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t(.*)$/);
    if (!match) continue;
    const file = GATE_FILES.find((candidate) => match[3] === candidate);
    if (!file) continue;
    measured.add(file);
    added += Number(match[1]);
    deleted += Number(match[2]);
  }
  assert.deepEqual([...measured].sort(), [...GATE_FILES].sort(),
    'every file the startup protocol lived in must appear in the change being measured');
  assert.ok(deleted > added,
    `the files the startup protocol lived in must shrink: +${added} / -${deleted}`);
});
