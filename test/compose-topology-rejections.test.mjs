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
// NATS's configuration, which the suite pins beside Compose (case (q)); a counterexample may replace it instead.
const NATS_CONF = 'src/link-gateway/nats.conf';
const natsConf = readFileSync(path.join(repo, NATS_CONF), 'utf8');

function replace(before, after) {
  assert.ok(source.includes(before), `counterexample target missing: ${before}`);
  return source.replace(before, after);
}

/** A counterexample in nats.conf: Compose as it is, the configuration changed. */
function replaceConf(before, after) {
  assert.ok(natsConf.includes(before), `counterexample target missing in ${NATS_CONF}: ${before}`);
  return { compose: source, conf: natsConf.replace(before, after) };
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
  // The Docker channel of 2026-10-17: off unless its profile is on, pinned whole, the only holder of the Docker
  // socket; and the apiserver's managed runner switch, off by default, with its directory read-only.
  ['the Docker channel outside its profile', 'the Docker channel is exactly the service the owner allowed',
    replace('    profiles: [managed-runners-docker]\n', '')],
  ['the managed runners profile on another service', 'nothing was added back:',
    replace('  web:\n', '  web:\n    profiles: [managed-runners-docker]\n')],
  ['a port on the Docker channel', 'the Docker channel is exactly the service the owner allowed',
    replace('    network_mode: none\n', '    network_mode: none\n    ports:\n      - "127.0.0.1:2375:2375"\n')],
  ['a privileged Docker channel', 'the Docker channel is exactly the service the owner allowed',
    replace('    network_mode: none\n', '    network_mode: none\n    privileged: true\n')],
  ['the Docker socket given to the apiserver', 'is given to the Docker channel and to no other service',
    replace('      - "${ORBIT_MANAGED_RUNNERS_DIR:-/dev/null}:/var/lib/orbit-managed-runners:ro"',
      '      - "${ORBIT_MANAGED_RUNNERS_DIR:-/dev/null}:/var/lib/orbit-managed-runners:ro"\n      - /var/run/docker.sock:/var/run/docker.sock')],
  ['managed runners on by default', 'nothing beyond the approved configuration was added',
    replace('${ORBIT_MANAGED_RUNNERS_ENABLED:-false}', '${ORBIT_MANAGED_RUNNERS_ENABLED:-true}')],
  ['a writable managed runners directory in the apiserver', 'nothing beyond the approved configuration was added',
    replace('/var/lib/orbit-managed-runners:ro"', '/var/lib/orbit-managed-runners"')],
  ['a Kubernetes template mounted by the Docker channel', 'Compose names nothing of Kubernetes',
    replace('      - /var/run/docker.sock:/var/run/docker.sock\n',
      '      - /var/run/docker.sock:/var/run/docker.sock\n      - ./deploy/managed-runner/storage:/templates:ro\n')],
  // The runner link gateway of 2026-10-25: off unless its profile is on, pinned whole, given the token signing key's
  // public half and never the key itself.
  ['the link gateway outside its profile', 'the runner link gateway is exactly the service',
    replace('    profiles: [runner-link]\n', '')],
  ['the runner link profile on another service', 'nothing was added back:',
    replace('  web:\n', '  web:\n    profiles: [runner-link]\n')],
  ['the token signing key given to the link gateway', 'the link token signing key is given to the apiserver alone',
    replace('      LINK_API_URL: http://apiserver:3000\n',
      '      LINK_API_URL: http://apiserver:3000\n      LINK_SIGNING_KEY: "${RUNNER_LINK_SIGNING_KEY:-}"\n')],
  ['a database for the link gateway', 'the runner link gateway is exactly the service',
    replace('      LINK_API_URL: http://apiserver:3000\n',
      '      LINK_API_URL: http://apiserver:3000\n      DATABASE_URL: "postgresql://orbit:orbit@postgres:5432/orbit?schema=public"\n')],
  ['the link gateway metrics on every interface', 'the runner link gateway is exactly the service',
    replace('      - "127.0.0.1:${RUNNER_LINK_METRICS_PORT:-9464}:9464"', '      - "${RUNNER_LINK_METRICS_PORT:-9464}:9464"')],
  ['a writable root for the link gateway', 'the runner link gateway is exactly the service',
    replace('    stop_grace_period: 90s\n    read_only: true\n', '    stop_grace_period: 90s\n')],
  ['the Docker socket given to the link gateway', 'is given to the Docker channel and to no other service',
    replace('      - "${RUNNER_LINK_GATEWAY_DIR:-/dev/null}:/var/lib/orbit-link-gateway"\n',
      '      - "${RUNNER_LINK_GATEWAY_DIR:-/dev/null}:/var/lib/orbit-link-gateway"\n      - /var/run/docker.sock:/var/run/docker.sock\n')],
  // The runner link's NATS of 2026-10-25 (task B1): off unless the gateway's profile is on, pinned whole, storing nothing,
  // on no port of the host and never reading the image's configuration file; and where the apiserver publishes hints.
  ['NATS outside its profile', "the runner link's NATS is exactly the service",
    replace('  nats:\n    profiles: [runner-link]\n', '  nats:\n')],
  ['JetStream on NATS', "the runner link's NATS is exactly the service",
    replace('    command: ["--config", "/etc/orbit-nats/nats.conf"]\n', '    command: ["--config", "/etc/orbit-nats/nats.conf", "--jetstream"]\n')],
  ["NATS reading the image's configuration file", "the runner link's NATS is exactly the service",
    replace('    command: ["--config", "/etc/orbit-nats/nats.conf"]\n', '    command: ["--config", "/etc/nats/nats-server.conf"]\n')],
  ['a NATS port on the host', "the runner link's NATS is exactly the service",
    replace('    expose:\n      - "4222"\n', '    expose:\n      - "4222"\n    ports:\n      - "4222:4222"\n')],
  ['a store for NATS', "the runner link's NATS is exactly the service",
    replace('    expose:\n      - "4222"\n', '    expose:\n      - "4222"\n    volumes:\n      - ./data/nats:/data\n')],
  ['hints published to another NATS by default', 'nothing beyond the approved configuration was added',
    replace('${RUNNER_LINK_NATS_URL:-nats://nats:4222}', '${RUNNER_LINK_NATS_URL:-nats://elsewhere.example:4222}')],
  ['the hints address given to the wiki worker', 'NATS is named to the apiserver and the link gateway alone',
    replace('      ORBIT_WIKI_MODEL_CONCURRENCY:',
      '      RUNNER_LINK_NATS_URL: "${RUNNER_LINK_NATS_URL:-nats://nats:4222}"\n      ORBIT_WIKI_MODEL_CONCURRENCY:')],
  // The gateway's forwarding of 2026-10-25 (task B4): the listener for runner link calls published nowhere, each NATS seed
  // given to its one client and the users' public keys to NATS alone, and nats.conf pinned line by line.
  ['the runner link listener published on the host', 'nothing beyond the approved configuration was added',
    replace('    expose:\n      - "3000"\n', '    expose:\n      - "3000"\n    ports:\n      - "3001:3001"\n')],
  ['the runner link listener on another port by default', 'nothing beyond the approved configuration was added',
    replace('${RUNNER_LINK_INTERNAL_PORT:-3001}"\n      RUNNER_LINK_INTERNAL_HOST', '${RUNNER_LINK_INTERNAL_PORT:-3002}"\n      RUNNER_LINK_INTERNAL_HOST')],
  ["the gateway's NATS seed given to the apiserver", 'nothing beyond the approved configuration was added',
    replace('${RUNNER_LINK_NATS_APISERVER_SEED:-}', '${RUNNER_LINK_NATS_GATEWAY_SEED:-}')],
  ["the apiserver's NATS seed given to the gateway", 'the runner link gateway is exactly the service',
    replace('      LINK_NATS_SEED: "${RUNNER_LINK_NATS_GATEWAY_SEED:-}"', '      LINK_NATS_SEED: "${RUNNER_LINK_NATS_APISERVER_SEED:-}"')],
  ["a NATS user's key given to the gateway", 'NATS is named to the apiserver and the link gateway alone',
    replace('      LINK_NATS_URL: nats://nats:4222\n', '      LINK_NATS_URL: nats://nats:4222\n      RUNNER_LINK_NATS_GATEWAY_KEY: "${RUNNER_LINK_NATS_GATEWAY_KEY:-}"\n')],
  ['NATS reading a writable configuration', "the runner link's NATS is exactly the service",
    replace('nats.conf:/etc/orbit-nats/nats.conf:ro', 'nats.conf:/etc/orbit-nats/nats.conf')],
  ['a third NATS user', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('  users: [\n', '  users: [\n    { user: monitor, password: monitor }\n')],
  ['a NATS cluster', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('http_port: 8222\n', 'http_port: 8222\ncluster { port: 6222 }\n')],
  ['JetStream in the NATS configuration', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('http_port: 8222\n', 'http_port: 8222\njetstream: enabled\n')],
  ['a gateway allowed to publish hints', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('publish: { allow: ["ses.*.live"] }', 'publish: { allow: ["ses.*.live", "rnr.>"] }')],
  ['an apiserver allowed to publish live streams', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('publish: { allow: ["rnr.>"] }', 'publish: { allow: ["rnr.>", "ses.*.live"] }')],
  ['NATS on another listener', "the runner link's NATS configuration is exactly the one task B4 added",
    replaceConf('port: 4222\n', 'port: 4222\nwebsocket { port: 8080, no_tls: true }\n')],
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
    mkdirSync(path.join(fixture, path.dirname(NATS_CONF)), { recursive: true });
    // A child suite must start its own runner rather than inherit node:test's recursion marker.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (variant) => {
      const { compose, conf } = typeof variant === 'string' ? { compose: variant, conf: natsConf } : variant;
      writeFileSync(path.join(fixture, 'docker-compose.yml'), compose);
      writeFileSync(path.join(fixture, NATS_CONF), conf);
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
