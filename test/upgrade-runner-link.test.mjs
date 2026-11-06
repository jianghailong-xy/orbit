// What scripts/install-server.sh and both copies of /upgrade's script do for the runner link (task 34sREuYT2DCEXiW6qZuOh;
// docs/self-hosting.md, "Runner link"; the owner's decision of 2026-11-05: a default install and an upgrade bring the link
// up before task D2 deletes the HTTPS work path). Each case runs the real scripts in a throwaway Git checkout, with a fake
// `docker` first on PATH that records every call and answers as a host would. The real Compose renders docker-compose.yml
// in the last cases, where it is installed. The real installs and upgrades are the task's drills.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const UPGRADES = ['.claude/skills/upgrade/upgrade.sh', '.agents/skills/upgrade/scripts/upgrade.sh'];
const INSTALL = 'scripts/install-server.sh';
const COPIED = [
  ...UPGRADES, INSTALL, '.env.example', '.gitignore', 'docker-compose.yml', 'gateway/nginx.conf', 'scripts/pg-backup.sh',
  'scripts/runner-link/door-check.js', 'deploy/runner-link/behind-web-gateway.env',
];
const SECRET_NAMES = [
  'SIGNING_KEY', 'PUBLIC_KEY', 'GATEWAY_TOKEN', 'NATS_APISERVER_SEED', 'NATS_APISERVER_KEY', 'NATS_GATEWAY_SEED', 'NATS_GATEWAY_KEY',
];
const secretValue = (name) => `fixture-secret-value-${name}`;
const LINK_ONLY_GUARD = 'RUNNER_LINK_SIGNING_KEY: "${RUNNER_LINK_SIGNING_KEY:?this build serves runners only over the runner link}"';

// The fake host. FAKE_FAIL fails a call that matches it; the rest is what a host with this deployment on it answers.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ -n "${'$'}{FAKE_FAIL:-}" ] && [[ "$*" == $FAKE_FAIL ]]; then echo "fake docker: failing $*" >&2; exit 1; fi
case "$*" in
  "compose version") echo "Docker Compose version v5.0.0" ;;
  "compose config --services")
    if grep -F 'RUNNER_LINK_SIGNING_KEY:?' docker-compose.yml >/dev/null && ! grep -E '^RUNNER_LINK_SIGNING_KEY=' .env >/dev/null; then
      echo "required variable RUNNER_LINK_SIGNING_KEY is missing a value" >&2; exit 1
    fi
    echo postgres; echo apiserver; echo wiki-worker; echo web; echo gateway; echo pgbackup ;;
  "compose config postgres") echo '    container_name: orbit-postgres' ;;
  "inspect --format {{range .Mounts}}"*" orbit-postgres") echo "$PWD/data/pg-archive" ;;
  "inspect --format {{.Image}} orbit-web") exit 1 ;;
  "compose ps -q pgbackup") echo pgbackup-0 ;;
  "exec pgbackup-0 cat /usr/local/bin/pg-backup.sh") cat scripts/pg-backup.sh ;;
  "compose ps -q gateway") echo gateway-0 ;;
  "exec gateway-0 cat /etc/nginx/conf.d/default.conf") cat "${'$'}{FAKE_RUNNING_NGINX:-gateway/nginx.conf}" ;;
  "compose ps -q link-gateway") [ -z "${'$'}{FAKE_LINK_GATEWAY_DOWN:-}" ] && echo link-gateway-0 ;;
  "inspect -f {{with index .State \"Health\"}}{{.Status}}{{end}} link-gateway-0") echo "${'$'}{FAKE_LINK_GATEWAY_HEALTH:-healthy}" ;;
  "build --help") echo '      --provenance string' ;;
  "run --rm --network none "*" orbit-link-gateway:local secrets")
    if [ -n "${'$'}{FAKE_SECRETS_GARBAGE:-}" ]; then echo "not secrets"; exit 0; fi
    for name in ${SECRET_NAMES.join(' ')}; do echo "RUNNER_LINK_$name=\"fixture-secret-value-$name\""; done ;;
  "compose run --rm --no-deps -T apiserver node - http://gateway/runner-link") echo "${'$'}{FAKE_DOOR_GATEWAY:-401 UNAUTHENTICATED}" ;;
  "compose run --rm --no-deps -T apiserver node - "*) echo "${'$'}{FAKE_DOOR_ORIGIN:-401 UNAUTHENTICATED}" ;;
  "compose logs --tail=20 nats link-gateway") echo "fixture log line of the link" ;;
  "image inspect -f {{.Id}} "*) echo "sha256:${'a'.repeat(64)}" ;;
  "info --format {{json .SecurityOptions}}") echo '["name=seccomp,profile=builtin"]' ;;
  "info --format {{with .FirewallBackend}}{{.Driver}}{{end}}") echo iptables ;;
  "network inspect -f {{index .Options \"com.docker.network.bridge.enable_icc\"}} "*) echo false ;;
  "network inspect -f {{range .IPAM.Config}}{{.Gateway}} {{end}} "*) echo "172.30.0.1 " ;;
  "network inspect -f {{.EnableIPv6}} "*) echo false ;;
  "network inspect -f {{with index .Options \"com.docker.network.bridge.name\"}}{{.}}{{else}}br-{{printf \"%.12s\" .Id}}{{end}} "*) echo br-0123456789ab ;;
  "run --rm --network host "*" orbit-managed-runner-firewall:local preflight") echo '{"backend": "nft", "ipv6": "present", "iptables": "iptables v1.8.13"}' ;;
  "run --rm --network host "*" orbit-managed-runner-firewall:local apply "*) echo '{"backend": "nft", "enforced": true, "problems": [], "written": ["IPv4", "IPv6"]}' ;;
  "run --rm --network orbit-managed-runners "*" orbit-managed-runner-firewall:local docker-dns") echo '[]' ;;
  "network inspect "*) [ -e "$FAKE_DOCKER_LOG.network" ] || exit 1 ;;
  "network create "*) : >"$FAKE_DOCKER_LOG.network" ;;
