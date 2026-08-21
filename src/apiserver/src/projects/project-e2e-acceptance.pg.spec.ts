import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  Prisma,
  ProjectAutomationPolicy,
  RunStatus,
  RunnerStatus,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import type { Client } from 'pg';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  deliver,
  dispatch,
  drainToIdle,
  emptyWorld,
  failTask,
  publicId,
  rawUuidPaths,
  servicesOn,
  session,
  task,
  world,
} from './project-e2e-harness';
import { ProjectAutomationPolicy as PolicyDto, base62ToUuid } from '@orbit/shared';
import {
  createDecisionId,
  hashDecisionInput,
  planProjectDecision,
  publicIdempotencyKey,
  verificationVerdictPlan,
} from './project-decision.service';
import { verificationVerdictActionKey } from './task-verification-verdict';
import {
  COORDINATOR_DISABLED_CODE,
  STALE_CONFIG_REVISION_CODE,
} from './project-coordinator-status';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectsController } from './projects.controller';

/**
 * Unit 22 — the end-to-end acceptance walk for project criteria 1, 4, 5, 6, 7, 8, 10 and 11.
 *
 * Every scenario here starts at a door somebody can actually open (a request, an outbox delivery,
 * a timer) and ends at a fact somebody can actually read (a row, a refusal code, a served payload).
 * The suite that owns delivery reliability, liveness and recovery is its sibling,
 * `project-e2e-recovery.pg.spec.ts`; between the two, every acceptance criterion 1–11 has at least
 * one scenario that would fail if the criterion stopped holding.
 *
 * It needs a database of its own, built by `prisma migrate deploy` rather than by a hand-written
 * subset: half of what is under test here lives in triggers and partial indexes that a subset
 * would agree with only because it copied them. `scripts/project-e2e.sh` provisions one, runs both
 * suites and the §10.3 SQL audit, and throws the server away.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

async function openBlockers(services: E2eServices, projectId: string) {
  return services.db.projectBlocker.findMany({
    where: { projectId, resolvedAt: null },
    orderBy: [{ kind: 'asc' }, { dedupeKey: 'asc' }],
  });
}
/** The runtime row as the control loop last published it. */
async function runtime(services: E2eServices, projectId: string) {
  return services.db.projectRuntime.findUniqueOrThrow({ where: { projectId } });
}

/**
 * A payload as a CLIENT receives it: through the global interceptor that spells ids.
 *
 * `ProjectsController` carries no `@MachineProtocol()`, so `replaceSource` is true there and `id`
 * IS the public id on the wire. Reproducing that here is what makes AC1's rule checkable at all —
 * the service layer deliberately answers in the UUIDs its columns key by.
 */
async function servePublicIds(payload: unknown): Promise<unknown> {
  const context = {
    getClass: () => ProjectsController,
    getHandler: () => ProjectsController.prototype.coordinatorStatus,
  } as unknown as ExecutionContext;
  return firstValueFrom(
    new PublicIdInterceptor().intercept(context, { handle: () => of(payload) }),
  );
}

/** One delivery, then whatever it scheduled, so a scenario asserts on a world at rest. */
async function settle(services: E2eServices, projectId: string, kind = 'task.updated'): Promise<void> {
  await deliver(services, projectId, kind);
  await drainToIdle(services);
}

