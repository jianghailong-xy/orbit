#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from './outcome-reconciler-release-dag-lib.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const [action, ...args] = process.argv.slice(2);
const requiredEnvironment = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};
const binding = {
  targetSha: requiredEnvironment('OUTCOME_RELEASE_DAG_TARGET_SHA'),
  targetReceiptDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_TARGET_RECEIPT_DIGEST'),
  environmentDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_ENVIRONMENT_DIGEST'),
  evaluationPlanDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_EVALUATION_PLAN_DIGEST'),
  dagPlanDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_PLAN_DIGEST'),
  evidenceCutDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_EVIDENCE_CUT_DIGEST'),
  bindingDigest: requiredEnvironment('OUTCOME_RELEASE_DAG_BINDING_DIGEST'),
};

function writeJson(output, value) {
  const absolute = path.resolve(output);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8' }).trim();
}

function fileEvidence(file) {
  const absolute = path.resolve(file);
  assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `${file} is missing`);
  const raw = readFileSync(absolute);
  return { path: path.relative(repo, absolute), bytes: raw.byteLength, sha256: sha256(raw) };
}

function treeEvidence(directory) {
  const absolute = path.resolve(directory);
  assert.ok(existsSync(absolute) && statSync(absolute).isDirectory(), `${directory} is missing`);
  const found = execFileSync('find', [absolute, '-type', 'f', '-print'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).sort();
  assert.ok(found.length > 0, `${directory} contains no files`);
  const files = found.map((file) => fileEvidence(file));
  return {
    path: path.relative(repo, absolute),
    fileCount: files.length,
    treeDigest: sha256(canonical(files)),
  };
}

function tapMetrics(raw) {
  const count = (name) => [...raw.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))]
    .reduce((total, match) => total + Number(match[1]), 0);
  return {
    tests: count('tests'),
    passed: count('pass'),
    failed: count('fail'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    todo: count('todo'),
  };
}