esac
exit 0
`;

function git(fixture, ...args) {
  return execFileSync('git', args, { cwd: fixture.checkout, env: fixture.env, encoding: 'utf8' }).trim();
}

function makeFixture(t, { linkOnly = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orbit-upgrade-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'orbit');
  for (const relative of COPIED) {
    mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
    copyFileSync(path.join(repo, relative), path.join(checkout, relative));
  }
  // The Dockerfile's context for the commit that names the link gateway's image.
  mkdirSync(path.join(checkout, 'src/link-gateway'), { recursive: true });
  writeFileSync(path.join(checkout, 'src/link-gateway/Dockerfile'), 'FROM scratch\n');
  // Both kinds of build, whichever this repository's docker-compose.yml is now.
  const compose = path.join(checkout, 'docker-compose.yml');
  const signingKey = /RUNNER_LINK_SIGNING_KEY: "\$\{RUNNER_LINK_SIGNING_KEY:[-?][^"]*"/;
  const text = readFileSync(compose, 'utf8');
  assert.match(text, signingKey);
  writeFileSync(compose, text.replace(signingKey, linkOnly ? LINK_ONLY_GUARD : 'RUNNER_LINK_SIGNING_KEY: "${RUNNER_LINK_SIGNING_KEY:-}"'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const log = path.join(root, 'docker.log');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ORBIT_|COMPOSE_|GIT_|RUNNER_LINK_)/.test(name))),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CEILING_DIRECTORIES: root,
  };
  const fixture = { root, checkout, env, log };
  git(fixture, 'init', '-q', '--initial-branch=orbit-fixture');
  git(fixture, 'add', '.');
  git(fixture, 'commit', '-q', '-m', 'fixture');
  fixture.envFile = path.join(checkout, '.env');
  fixture.run = (script, args = [], extra = {}) => {
    writeFileSync(log, '');
    const result = spawnSync(path.join(checkout, script), args, {
      cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  fixture.calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return fixture;
}

const BEFORE_LINK = 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nPUBLIC_ORIGIN="http://10.66.82.117:2086"\n';
// A deployment shaped like production's: its own host name, ACME on 443, its own seeds.
const PRODUCTION_SHAPED = `JWT_SECRET="kept"
PROVIDER_SECRET_KEY="kept too"
PUBLIC_ORIGIN="https://orbit.example.com"
COMPOSE_PROFILES=runner-link
RUNNER_LINK_URL="wss://link.orbit.example.com"
RUNNER_LINK_PORT=443
RUNNER_LINK_GATEWAY_DIR=/srv/orbit/link-gateway
RUNNER_LINK_ACME_DOMAINS=link.orbit.example.com
RUNNER_LINK_ACME_EMAIL=ops@example.com
${SECRET_NAMES.map((name) => `RUNNER_LINK_${name}="production-${name}"`).join('\n')}
`;

const indexOfCall = (calls, match) => {
  const at = calls.findIndex((call) => (match instanceof RegExp ? match.test(call) : call.includes(match)));
  assert.ok(at >= 0, `no call matches ${match}:\n${calls.join('\n')}`);
  return at;
};
const LINK_BUILD = /^build .*-t orbit-link-gateway:local src\/link-gateway$/;
const LINK_SECRETS = 'orbit-link-gateway:local secrets';
const LINK_UP = /^compose up -d --wait --wait-timeout 180 --no-deps nats link-gateway$/;
const APISERVER_UP = /^compose up -d --wait (--no-deps )?apiserver wiki-worker web gateway$/;
const IMAGES_BUILD = /^compose build .*apiserver wiki-worker web/;
const DOOR_GATEWAY = 'node - http://gateway/runner-link';
const WEB_GATEWAY_RECREATE = 'compose up -d --wait --no-deps --force-recreate gateway';

function assertNoSecretShown(fixture, run) {
  for (const name of SECRET_NAMES) {
    assert.ok(!run.output.includes(secretValue(name)), `${name} was printed`);
    assert.ok(!readFileSync(fixture.log, 'utf8').includes(secretValue(name)), `${name} was in a docker call's arguments`);
  }
}

