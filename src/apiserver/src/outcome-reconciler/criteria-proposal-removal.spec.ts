import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the acceptance-criteria PROPOSAL channel deleted.
 *
 * 0217_project_criteria_proposal_card made an agent's `acceptanceCriteriaItems` a card the account
 * owner had to answer, and 0218 kept that card while deleting the approval queue around it. The
 * account owner decided to remove the protection itself, so 0223 takes the whole channel out: the
 * relation, its six indexes, its nine stored functions, both HTTP doors, the web card and the copy
 * that described them.
 *
 * The four invariants the channel carried are GONE, not relocated:
 *
 *   criteriaEditingHasNoWebEntryPoint
 *   criteriaProposalHasNoAutomaticApplyPath
 *   criteriaProposalDoesNotMoveTheRuler
 *   criteriaProposalMachineDecisionRefused
 *
 * That is the accepted cost: any principal that reaches `project_update` now rewrites any
 * project's acceptance criteria directly, in force immediately, with no confirmation step, no
 * rendered diff and no ABA protection. This file exists so the removal is whole — a half-removed
 * channel would leave unreachable machinery behind and copy that lies about what a write does —
 * and so that nothing quietly reinstates an equivalent protection under another name.
 *
 * Everything here is derived from the tree: relations and functions are replayed out of
 * `prisma/migrations`, and every scan reads the same text a reviewer reads. The database-side
 * proof, against the actually-migrated schema, is `projects/criteria-proposal-removal.pg.spec.ts`.
 */
const API = path.resolve(__dirname, '../..');
const REPO = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');

const PROPOSAL_TABLE = 'project_criteria_proposal';

/** The four 0217 declared by name. The other two are the primary key and the generation unique. */
const PROPOSAL_INDEXES = [
  'project_criteria_proposal_one_pending_idx',
  'project_criteria_proposal_idempotency_idx',
  'project_criteria_proposal_decision_idempotency_idx',
  'project_criteria_proposal_inbox_idx',
];

/** Eight from 0217, plus the criteria-set digest 0218 added for the re-binding. */
const PROPOSAL_FUNCTIONS = [
  'project_acceptance_criteria_set_digest',
  'project_apply_criteria_proposal',
  'project_criteria_proposal_card',
  'project_criteria_proposal_diff',
  'project_criteria_proposal_effective_criteria',
  'project_criteria_proposal_normalize',
  'project_criteria_proposal_state_json',
  'project_owner_decide_criteria_proposal',
  'project_propose_acceptance_criteria',
];

/** Every `project_acceptance_*` relation in the schema. None of them is this task's to touch. */
const ACCEPTANCE_TABLES = [
  'project_acceptance_audit',
  'project_acceptance_conclusion',
  'project_acceptance_criteria_confirmation',
  'project_acceptance_criterion',
  'project_acceptance_criterion_definition',
  'project_acceptance_run',
];

/** The four names the account owner used for what this removal costs. */
const REMOVED_INVARIANTS = [
  'criteriaEditingHasNoWebEntryPoint',
  'criteriaProposalHasNoAutomaticApplyPath',
  'criteriaProposalDoesNotMoveTheRuler',
  'criteriaProposalMachineDecisionRefused',
];

/** The TypeScript, Go and web vocabulary the channel was spelled in. */
const PROPOSAL_IDENTIFIERS = [
  'ProjectCriteriaProposalCard',
  'ProposeCriteriaChangeDto',
  'CriteriaProposalDecisionDto',
  'proposeCriteriaChange',
  'decideCriteriaProposal',
  'machineCriteriaProposal',
  'criteriaProposalItems',
  'acceptanceCriteriaProposal',
  'criteria-proposal',
];

const CREATED_BY = '0217_project_criteria_proposal_card';
const REMOVED_BY = '0223_project_criteria_proposal_removal';

function migrations(): Array<{ dir: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((dir) => /^\d{4}_/.test(dir))
    .sort()
    .flatMap((dir) => {
      const file = path.join(MIGRATIONS, dir, 'migration.sql');
      try {
        return [{ dir, sql: readFileSync(file, 'utf8') }];
      } catch {
        return [];
      }
    });
}

/** The last migration that creates or drops `object`, and which of the two it did. */
function lastVerdict(
  created: RegExp,
  dropped: RegExp,
): { dir: string; verdict: 'CREATED' | 'DROPPED' } | null {
  let standing: { dir: string; verdict: 'CREATED' | 'DROPPED' } | null = null;
  for (const { dir, sql } of migrations()) {
    if (created.test(sql)) standing = { dir, verdict: 'CREATED' };
    if (dropped.test(sql)) standing = { dir, verdict: 'DROPPED' };
  }
  return standing;
}

function removalMigration(): string {
  return readFileSync(path.join(MIGRATIONS, REMOVED_BY, 'migration.sql'), 'utf8');
}

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

