import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { sanitizeRunnerEngines, isInstallEngine, isLoginEngine } from '../common/runner-engines';
import { StartInstallDto } from '../runners/dto';

test('P2 dsh health preserves independent availability and request authentication states', () => {
  for (const requestValidation of ['unknown', 'valid', 'invalid']) {
    const report = sanitizeRunnerEngines([{
      engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'yes',
      dsh: { versionCompatible: true, credentialPresent: true, modelCatalogReadable: true, requestValidation, sandboxEnforcement: 'unknown' },
    }])![0];
    assert.equal(report.auth, 'unknown', 'catalogue/ACP authentication cannot become local login');
    assert.equal(report.installed, true);
    assert.deepEqual(report.dsh, { versionCompatible: true, credentialPresent: true, modelCatalogReadable: true, requestValidation, sandboxEnforcement: 'unknown' });
  }
  assert.equal(sanitizeRunnerEngines([{ engine: 'claude', installed: true, auth: 'yes' }])![0].auth, 'yes');
});

test('P2 dsh health API drops secrets upstream messages and malformed states', () => {
  const report = sanitizeRunnerEngines([{
    engine: 'dsh', installed: true, auth: 'yes', apiKey: 'opaque-secret-one', version: 'opaque-secret-version',
    installationError: 'DSH_VERSION_INCOMPATIBLE: opaque-secret-two',
    dsh: { credentialPresent: 'true', modelCatalogReadable: true, requestValidation: 'authenticate succeeded', sandboxEnforcement: 'danger-full-access', diagnostic: 'raw opaque-secret-three', apiKey: 'opaque-secret-four', env: { ORBIT_DSH_API_KEY: 'opaque-secret-five' } },
  }])![0];
  assert.equal(report.installationError, 'DSH_VERSION_INCOMPATIBLE');
  assert.equal(report.auth, 'unknown');
  assert.equal(report.version, undefined);
  assert.deepEqual(report.dsh, { versionCompatible: false, credentialPresent: false, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'unknown' });
  assert.ok(!JSON.stringify(report).includes('opaque-secret'));
  assert.equal(sanitizeRunnerEngines([{ engine: 'dsh', installed: false, auth: 'no', dsh: { diagnostic: 'DSH_CREDENTIAL_INVALID: opaque-secret' } }])![0].dsh?.diagnostic, 'DSH_CREDENTIAL_INVALID');
});

test('P2 dsh browser install is authorized separately from unsupported account login', async () => {
  assert.equal(isInstallEngine('dsh'), true);
  assert.equal(isLoginEngine('dsh'), false);
  assert.deepEqual(await validate(Object.assign(new StartInstallDto(), { engine: 'dsh' })), []);
  assert.ok((await validate(Object.assign(new StartInstallDto(), { engine: 'unknown' }))).length > 0);
});
