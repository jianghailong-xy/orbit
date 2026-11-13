// /upgrade's two-stage release (.claude/skills/upgrade/SKILL.md, "Two-stage release"; task 34wyYuIZzkg1g7DfIqdSR): the
// build host builds, boots and pushes the images, tagged by commit, and the deployment's host pulls them and recreates
// what changed, building nothing. Each case runs the real scripts in a throwaway Git checkout, with a fake `docker` and a
// fake `ssh` first on PATH: ssh runs the command it is given here, as the target, in a directory of its own, and docker
// records every call and answers as each host would. Compose's `config` is the real one, where it is installed, so the
// files the target is left with are rendered as the target would render them. The real two-stage run is the task's dry run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const UPGRADES = ['.claude/skills/upgrade/upgrade.sh', '.agents/skills/upgrade/scripts/upgrade.sh'];
const REGISTRY = 'registry.invalid:5000';
const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
const compose = realDocker && spawnSync(realDocker, ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const COPIED = [
  ...UPGRADES, 'deploy/two-stage/release.sh', 'deploy/two-stage/deploy-stage.sh', 'deploy/two-stage/base-images.env',
  'docker-compose.yml', '.gitignore', 'gateway/nginx.conf', 'gateway/several-apiservers/http/upstreams.conf',
  'gateway/several-apiservers/server/routes.conf', 'scripts/pg-archive-wal.sh', 'scripts/pg-backup.sh',
  'src/link-gateway/nats.conf', 'deploy/runner-link/behind-web-gateway.env',
];
// What the target is left with besides .env, its ./data and .upgrade/: the release's files, and nothing built from.
const SHIPPED = [
  'deploy/runner-link/behind-web-gateway.env', 'docker-compose.yml', 'gateway/nginx.conf', 'gateway/several-apiservers/http/upstreams.conf',
  'gateway/several-apiservers/server/routes.conf', 'scripts/pg-archive-wal.sh', 'scripts/pg-backup.sh', 'src/link-gateway/nats.conf',
];
const DEPLOY_ORDER = ['postgres', 'nats', 'apiserver', 'wiki-worker', 'web', 'link-gateway', 'gateway', 'pgbackup'];
const TARGET_ENV = `JWT_SECRET="target-secret"
PROVIDER_SECRET_KEY="target-key"
RUNNER_LINK_SIGNING_KEY="target-signing-key"
PUBLIC_ORIGIN="https://orbit.example.com"
COMPOSE_PROFILES=runner-link
`;

// The fake docker. A call is logged as <side>\t<ORBIT_IMAGE_TAG>\t<args>, the side being "build" or "target". On the target
// it keeps each container of the deployment as files under FAKE_STATE: <service> holds the config hash it was made with.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
side="${'$'}{FAKE_SIDE:-build}"
printf '%s\t%s\t%s\n' "$side" "${'$'}{ORBIT_IMAGE_TAG:-}" "$*" >>"$FAKE_DOCKER_LOG"
state="$FAKE_STATE"
if [ "$1" = compose ]; then
  for arg in "$@"; do
    if [ "$arg" = config ]; then exec "$FAKE_REAL_DOCKER" "$@"; fi
  done
fi
case "$side $*" in
  "build compose version"|"target compose version") echo "Docker Compose version v5.0.0" ;;
  "build manifest inspect --insecure "*)
    grep -qxF "$4" "$FAKE_REGISTRY" 2>/dev/null && exit 0
    echo "no such manifest: $4" >&2; exit 1 ;;
  "build info --format "*) [ -n "${'$'}{FAKE_UNTRUSTED:-}" ] || echo "$FAKE_REGISTRY_NAME false"; echo "docker.io true" ;;
  "build inspect --format {{.Image}} orbit-web") echo "sha256:${'0'.repeat(64)}" ;;
  "build push "*) echo "$2" >>"$FAKE_REGISTRY" ;;
  "target ps -aq "*)
    service="$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')"
    [ ! -e "$state/$service" ] || echo "c-$service" ;;
  "target inspect -f "*)
    service="${'$'}{4#c-}"
    if [ -e "$state/$service.stopped" ]; then echo "false $(cat "$state/$service")"; else echo "true $(cat "$state/$service")"; fi ;;
  "target inspect --format "*" orbit-postgres") [ -e "$state/postgres" ] || exit 1; echo "$PWD/data/pg-archive" ;;
  "target inspect --format {{.Config.Image}} c-web") cat "$state/web.image" ;;
  "target compose ps -q "*) [ -e "$state/$4" ] && [ ! -e "$state/$4.stopped" ] && echo "c-$4" ;;
  "target exec c-gateway cat "*) cat "$state/gateway.file" ;;
  "target exec c-pgbackup cat "*) cat "$state/pgbackup.file" ;;
  "target compose up "*)
    service="${'$'}{!#}"
    [ -z "${'$'}{FAKE_UP_FAIL:-}" ] || [ "$service" != "$FAKE_UP_FAIL" ] || { echo "fake docker: $service is unhealthy" >&2; exit 1; }
    "$FAKE_REAL_DOCKER" compose config --hash "$service" | cut -d' ' -f2 >"$state/$service"
    rm -f "$state/$service.stopped"
    case "$service" in
      gateway) cp gateway/nginx.conf "$state/gateway.file" ;;
      pgbackup) cp scripts/pg-backup.sh "$state/pgbackup.file" ;;
      web) "$FAKE_REAL_DOCKER" compose config --images web >"$state/web.image" ;;
    esac ;;
  "target compose "*" pull "*) [ -z "${'$'}{FAKE_PULL_FAIL:-}" ] || { echo "fake docker: manifest unknown" >&2; exit 1; } ;;
