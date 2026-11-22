import {
  MODEL_QUALITY_HALF_LIFE_DAYS,
  MODEL_QUALITY_MIN_RATINGS,
  MODEL_QUALITY_MIN_TASKS,
  MODEL_QUALITY_WINDOW_DAYS,
  type ModelQuality,
  type ModelQualityRater,
} from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { taskFirstPassByModel } from '../tasks/task-model-routing-report.service';

/**
 * How well each model completed work, as the Model tiers view shows it beside the model's tier
 * (docs/subagent-design.md §7.1). Display only: routeSubagent and routeTaskRun never read any of it.
 *
 *  - SubAgents: the runs that ended in the last MODEL_QUALITY_WINDOW_DAYS days on each model, and the parents'
 *    ratings of them (subagent_rate). The average weighs each rating by its age, halving every
 *    MODEL_QUALITY_HALF_LIFE_DAYS days.
 *  - Tasks: the done tasks whose first run was on the model in that window, and how many passed first time
 *    (taskFirstPassByModel). Runs that failed on a usage limit or a model at capacity are not counted.
 *
 * Both are keyed by provider × engine × model, as a tier row lists a model under each engine of its provider.
 */

const DAY_MS = 86_400_000;

/** A provider × engine × model, as qualityKey spells it. */
export function qualityKey(provider: string, engine: string, model: string): string {
  return `${provider}\u0000${engine}\u0000${model}`;
}

/** What one key holds before it is summed with the other engines of its row and read out. */
export interface QualityTally {
  runCount: number;
  ratedCount: number;
  weightSum: number;
  weightedScoreSum: number;
  raters: Map<string, Omit<ModelQualityRater, 'label' | 'count'> & { count: number }>;
  completedTaskCount: number;
  firstPassTaskCount: number;
}

export function emptyTally(): QualityTally {
  return {
    runCount: 0, ratedCount: 0, weightSum: 0, weightedScoreSum: 0, raters: new Map(),
    completedTaskCount: 0, firstPassTaskCount: 0,
  };
}

/** Add `from` into `into`. */
export function addTally(into: QualityTally, from: QualityTally): void {
  into.runCount += from.runCount;
  into.ratedCount += from.ratedCount;
  into.weightSum += from.weightSum;
  into.weightedScoreSum += from.weightedScoreSum;
  for (const [key, rater] of from.raters) {
    const seen = into.raters.get(key);
    if (seen) seen.count += rater.count;
    else into.raters.set(key, { ...rater });
  }
  into.completedTaskCount += from.completedTaskCount;
  into.firstPassTaskCount += from.firstPassTaskCount;
}

/** How much a rating `ageMs` old weighs: 1 today, ½ after one half-life. */
export function ratingWeight(ageMs: number): number {
  return 0.5 ** (Math.max(0, ageMs) / (MODEL_QUALITY_HALF_LIFE_DAYS * DAY_MS));
}

/** A tally as the view serves it, with the thresholds applied. `label` names a rater's model. */
export function qualityOf(tally: QualityTally, label: (model: string) => string): ModelQuality {
  const enoughRatings = tally.ratedCount >= MODEL_QUALITY_MIN_RATINGS && tally.weightSum > 0;
  const enoughTasks = tally.completedTaskCount >= MODEL_QUALITY_MIN_TASKS;
  return {
    subagent: {
      averageRating: enoughRatings ? Math.round((tally.weightedScoreSum / tally.weightSum) * 10) / 10 : null,
      ratedCount: tally.ratedCount,
      runCount: tally.runCount,
      raters: [...tally.raters.values()]
        .map((rater) => ({ ...rater, label: rater.model ? label(rater.model) : null }))
        .sort((a, b) => b.count - a.count || (a.label ?? '').localeCompare(b.label ?? '')),
    },
    tasks: {
      firstPassRate: enoughTasks ? tally.firstPassTaskCount / tally.completedTaskCount : null,
      firstPassTaskCount: tally.firstPassTaskCount,
      completedTaskCount: tally.completedTaskCount,
    },
  };
}