function exists(relative: string): boolean {
  return statSync(path.join(REPO, relative), { throwIfNoEntry: false }) !== undefined;
}

test('the proposal relation and its six indexes are created by 0217 and dropped by 0223', () => {
  const table = lastVerdict(
    new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${PROPOSAL_TABLE}"?[\\s(]`, 'i'),
    new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${PROPOSAL_TABLE}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i'),
  );
  assert.ok(table, `${PROPOSAL_TABLE} is named by no migration at all`);
  assert.equal(table.verdict, 'DROPPED', `${PROPOSAL_TABLE} is still installed by ${table.dir}`);
  assert.equal(table.dir, REMOVED_BY);
  assert.ok(table.dir > CREATED_BY);

  // The four declared indexes go with the relation rather than being dropped one by one, which is
  // what makes "six" checkable: PostgreSQL takes the primary key and the (project_id,
  // proposal_generation) unique constraint with the table too. No later migration recreates one.
  for (const index of PROPOSAL_INDEXES) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${index}"?`, 'i'),
      new RegExp(`DROP\\s+(?:TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${PROPOSAL_TABLE}"?|INDEX\\s+(?:IF\\s+EXISTS\\s+)?"?${index}"?)`, 'i'),
    );
    assert.ok(standing, `${index} is named by no migration`);
    assert.equal(standing.verdict, 'DROPPED', `${index} is still installed by ${standing.dir}`);
  }
});

test('every proposal stored function is dropped, and the channel installed no view', () => {
  for (const fn of PROPOSAL_FUNCTIONS) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?\\s*\\(`, 'i'),
      new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${fn}"?\\s*\\(`, 'i'),
    );
    assert.ok(standing, `${fn} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${fn} is still installed by ${standing.dir}`);
  }
  // Stated rather than assumed: neither 0217 nor 0218 created a view over the proposal, so "the
  // views are gone" is a fact about an empty set and a reader should not go looking for one.
  for (const dir of [CREATED_BY, '0218_owner_ratification_queue_removal']) {
    const { sql } = migrations().find((migration) => migration.dir === dir)!;
    assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, `${dir} installed a view`);
  }
});

/** Every tracked file a reviewer would read, minus the append-only migration history. */
function liveSources(): Array<{ rel: string; text: string }> {
  const roots = ['src/apiserver/src', 'src/apiserver/prisma/schema.prisma', 'src/shared/src',
    'src/web/src', 'src/runner-go', 'scripts', 'test', 'contracts', 'docs', 'package.json'];
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (abs: string) => {
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (entry === 'node_modules' || entry === 'build' || entry === 'dist') continue;
        walk(path.join(abs, entry));
      }
      return;
    }
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|yml|yaml)$/.test(abs)) return;
    out.push({ rel: path.relative(REPO, abs), text: readFileSync(abs, 'utf8') });
  };
  for (const root of roots) walk(path.join(REPO, root));
  return out;
}

/**
 * The three files whose JOB is to name what is gone. Enumerated rather than pattern-matched: an
 * exemption that grew by accident would be a hole in the scan below, and this list failing is a
 * cheaper way to find out than a resurrected reference passing unnoticed.
 */
const REMOVAL_WITNESSES = [
  'src/apiserver/src/outcome-reconciler/criteria-proposal-removal.spec.ts',
  'src/apiserver/src/projects/criteria-proposal-removal.pg.spec.ts',
  'test/outcome-reconciler-v2.ratification.test.mjs',
];

