import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [pgTapPath, webTapPath, domPath, screenshotPath, livePath, manifestPath] = process.argv.slice(2);
if (!manifestPath) throw new Error('six evidence paths are required');

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const repo = requiredEnv('WORK_OVERVIEW_REPO');
const baseSha = requiredEnv('WORK_OVERVIEW_BASE_SHA');
const targetSha = requiredEnv('WORK_OVERVIEW_TARGET_SHA');
const mainSha = requiredEnv('WORK_OVERVIEW_MAIN_SHA');
const repository = requiredEnv('WORK_OVERVIEW_REPOSITORY');
const sourceArchiveDigest = requiredEnv('WORK_OVERVIEW_SOURCE_ARCHIVE_DIGEST');
const webArtifactDigest = requiredEnv('WORK_OVERVIEW_WEB_ARTIFACT_DIGEST');
const deployedWebArtifactDigest = requiredEnv('WORK_OVERVIEW_DEPLOYED_WEB_ARTIFACT_DIGEST');
const provider = requiredEnv('WORK_OVERVIEW_PROVIDER');
const evidencePhase = requiredEnv('WORK_OVERVIEW_EVIDENCE_PHASE');
const deploymentTaskId = requiredEnv('WORK_OVERVIEW_DEPLOYMENT_TASK_ID');
const startedAt = requiredEnv('WORK_OVERVIEW_STARTED_AT');
const pgSystemIdentifier = requiredEnv('WORK_OVERVIEW_PG_SYSTEM_IDENTIFIER');
const migrationCount = Number(requiredEnv('WORK_OVERVIEW_MIGRATION_COUNT'));
const lastMigration = requiredEnv('WORK_OVERVIEW_LAST_MIGRATION');

if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(targetSha) || mainSha !== targetSha) {
  throw new Error(`target/main SHA mismatch target=${targetSha} main=${mainSha}`);
}
if (!/^[0-9a-f]{64}$/.test(sourceArchiveDigest)) throw new Error('source archive digest is invalid');
if (!/^[0-9a-f]{64}$/.test(webArtifactDigest)) throw new Error('Web artifact digest is invalid');
if (!['PREDEPLOY_EVALUATION', 'POSTDEPLOY_CURRENT_BINDING'].includes(evidencePhase)) {
  throw new Error(`unsupported work-overview evidence phase: ${evidencePhase}`);
}
if (evidencePhase === 'POSTDEPLOY_CURRENT_BINDING'
    && webArtifactDigest !== deployedWebArtifactDigest) {
  throw new Error('deployed Web artifact does not match the target build');
}
if (evidencePhase === 'PREDEPLOY_EVALUATION') {
  if (deployedWebArtifactDigest !== 'DEFERRED' || !/^[0-9A-Za-z]+$/.test(deploymentTaskId)) {
    throw new Error('predeploy evidence does not name its bound deployment task');
  }
}
const repositoryMigrations = readdirSync(
  `${repo}/src/apiserver/prisma/migrations`,
  { withFileTypes: true },
).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (
  migrationCount !== repositoryMigrations.length
  || lastMigration !== repositoryMigrations.at(-1)
) {
  throw new Error(`migration frontier ${lastMigration} (${migrationCount}) is not current`);
}