/** One ended SubAgent run of the window, as subagentRuns reads it. */
export interface QualityRunRow {
  attemptEngine: string | null;
  attemptProvider: string | null;
  attemptModel: string | null;
  applied: string | null;
  decisionEngine: string | null;
  decisionProvider: string | null;
  decisionModel: string | null;
  runModel: string | null;
  parentEngine: string | null;
  parentProvider: string;
  parentModel: string | null;
  ratingScore: number | null;
  ratedAt: Date | null;
  raterEngine: string | null;
  raterProvider: string | null;
  raterModel: string | null;
}

/**
 * The model a run's result came from: its last attempt's (the candidate a limit moved it to, or where it opened);
 * else, on a shadow row (routing not applied), the parent's engine and provider with the model it ran on; else the
 * decision's pick. Null when none of them names a model.
 */
export function ranOn(row: QualityRunRow): { provider: string; engine: string; model: string } | null {
  if (row.attemptModel && row.attemptProvider && row.attemptEngine) {
    return { provider: row.attemptProvider, engine: row.attemptEngine, model: row.attemptModel };
  }
  if (row.applied === 'false') {
    const model = row.runModel ?? row.parentModel;
    return model ? { provider: row.parentProvider, engine: row.parentEngine ?? row.parentProvider, model } : null;
  }
  if (row.decisionModel && row.decisionProvider && row.decisionEngine) {
    return { provider: row.decisionProvider, engine: row.decisionEngine, model: row.decisionModel };
  }
  return null;
}

async function subagentRuns(db: Prisma.TransactionClient, ownerId: string, since: Date): Promise<QualityRunRow[]> {
  return db.$queryRaw<QualityRunRow[]>(Prisma.sql`
    SELECT r.attempts->-1->>'engine' AS "attemptEngine", r.attempts->-1->>'provider' AS "attemptProvider",
           r.attempts->-1->>'model' AS "attemptModel",
           r.decision->>'applied' AS applied, r.decision->>'engine' AS "decisionEngine",
           r.decision->>'provider' AS "decisionProvider", r.decision->>'model' AS "decisionModel",
           r.decision->>'runModel' AS "runModel",
           s.engine AS "parentEngine", s.provider AS "parentProvider", s.model AS "parentModel",
           r.rating_score AS "ratingScore", r.rated_at AS "ratedAt",
           r.rater_engine AS "raterEngine", r.rater_provider AS "raterProvider", r.rater_model AS "raterModel"
      FROM subagent_run r
      JOIN session s ON s.id = r.session_id
     WHERE r.owner_id = ${ownerId}::uuid AND r.created_at >= ${since} AND r.status <> 'RUNNING'
  `);
}

/** Every provider × engine × model's tally over the window ending `now`. Reads only. */
export async function readModelQuality(
  db: Prisma.TransactionClient,
  ownerId: string,
  now = new Date(),
): Promise<Map<string, QualityTally>> {
  const since = new Date(now.getTime() - MODEL_QUALITY_WINDOW_DAYS * DAY_MS);
  const [runs, tasks] = await Promise.all([subagentRuns(db, ownerId, since), taskFirstPassByModel(db, ownerId, since)]);
  const tallies = new Map<string, QualityTally>();
  const tallyOf = (key: string) => {
    let tally = tallies.get(key);
    if (!tally) tallies.set(key, (tally = emptyTally()));
    return tally;
  };
  for (const row of runs) {
    const target = ranOn(row);
    if (!target) continue;
    const tally = tallyOf(qualityKey(target.provider, target.engine, target.model));
    tally.runCount += 1;
    if (row.ratingScore === null || !row.ratedAt) continue;
    const weight = ratingWeight(now.getTime() - row.ratedAt.getTime());
    tally.ratedCount += 1;
    tally.weightSum += weight;
    tally.weightedScoreSum += weight * row.ratingScore;
    const rater = { engine: row.raterEngine, provider: row.raterProvider ?? '', model: row.raterModel };
    const raterKey = `${rater.provider}\u0000${rater.engine ?? ''}\u0000${rater.model ?? ''}`;
    const seen = tally.raters.get(raterKey);
    if (seen) seen.count += 1;
    else tally.raters.set(raterKey, { ...rater, count: 1 });
  }
  for (const row of tasks) {
    const tally = tallyOf(qualityKey(row.provider, row.engine, row.model));
    tally.completedTaskCount += row.completedTaskCount;
    tally.firstPassTaskCount += row.firstPassTaskCount;
  }
  return tallies;
}
