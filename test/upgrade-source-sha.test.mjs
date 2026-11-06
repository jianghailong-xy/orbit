import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const upgrade = path.join(repo, '.claude/skills/upgrade/upgrade.sh');

// Since 5969060e a build names its own commit: scripts/build-binaries.sh falls back to reading
// .git/HEAD and the refs straight out of the build context, which .dockerignore lets through
// and src/web/Dockerfile copies into the runner-binary stage. So the split these tests hold to
// is: a documented build from a checkout needs no ORBIT_SOURCE_SHA, a documented build from a
// source archive — no Git metadata — still does, and the build refuses outright rather than
// publishing a runner that cannot report the commit it came from.

// `docker compose up -d --build` with no service after it. Only the web image runs
// build-binaries.sh, so `--build apiserver` (the runbook's rollback) rebuilds no runner and
// carries no source-commit invariant.
const SERVICE_SCOPED = /docker compose up -d --build\s+[a-z]/;
// build-binaries.sh refuses anything that is not 40 lowercase hex, so a doc telling the reader
// to pass an abbreviated commit documents a build that stops with an error.
const NAMES_FULL_COMMIT =
  /ORBIT_SOURCE_SHA=(?:"\$\(git rev-parse HEAD\)"|<40-character commit>) docker compose up -d --build/;
// The prose that introduces an instruction is what says which of the two cases it is.
const ARCHIVE_CASE = /source archive/i;

test('documented full-stack builds resolve the source commit', () => {
  const documentation = [
    'README.md',
    'docs/self-hosting.md',
    'docs/postgres-conflict-runbook.md',
  ];
  let checkoutBuilds = 0;
  let archiveBuilds = 0;
  for (const relative of documentation) {
    const lines = readFileSync(path.join(repo, relative), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('docker compose up -d --build')) return;
      if (SERVICE_SCOPED.test(line)) return;
      const where = `${relative}:${index + 1}`;
      const context = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
      if (line.includes('ORBIT_SOURCE_SHA')) {
        archiveBuilds += 1;
        assert.match(line, NAMES_FULL_COMMIT,
          `${where} names the source revision in a form the build refuses`);
        assert.match(context, ARCHIVE_CASE,
          `${where} demands a source revision the build would have read from the checkout`);
      } else {
        checkoutBuilds += 1;
        assert.doesNotMatch(context, ARCHIVE_CASE,
          `${where} has a source-archive build without its source revision`);
      }
    });
  }
  assert.ok(checkoutBuilds >= 4, 'expected fresh-install and upgrade build instructions');
  assert.ok(archiveBuilds >= 2,
    'expected README and the self-hosting guide to keep covering source-archive builds');
});

