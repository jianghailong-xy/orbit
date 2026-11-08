/**
 * The cards the bot answers the owner's direct messages with (docs/feishu-bot-design.md §7.3): the default-workspace
 * picker, and `status`. English, as every word the bot sends (CLAUDE.md §5); a workspace's name and a session's or an
 * owner item's title are the owner's own words and go as they are.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Element = Record<string, any>;

/** A card as Feishu's card JSON 2.0 takes it. */
export interface FeishuDirectCard {
  schema: '2.0';
  config: { update_multi: true; summary: { content: string } };
  header: { title: { tag: 'plain_text'; content: string }; template: string };
  body: { direction: 'vertical'; elements: Element[] };
}

/** The callback value of a default-workspace button: what the router reads back from the click. */
export const DEFAULT_WORKSPACE_ACTION = 'default-workspace';

/** At most this many workspaces are offered, and this many entries listed by `status`. */
export const DIRECT_CARD_MAX_ENTRIES = 20;

const plain = (content: string) => ({ tag: 'plain_text' as const, content });
const text = (content: string): Element => ({ tag: 'div', text: plain(content) });
const button = (label: string, behavior: Element): Element => ({ tag: 'button', text: plain(label), type: 'default', behaviors: [behavior] });
const openInOrbit = (url: string): Element => button('Open in Orbit', { type: 'open_url', default_url: url });

function card(title: string, template: string, elements: Element[]): FeishuDirectCard {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: plain(title), template },
    body: { direction: 'vertical', elements },
  };
}

/** No default workspace yet: one button per workspace; a click makes it the default (§7.3). */
export function renderWorkspacePickerCard(workspaces: ReadonlyArray<{ id: string; name: string }>): FeishuDirectCard {
  return card('Choose a default workspace', 'blue', [
    text('New messages here start a session in your default workspace. Choose one, then send your message again.'),
    ...workspaces.slice(0, DIRECT_CARD_MAX_ENTRIES).map((w) =>
      button(w.name, { type: 'callback', value: { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: w.id } })),
  ]);
}

/** The picker once a workspace was chosen: what the default is now, and no buttons. */
export function renderWorkspaceChosenCard(name: string): FeishuDirectCard {
  return card('Default workspace set', 'green', [
    text(`New messages here start a session in ${name}. Send your message again to start one.`),
  ]);
}

/** One session waiting on the owner, with the owner items waiting in it. */
export interface StatusEntry {
  title: string;
  ownerItems: string[];
  url: string;
}

/** `status`: what waits on the owner, each with Open in Orbit (§7.3). */
export function renderStatusCard(entries: readonly StatusEntry[]): FeishuDirectCard {
  if (entries.length === 0) return card('Nothing is waiting on you', 'grey', [text('Nothing in Orbit is waiting on you right now.')]);
  const shown = entries.slice(0, DIRECT_CARD_MAX_ENTRIES);
  const elements: Element[] = [];
  for (const entry of shown) {
    elements.push(text(entry.title));
    for (const item of entry.ownerItems) elements.push(text(`• ${item}`));
    elements.push(openInOrbit(entry.url));
  }
  const more = entries.length - shown.length;
  if (more > 0) elements.push(text(`And ${more} more in Orbit.`));
  return card(`Waiting on you · ${entries.length}`, 'orange', elements);
}
