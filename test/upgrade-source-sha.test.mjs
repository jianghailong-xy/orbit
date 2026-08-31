import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const upgrade = path.join(repo, '.claude/skills/upgrade/upgrade.sh');

test('documented full-stack builds resolve the source commit', () => {
  const documentation = [
    'README.md',
    'docs/self-hosting.md',
    'docs/postgres-conflict-runbook.md',
  ];
  let fullStackBuilds = 0;
  for (const relative of documentation) {
    for (const line of readFileSync(path.join(repo, relative), 'utf8').split('\n')) {
      if (!line.includes('docker compose up -d --build')) continue;
      if (line.trim().endsWith('--build')) {
        fullStackBuilds += 1;
        assert.match(line, /ORBIT_SOURCE_SHA="\$\(git rev-parse HEAD\)" docker compose/,
          `${relative} has a web build without its source revision`);
      }
    }
  }
  assert.ok(fullStackBuilds >= 4, 'expected fresh-install and upgrade build instructions');
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
