#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tapPath, goJsonPath, capabilitiesPath, outputPath] = process.argv.slice(2);
if (!tapPath || !goJsonPath || !capabilitiesPath || !outputPath) {
  throw new Error('usage: outcome-reconciler-bootstrap-manifest.mjs TAP GO_JSON CLI_JSON OUTPUT');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tapSummary(source) {
  const read = (field) => {
    const matches = [...source.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`expected one TAP # ${field} summary`);
    return Number(matches[0][1]);
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
    cancelled: read('cancelled'),
    todo: read('todo'),
  };
}

function goSummary(source) {
  const terminal = new Map();
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) {
      terminal.set(`${event.Package}:${event.Test}`, event.Action);
    }
  }
  const actions = [...terminal.values()];
  return {
    tests: actions.length,
    pass: actions.filter((action) => action === 'pass').length,
    fail: actions.filter((action) => action === 'fail').length,
    skipped: actions.filter((action) => action === 'skip').length,
    cancelled: 0,
    todo: 0,
  };
}

const tapSource = readFileSync(tapPath, 'utf8');
const goSource = readFileSync(goJsonPath, 'utf8');
const ts = tapSummary(tapSource);
const go = goSummary(goSource);
const capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
const contractSource = readFileSync(path.join(root, 'contracts/runner-write-protocol.json'));
const contract = JSON.parse(contractSource.toString());
const contractDigest = sha256(contractSource);
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const targetBranch = execFileSync('git', ['branch', '--show-current'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

for (const [name, summary] of Object.entries({ typescript: ts, go })) {
  if (summary.tests <= 0 || summary.fail !== 0 || summary.skipped !== 0
      || summary.cancelled !== 0 || summary.todo !== 0 || summary.pass !== summary.tests) {
    throw new Error(`${name} summary is not a complete zero-skip pass: ${JSON.stringify(summary)}`);
  }
}
if (!Array.isArray(capabilities.capabilities) || capabilities.capabilities.length === 0
    || capabilities.capabilityCount !== capabilities.capabilities.length) {
  throw new Error('CLI capabilityCount is not derived from the emitted contract entries');
}
if (capabilities.capabilityRevision !== contract.capabilityRevision
    || capabilities.serverCapabilityRevision !== contract.capabilityRevision
    || capabilities.serverSchemaRevision !== contract.schemaRevision
    || capabilities.contractDigest !== contractDigest) {
  throw new Error('CLI and server contract revisions/digest disagree');
}

const executions = ts.tests + go.tests;
const skipped = ts.skipped + go.skipped;
const results = { typescript: ts, go };
const inputDigest = sha256(JSON.stringify({
  targetSha,
  contractDigest,
  suites: [
    'runner-write-protocol',
    'runner-tasks-controller',
    'bootstrap-delivery-fence',
    'task-done-writer-fence.pg',
    'task-status-derived-end-to-end.pg',
    'db-write-inventory',
    'runner-go-protocol',
  ],
}));
const resultDigest = sha256(JSON.stringify({
  results,
  capabilityCount: capabilities.capabilityCount,
  capabilityRevision: contract.capabilityRevision,
  schemaRevision: contract.schemaRevision,
}));
const manifest = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-bootstrap',
  outcome: 'PASS',
  targetSha,
  targetBranch,
  cliVersion: capabilities.cliVersion,
  cliCapabilityRevision: capabilities.capabilityRevision,
  cliSchemaRevision: capabilities.schemaVersion,
  serverCapabilityRevision: contract.capabilityRevision,
  serverSchemaRevision: contract.schemaRevision,
  contractDigest,
  capabilityCount: capabilities.capabilityCount,
  executions,
  skipped,
  failed: 0,
  results,
  sample: {
    database: process.env.BOOTSTRAP_DATABASE,
    databaseSystemIdentifier: process.env.BOOTSTRAP_DATABASE_SYSTEM_IDENTIFIER,
  },
  window: {
    startedAt: process.env.BOOTSTRAP_STARTED_AT,
    finishedAt: new Date().toISOString(),
  },
  inputDigest,
  resultDigest,
};
const withDigest = { ...manifest, manifestDigest: sha256(JSON.stringify(manifest)) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(withDigest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(withDigest)}\n`);
