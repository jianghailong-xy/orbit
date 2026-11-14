import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `main`'s branch protection requires a check named `Dependency review`. On a pull request it comes
 * from .github/workflows/dependency-review.yml; on a branch verified by dispatching ci.yml it comes
 * from ci.yml's `dependency-review` job. Two rules make that safe, and this file holds both:
 *
 *  - ci.yml's job runs on a dispatch only, as the same check the pull request runs (the same pinned
 *    action and settings), against explicit refs: main as the job resolves it, and the run's commit;
 *  - on every other event its skipped job reports under another name, so no skipped check called
 *    `Dependency review` stands beside the pull request's real one, where its skip would pass. GitHub
 *    reports a skipped job's name expression unevaluated, as its text, which is never that name.
 *
 * The workflows are read as text: there is no YAML parser at the root, and the shapes checked here
 * are the plain block layout these two files use.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI = '.github/workflows/ci.yml';
const PR = '.github/workflows/dependency-review.yml';
const CONTEXT = 'Dependency review';
const ACTION = 'actions/dependency-review-action@';
const EVENTS = ['workflow_dispatch', 'pull_request', 'push'];

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The lines under one top-level key (`on:`, `jobs:`), up to the next top-level key. */
function block(source, top) {
  const lines = source.split('\n');
  const start = lines.indexOf(`${top}:`);
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    body.push(line);
  }
  return body;
}

/** The events a workflow is triggered by: the keys of its `on:` block. */
function eventsOf(source) {
  return (block(source, 'on') ?? []).flatMap((line) => /^  ([a-z_]+):/.exec(line)?.[1] ?? []);
}

/** A workflow's jobs, by id: each job's own lines. */
function jobsOf(source) {
  const jobs = new Map();
  let id = null;
  for (const line of block(source, 'jobs') ?? []) {
    const head = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) {
      id = head[1];
      jobs.set(id, []);
    } else if (id) {
      jobs.get(id).push(line);
    }
  }
  return jobs;
}

