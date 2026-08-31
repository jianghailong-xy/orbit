#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const [stageArgument, outputArgument] = process.argv.slice(2);
assert.ok(stageArgument && outputArgument,
  'usage: outcome-reconciler-release-dag-prisma-fixture.mjs STAGE OUTPUT');

const stage = path.resolve(stageArgument);
const output = path.resolve(outputArgument);
const installedRoot = path.resolve(
  process.env.OUTCOME_RELEASE_DAG_INSTALLED_ROOT ?? '/root/orbit',
);
const apiRelative = 'src/apiserver';
const stageApi = path.join(stage, apiRelative);
const targetLockPath = path.join(repo, 'package-lock.json');
const installedLockPath = path.join(installedRoot, 'package-lock.json');
const installedModulesLockPath = path.join(installedRoot, 'node_modules/.package-lock.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function fileDigest(file) {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function treeEvidence(root) {
  assert.ok(existsSync(root) && statSync(root).isDirectory(), `${root} is missing`);
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const info = lstatSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (info.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'symlink', target: realpathSync(absolute) });
      } else if (info.isFile()) {
        entries.push({ path: relative, kind: 'file', ...fileDigest(absolute) });
      }
    }
  };
  visit(root);
  assert.ok(entries.length > 0, `${root} has no files`);
  return {
    path: path.relative(stage, root),
    fileCount: entries.length,
    treeDigest: sha256(canonical(entries)),
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const targetLockRaw = readFileSync(targetLockPath);
const installedLockRaw = readFileSync(installedLockPath);
assert.equal(sha256(installedLockRaw), sha256(targetLockRaw),
  'installed dependency checkout does not match target package-lock.json');
const targetLock = JSON.parse(targetLockRaw.toString('utf8'));
assert.equal(targetLock.lockfileVersion, 3);
assert.ok(targetLock.packages && typeof targetLock.packages === 'object');

const packageKeys = Object.keys(targetLock.packages)
  .filter((key) => key.includes('node_modules/'))
  .sort((left, right) => right.length - left.length);

function packageKeyForResolvedFile(resolved) {
  const absolute = path.resolve(resolved);
  assert.ok(absolute.startsWith(`${installedRoot}${path.sep}`),
    `dependency escaped installed checkout: ${absolute}`);
  const relative = path.relative(installedRoot, absolute).split(path.sep).join('/');
  const key = packageKeys.find((candidate) => (
    relative === candidate || relative.startsWith(`${candidate}/`)
  ));
  assert.ok(key, `resolved dependency is absent from target lock: ${relative}`);
  return key;
}

function resolveDependency(fromKey, dependency) {
  const source = path.join(installedRoot, fromKey);
  const resolver = createRequire(path.join(source, 'package.json'));
  for (const searchRoot of resolver.resolve.paths(dependency) ?? []) {
    const packageRoot = path.join(searchRoot, dependency);
    if (existsSync(path.join(packageRoot, 'package.json'))) {
      return packageKeyForResolvedFile(path.join(packageRoot, 'package.json'));
    }
  }
  return null;
}

const roots = [
  'src/apiserver/node_modules/prisma',
  'src/apiserver/node_modules/@prisma/client',
  'src/apiserver/node_modules/typescript',
  'node_modules/dotenv',
];
for (const key of roots) assert.ok(targetLock.packages[key], `target lock omits ${key}`);

const closure = new Set();
const queue = [...roots];
while (queue.length > 0) {
  const key = queue.shift();
  if (closure.has(key)) continue;
  closure.add(key);
  const entry = targetLock.packages[key];
  assert.ok(entry, `target lock omits dependency closure member ${key}`);
  const dependencyNames = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ]);
  for (const dependency of [...dependencyNames].sort()) {
    const resolvedKey = resolveDependency(key, dependency);
    if (resolvedKey && !closure.has(resolvedKey)) queue.push(resolvedKey);
  }
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stageApi, { recursive: true });
copyFileSync(path.join(repo, 'package.json'), path.join(stage, 'package.json'));
copyFileSync(targetLockPath, path.join(stage, 'package-lock.json'));
copyFileSync(path.join(repo, apiRelative, 'package.json'), path.join(stageApi, 'package.json'));
copyFileSync(path.join(repo, apiRelative, 'prisma.config.ts'), path.join(stageApi, 'prisma.config.ts'));
execFileSync('cp', [
  '-a', '--reflink=auto', path.join(repo, apiRelative, 'prisma'), path.join(stageApi, 'prisma'),
]);

