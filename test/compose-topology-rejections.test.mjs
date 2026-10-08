// Run the real topology suite against mutated Compose files in a disposable local clone. The
// source checkout is only read; expectations still come from the suite's fixed historical pins.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');

function replace(before, after) {
  assert.ok(source.includes(before), `counterexample target missing: ${before}`);
  return source.replace(before, after);
}

const cases = [
  ['a sixth resident service', 'Compose declares exactly the five surviving services',
    replace('\nvolumes:', '\n  observer:\n    image: alpine:3\n    restart: unless-stopped\n\nvolumes:')],
  ...['watchdog', 'outcome-coordinator', 'outcome-coordinator-secondary', 'executable-dead-man']
    .map((name) => [`removed sidecar ${name}`, 'no removed sidecar is named anywhere in Compose',
      replace('\nvolumes:', `\n  ${name}:\n    image: alpine:3\n\nvolumes:`)]),
  ['a one-shot profile', 'nothing was added back:',
    replace('  web:\n', '  web:\n    profiles: [observer]\n')],
  ['a new restart policy', 'nothing was added back:',
    replace('    container_name: orbit-web\n    restart: unless-stopped',
      '    container_name: orbit-web\n    restart: always')],
  ...[
    ['./data/postgres:/var/lib/postgresql/data', './data/empty:/var/lib/postgresql/data'],
    ['./data/pg-archive:/archive', './data/empty-archive:/archive'],
    ['shared_preload_libraries=pg_stat_statements', 'shared_preload_libraries='],
    ['pg_stat_statements.max=10000', 'pg_stat_statements.max=20000'],
    ['pg_stat_statements.track=top', 'pg_stat_statements.track=all'],
    ['log_temp_files=1024', 'log_temp_files=0'],
    ['statement_timeout=300s', 'statement_timeout=0'],
    ['lock_timeout=30s', 'lock_timeout=0'],
    ['idle_in_transaction_session_timeout=300s', 'idle_in_transaction_session_timeout=0'],
    ['      - wal_compression=on', '      - wal_compression=on\n      - -c\n      - shared_buffers=1GB'],
  ].map(([before, after]) => [`postgres change: ${before}`, 'the postgres service definition',
    replace(before, after)]),
  ['gateway config mount change', 'the gateway service definition',
    replace('./gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro',
      './gateway/other.conf:/etc/nginx/conf.d/default.conf:ro')],
  ['gateway command addition', 'the gateway service definition',
    replace('  gateway:\n', '  gateway:\n    command: [sh, -c, "nginx & sleep infinity"]\n')],
  ...['pgbackup', 'apiserver', 'web'].map((name) => [`resident command inside ${name}`,
    'nothing beyond the approved configuration was added',
    replace(`  ${name}:\n`, `  ${name}:\n    command: [sh, -c, "sleep infinity"]\n`)]),
  ['an unreviewed apiserver env', 'nothing beyond the approved configuration was added',
    replace('      PORT: "3000"', '      OBSERVER_ENABLED: "1"\n      PORT: "3000"')],
  ...[
    ['${ORBIT_WATCHES_MODE:-on}', '${ORBIT_WATCHES:-on}'],
    ['${ORBIT_WIKI_MODE:-on}', '${ORBIT_WIKI:-on}'],
    ['      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:2086}"',
      '      PUBLIC_ORIGIN: "https://other.example"'],
    ['      ORBIT_WIKI: "${ORBIT_WIKI_MODE:-on}"',
      '      ORBIT_WIKI: "${ORBIT_WIKI_MODE:-on}"\n      ORBIT_WIKI: "off"'],
  ].map(([before, after]) => [`changed env: ${before}`,
    'nothing beyond the approved configuration was added', replace(before, after)]),
  ...[
    ['FCM_PROJECT_ID', ''],
    ['FCM_CLIENT_EMAIL', ''],
    ['FCM_PRIVATE_KEY', ''],
    ['FCM_ANDROID_PACKAGE', 'io.orbitd.android'],
  ].flatMap(([name, fallback]) => {
    const line = `      ${name}: "\${${name}:-${fallback}}"`;
    const guard = 'nothing beyond the approved configuration was added';
    return [
      [`changed FCM value: ${name}`, guard,
        replace(line, `      ${name}: "\${${name}:-unapproved}"`)],
      [`duplicate FCM env: ${name}`, guard, replace(line, `${line}\n${line}`)],
    ];
  }),
  ['an unapproved FCM env', 'nothing beyond the approved configuration was added',
    replace('      FCM_PROJECT_ID:', '      FCM_UNAPPROVED: "1"\n      FCM_PROJECT_ID:')],
  // The wiki worker the owner added on 2026-10-07: pinned whole, and the only holder of the model's key.
  ['a port on the wiki worker', 'the wiki worker is exactly the service the owner approved',
    replace('    command: node src/apiserver/dist/wiki-worker/main.js\n',
      '    command: node src/apiserver/dist/wiki-worker/main.js\n    ports:\n      - "3001:3001"\n')],
  ['a mount on the wiki worker', 'the wiki worker is exactly the service the owner approved',
    replace('    command: node src/apiserver/dist/wiki-worker/main.js\n',
      '    command: node src/apiserver/dist/wiki-worker/main.js\n    volumes:\n      - ./data:/data\n')],
  ['the System model key given to the apiserver', 'are given to the wiki worker and to no other service',
    replace('      PORT: "3000"', '      ORBIT_WIKI_MODEL_API_KEY: "${ORBIT_WIKI_MODEL_API_KEY:-}"\n      PORT: "3000"')],
];

test('the topology checks accept the control and reject deployment counterexamples', async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'orbit-compose-topology-'));
  const fixture = path.join(temporary, 'repo');
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, fixture]);
    execFileSync('git', ['reset', '--quiet', 'HEAD'], { cwd: fixture });
    mkdirSync(path.join(fixture, 'test'));
    copyFileSync(path.join(repo, 'test/compose-topology.test.mjs'),
      path.join(fixture, 'test/compose-topology.test.mjs'));
    // A child suite must start its own runner rather than inherit node:test's recursion marker.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (compose) => {
      writeFileSync(path.join(fixture, 'docker-compose.yml'), compose);
      const result = spawnSync(process.execPath,
        ['--test', '--test-reporter=tap', 'test/compose-topology.test.mjs'],
        { cwd: fixture, encoding: 'utf8', env });
      assert.ifError(result.error);
      return result;
    };
    await t.test('unchanged Compose passes all topology assertions', () => {
      const result = run(source);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# fail 0\n/);
    });
    for (const [name, guard, compose] of cases) {
      await t.test(`rejects ${name}`, () => {
        const result = run(compose);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(result.stdout.split('\n').some((line) =>
          line.startsWith('not ok ') && line.includes(guard)), result.stdout + result.stderr);
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
