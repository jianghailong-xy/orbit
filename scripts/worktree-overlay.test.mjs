import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise the real entry point and real, offline npm installs. Only the heavyweight build
// tools are tiny fixture packages; npm, Git, symlinks, locks and package resolution are real.
const scripts = import.meta.dirname;
const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-overlay-test-'));
const main = path.join(scratch, 'main');
const env = {
  ...process.env,
  npm_config_cache: path.join(scratch, 'cache'),
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function run(cwd, command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000,
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function ok(cwd, command, args, extraEnv) {
  const result = run(cwd, command, args, extraEnv);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.output}\n${result.error ?? ''}`);
  return result.stdout.trim();
}

function write(where, body) {
  mkdirSync(path.dirname(where), { recursive: true });
  writeFileSync(where, body);
}

function json(where, value) {
  write(where, `${JSON.stringify(value, null, 2)}\n`);
}

function pack(name, files, extra = {}) {
  const directory = path.join(scratch, 'packages', name.replaceAll('/', '-'));
  json(path.join(directory, 'package.json'), { name, version: '1.0.0', ...extra });
  for (const [file, body] of Object.entries(files)) {
    write(path.join(directory, file), body);
    if (body.startsWith('#!')) chmodSync(path.join(directory, file), 0o755);
  }
  const packed = JSON.parse(ok(directory, 'npm', ['pack', '--json', '--pack-destination', path.join(main, 'fixtures')]))[0];
  return `file:fixtures/${packed.filename}`;
}

function commit(tree) {
  ok(tree, 'git', ['add', '.']);
  ok(tree, 'git', ['commit', '-qm', 'fixture']);
}

function candidate(name, addDependency = false) {
  const tree = path.join(scratch, name);
  ok(main, 'git', ['worktree', 'add', '--quiet', '--detach', tree, 'HEAD']);
  if (addDependency) {
    const manifest = path.join(tree, 'src/web/package.json');
    const pkg = JSON.parse(readFileSync(manifest));
    pkg.dependencies['@fixture/new-dependency'] = newDependency.replace('file:', 'file:../../');
    json(manifest, pkg);
    ok(tree, 'npm', ['install', '--package-lock-only', '--ignore-scripts']);
    commit(tree);
  }
  return tree;
}

function fingerprint() {
  const hash = createHash('sha256');
  function walk(where) {
    if (!existsSync(where)) return;
    const stat = lstatSync(where);
    hash.update(path.relative(main, where));
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update(readlinkSync(where));
    else if (stat.isDirectory()) for (const name of readdirSync(where).sort()) walk(path.join(where, name));
    else hash.update(readFileSync(where));
  }
  for (const location of ['node_modules', 'src/apiserver/node_modules', 'src/shared/node_modules', 'src/web/node_modules', 'src/shared/dist']) {
    walk(path.join(main, location));
  }
  return hash.digest('hex');
}

function clean(tree) {
  assert.equal(ok(tree, 'git', ['status', '--porcelain', '--untracked-files=no']), '', 'preparation changed tracked files');
}

function resolve(tree, workspace, specifier) {
  return ok(path.join(tree, workspace), 'node', ['-p', `require.resolve(${JSON.stringify(specifier)})`]);
}

function local(tree, where) {
  assert.ok(realpathSync(where).startsWith(`${tree}/`), `${where} escaped this worktree`);
}

function isolatedArtifacts(tree) {
  for (const workspace of ['src/apiserver', 'src/web']) {
    assert.equal(resolve(tree, workspace, '@orbit/shared'), path.join(tree, 'src/shared/dist/index.js'));
  }
  local(tree, resolve(tree, 'src/apiserver', '@prisma/client'));
  assert.ok(existsSync(path.join(tree, 'src/apiserver/node_modules/.prisma/client/index.d.ts')));
  for (const cache of ['.vite', '.vite-temp']) {
    const cachePath = path.join(tree, 'src/web/node_modules', cache);
    mkdirSync(cachePath, { recursive: true });
    write(path.join(cachePath, 'candidate-only'), 'local cache');
    local(tree, cachePath);
  }
}

let newDependency;
test('worktree overlay prepares lockfile dependencies without changing the shared installation', async (t) => {
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(path.join(main, 'fixtures'), { recursive: true });
  const typescript = pack('typescript', {
    'tsc.cjs': `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('Version fixture'); process.exit(0); }
const shared = path.dirname(process.argv[process.argv.indexOf('-p') + 1]);
fs.mkdirSync(path.join(shared, 'dist'), { recursive: true });
fs.writeFileSync(path.join(shared, 'dist/index.js'), 'module.exports = "fixture shared";\\n');
`,
  }, { bin: { tsc: 'tsc.cjs' } });
  const prisma = pack('prisma', {
    'prisma.cjs': `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'generate') process.exit(1);
