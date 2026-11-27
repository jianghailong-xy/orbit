import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isInternalHost } from './held-key';

test('internal hosts are refused, IPv6 loopback included', () => {
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.0.2', '169.254.169.254', '0.0.0.0', '[::1]']) {
    assert.equal(isInternalHost(new URL(`http://${host}/v1`).hostname), true, host);
  }
  for (const host of ['api.deepseek.com', '172.32.0.1', '8.8.8.8']) {
    assert.equal(isInternalHost(new URL(`https://${host}/v1`).hostname), false, host);
  }
});
