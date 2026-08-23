import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { ProjectEventsService } from './project-events.service';
import { ProjectsModule } from './projects.module';
import {
  PROJECT_RECONCILE_TIMER_MS,
  PROJECT_TELEMETRY_PRUNE_INTERVAL_MS,
  ProjectReconcileService,
} from './project-reconcile.service';

function sqlText(arg: unknown): string {
  const parts = (arg as { strings?: readonly string[] })?.strings ?? (arg as readonly string[]);
  return Array.isArray(parts) ? parts.join(' ') : String(arg);
}

test('the orchestration service registers once and owns exactly one recovery timer', async () => {
  const providers = Reflect.getMetadata('providers', ProjectsModule) as unknown[];
  assert.equal(
    providers.filter((provider) => provider === ProjectReconcileService).length,
    1,
    'ProjectsModule must provide one reconcile singleton',
  );

  let registered: unknown;
  let unregistered = 0;
  let drains = 0;
  let cleared = 0;
  const eventService = {
    registerHandler: (handler: unknown) => {
      registered = handler;
      return () => { unregistered += 1; };
    },
    drainAvailable: async () => { drains += 1; return 0; },
  } as unknown as ProjectEventsService;
  const prisma = { $executeRaw: async () => 0 } as never;
  const service = new ProjectReconcileService(prisma, eventService);

  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const intervals: Array<{ delay: number; unref: number }> = [];
  const fakeTimer = { unref: () => { intervals[0].unref += 1; } };
  globalThis.setInterval = ((_callback: () => void, delay?: number) => {
    intervals.push({ delay: Number(delay), unref: 0 });
    return fakeTimer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {
    cleared += 1;
  }) as typeof clearInterval;

  try {
    service.onModuleInit();
    await waitImmediate();
    assert.equal(registered, service);
    assert.deepEqual(intervals, [{ delay: PROJECT_RECONCILE_TIMER_MS, unref: 1 }]);
    assert.equal(drains, 2, 'the initial pass drains before and after durable wake creation');

    service.onModuleDestroy();
    assert.equal(cleared, 1);
    assert.equal(unregistered, 1);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('the shared recovery tick runs bounded telemetry retention at one-hour cadence', async () => {
  const statements: string[] = [];
  let drains = 0;
  const prisma = {
    $executeRaw: async (query: unknown) => {
      statements.push(sqlText(query));
      return 0;
    },
  } as never;
  const events = {
    drainAvailable: async () => { drains += 1; return 0; },
  } as unknown as ProjectEventsService;
  // Truthy because Nest supplies the decision service in production. Its methods are not needed
  // when this no-event harness only drives the recovery/retention cadence.
  const service = new ProjectReconcileService(prisma, events, {} as never);
  const started = new Date('2030-01-01T00:00:00.000Z');

  await service.tick(started);
  await service.tick(new Date(started.getTime() + PROJECT_TELEMETRY_PRUNE_INTERVAL_MS - 1));
  await service.tick(new Date(started.getTime() + PROJECT_TELEMETRY_PRUNE_INTERVAL_MS));

  assert.equal(drains, 6, 'retention adds no second clock or drain path');
  assert.equal(statements.filter((sql) => sql.includes('DELETE FROM "project_event"')).length, 2);
  assert.equal(statements.filter((sql) => sql.includes('DELETE FROM "project_decision"')).length, 2);
});