test('an explicit source SHA is required exactly where the build cannot resolve the commit', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-source-sha-'));
  const script = path.join(fixture, 'scripts/build-binaries.sh');
  const git = path.join(fixture, '.git');
  const checkedOut = '1'.repeat(40);
  const named = '2'.repeat(40);

  const run = (sourceSHA) => {
    const env = {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH}`,
      // Keep git from walking out of the fixture and answering with some enclosing repo's
      // HEAD when the fixture is the source archive that has no metadata of its own.
      GIT_CEILING_DIRECTORIES: tmpdir(),
    };
    if (sourceSHA === undefined) delete env.ORBIT_SOURCE_SHA;
    else env.ORBIT_SOURCE_SHA = sourceSHA;
    return spawnSync('bash', [script, 'dist-bin'], { cwd: fixture, env, encoding: 'utf8' });
  };
  const stamped = (sha) => new RegExp(`^>> source ${sha}$`, 'm');

  try {
    mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    mkdirSync(path.join(fixture, 'src/runner-go'), { recursive: true });
    copyFileSync(path.join(repo, 'scripts/build-binaries.sh'), script);
    writeFileSync(path.join(fixture, 'package.json'), '{ "version": "0.0.0-fixture" }\n');
    // Stop the run at its first cross-compile: the commit it resolved is already on stdout by
    // then, and a real Go toolchain would only make the assertion slower.
    const fakeGo = path.join(fixture, 'go');
    writeFileSync(fakeGo, '#!/bin/sh\necho "fixture go: stopping after the source stamp" >&2\nexit 1\n');
    chmodSync(fakeGo, 0o755);

    // A checkout build names itself. This is the runner-binary stage's own situation: .git/HEAD
    // and the refs, no object store, so `git` refuses the tree and the files are read directly.
    mkdirSync(path.join(git, 'refs/heads'), { recursive: true });
    writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(git, 'refs/heads/main'), `${checkedOut}\n`);
    const checkout = run(undefined);
    assert.match(checkout.stdout, stamped(checkedOut),
      `a checkout build did not resolve its own commit:\n${checkout.stdout}\n${checkout.stderr}`);
    assert.match(checkout.stderr, /fixture go/,
      'the run stopped before it reached the build it was supposed to stamp');

    // …including when the branch ref is packed rather than loose, which is what a clone ships.
    rmSync(path.join(git, 'refs'), { recursive: true, force: true });
    writeFileSync(path.join(git, 'packed-refs'), `${checkedOut} refs/heads/main\n`);
    const packed = run(undefined);
    assert.match(packed.stdout, stamped(checkedOut),
      `a packed ref did not resolve:\n${packed.stdout}\n${packed.stderr}`);

    // A source archive carries no metadata, so there is nothing to resolve: the build refuses
    // instead of stamping an anonymous binary, and says which variable names the commit.
    rmSync(git, { recursive: true, force: true });
    const archive = run(undefined);
    assert.notEqual(archive.status, 0, 'a build with no way to name its commit must refuse');
    assert.doesNotMatch(archive.stderr, /fixture go/,
      'it must refuse at the resolution gate, before compiling anything');
    assert.match(archive.stderr, /ORBIT_SOURCE_SHA/,
      'the refusal must name the variable that makes the build legal');
    assert.doesNotMatch(archive.stdout, /^>> source /m,
      'it refused, so it must not have stamped anything');

    // …and naming the commit is exactly what makes that same build legal again.
    const explicit = run(named);
    assert.match(explicit.stdout, stamped(named),
      `an explicitly named commit did not reach the stamp:\n${explicit.stdout}\n${explicit.stderr}`);

    // An abbreviated commit is refused, which is why the docs spell out all 40 characters.
    const abbreviated = run(named.slice(0, 7));
    assert.notEqual(abbreviated.status, 0, 'an abbreviated commit must not be stamped');
    assert.match(abbreviated.stderr, /40-character/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the docker build carries the checkout commit into the runner-binary stage', () => {
  // Each of these links alone puts the documented bare `docker compose up -d --build` back on
  // "no Git metadata in the build context": Compose has to pass the argument even when it is
  // empty, the Dockerfile has to declare it and hand it to the build script, and it has to copy
  // in the metadata that .dockerignore keeps letting through around the excluded object store.
  const links = [
    ['docker-compose.yml', /ORBIT_SOURCE_SHA: "\$\{ORBIT_SOURCE_SHA:-\}"/,
      'the web build must accept an unset ORBIT_SOURCE_SHA'],
    ['src/web/Dockerfile', /^ARG ORBIT_SOURCE_SHA$/m,
      'the runner-binary stage must accept the build argument'],
    ['src/web/Dockerfile', /ORBIT_SOURCE_SHA="\$ORBIT_SOURCE_SHA" bash scripts\/build-binaries\.sh/,
      'a named commit must reach build-binaries.sh'],
    ['src/web/Dockerfile', /^COPY \.gi\[t\] \.\/\.git\/$/m,
      'the checkout metadata must reach the stage that reads it'],
    ['.dockerignore', /^!\.git\/HEAD$/m, 'HEAD names the commit being built'],
    ['.dockerignore', /^!\.git\/refs$/m, 'HEAD points at a loose ref'],
    ['.dockerignore', /^!\.git\/packed-refs$/m, 'or at a packed one'],
  ];
  for (const [relative, pattern, why] of links) {
    assert.match(readFileSync(path.join(repo, relative), 'utf8'), pattern,
      `${relative}: ${why}`);
  }
});

test('legacy upgrade passes the checked-out commit to the web image build', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-upgrade-source-sha-'));
  const dockerLog = path.join(fixture, 'docker.log');
  const fakeDocker = path.join(fixture, 'docker');
  writeFileSync(fakeDocker, `#!/bin/sh
printf '%s\\t%s\\n' "\${ORBIT_SOURCE_SHA-}" "$*" >>"$ORBIT_FAKE_DOCKER_LOG"
`);
  chmodSync(fakeDocker, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH}`,
      ORBIT_FAKE_DOCKER_LOG: dockerLog,
      // A link of its own, so that the runner link's steps (test/upgrade-runner-link.test.mjs) leave this case and its .env alone.
      RUNNER_LINK_URL: 'wss://link.fixture.invalid',
    };
    delete env.ORBIT_SOURCE_SHA;
    // --no-pull: this runs in the repository itself, which a pull would move.
    const run = spawnSync(upgrade, ['--allow-dirty', '--no-pull'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const calls = readFileSync(dockerLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\t'));
    const build = calls.find(([, args]) => args === 'compose build apiserver wiki-worker web');
    assert.deepEqual(build, [head, 'compose build apiserver wiki-worker web']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('upgrade on main pulls origin first, so the build names the commit that landed', () => {
  // Merges reach origin without passing through the deploy checkout — another machine's runner, a
  // GitHub merge. Built from what that checkout last heard, the deploy is stale and still reports
  // success, so both copies of the skill fast-forward a checkout on main before building.
  for (const relative of [
    '.claude/skills/upgrade/upgrade.sh',
    '.agents/skills/upgrade/scripts/upgrade.sh',
  ]) {
    const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-upgrade-pull-'));
    const origin = path.join(fixture, 'origin.git');
    const deployed = path.join(fixture, 'deployed');
    const elsewhere = path.join(fixture, 'elsewhere');
    const dockerLog = path.join(fixture, 'docker.log');
    const fakeDocker = path.join(fixture, 'docker');
    writeFileSync(fakeDocker, `#!/bin/sh
printf '%s\\t%s\\n' "\${ORBIT_SOURCE_SHA-}" "$*" >>"$ORBIT_FAKE_DOCKER_LOG"
`);
    chmodSync(fakeDocker, 0o755);
    const env = {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH}`,
      ORBIT_FAKE_DOCKER_LOG: dockerLog,
      // A link of its own, so that the runner link's steps (test/upgrade-runner-link.test.mjs) leave this case and its .env alone.
      RUNNER_LINK_URL: 'wss://link.fixture.invalid',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    delete env.ORBIT_SOURCE_SHA;
    const git = (cwd, ...args) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const commit = (cwd, message) => {
      git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
      return git(cwd, 'rev-parse', 'HEAD');
    };
    const land = (message) => {
      const sha = commit(elsewhere, message);
      git(elsewhere, 'push', '-q', 'origin', 'main');
      return sha;
    };
    // The commit the run handed to `compose build`; undefined when it stopped before building.
    const upgradeWith = (...args) => {
      writeFileSync(dockerLog, '');
      const run = spawnSync(path.join(deployed, relative), args, {
        cwd: fixture,
        env,
        encoding: 'utf8',
      });
      const build = readFileSync(dockerLog, 'utf8')
        .split('\n')
        .map((line) => line.split('\t'))
        .find(([, call]) => call === 'compose build apiserver wiki-worker web');
      return { run, built: build?.[0], why: `${relative} ${args.join(' ')}\n${run.stdout}\n${run.stderr}` };
    };

    try {
      git(fixture, 'init', '-q', '--bare', '--initial-branch=main', origin);
      git(fixture, 'init', '-q', '--initial-branch=main', deployed);
      // As the installed checkout has it: --ff-only must still win over a configured rebase.
      git(deployed, 'config', 'pull.rebase', 'true');
      mkdirSync(path.dirname(path.join(deployed, relative)), { recursive: true });
      copyFileSync(path.join(repo, relative), path.join(deployed, relative));
      chmodSync(path.join(deployed, relative), 0o755);
      git(deployed, 'add', '.');
      commit(deployed, 'install');
      git(deployed, 'remote', 'add', 'origin', origin);
      git(deployed, 'push', '-q', '-u', 'origin', 'main');
      git(fixture, 'clone', '-q', origin, elsewhere);

      const landed = land('merged on another machine');
      let r = upgradeWith();
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.built, landed, `the build must name the commit the pull brought in: ${r.why}`);

      // Only ahead of origin — a local fast-forward not pushed yet — leaves nothing to pull: it ships.
      const local = commit(deployed, 'fast-forwarded here, not pushed');
      r = upgradeWith();
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.built, local, r.why);

      // Diverged from origin: stop before building anything, and name the way out.
      land('merged on another machine again');
      r = upgradeWith();
      assert.notEqual(r.run.status, 0, `a diverged checkout must not deploy: ${r.why}`);
      assert.equal(r.built, undefined, `it must stop before building: ${r.why}`);
      assert.match(r.run.stderr, /--no-pull/, r.why);
      assert.equal(git(deployed, 'rev-parse', 'HEAD'), local, 'the failed pull must leave the checkout alone');

      // --no-pull deploys the checkout exactly as it is.
      r = upgradeWith('--no-pull');
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.built, local, r.why);

      // Off main nothing is pulled: this branch has no upstream, so a pull would fail the run.
      git(deployed, 'switch', '-q', '-c', 'topic');
      const topic = commit(deployed, 'on a topic branch');
      r = upgradeWith();
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.built, topic, r.why);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

// A deployment runs from one checkout, because its bind mounts are relative, so both copies of the skill stop anywhere
// else before they touch anything: from there /archive would bind an empty directory, which the mirror's --delete reads,
// and every attachment would stop reading. And no list of services names pgbackup, which runs a script bind-mounted as a
// single file: where the deployment does run from, they bring it up to date themselves.
const DEPLOYMENT_FAKE_DOCKER = `#!/bin/sh
printf '%s\n' "$*" >>"$ORBIT_FAKE_DOCKER_LOG"
case "$*" in
  'compose config --services') printf '%s\n' postgres apiserver wiki-worker web gateway pgbackup ;;
  'compose config postgres')
    [ -z "$ORBIT_FAKE_NO_ENV" ] || exit 1
    echo "    container_name: \${ORBIT_FAKE_POSTGRES:-orbit-postgres}" ;;
  'compose ps -q pgbackup') [ -z "$ORBIT_FAKE_PGBACKUP" ] || echo "$ORBIT_FAKE_PGBACKUP" ;;
  'inspect --format '*' orbit-postgres')
    [ -n "$ORBIT_FAKE_ARCHIVE" ] || { echo 'Error: No such object' >&2; exit 1; }
    echo "$ORBIT_FAKE_ARCHIVE" ;;
  'inspect --format '*' orbit-qa-postgres') echo "$PWD/data/pg-archive" ;;
  "exec $ORBIT_FAKE_PGBACKUP cat /usr/local/bin/pg-backup.sh") cat "$ORBIT_FAKE_RUNNING_SCRIPT" ;;
esac
`;

for (const relative of ['.claude/skills/upgrade/upgrade.sh', '.agents/skills/upgrade/scripts/upgrade.sh']) {
  test(`${relative} stops anywhere but the checkout the deployment runs from, and brings pgbackup up to date there`, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'orbit-upgrade-deployment-'));
    const deployed = path.join(fixture, 'deployed');
    const dockerLog = path.join(fixture, 'docker.log');
    const running = path.join(fixture, 'running-script');
    const fakeDocker = path.join(fixture, 'docker');
    writeFileSync(fakeDocker, DEPLOYMENT_FAKE_DOCKER);
    chmodSync(fakeDocker, 0o755);
    const env = {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH}`,
      ORBIT_FAKE_DOCKER_LOG: dockerLog,
      // A link of its own, so that the runner link's steps (test/upgrade-runner-link.test.mjs) leave this case and its .env alone.
      RUNNER_LINK_URL: 'wss://link.fixture.invalid',
      ORBIT_FAKE_RUNNING_SCRIPT: running,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    delete env.COMPOSE_PROJECT_NAME;
    const git = (...args) => execFileSync('git', args, { cwd: deployed, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const script = '#!/bin/sh\n# the sidecar, as this checkout has it\n';
    const here = path.join(deployed, 'data/pg-archive');
    const installed = path.join(fixture, 'installed');
    const elsewhere = path.join(installed, 'data/pg-archive');
    // One upgrade. `archive` is where the running postgres binds /archive, empty with no such container; `pgbackup` the
    // sidecar's id in this run's Compose project, empty where it is not running; `container` the name Compose renders.
    const upgradeWith = ({ runningScript = script, archive = here, pgbackup = 'pgbackup-id', container = '', args = [], noEnv = '' } = {}) => {
      writeFileSync(dockerLog, '');
      writeFileSync(running, runningScript);
      const run = spawnSync(path.join(deployed, relative), ['--no-pull', ...args], {
        cwd: fixture,
        env: { ...env, ORBIT_FAKE_ARCHIVE: archive, ORBIT_FAKE_PGBACKUP: pgbackup, ORBIT_FAKE_POSTGRES: container, ORBIT_FAKE_NO_ENV: noEnv },
        encoding: 'utf8',
      });
      const calls = readFileSync(dockerLog, 'utf8').trim().split('\n');
      return {
        run,
        calls,
        ups: calls.filter((call) => call.startsWith('compose up ')),
        why: `${relative}\n${run.stdout}\n${run.stderr}`,
      };
    };
    // Stopped before it changed anything: no later call than the two questions of the check, and it says where to go.
    const assertRefused = (r) => {
      assert.notEqual(r.run.status, 0, r.why);
      assert.deepEqual(r.calls.filter((call) => /^(compose (build|pull|up|run)|tag|exec) /.test(call)), [], r.why);
      assert.equal(r.calls.at(-1).endsWith(' orbit-postgres'), true, r.why);
      assert.ok(r.run.stderr.includes(`this deployment runs from ${installed}, not from this checkout (${deployed})`), r.why);
      assert.ok(r.run.stderr.includes(`Nothing was pulled, built, tagged or recreated. Run the upgrade in ${installed}.`), r.why);
    };

    try {
      mkdirSync(path.dirname(path.join(deployed, relative)), { recursive: true });
      mkdirSync(path.join(deployed, 'scripts'));
      copyFileSync(path.join(repo, relative), path.join(deployed, relative));
      chmodSync(path.join(deployed, relative), 0o755);
      writeFileSync(path.join(deployed, 'scripts/pg-backup.sh'), script);
      git('init', '-q', '--initial-branch=main');
      git('add', '.');
      git('commit', '-q', '-m', 'install');

      // Nothing changed: `up` is asked, which recreates it only for a change of configuration, and it is never forced.
      let r = upgradeWith();
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.ups.at(-1), 'compose up -d --wait --no-deps pgbackup', r.why);
      assert.equal(r.ups.filter((up) => up.includes('pgbackup')).length, 1, r.why);

      // Only the script changed, which Compose cannot see: the container is recreated, and after the other services.
      r = upgradeWith({ runningScript: '#!/bin/sh\n# the sidecar, as the container started on it\n' });
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.ups.at(-1), 'compose up -d --wait --no-deps --force-recreate pgbackup', r.why);
      assert.ok(r.ups.length >= 2 && r.ups.at(-2).includes('apiserver'), r.why);

      // Never postgres: the default path's calls do not name it, and pgbackup's cannot bring it along.
      assert.deepEqual(r.ups.filter((up) => /\bpostgres\b/.test(up)), [], r.why);
      assert.deepEqual(r.ups.filter((up) => up.includes('pgbackup') && !up.includes('--no-deps')), [], r.why);

      // Anywhere else, whether or not this run's Compose project can see the sidecar, and with --pull-base too.
      assertRefused(upgradeWith({ archive: elsewhere }));
      assertRefused(upgradeWith({ archive: elsewhere, pgbackup: '' }));
      assertRefused(upgradeWith({ archive: elsewhere, args: ['--pull-base'] }));
      // Compose cannot render a worktree with no .env: the default name is asked instead of the check being skipped.
      assertRefused(upgradeWith({ archive: elsewhere, noEnv: '1' }));

      // A first install: no such container, so nothing to stop for.
      r = upgradeWith({ archive: '', pgbackup: '' });
      assert.equal(r.run.status, 0, r.why);
      assert.ok(r.calls.includes('compose build apiserver wiki-worker web'), r.why);

      // A separate deployment on the same Docker, the first deployment's container elsewhere: its containers have names of
      // their own, so it is held to its own /archive and goes ahead.
      r = upgradeWith({ archive: elsewhere, container: 'orbit-qa-postgres' });
      assert.equal(r.run.status, 0, r.why);
      assert.ok(r.calls.some((call) => call.endsWith(' orbit-qa-postgres')), r.why);
      assert.ok(!r.calls.some((call) => call.startsWith('inspect ') && call.endsWith(' orbit-postgres')), r.why);

      // A sidecar that is stopped here stays as its operator left it, and the run says so last of all.
      r = upgradeWith({ pgbackup: '' });
      assert.equal(r.run.status, 0, r.why);
      assert.deepEqual(r.ups.filter((up) => up.includes('pgbackup')), [], r.why);
      assert.match(r.run.stderr.trim().split('\n').slice(-2).join('\n'), /pgbackup was NOT updated/, r.why);
      assert.ok(r.run.stderr.includes(`run this in ${deployed}: docker compose up -d --no-deps --force-recreate pgbackup`), r.why);

      // --pull-base from the installed checkout still brings a changed script up to date, after its own recreate.
      r = upgradeWith({ runningScript: '#!/bin/sh\n# older\n', args: ['--pull-base'] });
      assert.equal(r.run.status, 0, r.why);
      assert.equal(r.ups.at(-1), 'compose up -d --wait --no-deps --force-recreate pgbackup', r.why);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