if (action === 'preflight') {
  const [output] = args;
  assert.ok(output, 'usage: release-dag-step preflight OUTPUT');
  const head = git('rev-parse', 'HEAD');
  const originMain = git('rev-parse', 'refs/remotes/origin/main');
  assert.equal(head, binding.targetSha);
  assert.equal(originMain, binding.targetSha);
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=no'), '');
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-preflight',
    outcome: 'PASS',
    targetRef: 'refs/heads/main',
    ...binding,
    checkoutHead: head,
    originMain,
    trackedClean: true,
  };
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'dependency-context') {
  const [output, ...dependencies] = args;
  assert.ok(output && dependencies.length > 0,
    'usage: release-dag-step dependency-context OUTPUT PATH...');
  const resolved = dependencies.map((dependency) => {
    const absolute = path.join(repo, dependency);
    assert.ok(existsSync(absolute), `dependency path is missing: ${dependency}`);
    return {
      path: dependency,
      realpath: execFileSync('readlink', ['-f', absolute], { encoding: 'utf8' }).trim(),
    };
  });
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-dependency-context',
    outcome: 'PASS',
    ...binding,
    dependencies: resolved,
    dependencyDigest: sha256(canonical(resolved)),
    generatedAt: new Date().toISOString(),
  };
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'prisma-context') {
  const [output] = args;
  assert.ok(output, 'usage: release-dag-step prisma-context OUTPUT');
  const trees = [
    'src/apiserver/node_modules/@prisma/client',
    'src/apiserver/node_modules/.prisma/client',
  ].map((directory) => treeEvidence(path.join(repo, directory)));
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-prisma-context',
    outcome: 'PASS',
    ...binding,
    trees,
    treeDigest: sha256(canonical(trees)),
    generatedAt: new Date().toISOString(),
  };
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'build-context') {
  const [output, ...sources] = args;
  assert.ok(output && sources.length > 0,
    'usage: release-dag-step build-context OUTPUT SOURCE...');
  const evidence = sources.map((source) => fileEvidence(path.join(repo, source)));
  const buildOutputs = [
    'src/shared/dist/index.js',
    'src/apiserver/dist/main.js',
    'src/apiserver/node_modules/.prisma/client/schema.prisma',
    'src/apiserver/build/projects/project-work-overview-readiness.pg.spec.js',
    'src/web/dist/index.html',
  ].map((file) => fileEvidence(path.join(repo, file)));
  const buildTrees = [
    'src/shared/dist',
    'src/apiserver/dist',
    'src/apiserver/build',
    'src/apiserver/node_modules/.prisma/client',
    'src/web/dist',
  ].map((directory) => treeEvidence(path.join(repo, directory)));
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-build-context',
    outcome: 'PASS',
    ...binding,
    sources: evidence,
    sourceDigest: sha256(canonical(evidence)),
    outputs: buildOutputs,
    outputDigest: sha256(canonical(buildOutputs)),
    trees: buildTrees,
    treeDigest: sha256(canonical(buildTrees)),
    generatedAt: new Date().toISOString(),
  };
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'postgres-context') {
  const [output, container, admin, _password, host, port, systemIdentifier, version,
    migrations, beforeMigrations, lastMigration, currentTemplate, beforeOwnerRoutingTemplate,
    imageId, prismaFixturePath] = args;
  assert.ok(prismaFixturePath,
    'usage: release-dag-step postgres-context OUTPUT CONTAINER ADMIN PASSWORD HOST PORT SYSTEM VERSION MIGRATIONS BEFORE_MIGRATIONS LAST CURRENT BEFORE IMAGE_ID PRISMA_FIXTURE');
  assert.equal(_password, 'ord_disposable_password');
  const prismaFixture = JSON.parse(readFileSync(prismaFixturePath, 'utf8'));
  const { artifactDigest: fixtureArtifactDigest, ...fixtureBody } = prismaFixture;
  assert.equal(fixtureArtifactDigest, sha256(canonical(fixtureBody)));
  assert.equal(prismaFixture.outcome, 'PASS');
  assert.equal(prismaFixture.targetSha, binding.targetSha);
  assert.equal(prismaFixture.packageLock.target.sha256,
    fileEvidence(path.join(repo, 'package-lock.json')).sha256);
  assert.equal(prismaFixture.packageLock.target.sha256,
    prismaFixture.packageLock.installed.sha256);
  assert.equal(prismaFixture.packageLock.targetEqualsInstalled, true);
  assert.equal(prismaFixture.regression.reproducedBeforeRepair, true);
  assert.equal(prismaFixture.regression.absentAfterRepair, true);
  assert.equal(prismaFixture.regression.oldFailureFingerprint,
    "Cannot find module 'prisma/config'");
  assert.equal(prismaFixture.generatedClient.schema.sha256,
    prismaFixture.sources.formattedFixtureSchema.sha256);
  assert.equal(existsSync(prismaFixture.isolation.stage), false,
    'isolated Prisma stage was not removed after migration deployment');
  const repositoryMigrations = execFileSync('find', [
    path.join(repo, 'src/apiserver/prisma/migrations'),
    '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-printf', '%f\n',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-postgres-context',
    outcome: 'PASS',
    ...binding,
    container,
    admin,
    credential: 'FIXED_DISPOSABLE_LOOPBACK_ONLY',
    host,
    port: Number(port),
    systemIdentifier,
    version,
    migrations: Number(migrations),
    beforeMigrations: Number(beforeMigrations),
    lastMigration,
    migrationFrontier: {
      repositoryCount: repositoryMigrations.length,
      beforeOwnerRoutingCount: Number(beforeMigrations),
      currentCount: Number(migrations),
      lastMigration,
      ownerRoutingDeltaApplied: true,
    },
    currentTemplate,
    beforeOwnerRoutingTemplate,
    imageId,
    prismaFixture: {
      path: path.relative(repo, path.resolve(prismaFixturePath)),
      artifactDigest: fixtureArtifactDigest,
      packageLock: prismaFixture.packageLock,
      packages: prismaFixture.packages,
      regression: prismaFixture.regression,
      sources: prismaFixture.sources,
      generatedClient: prismaFixture.generatedClient,
      isolation: {
        ...prismaFixture.isolation,
        stageRemoved: true,
      },
    },
    generatedAt: new Date().toISOString(),
  };
  assert.equal(version, '16.14');
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(body.migrations >= 210);
  assert.equal(body.migrations, repositoryMigrations.length);
  assert.equal(body.beforeMigrations, body.migrations - 1);
  assert.equal(body.lastMigration, repositoryMigrations.at(-1));
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'full-api-inventory') {
  const [output] = args;
  assert.ok(output, 'usage: release-dag-step full-api-inventory OUTPUT');
  const apiBuild = path.join(repo, 'src/apiserver/build');
  const find = execFileSync('find', [apiBuild, '-mindepth', '2', '-maxdepth', '2',
    '-type', 'f', '-name', '*.spec.js'], { encoding: 'utf8' });
  const files = find.trim().split('\n').filter(Boolean).sort();
  assert.ok(files.length >= 300, `full API inventory is truncated: ${files.length}`);
  const serialPattern = /(task-(dispatch-epoch-aba|run-winner-recovery|completion-evidence)|judgment-delivery)\.pg\.spec\.js$/u;
  const specs = files.map((file, offset) => ({
    index: offset + 1,
    path: path.relative(repo, file),
    class: serialPattern.test(file) ? 'serial' : 'parallel',
    ...fileEvidence(file),
  }));
  const uniquePaths = new Set(specs.map((spec) => spec.path));
  assert.equal(uniquePaths.size, specs.length);
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-full-api-inventory',
    outcome: 'PASS',
    ...binding,
    selectionPolicy: 'EXHAUSTIVE_DISJOINT_PARTITION_WITHOUT_NAME_FILTER',
    shardCount: 4,
    totalSpecs: specs.length,
    parallelSpecs: specs.filter((spec) => spec.class === 'parallel').length,
    serialSpecs: specs.filter((spec) => spec.class === 'serial').length,
    specs,
    inventoryDigest: sha256(canonical(specs)),
  };
  writeJson(output, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'full-api-partition') {
  const [inventoryPath, partitionClass, indexText, countText, tapOutput, manifestOutput] = args;
  assert.ok(manifestOutput,
    'usage: release-dag-step full-api-partition INVENTORY parallel|serial INDEX COUNT TAP MANIFEST');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(inventory.bindingDigest, binding.bindingDigest);
  const index = Number(indexText);
  const count = Number(countText);
  assert.ok(partitionClass === 'serial' || (partitionClass === 'parallel'
    && Number.isInteger(index) && index >= 0 && index < count && count === inventory.shardCount));
  const selected = inventory.specs.filter((spec) => partitionClass === 'serial'
    ? spec.class === 'serial'
    : spec.class === 'parallel' && ((spec.index - 1) % count) === index);
  assert.ok(selected.length > 0, 'full API partition selected no specs');
  const caseRoot = path.join(requiredEnvironment('OUTCOME_RELEASE_DAG_RUN_ROOT'), 'full-api-cases');
  const chunks = selected.map((spec) => {
    const log = path.join(caseRoot, `${String(spec.index).padStart(4, '0')}.tap`);
    assert.ok(existsSync(log), `full API case ${spec.index} produced no TAP log`);
    return readFileSync(log, 'utf8');
  });
  mkdirSync(path.dirname(path.resolve(tapOutput)), { recursive: true });
  writeFileSync(tapOutput, chunks.join('\n'));
  const metrics = tapMetrics(chunks.join('\n'));
  assert.ok(metrics.tests > 0);
  assert.equal(metrics.passed, metrics.tests);
  assert.equal(metrics.failed, 0);
  assert.equal(metrics.cancelled, 0);
  assert.equal(metrics.skipped, 0);
  assert.equal(metrics.todo, 0);
  const body = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-full-api-partition',
    outcome: 'PASS',
    ...binding,
    partition: { class: partitionClass, index, count },
    inventoryDigest: inventory.inventoryDigest,
    specCount: selected.length,
    specIndices: selected.map((spec) => spec.index),
    summary: metrics,
    tapDigest: createHash('sha256').update(chunks.join('\n')).digest('hex'),
  };
  writeJson(manifestOutput, { ...body, artifactDigest: sha256(canonical(body)) });
} else if (action === 'full-api-combine') {
  const [inventoryPath, tapOutput, ...partitionPaths] = args;
  assert.ok(tapOutput && partitionPaths.length === 5,
    'usage: release-dag-step full-api-combine INVENTORY TAP FOUR_SHARDS SERIAL');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(inventory.bindingDigest, binding.bindingDigest);
  const partitions = partitionPaths.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  for (const partition of partitions) {
    assert.equal(partition.bindingDigest, binding.bindingDigest);
    assert.equal(partition.inventoryDigest, inventory.inventoryDigest);
    assert.equal(partition.outcome, 'PASS');
    assert.equal(partition.summary.failed, 0);
    assert.equal(partition.summary.skipped, 0);
  }
  const indices = partitions.flatMap((partition) => partition.specIndices).sort((a, b) => a - b);
  assert.deepEqual(indices, inventory.specs.map((spec) => spec.index),
    'Full API partitions are not an exhaustive one-time cover');
  assert.equal(new Set(indices).size, indices.length, 'a Full API spec was executed twice');
  const caseRoot = path.join(requiredEnvironment('OUTCOME_RELEASE_DAG_RUN_ROOT'), 'full-api-cases');
  const raw = inventory.specs.map((spec) => readFileSync(path.join(
    caseRoot, `${String(spec.index).padStart(4, '0')}.tap`,
  ), 'utf8')).join('\n');
  mkdirSync(path.dirname(path.resolve(tapOutput)), { recursive: true });
  writeFileSync(tapOutput, raw);
  const metrics = tapMetrics(raw);
  assert.equal(metrics.passed, metrics.tests);
  assert.equal(metrics.failed, 0);
  assert.equal(metrics.cancelled, 0);
  assert.equal(metrics.skipped, 0);
  assert.equal(metrics.todo, 0);
} else {
  throw new Error(`unknown release DAG step: ${action}`);
}
