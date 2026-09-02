// Nothing may point at what the sidecar removal took away, and everything the apiserver still
// imports must still be there.
//
// Removing the four sidecars from Compose deleted four service names that other files named:
// deployment scripts brought them up, npm aliases launched their processes, .env.example bound
// their SHAs. A deployment path that still names a removed service does not degrade — `docker
// compose up watchdog` exits non-zero and the upgrade stops before it recreates apiserver. The
// mirror-image risk is the shared code that was deliberately KEPT: OutcomeWatchdogModule and
// OutcomeWatchdogService are still imported by AppModule and the runner API, so a later cleanup
// that removes them leaves the main process with dangling imports. Both directions are asserted
// here rather than left to review.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSrc = path.join(repo, 'src/apiserver/src');

const REMOVED_SERVICES = [
  'watchdog', 'outcome-coordinator', 'outcome-coordinator-secondary', 'executable-dead-man',
];
const REMOVED_NPM_ALIASES = ['start:watchdog', 'start:outcome-coordinator'];

function read(relative) {
  return readFileSync(path.join(repo, relative), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Only the `services:` section — the top-level `volumes:` keys sit at the same indentation.
const composeServices = new Set(
  [...(read('docker-compose.yml').match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '')
    .matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((match) => match[1]),
);

/** Service names a Compose invocation in an upgrade script would act on. */
function invokedServices(script) {
  const source = read(script).replace(/\\\n/g, ' ');
  const names = [];
  for (const line of source.split('\n')) {
    const call = line.match(/\$DC (build|pull|up|run|stop|rm)\s+(.*)$/);
    if (!call) continue;
    const [, subcommand, rest] = call;
    for (const token of rest.trim().split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!/^[a-z][a-z0-9_-]*$/.test(token)) break;
      names.push(token);
      // `run SERVICE COMMAND…` names exactly one service; everything after it is the command.
      if (subcommand === 'run') break;
    }
  }
  return names;
}

test('(g) no upgrade path invokes a Compose service that does not exist', () => {
  for (const script of [
    '.claude/skills/upgrade/upgrade.sh',
    '.agents/skills/upgrade/scripts/upgrade.sh',
  ]) {
    const invoked = invokedServices(script);
    assert.ok(invoked.length > 0, `${script} invokes no Compose service at all`);
    for (const name of invoked) {
      assert.ok(composeServices.has(name), `${script} invokes removed/unknown service ${name}`);
    }
  }
});

test('(g) no deployment or configuration file still names a removed service', () => {
  const surfaces = [
    'docker-compose.yml',
    '.claude/skills/upgrade/upgrade.sh',
    '.agents/skills/upgrade/scripts/upgrade.sh',
    '.claude/skills/upgrade/SKILL.md',
    '.agents/skills/upgrade/SKILL.md',
    '.env.example',
  ];
  for (const surface of surfaces) {
    const source = read(surface);
    for (const removed of REMOVED_SERVICES) {
      assert.equal(source.includes(removed), false, `${surface} still names ${removed}`);
    }
  }
  // The two SHAs only the removed watchdog container ever read.
  assert.doesNotMatch(read('.env.example'), /OUTCOME_WATCHDOG_(COLLECTOR|TARGET)_SHA/);
});

test('(g) the removed process launch aliases are gone and unreferenced', () => {
  const scripts = JSON.parse(read('src/apiserver/package.json')).scripts;
  for (const alias of REMOVED_NPM_ALIASES) {
    assert.equal(alias in scripts, false, `${alias} still exists`);
  }
  // `git grep -l` exits 1 on no match, which is exactly the passing case here.
  const search = spawnSync('git', ['grep', '-l', '-F', '-e', REMOVED_NPM_ALIASES[0],
    '-e', REMOVED_NPM_ALIASES[1], '--', ':!test/sidecar-removal-orphans.test.mjs'],
  { cwd: repo, encoding: 'utf8' });
  assert.ok([0, 1].includes(search.status), search.stderr);
  assert.equal(search.stdout.trim(), '', `still referenced by:\n${search.stdout}`);
});

test('(g) every relative import in the apiserver resolves to a file that exists', () => {
  const files = walk(apiSrc);
  assert.ok(files.length > 500, `expected the whole apiserver source tree, saw ${files.length}`);
  const dangling = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(file), specifier);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
        .some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!resolved) dangling.push(`${path.relative(repo, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('(h) nothing still imports the watchdog module the sidecar removal left behind', () => {
  // When the four Compose services went, the watchdog Nest module stayed because the apiserver
  // still imported it. 0221 removed its data layer, so the module went too -- and the two holders
  // must have dropped the import in the same change rather than pointing at a missing file.
  for (const holder of ['src/apiserver/src/app.module.ts',
    'src/apiserver/src/runner-api/runner-api.module.ts']) {
    const source = read(holder);
    assert.doesNotMatch(source, /outcome-watchdog/,
      `${holder} still imports a module the watchdog removal deleted`);
  }
  assert.equal(existsSync(path.join(repo, 'src/apiserver/src/outcome-watchdog')), false);
  assert.equal(existsSync(path.join(repo, 'src/apiserver/src/outcome-coordinator')), false);
});

test('(g) every repository .mjs entry point still parses', () => {
  const entries = readdirSync(path.join(repo, 'scripts'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join('scripts', name));
  assert.ok(entries.length > 20);
  for (const entry of entries) {
    execFileSync(process.execPath, ['--check', path.join(repo, entry)], { cwd: repo });
  }
  for (const entry of ['test/compose-topology.test.mjs', 'test/sidecar-removal-orphans.test.mjs',
    'test/outcome-reconciler-v2.canary.test.mjs']) {
    execFileSync(process.execPath, ['--check', path.join(repo, entry)], { cwd: repo });
  }
});