esac
exit 0
`;
const FAKE_SSH = String.raw`#!/usr/bin/env bash
while [ "${'$'}{1:-}" = -o ]; do shift 2; done
host="$1"; shift
printf '%s\t%s\n' "$host" "$*" >>"$FAKE_SSH_LOG"
mkdir -p "$FAKE_TARGET_TMP"
# As ssh does, the command starts in the home directory, with none of this side's environment.
cd "$FAKE_TARGET_HOME" && exec env -i PATH="$PATH" HOME="$HOME" FAKE_SIDE=target TMPDIR="$FAKE_TARGET_TMP" \
  $(env | grep -E '^FAKE_[A-Z_]+=' | grep -v '^FAKE_SIDE=') bash -c "$*"
`;
// The boot check, as CI runs it: what it was asked to boot is all a case needs.
const FAKE_BOOT_CHECK = '#!/usr/bin/env bash\nprintf "build\\t-\\tboot-check %s %s\\n" "$ORBIT_APISERVER_IMAGE" "$ORBIT_WEB_IMAGE" >>"$FAKE_DOCKER_LOG"\n';
// A plain-HTTP registry answers here only where a case says so.
const FAKE_CURL = '#!/usr/bin/env bash\n[ -n "${FAKE_REGISTRY_HTTP:-}" ]\n';

function makeFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'orbit-two-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'orbit');
  for (const relative of COPIED) {
    mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
    copyFileSync(path.join(repo, relative), path.join(checkout, relative));
  }
  mkdirSync(path.join(checkout, 'src/link-gateway'), { recursive: true });
  writeFileSync(path.join(checkout, 'src/link-gateway/Dockerfile'), 'FROM scratch\n');
  writeFileSync(path.join(checkout, 'scripts/image-boot-check.sh'), FAKE_BOOT_CHECK);
  // The build host's own settings, which a build reads for its arguments; ignored, as .env is in every checkout.
  writeFileSync(path.join(checkout, '.env'), 'JWT_SECRET=build\nPROVIDER_SECRET_KEY=build\nRUNNER_LINK_SIGNING_KEY=build\n');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['docker', FAKE_DOCKER], ['ssh', FAKE_SSH], ['curl', FAKE_CURL]]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const target = path.join(root, 'target', 'orbit');
  const state = path.join(root, 'target', 'containers');
  mkdirSync(target, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(target, '.env'), TARGET_ENV, { mode: 0o600 });
  const fixture = {
    root, checkout, target, state,
    dockerLog: path.join(root, 'docker.log'),
    sshLog: path.join(root, 'ssh.log'),
    registry: path.join(root, 'registry'),
  };
  fixture.env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ORBIT_|COMPOSE_|GIT_|RUNNER_LINK_|DOCKER_)/.test(name))),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: fixture.dockerLog,
    FAKE_SSH_LOG: fixture.sshLog,
    FAKE_REGISTRY: fixture.registry,
    FAKE_REGISTRY_NAME: REGISTRY,
    FAKE_REAL_DOCKER: realDocker,
    FAKE_STATE: state,
    FAKE_TARGET_HOME: path.join(root, 'target'),
    FAKE_TARGET_TMP: path.join(root, 'target', 'tmp'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CEILING_DIRECTORIES: root,
    ORBIT_REGISTRY: REGISTRY,
    ORBIT_DEPLOY_HOST: 'root@target.invalid',
    ORBIT_DEPLOY_DIR: target,
  };
  fixture.git = (...args) => execFileSync('git', args, { cwd: checkout, env: fixture.env, encoding: 'utf8' }).trim();
  fixture.commit = (message) => {
    fixture.git('add', '.');
    fixture.git('commit', '-q', '--allow-empty', '-m', message);
    return fixture.git('rev-parse', 'HEAD');
  };
  fixture.git('init', '-q', '--initial-branch=orbit-fixture');
  fixture.run = (script, args = [], extra = {}) => {
    for (const log of [fixture.dockerLog, fixture.sshLog]) writeFileSync(log, '');
    const env = { ...fixture.env, ...extra };
    for (const [name, value] of Object.entries(extra)) if (value === undefined) delete env[name];
    const result = spawnSync(path.join(checkout, script), ['--no-pull', ...args], {
      cwd: checkout, env, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const calls = readFileSync(fixture.dockerLog, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [side, tag, ...rest] = line.split('\t');
      return { side, tag, args: rest.join('\t') };
    });
    return {
      ...result,
      output: `${result.stdout}\n${result.stderr}`,
      build: calls.filter((call) => call.side === 'build'),
      target: calls.filter((call) => call.side === 'target'),
      ssh: readFileSync(fixture.sshLog, 'utf8').split('\n').filter(Boolean),
    };
  };
  fixture.linkTag = () => fixture.git('log', '-1', '--format=%H', '--', 'src/link-gateway');
  return fixture;
}

/** Every file under dir, relative to it, but for the ones a deployment keeps for itself. */
function shippedFiles(dir) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (['.env', '.upgrade', 'data'].includes(name)) continue;
      if (entry.isDirectory()) walk(name);
      else files.push(name);
    }
  };
  walk('');
  return files.sort();
}

const ups = (run) => run.target.filter((call) => call.args.startsWith('compose up ')).map((call) => call.args);
const upped = (run) => ups(run).map((call) => call.split(' ').at(-1));
const releaseLines = (text) => text.slice(text.indexOf('# >>> The release this host runs')).trim().split('\n');

test('the two-stage section is the same in both copies of /upgrade\'s script', () => {
  const section = (relative) => {
    const text = readFileSync(path.join(repo, relative), 'utf8');
    const start = text.indexOf('# ── Two-stage release: this section is the same in both copies');
    const end = text.indexOf('# ── end of the two-stage release\'s section');
    assert.ok(start > 0 && end > start, `${relative} has no two-stage section`);
    return text.slice(start, end);
  };
  assert.equal(section(UPGRADES[0]), section(UPGRADES[1]));
});

test('the deploy ships every file docker-compose.yml reads from its directory, and nothing that builds', () => {
  const release = readFileSync(path.join(repo, 'deploy/two-stage/release.sh'), 'utf8');
  const shipped = release.match(/^RELEASE_FILES=\(([^)]*)\)$/m)[1].split(/\s+/).filter(Boolean);
  const source = readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const read = new Set([...source.matchAll(/\.\/([A-Za-z0-9._/-]+)/g)].map((match) => match[1]));
  // The env file a same-origin link names in .env (the upgrade scripts' link_lines), which this file defaults to /dev/null.
  read.add('deploy/runner-link/behind-web-gateway.env');
  for (const file of read) {
    if (file.startsWith('data/')) continue;
    assert.ok(shipped.some((entry) => file === entry || file.startsWith(`${entry}/`)), `${file} is mounted and not shipped`);
  }
  for (const entry of shipped) {
    assert.ok(!/(^|\/)(src\/(apiserver|web)|Dockerfile)/.test(entry), `${entry} is something only a build reads`);
  }
});

test('with ORBIT_REGISTRY unset, Compose renders exactly what the file rendered before the two-stage release', { skip: !compose && 'needs docker compose' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-two-stage-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
  // The file with the release's lines put back as they read before it.
  const before = now.replace(/\n# Where each image comes from\.[^\n]*\n(?:#[^\n]*\n)*\n/, '\n')
    .replace(/\n {4}# Empty unless ORBIT_IMAGE_TAG is set[^\n]*\n {4}#[^\n]*\n {4}image: \$\{ORBIT_IMAGE_TAG:\+[^\n]*\n/, '\n')
    .replace(/\$\{ORBIT_REGISTRY:\+\$\{ORBIT_REGISTRY\}\/\}\$\{ORBIT_[A-Z]+_IMAGE:-([^}]+)\}/g, '$1')
    .replace(/\$\{ORBIT_REGISTRY:\+\$\{ORBIT_REGISTRY\}\/\}(orbit-[a-z-]+):\$\{ORBIT_[A-Z_]+_TAG:-local\}/g, '$1:local');
  assert.notEqual(before, now);
  assert.doesNotMatch(before, /ORBIT_REGISTRY|ORBIT_IMAGE_TAG|ORBIT_LINK_GATEWAY_TAG|ORBIT_[A-Z]+_IMAGE/);
  writeFileSync(path.join(dir, 'before.yml'), before);
  writeFileSync(path.join(dir, 'now.yml'), now);
  writeFileSync(path.join(dir, '.env'), 'JWT_SECRET=x\nPROVIDER_SECRET_KEY=y\nRUNNER_LINK_SIGNING_KEY=z\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ORBIT_|COMPOSE_)/.test(name)));
  const render = (file, ...args) => {
    const result = spawnSync(realDocker, ['compose', '-f', file, '--project-directory', dir, '--profile', '*', ...args],
      { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // Compose lists the services of --hash and --images in no set order.
  const lines = (text) => text.trim().split('\n').sort();
  assert.equal(render('now.yml', 'config'), render('before.yml', 'config'));
  for (const args of [['config', '--hash', '*'], ['config', '--images']]) {
    assert.deepEqual(lines(render('now.yml', ...args)), lines(render('before.yml', ...args)), `docker compose ${args.join(' ')}`);
  }
  // Set, every image but the two managed runners' comes from the registry, by commit or by digest.
  const set = spawnSync(realDocker, ['compose', '-f', 'now.yml', '--project-directory', dir, '--profile', '*', 'config', '--images'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...env, ORBIT_REGISTRY: REGISTRY, ORBIT_IMAGE_TAG: 'a'.repeat(40), ORBIT_LINK_GATEWAY_TAG: 'b'.repeat(40),
      ...Object.fromEntries(readFileSync(path.join(repo, 'deploy/two-stage/base-images.env'), 'utf8').split('\n')
        .filter((line) => /^ORBIT_[A-Z]+_IMAGE=/.test(line)).map((line) => line.split('='))),
    },
  });
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(set.stdout.trim().split('\n').sort(), [
    'orbit-docker-channel:local', 'orbit-managed-runner-firewall:local',
    `${REGISTRY}/library/nats@sha256:7ae34c25dfd6fe2e01c6483eabef20d796690fdcac6c4d94ca780a6cf9877fde`,
    `${REGISTRY}/library/nginx@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a`,
    `${REGISTRY}/library/postgres@sha256:d845e7f0ac8517b9d9868b6d20379f9688ba3676595e50ca7c0b664964b2a760`,
    `${REGISTRY}/library/postgres@sha256:d845e7f0ac8517b9d9868b6d20379f9688ba3676595e50ca7c0b664964b2a760`,
    `${REGISTRY}/orbit-apiserver:${'a'.repeat(40)}`, `${REGISTRY}/orbit-apiserver:${'a'.repeat(40)}`,
    `${REGISTRY}/orbit-link-gateway:${'b'.repeat(40)}`, `${REGISTRY}/orbit-web:${'a'.repeat(40)}`,
  ].sort());
});

for (const upgrade of UPGRADES) {
  test(`${upgrade}: build and push here, pull and up there, build nothing there, and roll back by commit`, { skip: !compose && 'needs docker compose' }, (t) => {
    const fixture = makeFixture(t);
    const first = fixture.commit('the first release');
    const link = fixture.linkTag();

    // The first release: built, booted and pushed here, then shipped and brought up there.
    let run = fixture.run(upgrade);
    assert.equal(run.status, 0, run.output);
    const images = [`${REGISTRY}/orbit-apiserver:${first}`, `${REGISTRY}/orbit-web:${first}`, `${REGISTRY}/orbit-link-gateway:${link}`];
    const build = run.build.map((call) => call.args);
    const at = (match) => {
      const index = build.findIndex((call) => (match instanceof RegExp ? match.test(call) : call === match));
      assert.ok(index >= 0, `no build-host call matches ${match}:\n${build.join('\n')}`);
      return index;
    };
    const composeBuild = at('compose build --build-arg PREVIOUS_RELEASE_IMAGE=orbit-web:previous-release apiserver wiki-worker web');
    assert.equal(run.build[composeBuild].tag, first, 'compose builds the images under the commit\'s tag');
    const order = [
      at(`tag sha256:${'0'.repeat(64)} orbit-web:previous-release`), composeBuild, at(`boot-check ${images[0]} ${images[1]}`),
      at(`build --provenance=false --build-arg ORBIT_SOURCE_SHA=${link} -t ${images[2]} src/link-gateway`),
      ...images.map((image) => at(`push ${image}`)),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `in this order:\n${build.join('\n')}`);
    assert.deepEqual(readFileSync(fixture.registry, 'utf8').trim().split('\n'), images);
    assert.ok(!build.some((call) => /^compose (up|pull|run|ps)\b/.test(call)), `nothing runs on the build host:\n${build.join('\n')}`);

    // The target builds nothing, and every `up` names one service and touches no other.
    const target = run.target.map((call) => call.args);
    assert.ok(!target.some((call) => /^(build|buildx|compose (.* )?build)\b/.test(call)), `the target built:\n${target.join('\n')}`);
    assert.ok(ups(run).every((call) => /^compose up -d --wait --no-deps --no-build( --force-recreate)? [a-z-]+$/.test(call)), ups(run).join('\n'));
    assert.deepEqual(upped(run), DEPLOY_ORDER);
    const pull = target.findIndex((call) => /^compose .* pull /.test(call));
    assert.ok(pull >= 0 && pull < target.indexOf(ups(run)[0]), 'every image is pulled before anything is brought up');
    assert.deepEqual(shippedFiles(fixture.target), SHIPPED);
    assert.equal(readFileSync(path.join(fixture.target, 'docker-compose.yml'), 'utf8'), readFileSync(path.join(fixture.checkout, 'docker-compose.yml'), 'utf8'));

    // .env keeps every line it had, gains the release's, keeps its mode, and is all a later `docker compose` there needs.
    const env = readFileSync(path.join(fixture.target, '.env'), 'utf8');
    assert.ok(env.startsWith(TARGET_ENV), 'what .env held comes first, byte for byte');
    assert.equal(statSync(path.join(fixture.target, '.env')).mode & 0o777, 0o600);
    const base = Object.fromEntries(readFileSync(path.join(repo, 'deploy/two-stage/base-images.env'), 'utf8').split('\n')
      .filter((line) => /^ORBIT_[A-Z]+_IMAGE=/.test(line)).map((line) => line.split('=')));
    assert.deepEqual(releaseLines(env), [
      '# >>> The release this host runs: written by /upgrade\'s two-stage deploy, and replaced whole by the next one',
      `ORBIT_REGISTRY=${REGISTRY}`, `ORBIT_IMAGE_TAG=${first}`, `ORBIT_LINK_GATEWAY_TAG=${link}`,
      `ORBIT_POSTGRES_IMAGE=${base.ORBIT_POSTGRES_IMAGE}`, `ORBIT_NGINX_IMAGE=${base.ORBIT_NGINX_IMAGE}`, `ORBIT_NATS_IMAGE=${base.ORBIT_NATS_IMAGE}`,
      '# <<< The release this host runs',
    ]);
    const rendered = spawnSync(realDocker, ['compose', 'config', '--images'], {
      cwd: fixture.target, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ORBIT_|COMPOSE_)/.test(name))),
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    for (const image of rendered.stdout.trim().split('\n')) assert.ok(image.startsWith(`${REGISTRY}/`), `${image} would not be pulled`);
    assert.match(run.stdout, new RegExp(`✓ Release ${first} runs on root@target.invalid`));
    assert.equal(readFileSync(path.join(fixture.target, '.upgrade/history'), 'utf8').trim().split('\n').length, 1);

    // A second release that changes the gateway's configuration: the gateway is recreated to read it, and everything
    // else that is unchanged stays as it is. postgres, unchanged, is never brought up again.
    appendFileSync(path.join(fixture.checkout, 'gateway/nginx.conf'), '# a change of the second release\n');
    const second = fixture.commit('the second release');
    run = fixture.run(upgrade);
    assert.equal(run.status, 0, run.output);
    assert.ok(run.build.some((call) => call.args.startsWith('compose build ') && call.tag === second), run.output);
    assert.ok(!run.build.some((call) => call.args.startsWith('build ')), 'the link gateway, unchanged, is in the registry already');
    assert.match(run.stdout, /orbit-link-gateway:[0-9a-f]{40} is in the registry already/);
    assert.deepEqual(upped(run), DEPLOY_ORDER.filter((service) => service !== 'postgres'));
    assert.ok(ups(run).includes('compose up -d --wait --no-deps --no-build --force-recreate gateway'), ups(run).join('\n'));
    assert.match(run.stdout, /postgres +unchanged/);
    assert.match(run.stdout, /apiserver +recreate/);
    assert.match(readFileSync(path.join(fixture.target, 'gateway/nginx.conf'), 'utf8'), /a change of the second release/);
    assert.equal(releaseLines(readFileSync(path.join(fixture.target, '.env'), 'utf8'))[2], `ORBIT_IMAGE_TAG=${second}`);
    assert.ok(readFileSync(path.join(fixture.target, '.env'), 'utf8').startsWith(TARGET_ENV));

    // The rollback: the first release again, from the registry, its own files with it, and nothing built anywhere.
    run = fixture.run(upgrade, ['--deploy', first]);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.build.filter((call) => /^(compose build|build|push|tag) /.test(call.args)), [], run.output);
    assert.ok(!run.target.some((call) => /^(build|compose (.* )?build)\b/.test(call.args)), run.output);
    assert.doesNotMatch(readFileSync(path.join(fixture.target, 'gateway/nginx.conf'), 'utf8'), /a change of the second release/);
    assert.equal(releaseLines(readFileSync(path.join(fixture.target, '.env'), 'utf8'))[2], `ORBIT_IMAGE_TAG=${first}`);
    assert.ok(ups(run).includes('compose up -d --wait --no-deps --no-build --force-recreate gateway'), ups(run).join('\n'));
    assert.deepEqual(readFileSync(path.join(fixture.target, '.upgrade/history'), 'utf8').trim().split('\n').map((line) => line.split(' ')[1]),
      [first, second, first]);
    // The same release again changes nothing that runs: only the services' `up`, each a no-op, and no forced recreate.
    run = fixture.run(upgrade, ['--deploy', first]);
    assert.equal(run.status, 0, run.output);
    assert.ok(!ups(run).some((call) => call.includes('--force-recreate')), ups(run).join('\n'));
    for (const service of DEPLOY_ORDER) assert.match(run.stdout, new RegExp(`    ${service} +unchanged`));
  });
}

test('a deploy that cannot run changes nothing on either host', { skip: !compose && 'needs docker compose' }, (t) => {
  const fixture = makeFixture(t);
  const upgrade = UPGRADES[0];
  const commit = fixture.commit('a release');
  const unchanged = () => {
    assert.deepEqual(shippedFiles(fixture.target), []);
    assert.equal(readFileSync(path.join(fixture.target, '.env'), 'utf8'), TARGET_ENV);
  };

  // Not in the registry: refused before anything is shipped.
  let run = fixture.run(upgrade, ['--deploy', commit]);
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.stderr, /orbit-apiserver:[0-9a-f]{40} is not in registry\.invalid:5000\. Build the release first/);
  assert.deepEqual(run.ssh, []);
  unchanged();

  // The flags of the two-stage release, without its registry.
  run = fixture.run(upgrade, ['--build-only'], { ORBIT_REGISTRY: undefined });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /belong to the two-stage release, which ORBIT_REGISTRY turns on/);

  // A plain-HTTP registry this host's Docker does not trust: refused before anything is built.
  run = fixture.run(upgrade, ['--build-only'], { FAKE_REGISTRY_HTTP: '1', FAKE_UNTRUSTED: '1' });
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.stderr, /does not list it among its insecure-registries/);
  assert.ok(!run.build.some((call) => /^(compose build|build) /.test(call.args)), run.output);

  // Built and pushed, then each of these stops the deploy stage before any `up`, and before its files are in place.
  run = fixture.run(upgrade, ['--build-only']);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.ssh.filter((call) => call.includes('deploy-stage.sh')), []);
  const refused = (extra, setup, message) => {
    setup();
    const result = fixture.run(upgrade, ['--deploy', commit], extra);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, message);
    assert.deepEqual(ups(result), [], result.output);
    assert.ok(!existsSync(path.join(fixture.target, 'docker-compose.yml')), 'the release\'s files stay staged');
  };
  const lock = path.join(fixture.root, 'target', 'tmp', 'orbit-upgrade.lock');
  refused({}, () => { mkdirSync(lock, { recursive: true }); writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`); },
    /another upgrade is already in progress on this host/);
  rmSync(lock, { recursive: true, force: true });
  refused({ FAKE_PULL_FAIL: '1' }, () => {}, /manifest unknown/);
  refused({}, () => appendFileSync(path.join(fixture.target, '.env'), 'COMPOSE_PROFILES=runner-link,managed-runners-docker\n'),
    /switches on managed runners/);
  writeFileSync(path.join(fixture.target, '.env'), `${TARGET_ENV}# >>> The release this host runs: written by /upgrade's two-stage deploy, and replaced whole by the next one\n`);
  refused({}, () => {}, /the release's lines in \.env are not as a deploy writes them/);
  rmSync(path.join(fixture.target, '.env'));
  refused({}, () => {}, /has no \.env/);
  writeFileSync(path.join(fixture.target, '.env'), TARGET_ENV);
  unchanged();

  // A service that does not come up fails the deploy, after the ones before it.
  run = fixture.run(upgrade, ['--deploy', commit], { FAKE_UP_FAIL: 'apiserver' });
  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(upped(run), ['postgres', 'nats', 'apiserver']);
  assert.ok(!existsSync(path.join(fixture.target, '.upgrade/history')), 'a failed deploy is not a release this host ran');

  // A running postgres whose configuration the release changes is left running, and said so, unless --pull-base.
  run = fixture.run(upgrade, ['--deploy', commit]);
  assert.equal(run.status, 0, run.output);
  writeFileSync(path.join(fixture.state, 'postgres'), 'an older configuration\n');
  run = fixture.run(upgrade, ['--deploy', commit]);
  assert.equal(run.status, 0, run.output);
  assert.ok(!upped(run).includes('postgres'), run.output);
  assert.match(run.output, /postgres was NOT recreated/);
  run = fixture.run(upgrade, ['--deploy', commit, '--pull-base']);
  assert.equal(run.status, 0, run.output);
  assert.equal(upped(run)[0], 'postgres');
});