for (const upgrade of UPGRADES) {
  test(`${upgrade}: a deployment with no link gains its lines at the end of .env, every line before them as it was, and nothing secret is shown`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, BEFORE_LINK, { mode: 0o640 });
    chmodSync(fixture.envFile, 0o640);
    const inode = statSync(fixture.envFile).ino;
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    assertNoSecretShown(fixture, run);

    const after = readFileSync(fixture.envFile, 'utf8');
    assert.ok(after.startsWith(BEFORE_LINK), 'what .env held comes first, byte for byte');
    assert.equal(statSync(fixture.envFile).ino, inode, 'appended, not replaced');
    assert.equal(statSync(fixture.envFile).mode & 0o777, 0o640, 'its mode is as it was');
    const added = after.slice(BEFORE_LINK.length).split('\n').filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(added, [
      'RUNNER_LINK_URL=same-origin',
      'RUNNER_LINK_ENV_FILE=./deploy/runner-link/behind-web-gateway.env',
      'RUNNER_LINK_BIND=127.0.0.1',
      'RUNNER_LINK_PORT=0',
      'RUNNER_LINK_METRICS_PORT=0',
      ...SECRET_NAMES.map((name) => `RUNNER_LINK_${name}="${secretValue(name)}"`),
      'COMPOSE_PROFILES=runner-link',
    ]);

    // The image makes the secrets, in no network and with no privilege; the link comes up before the apiserver is recreated.
    const calls = fixture.calls();
    assert.ok(calls.some((call) => call.includes('--network none --read-only --cap-drop ALL --security-opt no-new-privileges orbit-link-gateway:local secrets')));
    const order = [LINK_BUILD, LINK_SECRETS, IMAGES_BUILD, LINK_UP, DOOR_GATEWAY, 'node - http://10.66.82.117:2086/runner-link', APISERVER_UP]
      .map((match) => indexOfCall(calls, match));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `in this order:\n${calls.join('\n')}`);

    // It reports the plain link once, and that it is done.
    assert.match(run.stderr, /warning: this deployment's address is plain http, so its runner link is plain ws:\/\//);
    assert.equal(run.output.match(/address is plain http/g).length, 1);
    assert.match(run.stdout, /✓ Upgrade complete/);
  });

  test(`${upgrade}: an existing COMPOSE_PROFILES line stays, a later one adds runner-link, and an unended last line is only ended`, (t) => {
    const fixture = makeFixture(t);
    const before = 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nCOMPOSE_PROFILES=a,b\nPUBLIC_ORIGIN="https://orbit.example.com"';
    writeFileSync(fixture.envFile, before);
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    const after = readFileSync(fixture.envFile, 'utf8');
    assert.ok(after.startsWith(`${before}\n`), 'what .env held comes first, its last line ended');
    assert.deepEqual(after.split('\n').filter((line) => line.startsWith('COMPOSE_PROFILES=')), ['COMPOSE_PROFILES=a,b', 'COMPOSE_PROFILES=a,b,runner-link']);
    assert.ok(!run.output.includes('plain http'), 'an https origin is not warned about');
  });

  test(`${upgrade}: a second upgrade writes nothing to .env and makes no new secret`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, BEFORE_LINK);
    assert.equal(fixture.run(upgrade, ['--no-pull']).status, 0);
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(fixture.envFile, old, old);
    const before = { bytes: readFileSync(fixture.envFile), inode: statSync(fixture.envFile).ino, mtime: statSync(fixture.envFile).mtimeMs };
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readFileSync(fixture.envFile), before.bytes);
    assert.equal(statSync(fixture.envFile).ino, before.inode);
    assert.equal(statSync(fixture.envFile).mtimeMs, before.mtime, '.env was not written');
    const calls = fixture.calls();
    assert.ok(!calls.some((call) => call.includes(LINK_SECRETS)));
    indexOfCall(calls, LINK_BUILD);
    indexOfCall(calls, LINK_UP);
    assertNoSecretShown(fixture, run);
  });

  test(`${upgrade}: a deployment shaped like production's: .env's inode, mtime and bytes stay, and no call builds or starts its link`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, PRODUCTION_SHAPED, { mode: 0o600 });
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(fixture.envFile, old, old);
    const inode = statSync(fixture.envFile).ino;
    const mtime = statSync(fixture.envFile).mtimeMs;
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    assert.equal(statSync(fixture.envFile).ino, inode, 'the inode');
    assert.equal(statSync(fixture.envFile).mtimeMs, mtime, 'the mtime');
    assert.equal(readFileSync(fixture.envFile, 'utf8'), PRODUCTION_SHAPED, 'the bytes');
    const calls = fixture.calls();
    // It is looked at, and that is all.
    assert.deepEqual(calls.filter((call) => /link-gateway|nats|secrets/.test(call)), [
      'compose ps -q link-gateway',
      'inspect -f {{with index .State "Health"}}{{.Status}}{{end}} link-gateway-0',
    ]);
    assert.match(run.stdout, /Runner link: this deployment's own; \.env and the link gateway are left as they are/);
    assert.ok(!run.output.includes('production-'), 'no value of its .env is shown');
    assert.ok(!run.output.includes('plain http'));
  });

  test(`${upgrade}: an operator's own link, unfinished or down, is said by name, never by value, and nothing is changed`, (t) => {
    for (const [body, extra, said] of [
      ['COMPOSE_PROFILES=runner-link\n', {}, /no value for: RUNNER_LINK_SIGNING_KEY RUNNER_LINK_URL/],
      ['RUNNER_LINK_SIGNING_KEY="production-signing"\n', {}, /no value for: RUNNER_LINK_URL RUNNER_LINK_GATEWAY_TOKEN .* COMPOSE_PROFILES\(runner-link\)/],
      [PRODUCTION_SHAPED, { FAKE_LINK_GATEWAY_DOWN: '1' }, /link-gateway is not running/],
      [PRODUCTION_SHAPED, { FAKE_LINK_GATEWAY_HEALTH: 'unhealthy' }, /link-gateway is unhealthy/],
    ]) {
      const fixture = makeFixture(t);
      const text = `${BEFORE_LINK}${body}`;
      writeFileSync(fixture.envFile, text);
      const run = fixture.run(upgrade, ['--no-pull'], extra);
      assert.equal(run.status, 0, run.output);
      assert.match(run.stderr, said);
      assert.equal(readFileSync(fixture.envFile, 'utf8'), text);
      assert.ok(!run.output.includes('production-'));
      assert.ok(!fixture.calls().some((call) => LINK_BUILD.test(call) || LINK_UP.test(call)));
    }
  });

  test(`${upgrade}: a .env written with CRLF line ends keeps them, and gains a profile line Compose reads`, (t) => {
    const fixture = makeFixture(t);
    const before = 'JWT_SECRET="kept"\r\nPROVIDER_SECRET_KEY="kept too"\r\nCOMPOSE_PROFILES=a\r\n';
    writeFileSync(fixture.envFile, before);
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    const after = readFileSync(fixture.envFile, 'utf8');
    assert.ok(after.startsWith(before));
    assert.match(after, /\nCOMPOSE_PROFILES=a,runner-link\n/);
    // And the next run finds what this one wrote.
    assert.equal(fixture.run(upgrade, ['--no-pull']).status, 0);
    assert.equal(readFileSync(fixture.envFile, 'utf8'), after);
  });

  test(`${upgrade}: a same-origin link whose profile was taken out by hand is left off, with a warning`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, BEFORE_LINK);
    assert.equal(fixture.run(upgrade, ['--no-pull']).status, 0);
    const off = readFileSync(fixture.envFile, 'utf8').replace(/\nCOMPOSE_PROFILES=runner-link\n/, '\n');
    writeFileSync(fixture.envFile, off);
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stderr, /warning: this deployment set up its own link, and \.env has no value for: COMPOSE_PROFILES\(runner-link\)/);
    assert.equal(readFileSync(fixture.envFile, 'utf8'), off);
    assert.ok(!fixture.calls().some((call) => LINK_BUILD.test(call) || LINK_UP.test(call)));
    assertNoSecretShown(fixture, run);
  });

  test(`${upgrade}: a name set empty is not a link, and a name exported in the shell is an operator's`, (t) => {
    const empty = makeFixture(t);
    writeFileSync(empty.envFile, `${BEFORE_LINK}RUNNER_LINK_URL=\nRUNNER_LINK_SIGNING_KEY=""\n`);
    assert.equal(empty.run(upgrade, ['--no-pull']).status, 0);
    assert.match(readFileSync(empty.envFile, 'utf8'), /\nRUNNER_LINK_URL=same-origin\n/);
    const exported = makeFixture(t);
    writeFileSync(exported.envFile, BEFORE_LINK);
    const run = exported.run(upgrade, ['--no-pull'], { RUNNER_LINK_URL: 'wss://link.example.test' });
    assert.equal(run.status, 0, run.output);
    assert.equal(readFileSync(exported.envFile, 'utf8'), BEFORE_LINK);
  });

  for (const [what, extra, said, wrote] of [
    ['its image does not build', { FAKE_FAIL: 'build * src/link-gateway' }, /its image did not build/, false],
    ['its image makes no secrets', { FAKE_FAIL: 'run * secrets' }, /did not make the link's secrets/, false],
    ['its image makes something else', { FAKE_SECRETS_GARBAGE: '1' }, /something other than the link's seven secrets/, false],
    ['nats or the gateway stays down', { FAKE_FAIL: 'compose up * nats link-gateway' }, /nats or link-gateway did not come up within 3 minutes/, true],
    ['the web gateway does not reach it', { FAKE_DOOR_GATEWAY: '502' }, /the web gateway's \/runner-link answered: 502/, true],
    ['a proxy in front drops upgrades', { FAKE_DOOR_ORIGIN: '426 WEBSOCKET_REQUIRED' }, /http:\/\/10\.66\.82\.117:2086\/runner-link answered: 426 WEBSOCKET_REQUIRED.*pass WebSocket upgrades/, true],
  ]) {
    test(`${upgrade}: before the link-only build, when ${what}: everything else is upgraded, it says why last, and it exits non-zero`, (t) => {
      const fixture = makeFixture(t);
      writeFileSync(fixture.envFile, BEFORE_LINK);
      const run = fixture.run(upgrade, ['--no-pull'], extra);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, said);
      assert.match(run.stderr, /!!  The runner link is NOT working/);
      assert.match(run.stderr, /This deployment keeps working: everything else was upgraded, and its runners stay on HTTPS/);
      assert.match(run.stderr, /✗ The upgrade finished, and the runner link is not working/);
      assert.ok(!run.output.includes('✓ Upgrade complete'));
      indexOfCall(fixture.calls(), APISERVER_UP);
      assert.equal(readFileSync(fixture.envFile, 'utf8').includes('RUNNER_LINK_URL=same-origin'), wrote);
      assertNoSecretShown(fixture, run);
      // The next run finds what this one wrote, and makes no new secret.
      const text = readFileSync(fixture.envFile, 'utf8');
      const next = fixture.run(upgrade, ['--no-pull']);
      assert.equal(next.status, 0, next.output);
      if (wrote) {
        assert.equal(readFileSync(fixture.envFile, 'utf8'), text);
        assert.ok(!fixture.calls().some((call) => call.includes(LINK_SECRETS)));
      } else {
        assert.match(readFileSync(fixture.envFile, 'utf8'), /\nRUNNER_LINK_URL=same-origin\n/);
      }
    });

    test(`${upgrade}: in a build that serves runners only over the link, when ${what}: the apiserver is not recreated, and it exits 1 saying so`, (t) => {
      const fixture = makeFixture(t, { linkOnly: true });
      writeFileSync(fixture.envFile, BEFORE_LINK);
      const run = fixture.run(upgrade, ['--no-pull'], extra);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, said);
      assert.match(run.stderr, /error: this build serves runners only over the runner link, and it did not come up/);
      assert.match(run.stderr, /The apiserver was not recreated: this deployment goes on running the build it has/);
      assert.ok(!fixture.calls().some((call) => APISERVER_UP.test(call)), fixture.calls().join('\n'));
      assert.ok(!run.output.includes('✓ Upgrade complete'));
      assertNoSecretShown(fixture, run);
    });
  }

  test(`${upgrade}: an origin this host cannot reach proves nothing either way, and is said so`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, BEFORE_LINK);
    const run = fixture.run(upgrade, ['--no-pull'], { FAKE_DOOR_ORIGIN: 'unreachable ETIMEDOUT' });
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /could not be checked from here \(ETIMEDOUT\)/);
  });

  test(`${upgrade}: an origin on this host is not asked: inside a container it would be the container`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, 'JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nPUBLIC_ORIGIN="http://localhost:2086"\n');
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(fixture.calls().filter((call) => call.includes('node - ')), [`compose run --rm --no-deps -T apiserver ${DOOR_GATEWAY}`]);
  });

  test(`${upgrade}: in a build that serves runners only over the link: its lines are in .env before Compose renders, and an operator's unfinished link stops it first`, (t) => {
    const fixture = makeFixture(t, { linkOnly: true });
    writeFileSync(fixture.envFile, BEFORE_LINK);
    const run = fixture.run(upgrade, ['--no-pull']);
    assert.equal(run.status, 0, run.output);
    const calls = fixture.calls();
    assert.ok(indexOfCall(calls, LINK_SECRETS) < calls.indexOf('compose config --services'), calls.join('\n'));
    assert.ok(indexOfCall(calls, LINK_UP) < indexOfCall(calls, APISERVER_UP));

    // A deployment the install set up, whose lines are there already: nothing is built before what can stop the run has
    // had its say (the managed runners' files, scripts/managed-runner/new_deployment_test.py).
    const managed = makeFixture(t, { linkOnly: true });
    writeFileSync(managed.envFile, readFileSync(fixture.envFile, 'utf8'));
    assert.equal(managed.run(upgrade, ['--no-pull']).status, 0);
    const managedCalls = managed.calls();
    assert.ok(managedCalls.indexOf('compose config --services') < indexOfCall(managedCalls, LINK_BUILD), managedCalls.join('\n'));

    const unfinished = makeFixture(t, { linkOnly: true });
    writeFileSync(unfinished.envFile, `${BEFORE_LINK}RUNNER_LINK_SIGNING_KEY="production-signing"\n`);
    const stopped = unfinished.run(upgrade, ['--no-pull']);
    assert.equal(stopped.status, 1, stopped.output);
    assert.match(stopped.stderr, /no value for: RUNNER_LINK_URL/);
    assert.ok(!stopped.output.includes('production-'));
    assert.ok(!unfinished.calls().some((call) => /^compose build|^compose up/.test(call)), unfinished.calls().join('\n'));
  });

  test(`${upgrade}: the web gateway is recreated once, ahead of the apiserver, where the nginx.conf it runs is not this checkout's`, (t) => {
    for (const body of [BEFORE_LINK, PRODUCTION_SHAPED]) {
      const fixture = makeFixture(t);
      writeFileSync(fixture.envFile, body);
      const running = path.join(fixture.root, 'running-nginx.conf');
      writeFileSync(running, 'server { listen 80; }\n');
      const run = fixture.run(upgrade, ['--no-pull'], { FAKE_RUNNING_NGINX: running });
      assert.equal(run.status, 0, run.output);
      const calls = fixture.calls();
      assert.equal(calls.filter((call) => call === WEB_GATEWAY_RECREATE).length, 1);
      assert.ok(calls.indexOf(WEB_GATEWAY_RECREATE) < indexOfCall(calls, APISERVER_UP));
      if (body === BEFORE_LINK) assert.ok(calls.indexOf(WEB_GATEWAY_RECREATE) > indexOfCall(calls, LINK_UP));
      // Running this checkout's already: it is left alone.
      const again = fixture.run(upgrade, ['--no-pull']);
      assert.equal(again.status, 0, again.output);
      assert.ok(!fixture.calls().includes(WEB_GATEWAY_RECREATE));
    }
  });

  test(`${upgrade}: a pull that changes the script runs the new one, from the start, once`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(fixture.envFile, PRODUCTION_SHAPED);
    git(fixture, 'branch', '-m', 'main');
    const origin = path.join(fixture.root, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', fixture.checkout, origin], { env: fixture.env });
    git(fixture, 'remote', 'add', 'origin', origin);
    git(fixture, 'fetch', '-q', 'origin');
    git(fixture, 'branch', '--set-upstream-to=origin/main', 'main');
    // Another machine lands a new version of the script.
    const elsewhere = path.join(fixture.root, 'elsewhere');
    execFileSync('git', ['clone', '-q', origin, elsewhere], { env: fixture.env });
    const script = path.join(elsewhere, upgrade);
    const text = readFileSync(script, 'utf8');
    writeFileSync(script, text.replace('set -euo pipefail\n', 'set -euo pipefail\necho "the new script is running with: $*"\n'));
    execFileSync('git', ['add', '.'], { cwd: elsewhere, env: fixture.env });
    execFileSync('git', ['commit', '-q', '-m', 'the script changes'], { cwd: elsewhere, env: fixture.env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: elsewhere, env: fixture.env });

    const run = fixture.run(upgrade);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /==> The pull changed this script; running the new one/);
    assert.match(run.stdout, /the new script is running with:  ?--no-pull/);
    assert.equal(fixture.calls().filter((call) => /^compose build /.test(call)).length, 1);
    assert.equal(git(fixture, 'rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: elsewhere, encoding: 'utf8' }).trim());
    // And a pull that does not change it goes straight on.
    const second = fixture.run(upgrade);
    assert.equal(second.status, 0, second.output);
    assert.ok(!second.stdout.includes('The pull changed this script'));
  });
}

