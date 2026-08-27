import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ProjectsController } from './projects.controller';

const OWNER = '00000000-0000-7000-8000-000000000001';

test('the owner REST surface exposes a bounded project-acceptance inbox and verdict write', () => {
  const proto = ProjectsController.prototype;
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.pendingAcceptance), 'acceptance/pending');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.pendingAcceptance), RequestMethod.GET);
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, proto.finalizeAcceptanceRun),
    ':id/acceptance/runs/:runId/verdict',
  );
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, proto.finalizeAcceptanceRun),
    RequestMethod.POST,
  );
});

test('the pending inbox derives owner from auth and validates the numeric limit in the service', async () => {
  const calls: unknown[][] = [];
  const acceptance = {
    pendingInbox: async (...args: unknown[]) => {
      calls.push(args);
      return { total: 0, items: [] };
    },
  };
  const controller = new ProjectsController(
    {} as never,
    acceptance as never,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.deepEqual(
    await controller.pendingAcceptance({ userId: OWNER } as never, '25'),
    { total: 0, items: [] },
  );
  assert.deepEqual(calls, [[OWNER, 25]]);
});
