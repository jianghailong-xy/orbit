/**
 * The shape of the scheduled tasks' doors (docs/scheduled-tasks-design.md §9.1), read off the controllers themselves:
 *
 *   (a) REST has exactly the read and control routes, the drafts of the Scheduled page, Change…'s conversation
 *       (which opens a session, as a draft does; the session changes the schedule), the two card presses and rename:
 *       no route creates a schedule or changes one (no POST /schedules, no PATCH or PUT anywhere under it), except
 *       POST /schedules/:id/rename, the one door that changes a schedule, whose body is the title alone (§8.4,
 *       owner 2026-11-26). No other controller in the server serves a path under /schedules or /schedule-*.
 *   (b) The two card presses are owner channel only: closed to every access token (OWNER_INTERACTIVE), not open to
 *       `orbit` in a terminal (no @TerminalRoute), and refused to a request carrying an acting session.
 *   (c) Nothing under /runner answers a card, and `orbit mcp` has no tool that does: a session, a run, an MCP tool
 *       call and the Orbit CLI acting as an agent all reach the server only through /runner.
 *   (d) The tools say which of Orbit's four timers to use (§1).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';

import { patDeclaration } from '../auth/pat-scope.decorator';
import { TERMINAL_ROUTE } from '../auth/terminal-credentials';
import { RunnerSchedulesController } from '../runner-api/runner-schedules.controller';
import { ScheduleRenameDto } from './dto';
import { SchedulesController, scheduleActorOf } from './schedules.controller';

const reflector = new Reflector();

function routesOf(controller: Function): Array<{ handler: string; method: string; path: string }> {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(/^\/|\/$/g, '');
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .flatMap((name) => {
      const fn = proto[name] as Function;
      const path = Reflect.getMetadata(PATH_METADATA, fn);
      if (path === undefined) return [];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
      return [{ handler: name, method, path: [base, String(path)].filter(Boolean).join('/') }];
    });
}

test('(a) REST is read, control, drafts, the two presses and rename: nothing else creates or changes a schedule', () => {
  const routes = routesOf(SchedulesController).map((r) => `${r.method} /${r.path}`).sort();
  assert.deepEqual(routes, [
    'DELETE /schedules/:id',
    'GET /schedule-requests',
    'GET /schedule-requests/:id',
    'GET /schedules',
    'GET /schedules/:id',
    'GET /schedules/:id/change',
    'GET /schedules/:id/runs',
    'GET /schedules/drafts',
    'GET /sessions/:id/schedule-cards',
    'POST /schedule-requests/:id/allow',
    'POST /schedule-requests/:id/decline',
    'POST /schedule-runs/:id/stop',
    'POST /schedules/:id/change',
    'POST /schedules/:id/pause',
    'POST /schedules/:id/rename',
    'POST /schedules/:id/resume',
    'POST /schedules/:id/run',
    'POST /schedules/:id/undo',
    'POST /schedules/drafts',
  ].sort());
  for (const r of routesOf(SchedulesController)) {
    assert.ok(!(r.method === 'POST' && r.path === 'schedules'), 'no POST /schedules: a schedule is created only by a card');
    assert.ok(r.method !== 'PATCH' && r.method !== 'PUT', `${r.method} /${r.path}: no REST door changes a schedule`);
  }
  // The exception carries a title and nothing else: the global whitelist refuses any other field.
  assert.deepEqual(
    [...new Set(getMetadataStorage().getTargetValidationMetadatas(ScheduleRenameDto, '', false, false).map((m) => m.propertyName))],
    ['title'],
  );
});

test('(a) no other controller serves a path under /schedules or /schedule-*', () => {
  // The sources, not build/: build/ also holds links into node_modules.
  const root = join(__dirname, '..', '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === 'node_modules') continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.controller\.ts$/.test(name) && !/schedules\.controller\.ts$/.test(name)) {
        if (/['"`]\/?schedule(s|-[a-z]+)(\/|['"`])/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test('(b) Create, Allow and Decline are closed to tokens, not terminal routes, and refuse an acting session', () => {
  for (const handler of ['allow', 'decline'] as const) {
    const fn = SchedulesController.prototype[handler];
    assert.deepEqual(patDeclaration(reflector, fn, SchedulesController), { kind: 'FORBIDDEN', reason: 'OWNER_INTERACTIVE' });
    assert.equal(Reflect.getMetadata(TERMINAL_ROUTE, fn), undefined, `${handler} must not be open to a terminal`);
  }
  // A request carrying an acting session is that session, whatever credential carried it.
  const user = { userId: '00000000-0000-7000-8000-000000000001', email: 'x', credential: { kind: 'LOGIN' as const } };
  const sessionId = '00000000-0000-7000-8000-000000000002';
  assert.deepEqual(scheduleActorOf(user, { headers: { 'x-orbit-session-id': sessionId } }), {
    kind: 'SESSION', ownerId: user.userId, sessionId,
  });
  assert.deepEqual(scheduleActorOf({ ...user, credential: { kind: 'PAT', tokenId: 't', scopes: [], workspaceIds: [] } }, { headers: {} }), {
    kind: 'PAT', ownerId: user.userId,
  });
  assert.deepEqual(scheduleActorOf(user, { headers: {} }), { kind: 'OWNER', ownerId: user.userId });
});

test('(c) nothing under /runner answers a card, and orbit mcp has no tool that does', () => {
  const runnerRoutes = routesOf(RunnerSchedulesController).map((r) => `${r.method} /${r.path}`).sort();
  assert.deepEqual(runnerRoutes, [
    'DELETE /runner/schedules/:id',
    'GET /runner/schedules',
    'GET /runner/schedules/:id',
    'PATCH /runner/schedules/:id',
    'POST /runner/schedule-runs/:id/stop',
    'POST /runner/schedule-runs/report',
    'POST /runner/schedules',
    'POST /runner/schedules/:id/end',
    'POST /runner/schedules/:id/pause',
    'POST /runner/schedules/:id/resume',
    'POST /runner/schedules/:id/run',
  ].sort());
  const goSource = readFileSync(join(__dirname, '..', '..', '..', 'runner-go', 'schedule_tools.go'), 'utf8');
  assert.doesNotMatch(goSource, /schedule-requests|\/allow|\/decline/, 'orbit mcp must not reach a card press');
  const tools = [...goSource.matchAll(/"name":\s+"(schedule_[a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tools, [
    'schedule_create', 'schedule_delete', 'schedule_end', 'schedule_get', 'schedule_list', 'schedule_pause',
    'schedule_resume', 'schedule_run_now', 'schedule_run_stop', 'schedule_update',
  ]);
  assert.match(goSource, /"name": scheduleRunReportTool/);
});

test('(d) schedule_create and schedule_wakeup carry the choice between the five timers', () => {
  const goDir = join(__dirname, '..', '..', '..', 'runner-go');
  const tools = readFileSync(join(goDir, 'schedule_tools.go'), 'utf8');
  for (const words of ['schedule_wakeup with recurring: true', 'task_await, session_await or watch_create', "the task's runAt", 'schedule_create']) {
    assert.ok(tools.includes(words), `the timer choice names ${words}`);
  }
  // The fifth (docs/condition-triggers-design.md §8): something outside Orbit becoming true is a condition.
  assert.match(tools, /outlives this conversation\. " \+ conditionTimerCase/);
  const conditions = readFileSync(join(goDir, 'condition_tools.go'), 'utf8');
  for (const words of ['When something outside Orbit becomes true', 'not a bg_run poll and not a daily', 'wait until X']) {
    assert.ok(conditions.includes(words), `the condition timer names ${words}`);
  }
  assert.match(tools, /"description": "Propose a scheduled task[^]*?scheduleTimerChoice/);
  const catalog = readFileSync(join(goDir, 'operation_catalog.go'), 'utf8');
  assert.match(catalog, /"name": "schedule_wakeup",[^]*?scheduleTimerChoice,\n/);
});