test('both copies keep the runner link\'s section the same', () => {
  const sections = UPGRADES.map((relative) => {
    const text = readFileSync(path.join(repo, relative), 'utf8');
    const start = text.indexOf('# ── Runner link: this section is the same in both copies');
    assert.ok(start >= 0, relative);
    return text.slice(start, text.indexOf('# ── end of the runner link\'s section', start));
  });
  assert.equal(sections[0], sections[1]);
  assert.match(sections[0], /link_write_env\(\)/);
});

test('no script writes the switch: RUNNER_LINK_REQUIRED and runner_link_switch are an administrator\'s', () => {
  for (const relative of [...UPGRADES, INSTALL]) {
    const lines = readFileSync(path.join(repo, relative), 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#'));
    const text = lines.join('\n');
    assert.doesNotMatch(text, /runner_link_switch/, relative);
    assert.doesNotMatch(text, /RUNNER_LINK_REQUIRED/, relative);
    assert.doesNotMatch(text, /runner-link-required/, relative);
    assert.doesNotMatch(text, /psql/, relative);
  }
});

// ── the install ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('a fresh install writes the link\'s lines once, after the managed runners\' profile, shows no secret, and checks the way a runner takes', (t) => {
  const fixture = makeFixture(t);
  const run = fixture.run(INSTALL, ['--public-origin', 'http://10.66.82.117:2086', '--managed-runner-image', 'orbit-managed-runner:fixture']);
  assert.equal(run.status, 0, run.output);
  assertNoSecretShown(fixture, run);
  const text = readFileSync(fixture.envFile, 'utf8');
  assert.equal(statSync(fixture.envFile).mode & 0o777, 0o600);
  const live = text.split('\n').filter((line) => line && !line.startsWith('#'));
  for (const name of SECRET_NAMES) assert.equal(live.filter((line) => line === `RUNNER_LINK_${name}="${secretValue(name)}"`).length, 1, name);
  assert.equal(live.filter((line) => line === 'RUNNER_LINK_URL=same-origin').length, 1);
  assert.deepEqual(live.filter((line) => line.startsWith('COMPOSE_PROFILES=')), [
    'COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall',
    'COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall,runner-link',
  ]);
  const calls = fixture.calls();
  const order = [LINK_BUILD, LINK_SECRETS, /^compose build /, 'compose up -d --wait --wait-timeout 900', DOOR_GATEWAY].map((match) => indexOfCall(calls, match));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), calls.join('\n'));
  assert.ok(!calls.some((call) => /^compose build .*link-gateway/.test(call)), 'its image is built once, as /upgrade names it');
  assert.match(run.stderr, /this deployment's address is plain http, so its runner link is plain ws:\/\//);
  assert.match(run.stdout, /✓ Orbit is running/);
});

