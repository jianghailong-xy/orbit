import type { ShareRootKind } from '../share-links/share-link';
import { escapeHtml } from '../email/welcome-email.template';

/** What a card says a link of each kind is (docs/mocks/wechat-share-card, plan A: the kind, no status
 *  a chat would keep long after it changed). */
const DESCRIPTION: Record<ShareRootKind, string> = {
  SESSION: 'A conversation shared from Orbit',
  TASK: 'A task shared from Orbit',
  PROJECT: 'A project shared from Orbit',
  WIKI: 'A wiki shared from Orbit',
};

/** A title is cut here; a chat shows two lines of it at most. */
const MAX_TITLE = 120;

/**
 * The head lines a public link's page carries for a chat app that reads a link's page without running
 * it (WeChat, Slack, iMessage): web/nginx.conf includes them into `/s/<token>` in place of the bare
 * `<title>Orbit</title>`. The title is the root's first line; the picture is the app icon at the
 * deployment's public origin, a PNG, since WeChat shows no SVG.
 */
export function shareCardHead(card: { kind: ShareRootKind; title: string }, origin: string): string {
  const firstLine = card.title.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const title = escapeHtml(
    !firstLine ? 'Orbit' : firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine,
  );
  const description = escapeHtml(DESCRIPTION[card.kind]);
  const image = escapeHtml(`${origin}/icon-512.png`);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Orbit" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta name="twitter:card" content="summary" />`,
    '',
  ].join('\n');
}
