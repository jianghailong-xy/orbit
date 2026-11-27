import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { AuthController } from '../auth/auth.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import {
  DOCUMENTS_DISABLED,
  DRIVE_ENABLED_ENV,
  documentsClaimFields,
  documentsEnabled,
  driveEnabledEnvName,
  DriveEnabledGuard,
  readDriveSwitch,
} from './drive-switch';
import { DriveController, DriveDownloadController } from './drive.controller';
import { RunnerDriveController } from './runner-drive.controller';

/** Runs `fn` with the switch set to `value` (undefined: absent), and puts the environment back. */
function withSwitch<T>(value: string | undefined, fn: () => T): T {
  const before = process.env[DRIVE_ENABLED_ENV];
  if (value === undefined) delete process.env[DRIVE_ENABLED_ENV];
  else process.env[DRIVE_ENABLED_ENV] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[DRIVE_ENABLED_ENV];
    else process.env[DRIVE_ENABLED_ENV] = before;
  }
}

test('Drive is off unless the switch says true', () => {
  assert.deepEqual(readDriveSwitch(undefined), { enabled: false, problem: null });
  assert.deepEqual(readDriveSwitch(''), { enabled: false, problem: null });
  assert.deepEqual(readDriveSwitch('false'), { enabled: false, problem: null });
  assert.deepEqual(readDriveSwitch(' TRUE '), { enabled: true, problem: null });
  for (const value of ['1', 'yes', 'on']) {
    const read = readDriveSwitch(value);
    assert.equal(read.enabled, false, value);
    assert.match(read.problem ?? '', /neither true nor false/);
  }
});

test('off, every drive door refuses with the 404 DOCUMENTS_DISABLED; on, it lets the request through', () => {
  const guard = new DriveEnabledGuard();
  withSwitch(undefined, () => {
    assert.throws(() => guard.canActivate(), (err: unknown) => {
      assert.ok(err instanceof NotFoundException);
      assert.equal((err.getResponse() as { code: string }).code, DOCUMENTS_DISABLED);
      return true;
    });
  });
  withSwitch('true', () => assert.equal(guard.canActivate(), true));
});

test('the guard is on each drive controller, after the credential guard', () => {
  const guards = (controller: object) => Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[];
  assert.deepEqual(guards(DriveController), [JwtAuthGuard, DriveEnabledGuard]);
  assert.deepEqual(guards(DriveDownloadController), [DriveEnabledGuard]);
  assert.deepEqual(guards(RunnerDriveController), [RunnerAuthGuard, DriveEnabledGuard]);
});

test('a claim says documentsDisabled only while Drive is off', () => {
  assert.deepEqual(withSwitch(undefined, () => documentsClaimFields()), { documentsDisabled: true });
  assert.deepEqual(withSwitch('true', () => documentsClaimFields()), {});
});

test('the capability route says what the switch says', () => {
  const route = () => new AuthController({} as never, {} as never, { enabled: false, problem: null }).capabilities().documents;
  assert.deepEqual(withSwitch(undefined, route), { enabled: false });
  assert.deepEqual(withSwitch('true', route), { enabled: true });
  assert.equal(withSwitch('true', () => documentsEnabled()), true);
});

test('ORBIT_DOCUMENTS_ENABLED and then ORBIT_FILES_ENABLED are read while ORBIT_DRIVE_ENABLED is unset', () => {
  assert.equal(documentsEnabled({}), false);
  assert.equal(documentsEnabled({ ORBIT_FILES_ENABLED: 'true' }), true);
  assert.equal(documentsEnabled({ ORBIT_DOCUMENTS_ENABLED: 'true' }), true);
  assert.equal(documentsEnabled({ ORBIT_DRIVE_ENABLED: '', ORBIT_DOCUMENTS_ENABLED: 'true' }), true);
  assert.equal(documentsEnabled({ ORBIT_DOCUMENTS_ENABLED: 'false', ORBIT_FILES_ENABLED: 'true' }), false);
  assert.equal(documentsEnabled({ ORBIT_DRIVE_ENABLED: 'false', ORBIT_DOCUMENTS_ENABLED: 'true' }), false);
  assert.equal(driveEnabledEnvName({ ORBIT_FILES_ENABLED: 'true' }), 'ORBIT_FILES_ENABLED');
  assert.equal(driveEnabledEnvName({}), 'ORBIT_DRIVE_ENABLED');
});
