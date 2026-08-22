import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectsController } from './projects.controller';
import { parseCriteria } from './project-acceptance';
import { ACCEPTANCE_UNDECIDED } from './project-acceptance.service';
import {
  E2eServices,
  connectIsolatedPg,
  emptyWorld,
  servicesOn,
  task,
  world,
} from './project-e2e-harness';

/**
 * `GET /projects/:id` reports the ACCEPTANCE standing, on real PostgreSQL.
 *
 * The detail read already answers "how much of the work is done" with a task tally. That is a
 * process measure: it reaches 100% the moment the last task is closed, whether or not the thing
 * the project was for was ever checked. The acceptance tally is the outcome measure, and it comes
 * out of `project_acceptance_criterion` — one row per stated criterion per attempt.
 *
 * "Per attempt" is the whole reason this is a pg spec rather than a unit test. A criterion key
 * recurs in every run that judged it, so the naive read — gather this project's criterion rows,
 * group by key — reports last week's PASS as though it were today's, and the project looks further
 * along than any single attempt ever concluded. That failure needs two real runs over the same
 * criteria to show up at all, which needs the real table.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Five criteria, so the split below (2 PASS / 1 FAIL / 2 unjudged) is not a coincidence of two. */
const FIVE = [
  'every suite is green on a disposable database',
  'the branch content is on the target branch',
  'no blocker is open',
  'the migration applies to an empty database',
  'the runbook names the rollback',
].join('\n');

const THREE = [
  '- the API answers within 200ms at p95',
  '- the dashboard shows the new panel',
  '- the alert fires on a synthetic breach',
].join('\n');

const MIGRATION = '0127_project_acceptance_run';

/** The detail body as a client receives it: through the id mapper, which is where a UUID column
 *  becomes a name the caller can hand back. */
async function serve(payload: unknown): Promise<Record<string, any>> {
  const context = {
    getClass: () => ProjectsController,
    getHandler: () => ProjectsController.prototype.get,
  } as unknown as ExecutionContext;
  return await firstValueFrom(
    new PublicIdInterceptor().intercept(context, { handle: () => of(payload) }),
  ) as Record<string, any>;
}

/** Conclude every criterion of a run, which is the only shape `finalizeRun` accepts. */
async function finalize(
  services: E2eServices,
  ownerId: string,
  projectId: string,
  run: { id: string; criteria: Array<{ ordinal: number }> },
  verdictOf: (ordinal: number) => 'PASS' | 'FAIL' | 'INCONCLUSIVE',
) {
  return services.acceptance.finalizeRun(
    ownerId, projectId, run.id,
    run.criteria.map((c) => ({
      ordinal: c.ordinal,
      verdict: verdictOf(c.ordinal),
      summary: `attempt said ${verdictOf(c.ordinal)} about ${c.ordinal}`,
      evidence: { command: 'npm test', exitCode: 0 },
    })),
  );
}