test('unit 22: the project control loop end to end', { skip, timeout: 900_000 }, async (t) => {
  const identity = await connectIsolatedPg(URL);
  const migrations = await identity.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM "_prisma_migrations"
     WHERE "migration_name" IN ('0111_project_coordinator_identity', '0116_project_event_outbox',
                               '0119_project_reconcile_runtime', '0120_project_decision_audit',
                               '0121_project_authorization_policy', '0125_project_blocker',
                               '0126_project_coordinator_session_lifecycle')
       AND "finished_at" IS NOT NULL
  `);
  assert.equal(migrations.rows[0]?.count, '7',
    'the isolated database must carry the whole control-loop migration set');

  const services = servicesOn(URL!);

  const scenario = async (
    name: string,
    body: (client: Client) => Promise<void>,
  ): Promise<void> => {
    await t.test(name, async () => {
      await emptyWorld(identity);
      await body(identity);
    });
  };

  try {
    // ----------------------------------------------------------------------------------------
    // AC11 — an existing project keeps its safe defaults and is never switched on by accident.
    // ----------------------------------------------------------------------------------------

    await scenario('AC11: a project written by the old binary lands outside the loop', async (client) => {
      // No service layer: this is the row shape a pre-feature binary produces, which after the
      // migration means "every new column at its DATABASE default". §12.1 G1 is exactly the claim
      // that those defaults differ from what `ProjectsService.create` writes for a NEW project.
      const ownerId = randomUUID();
      const projectId = randomUUID();
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO "user" (id, email, name, password_hash)
         VALUES ($1::uuid, $2, 'legacy', 'x')`, [ownerId, `legacy-${ownerId}@pcc22.invalid`]);
      await client.query(
        `INSERT INTO "project" (id, owner_id, title, updated_at)
         VALUES ($1::uuid, $2::uuid, 'legacy project', now())`, [projectId, ownerId]);
      await client.query(
        `INSERT INTO "task" (id, owner_id, project_id, title, creator_type, creator_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'legacy task', 'USER', $2::uuid, now())`,
        [taskId, ownerId, projectId]);

      const project = await services.db.project.findUniqueOrThrow({ where: { id: projectId } });
      assert.equal(project.coordinatorEnabled, false, 'AC11: the loop must be off for old rows');
      assert.equal(project.automationPolicy, ProjectAutomationPolicy.MANUAL,
        'AC11 G1: the column default protects existing rows, whatever a new project starts at');
      assert.equal(project.coordinatorSessionId, null, 'and no coordination run was opened for it');
      assert.equal(String(project.configRevision), '0');

      const row = await runtime(services, projectId);
      assert.equal(row.runState, 'PLANNING', 'migration step 3 backfills a runtime row');
      assert.equal(row.nextWakeAt, null, 'G2: the migration schedules nothing');
      assert.equal(String(row.fencingToken), '0');
      assert.equal(String(row.coordinatorGeneration), '0');

      const legacyTask = await services.db.task.findUniqueOrThrow({ where: { id: taskId } });
      assert.equal(legacyTask.dispatchAuthority, 'LEGACY',
        '§12.3: an old task keeps the legacy sweeps as its only dispatcher');
      assert.equal(legacyTask.completionPolicy, 'MANUAL');
    });

    await scenario('AC11: signals from a legacy project are discarded, never acted on', async () => {
      const ownerId = randomUUID();
      const projectId = randomUUID();
      await identity.query(
        `INSERT INTO "user" (id, email, name, password_hash)
         VALUES ($1::uuid, $2, 'legacy', 'x')`, [ownerId, `legacy-${ownerId}@pcc22.invalid`]);
      await identity.query(
        `INSERT INTO "project" (id, owner_id, title, updated_at)
         VALUES ($1::uuid, $2::uuid, 'legacy project', now())`, [projectId, ownerId]);
      await identity.query(
        `INSERT INTO "task" (id, owner_id, project_id, title, creator_type, creator_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'legacy task', 'USER', $2::uuid, now())`,
        [randomUUID(), ownerId, projectId]);

      // §5.3 N1: producers do not filter on `coordinator_enabled`, so the rows above DO commit
      // signals. AC11 is therefore not "no events" — it is that draining them changes nothing.
      const queued = await services.db.projectEvent.count({ where: { projectId } });
      assert.ok(queued > 0, 'the producers must still record what happened');

      const drained = await drainToIdle(services);
      assert.ok(drained > 0, 'the delivery path must consume them rather than leaving a backlog');
      const dispositions = await services.db.projectEvent.findMany({
        where: { projectId }, select: { disposition: true, consumedAt: true },
      });
      assert.ok(dispositions.every((event) => event.disposition === 'DISCARDED_OUT_OF_LOOP'),
        '§5.5 EV3: an out-of-loop project disposes of its signals terminally');
      assert.ok(dispositions.every((event) => event.consumedAt !== null));

      assert.equal(await services.db.projectAction.count({ where: { projectId } }), 0,
        'AC11: nothing may be dispatched, rotated or approved for a project nobody switched on');
      assert.equal(await services.db.projectDecision.count({ where: { projectId } }), 0);
      assert.equal(await services.db.projectBlocker.count({ where: { projectId } }), 0);
      assert.equal(await services.db.session.count({ where: { task: { projectId } } }), 0);
      assert.equal((await runtime(services, projectId)).nextWakeAt, null);

      // §10.2 W4-b: the backstop scans only projects that are IN the loop, so a legacy row cannot
      // become a permanent WARN — the failure mode PC-CX-05 was raised about.
      const before = services.reconciler.backstopHits;
      await services.reconciler.tick(new Date(Date.now() + 10 * 60_000));
      assert.equal(services.reconciler.backstopHits, before,
        'a legacy project must not be reported as a stalled one');
      assert.equal(
        await services.db.projectEvent.count({ where: { projectId, kind: 'timer.backstop' } }), 0);
    });

    await scenario('AC11: turning the loop on requires naming a level, and says so to the loop',
      async () => {
        const target = await world(services.db, 'ac11-optin', { coordinatorEnabled: false });
        await services.db.project.update({
          where: { id: target.projectId },
          data: { automationPolicy: ProjectAutomationPolicy.MANUAL },
        });
        await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

        // G3: "carry on with the safe default" is leaving it alone. Switching it on is a choice,
        // and a choice with no level named is refused before anything is written.
        await assert.rejects(
          () => services.projects.update(target.ownerId, target.projectId, { coordinatorEnabled: true }),
          (error: unknown) => error instanceof BadRequestException,
          'AC11: enabling without an explicit policy must be refused');
        const untouched = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
        assert.equal(untouched.coordinatorEnabled, false, 'a refused request writes nothing');
        assert.equal(String(untouched.configRevision), '0');

        const updated = await services.projects.update(target.ownerId, target.projectId, {
          coordinatorEnabled: true,
          automationPolicy: PolicyDto.GUARDED_AUTO,
        });
        assert.equal(updated.coordinatorEnabled, true);
        assert.equal(updated.automationPolicy, ProjectAutomationPolicy.GUARDED_AUTO);
        assert.equal(String(updated.configRevision), '1',
          '§9.6 AU2: one bump per write of the authorization set');

        const events = await services.db.projectEvent.findMany({
          where: { projectId: target.projectId }, select: { kind: true },
        });
        assert.ok(events.some((event) => event.kind === 'user.policy_changed'),
          'G3: the same transaction that switches it on tells the loop');
        const tasksNow = await services.db.task.findMany({
          where: { projectId: target.projectId }, select: { dispatchAuthority: true },
        });
        assert.ok(tasksNow.every((row) => row.dispatchAuthority === 'COORDINATOR'),
          '§12.3 D3: the projection follows the switch, whoever threw it');
      });

    await scenario('AC11: a decision captured before blockers existed replays to what it decided',
      async () => {
        const target = await world(services.db, 'ac11-replay');
        await task(services.db, target, 'work');
        const decisionId = createDecisionId();
        const captured = await services.db.$transaction(
          async (tx) => services.decisions.capture(tx, target.projectId),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

        // A pre-0125 snapshot: the field is ABSENT, which §6.1 says a reader must treat as "this
        // binary had no blockers" and not as "there were none". The difference is the whole of
        // mixed-version replay, so it is asserted rather than assumed.
        const legacyInput = JSON.parse(JSON.stringify(captured.input)) as typeof captured.input;
        delete (legacyInput.world as { blockers?: unknown }).blockers;
        legacyInput.decisionInputHash = hashDecisionInput(legacyInput);
        const legacyOutcome = planProjectDecision(legacyInput, { decisionId });
        assert.equal(legacyOutcome.blockers, undefined,
          'an old snapshot must not grow a blocker audit it never had');
        assert.equal(legacyOutcome.detail, undefined);
        assert.ok(legacyOutcome.nextWakeAt, 'and it still gets a clock');

        const modernOutcome = planProjectDecision(captured.input, { decisionId });
        assert.ok(modernOutcome.blockers, 'a current snapshot carries the full blocker plan');
        assert.deepEqual(modernOutcome.blockersOpened, []);
      });

    // ----------------------------------------------------------------------------------------
    // AC1 — a stable coordinator identity, a rotatable run, and Base62 everywhere.
    // ----------------------------------------------------------------------------------------

    await scenario('AC1: a project recorded in a session is bound to it in one insert', async () => {
      const target = await world(services.db, 'ac1-create');
      const planning = await session(services.db, target, { status: RunStatus.RUNNING, finishedAt: null });

      const created = await services.projects.createInSession(
        target.ownerId, target.runnerId, planning, { title: 'recorded in a session' });
      const row = await services.db.project.findUniqueOrThrow({
        where: { id: created.id },
        include: { members: true, runtime: true },
      });
      assert.equal(row.coordinatorSessionId, planning, 'AC1: the conversation is the coordinator run');
      assert.equal(row.coordinatorWorkspaceId, target.agentId, 'AC1: and its workspace is the landing');
      assert.equal(row.members.length, 1);
      assert.equal(row.members[0].agentId, target.agentId);
      assert.equal(row.members[0].role, 'COORDINATOR', 'AC1: WHO is a durable team row, not the session');
      assert.ok(row.runtime, 'AC1: the run record exists from the first instant');
      assert.equal(row.coordinatorEnabled, true, 'a NEW project starts in the loop');
      assert.equal(row.automationPolicy, ProjectAutomationPolicy.GUARDED_AUTO,
        'AC4: guarded-auto is the default a new project starts at');
      assert.equal(row.runtime!.coordinatorIdentitySource, 'DERIVED',
        'nobody CHOSE this agent, so the identity stays correctable');

      // A second project cannot claim the same conversation — one session coordinates at most one.
      await assert.rejects(
        () => services.projects.createInSession(
          target.ownerId, target.runnerId, planning, { title: 'second' }),
        (error: unknown) => error instanceof ConflictException);
    });

    await scenario('AC1: asking for the coordinator twice returns the same conversation', async () => {
      const target = await world(services.db, 'ac1-open');
      const first = await services.projects.coordinator(target.ownerId, target.projectId, target.agentId);
      assert.equal(first.created, true);
      const second = await services.projects.coordinator(target.ownerId, target.projectId);
      assert.equal(second.created, false, 'AC1: opening it again is not a second coordinator');
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(
        await services.db.session.count({ where: { coordinatorForProject: { id: target.projectId } } }), 1);
    });

    await scenario('AC1: the loop replaces a dead coordination run and keeps WHO and WHERE',
      async () => {
        const target = await world(services.db, 'ac1-rotate');
        const opened = await services.projects.coordinator(
          target.ownerId, target.projectId, target.agentId);
        const before = await services.db.project.findUniqueOrThrow({
          where: { id: target.projectId }, include: { runtime: true } });
        assert.equal(before.coordinatorSessionId, opened.sessionId);

        // The conversation ends — the ordinary way a coordination run stops being usable.
        await services.db.session.update({
          where: { id: opened.sessionId },
          data: { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() },
        });

        await settle(services, target.projectId, 'session.ended');

        const after = await services.db.project.findUniqueOrThrow({
          where: { id: target.projectId }, include: { runtime: true, members: true } });
        assert.notEqual(after.coordinatorSessionId, opened.sessionId,
          'AC1/AC9: a dead run is replaced rather than left as the project\'s only door');
        assert.ok(after.coordinatorSessionId, 'and the replacement is bound, not merely planned');
        assert.equal(after.coordinatorWorkspaceId, target.agentId, 'the landing is not a re-election');
        assert.deepEqual(after.members.map((member) => member.agentId), [target.agentId],
          'AC1: WHO survives a rotation');
        assert.equal(String(after.runtime!.coordinatorGeneration), '1',
          '§8.2 GE1: the generation counter never goes back');

        const rotation = await services.db.projectAction.findFirstOrThrow({
          where: { projectId: target.projectId, type: 'ROTATE_COORDINATOR_SESSION' },
        });
        assert.equal(rotation.status, 'APPLIED');
        assert.match(rotation.idempotencyKey, /:rotate:1$/,
          '§8.2 GE1: a permanent key carrying the generation it opened');
        assert.ok(rotation.decisionId, '§8.3: and the decision that proposed it');
        const audit = await services.decisions.replay(target.ownerId, rotation.decisionId!);
        assert.equal(audit?.actionsTraceable, true,
          'AC5: the rotation the loop applied must be traceable to the decision that planned it');
        assert.equal(audit?.matches, true);
        const rotated = await services.db.session.findUniqueOrThrow({
          where: { id: after.coordinatorSessionId! } });
        assert.equal(rotated.workspaceId, target.agentId,
          '§7.5: the database refuses a coordination run that opens anywhere else');
      });

    await scenario('AC1: every id the control surface serves is Base62', async () => {
      const target = await world(services.db, 'ac1-ids', { policy: ProjectAutomationPolicy.AUTO });
      const parent = await task(services.db, target, 'parent', { completionPolicy: 'ALL_CHILDREN_DONE' });
      const child = await task(services.db, target, 'child', { parentTaskId: parent });
      await task(services.db, target, 'verify child', { verifiesTaskId: child });
      await services.projects.coordinator(target.ownerId, target.projectId, target.agentId);
      const missing = `pcc22-gone-${randomUUID().slice(0, 8)}`;
      const blocked = await task(services.db, target, 'blocked', { provider: missing });
      await dispatch(services, target, blocked);
      await dispatch(services, target, child);
      await settle(services, target.projectId);

      // The service layer answers in UUIDs; `PublicIdInterceptor` is the boundary that spells
      // them, and on a user-facing controller it REPLACES rather than twins. Asserting on the
      // service's own return value would be asserting on the wrong side of that boundary — this
      // is what a client receives.
      for (const [name, payload] of [
        ['coordinatorStatus', await services.projects.coordinatorStatus(target.ownerId, target.projectId)],
        ['blockers', await services.projects.blockers(target.ownerId, target.projectId, true)],
        ['verifications', await services.projects.verifications(target.ownerId, target.projectId)],
        ['taskPage', await services.projects.taskPage(target.ownerId, target.projectId, {})],
        ['get', await services.projects.get(target.ownerId, target.projectId)],
      ] as Array<[string, unknown]>) {
        const served = await servePublicIds(payload);
        const leaked = rawUuidPaths(served, `$.${name}`);
        assert.deepEqual(leaked, [],
          `AC1: ${name} must serve Base62 ids only — leaked ${leaked.join(', ')}`);
      }

      // And the loop's own audit is Base62 BEFORE any interceptor sees it: §6.2 freezes the
      // decision outcome as a document, and a document nobody rewrites has to be born correct.
      const decisions = await services.db.projectDecision.findMany({
        where: { projectId: target.projectId }, select: { outcome: true },
      });
      assert.ok(decisions.length > 0);
      for (const decision of decisions) {
        assert.deepEqual(rawUuidPaths(decision.outcome, '$.outcome'), [],
          'AC1/§6.2: the frozen decision audit is Base62 at rest');
      }
      const raised = await services.db.projectBlocker.findMany({
        where: { projectId: target.projectId }, select: { dedupeKey: true, detail: true },
      });
      assert.ok(raised.length > 0, 'this scenario must actually raise one');
      for (const blocker of raised) {
        assert.deepEqual(rawUuidPaths(blocker.detail, '$.detail'), [],
          'AC1/§11: a blocker a person reads names rows in the spelling they can paste');
      }
    });

    // ----------------------------------------------------------------------------------------
    // AC4 / AC5 — policy, limits, budget, and an audit that replays.
    // ----------------------------------------------------------------------------------------

    await scenario('AC4: MANUAL never dispatches on its own — it asks', async () => {
      const target = await world(services.db, 'ac4-manual', {
        policy: ProjectAutomationPolicy.MANUAL,
      });
      const work = await task(services.db, target, 'work');
      const refused = await dispatch(services, target, work);
      assert.equal(refused.status, 'REFUSED', 'AC4: MANUAL may not start work by itself');
      assert.equal(refused.reasonCode, 'POLICY_REQUIRES_APPROVAL');
      assert.equal(refused.sessionId, null, 'and no session may exist for a refused dispatch');
      assert.equal(await services.db.session.count({ where: { taskId: work } }), 0);

      // An approval is authority for exactly ONE key. Pointing it at the wrong one is refused
      // rather than treated as a standing grant.
      const mismatched = await dispatch(services, target, work, 2, {
        state: 'APPROVED',
        targetIdempotencyKey: `pc:v1:${target.projectId}:dispatch:${work}:99`,
      });
      assert.equal(mismatched.status, 'REFUSED');
      assert.equal(mismatched.reasonCode, 'APPROVAL_TARGET_MISMATCH',
        'AC4/§9.2: an approval is not a wildcard');

      // The same request WITH the user's approval bound to it is allowed — the approval is the
      // thing that changed, not the policy.
      const approved = await dispatch(services, target, work, 3, {
        state: 'APPROVED',
        targetIdempotencyKey: `pc:v1:${target.projectId}:dispatch:${work}:3`,
      });
      assert.equal(approved.status, 'APPLIED', 'AC4: an approved action runs under MANUAL');
      assert.ok(approved.sessionId);
      assert.equal(approved.reasonCode, 'APPROVAL_GRANTED');
    });

    await scenario('AC4: guarded-auto runs routine work and stops at the risky row', async () => {
      const target = await world(services.db, 'ac4-guarded', {
        policy: ProjectAutomationPolicy.GUARDED_AUTO,
      });
      const routine = await task(services.db, target, 'routine');
      const first = await dispatch(services, target, routine);
      assert.equal(first.status, 'APPLIED', 'DISPATCH_INITIAL is ALLOW at guarded-auto');

      // A task that has already burned its attempts is DISPATCH_MAX_ATTEMPTS — REQUIRE_APPROVAL in
      // every policy including AUTO. §9.3's "never on your behalf" is this row.
      const exhausted = await task(services.db, target, 'exhausted');
      await failTask(services.db, target, exhausted, 5, new Date(Date.now() - 8 * 60 * 60_000));
      const held = await dispatch(services, target, exhausted);
      assert.equal(held.status, 'REFUSED');
      assert.equal(held.reasonCode, 'MAX_ATTEMPTS_REACHED',
        'AC4/§9.2 DISPATCH_MAX_ATTEMPTS: the high-risk row asks a person at every level');
    });

    await scenario('AC4: AUTO dispatches, and the concurrency cap denies the second', async () => {
      const target = await world(services.db, 'ac4-concurrency', {
        policy: ProjectAutomationPolicy.AUTO,
        maxConcurrentTasks: 1,
      });
      const first = await task(services.db, target, 'first');
      const second = await task(services.db, target, 'second');
      const started = await dispatch(services, target, first);
      assert.equal(started.status, 'APPLIED');
      assert.ok(started.sessionId);
      assert.equal(services.announced.sessions.includes(started.sessionId!), true,
        '§8.3: the runner is told after the commit, not inside it');

      const capped = await dispatch(services, target, second);
      assert.equal(capped.status, 'REFUSED');
      assert.equal(capped.reasonCode, 'PROJECT_CONCURRENCY_LIMIT',
        'AC4: the cap DENIES — it is not an approval question');
      assert.equal(await services.db.session.count({ where: { taskId: second } }), 0);
    });

    await scenario('AC4: the daily session budget denies rather than silently skipping', async () => {
      const target = await world(services.db, 'ac4-budget', {
        policy: ProjectAutomationPolicy.AUTO,
        maxConcurrentTasks: 5,
        sessionBudgetPerDay: 1,
      });
      const first = await task(services.db, target, 'first');
      const second = await task(services.db, target, 'second');
      assert.equal((await dispatch(services, target, first)).status, 'APPLIED');

      const overBudget = await dispatch(services, target, second);
      assert.equal(overBudget.status, 'REFUSED');
      assert.equal(overBudget.reasonCode, 'SESSION_BUDGET_EXHAUSTED',
        '§9.4: the budget refuses under its OWN code, so "why did it stop" is answerable');

      await settle(services, target.projectId);
      const raised = await openBlockers(services, target.projectId);
      assert.ok(raised.some((blocker) => blocker.kind === 'BUDGET_EXHAUSTED'),
        'AC8: and it is visible as a structured blocker, not only as a refusal code');
    });

    await scenario('AC5: the decision audit replays byte-for-byte from its own input', async () => {
      const target = await world(services.db, 'ac5-replay');
      await task(services.db, target, 'work');
      await settle(services, target.projectId);

      const decisions = await services.db.projectDecision.findMany({
        where: { projectId: target.projectId }, orderBy: { createdAt: 'asc' },
      });
      assert.ok(decisions.length > 0, 'AC5: every pass leaves a decision row');
      for (const row of decisions) {
        const replayed = await services.decisions.replay(target.ownerId, row.id);
        assert.ok(replayed, 'AC5: every decision must be replayable by its owner');
        assert.equal(replayed!.matches, true,
          'AC5: the same input must produce the same outcome, or the audit proves nothing');
        assert.equal(replayed!.hashMatches, true, 'AC5: including the hash it was captured under');
        assert.equal(replayed!.outcomeMatches, true);
        assert.equal(replayed!.actionsTraceable, true,
          'AC5: and every action it produced is traceable to it');
      }
      const audit = decisions[decisions.length - 1];
      assert.ok(audit.decisionInputHash, 'AC5: the snapshot is identified by its hash');
      assert.ok((audit.decisionInput as { readAt?: string }).readAt,
        'AC5: and by the instant it read the world');
    });

    await scenario('AC5: an applied action is exactly-once under its key', async () => {
      const target = await world(services.db, 'ac5-idempotent', {
        policy: ProjectAutomationPolicy.AUTO,
      });
      const work = await task(services.db, target, 'work');
      const first = await dispatch(services, target, work, 1);
      assert.equal(first.status, 'APPLIED');

      // The same key again — a redelivery, a retry, a replica that did not see the commit.
      const replay = await dispatch(services, target, work, 1);
      assert.equal(replay.applyStatus, 'ALREADY_APPLIED',
        'AC5/§8.3: the second attempt under one key is not a second run');
      assert.equal(replay.actionId, first.actionId, 'and it resolves to the SAME ledger row');
      assert.equal(await services.db.session.count({ where: { taskId: work } }), 1,
        'AC5: exactly one session exists for one applied dispatch');
      assert.equal(
        await services.db.projectAction.count({
          where: { projectId: target.projectId, type: 'DISPATCH_TASK' } }), 1,
        'and exactly one ledger row');
    });

    // ----------------------------------------------------------------------------------------
    // AC6 / AC7 — verification consequences and parent aggregation.
    // ----------------------------------------------------------------------------------------

    await scenario('AC6: a FAIL reverts the subject, files a defect and blocks downstream',
      async () => {
        const target = await world(services.db, 'ac6-fail', { policy: ProjectAutomationPolicy.AUTO });
        const subject = await task(services.db, target, 'the work');
        const verifier = await task(services.db, target, 'the check', { verifiesTaskId: subject });
        const downstream = await task(services.db, target, 'depends on the work', {
          dependsOn: [subject],
        });
        await services.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
        await services.db.task.update({
          where: { id: verifier },
          data: { status: TaskStatus.DONE, verdict: TaskVerdict.FAIL },
        });

        const applied = await applyVerdicts(services, target);
        assert.equal(applied.length, 1, 'AC6: the conclusion is applied by the loop, once');
        assert.equal(applied[0].action.status, 'APPLIED');
        assert.ok(applied[0].defectTaskId, 'AC6: a defect subtask is FILED, not suggested');
        assert.ok(applied[0].failureId, 'AC6: and the condition is a row');
        assert.equal(applied[0].subjectReverted, true, 'AC6: the verified task is natively reverted');

        const revertedSubject = await services.db.task.findUniqueOrThrow({ where: { id: subject } });
        assert.notEqual(revertedSubject.status, TaskStatus.DONE,
          'AC6: "done" that failed its check is not done');

        // V3: downstream is stopped by a PRECONDITION, not by rewriting its status.
        const stillOpen = await services.db.task.findUniqueOrThrow({ where: { id: downstream } });
        assert.equal(stillOpen.status, TaskStatus.OPEN);
        const blocked = await dispatch(services, target, downstream);
        assert.equal(blocked.status, 'REFUSED');
        assert.ok(
          ['VERIFICATION_FAILED_UPSTREAM', 'VERIFICATION_DEFECT_OPEN', 'TASK_DEPENDENCIES_INCOMPLETE']
            .includes(blocked.reasonCode ?? ''),
          `AC6: the downstream block is mechanical (got ${blocked.reasonCode})`);

        await settle(services, target.projectId);
        const raised = await openBlockers(services, target.projectId);
        assert.ok(raised.some((blocker) => blocker.kind === 'VERIFICATION_FAILED'),
          'AC8: a failed check shows up where every other reason shows up');
      });

    await scenario('AC6: a later PASS clears the condition and the work may move again', async () => {
      const target = await world(services.db, 'ac6-pass', { policy: ProjectAutomationPolicy.AUTO });
      const subject = await task(services.db, target, 'the work');
      const verifier = await task(services.db, target, 'the check', { verifiesTaskId: subject });
      await services.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
      await services.db.task.update({
        where: { id: verifier },
        data: { status: TaskStatus.DONE, verdict: TaskVerdict.FAIL },
      });
      await applyVerdicts(services, target);
      await settle(services, target.projectId);
      assert.ok((await openBlockers(services, target.projectId))
        .some((blocker) => blocker.kind === 'VERIFICATION_FAILED'));

      // The check is re-run and this time it passes. §13.2 V7: a new conclusion, a new revision.
      await services.db.task.update({
        where: { id: verifier },
        data: { status: TaskStatus.DONE, verdict: TaskVerdict.PASS },
      });
      await applyVerdicts(services, target);
      await settle(services, target.projectId);

      const open = await openBlockers(services, target.projectId);
      assert.ok(!open.some((blocker) => blocker.kind === 'VERIFICATION_FAILED'),
        'AC6/§11.4: the condition clears because it stopped being true, not because it was told');
      const failures = await services.db.taskVerificationFailure.findMany({
        where: { verifierTaskId: verifier },
      });
      assert.ok(failures.every((failure) => failure.resolvedAt !== null),
        'AC6: the recorded failure is resolved rather than deleted');
    });

    await scenario('AC7: ALL_CHILDREN_DONE closes the parent with nobody maintaining it', async () => {
      const target = await world(services.db, 'ac7-all');
      const parent = await task(services.db, target, 'phase', {
        completionPolicy: 'ALL_CHILDREN_DONE', assigneeId: null,
      });
      const childA = await task(services.db, target, 'a', { parentTaskId: parent });
      const childB = await task(services.db, target, 'b', { parentTaskId: parent });

      await services.db.task.update({ where: { id: childA }, data: { status: TaskStatus.DONE } });
      await settle(services, target.projectId);
      assert.equal((await services.db.task.findUniqueOrThrow({ where: { id: parent } })).status,
        TaskStatus.OPEN, 'AC7: one child is not all of them');

      await services.db.task.update({ where: { id: childB }, data: { status: TaskStatus.DONE } });
      await settle(services, target.projectId);
      assert.equal((await services.db.task.findUniqueOrThrow({ where: { id: parent } })).status,
        TaskStatus.DONE, 'AC7: the parent settles itself once its policy is satisfied');

      // AG5: aggregation is a compare-and-set, deliberately NOT an action-ledger key — there is
      // no `AGGREGATE_PARENT` member of `ProjectActionType` at all, and no ledger row names the
      // parent this pass closed.
      assert.equal(await services.db.projectAction.count({
        where: { projectId: target.projectId, subjectId: parent } }), 0);

      // And it is reversible: reopening a child reopens the parent, so the tree cannot lie.
      await services.db.task.update({ where: { id: childB }, data: { status: TaskStatus.OPEN } });
      await settle(services, target.projectId);
      assert.equal((await services.db.task.findUniqueOrThrow({ where: { id: parent } })).status,
        TaskStatus.OPEN, 'AC7: an aggregate follows its children in both directions');
    });

    await scenario('AC7: VERIFICATION_PASSED holds the parent until the check concludes', async () => {
      const target = await world(services.db, 'ac7-verified');
      const parent = await task(services.db, target, 'phase', {
        completionPolicy: 'VERIFICATION_PASSED', assigneeId: null,
      });
      const child = await task(services.db, target, 'a', { parentTaskId: parent });
      const verifier = await task(services.db, target, 'check the phase', { verifiesTaskId: parent });

      await services.db.task.update({ where: { id: child }, data: { status: TaskStatus.DONE } });
      await settle(services, target.projectId);
      assert.equal((await services.db.task.findUniqueOrThrow({ where: { id: parent } })).status,
        TaskStatus.OPEN, 'AC7: children done is not the same as verified');

      await services.db.task.update({
        where: { id: verifier },
        data: { status: TaskStatus.DONE, verdict: TaskVerdict.PASS },
      });
      await settle(services, target.projectId);
      assert.equal((await services.db.task.findUniqueOrThrow({ where: { id: parent } })).status,
        TaskStatus.DONE, 'AC7: the passing check is what closes it');
    });

    // ----------------------------------------------------------------------------------------
    // AC8 — every stop is a structured blocker; nothing falls back in silence.
    // ----------------------------------------------------------------------------------------

    await scenario('AC8: an unavailable provider is a blocker, and a fallback is only ever explicit',
      async () => {
        const missing = `pcc22-gone-${randomUUID().slice(0, 8)}`;
        const target = await world(services.db, 'ac8-provider', {
          policy: ProjectAutomationPolicy.AUTO,
        });
        const work = await task(services.db, target, 'work', { provider: missing });
        const refused = await dispatch(services, target, work);
        assert.equal(refused.status, 'REFUSED');
        assert.equal(refused.reasonCode, 'PROVIDER_UNAVAILABLE',
          'AC8: an absent provider must not be silently swapped for a present one');
        assert.equal(await services.db.session.count({ where: { taskId: work } }), 0);

        await settle(services, target.projectId);
        const raised = await openBlockers(services, target.projectId);
        const blocker = raised.find((row) => row.kind === 'PROVIDER_UNAVAILABLE');
        assert.ok(blocker, 'AC8: with a row that answers who, what and when');
        assert.equal(blocker!.owner, 'SYSTEM');
        assert.equal(blocker!.recovery, 'EVENT');
        assert.ok(blocker!.requiredAction);
        assert.ok(blocker!.nextCheckAt, '§11.1: a recoverable blocker keeps a clock');

        // The world recovers. §11.4 BL3: it clears by RECOMPUTING, not by being told.
        await services.db.modelProvider.create({
          data: {
            ownerId: target.ownerId, slug: missing, label: missing, runtime: 'claude',
            baseUrl: 'https://pcc22.invalid', apiKeyEnc: 'iv:tag:ct', enabled: true,
            defaultModel: `${missing}-m`, models: [{ value: `${missing}-m`, label: missing }],
          },
        });
        const retried = await dispatch(services, target, work, 2);
        assert.equal(retried.status, 'APPLIED', 'AC8: the same task runs once the world recovers');
        await settle(services, target.projectId);
        assert.ok(!(await openBlockers(services, target.projectId))
          .some((row) => row.kind === 'PROVIDER_UNAVAILABLE'),
          'AC8: and the blocker clears itself');
      });

    await scenario('AC8: no matching runner is a blocker that clears when one comes back', async () => {
      const target = await world(services.db, 'ac8-runner', {
        policy: ProjectAutomationPolicy.AUTO,
        runnerStatus: RunnerStatus.OFFLINE,
      });
      const work = await task(services.db, target, 'work');
      const refused = await dispatch(services, target, work);
      assert.equal(refused.status, 'REFUSED');
      assert.equal(refused.refusalCode, 'NO_MATCHING_RUNNER');

      await settle(services, target.projectId);
      const raised = await openBlockers(services, target.projectId);
      assert.ok(raised.some((row) => row.kind === 'NO_MATCHING_RUNNER'), 'AC8: a structured stop');

      await services.db.runner.update({
        where: { id: target.runnerId },
        data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
      });
      const retried = await dispatch(services, target, work, 2);
      assert.equal(retried.status, 'APPLIED');
      await settle(services, target.projectId);
      assert.ok(!(await openBlockers(services, target.projectId))
        .some((row) => row.kind === 'NO_MATCHING_RUNNER'));
    });

    await scenario('AC8: a merge conflict names the branch and the paths', async () => {
      const target = await world(services.db, 'ac8-merge');
      const work = await task(services.db, target, 'work');
      await session(services.db, target, {
        taskId: work,
        branch: 'orbit/work',
        mergeStatus: 'conflict',
        mergeTarget: 'main',
        changedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      });

      await settle(services, target.projectId, 'merge.conflict');
      const blocker = (await openBlockers(services, target.projectId))
        .find((row) => row.kind === 'MERGE_CONFLICT');
      assert.ok(blocker, 'AC8: a conflict is a first-class stop');
      assert.equal(blocker!.subjectType, 'TASK');
      const detail = blocker!.detail as { mergeTarget?: string; paths?: string[] };
      assert.equal(detail.mergeTarget, 'main');
      assert.deepEqual(detail.paths, ['src/a.ts', 'src/b.ts'],
        'AC8: with enough in it for a person to act without excavating');
      assert.ok(blocker!.requiredAction);
    });

    await scenario('AC8: an exhausted retry budget is a blocker, and the backoff before it is not',
      async () => {
        const target = await world(services.db, 'ac8-retry', { policy: ProjectAutomationPolicy.AUTO });
        const work = await task(services.db, target, 'work');

        // Inside the backoff: nobody has to do anything, so §9.5 Q3-a says there is no blocker —
        // only a definite retry instant, which is §10.4 clause 3's wake.
        await failTask(services.db, target, work, 1);
        const deferred = await dispatch(services, target, work);
        assert.equal(deferred.status, 'REFUSED');
        assert.equal(deferred.reasonCode, 'RETRY_BACKOFF_ACTIVE');
        await settle(services, target.projectId);
        assert.equal((await openBlockers(services, target.projectId)).length, 0,
          'AC8/§9.5 Q3-a: a scheduled retry is not a blocker');
        const scheduled = await runtime(services, target.projectId);
        assert.ok(scheduled.nextWakeAt, 'AC3: but it does have a clock');

        // Out of attempts: now somebody has to look.
        await failTask(services.db, target, work, 4, new Date(Date.now() - 60_000));
        await settle(services, target.projectId);
        const raised = await openBlockers(services, target.projectId);
        assert.ok(raised.some((row) => row.kind === 'TEST_FAILED'),
          'AC8: an exhausted retry budget is a structured stop');
      });

    await scenario('AC8: waiting on a person has an owner, an action and an escalation', async () => {
      const target = await world(services.db, 'ac8-human', { policy: ProjectAutomationPolicy.AUTO });
      // A SECOND agent, so the one that gets switched off is the assignee and not the coordinator:
      // a disabled coordinator is `COORDINATOR_AGENT_DISABLED`, a different row of §11.2's table.
      const worker = await services.db.workspace.create({
        data: {
          ownerId: target.ownerId, runnerId: target.runnerId, name: 'ac8-human-worker', enabled: true,
        },
      });
      await services.db.projectMember.create({
        data: { projectId: target.projectId, agentId: worker.id, role: 'MEMBER' },
      });
      const work = await task(services.db, target, 'work', { assigneeId: worker.id });
      await services.db.workspace.update({ where: { id: worker.id }, data: { enabled: false } });

      const refused = await dispatch(services, target, work);
      assert.equal(refused.status, 'REFUSED');
      assert.equal(refused.reasonCode, 'WHO_DISABLED');
      await settle(services, target.projectId);

      const blocker = (await openBlockers(services, target.projectId))
        .find((row) => row.kind === 'WHO_DISABLED');
      assert.ok(blocker, 'AC8: waiting on a person is recorded, not implied');
      assert.equal(blocker!.owner, 'USER', '§11.1: who has to act');
      assert.equal(blocker!.recovery, 'HUMAN', '§11.1: how it can end');
      assert.ok(blocker!.requiredAction, '§11.1: what that person has to do');
      assert.equal(blocker!.escalatedAt, null, 'not yet — the alarm has not gone off');
      assert.ok(blocker!.nextCheckAt, '§10.4 clause 2: an un-escalated blocker still has a clock');

      const state = await runtime(services, target.projectId);
      assert.equal(state.runState, 'AWAITING_HUMAN',
        'AC3: a project waiting on a person is not idling — it says so');

      // §11.5: the alarm goes off exactly once, however many passes run after it.
      await services.db.projectBlocker.update({
        where: { id: blocker!.id },
        data: { firstSeenAt: new Date(Date.now() - 4 * 60 * 60_000) },
      });
      await settle(services, target.projectId);
      const escalated = (await openBlockers(services, target.projectId))
        .find((row) => row.kind === 'WHO_DISABLED');
      assert.ok(escalated?.escalatedAt, 'AC8: a blocker nobody cleared is escalated');
      const firstAlarm = escalated!.escalatedAt!.getTime();
      await settle(services, target.projectId);
      const again = (await openBlockers(services, target.projectId))
        .find((row) => row.kind === 'WHO_DISABLED');
      assert.equal(again!.escalatedAt!.getTime(), firstAlarm,
        'AC8: escalation is once per episode, not once per pass');
    });

    await scenario('AC8: the same cause does not open a second episode', async () => {
      const missing = `pcc22-gone-${randomUUID().slice(0, 8)}`;
      const target = await world(services.db, 'ac8-dedupe', { policy: ProjectAutomationPolicy.AUTO });
      const work = await task(services.db, target, 'work', { provider: missing });

      await dispatch(services, target, work, 1);
      await settle(services, target.projectId);
      await dispatch(services, target, work, 2);
      await settle(services, target.projectId);
      await dispatch(services, target, work, 3);
      await settle(services, target.projectId);

      const episodes = await services.db.projectBlocker.findMany({
        where: { projectId: target.projectId, kind: 'PROVIDER_UNAVAILABLE' },
      });
      assert.equal(episodes.length, 1, 'AC8/§11.3: one cause is one episode');
      assert.equal(String(episodes[0].lifecycleGeneration), '1');
      assert.ok(episodes[0].occurrences >= 2, 'and the repeats are counted, not multiplied');
    });

    // ----------------------------------------------------------------------------------------
    // AC10 — the control surface answers "why is this not moving", in every state.
    // ----------------------------------------------------------------------------------------

    await scenario('AC10: coordinator status answers empty, legacy, running and blocked', async () => {
      const empty = await world(services.db, 'ac10-empty');
      const emptyStatus = await services.projects.coordinatorStatus(empty.ownerId, empty.projectId);
      assert.equal(emptyStatus.policy.coordinatorEnabled, true);
      assert.equal(emptyStatus.runtime.runState, 'PLANNING');
      assert.equal(emptyStatus.blockers.open.length, 0, 'AC10: an empty project is an empty answer');
      assert.equal(emptyStatus.blockers.openEmptyReason, 'NO_OPEN_BLOCKER',
        'AC10: and empty says WHY it is empty rather than looking like a failed read');
      assert.equal(emptyStatus.decisions.length, 0);
      assert.equal(emptyStatus.decisionsEmptyReason, 'NO_DECISION_YET');
      assert.equal(emptyStatus.nextWake.at, null);
      assert.equal(emptyStatus.nextWake.absentReason, 'NO_WAKE_SCHEDULED');

      const legacy = await world(services.db, 'ac10-legacy', { coordinatorEnabled: false });
      const legacyStatus = await services.projects.coordinatorStatus(legacy.ownerId, legacy.projectId);
      assert.equal(legacyStatus.policy.coordinatorEnabled, false,
        'AC10/AC11: a project outside the loop reads as off, not as broken');

      const blocked = await world(services.db, 'ac10-blocked', { policy: ProjectAutomationPolicy.AUTO });
      const work = await task(services.db, blocked, 'work', {
        provider: `pcc22-gone-${randomUUID().slice(0, 8)}`,
      });
      await dispatch(services, blocked, work);
      await settle(services, blocked.projectId);
      const blockedStatus = await servePublicIds(
        await services.projects.coordinatorStatus(blocked.ownerId, blocked.projectId)
      ) as Awaited<ReturnType<typeof services.projects.coordinatorStatus>>;
      assert.ok(blockedStatus.blockers.open.length > 0, 'AC10: what is stopping it');
      assert.ok(blockedStatus.blockers.open[0].requiredAction, 'AC10: and what would clear it');
      assert.ok(blockedStatus.decisions.length > 0, 'AC10: the last few decisions');
      assert.ok(blockedStatus.nextWake.at, 'AC10: when it next wakes');
      assert.ok(blockedStatus.nextWake.reason);
      assert.deepEqual(rawUuidPaths(blockedStatus, '$'), []);
    });

    await scenario('AC10: a trigger composed against a stale revision is refused, and writes nothing',
      async () => {
        const target = await world(services.db, 'ac10-cas');
        await services.projects.update(target.ownerId, target.projectId, { maxConcurrentTasks: 2 });
        const current = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
        assert.equal(String(current.configRevision), '1');
        const before = await services.db.projectEvent.count({ where: { projectId: target.projectId } });

        await assert.rejects(
          () => services.projects.triggerCoordinator(target.ownerId, target.projectId, {
            expectedConfigRevision: '0',
          }),
          (error: unknown) => (error as { response?: { code?: string } })?.response?.code
            === STALE_CONFIG_REVISION_CODE,
          'AC10: a button pressed against settings that have moved is refused by code');
        assert.equal(await services.db.projectEvent.count({ where: { projectId: target.projectId } }),
          before, 'AC10: and the refusal writes nothing');

        // The same trigger id twice is one request, not two runs (§7.6 TR2).
        const triggerId = randomUUID();
        const first = await services.projects.triggerCoordinator(target.ownerId, target.projectId, {
          expectedConfigRevision: '1', triggerId,
        });
        const second = await services.projects.triggerCoordinator(target.ownerId, target.projectId, {
          expectedConfigRevision: '1', triggerId,
        });
        assert.equal(first.triggerId, second.triggerId);
        const manual = await services.db.projectEvent.findMany({
          where: { projectId: target.projectId, kind: 'user.manual_trigger', consumedAt: null },
        });
        assert.equal(manual.length, 1, 'AC10: a double click is one signal');
        assert.ok(manual[0].occurrences >= 2, 'and the second is counted on the same row');

        // The off switch refuses it outright rather than accepting a request that never happens.
        await services.projects.update(target.ownerId, target.projectId, {
          coordinatorEnabled: false,
        });
        await assert.rejects(
          () => services.projects.triggerCoordinator(target.ownerId, target.projectId, {}),
          (error: unknown) => (error as { response?: { code?: string } })?.response?.code
            === COORDINATOR_DISABLED_CODE);
      });

    await scenario('AC10: the blocker face keeps the resolved episode', async () => {
      const missing = `pcc22-gone-${randomUUID().slice(0, 8)}`;
      const target = await world(services.db, 'ac10-history', { policy: ProjectAutomationPolicy.AUTO });
      const work = await task(services.db, target, 'work', { provider: missing });
      await dispatch(services, target, work, 1);
      await settle(services, target.projectId);
      assert.equal(
        (await services.projects.blockers(target.ownerId, target.projectId)).blockers.length, 1);

      await services.db.modelProvider.create({
        data: {
          ownerId: target.ownerId, slug: missing, label: missing, runtime: 'claude',
          baseUrl: 'https://pcc22.invalid', apiKeyEnc: 'iv:tag:ct', enabled: true,
          defaultModel: `${missing}-m`, models: [{ value: `${missing}-m`, label: missing }],
        },
      });
      await dispatch(services, target, work, 2);
      await settle(services, target.projectId);

      const current = await services.projects.blockers(target.ownerId, target.projectId);
      assert.equal(current.blockers.length, 0, 'AC10: it is no longer stopping anything');
      const history = await servePublicIds(
        await services.projects.blockers(target.ownerId, target.projectId, true)
      ) as Awaited<ReturnType<typeof services.projects.blockers>>;
      assert.equal(history.blockers.length, 1,
        'AC10: and "what was blocking this an hour ago" is still answerable');
      assert.ok(history.blockers[0].resolvedAt);
      assert.equal(history.blockers[0].resolvedBy, 'AUTO');
      assert.deepEqual(rawUuidPaths(history, '$'), []);
    });
  } finally {
    await services.dispose();
    await identity.end();
  }
});

