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
  DOCUMENTS_ENABLED_ENV,
  documentsClaimFields,
  documentsEnabled,
  DocumentsEnabledGuard,
  readDocumentsSwitch,
} from './documents-switch';
import { DocumentsController, DocumentsDownloadController } from './documents.controller';
import { RunnerDocumentsController } from './runner-documents.controller';

/** Runs `fn` with the switch set to `value` (undefined: absent), and puts the environment back. */
function withSwitch<T>(value: string | undefined, fn: () => T): T {
  const before = process.env[DOCUMENTS_ENABLED_ENV];
  if (value === undefined) delete process.env[DOCUMENTS_ENABLED_ENV];
  else process.env[DOCUMENTS_ENABLED_ENV] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[DOCUMENTS_ENABLED_ENV];
    else process.env[DOCUMENTS_ENABLED_ENV] = before;
  }
}

test('Drive is off unless the switch says true', () => {
  assert.deepEqual(readDocumentsSwitch(undefined), { enabled: false, problem: null });
  assert.deepEqual(readDocumentsSwitch(''), { enabled: false, problem: null });
  assert.deepEqual(readDocumentsSwitch('false'), { enabled: false, problem: null });
  assert.deepEqual(readDocumentsSwitch(' TRUE '), { enabled: true, problem: null });
  for (const value of ['1', 'yes', 'on']) {
    const read = readDocumentsSwitch(value);
    assert.equal(read.enabled, false, value);
    assert.match(read.problem ?? '', /neither true nor false/);
  }
});

test('off, every drive door refuses with the 404 DOCUMENTS_DISABLED; on, it lets the request through', () => {
  const guard = new DocumentsEnabledGuard();
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
  assert.deepEqual(guards(DocumentsController), [JwtAuthGuard, DocumentsEnabledGuard]);
  assert.deepEqual(guards(DocumentsDownloadController), [DocumentsEnabledGuard]);
  assert.deepEqual(guards(RunnerDocumentsController), [RunnerAuthGuard, DocumentsEnabledGuard]);
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
