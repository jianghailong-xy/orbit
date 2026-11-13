import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The release skill ships twice: .claude/skills/release for Claude Code and .agents/skills/release for
 * every other engine. Both must follow the single-version rule (scripts/release-identity.mjs): the root
 * package version is the version of record, `next` resolves from it alone, and tagging passes the same
 * identity gate CI runs.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPERS = ['.claude/skills/release/release.sh', '.agents/skills/release/scripts/release.sh'];
const SKILLS = ['.claude/skills/release/SKILL.md', '.agents/skills/release/SKILL.md'];

test('the .agents release helper is the .claude one, byte for byte', () => {
  const [claude, agents] = HELPERS.map((p) => readFileSync(join(ROOT, p)));
  assert.ok(claude.equals(agents), `${HELPERS[1]} differs from ${HELPERS[0]}`);
});

test('both release skills state the package-version rule and none resolves next from old tags', () => {
  for (const p of SKILLS) {
    const text = readFileSync(join(ROOT, p), 'utf8');
    assert.match(text, /version of record/, `${p} does not name package.json as the version of record`);
    assert.match(text, /bump next/, `${p} does not describe bump next`);
    assert.match(text, /`identity`/, `${p} does not list the identity job`);
    assert.doesNotMatch(text, /versionsort|tag --list/, `${p} still reads next from the tag sequence`);
  }
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A throwaway repository shaped like this one, whose origin is a local bare repository. */
function fixture(version) {
  const dir = mkdtempSync(join(tmpdir(), 'release-skill-'));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'remote', 'add', 'origin', origin);
  for (const p of [...HELPERS, 'scripts/release-identity.mjs']) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    copyFileSync(join(ROOT, p), join(repo, p));
  }
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'orbit', version }, null, 2) + '\n');
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'orbit', version, packages: { '': { version } } }, null, 2) + '\n');
  mkdirSync(join(repo, 'release-notes'));
  copyFileSync(join(ROOT, 'release-notes/0.1.257-beta.1.md'), join(repo, 'release-notes', `${version}.md`));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'release commit');
  // The old tag line: a tag-sequence resolver would answer v0.1.2-beta.247 here.
  git(repo, 'tag', '-a', 'v0.1.2-beta.246', '-m', 'old');
  git(repo, 'push', '-q', 'origin', 'main', 'v0.1.2-beta.246');
  return { dir, repo, origin };
}

function run(repo, helper, ...args) {
  return spawnSync('bash', [join(repo, helper), ...args], { cwd: repo, encoding: 'utf8' });
}

for (const helper of HELPERS) {
  test(`${helper}: next resolves exactly the untagged package version, then the beta after it`, () => {
    const { dir, repo, origin } = fixture('0.1.257-beta.1');
    try {
      let r = run(repo, helper, 'next');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'v0.1.257-beta.1\n');

      const head = git(repo, 'rev-parse', 'HEAD');
      r = run(repo, helper, 'bump', 'next');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'bump next on an untagged package version committed');

      // Once the candidate is tagged on origin only, the next beta opens.
      git(origin, 'tag', 'v0.1.257-beta.1', 'main');
      r = run(repo, helper, 'next');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'v0.1.257-beta.2\n');
      assert.equal(git(repo, 'tag', '--list', 'v0.1.257-beta.2'), '', 'next created a tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${helper}: tagging passes the identity gate, which refuses a version package.json does not carry`, () => {
    const { dir, repo, origin } = fixture('0.1.257-beta.1');
    try {
      const r = run(repo, helper, '0.1.2-beta.247');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr + r.stdout, /0\.1\.257-beta\.1/);
      assert.equal(git(repo, 'tag', '--list', 'v0.1.2-beta.247'), '');
      assert.equal(git(origin, 'tag', '--list', 'v0.1.2-beta.247'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
