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
    };
    delete env.ORBIT_SOURCE_SHA;
    const run = spawnSync(upgrade, ['--allow-dirty'], {
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
    const build = calls.find(([, args]) => args === 'compose build apiserver web');
    assert.deepEqual(build, [head, 'compose build apiserver web']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