const generated = path.join(process.cwd(), 'node_modules/.prisma/client');
fs.mkdirSync(generated, { recursive: true });
fs.writeFileSync(path.join(generated, 'index.d.ts'), '// generated fixture client\\n');
`,
  }, { bin: { prisma: 'prisma.cjs' } });
  const client = pack('@prisma/client', { 'index.js': 'module.exports = {};\n' }, { main: 'index.js' });
  newDependency = pack('@fixture/new-dependency', {
    'button.js': 'module.exports = "new button";\n',
    'dialog.js': 'module.exports = "new dialog";\n',
  }, { exports: { './button': './button.js', './dialog': './dialog.js' } });
  const optionalDependency = pack('@fixture/optional', { 'index.js': 'module.exports = "optional";\n' });
  json(path.join(main, 'package.json'), {
    name: 'overlay-fixture', private: true,
    workspaces: ['src/shared', 'src/apiserver', 'src/web'],
    devDependencies: { typescript, prisma, '@prisma/client': client },
  });
  for (const workspace of ['shared', 'apiserver', 'web']) {
    json(path.join(main, `src/${workspace}/package.json`), {
      name: `@orbit/${workspace}`, version: '1.0.0', main: 'dist/index.js', dependencies: {},
    });
  }
  json(path.join(main, 'src/shared/tsconfig.json'), {});
  write(path.join(main, 'src/apiserver/prisma/schema.prisma'), '// fixture schema\n');
  write(path.join(main, '.gitignore'), 'node_modules/\ndist/\n');
  mkdirSync(path.join(main, 'scripts'));
  for (const file of ['worktree-overlay.sh', 'worktree-dependencies.mjs']) {
    if (existsSync(path.join(scripts, file))) copyFileSync(path.join(scripts, file), path.join(main, 'scripts', file));
  }
  ok(main, 'npm', ['install', '--ignore-scripts']);
  ok(main, 'node_modules/.bin/tsc', ['-p', 'src/shared/tsconfig.json']);
  for (const location of ['node_modules/.cache', 'src/apiserver/node_modules', 'src/shared/node_modules', 'src/web/node_modules/.vite', 'src/web/node_modules/.vite-temp']) {
    write(path.join(main, location, 'shared-sentinel'), 'must not change');
  }
  ok(main, 'git', ['init', '--quiet']);
  ok(main, 'git', ['config', 'user.email', 'fixture@example.invalid']);
  ok(main, 'git', ['config', 'user.name', 'Overlay fixture']);
  commit(main);

  await t.test('compatible lock reuses packages but keeps shared, Prisma and Vite artifacts local', () => {
    const tree = candidate('compatible');
    const before = fingerprint();
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    assert.equal(resolve(tree, 'src/web', 'typescript/package.json'), path.join(main, 'node_modules/typescript/package.json'));
    isolatedArtifacts(tree);
    const generated = path.join(tree, 'src/apiserver/node_modules/.prisma/client/index.d.ts');
    const generatedTime = lstatSync(generated).mtimeMs;
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    assert.equal(lstatSync(generated).mtimeMs, generatedTime);
    assert.ok(existsSync(path.join(tree, 'src/web/node_modules/.vite/candidate-only')));
    clean(tree);
    assert.equal(fingerprint(), before);
  });

  await t.test('an old shared root overlay cannot retain stale real workspace packages', () => {
    const tree = candidate('stale-workspace');
    symlinkSync(path.join(main, 'node_modules'), path.join(tree, 'node_modules'));
    json(path.join(tree, 'src/web/node_modules/typescript/package.json'), { name: 'typescript', version: '0.0.0' });
    const before = fingerprint();
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    assert.equal(resolve(tree, 'src/web', 'typescript/package.json'), path.join(main, 'node_modules/typescript/package.json'));
    isolatedArtifacts(tree);
    clean(tree);
    assert.equal(fingerprint(), before);
  });

  await t.test('a stale private package cannot shadow a compatible shared installation', () => {
    const tree = candidate('stale-private');
    ok(tree, 'npm', ['ci', '--ignore-scripts']);
    const manifest = path.join(tree, 'node_modules/typescript/package.json');
    const pkg = JSON.parse(readFileSync(manifest));
    pkg.version = '0.0.0';
    json(manifest, pkg);
    const before = fingerprint();
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    assert.equal(resolve(tree, 'src/web', 'typescript/package.json'), path.join(main, 'node_modules/typescript/package.json'));
    isolatedArtifacts(tree);
    clean(tree);
    assert.equal(fingerprint(), before);
  });

  await t.test('new locked dependency installs privately and a second preparation preserves local artifacts', () => {
    const tree = candidate('new-dependency', true);
    const before = fingerprint();
    assert.notEqual(run(path.join(main, 'src/web'), 'node', ['-p', 'require.resolve("@fixture/new-dependency/button")']).status, 0);
    ok(tree, 'bash', ['scripts/worktree-overlay.sh'], { NODE_ENV: 'production' });
    for (const subpath of ['button', 'dialog']) local(tree, resolve(tree, 'src/web', `@fixture/new-dependency/${subpath}`));
    local(tree, resolve(tree, 'src/web', 'typescript/package.json'));
    local(tree, path.join(tree, 'node_modules/.bin/tsc'));
    write(path.join(tree, 'node_modules/.cache/candidate-only'), 'private cache');
    local(tree, path.join(tree, 'node_modules/.cache'));
    isolatedArtifacts(tree);
    clean(tree);
    assert.equal(fingerprint(), before);
    const generated = path.join(tree, 'src/apiserver/node_modules/.prisma/client/index.d.ts');
    const generatedTime = lstatSync(generated).mtimeMs;
    write(path.join(tree, 'node_modules/rerun-sentinel'), 'keep the compatible local install');
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    assert.equal(readFileSync(path.join(tree, 'node_modules/rerun-sentinel'), 'utf8'), 'keep the compatible local install');
    assert.equal(lstatSync(generated).mtimeMs, generatedTime);
    assert.ok(existsSync(path.join(tree, 'src/web/node_modules/.vite/candidate-only')));
    isolatedArtifacts(tree);
    clean(tree);
    assert.equal(fingerprint(), before);
  });

  await t.test('failed real npm ci cannot write through existing root, workspace, scope or bin links', () => {
    const tree = candidate('failed-install', true);
    write(path.join(tree, newDependency.slice('file:'.length)), 'invalid tarball');
    commit(tree);
    symlinkSync(path.join(main, 'node_modules'), path.join(tree, 'node_modules'));
    symlinkSync(path.join(main, 'node_modules'), path.join(tree, 'src/node_modules'));
    for (const workspace of ['shared', 'web']) {
      symlinkSync(path.join(main, `src/${workspace}/node_modules`), path.join(tree, `src/${workspace}/node_modules`));
    }
    mkdirSync(path.join(tree, 'src/apiserver/node_modules'));
    for (const name of ['.bin', '@prisma']) {
      symlinkSync(path.join(main, 'node_modules', name), path.join(tree, 'src/apiserver/node_modules', name));
    }
    const before = fingerprint();
    const result = run(tree, 'bash', ['scripts/worktree-overlay.sh'], { npm_config_cache: path.join(scratch, 'empty-cache') });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /npm (?:error|ERR!)/, 'failure must come from the attempted real npm install');
    assert.equal(fingerprint(), before);
    clean(tree);
  });

  await t.test('npm may omit a failed optional package while installing and reusing required dependencies', () => {
    const tree = candidate('optional-missing', true);
    const manifest = path.join(tree, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest));
    pkg.optionalDependencies = { '@fixture/optional': optionalDependency };
    json(manifest, pkg);
    ok(tree, 'npm', ['install', '--package-lock-only', '--ignore-scripts']);
    assert.equal(JSON.parse(readFileSync(path.join(tree, 'package-lock.json'))).packages['node_modules/@fixture/optional'].optional, true);
    write(path.join(tree, optionalDependency.slice('file:'.length)), 'invalid optional tarball');
    commit(tree);
    const before = fingerprint();
    const freshCache = { npm_config_cache: path.join(scratch, 'optional-cache') };
    ok(tree, 'bash', ['scripts/worktree-overlay.sh'], freshCache);
    local(tree, resolve(tree, 'src/web', '@fixture/new-dependency/button'));
    assert.equal(existsSync(path.join(tree, 'node_modules/@fixture/optional')), false);
    assert.equal(JSON.parse(readFileSync(path.join(tree, 'node_modules/.package-lock.json'))).packages['node_modules/@fixture/optional'], undefined);
    isolatedArtifacts(tree);
    write(path.join(tree, 'node_modules/rerun-sentinel'), 'reuse optional omission');
    ok(tree, 'bash', ['scripts/worktree-overlay.sh'], freshCache);
    assert.equal(readFileSync(path.join(tree, 'node_modules/rerun-sentinel'), 'utf8'), 'reuse optional omission');
    clean(tree);
    assert.equal(fingerprint(), before);
  });

  await t.test('an extra nested package in the shared installation cannot shadow the locked root version', () => {
    const typescript2 = pack('typescript', { 'index.js': '// nested version\n' }, { version: '2.0.0' });
    const mainManifest = path.join(main, 'src/web/package.json');
    const web = JSON.parse(readFileSync(mainManifest));
    web.dependencies.typescript = typescript2.replace('file:', 'file:../../');
    json(mainManifest, web);
    ok(main, 'npm', ['install', '--ignore-scripts']);
    commit(main);
    assert.equal(JSON.parse(readFileSync(resolve(main, 'src/web', 'typescript/package.json'))).version, '2.0.0');
    const tree = candidate('extra-shared-package');
    delete web.dependencies.typescript;
    json(path.join(tree, 'src/web/package.json'), web);
    ok(tree, 'npm', ['install', '--package-lock-only', '--ignore-scripts']);
    commit(tree);
    const before = fingerprint();
    ok(tree, 'bash', ['scripts/worktree-overlay.sh']);
    const resolved = resolve(tree, 'src/web', 'typescript/package.json');
    local(tree, resolved);
    assert.equal(JSON.parse(readFileSync(resolved)).version, '1.0.0');
    isolatedArtifacts(tree);
    clean(tree);
    assert.equal(fingerprint(), before);
  });
});