const pgTap = readFileSync(pgTapPath, 'utf8');
const webTap = readFileSync(webTapPath, 'utf8');
if (/^not ok\b/m.test(pgTap) || /^\s*not ok\b/m.test(webTap)) {
  throw new Error('test evidence contains a failure');
}
const pgTests = Number(pgTap.match(/^# tests (\d+)$/m)?.[1] ?? 0);
const pgPass = Number(pgTap.match(/^# pass (\d+)$/m)?.[1] ?? 0);
const pgSkipped = Number(pgTap.match(/^# skipped (\d+)$/m)?.[1] ?? -1);
const webLeafTests = [...webTap.matchAll(/^\s{8}ok \d+ - /gm)].length;
const webSkipped = [...webTap.matchAll(/# SKIP/g)].length;
if (pgTests !== 16 || pgPass !== 16 || pgSkipped !== 0) {
  throw new Error(`PostgreSQL test tally is ${pgPass}/${pgTests}, skipped=${pgSkipped}`);
}
if (webLeafTests !== 6 || webSkipped !== 0) {
  throw new Error(`Web test tally is ${webLeafTests}, skipped=${webSkipped}`);
}

const dom = JSON.parse(readFileSync(domPath, 'utf8'));
if (dom.viewport?.width !== 390 || dom.viewport?.height !== 844) {
  throw new Error('DOM evidence is not bound to a 390x844 phone viewport');
}
if (!Object.values(dom.assertions ?? {}).every(Boolean)) {
  throw new Error(`DOM assertion failed: ${JSON.stringify(dom.assertions)}`);
}

const screenshot = readFileSync(screenshotPath);
if (screenshot.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('phone screenshot is not PNG');
const screenshotWidth = screenshot.readUInt32BE(16);
const screenshotHeight = screenshot.readUInt32BE(20);
if (screenshotWidth !== 390 || screenshotHeight !== 844) {
  throw new Error(`phone screenshot is ${screenshotWidth}x${screenshotHeight}, expected 390x844`);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const live = JSON.parse(readFileSync(livePath, 'utf8'));
if (evidencePhase === 'PREDEPLOY_EVALUATION') {
  if (live.state !== 'DEFERRED_TO_BOUND_TASK' || live.taskId !== deploymentTaskId
      || live.readOnly !== true || live.noTaskWasStarted !== true) {
    throw new Error('predeploy live evidence boundary is incomplete');
  }
} else {
  if (live.task?.id !== '34EVtIlOD1lRdPL4c5j7E') throw new Error('live evidence names the wrong root task');
  if (live.task?.workState === 'READY' || live.assertions?.taskIsNotReady !== true) {
    throw new Error('live verification subject is still classified READY');
  }
  if (live.assertions?.noTaskWasStarted !== true || live.readOnly !== true) {
    throw new Error('live evidence did not attest its read-only boundary');
  }
  if (
    !Number.isInteger(live.taskWorkSessions?.before)
    || live.taskWorkSessions.before !== live.taskWorkSessions.after
  ) {
    throw new Error('live task-work session count changed during the read-only probe');
  }
  if (live.assertions?.bucketTotalMatchesTaskCount !== true) {
    throw new Error('live panorama buckets do not reconcile with taskCount');
  }
  if (live.assertions?.projectListMatchesPanorama !== true) {
    throw new Error('live project-list rollup does not match panorama');
  }
}

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', baseSha, targetSha]);
const changedFiles = git('diff', '--name-only', baseSha, targetSha)
  .split('\n').filter(Boolean);
const relevantFiles = changedFiles.filter((file) =>
  file === 'package.json'
  || file === 'docs/postgres-lock-order.md'
  || file.startsWith('scripts/outcome-reconciler-work-overview-readiness')
  || file === 'src/apiserver/src/common/db-write-inventory.ts'
  || file.startsWith('src/apiserver/prisma/migrations/')
  || file.startsWith('src/apiserver/src/projects/')
  || file.startsWith('src/apiserver/src/sessions/')
  || file.startsWith('src/apiserver/src/tasks/')
  || file.startsWith('src/web/src/'));
if (relevantFiles.length < 10) throw new Error('target commit does not contain the expected repair surface');
const sourceFiles = relevantFiles.map((path) => ({
  path,
  sha256: sha256(execFileSync('git', ['-C', repo, 'show', `${targetSha}:${path}`])),
}));
const sourceDigest = sha256(Buffer.from(sourceFiles.map((file) => `${file.sha256}  ${file.path}\n`).join('')));

const manifest = {
  schema: 'orbit.work-overview-readiness.manifest.v2',
  outcome: 'PASS',
  evidencePhase,
  repository,
  targetRef: 'refs/heads/main',
  targetSha,
  cleanTargetSha: mainSha,
  provider,
  verifiedAt: new Date().toISOString(),
  startedAt,
  source: {
    baseSha,
    gitTree: git('rev-parse', `${targetSha}^{tree}`),
    archiveSha256: sourceArchiveDigest,
    relevantSourceSha256: sourceDigest,
    files: sourceFiles,
  },
  tests: {
    count: pgTests + webLeafTests,
    passed: pgPass + webLeafTests,
    failed: 0,
    skipped: 0,
    postgres: { count: pgTests, passed: pgPass, skipped: pgSkipped },
    web: { count: webLeafTests, passed: webLeafTests, skipped: webSkipped },
    disposablePostgres: {
      systemIdentifier: pgSystemIdentifier,
      migrationCount,
      lastMigration,
      cleaned: true,
    },
  },
  web: {
    artifactSha256: webArtifactDigest,
    candidateArtifactVerified: true,
    requiredLabelsInCandidateAssets: [
      'Awaiting verification',
      'Verification failed',
      'Missing verifier',
    ],
    ...(evidencePhase === 'POSTDEPLOY_CURRENT_BINDING' ? {
      deployedArtifactSha256: deployedWebArtifactDigest,
      artifactMatchesDeployment: true,
      deployedImageId: requiredEnv('WORK_OVERVIEW_WEB_IMAGE_ID'),
      deployedContainerCreatedAt: requiredEnv('WORK_OVERVIEW_WEB_CREATED_AT'),
      deployedHttpReadable: true,
      requiredLabelsInDeployedAssets: [
        'Awaiting verification',
        'Verification failed',
        'Missing verifier',
      ],
    } : {
      deploymentVerification: { state: 'DEFERRED_TO_BOUND_TASK', taskId: deploymentTaskId },
    }),
    phoneViewport: {
      width: screenshotWidth,
      height: screenshotHeight,
      screenshotPath,
      screenshotSha256: sha256(screenshot),
      domPath,
      assertions: dom.assertions,
    },
  },
  deployment: evidencePhase === 'POSTDEPLOY_CURRENT_BINDING' ? {
    state: 'VERIFIED_CURRENT_BINDING',
    apiserverImageId: requiredEnv('WORK_OVERVIEW_API_IMAGE_ID'),
    apiserverContainerCreatedAt: requiredEnv('WORK_OVERVIEW_API_CREATED_AT'),
    webImageId: requiredEnv('WORK_OVERVIEW_WEB_IMAGE_ID'),
    webContainerCreatedAt: requiredEnv('WORK_OVERVIEW_WEB_CREATED_AT'),
    servicesHealthy: true,
    baseImagesRefreshed: false,
  } : {
    state: 'DEFERRED_TO_BOUND_TASK',
    taskId: deploymentTaskId,
    evaluatorMayDeploy: false,
  },
  liveFixture: live,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`work-overview manifest=${manifestPath} tests=${manifest.tests.count} skip=0 target=${targetSha} web=${webArtifactDigest}\n`);
