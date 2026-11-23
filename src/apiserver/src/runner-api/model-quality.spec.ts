/**
 * The Model tiers quality (docs/subagent-design.md §7.1) without a database: the rating's decay, the "not enough"
 * thresholds, which model a run's rating belongs to, the score bounds of subagent_rate, the finished block's ask
 * to rate, and that routing reads none of it. The write and read paths on PostgreSQL are subagent-rating.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MODEL_QUALITY_MIN_RATINGS, MODEL_QUALITY_MIN_TASKS } from '@orbit/shared';

import { buildSubagentFinishedBlock, SUBAGENT_RATE_LINE } from './background-job-wake';
import { addTally, emptyTally, qualityOf, ranOn, ratingWeight, type QualityRunRow, type QualityTally } from './model-quality';
import { SubagentRatingDto } from './subagent-rating';

const DAY = 86_400_000;
const id = (model: string) => model;

function rated(scores: Array<[score: number, ageDays: number]>): QualityTally {
  const tally = emptyTally();
  for (const [score, age] of scores) {
    const weight = ratingWeight(age * DAY);
    tally.runCount += 1;
    tally.ratedCount += 1;
    tally.weightSum += weight;
    tally.weightedScoreSum += weight * score;
  }
  return tally;
}

test('a rating weighs 1 today, half after 30 days and a quarter after 60', () => {
  assert.equal(ratingWeight(0), 1);
  assert.equal(ratingWeight(30 * DAY), 0.5);
  assert.equal(ratingWeight(60 * DAY), 0.25);
  assert.equal(ratingWeight(-DAY), 1, 'a clock skewed into the future does not weigh more than today');
});

test('the average weighs recent ratings more than a plain mean would', () => {
  // Three 5s today and three 1s sixty days ago: a plain mean is 3.0; weighted, (3·5 + 0.75·1) / 3.75 = 4.2.
  const quality = qualityOf(rated([[5, 0], [5, 0], [5, 0], [1, 60], [1, 60], [1, 60]]), id);
  assert.equal(quality.subagent.averageRating, 4.2);
  assert.equal(quality.subagent.ratedCount, 6);
});

test(`below ${MODEL_QUALITY_MIN_RATINGS} ratings there is no average, and the counts still say how far it is`, () => {
  const four = rated([[4, 0], [4, 1], [4, 2], [4, 3]]);
  four.runCount = 9;
  const quality = qualityOf(four, id);
  assert.equal(quality.subagent.averageRating, null);
  assert.equal(quality.subagent.ratedCount, 4);
  assert.equal(quality.subagent.runCount, 9);
  assert.equal(qualityOf(rated([[4, 0], [4, 1], [4, 2], [4, 3], [4, 4]]), id).subagent.averageRating, 4);
});

test(`below ${MODEL_QUALITY_MIN_TASKS} completed tasks there is no first-pass rate`, () => {
  const tally = emptyTally();
  tally.completedTaskCount = 9;
  tally.firstPassTaskCount = 9;
  assert.equal(qualityOf(tally, id).tasks.firstPassRate, null);
  assert.equal(qualityOf(tally, id).tasks.completedTaskCount, 9);
  tally.completedTaskCount = 10;
  tally.firstPassTaskCount = 8;
  assert.equal(qualityOf(tally, id).tasks.firstPassRate, 0.8);
});

test("a row's engines are summed, and the raters keep their models, most ratings first, by the owner's names", () => {
  const claude = rated([[5, 0], [4, 0]]);
  claude.raters.set('opus', { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', count: 2 });
  const codex = rated([[3, 0], [3, 0], [3, 0]]);
  codex.raters.set('gpt', { engine: 'codex', provider: 'codex', model: 'gpt-5.5', count: 1 });
  codex.raters.set('opus', { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', count: 2 });
  codex.completedTaskCount = 4;
  const sum = emptyTally();
  addTally(sum, claude);
  addTally(sum, codex);
  const quality = qualityOf(sum, (model) => (model === 'claude-opus-5-5' ? 'Opus 5.5' : model));
  assert.equal(quality.subagent.ratedCount, 5);
  assert.equal(quality.subagent.averageRating, 3.6);
  assert.deepEqual(quality.subagent.raters, [
    { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', count: 4 },
    { engine: 'codex', provider: 'codex', model: 'gpt-5.5', label: 'gpt-5.5', count: 1 },
  ]);
  assert.equal(quality.tasks.completedTaskCount, 4);
  assert.equal(claude.raters.get('opus')?.count, 2, 'summing leaves the parts as they were');
});

test('a rating belongs to the model the result came from', () => {
  const base: QualityRunRow = {
    attemptEngine: null, attemptProvider: null, attemptModel: null, applied: 'true',
    decisionEngine: 'claude', decisionProvider: 'claude', decisionModel: 'claude-sonnet-5-5', runModel: null,
    parentEngine: 'claude', parentProvider: 'claude', parentModel: 'claude-opus-5-5',
    ratingScore: 5, ratedAt: new Date(), raterEngine: 'claude', raterProvider: 'claude', raterModel: 'claude-opus-5-5',
  };
  assert.deepEqual(ranOn(base), { provider: 'claude', engine: 'claude', model: 'claude-sonnet-5-5' }, "the decision's pick");
  assert.deepEqual(
    ranOn({ ...base, attemptEngine: 'codex', attemptProvider: 'codex', attemptModel: 'gpt-5.5' }),
    { provider: 'codex', engine: 'codex', model: 'gpt-5.5' },
    'the last attempt: where a usage limit moved it',
  );
  assert.deepEqual(
    ranOn({ ...base, applied: 'false', runModel: 'claude-opus-5-5' }),
    { provider: 'claude', engine: 'claude', model: 'claude-opus-5-5' },
    "a shadow row ran on the parent's engine",
  );
  assert.equal(ranOn({ ...base, decisionModel: null }), null, 'a run that names no model is not counted');
});

test('subagent_rate takes a whole score from 1 to 5 and a note of up to 500 characters', () => {
  const errors = (body: object) => validateSync(plainToInstance(SubagentRatingDto, body)).map((e) => e.property);
  for (const score of [1, 3, 5]) assert.deepEqual(errors({ score }), [], `score ${score}`);
  for (const score of [0, 6, 2.5, '4', null]) assert.deepEqual(errors({ score }), ['score'], `score ${String(score)}`);
  assert.deepEqual(errors({ score: 4, note: 'x'.repeat(500) }), []);
  assert.deepEqual(errors({ score: 4, note: 'x'.repeat(501) }), ['note']);
});

test('the SubAgent finished block asks the parent to rate the result, once, after it has used it', () => {
  const block = buildSubagentFinishedBlock([{
    wakeId: 'R1:exit', jobId: 'R1', trigger: 'exit', kind: 'subagent', command: 'Find callers', description: 'Find callers',
    status: 'DONE', outputPath: '', outputOffset: 0, outputSize: 2, outputExcerpt: 'ok',
  } as never]);
  const lines = block.split('\n');
  assert.equal(lines.filter((line) => line === SUBAGENT_RATE_LINE).length, 1);
  assert.equal(lines.at(-2), SUBAGENT_RATE_LINE, 'the last sentence before the block closes');
  assert.match(SUBAGENT_RATE_LINE, /^ {2}Once you have used a result, rate it with mcp__orbit__subagent_rate/);
  assert.match(SUBAGENT_RATE_LINE, /Optional: nothing waits on it\.$/);
});

const QUALITY_WORDS = /\b(rating|ratings|ratingScore|rating_score|qualityOf|readModelQuality|taskFirstPassByModel)\b|model-quality/;

test('routing reads no rating and no quality', () => {
  // routeSubagent and routeTaskRun live in model-routing.ts; planSubagentRoute and the task route's reads beside it.
  for (const file of ['../tasks/model-routing.ts', '../tasks/task-route-decision.ts']) {
    const source = readFileSync(join(__dirname, '../../src/runner-api', file), 'utf8');
    assert.equal(QUALITY_WORDS.test(source), false, `${file} mentions ${QUALITY_WORDS.exec(source)?.[0]}`);
  }
  const route = readFileSync(join(__dirname, '../../src/runner-api/subagent-route.ts'), 'utf8');
  const plan = route.slice(route.indexOf('export async function planSubagentRoute'), route.indexOf('export async function subagentTierView'));
  assert.ok(plan.length > 0);
  assert.equal(QUALITY_WORDS.test(plan), false, 'planSubagentRoute reads no quality');
});
