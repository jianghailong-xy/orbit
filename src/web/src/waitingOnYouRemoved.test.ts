import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * "Waiting on you" stays removed on every client (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16): no
 * navigation entry, page, sheet or route of its own on the web, Android, macOS or iOS. A request is drawn in the
 * session that asked; a scheduled task's item on the Scheduled page and in its run's session; a terminal asking to
 * be approved on its machine's page. The old `/waiting` address keeps redirecting. Scheduled keeps its own page,
 * entry and count.
 *
 * The status chip a card wears ("Waiting on you") is not an inbox and is not looked for here.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const CLIENTS = {
  web: ['src/web/src'],
  android: ['src/android/app/src/main', 'src/android/core/src/main'],
  apple: ['src/macos/OrbitApp/Sources', 'src/macos/OrbitKit/Sources', 'src/ios/Sources'],
} as const;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'test', '__tests__']);
const SOURCE = /\.(tsx?|swift|kt)$/;
const NOT_PRODUCT = /\.(test|spec)\.tsx?$/;

function files(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
      } else if (SOURCE.test(entry.name) && !NOT_PRODUCT.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  roots.forEach(walk);
  return out;
}

const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');

/** What an inbox of its own would be named by, per client. */
const FORBIDDEN: Record<keyof typeof CLIENTS, RegExp[]> = {
  web: [
    /\bWaitingOnYouPage\b/, // the page
    /\buseWaitingOnYouCount\b/, // the nav entry's count
    /name="waiting"/, // its icon
  ],
  android: [
    /\bWAITING_ON_YOU\b/, // the destination
    /\bWaitingOnYouScreen\b/, // the page
    /\bNeedsYouBar\b/, // the resident bar its terminal line led (main's 54a8858f7: a notice instead)
  ],
  apple: [
    /\bOwnerRequestInbox(View|Sheet|Entry)\b/, // the sheet and its entry
    /\bownerRequestInboxSheet\b/,
    /\binboxPresented\b/,
    /\bwaitingOnYouRow\b/,
    /owner-request-inbox-entry/,
  ],
};

describe('no Waiting on you navigation, page, route or sheet on any client', () => {
  for (const client of Object.keys(CLIENTS) as (keyof typeof CLIENTS)[]) {
    it(`${client}: no source names one`, () => {
      const found = files(CLIENTS[client]).flatMap((rel) => {
        const text = read(rel);
        return FORBIDDEN[client].filter((pattern) => pattern.test(text)).map((pattern) => `${rel}: ${pattern}`);
      });
      expect(found).toEqual([]);
    });
  }

  it('web: the sidebar has no waiting entry and no waiting glyph', () => {
    expect(read('src/web/src/components/TasksSidePanel.tsx')).not.toMatch(/key:\s*'waiting'/);
    expect(read('src/web/src/components/SidebarNavIcon.tsx')).not.toMatch(/\bwaiting:\s*\(/);
  });

  it('web: /waiting only redirects', () => {
    const app = read('src/web/src/App.tsx');
    const waiting = [...app.matchAll(/<Route\s+path="waiting"[^>]*element=\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(waiting).toEqual(['<OwnerRequestRedirect />']);
  });

  it('apple: the drawer has no Waiting on you row', () => {
    const drawer = read('src/macos/OrbitKit/Sources/OrbitKit/App/DrawerWorkLogic.swift');
    expect(drawer).not.toMatch(/\bcase waitingOnYou\b|\.waitingOnYou\b/);
  });
});

describe('Scheduled keeps its own page, entry and count', () => {
  it('web: its route, its sidebar entry with the Needs you count, and the cards on its page', () => {
    expect(read('src/web/src/App.tsx')).toMatch(/path="scheduled"[\s\S]{0,80}<ScheduledPage \/>/);
    const panel = read('src/web/src/components/TasksSidePanel.tsx');
    expect(panel).toContain("{ key: 'scheduled'");
    expect(panel).toContain('useScheduledNeedsCount()');
    expect(read('src/web/src/pages/ScheduledPage.tsx')).toContain('data-schedule-waiting');
  });

  it('apple: its drawer row, and the cards on its pages', () => {
    expect(read('src/macos/OrbitKit/Sources/OrbitKit/App/DrawerWorkLogic.swift')).toContain('.scheduled');
    expect(read('src/macos/OrbitApp/Sources/OrbitApp/Views/ScheduledPage.swift')).toContain('ScheduleWaitingCardView(item: item)');
    expect(read('src/macos/OrbitApp/Sources/OrbitApp/Views/ScheduledMacPage.swift')).toContain('ScheduleWaitingCardView(item: item)');
  });
});
