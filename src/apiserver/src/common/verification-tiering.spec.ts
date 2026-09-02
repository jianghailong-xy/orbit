import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The tiers acceptance is spent in, and the things tiering is not allowed to cost.
 *
 * Every task used to run the whole API acceptance: about eight machine-hours in one day, to answer
 * a question a branch run cannot answer. Every red that day appeared AFTER a merge -- the branches
 * were green. So the fast gate moved to the task and the full run moved to the merge boundary.
 *
 * The danger in that trade is obvious and this file is where it is held down: a cheap gate invites
 * somebody to merge on it, and a full run that is now rarer invites somebody to make it smaller.
 * What follows therefore asserts, in both directions, that the gate says what it cannot see and
 * that the full run still runs everything -- including from inside the run itself, which is the
 * only place the second question can be answered honestly.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const API = path.resolve(__dirname, '../..');
const GATE = 'scripts/outcome-reconciler-fast-gate.sh';
const SELECTOR = 'scripts/outcome-reconciler-fast-gate-select.mjs';
const FULL_API = 'scripts/outcome-reconciler-full-api.sh';
const CASE_RUNNER = 'scripts/outcome-reconciler-full-api-standalone-case.sh';
const TIERS = 'docs/verification-tiering.md';

/**
 * Compiled specs on `origin/main` at `db578175`, counted the way the full run counts them:
 * `find src/apiserver/build -mindepth 2 -maxdepth 2 -name '*.spec.js'`. The floor, never a target.
 * The task that introduced tiering was filed when this number was 345; it is measured rather than
 * remembered for that reason.
 */
