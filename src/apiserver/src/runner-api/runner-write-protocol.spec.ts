import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';

import {
  negotiateRunnerWriteProtocol,
  RUNNER_WRITE_CAPABILITY_REVISION,
  RUNNER_WRITE_SCHEMA_REVISION,
} from './runner-write-protocol';
import {
  requireExplicitCompletionCriterion,
} from '../tasks/task-completion-criterion-gate';

test('the server revision is generated from the repository contract', () => {
  const contractPath = path.resolve(__dirname, '../../../../contracts/runner-write-protocol.json');
  const source = readFileSync(contractPath);
  const contract = JSON.parse(source.toString()) as {
    capabilityRevision: number;
    schemaRevision: number;
  };
  assert.equal(RUNNER_WRITE_CAPABILITY_REVISION, contract.capabilityRevision);
  assert.equal(RUNNER_WRITE_SCHEMA_REVISION, contract.schemaRevision);
});

test('headerless and explicit N-1 clients negotiate only the known compatibility lane', () => {
  assert.deepEqual(negotiateRunnerWriteProtocol({}), {
    mode: 'LEGACY_N_MINUS_ONE',
    capabilityRevision: 1,
    schemaRevision: 1,
  });
  const explicit = negotiateRunnerWriteProtocol({
    capabilityRevision: '1',
    schemaRevision: '1',
  });
  assert.equal('mode' in explicit && explicit.mode, 'LEGACY_N_MINUS_ONE');
  const tooOld = negotiateRunnerWriteProtocol({
    capabilityRevision: '0',
    schemaRevision: '0',
  });
  assert.equal('code' in tooOld && tooOld.code, 'RUNNER_PROTOCOL_REVISION_UNSUPPORTED');
});

test('the digest a client still sends beside its revisions is not read, and no revision of its own is added to it', () => {
  const current = negotiateRunnerWriteProtocol({
    capabilityRevision: String(RUNNER_WRITE_CAPABILITY_REVISION),
    schemaRevision: String(RUNNER_WRITE_SCHEMA_REVISION),
    cliVersion: '0.1.246',
    ...({ contractDigest: 'f'.repeat(64) } as object),
  });
  assert.equal('mode' in current && current.mode, 'CURRENT');
  assert.equal('contractDigest' in current, false);
  const unknown = negotiateRunnerWriteProtocol({ capabilityRevision: '3', schemaRevision: '3', cliVersion: '0.1.140' });
  assert.equal('code' in unknown && unknown.code, 'RUNNER_PROTOCOL_REVISION_UNSUPPORTED');
  assert.equal('kind' in unknown && unknown.kind, 'REFUSAL');
  assert.equal('cliVersion' in unknown && unknown.cliVersion, '0.1.140');
});

test('legacy completion shapes translate only when their intent is unambiguous', () => {
  const executable: {
    completionCriterion?: string;
    acceptanceCommand: string;
    acceptanceExpectedExitCode: number;
  } = requireExplicitCompletionCriterion({
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
  });
  assert.equal(executable.completionCriterion, 'EXECUTABLE');

  const verification: { completionCriterion?: string; completionPolicy: string } =
    requireExplicitCompletionCriterion({
    completionPolicy: 'VERIFICATION_PASSED',
    });
  assert.equal(verification.completionCriterion, 'VERIFICATION');
});

test('an omitted completion criterion can never fall back to EVIDENCE_JUDGMENT', () => {
  assert.throws(
    () => requireExplicitCompletionCriterion({}),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      const body = error.getResponse() as Record<string, unknown>;
      assert.equal(body.code, 'RUNNER_COMPLETION_CRITERION_REQUIRED');
      assert.equal(body.kind, 'REFUSAL');
      assert.equal(body.requiredAction, 'DECLARE_COMPLETION_CRITERION_EXPLICITLY');
      assert.match(String(body.message), /never.*EVIDENCE_JUDGMENT/i);
      return true;
    },
  );
});