/**
 * Apply every verdict this snapshot concludes, through the production service.
 *
 * The plan comes from `verificationVerdictPlan` — the same function the decision planner and the
 * blocker face both read, so the three cannot disagree about what a check concluded.
 */
async function applyVerdicts(services: E2eServices, target: World) {
  const lease = await services.reconciler.acquireLease(target.projectId);
  assert.ok(lease, 'the project under test must be leasable');
  try {
    const decisionId = createDecisionId();
    const planned = await services.db.$transaction(async (tx) => {
      const captured = await services.decisions.capture(tx, target.projectId);
      const plan = verificationVerdictPlan(captured.input);
      // §8.3: an action no decision proposed may not be claimed against it, so the pass that
      // will apply these conclusions is the pass that has to write them into its own plan.
      const outcome = planProjectDecision(captured.input, {
        decisionId,
        actions: plan.map((verdict) => ({
          type: 'APPLY_VERIFICATION_VERDICT',
          idempotencyKey: publicIdempotencyKey(verificationVerdictActionKey(
            target.projectId, base62ToUuid(verdict.verifierTaskId), verdict.verdictRevision)),
          subject: { type: 'TASK', id: verdict.verifierTaskId },
        })),
      });
      await services.decisions.persist(tx, captured, outcome, decisionId);
      return plan;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const applied = [];
    for (const verdict of planned) {
      applied.push(await services.verdicts.apply(lease, { decisionId, planned: verdict }));
    }
    return applied;
  } finally {
    await services.reconciler.releaseLease(lease);
  }
}
