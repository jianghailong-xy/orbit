import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  countLinkHeartbeatFull,
  countLinkHeartbeatQuiet,
  countLinkHeartbeatReport,
  renderLinkHeartbeatMetrics,
  resetLinkHeartbeatMetrics,
} from './link-heartbeat-metrics';

beforeEach(resetLinkHeartbeatMetrics);

test('every outcome and full reason is exposed at zero before any beat', () => {
  const text = renderLinkHeartbeatMetrics();
  assert.ok(text.includes('orbit_link_heartbeat_outcomes_total{outcome="quiet"} 0'));
  assert.ok(text.includes('orbit_link_heartbeat_full_reconciles_total{reason="period"} 0'));
});

test('counts quiet, report by kind, and full by reason', () => {
  countLinkHeartbeatQuiet();
  countLinkHeartbeatQuiet();
  countLinkHeartbeatReport(['repos', 'planUsage']);
  countLinkHeartbeatFull('CHANGED');
  countLinkHeartbeatFull('PERIOD');
  countLinkHeartbeatFull('MANAGED');
  const text = renderLinkHeartbeatMetrics();
  for (const line of [
    'orbit_link_heartbeat_outcomes_total{outcome="quiet"} 2',
    'orbit_link_heartbeat_outcomes_total{outcome="report"} 1',
    'orbit_link_heartbeat_outcomes_total{outcome="full"} 3',
    'orbit_link_heartbeat_reports_total{kind="repos"} 1',
    'orbit_link_heartbeat_reports_total{kind="planUsage"} 1',
    'orbit_link_heartbeat_full_reconciles_total{reason="changed"} 1',
    'orbit_link_heartbeat_full_reconciles_total{reason="managed"} 1',
  ]) assert.ok(text.includes(line), line);
});
