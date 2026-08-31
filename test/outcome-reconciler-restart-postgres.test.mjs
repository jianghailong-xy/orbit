// The one-shot PostgreSQL restart the serial full-api partition hands to the specs that assert what
// survives a real server restart. Two properties are load-bearing and neither was covered: the
// container the release DAG provisions has to still be the same cluster afterwards, and the wait
// for it has to fail closed, with evidence, instead of calling a slow server a dead one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const restart = path.join(repo, 'scripts/outcome-reconciler-restart-postgres.sh');
const image = process.env.OUTCOME_RELEASE_DAG_PG_IMAGE ?? 'postgres:16-alpine';
const role = 'pccrd_restart_probe_u';
const password = 'pccrd_disposable_password';
const database = 'pccrd_restart_probe_db';
const pinnedPort = process.env.OUTCOME_RESTART_PROBE_PORT ?? '55493';

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', ...options });

function remove(container) {
  docker(['rm', '-fv', container]);
}

// Exactly the storage, address and identity shape scripts/outcome-reconciler-release-dag-prepare.sh
// provisions, so what this proves is what the release DAG actually runs. `publish` is the one knob:
// the shape it used to have is the argument the old one-shot fixtures pass.
function provision(container, { storage = [], publish = ['127.0.0.1:' + pinnedPort + ':5432'] } = {}) {
  remove(container);
  const created = docker(['run', '-d', '--name', container,
    '--cpus', '1', '--memory', '1024m', '--memory-swap', '1024m', '--pids-limit', '512',
    ...storage,
    '-e', `POSTGRES_USER=${role}`, '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${database}`, '-p', publish[0], image]);
  assert.equal(created.status, 0, created.stderr);
  return container;
}

const publishedPort = (container) =>
  docker(['port', container, '5432/tcp']).stdout.trim();

function psql(container, sql, { database: db = database } = {}) {
  return docker(['exec', '-e', `PGPASSWORD=${password}`, container,
    'psql', '-h', '127.0.0.1', '-U', role, '-d', db, '-tAc', sql]);
}

function awaitReady(container) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (psql(container, 'SELECT 1').status === 0) return;
    execFileSync('sleep', ['1']);
  }
  assert.fail(`${container} never accepted a connection`);
}