const SPEC_BASELINE = 360;

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Every spec source the full run compiles into a case, at the depth the run enumerates. */
function specSources(): string[] {
  const specs: string[] = [];
  for (const directory of readdirSync(path.join(API, 'src'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const entry of readdirSync(path.join(API, 'src', directory.name))) {
      if (entry.endsWith('.spec.ts')) specs.push(`${directory.name}/${entry}`);
    }
  }
  return specs.sort();
}

/** The real selector, asked what a change would select. Nothing is mocked; this is the shipped one. */
function select(...changed: string[]): string[] {
  const run = spawnSync(process.execPath, [path.join(ROOT, SELECTOR), ...changed], {
    encoding: 'utf8', cwd: ROOT,
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\n').filter(Boolean);
}

// (a) -------------------------------------------------------------------------------------------
test('(a) the fast gate is a named entry point with the three stages it promises', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert.equal(scripts['test:outcome-reconciler:fast-gate'], `bash ${GATE}`);
  assert.ok(existsSync(path.join(ROOT, GATE)));
  assert.ok(existsSync(path.join(ROOT, SELECTOR)));

  // Asked of the gate rather than read out of it: --dry-run reports the plan and runs nothing.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_')) delete env[key];
  const plan = spawnSync('bash', [path.join(ROOT, GATE), '--dry-run'], {
    encoding: 'utf8', cwd: ROOT, env,
  });
  assert.equal(plan.status, 0, plan.stderr);
  const output = `${plan.stdout}${plan.stderr}`;
  assert.match(output, /fast-gate \[1\/3\]: build orphans/u);
  assert.match(output, /stage 2 would run: tsc -p tsconfig\.test\.json --noEmit/u);
  assert.match(output, /stage 3 would run \d+ spec\(s\)/u);
});

test('(a) the gate delegates its selection to the selector, and the selector follows the change', () => {
  assert.match(read(GATE), new RegExp(SELECTOR.replace(/[.*]/gu, '\\$&')));

  // A changed spec answers for itself.
  assert.deepEqual(select('src/apiserver/src/common/verification-tiering.spec.ts'),
    ['src/apiserver/src/common/verification-tiering.spec.ts']);
  // A changed source file answers through the siblings that exist beside it.
  assert.deepEqual(select('src/apiserver/src/common/db-write-inventory.ts'),
    ['src/apiserver/src/common/db-write-inventory.spec.ts']);
  // A file with no spec beside it selects nothing rather than guessing.
  assert.deepEqual(select('README.md', 'docs/verification-tiering.md', 'package.json'), []);
});

// (b), and the reason it is not enforced ---------------------------------------------------------
test('(b) the gate states its own budget and reports the wall clock it took', () => {
  const gate = read(GATE);
  assert.match(gate, /BUDGET="\$\{ORBIT_FAST_GATE_BUDGET_SECONDS:-90\}"/u);
  assert.match(gate, /PASSED elapsed=\$\{ELAPSED\}s budget=\$\{BUDGET\}s/u);
  // Reported, not enforced. A gate that goes red because the host was busy is a gate people learn
  // to ignore, and this one has to be believed the one time it is right.
  assert.match(gate, /OVER BUDGET/u);
  assert.doesNotMatch(gate, /OVER BUDGET[\s\S]{0,200}exit 1/u);
});

// (f) -------------------------------------------------------------------------------------------
test('(f) the gate cannot stand in for the full run, and says so in its own output', () => {
  const gate = read(GATE);
  assert.match(gate, /It is NOT a merge gate/u);
  assert.match(gate, /npm run test:outcome-reconciler:full-api/u);
  // On the way out of every path, including the failing ones.
  assert.match(gate, /trap announce_boundary EXIT/u);

  // The construction: a change confined to the migration ledger selects no spec whatsoever, so the
  // gate passes it. Dropping the seven completion-ack triggers was exactly this shape and broke
  // twenty-one specs in `sessions/` and `runner-api/`; nothing but the full run finds that.
  const migrations = readdirSync(path.join(API, 'prisma/migrations'))
    .filter((name) => /^\d{4}_/u.test(name)).sort();
  assert.ok(migrations.length > 0);
  const latest = `src/apiserver/prisma/migrations/${migrations[migrations.length - 1]}/migration.sql`;
  assert.ok(existsSync(path.join(ROOT, latest)));
  assert.deepEqual(select(latest), [], 'a migration-only change selects nothing');

  // And even a selected .pg spec is deferred, because it needs the server only the full run
  // provisions -- so the gate structurally cannot answer any question a database answers.
  assert.match(gate,
    /if \[\[ "\$SPEC" == \*\.pg\.spec\.ts \]\]; then DEFERRED\+=\("\$SPEC"\); else RUNNABLE\+=\("\$SPEC"\); fi/u);
  const pgSpecs = specSources().filter((name) => name.endsWith('.pg.spec.ts'));
  assert.ok(pgSpecs.length > 50, `${pgSpecs.length} pg specs are deferred to the full run`);
});

// (d) -------------------------------------------------------------------------------------------
test('(d) the full run still enumerates every spec, unconditionally', () => {
  const full = read(FULL_API);
  // The enumeration itself: a find with no filter in it.
  assert.match(full,
    /mapfile -t SPECS < <\(find "\$API\/build" -mindepth 2 -maxdepth 2 -type f -name '\*\.spec\.js' \| sort\)/u);
  assert.match(full, /\[ "\$\{#SPECS\[@\]\}" -gt 0 \] \|\| \{ echo 'no compiled API specs found'/u);
  // The one narrowing that exists is the single-spec diagnostic mode, and it exits before it can
  // publish a manifest -- so a narrowed run cannot be handed in as an acceptance.
  assert.match(full, /if \[ -n "\$\{OUTCOME_RELEASE_API_SPEC_REGEX:-\}" \]; then\n\s+echo '==> full-api: selected diagnostic specs passed'\n\s+exit 0/u);

  const specs = specSources();
  assert.ok(specs.length >= SPEC_BASELINE,
    `the tree has ${specs.length} specs; the baseline this task started from is ${SPEC_BASELINE}`);

  // Nothing outside the .pg family may register a skip at all, and the .pg skips are all gated on
  // the database URL the full run supplies -- which is why the manifest can demand zero skips.
  const skipping = specs.filter((name) => !name.endsWith('.pg.spec.ts'))
    .filter((name) => /(?:^|[^A-Za-z])(?:test|it|describe|t)\.skip\s*\(|[{,]\s*skip:/u
      .test(readFileSync(path.join(API, 'src', name), 'utf8')));
  assert.deepEqual(skipping, [], 'a spec outside the .pg family registered a skip');
  const manifest = read('scripts/outcome-reconciler-full-api-manifest.mjs');
  for (const zero of ['failed', 'cancelled', 'skipped', 'todo']) {
    assert.match(manifest, new RegExp(`assert\\.equal\\(summary\\.${zero}, 0\\)`),
      `the manifest must still refuse a run with any ${zero} test`);
  }
});

test('(d) this very run enumerated the whole tree, and was not narrowed', () => {
  // Read from the run that is executing this spec. Outside one -- a developer running `npm test`
  // -- there is no such run to make a claim about, and the assertions above are the whole story.
  const total = process.env.OUTCOME_API_CASE_TOTAL;
  if (!total) return;
  assert.ok(Number(total) >= SPEC_BASELINE,
    `this run scheduled ${total} cases against a baseline of ${SPEC_BASELINE}`);
  assert.equal(process.env.OUTCOME_RELEASE_API_SPEC_REGEX, undefined,
    'the diagnostic single-spec mode may not be what an acceptance was run under');
});

// (e) -------------------------------------------------------------------------------------------
test('(e) parallelism is unchanged and every case still gets an identity of its own', () => {
  const full = read(FULL_API);
  assert.match(full, /JOBS="\$\{OUTCOME_RELEASE_API_JOBS:-4\}"/u, 'the default is still four');
  assert.match(full, /\[\[ "\$JOBS" =~ \^\[1-8\]\$ \]\]/u);
  assert.match(full, /xargs -0 -r -n 2 -P "\$JOBS"/u);

  const runner = read(CASE_RUNNER);
  // One database, one empty database and one role per case, named from the case index, and read
  // back through the case role before the spec is allowed to mutate anything.
  assert.match(runner, /STEM="\$\{OUTCOME_API_CASE_PREFIX\}_c\$\(printf '%04d' "\$INDEX"\)"/u);
  assert.match(runner, /CASE_DB="\$\{STEM\}_d"/u);
  assert.match(runner, /EMPTY_DB="\$\{STEM\}_e"/u);
  assert.match(runner, /CASE_ROLE="\$\{STEM\}_u"/u);
  assert.match(runner, /\[ "\$IDENTITY_DATABASE" = "\$CASE_DB" \]/u);
  assert.match(runner, /\[ "\$leftovers" = 0 \] \|\| cleanup_rc=1/u);
});

test('(e) this very case is running under an identity of its own', () => {
  const url = process.env.DATABASE_URL;
  const empty = process.env.ORBIT_TEST_PG_URL;
  if (!process.env.OUTCOME_API_CASE_TOTAL || !url || !empty) return;
  const identity = /^postgresql:\/\/(pcc[0-9a-z]*_c(\d{4})_u):[^@]*@[^/]+\/(pcc[0-9a-z]*_c\d{4}_d)$/u
    .exec(url);
  assert.ok(identity, `this case's database URL is not a per-case pcc* identity: ${url}`);
  assert.equal(identity[3], `${process.env.OUTCOME_API_CASE_PREFIX}_c${identity[2]}_d`);
  assert.equal(identity[1], `${process.env.OUTCOME_API_CASE_PREFIX}_c${identity[2]}_u`);
  assert.ok(empty.endsWith(`_c${identity[2]}_e`), 'the empty database belongs to this case too');
});

// (g), (h), (i) -----------------------------------------------------------------------------------
test('(g) a failure is published while the run is still going, and does not stop it', () => {
  const full = read(FULL_API);
  // A path that outlives the case directory, emptied at the start of the run and handed to every
  // case: this is the only place a failure can be read WHILE the run is going.
  assert.match(full, /FAILURES="\$BUILD\/outcome-reconciler-full-api-failures\.log"/u);
  assert.match(full, /: > "\$FAILURES"\nexport OUTCOME_API_CASE_FAILURE_LOG="\$FAILURES"/u);
  assert.match(full, /the run does not stop at the first one/u);
  assert.match(full, /case\(s\) failed, in the order they failed:/u);

  // Neither stage stops at a failing case: the parallel one reads xargs' status after the whole
  // pipeline, and the serial one records the failure and goes on to the next case.
  assert.match(full, /PARALLEL_RC=\$\{PIPESTATUS\[1\]\}\n\s+set -e\n\s+\[ "\$PARALLEL_RC" = 0 \] \|\| TEST_RC=1/u);
  assert.match(full, /if ! "\$REPO\/scripts\/outcome-reconciler-full-api-standalone-case\.sh" \\\n[^\n]*\n\s+TEST_RC=1\n\s+fi/u);

  // What the line has to carry to be worth publishing early.
  assert.match(read(CASE_RUNNER),
    /printf '%s \[%s\/%s\] %s %s exit=%s elapsed=%ss\\n'/u);
});

test('(h) the case runner keeps the inner TAP, and (i) says something when there is none', () => {
  const runner = read(CASE_RUNNER);
  // Inherited NODE_TEST_* makes a nested runner report to a listener that is not there: empty
  // output and exit 0. That is a false green, so it is dropped here rather than at each call site.
  assert.match(runner, /for NAME in "\$\{!NODE_TEST_@\}"; do unset "\$NAME"; done/u);
  assert.match(runner, /sed -n '\/\^not ok\/,\$p' "\$LOG" >&2/u);
  assert.match(runner, /full-api NO TAP \[\$INDEX\/\$OUTCOME_API_CASE_TOTAL\]/u);
  assert.match(runner, /echo "exit=\$SPEC_RC elapsed=\$\{SPEC_ELAPSED\}s timeout=\$OUTCOME_API_CASE_TIMEOUT kind=\$SPEC_KIND" >&2/u);
  // The four endings that all used to arrive as one unexplained non-zero.
  for (const kind of ['COMPLETED', 'TIMED_OUT', 'SIGNALED', 'SPEC_FAILED', 'CRASHED_BEFORE_TAP']) {
    assert.match(runner, new RegExp(`echo ${kind}`));
  }
  // Driven for real, against the real script, next door.
  assert.ok(existsSync(path.join(API, 'src/common/full-api-case-diagnostics.spec.ts')));
});

// (j), (k) ----------------------------------------------------------------------------------------
test('(j) the tiers are written down, and say the full run still happens before a merge', () => {
  const tiers = read(TIERS);
  assert.match(tiers, /Fast gate/u);
  assert.match(tiers, /≤ 90s/u);
  assert.match(tiers, /Once at the merge boundary\*\*, by whoever merges — not once per task/u);
  assert.match(tiers, /Before merging, run the full acceptance once/u);
  assert.match(tiers, /The fast gate is not a merge gate/u);
  assert.match(tiers, /npm run test:outcome-reconciler:release-dag/u);
  // Tiering changes when the full run happens, not how much of it runs.
  assert.match(tiers, /The case count never goes down/u);
  assert.match(tiers, /Parallelism stays at 4/u);
});

test('(k) the tiers forbid measuring a subtraction with a branch diff', () => {
  const tiers = read(TIERS);
  assert.match(tiers, /may not be measured with `git diff main\.\.HEAD`/u);
  assert.match(tiers, /after the merge it is 0\/0 forever/u);
  assert.match(tiers, /The baseline has to be content, not a revision/u);
  assert.match(tiers, /retired/u);
  assert.match(tiers, /spent/u);
});

// (l) ----------------------------------------------------------------------------------------------
test('(l) tiering added no service and nothing that keeps running', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map((match) => match[1]);
  assert.deepEqual(services.sort(),
    ['apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web']);

  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert.equal(Object.keys(scripts).some((name) => /daemon|worker|cron|watch/iu.test(name)), false);

  // The gate starts nothing it does not wait for, and leaves nothing behind it.
  const gate = read(GATE);
  for (const resident of [/\bnohup\b/u, /\bsetsid\b/u, /\bdisown\b/u, /docker run/u, /&\s*$/mu]) {
    assert.doesNotMatch(gate, resident, `the fast gate must not start anything resident`);
  }
  assert.doesNotMatch(gate, /systemd|pm2|forever/u);
});