const fixtureRequire = createRequire(path.join(stageApi, 'prisma.config.ts'));
let legacyFailure;
try {
  fixtureRequire.resolve('prisma/config');
} catch (error) {
  legacyFailure = error;
}
assert.equal(legacyFailure?.code, 'MODULE_NOT_FOUND');
assert.match(legacyFailure.message, /Cannot find module 'prisma\/config'/u);

const copiedPackages = [];
for (const key of [...closure].sort()) {
  const source = path.join(installedRoot, key);
  const destination = path.join(stage, key);
  const lockEntry = targetLock.packages[key];
  assert.ok(existsSync(path.join(source, 'package.json')), `installed package is missing: ${key}`);
  const installedPackage = readJson(path.join(source, 'package.json'));
  assert.equal(installedPackage.version, lockEntry.version, `${key} version differs from target lock`);
  mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', source, destination]);
  copiedPackages.push({
    lockKey: key,
    name: installedPackage.name,
    version: installedPackage.version,
    integrity: lockEntry.integrity ?? null,
  });
}

const prismaConfigResolution = fixtureRequire.resolve('prisma/config');
const clientPackage = path.join(stageApi, 'node_modules/@prisma/client/package.json');
const prismaPackage = path.join(stageApi, 'node_modules/prisma/package.json');
for (const resolved of [prismaConfigResolution, clientPackage, prismaPackage]) {
  assert.ok(realpathSync(resolved).startsWith(`${stage}${path.sep}`),
    `isolated Prisma fixture resolved outside itself: ${resolved}`);
  assert.ok(!realpathSync(resolved).startsWith(`${installedRoot}${path.sep}`));
}

const prismaCli = path.join(stageApi, 'node_modules/prisma/build/index.js');
execFileSync(process.execPath, [prismaCli, 'format', '--schema', 'prisma/schema.prisma'], {
  cwd: stageApi,
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
execFileSync(process.execPath, [prismaCli, 'generate', '--config', 'prisma.config.ts'], {
  cwd: stageApi,
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const generatedClient = path.join(stageApi, 'node_modules/.prisma/client');
const generatedSchema = path.join(generatedClient, 'schema.prisma');
assert.ok(existsSync(generatedSchema), 'isolated Prisma Client was not generated');
assert.deepEqual(fileDigest(generatedSchema), fileDigest(path.join(stageApi, 'prisma/schema.prisma')),
  'generated Prisma Client is not bound to the target schema');

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.release-dag-isolated-prisma-fixture',
  outcome: 'PASS',
  targetSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  isolation: {
    stage,
    installedRoot,
    runtimeResolutionUsesInstalledRoot: false,
    runtimeResolutionUsesRepositoryNodeModules: false,
  },
  packageLock: {
    target: { path: 'package-lock.json', ...fileDigest(targetLockPath) },
    installed: { path: installedLockPath, ...fileDigest(installedLockPath) },
    installedNodeModules: {
      path: installedModulesLockPath,
      ...fileDigest(installedModulesLockPath),
    },
    targetEqualsInstalled: true,
    lockfileVersion: targetLock.lockfileVersion,
  },
  packages: {
    roots,
    closureCount: copiedPackages.length,
    closureDigest: sha256(canonical(copiedPackages)),
    copied: copiedPackages,
    prisma: {
      ...readJson(prismaPackage),
      resolvedConfig: path.relative(stage, prismaConfigResolution),
    },
    client: readJson(clientPackage),
  },
  regression: {
    oldFailureFingerprint: "Cannot find module 'prisma/config'",
    reproducedBeforeRepair: true,
    absentAfterRepair: true,
    repairedResolution: path.relative(stage, prismaConfigResolution),
  },
  sources: {
    config: { path: `${apiRelative}/prisma.config.ts`, ...fileDigest(path.join(stageApi, 'prisma.config.ts')) },
    targetSchema: { path: `${apiRelative}/prisma/schema.prisma`, ...fileDigest(path.join(repo, apiRelative, 'prisma/schema.prisma')) },
    formattedFixtureSchema: { path: `${apiRelative}/prisma/schema.prisma`, ...fileDigest(path.join(stageApi, 'prisma/schema.prisma')) },
  },
  generatedClient: {
    schema: { path: path.relative(stage, generatedSchema), ...fileDigest(generatedSchema) },
    tree: treeEvidence(generatedClient),
  },
  generatedAt: new Date().toISOString(),
};
const manifest = { ...body, artifactDigest: sha256(canonical(body)) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  outcome: manifest.outcome,
  targetSha: manifest.targetSha,
  packageLockDigest: manifest.packageLock.target.sha256,
  closureCount: manifest.packages.closureCount,
  generatedClientDigest: manifest.generatedClient.tree.treeDigest,
  oldFailureFingerprintAbsent: manifest.regression.absentAfterRepair,
  manifest: output,
}));
