import { describe, expect, it } from 'vitest';
import app from '../../App.tsx?raw';

/**
 * Each Personal row of the Settings nav opens a page of its own inside the Settings window
 * (docs/mocks/settings-redesign, board-2). The ways into Shared links, Access tokens and Feishu used to be
 * cards with a Manage button on the one Settings page; the nav rows replace them, and SettingsLayout.test
 * checks each row opens its address.
 */
const settings = app.slice(app.indexOf('<Route path="settings" element={<SettingsLayout />}>'));
const block = settings.slice(0, settings.indexOf('</Route>'));

describe('the Personal pages, each at /settings/<slug>', () => {
  it.each([
    ['general', '<GeneralSettingsPage />'],
    ['notifications', '<NotificationsSettingsPage />'],
    ['appearance', '<AppearanceSettingsPage />'],
    ['profile', '<ProfilePage />'],
    ['shared-links', '<SharedLinksPage />'],
    ['access-tokens', '<AccessTokensPage />'],
    ['secrets', '<SecretsPage />'],
    ['providers/routing', '<ModelRoutingPage />'],
    // Old addresses of what Model routing holds, their query kept.
    ['routing-report', '<KeepQueryRedirect to="/settings/providers/routing" />'],
    ['providers/tiers', '<KeepQueryRedirect to="/settings/providers/routing" />'],
    ['integrations/feishu', '<FeishuIntegrationPage />'],
    ['integrations/feishu/connect-group', '<FeishuConnectGroupPage />'],
    ['integrations/github', '<GithubIntegrationPage />'],
  ])('routes %s to %s inside the Settings window', (slug, element) => {
    expect(block).toContain(`<Route path="${slug}" element={${element}} />`);
  });

  it('opens General at /settings', () => {
    expect(block).toContain('<Route index element={<Navigate to="/settings/general" replace />} />');
  });

  it('keeps Access tokens after Shared links', () => {
    expect(block.indexOf('path="access-tokens"')).toBeGreaterThan(block.indexOf('path="shared-links"'));
  });

  it('keeps Secrets right after Access tokens', () => {
    expect(block.indexOf('path="secrets"')).toBeGreaterThan(block.indexOf('path="access-tokens"'));
    expect(block.indexOf('path="secrets"')).toBeLessThan(block.indexOf('path="terminals"'));
  });

  it('has no one-page Settings left', () => {
    expect(app).not.toContain('<SettingsPage />');
  });
});