test('a fresh install on https, and one without managed runners, get the link too; the first without the warning', (t) => {
  const https = makeFixture(t);
  const run = https.run(INSTALL, ['--public-origin', 'https://orbit.example.com', '--no-managed-runners']);
  assert.equal(run.status, 0, run.output);
  assert.ok(!run.output.includes('plain http'));
  assert.deepEqual(readFileSync(https.envFile, 'utf8').split('\n').filter((line) => line.startsWith('COMPOSE_PROFILES=')), ['COMPOSE_PROFILES=runner-link']);
  const noStart = makeFixture(t);
  const written = noStart.run(INSTALL, ['--no-managed-runners', '--no-start']);
  assert.equal(written.status, 0, written.output);
  assert.match(readFileSync(noStart.envFile, 'utf8'), /\nRUNNER_LINK_URL=same-origin\n/);
  assert.ok(!noStart.calls().some((call) => /^compose (up|build)/.test(call)));
});

test('a fresh install whose link does not answer, or whose image makes no secrets, stops and says so', (t) => {
  const door = makeFixture(t);
  const run = door.run(INSTALL, ['--no-managed-runners'], { FAKE_DOOR_GATEWAY: '502' });
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /the web gateway's \/runner-link answered: 502/);
  assert.ok(!run.output.includes('✓ Orbit is running'));
  const secrets = makeFixture(t);
  const refused = secrets.run(INSTALL, ['--no-managed-runners'], { FAKE_SECRETS_GARBAGE: '1' });
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /something other than the runner link's seven secrets/);
  assert.ok(!existsSync(secrets.envFile), '.env is not written');
});

