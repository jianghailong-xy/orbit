import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ProjectsController } from './projects.controller';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';

// Migration 0229 removed the project acceptance judgment on the account owner's instruction. The
// REST surface that existed to DRIVE it went with it: the pending-review inbox a person worked
// from, the door that opened an evidence version, and the one that recorded a verdict.
//
// Asserted as an absence, on both doors, because a route that came back would come back silently:
// nothing else in this tree would notice a handler being added to a controller.

const REMOVED_HANDLERS = [
  'pendingAcceptance',
  'acceptanceOverview',
  'openAcceptanceRun',
  'finalizeAcceptanceRun',
  // Unit L7's reopen preview and its write: both read `acceptance_epoch`, which 0229 dropped.
  'reopenPreview',
  'reopen',
  'getProjectReopenImpact',
  'projectAcceptance',
];

test('no acceptance-judgment handler survives on either project controller', () => {
  for (const [name, controller] of [
    ['ProjectsController', ProjectsController],
    ['RunnerProjectsController', RunnerProjectsController],
  ] as const) {
    const handlers = new Set(Object.getOwnPropertyNames(controller.prototype));
    for (const gone of REMOVED_HANDLERS) {
      assert.equal(handlers.has(gone), false, `${name}.${gone} survives 0229`);
    }
  }
});

test('no route path on either project controller still addresses acceptance judgment', () => {
  for (const controller of [ProjectsController, RunnerProjectsController]) {
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === 'constructor') continue;
      const handler = (controller.prototype as never)[name];
      const routePath = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof routePath !== 'string') continue;
      assert.doesNotMatch(routePath, /acceptance\/(pending|runs)/,
        `${controller.name}.${name} still serves ${routePath}`);
      assert.doesNotMatch(routePath, /reopen/,
        `${controller.name}.${name} still serves ${routePath}`);
      assert.doesNotMatch(routePath, /verdict/,
        `${controller.name}.${name} still serves ${routePath}`);
    }
  }
});

// The one acceptance-shaped route that stays, and it is an observation rather than a verdict: what
// a target branch was seen to contain. Named explicitly so the sweep above cannot be read as
// "every acceptance route is gone".
test('recording what a branch contains survives on both doors, as a POST', () => {
  for (const controller of [ProjectsController, RunnerProjectsController]) {
    const handler = (controller.prototype as never)['recordMergeEvidence'];
    assert.ok(handler, `${controller.name} lost recordMergeEvidence`);
    assert.match(String(Reflect.getMetadata(PATH_METADATA, handler)), /acceptance\/merge-evidence$/);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
  }
});
