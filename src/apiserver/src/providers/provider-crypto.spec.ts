import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decryptSecret, encryptSecret } from './provider-crypto';

test('provider-crypto', async (t) => {
  process.env.PROVIDER_SECRET_KEY = 'test-master-key';

  await t.test('round-trips a secret', () => {
    const enc = encryptSecret('sk-deepseek-123');
    assert.notEqual(enc, 'sk-deepseek-123');
    assert.equal(decryptSecret(enc), 'sk-deepseek-123');
  });

  await t.test('uses a fresh iv each call (ciphertext is non-deterministic)', () => {
    assert.notEqual(encryptSecret('x'), encryptSecret('x'));
  });

  await t.test('rejects a tampered ciphertext (GCM auth tag)', () => {
    const [iv, tag] = encryptSecret('secret').split(':');
    const forged = [iv, tag, Buffer.from('garbage').toString('base64')].join(':');
    assert.throws(() => decryptSecret(forged));
  });

  await t.test('throws a clear error when the master key is unset', () => {
    delete process.env.PROVIDER_SECRET_KEY;
    assert.throws(() => encryptSecret('x'), /PROVIDER_SECRET_KEY/);
  });
});
