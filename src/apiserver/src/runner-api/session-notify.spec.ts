import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';
import { RunnerNotifyController } from './runner-notify.controller';

/**
 * The daemon's alert about a background job of one of its sessions, POST /runner/sessions/:id/notify
 * (docs/runner-link-design.md §15.9), is the alert the agents' door sends with the session in X-Orbit-Session-Id
 * (POST /runner/notify, which the daemon used until 2026-10-28): the same call to the push channel, argument for
 * argument, and the same answer. It is the daemon's door, so it takes only a session of the runner's own.
 */

const SESSION = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const OTHERS = '019fe1dd-3f39-7610-8e5d-507e36a4ea9c';
const LANDING = '019fe1dd-3f39-7610-8e5d-507e36a4ea9d';
const MESSAGE = 'Background shell job-1 ended (exit code 0): make';

function doors() {
  const asked: unknown[] = [];
  const push = {
    notifyAgentMessage: async (input: unknown) => {
      asked.push(input);
      return { delivered: true, devices: 1 };
    },
  };
  const sessions: Record<string, object> = {
    [SESSION]: { id: SESSION, ownerId: 'owner-1', assignedRunnerId: 'runner-1', sessionKind: 'STANDARD' },
    [OTHERS]: { id: OTHERS, ownerId: 'owner-1', assignedRunnerId: 'runner-2', sessionKind: 'STANDARD' },
    [LANDING]: { id: LANDING, ownerId: 'owner-1', assignedRunnerId: null, sessionKind: 'LANDING' },
  };
  const prisma = { session: { findUnique: async ({ where }: { where: { id: string } }) => sessions[where.id] ?? null } };
  const daemon = new RunnerApiController(prisma as never, {} as never, {} as never, push as never, {} as never, {} as never);
  return { asked, daemon, agents: new RunnerNotifyController(push as never) };
}

test('the daemon\'s alert asks the push channel exactly what the agents\' door asks for the same session', async () => {
  for (const [runner, title] of [
    [{ id: 'runner-1', ownerId: 'owner-1', name: 'the machine', displayName: 'Desk' }, 'Desk'],
    [{ id: 'runner-1', ownerId: 'owner-1', name: 'the machine', displayName: null }, 'the machine'],
    [{ id: 'runner-1', ownerId: 'owner-1', name: '', displayName: null }, 'Orbit'],
  ] as const) {
    const { asked, daemon, agents } = doors();
    const fromDaemon = await daemon.sessionNotify(runner as never, SESSION, { message: MESSAGE });
    const fromAgents = await agents.notify(runner as never, SESSION, { message: MESSAGE });
    assert.deepEqual(asked, [
      { ownerId: 'owner-1', sessionId: SESSION, fallbackTitle: title, message: MESSAGE },
      { ownerId: 'owner-1', sessionId: SESSION, fallbackTitle: title, message: MESSAGE },
    ]);
    assert.deepEqual(fromDaemon, fromAgents);
  }
});

test('the daemon\'s alert is only for a session of its own, and never for a landing', async () => {
  const { asked, daemon } = doors();
  const runner = { id: 'runner-1', ownerId: 'owner-1', name: 'the machine', displayName: null } as never;
  await assert.rejects(daemon.sessionNotify(runner, OTHERS, { message: MESSAGE }), ForbiddenException);
  await assert.rejects(daemon.sessionNotify(runner, '019fe1dd-3f39-7610-8e5d-507e36a4eaff', { message: MESSAGE }), ForbiddenException);
  await assert.rejects(daemon.sessionNotify(runner, LANDING, { message: MESSAGE }), ConflictException);
  assert.deepEqual(asked, [], 'the push channel was asked for a session that is not the runner\'s');
});
