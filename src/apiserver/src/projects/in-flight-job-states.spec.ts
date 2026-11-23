import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { IN_FLIGHT_JOB_STATES, RUNNER_JOB_STATES, isInFlightJobState } from './in-flight-job-states';

/**
 * One list of the states a landing is in flight in (docs/design/protected-branch-landing.md §4.2). A job waiting on its
 * pull request is in flight — J3's index, a criterion's IN_FLIGHT, the landing view and every door that asks "is this
 * landing still moving" count it — and a reader that spells `QUEUED, RUNNING` itself leaves it out without saying so.
 * This census reads the apiserver's source and fails on any such spelling outside the readers listed here, each with
 * the reason it is not about a landing in flight.
 */

const SRC = path.resolve(__dirname, '..', '..', 'src');

/** The files that may spell the two states together, and why. */
const NOT_IN_FLIGHT_READERS: Readonly<Record<string, string>> = {
  'projects/in-flight-job-states.ts': 'the lists themselves: the in-flight one, and the runner-work one beside it',
  'projects/project-criterion-landing.ts': 'JOB_SAID_NOTHING_ABOUT_THE_BRANCH, an allowlist of states the line never reported on the branch in; a job '
    + 'waiting on its pull request did report, and stays out of it on purpose',
  'projects/project-ready-to-run.ts': 'a session\'s run state, not an integration job\'s',
  'schedules/schedule-reads.service.ts': 'a schedule run\'s state, not an integration job\'s',
  'schedules/schedule-start-check.ts': 'a schedule run\'s state, not an integration job\'s',
};

const PAIR = /'(QUEUED|RUNNING)',\s*'(QUEUED|RUNNING)'/;
const EITHER = /=== '(QUEUED|RUNNING)' \|\| [\w.?]+ === '(QUEUED|RUNNING)'/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith('.ts') && !name.includes('.spec.') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('PULL_REQUEST is in flight, and the runner-work list is the in-flight list without it', () => {
  assert.deepEqual([...IN_FLIGHT_JOB_STATES], ['QUEUED', 'RUNNING', 'PULL_REQUEST']);
  assert.deepEqual([...RUNNER_JOB_STATES], IN_FLIGHT_JOB_STATES.filter((state) => state !== 'PULL_REQUEST'));
  assert.equal(isInFlightJobState('PULL_REQUEST'), true);
  assert.equal(isInFlightJobState('LANDED'), false);
});

test('no reader spells the in-flight states itself', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (NOT_IN_FLIGHT_READERS[relative]) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (PAIR.test(line) || EITHER.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'these lines spell QUEUED and RUNNING together; a job waiting on its pull request is in flight too. Use '
    + 'IN_FLIGHT_JOB_STATES (or IN_FLIGHT_JOB_STATES_SQL, isInFlightJobState) from projects/in-flight-job-states.ts — '
    + 'or, for a reader that is not about a landing in flight, list the file in NOT_IN_FLIGHT_READERS with the reason');
});