test('project detail reports the latest attempt\'s acceptance standing', { skip, timeout: 300_000 }, async (t) => {
  const identity = await connectIsolatedPg(URL);
  const applied = await identity.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM "_prisma_migrations"
     WHERE "migration_name" = '${MIGRATION}' AND "finished_at" IS NOT NULL`);
  assert.equal(applied.rows[0].count, '1', `migration ${MIGRATION} has not been applied to this database`);

  const services = servicesOn(URL!);
  t.after(async () => {
    await services.dispose();
    await identity.end();
  });

  await t.test('only the latest run is counted, and its unjudged criteria say so', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'acceptance-standing', { acceptanceCriteria: FIVE });
    const evidence = await task(services.db, target, 'made the suite green');

    // Attempt 1 concluded 4 of 5 PASS. This is the history that must not be reported, and it is
    // written the way history gets written: a run somebody actually finished.
    const first = await services.acceptance.openRun(
      target.ownerId, target.projectId, { decidedBy: 'USER' },
    );
    const firstDone = await finalize(
      services, target.ownerId, target.projectId, first, (o) => (o === 5 ? 'FAIL' : 'PASS'),
    );
    assert.equal(firstDone.criteria.filter((c) => c.verdict === 'PASS').length, 4);

    // Attempt 2 is open: two criteria concluded PASS, one FAIL, two not reached. `finalizeRun`
    // answers a whole checklist at once, so the half-judged state — the state every run passes
    // through, and the one a page is most likely to be looking at — is written here directly.
    const second = await services.acceptance.openRun(
      target.ownerId, target.projectId, { decidedBy: 'COORDINATOR_AGENT' },
    );
    assert.deepEqual(second.criteria.map((c) => c.verdict), [null, null, null, null, null]);
    const decidedAt = new Date();
    for (const [ordinal, verdict] of [[1, 'PASS'], [2, 'PASS'], [3, 'FAIL']] as const) {
      await services.db.projectAcceptanceCriterion.updateMany({
        where: { runId: second.id, ordinal },
        data: {
          verdict,
          summary: `attempt 2 said ${verdict} about ${ordinal}`,
          decidedAt,
          evidenceTaskId: verdict === 'PASS' ? evidence : null,
        },
      });
    }

    const detail = await services.projects.get(target.ownerId, target.projectId);

    // The assertion this whole spec exists for: 2, not 4. A read that gathered criterion rows by
    // key across runs, or that trusted `superseded_at is null`, reports attempt 1's tally here.
    assert.equal(detail.acceptance.passed, 2, 'only the latest attempt may be counted');
    assert.equal(detail.acceptance.total, 5);
    assert.deepEqual(detail.acceptance.criteria.map((c) => c.ordinal), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      detail.acceptance.criteria.map((c) => c.verdict),
      ['PASS', 'PASS', 'FAIL', ACCEPTANCE_UNDECIDED, ACCEPTANCE_UNDECIDED],
      'a criterion the latest attempt has not reached reports a placeholder, never a stale verdict',
    );

    // ...and it is the LATEST run's clock. An open attempt has no completion, so the answer to
    // "when was acceptance last looked at" is when it started — which is still after attempt 1
    // finished, so a read that took the newest FINALIZED run would be visibly older.
    const runs = await services.db.projectAcceptanceRun.findMany({
      where: { projectId: target.projectId }, orderBy: { attempt: 'asc' },
    });
    assert.equal(runs.length, 2);
    assert.equal(detail.acceptance.lastRunAt?.getTime(), runs[1].startedAt.getTime());
    assert.ok(
      detail.acceptance.lastRunAt!.getTime() >= runs[0].completedAt!.getTime(),
      'the reported time is the latest attempt\'s, not the last concluded one\'s',
    );

    // The free text is untouched by any of this: it is what a person edits, and the structured
    // rows are what a run concluded about it. Both are served, neither replaces the other.
    assert.equal(detail.acceptanceCriteria, FIVE);
    assert.deepEqual(
      detail.acceptance.criteria.map((c) => c.text),
      parseCriteria(FIVE).map((c) => c.text),
    );
    assert.deepEqual(
      detail.acceptance.criteria.map((c) => c.key),
      parseCriteria(FIVE).map((c) => c.key),
      'the key is the content key the runs line up by, not a row id',
    );
    assert.equal(detail.acceptance.criteria[0].summary, 'attempt 2 said PASS about 1');
    assert.equal(detail.acceptance.criteria[3].summary, null);
    assert.equal(detail.acceptance.criteria[3].decidedAt, null);

    // The evidence pointer is an address, so it has to leave in the spelling a client can hand
    // back — the mapper keys on the field NAME, and a field it does not know stays a raw UUID.
    const served = await serve(detail);
    assert.equal(served.acceptance.criteria[0].evidenceTaskPublicId, uuidToBase62(evidence));
    assert.equal(served.acceptance.criteria[3].evidenceTaskId, null);
  });

  await t.test('a project nobody has run acceptance against reports its stated criteria, unjudged', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'never-run', { acceptanceCriteria: THREE });

    const detail = await services.projects.get(target.ownerId, target.projectId);

    assert.equal(detail.acceptance.total, 3, 'the stated criteria are registered whether or not anyone ran them');
    assert.equal(detail.acceptance.passed, 0);
    assert.equal(detail.acceptance.lastRunAt, null);
    assert.deepEqual(
      detail.acceptance.criteria.map((c) => c.verdict),
      [ACCEPTANCE_UNDECIDED, ACCEPTANCE_UNDECIDED, ACCEPTANCE_UNDECIDED],
    );
    assert.deepEqual(detail.acceptance.criteria.map((c) => c.ordinal), [1, 2, 3]);
    // The list markers are cosmetic — `parseCriteria` decides what one criterion is, and this read
    // must not invent a second answer to that question.
    assert.deepEqual(
      detail.acceptance.criteria.map((c) => c.text),
      parseCriteria(THREE).map((c) => c.text),
    );
    assert.equal(detail.acceptanceCriteria, THREE);

    // A project with no criteria at all is the other empty case, and it is empty rather than an
    // error: there is nothing stated to judge, which is exactly what `openRun` refuses on.
    const blank = await world(services.db, 'no-criteria');
    const blankDetail = await services.projects.get(blank.ownerId, blank.projectId);
    assert.deepEqual(blankDetail.acceptance, { total: 0, passed: 0, lastRunAt: null, criteria: [] });
  });
});
