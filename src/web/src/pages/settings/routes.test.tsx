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
    ['storage', '<StorageSettingsPage />'],
    ['storage/:kind/:id', '<StorageFilesPage />'],
    ['shared-links', '<SharedLinksPage />'],
    ['access-tokens', '<AccessTokensPage />'],
    ['integrations/feishu', '<FeishuIntegrationPage />'],
    ['integrations/feishu/connect-group', '<FeishuConnectGroupPage />'],
  ])('routes %s to %s inside the Settings window', (slug, element) => {
    expect(block).toContain(`<Route path="${slug}" element={${element}} />`);
  });

  it('opens General at /settings', () => {
    expect(block).toContain('<Route index element={<Navigate to="/settings/general" replace />} />');
  });

  it('keeps Access tokens after Shared links', () => {
    expect(block.indexOf('path="access-tokens"')).toBeGreaterThan(block.indexOf('path="shared-links"'));
  });

  it('has no one-page Settings left', () => {
    expect(app).not.toContain('<SettingsPage />');
  });
});
