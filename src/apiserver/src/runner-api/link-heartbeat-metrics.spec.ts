import {
  countLinkHeartbeatFull,
  countLinkHeartbeatQuiet,
  countLinkHeartbeatReport,
  renderLinkHeartbeatMetrics,
  resetLinkHeartbeatMetrics,
} from './link-heartbeat-metrics';

describe('link heartbeat metrics', () => {
  beforeEach(resetLinkHeartbeatMetrics);

  it('exposes every outcome and full reason at zero before any beat', () => {
    const text = renderLinkHeartbeatMetrics();
    expect(text).toContain('orbit_link_heartbeat_outcomes_total{outcome="quiet"} 0');
    expect(text).toContain('orbit_link_heartbeat_full_reconciles_total{reason="period"} 0');
  });

  it('counts quiet, report (by kind) and full (by reason)', () => {
    countLinkHeartbeatQuiet();
    countLinkHeartbeatQuiet();
    countLinkHeartbeatReport(['repos', 'planUsage']);
    countLinkHeartbeatFull('CHANGED');
    countLinkHeartbeatFull('PERIOD');
    countLinkHeartbeatFull('MANAGED');
    const text = renderLinkHeartbeatMetrics();
    expect(text).toContain('orbit_link_heartbeat_outcomes_total{outcome="quiet"} 2');
    expect(text).toContain('orbit_link_heartbeat_outcomes_total{outcome="report"} 1');
    expect(text).toContain('orbit_link_heartbeat_outcomes_total{outcome="full"} 3');
    expect(text).toContain('orbit_link_heartbeat_reports_total{kind="repos"} 1');
    expect(text).toContain('orbit_link_heartbeat_reports_total{kind="planUsage"} 1');
    expect(text).toContain('orbit_link_heartbeat_full_reconciles_total{reason="changed"} 1');
    expect(text).toContain('orbit_link_heartbeat_full_reconciles_total{reason="managed"} 1');
  });
});
