import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * The plug, asserted as wiring rather than as prose.
 *
 * `CompletionInputRouter` was registered, exported and injected into `TasksService` months before
 * anything in that file called it: the constructor parameter, the assignment and the private field
 * were all there, and `this.completionInputs` appeared nowhere else. A service that HOLDS a
 * collaborator looks identical, in every type and in every module graph, to one that USES it — so
 * neither `tsc` nor a DI check can tell the two apart, and the gap survived exactly that long.
 *
 * Two things are therefore checked here, and they are the two halves that were missing:
 *
 *   1. the task write path calls the router at all, counted over the source a reviewer reads; and
 *   2. the producer that call reaches is really a provider of the module the router lives in,
 *      resolved through Nest rather than matched as a string in a file.
 *
 * What the delivery is worth — that it happens after the transaction commits, and that it puts
 * exactly one row in the wake ledger — needs a database and lives in
 * `task-write-settled-delivery.pg.spec.ts`.
 */

// Resolved against the package root: this runs from `build/tasks`, and the subject is the
// TypeScript, not the JavaScript it compiles to.
const TASKS_SERVICE = path.resolve(__dirname, '../../src/tasks/tasks.service.ts');

/**
 * Blank comments out without moving a line.
 *
 * `tasks.service.ts` describes its own collaborators in prose, and a census that counted a
 * sentence about the router would be green over a service that still never calls one.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead: string) => lead + ' '.repeat(line.length - lead.length));
}

/** `this.completionInputs.someMethod(` — a CALL, which the constructor's assignment is not. */
const ROUTER_CALL = /\bthis\.completionInputs\s*(?:\?\.|\.)\s*([A-Za-z0-9_$]+)\s*\(/g;
/** The shape the gap consisted of: holding the collaborator and doing nothing with it. */
const ROUTER_ASSIGNMENT = /\bthis\.completionInputs\s*=/;

function routerCallSites(source: string): { method: string; line: number }[] {
  const text = withoutComments(source);
  const sites: { method: string; line: number }[] = [];
  for (const match of text.matchAll(ROUTER_CALL)) {
    sites.push({
      method: match[1]!,
      line: text.slice(0, match.index).split('\n').length,
    });
  }
  return sites;
}

test('the task write path calls CompletionInputRouter, not merely holds one', () => {
  const source = readFileSync(TASKS_SERVICE, 'utf8');
  const sites = routerCallSites(source);

  assert.ok(
    sites.length > 0,
    'tasks.service.ts holds a CompletionInputRouter and never calls it — the wire reaches the '
      + 'door and the plug is not in',
  );
  // The field is still assigned in the constructor; the count above is of calls, and this states
  // that the census can tell the two apart rather than counting the injection as a use.
  assert.match(withoutComments(source), ROUTER_ASSIGNMENT);
});

test('the census counts calls and not the injection that used to be all there was', () => {
  // The tree as it stood before this work: injected, assigned, never called. A census that
  // reported a call here would report one for any service that merely accepts the collaborator.
  const held = `
    constructor(completionInputs?: CompletionInputRouter) {
      this.completionInputs = completionInputs;
    }
    private readonly completionInputs?: CompletionInputRouter;
  `;
  assert.deepEqual(routerCallSites(held), []);

  // And a mention in prose is not a call either.
  assert.deepEqual(
    routerCallSites('// this.completionInputs.routeSettledProjects(ids) is what T7 needs\n'),
    [],
  );

  assert.deepEqual(
    routerCallSites('await this.completionInputs.routeSettledProjects(ids);').map((s) => s.method),
    ['routeSettledProjects'],
  );
});

/**
 * Stand-ins for what the real application root supplies through its @Global modules — Prisma, the
 * queue, realtime, and the JWT the session controllers' guard is built from. Nothing below calls a
 * method on any of them: the claim is about what Nest can CONSTRUCT, so an empty double is the
 * right shape and a test that reached one would fail rather than pass quietly.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: QueueService, useValue: {} },
    { provide: RealtimeService, useValue: { publishForUser: () => undefined } },
    { provide: JwtService, useValue: {} },
  ],
  exports: [PrismaService, QueueService, RealtimeService, JwtService],
})
class GlobalDoubles {}

@Module({ imports: [GlobalDoubles, CoordinatorJudgmentModule] })
class WiringHarness {}

test('the judgment module can construct the producer the router delivers through', async (t) => {
  const context = await NestFactory.createApplicationContext(WiringHarness, {
    logger: false,
    abortOnError: false,
  });
  t.after(() => context.close());

  const producer = context.get(ProjectTasksSettledProducer);
  assert.ok(
    producer instanceof ProjectTasksSettledProducer,
    'unit T7 is not a provider of the module that owns its two collaborators',
  );
  // One instance, not one per injection site: the router below resolves the same object, which is
  // what makes "both task write doors deliver through one producer" true rather than intended.
  assert.equal(context.get(ProjectTasksSettledProducer), producer);

  const router = context.get(CompletionInputRouter);
  assert.ok(router instanceof CompletionInputRouter);
  assert.equal(typeof router.routeSettledProjects, 'function');
});