test('the firewall added later goes into both of a deployment\'s profile lines', (t) => {
  const fixture = makeFixture(t);
  assert.equal(fixture.run(INSTALL, ['--no-managed-runner-firewall', '--managed-runner-image', 'orbit-managed-runner:fixture', '--no-start']).status, 0);
  const run = fixture.run(INSTALL, ['--enable-managed-runner-firewall']);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(readFileSync(fixture.envFile, 'utf8').split('\n').filter((line) => line.startsWith('COMPOSE_PROFILES=')), [
    'COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall',
    'COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall,runner-link',
  ]);
});

// ── what the real Compose makes of it ───────────────────────────────────────────────────────────────────────────────

const composeThere = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
function compose(dir, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ORBIT_|COMPOSE_|RUNNER_LINK_)/.test(name)));
  return execFileSync('docker', ['compose', ...args], { cwd: dir, env: { ...clean, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('a production-shaped .env renders link-gateway and nats with the config hash they had before this change: nothing to recreate', { skip: !composeThere }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-compose-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'src/link-gateway'), { recursive: true });
  copyFileSync(path.join(repo, 'src/link-gateway/nats.conf'), path.join(dir, 'src/link-gateway/nats.conf'));
  writeFileSync(path.join(dir, '.env'), PRODUCTION_SHAPED);
  const now = readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
  writeFileSync(path.join(dir, 'docker-compose.yml'), now);
  // The apiserver's lines are no part of what this compares, and a production-shaped .env fills them either way.
  const current = compose(dir, ['config', '--hash', 'link-gateway,nats']);
  // The two lines as they were before this change.
  const before = now
    .replace(/^ *env_file: \["\$\{RUNNER_LINK_ENV_FILE:-\/dev\/null\}"\]\n/m, '')
    .replace('- "${RUNNER_LINK_BIND:-}:${RUNNER_LINK_PORT:-8443}:8443"', '- "${RUNNER_LINK_PORT:-8443}:8443"');
  assert.notEqual(before, now);
  writeFileSync(path.join(dir, 'docker-compose.yml'), before);
  assert.equal(current, compose(dir, ['config', '--hash', 'link-gateway,nats']));
});

