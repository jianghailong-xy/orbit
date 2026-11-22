import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NestApplicationContext, NestFactory, type ModuleRef } from '@nestjs/core';

import { AppModule } from '../app.module';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * §12.15 P-M1, M-F1: the finish that decides a deferred landing asks for the project's promotion
 * candidate again through `CompletionInputRouter.considerPromotionAfterSettledWork`, which finds
 * `ProjectPromotionService` by ModuleRef at the call (a value import closes a file ring through
 * `ProjectFuseService`). If that lookup did not resolve in the real application, an empty branch's
 * finish would ask nobody and the project's candidate would never appear — so:
 *
 *  (1) the real AppModule's whole provider graph is built (every module, every provider constructed,
 *      lifecycle hooks not run: no database is reached and no timer starts), and the router the task
 *      write path and the reaper hold is the graph's one router, whose lookup reaches the graph's one
 *      ProjectPromotionService — the instance the runner's landing door asks too;
 *  (2)(3) a lookup that cannot resolve is an error naming the project, never a quiet return.
 */

/** Every provider of AppModule constructed and wired, with no lifecycle hook run. */
async function appGraph() {
  // PrismaService reads its URL when it is constructed; nothing below ever connects to it.
  process.env.DATABASE_URL ??= 'postgresql://wiring:wiring@127.0.0.1:9/wiring';
  // The JWT module's factory refuses to build without a secret; this graph signs nothing.
  process.env.JWT_SECRET ??= 'promotion-lookup-wiring-spec-secret-not-used-for-anything';
  const proto = NestApplicationContext.prototype as unknown as Record<string, unknown>;
  const hooks = ['callInitHook', 'callBootstrapHook', 'callDestroyHook', 'callBeforeShutdownHook', 'callShutdownHook'];
  const saved = hooks.map((name) => proto[name]);
  for (const name of hooks) proto[name] = async () => undefined;
  const context = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  return {
    context,
    async close() {
      await context.close();
      hooks.forEach((name, i) => { proto[name] = saved[i]; });
    },
  };
}

test('(1) in the real AppModule graph, settled work reaches the one ProjectPromotionService the landing door asks', async (t) => {
  const { context, close } = await appGraph();
  t.after(close);

  const router = context.get(CompletionInputRouter, { strict: false });
  const tasks = context.get(TasksService, { strict: false });
  const reaper = context.get(ReaperService, { strict: false });
  assert.equal((tasks as unknown as { completionInputs: unknown }).completionInputs, router,
    'TasksService (the runner finalize\'s settled-work door) holds the graph\'s router');
  assert.equal((reaper as unknown as { completionInputs: unknown }).completionInputs, router,
    'the reaper\'s forced finish holds the graph\'s router');

  const promotions = context.get(ProjectPromotionService, { strict: false });
  assert.ok(promotions instanceof ProjectPromotionService);
  const runnerApi = context.get(RunnerApiController, { strict: false });
  assert.equal((runnerApi as unknown as { promotions: unknown }).promotions, promotions,
    'the landing result door asks the same instance');

  const considered: string[] = [];
  promotions.considerCandidate = async (projectId: string) => { considered.push(projectId); return null; };
  const logged: string[] = [];
  const logger = (router as unknown as { logger: Record<'error' | 'warn', (m: string) => void> }).logger;
  logger.error = (m) => { logged.push(m); };
  logger.warn = (m) => { logged.push(m); };

  await router.considerPromotionAfterSettledWork(['project-1', null, 'project-1', 'project-2']);

  assert.deepEqual(logged, [], 'the lookup resolved, with nothing logged');
  assert.deepEqual(considered, ['project-1', 'project-2'], 'the graph\'s ProjectPromotionService was asked, once per project');
});

/** A router built by hand: the six producers it needs are never reached by this door. */
function handBuiltRouter(moduleRef?: Partial<ModuleRef>) {
  const router = new CompletionInputRouter(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, moduleRef as ModuleRef | undefined,
  );
  const errors: string[] = [];
  (router as unknown as { logger: { error: (m: string) => void } }).logger.error = (m) => { errors.push(m); };
  return { router, errors };
}

test('(2) a router with no module graph logs an error naming the project, not a quiet return', async () => {
  const { router, errors } = handBuiltRouter();
  await router.considerPromotionAfterSettledWork(['project-without-a-graph']);
  assert.equal(errors.length, 1, 'one error');
  assert.match(errors[0]!, /project-without-a-graph/);
  assert.match(errors[0]!, /ProjectPromotionService not found/);
});

test('(3) a lookup that throws logs an error naming every project it left unasked', async () => {
  const { router, errors } = handBuiltRouter({
    get: (() => { throw new Error('Nest could not find ProjectPromotionService element'); }) as never,
  });
  await router.considerPromotionAfterSettledWork(['project-a', 'project-b']);
  assert.equal(errors.length, 1, 'one error');
  assert.match(errors[0]!, /project-a, project-b/);
  assert.match(errors[0]!, /Nest could not find ProjectPromotionService element/);
});

test('(4) nothing to ask is not an error', async () => {
  const { router, errors } = handBuiltRouter();
  await router.considerPromotionAfterSettledWork([null, undefined]);
  assert.deepEqual(errors, []);
});