/** A job's own key (`name`, `if`), or null. */
function keyOf(lines, key) {
  for (const line of lines) {
    const match = new RegExp(`^    ${key}: (.*)$`).exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

/** Whether a job runs on `event`: only an `if:` of the form `github.event_name == '<e>'` is read as excluding one. */
function runsOn(lines, event) {
  const only = /^github\.event_name == '([a-z_]+)'$/.exec(keyOf(lines, 'if') ?? '');
  return only ? only[1] === event : true;
}

/**
 * The name a job's check reports under `event`, as GitHub reports it. A literal is itself. A name that is one
 * expression is evaluated only where the job runs; where its `if:` skips it, GitHub reports the expression's
 * own text without evaluating it (probe run 43607713030, a push: the skipped job's check was named
 * `github.event_name == 'workflow_dispatch' && 'Dependency review' || 'Dependency review (workflow_dispatch only)'`).
 * The one expression read here is `github.event_name == '<e>' && '<a>' || '<b>'`; any other comes back null,
 * a problem rather than a guess.
 */
function checkName(name, event, runs) {
  const inner = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(name)?.[1];
  if (inner === undefined) return name.includes('${{') ? null : name;
  if (!runs) return inner;
  const expression = /^github\.event_name == '([a-z_]+)' && '([^']*)' \|\| '([^']*)'$/.exec(inner);
  return expression ? (expression[1] === event ? expression[2] : expression[3]) : null;
}

/** The `with:` inputs of the step that uses `action` in a job, as key → value. */
function inputsOf(lines, action) {
  const at = lines.findIndex((line) => line.includes(`uses: ${action}`));
  if (at < 0) return null;
  const indent = /^(\s*)/.exec(lines[at])[1].length;
  const inputs = new Map();
  let inWith = false;
  for (const line of lines.slice(at + 1)) {
    const depth = /^(\s*)/.exec(line)[1].length;
    if (line.trim() === '') continue;
    if (depth < indent || /^\s*- /.test(line)) break;
    if (line.trim() === 'with:') {
      inWith = true;
      continue;
    }
    const pair = /^\s*([a-z-]+): (.*)$/.exec(line);
    if (inWith && pair) inputs.set(pair[1], pair[2].trim());
  }
  return inputs;
}

/** Everything wrong with the two workflows' `Dependency review` checks, or []. */
export function problems(ci, pr) {
  const found = [];

  // The pull request's own check: on pull requests alone, under exactly the required name.
  if (eventsOf(pr).join(',') !== 'pull_request') found.push(`${PR} must run on pull_request alone, not ${eventsOf(pr)}`);
  const prJobs = [...jobsOf(pr).values()];
  const prJob = prJobs.find((lines) => keyOf(lines, 'name') === CONTEXT);
  if (!prJob) found.push(`${PR} has no job named ${CONTEXT}`);
  const prUses = prJob?.find((line) => line.includes(`uses: ${ACTION}`))?.trim();
  const prInputs = prJob ? inputsOf(prJob, ACTION) : null;

  // ci.yml: dispatchable, and exactly one job running the action.
  const events = eventsOf(ci);
  for (const event of EVENTS) if (!events.includes(event)) found.push(`${CI} is no longer triggered by ${event}`);
  const jobs = jobsOf(ci);
  const reviewing = [...jobs].filter(([, lines]) => lines.some((line) => line.includes(`uses: ${ACTION}`)));
  if (reviewing.length !== 1) {
    found.push(`${CI} must run ${ACTION} in exactly one job, not ${reviewing.length}`);
    return found;
  }
  const [id, lines] = reviewing[0];

  if (keyOf(lines, 'if') !== "github.event_name == 'workflow_dispatch'") {
    found.push(`${CI} job ${id} must run on workflow_dispatch alone, not if: ${keyOf(lines, 'if')}`);
  }

  // No job of ci.yml reports `Dependency review` except this one, and this one only on a dispatch.
  for (const [jobId, jobLines] of jobs) {
    const name = keyOf(jobLines, 'name') ?? jobId;
    for (const event of EVENTS) {
      const reported = checkName(name, event, runsOn(jobLines, event));
      if (reported === null && name.includes(CONTEXT)) {
        found.push(`${CI} job ${jobId}'s name cannot be read: ${name}`);
      } else if (reported === CONTEXT && !(jobId === id && event === 'workflow_dispatch')) {
        found.push(`on ${event}, ${CI} job ${jobId} reports a check named ${CONTEXT}`);
      }
    }
  }
  if (checkName(keyOf(lines, 'name') ?? id, 'workflow_dispatch', runsOn(lines, 'workflow_dispatch')) !== CONTEXT) {
    found.push(`on workflow_dispatch, ${CI} job ${id} must report ${CONTEXT}`);
  }

  // The same check as the pull request's: the same pinned action and settings, refs passed explicitly.
  const uses = lines.find((line) => line.includes(`uses: ${ACTION}`)).trim();
  if (prUses && uses !== prUses) found.push(`${CI} uses ${uses}, but ${PR} uses ${prUses}`);
  const inputs = inputsOf(lines, ACTION);
  if (inputs.get('head-ref') !== '${{ github.sha }}') {
    found.push(`${CI} job ${id} must review the run's own commit (head-ref: \${{ github.sha }}), not ${inputs.get('head-ref')}`);
  }
  const base = /^\$\{\{ steps\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/.exec(inputs.get('base-ref') ?? '');
  if (!base) {
    found.push(`${CI} job ${id} must pass base-ref from the step that resolves main, not ${inputs.get('base-ref')}`);
  } else {
    const step = lines.findIndex((line) => line.trim() === `id: ${base[1]}`);
    const resolves = step >= 0 && lines.slice(step).some((line) => line.includes('commits/main'));
    if (!resolves) found.push(`${CI} job ${id}'s step ${base[1]} does not resolve main`);
  }
  for (const [key, value] of prInputs ?? []) {
    if (inputs.get(key) !== value) found.push(`${CI} job ${id} sets ${key}: ${inputs.get(key)}, but ${PR} sets ${value}`);
  }
  return found;
}

test("ci.yml's dispatch-only Dependency review is the pull request's check on the run's own commit", () => {
  assert.deepEqual(problems(read(CI), read(PR)), []);
});

test('the checks refuse the shapes that would let a skipped job pass for Dependency review', () => {
  const ci = read(CI);
  const pr = read(PR);
  const named = ci.match(/^    name: \$\{\{ github\.event_name == 'workflow_dispatch' && 'Dependency review' \|\| '[^']*' \}\}$/m)?.[0];
  assert.ok(named, 'the dispatch job is not named by the event');
  const guard = "    if: github.event_name == 'workflow_dispatch'\n";
  assert.ok(ci.includes(guard), 'the dispatch job has no workflow_dispatch guard');

  // Named Dependency review on every event: its skip on a pull request or a push would read as the check.
  const literal = problems(ci.replace(named, `    name: ${CONTEXT}`), pr);
  assert.ok(literal.some((p) => p.startsWith('on pull_request,')), literal.join('\n'));
  assert.ok(literal.some((p) => p.startsWith('on push,')), literal.join('\n'));

  // No guard: it would run on pull requests and pushes as well.
  assert.ok(problems(ci.replace(guard, ''), pr).some((p) => p.includes('must run on workflow_dispatch alone')));

  // Another head than the run's commit, or settings the pull request's check does not use.
  assert.ok(problems(ci.replace('head-ref: ${{ github.sha }}', 'head-ref: main'), pr).some((p) => p.includes('head-ref')));
  assert.ok(problems(ci.replace(/fail-on-severity: high/, 'fail-on-severity: critical'), pr).some((p) => p.includes('fail-on-severity')));

  // A second job reporting the context, or the pull request's workflow running on more than pull requests.
  const second = ci.replace('\n  dependency-audit:\n', `\n  impostor:\n    name: ${CONTEXT}\n    runs-on: ubuntu-latest\n\n  dependency-audit:\n`);
  assert.ok(problems(second, pr).some((p) => p.includes('job impostor reports a check named')));
  assert.ok(problems(ci, pr.replace('on:\n  pull_request:\n', 'on:\n  pull_request:\n  push:\n')).some((p) => p.includes('pull_request alone')));
});

test('the job reports what the probe runs saw: its text when skipped, Dependency review on a dispatch', () => {
  const [, lines] = [...jobsOf(read(CI))].find(([, job]) => job.some((line) => line.includes(`uses: ${ACTION}`)));
  const name = keyOf(lines, 'name');
  // Probe run 43607713030, a push: the skipped job's check was named by its expression's text.
  const skipped = "github.event_name == 'workflow_dispatch' && 'Dependency review' || 'Dependency review (workflow_dispatch only)'";
  for (const event of ['push', 'pull_request']) assert.equal(checkName(name, event, runsOn(lines, event)), skipped);
  // Probe run 43607986333, a dispatch: the job ran under the required name.
  assert.equal(checkName(name, 'workflow_dispatch', runsOn(lines, 'workflow_dispatch')), CONTEXT);
});
