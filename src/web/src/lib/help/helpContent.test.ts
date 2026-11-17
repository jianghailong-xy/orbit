import { describe, expect, it } from 'vitest';
import { articleMeta, forPlatform, headingId, resolveOrbitLink, tableOfContents, type HelpLinkAccount } from './helpContent';

const account: HelpLinkAccount = {
  admin: false,
  machines: [
    { id: 'm-online', offline: false },
    { id: 'm-offline', offline: true },
  ],
  workspaces: [{ id: 'w-recent' }, { id: 'w-old' }],
};
const bare: HelpLinkAccount = { admin: false, machines: [], workspaces: [] };

describe('resolveOrbitLink: an orbit:/ link for the reader', () => {
  it('keeps a page with no placeholder as it is', () => {
    expect(resolveOrbitLink('orbit:/settings/providers/new', account)).toBe('/settings/providers/new');
    expect(resolveOrbitLink('orbit:/waiting', account)).toBe('/waiting');
  });

  it("puts the account's machine in a machine placeholder, the offline one first", () => {
    expect(resolveOrbitLink('orbit:/settings/machines/:id', account)).toBe('/settings/machines/m-offline');
    expect(resolveOrbitLink('orbit:/settings/machines/:machine', account)).toBe('/settings/machines/m-offline');
    const allOnline = { ...account, machines: [{ id: 'a', offline: false }, { id: 'b', offline: false }] };
    expect(resolveOrbitLink('orbit:/settings/machines/:id', allOnline)).toBe('/settings/machines/a');
  });

  it('puts the most recently used workspace in a workspace placeholder', () => {
    expect(resolveOrbitLink('orbit:/settings/workspaces/:id', account)).toBe('/settings/workspaces/w-recent');
  });

  it('answers null when the target does not exist for this account', () => {
    expect(resolveOrbitLink('orbit:/settings/machines/:id', bare)).toBeNull();
    expect(resolveOrbitLink('orbit:/settings/workspaces/:id', bare)).toBeNull();
    // A placeholder nothing fills.
    expect(resolveOrbitLink('orbit:/projects/:id', account)).toBeNull();
    // An administrator's page, for a member.
    expect(resolveOrbitLink('orbit:/admin/sign-in', account)).toBeNull();
    expect(resolveOrbitLink('orbit:/admin/sign-in', { ...account, admin: true })).toBe('/admin/sign-in');
  });

  it('answers null for every app page signed out, but still links another article', () => {
    expect(resolveOrbitLink('orbit:/settings/providers/new', null)).toBeNull();
    expect(resolveOrbitLink('orbit:/help/wiki/review-proposals', null)).toBe('/help/wiki/review-proposals');
  });

  it('is not fooled by other schemes', () => {
    expect(resolveOrbitLink('https://example.com/settings', account)).toBeNull();
  });
});

describe('forPlatform: platform-only passages', () => {
  const body = [
    'Everyone reads this.',
    '',
    '::: platform ios',
    'Only on iPhone.',
    ':::',
    '',
    '::: platform web macos',
    'On the web and the Mac.',
    ':::',
    '',
    '```text',
    '::: platform ios',
    'inside a code block',
    '```',
    'The end.',
  ].join('\n');

  it('hides an ios passage on the web and keeps one that names the web', () => {
    const web = forPlatform(body, 'web');
    expect(web).not.toContain('Only on iPhone.');
    expect(web).toContain('On the web and the Mac.');
    expect(web).not.toMatch(/^:::\s*platform web/m);
    expect(web).toContain('Everyone reads this.');
    expect(web).toContain('The end.');
    // A fence is code, whatever it says.
    expect(web).toContain('inside a code block');
  });

  it('keeps the ios passage on iPhone', () => {
    expect(forPlatform(body, 'ios')).toContain('Only on iPhone.');
    expect(forPlatform(body, 'ios')).not.toContain('On the web and the Mac.');
  });
});

describe('On this page and the meta line', () => {
  it("lists the body's ## headings with the anchors the page gives them", () => {
    const toc = tableOfContents('Intro\n\n## 1. Is the computer **awake**?\n\ntext\n\n```\n## not a heading\n```\n\n## Updating is not `offline`\n### deeper');
    expect(toc).toEqual([
      { id: '1-is-the-computer-awake', text: '1. Is the computer awake?' },
      { id: 'updating-is-not-offline', text: 'Updating is not offline' },
    ]);
    expect(headingId('Where you see it')).toBe('where-you-see-it');
  });

  it('reads time, date and platforms', () => {
    expect(articleMeta({ body: 'word '.repeat(450), updated: '2026-11-10', platforms: ['web', 'macos', 'ios', 'android'] })).toBe(
      '3 min read · Updated Nov 10, 2026 · Web, macOS, iPhone, Android',
    );
  });
});