test('no live source names the proposal relation, a proposal function or the channel vocabulary', () => {
  const names = [PROPOSAL_TABLE, ...PROPOSAL_INDEXES, ...PROPOSAL_FUNCTIONS, ...PROPOSAL_IDENTIFIERS];
  const sources = liveSources();
  assert.ok(sources.length > 1_000, `the scan must actually have read the tree: ${sources.length}`);
  for (const witness of REMOVAL_WITNESSES) {
    assert.ok(sources.some(({ rel }) => rel === witness), `${witness} is not in the scan`);
  }
  const offenders: string[] = [];
  for (const { rel, text } of sources) {
    if (REMOVAL_WITNESSES.includes(rel)) continue;
    text.split('\n').forEach((line, index) => {
      // Naming the migration that created something, on the same line, is a citation of the
      // history rather than a use of it: `prisma/migrations` is append-only, so a manifest may
      // still take a digest of 0217 after the objects it describes are gone.
      if (line.includes('prisma/migrations/')) return;
      for (const name of names) {
        if (line.includes(name)) offenders.push(`${rel}:${index + 1}: ${name}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'the proposal channel is still named outside the migration history — raw SQL in `$queryRaw` '
      + 'is not type-checked, so this scan is the only thing that would catch it');
});

test('all four invariants are gone together: no half-removed channel is left behind', () => {
  const offenders: string[] = [];
  for (const { rel, text } of liveSources()) {
    if (REMOVAL_WITNESSES.includes(rel)) continue;
    for (const invariant of REMOVED_INVARIANTS) {
      if (text.includes(invariant)) offenders.push(`${rel}: ${invariant}`);
    }
  }
  assert.deepEqual(offenders, [],
    'one of the four invariants still has an implementation: they are removed together or the '
      + 'channel is half-standing, with logic nothing can reach');
});

test('the web entry point is gone: the card, its test and its mount point', () => {
  assert.equal(exists('src/web/src/components/ProjectCriteriaProposalCard.tsx'), false);
  assert.equal(exists('src/web/src/components/ProjectCriteriaProposalCard.test.tsx'), false);
  assert.doesNotMatch(read('src/web/src/components/WorkspaceView.tsx'), /CriteriaProposal/,
    'the web mount point is still there');
  // No manifest may still digest the card, or its suite fails on a missing file rather than on
  // anything a reader would recognise. The surfaces manifest that named it has since been deleted
  // upstream, so this scans every manifest instead of that one path, which would now throw ENOENT
  // before it could assert anything.
  for (const manifest of readdirSync(path.join(REPO, 'scripts')).filter((f) => f.endsWith('.mjs'))) {
    assert.doesNotMatch(read(path.join('scripts', manifest)), /ProjectCriteriaProposalCard/,
      `${manifest} still digests a file that no longer exists`);
  }
});

test('the apiserver propose and decide paths are gone from both doors', () => {
  const service = read('src/apiserver/src/projects/project-acceptance.service.ts');
  assert.doesNotMatch(service, /proposeCriteriaChange|decideCriteriaProposal/,
    'the propose and decide service methods are still there');
  const user = read('src/apiserver/src/projects/projects.controller.ts');
  assert.doesNotMatch(user, /criteria-proposal|criteria-confirmation/,
    'the user door still carries a proposal or confirmation route');
  const runner = read('src/apiserver/src/runner-api/runner-projects.controller.ts');
  assert.doesNotMatch(runner, /criteria-proposal/, 'the runner door still carries a proposal route');
  assert.doesNotMatch(read('src/apiserver/src/projects/dto.ts'),
    /ProposeCriteriaChangeDto|CriteriaProposalDecisionDto/, 'the proposal DTOs are still declared');
  // The two write units the inventory carried for them go with the methods: an entry describing a
  // method that no longer exists is exactly what `db-write-inventory.spec.ts` refuses.
  assert.doesNotMatch(read('src/apiserver/src/common/db-write-inventory.ts'),
    /CriteriaProposal|criteria_proposal/, 'a write-inventory unit still describes the channel');
});

test('the acceptance-criteria capability set carries no propose and no confirm', () => {
  // `project_criteria_confirm` was the 0189-era one-shot confirmation tool and it is not declared
  // anywhere; asserted so a later change cannot reintroduce a confirmation step under the old
  // name. `project_update` is the whole surface acceptance criteria are written through.
  for (const relative of ['src/runner-go/mcp.go', 'src/runner-go/project_cli.go']) {
    const source = read(relative);
    assert.doesNotMatch(source, /project_criteria_(?:confirm|propose)/,
      `${relative} declares a criteria confirmation or proposal capability`);
  }
  const runner = read('src/apiserver/src/runner-api/runner-projects.controller.ts');
  // The one PATCH, reaching the one write. Everything else on the body already went this way; the
  // point of the assertion is that acceptance criteria are no longer split off from it.
  assert.match(runner,
    /@Patch\('projects\/:id'\)[\s\S]*?return this\.projects\.update\(runner\.ownerId, id, dto, sessionId\);/,
    'the runner PATCH must forward the whole body, acceptance criteria included, to the write');
  assert.doesNotMatch(runner, /refuseEmptyCriteriaProposal/,
    '`acceptanceCriteriaItems: []` is a clear again, not a refusal about proposals');
});

/**
 * Copy that would be a lie after this change.
 *
 * A tool description saying "this is a proposal, nothing changes until the owner approves it" in
 * front of a write that lands immediately is worse than no description: a model reads it, reports
 * the criteria as unchanged, and keeps working to a standard that has already moved.
 */
const LYING_COPY = [
  /\bPROPOSAL\b/,
  /you are PROPOSING/i,
  /acceptanceCriteriaProposal/,
  /records? (?:one|a) proposal for the account owner/i,
  /nothing changes until (?:they|the owner)/i,
  /until the (?:account )?owner (?:approves|answers) it/i,
  /\[\] is refused/,
  // The same claim in Chinese: the web app's own copy is Chinese, and an English-only scan would
  // have missed the one sentence on the acceptance review page that said the ruler moved by
  // proposal and owner confirmation. Scoped to lines that are about the standard, because
  // "approve" on its own is the evidence-signoff channel, which still exists.
  /标准[^\n]{0,40}(?:提议|批准|卡片上确认)/,
  /(?:提议|批准)[^\n]{0,40}标准/,
];

test('CLI, MCP and web copy about acceptance criteria matches what a write now does', () => {
  const surfaces: Array<[string, string]> = [
    ['src/runner-go/mcp.go', read('src/runner-go/mcp.go')],
    ['src/runner-go/project_cli.go', read('src/runner-go/project_cli.go')],
    ['src/apiserver/src/projects/dto.ts', read('src/apiserver/src/projects/dto.ts')],
    ['src/apiserver/src/runner-api/runner-projects.controller.ts',
      read('src/apiserver/src/runner-api/runner-projects.controller.ts')],
  ];
  for (const { rel, text } of liveSources()) {
    if (rel.startsWith('src/web/src/') && /\.tsx?$/.test(rel)) surfaces.push([rel, text]);
  }
  const offenders: string[] = [];
  for (const [rel, text] of surfaces) {
    text.split('\n').forEach((line, index) => {
      for (const phrase of LYING_COPY) {
        if (phrase.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'a surface still tells its caller that acceptance criteria are a proposal the owner must '
      + 'approve, while the write lands immediately');
});

test('CLI and MCP say what the write does rather than merely not lying about it', () => {
  // Silence would pass the scan above and still leave a caller guessing. Both doors state the
  // semantics they actually have: the set you send replaces the one in force.
  const mcp = read('src/runner-go/mcp.go');
  const property = mcp.slice(mcp.indexOf('projectCriteriaUpdateProp'));
  assert.match(property.slice(0, property.indexOf('items')), /whole structured replacement/i,
    'the MCP acceptanceCriteriaItems property must say the set is replaced');
  assert.match(mcp, /Sending acceptanceCriteriaItems replaces the criteria in force immediately/,
    'the MCP project_update description must say the write lands immediately');
  const cli = read('src/runner-go/project_cli.go');
  assert.match(cli, /whole-collection replacement/i, 'the CLI help must say the set is replaced');
  assert.match(cli, /\[\] clears the collection/, 'the CLI help must document the clear again');
});

test('0223 is subtraction: it only takes machinery away', () => {
  const sql = removalMigration();
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, /CREATE\s+TYPE/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i, /ALTER\s+TABLE/i]) {
    assert.equal(forbidden.test(sql), false,
      `the removal migration installs ${forbidden} — it must only take machinery away`);
  }
  const ddl = [...sql.matchAll(/^(?:CREATE|ALTER|DROP)(?: OR REPLACE)? [A-Z]+/gm)]
    .map((match) => match[0]);
  assert.deepEqual([...new Set(ddl)].sort(), ['DROP FUNCTION', 'DROP TABLE']);
  assert.doesNotMatch(sql, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');
});

test('0223 cannot reach the ruler it stops protecting', () => {
  const sql = removalMigration();
  // Unit (h)/(i): the ruler's CONTENT is not what is being removed. The migration names no
  // acceptance RELATION in any statement, so no criterion's text or verification_method can move
  // by one byte — a stronger claim than "we did not mean to touch them". The one
  // `project_acceptance_`-prefixed name it does carry is a dropped FUNCTION, 0218's criteria-set
  // digest, whose only callers were inside the decision function dropped beside it.
  for (const line of sql.split('\n')) {
    if (line.trimStart().startsWith('--')) continue;
    for (const table of ACCEPTANCE_TABLES) {
      assert.equal(line.includes(table), false,
        `the removal migration names ${table} in a statement: ${line.trim()}`);
    }
  }
});

test('the removal adds no compose service and no resident process', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services.sort(),
    ['apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web'],
    'the deployment is exactly the services it already had');
  const apiserver = JSON.parse(read('src/apiserver/package.json')) as
    { scripts: Record<string, string> };
  assert.deepEqual(Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'], 'no new long-running entry point');
});

test('the acceptance relations the proposal protected are still installed', () => {
  for (const table of ACCEPTANCE_TABLES) {
    const create = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?[\\s(]`, 'i');
    const drop = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${table}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i');
    const verdict = lastVerdict(create, drop);
    assert.ok(verdict, `${table} is named by no migration`);
    assert.equal(verdict.verdict, 'CREATED', `${table} was dropped by ${verdict.dir}`);
  }
  const gate = lastVerdict(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?project_acceptance_done_gate"?\s*\(/i,
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?project_acceptance_done_gate"?/i,
  );
  assert.ok(gate);
  assert.equal(gate.verdict, 'CREATED', `the DONE gate was dropped by ${gate.dir}`);
});