test('the lines an upgrade writes render a gateway behind the web gateway: plain, on loopback, on no port of its choosing', { skip: !composeThere }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-compose-same-origin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'deploy/runner-link'), { recursive: true });
  mkdirSync(path.join(dir, 'src/link-gateway'), { recursive: true });
  copyFileSync(path.join(repo, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  copyFileSync(path.join(repo, 'src/link-gateway/nats.conf'), path.join(dir, 'src/link-gateway/nats.conf'));
  copyFileSync(path.join(repo, 'deploy/runner-link/behind-web-gateway.env'), path.join(dir, 'deploy/runner-link/behind-web-gateway.env'));
  writeFileSync(path.join(dir, '.env'), [
    'JWT_SECRET=x', 'PROVIDER_SECRET_KEY=y', 'COMPOSE_PROFILES=managed-runners-docker',
    'RUNNER_LINK_URL=same-origin', 'RUNNER_LINK_ENV_FILE=./deploy/runner-link/behind-web-gateway.env',
    'RUNNER_LINK_BIND=127.0.0.1', 'RUNNER_LINK_PORT=0', 'RUNNER_LINK_METRICS_PORT=0',
    ...SECRET_NAMES.map((name) => `RUNNER_LINK_${name}="${secretValue(name)}"`),
    'COMPOSE_PROFILES=managed-runners-docker,runner-link', '',
  ].join('\n'));
  // Compose takes the last COMPOSE_PROFILES: the earlier one's profile stays on, and the later one's comes on.
  const services = compose(dir, ['config', '--services']).split('\n');
  for (const service of ['docker-channel', 'nats', 'link-gateway']) assert.ok(services.includes(service), service);
  const rendered = JSON.parse(compose(dir, ['config', '--format', 'json', 'link-gateway']));
  const gateway = rendered.services['link-gateway'];
  assert.equal(gateway.environment.LINK_TLS_MODE, 'off');
  assert.equal(gateway.environment.LINK_IP_RATE, '200');
  assert.equal(gateway.environment.LINK_IP_BURST, '400');
  assert.deepEqual(gateway.ports.map(({ host_ip, target, published }) => [host_ip, target, published]), [['127.0.0.1', 8443, '0'], ['127.0.0.1', 9464, '0']]);
});
