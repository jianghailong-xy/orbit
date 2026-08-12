import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSubscriptionUsage, probesSubscriptionUsage } from './plan-usage';

const OAT = 'sk-ant-oat01-abcdef';

test('an Anthropic-hosted claude row holding a subscription token is probed', () => {
  assert.equal(
    probesSubscriptionUsage({ runtime: 'claude', baseUrl: 'https://api.anthropic.com' }, OAT),
    true,
  );
});

test('a metered API key is never probed — it has no 5-hour or weekly window to report', () => {
  assert.equal(
    probesSubscriptionUsage({ runtime: 'claude', baseUrl: 'https://api.anthropic.com' }, 'sk-ant-api03-x'),
    false,
  );
});

test('a proxy or compatible vendor is never asked, so the key stays with Anthropic', () => {
  for (const baseUrl of [
    'https://api.deepseek.com/anthropic',
    'https://anthropic.example.com',
    'not a url',
  ]) {
    assert.equal(probesSubscriptionUsage({ runtime: 'claude', baseUrl }, OAT), false, baseUrl);
  }
});

test('OpenAI-dialect runtimes are skipped even on an Anthropic URL', () => {
  for (const runtime of ['codex', 'kimi']) {
    assert.equal(
      probesSubscriptionUsage({ runtime, baseUrl: 'https://api.anthropic.com' }, OAT),
      false,
      runtime,
    );
  }
});

test('the endpoint payload maps onto the windows the clients already render', () => {
  const usage = parseSubscriptionUsage(
    {
      five_hour: { utilization: 100, resets_at: '2026-08-12T17:40:00Z' },
      seven_day: { utilization: 78, resets_at: '2026-08-14T04:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 12.5 },
    },
    '2026-08-12T15:00:00Z',
  );
  assert.deepEqual(usage, {
    provider: 'claude',
    fiveHour: { utilization: 100, resetsAt: '2026-08-12T17:40:00Z' },
    sevenDay: { utilization: 78, resetsAt: '2026-08-14T04:00:00Z' },
    sevenDaySonnet: { utilization: 12.5 },
    fetchedAt: '2026-08-12T15:00:00Z',
  });
});

test('a window the endpoint omits is left out rather than reported as 0%', () => {
  const usage = parseSubscriptionUsage({ five_hour: { utilization: 4 } }, 'now');
  assert.equal(usage?.sevenDay, undefined);
  assert.equal(usage?.sevenDayOpus, undefined);
});

test('a payload carrying no window we understand reads as no quota, not an empty gauge', () => {
  assert.equal(parseSubscriptionUsage({ something_else: 1 }, 'now'), null);
  assert.equal(parseSubscriptionUsage(null, 'now'), null);
  assert.equal(parseSubscriptionUsage('nope', 'now'), null);
});