function runRestart(container, environment = {}) {
  const startedAt = Date.now();
  const result = spawnSync('bash', [restart, container, role, password, database],
    { encoding: 'utf8', env: { ...process.env, ...environment } });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

test('a restarted release-DAG server is still the same cluster at the same address', () => {
  const container = provision('orbit-restart-probe-survives');
  try {
    awaitReady(container);
    const before = psql(container, 'SELECT system_identifier FROM pg_control_system()').stdout.trim();
    const address = publishedPort(container);
    assert.equal(psql(container,
      'CREATE TABLE moment(named text); INSERT INTO moment VALUES (\'answered\')').status, 0);

    const result = runRestart(container);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    // A real restart, and afterwards the two things the case's own connection string assumes: the
    // same cluster with the row still on it, still reachable where the case was told to find it.
    assert.equal(psql(container, 'SELECT named FROM moment').stdout.trim(), 'answered');
    assert.equal(psql(container, 'SELECT system_identifier FROM pg_control_system()').stdout.trim(),
      before);
    assert.equal(psql(container, 'SELECT current_user').stdout.trim(), role);
    assert.equal(publishedPort(container), address);
  } finally {
    remove(container);
  }
});

test('the one-shot shape loses both the cluster and the address across a restart', () => {
  const container = provision('orbit-restart-probe-oneshot', {
    storage: ['--tmpfs', '/var/lib/postgresql/data:rw,size=512m'],
    publish: ['127.0.0.1::5432'],
  });
  try {
    awaitReady(container);
    const before = psql(container, 'SELECT system_identifier FROM pg_control_system()').stdout.trim();
    const address = publishedPort(container);
    assert.equal(psql(container,
      'CREATE TABLE moment(named text); INSERT INTO moment VALUES (\'answered\')').status, 0);

    assert.equal(docker(['restart', container]).status, 0);
    awaitReady(container);

    // Why prepare-postgres may not hand the serial partition this shape. The tmpfs data directory
    // dies with the container's mount namespace, so the restart comes back as a different, empty
    // cluster: the entrypoint re-creates POSTGRES_USER and POSTGRES_DB by name, which is why the
    // readiness probe has to be a real query, but every SQL-created role, database and row is gone.
    // The ephemeral published port is re-allocated too, so the URL the case holds points at nothing.
    assert.notEqual(psql(container, 'SELECT system_identifier FROM pg_control_system()').stdout.trim(),
      before, 'the one-shot restart unexpectedly kept the same cluster');
    const survivor = psql(container, 'SELECT named FROM moment');
    assert.notEqual(survivor.status, 0, 'the one-shot restart unexpectedly kept the row');
    assert.match(survivor.stderr, /relation "moment" does not exist/u);
    assert.notEqual(publishedPort(container), address,
      'the ephemeral port unexpectedly survived the restart');
  } finally {
    remove(container);
  }
});

test('a server that will not come back fails closed with evidence', () => {
  const container = 'orbit-restart-probe-exits';
  remove(container);
  const created = docker(['run', '-d', '--name', container, '--entrypoint', '/bin/sh', image,
    '-c', 'echo release-dag-probe-marker; exit 9']);
  assert.equal(created.status, 0, created.stderr);
  try {
    const result = runRestart(container);
    assert.notEqual(result.status, 0, 'a container that exits must not be reported ready');
    assert.match(result.stderr, /did not become ready: the container is no longer running/u);
    assert.match(result.stderr, /waited \d+s of a \d+s budget over \d+ probe\(s\)/u);
    assert.match(result.stderr, /container: status=exited running=false restarting=false exit=9/u);
    assert.match(result.stderr, /docker logs --tail 20:/u);
    assert.match(result.stderr, /release-dag-probe-marker/u);
    // Answered from the container's own state, not waited out against the budget.
    assert.ok(result.elapsedMs < 30_000, `fast failure took ${result.elapsedMs}ms`);
  } finally {
    remove(container);
  }
});

test('a server that never accepts a connection is failed at its declared budget', () => {
  const container = 'orbit-restart-probe-silent';
  remove(container);
  const created = docker(['run', '-d', '--name', container, '--entrypoint', '/bin/sh', image,
    '-c', 'echo no-postgres-here; sleep 600']);
  assert.equal(created.status, 0, created.stderr);
  try {
    const result = runRestart(container, { OUTCOME_PG_RESTART_READY_TIMEOUT_SECONDS: '8' });
    assert.notEqual(result.status, 0, 'a server that never answers must not be reported ready');
    assert.match(result.stderr, /did not become ready: it never accepted a connection/u);
    assert.match(result.stderr, /waited \d+s of a 8s budget over \d+ probe\(s\)/u);
    assert.match(result.stderr, /container: status=running running=true restarting=false/u);
    assert.match(result.stderr, /last probe: .*psql/u);
    assert.match(result.stderr, /no-postgres-here/u);
    assert.ok(result.elapsedMs >= 8_000, `gave up after only ${result.elapsedMs}ms`);
  } finally {
    remove(container);
  }
});

test('a server slower than the old fixed sixty-second wait is still accepted', () => {
  const container = 'orbit-restart-probe-slow';
  remove(container);
  // PID 1 is running the whole time, so the container-running precondition holds and only the real
  // connection decides. 65s of it is past the budget this script used to have.
  const created = docker(['run', '-d', '--name', container, '--entrypoint', '/bin/sh',
    '-e', `POSTGRES_USER=${role}`, '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${database}`, '-p', `127.0.0.1:${pinnedPort}:5432`, image,
    '-c', 'sleep 65; exec docker-entrypoint.sh postgres']);
  assert.equal(created.status, 0, created.stderr);
  try {
    const result = runRestart(container);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.elapsedMs > 60_000,
      `the slow start was not actually slower than the old cap: ${result.elapsedMs}ms`);
    assert.equal(psql(container, 'SELECT 1').stdout.trim(), '1');
  } finally {
    remove(container);
  }
});
