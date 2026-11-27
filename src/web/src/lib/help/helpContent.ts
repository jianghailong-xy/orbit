import type { HelpArticleMeta, HelpPlatform } from '@orbit/shared';

/**
 * Reading a help article's Markdown on a client (docs/mocks/help-center board 03, "how an article is written"):
 * which platform-only passages it keeps, where its in-app `orbit:/…` links go for the reader, and the
 * headings its "On this page" lists. Pure, so the /help pages and the help drawer read an article one way.
 */

const FENCE = /^\s*(```|~~~)/;
const PLATFORM_OPEN = /^\s*:::\s*platform\s+(.+?)\s*$/;
const BLOCK_CLOSE = /^\s*:::\s*$/;

/**
 * The body with each `::: platform ios` … `:::` passage kept only when it names `platform`. A passage may name
 * several (`::: platform ios android`); fences are left alone, so a `:::` inside a code block is code.
 */
export function forPlatform(body: string, platform: HelpPlatform): string {
  const out: string[] = [];
  let inFence = false;
  let dropping: boolean | null = null; // null: outside a platform passage
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence) {
      const open = PLATFORM_OPEN.exec(line);
      if (open && dropping === null) {
        dropping = !open[1].toLowerCase().split(/[\s,]+/).includes(platform);
        continue;
      }
      if (dropping !== null && BLOCK_CLOSE.test(line)) {
        dropping = null;
        continue;
      }
    }
    if (!dropping) out.push(line);
  }
  return out.join('\n');
}

/** What the account has, for resolving an `orbit:/` link: null signed out. */
export interface HelpLinkAccount {
  admin: boolean;
  /** The account's machines, in its own order; `offline` true for one not checking in. */
  machines: ReadonlyArray<{ id: string; offline: boolean }>;
  /** The account's workspaces, most recently used first. */
  workspaces: ReadonlyArray<{ id: string }>;
}

export const ORBIT_LINK_PREFIX = 'orbit:/';

/** An `orbit:/help/<category>/<slug>` link: another article, readable signed out. */
export function helpArticleLink(href: string | undefined): string | null {
  if (!href?.startsWith(`${ORBIT_LINK_PREFIX}help/`)) return null;
  return href.slice(ORBIT_LINK_PREFIX.length - 1);
}

/**
 * Where an in-app `orbit:/…` link goes for this reader, or null when its target does not exist for them —
 * signed out, an administrator's page for a member, or a placeholder (`:id`, `:machine`) the account has
 * nothing to put in. A machine placeholder takes the first offline machine (the articles that link one are
 * about a machine in trouble), else the first; a workspace placeholder takes the most recently used.
 */
export function resolveOrbitLink(href: string, account: HelpLinkAccount | null): string | null {
  if (!href.startsWith(ORBIT_LINK_PREFIX)) return null;
  const article = helpArticleLink(href);
  if (article) return article;
  if (!account) return null;
  const [pathPart, hash = ''] = href.slice(ORBIT_LINK_PREFIX.length - 1).split('#', 2);
  const segments = pathPart.split('/');
  if (segments[1] === 'admin' && !account.admin) return null;
  const machine = account.machines.find((m) => m.offline) ?? account.machines[0];
  const workspace = account.workspaces[0];
  const resolved: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment.startsWith(':')) {
      resolved.push(segment);
      continue;
    }
    const owner = segments[i - 1];
    const id = owner === 'machines' || owner === 'runners' ? machine?.id : owner === 'workspaces' ? workspace?.id : undefined;
    if (!id) return null;
    resolved.push(id);
  }
  return resolved.join('/') + (hash ? `#${hash}` : '');
}

/** A heading's anchor: its words, lowercased, joined by hyphens. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** A Markdown heading line's text as it reads: emphasis, code marks and link targets taken off. */
function plainHeading(source: string): string {
  return source
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

/** The `##` headings of a body, for "On this page", with the anchors the rendered headings carry. */
export function tableOfContents(body: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = plainHeading(m[1]);
      out.push({ id: headingId(text), text });
    }
  }
  return out;
}

/** Minutes to read, at 200 words a minute, never less than one. Chinese is written without spaces, so two of its
 *  characters count as a word. */
export function readMinutes(body: string): number {
  const han = body.match(/[㐀-䶿一-鿿]/g)?.length ?? 0;
  const words = body.replace(/[㐀-䶿一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil((words + han / 2) / 200));
}

const PLATFORM_LABEL: Record<HelpPlatform, string> = { web: 'Web', macos: 'macOS', ios: 'iPhone', android: 'Android' };

/** "4 min read · Updated Nov 10, 2026 · Web, macOS, iPhone, Android". */
export function articleMeta(article: Pick<HelpArticleMeta, 'updated' | 'platforms'> & { body: string }): string {
  const [y, m, d] = article.updated.split('-').map(Number);
  const updated = y && m && d
    ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : article.updated;
  const platforms = article.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', ');
  return [`${readMinutes(article.body)} min read`, `Updated ${updated}`, platforms].filter(Boolean).join(' · ');
}
