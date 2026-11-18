#!/usr/bin/env node
// The dependency audit CI runs: `npm audit --audit-level=high`, except for the advisories
// scripts/npm-audit-allowlist.json names. An entry holds only while it is unexpired and the
// advisory's vulnerable range is still the one recorded: a patched release narrows the range, and
// the audit goes red again so the upgrade is made. Every other high or critical advisory fails.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIGH = new Set(['high', 'critical']);

/** The GHSA id an advisory's URL ends with. */
const idOf = (via) => String(via.url ?? '').split('/').pop();

/**
 * What the audit fails on: every high or critical advisory no current allowlist entry covers, and every
 * entry that no longer holds (expired, or its advisory's range moved). `today` is YYYY-MM-DD.
 */
export function judge(audit, allowlist, today) {
  const advisories = new Map();
  for (const vulnerability of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'object' && HIGH.has(via.severity)) advisories.set(idOf(via), via);
    }
  }
  const failures = [];
  const stale = [];
  for (const [id, via] of advisories) {
    const entry = allowlist.find((e) => e.advisory === id);
    if (!entry) {
      failures.push(`${via.severity} ${id} in ${via.name} (${via.range}): ${via.title}`);
    } else if (entry.expires < today) {
      failures.push(`${id} in ${via.name}: its exemption expired on ${entry.expires}; upgrade or renew it`);
    } else if (entry.range !== via.range) {
      failures.push(`${id} in ${via.name}: the vulnerable range is now ${via.range}, not ${entry.range}; `
        + 'a patched release likely exists, so upgrade and drop the exemption');
    }
  }
  for (const entry of allowlist) {
    if (!advisories.has(entry.advisory)) stale.push(`${entry.advisory} (${entry.package}) is no longer reported; remove its exemption`);
  }
  return { failures, stale, allowed: [...advisories.keys()].filter((id) => !failures.some((f) => f.includes(id))) };
}

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allowlist = JSON.parse(readFileSync(path.join(repo, 'scripts/npm-audit-allowlist.json'), 'utf8'));
  const run = spawnSync('npm', ['audit', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let audit;
  try {
    audit = JSON.parse(run.stdout);
  } catch {
    console.error(`npm audit gave no JSON (exit ${run.status}):\n${run.stderr}`);
    process.exit(2);
  }
  if (audit.error) {
    console.error(`npm audit failed: ${JSON.stringify(audit.error)}`);
    process.exit(2);
  }
  const { failures, stale, allowed } = judge(audit, allowlist, new Date().toISOString().slice(0, 10));
  console.log(`npm audit: ${JSON.stringify(audit.metadata?.vulnerabilities ?? {})}`);
  for (const id of allowed) console.log(`allowed by scripts/npm-audit-allowlist.json: ${id}`);
  for (const line of stale) console.log(`note: ${line}`);
  if (failures.length > 0) {
    for (const line of failures) console.error(`FAIL ${line}`);
    process.exit(1);
  }
  console.log('no high or critical advisory outside the allowlist');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
