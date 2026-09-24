import { toUuid } from '@orbit/shared';
import { encodeId } from './idCodec';

/**
 * Which links in a conversation point at an object in THIS deployment, and at which object — the
 * web half of a rule the three clients share.
 *
 * Two sources, one answer. A person pastes a page URL of the deployment they are talking to
 * (`/sessions/<id>`, `/tasks/<id>`, `/projects/<id>`, `/lists/<key>`), and an agent writes a
 * reference — `[名字](orbit-task:<id>)` — which is what delivery's own instructions ask it to write.
 * Both are read here and both come out as an `OrbitLinkRef`: a kind, an id canonicalised to the one
 * spelling the rest of this client compares with, and the text the card replaces.
 *
 * This is a port of OrbitKit's `OrbitLink.swift`/`OrbitLinkPlacement.swift`, not a second rule:
 * `src/shared/src/orbit-link.fixture.json` is one set of cases both ends are proved against
 * (`lib/orbitLink.test.ts` walks it in full), so the two cannot drift into two sets of rules.
 *
 * Only page URLs are read from prose, and this is the whole of the page table the deployment
 * serves. `/api/…`, `/dl/…`, `/install`, `/s/…` and every other path are deliberately not here: a
 * person who pastes `/api/runner/tasks/<id>` is usually quoting an error log, and a card would
 * replace the evidence with a summary of it.
 */

export type OrbitLinkKind = 'task' | 'session' | 'project' | 'list';

/** The four kinds, in the order `@orbit/shared`'s `LINK_PREVIEW_KINDS` lists them. */
export const ORBIT_LINK_KINDS: readonly OrbitLinkKind[] = ['project', 'task', 'session', 'list'];

/** Which object a link names. */
export interface OrbitLinkTarget {
  kind: OrbitLinkKind;
  /**
   * The canonical spelling: a lowercase UUID, whichever of the two spellings the link used.
   *
   * Compared, cached and stored under this and never under what was written: the two spellings of
   * one id are one object, and comparing spellings instead of ids is the silent miss this whole
   * rule exists to prevent.
   */
  id: string;
}

/**
 * Where the link was written, kept verbatim so a card can show what it replaced — the mono hint
 * under a loading or unavailable card is drawn from it, and it is the text a copy would hand back.
 */
export type OrbitLinkSource =
  | { kind: 'url'; url: string }
  | { kind: 'ref'; ref: string };

/** A link that became a card: the object, and the text it replaced. */
export interface OrbitLinkRef {
  target: OrbitLinkTarget;
  source: OrbitLinkSource;
}

/** The page path each kind lives under. */
export const ORBIT_LINK_PATH: Record<OrbitLinkKind, string> = {
  task: 'tasks',
  session: 'sessions',
  project: 'projects',
  list: 'lists',
};

/** The key a preview is cached and compared under — `kind:uuid`. */
export function linkKey(target: OrbitLinkTarget): string {
  return `${target.kind}:${target.id}`;
}

/** Any spelling of an id -> the canonical lowercase UUID, or null when it is neither spelling. */
export function canonicalId(raw: string): string | null {
  try {
    return toUuid(raw);
  } catch {
    return null;
  }
}

/** The id as the link spelled it — the mono hint under a card, before canonicalisation. */
export function writtenId(ref: OrbitLinkRef): string {
  if (ref.source.kind === 'url') {
    const withoutQuery = ref.source.url.split(/[?#]/)[0];
    const segments = withoutQuery.split('/');
    return segments[segments.length - 1] ?? '';
  }
  const colon = ref.source.ref.indexOf(':');
  return colon === -1 ? '' : ref.source.ref.slice(colon + 1);
}

/** The public (base62) id a route carries. */
export function publicId(target: OrbitLinkTarget): string {
  return encodeId(target.id);
}

/** The app's own page for an object — where a card's title and its click go. */
export function pageHref(target: OrbitLinkTarget): string {
  return `/${ORBIT_LINK_PATH[target.kind]}/${encodeURIComponent(publicId(target))}`;
}

/**
 * `orbitd.io/tasks/34Mx0dQe8RkV2uLbNw7Ta` — the host without its scheme, the path this deployment
 * serves for the kind, and the id as the link wrote it. The hint under a card that has nothing else
 * to show.
 */
export function pathLabel(ref: OrbitLinkRef, host: string): string {
  let label = host.trim();
  const scheme = label.indexOf('://');
  if (scheme !== -1) label = label.slice(scheme + 3);
  label = label.split(/[/?#]/)[0];
  const written = writtenId(ref);
  return `${label}/${ORBIT_LINK_PATH[ref.target.kind]}/${written || publicId(ref.target)}`;
}

// MARK: - reading a link

/**
 * The one host a link has to name for a card: the server the reader is signed in to
 * (`window.location.host`). Accepts either an authority (`orbitd.io`, `localhost:3000`) or a whole
 * URL, since the caller holds one or the other depending on where it read it.
 */
export function hostOf(raw: string): string {
  const text = raw.trim();
  const parsed = parseAbsolute(text);
  if (parsed) return parsed.host;
  return text.split(/[/?#]/)[0].toLowerCase();
}

/** `scheme://host:port/path` as the browser reads it, or null for anything that is not a URL. */
function parseAbsolute(url: string): { host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // The two schemes this deployment serves, and no other: a link's scheme is part of which server
  // it is, and an explicitly spelled default port is no port at all (`URL` drops it the same way).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { host: parsed.host, path: parsed.pathname };
}

/**
 * The page a link names, or null for anything this deployment's cards do not cover.
 *
 * The query and the fragment are ignored entirely, which is what makes `/tasks/<id>?list=<key>` a
 * task card: what a path with parameters names is still the object in its path.
 */
export function targetForPageURL(url: string, host: string): OrbitLinkTarget | null {
  const parsed = parseAbsolute(url);
  if (!parsed) return null;
  // A port is part of which server this is, and the two are compared as written: a link that spells
  // a port out where the reader's own server spells none is another server.
  if (parsed.host !== hostOf(host)) return null;
  return targetForPath(parsed.path);
}

/** The path table. Everything else — `/api/…`, `/dl/…`, `/install`, `/s/…`, the deployment's own
 *  pages — is not a link to an object. */
function targetForPath(path: string): OrbitLinkTarget | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const target = (kind: OrbitLinkKind, raw: string | undefined): OrbitLinkTarget | null => {
    if (raw === undefined) return null;
    const id = canonicalId(raw);
    return id === null ? null : { kind, id };
  };
  if (segments.length === 2) {
    switch (segments[0]) {
      case 'tasks':
        return target('task', segments[1]);
      case 'sessions':
        return target('session', segments[1]);
      case 'projects':
        return target('project', segments[1]);
      // `none` is the app's own scope for "no list", not a list a card could draw.
      case 'lists':
        return segments[1] === 'none' ? null : target('list', segments[1]);
      default:
        return null;
    }
  }
  // The pre-1.0 spellings, still in links people have pasted: both name a session.
  if (
    segments.length === 4 &&
    segments[2] === 'sessions' &&
    (segments[0] === 'workspaces' || segments[0] === 'agents')
  ) {
    return target('session', segments[3]);
  }
  return null;
}

/** The reference form an agent writes: `orbit-(task|session|project|list):<id>`. */
export function targetForReference(reference: string): OrbitLinkTarget | null {
  if (!reference.startsWith('orbit-')) return null;
  const colon = reference.indexOf(':');
  if (colon === -1) return null;
  const kind = reference.slice('orbit-'.length, colon);
  if (!(ORBIT_LINK_KINDS as readonly string[]).includes(kind)) return null;
  const id = canonicalId(reference.slice(colon + 1));
  return id === null ? null : { kind: kind as OrbitLinkKind, id };
}

// MARK: - finding page URLs in prose

/** One bare page URL of this deployment, and the text it occupies. */
export interface OrbitLinkMatch {
  /** The whole span the card replaces — including the angle brackets of `<https://…>`, which is the
   *  form a person gets when they paste a link into a markdown field. */
  start: number;
  end: number;
  /** The URL itself, without those brackets. */
  url: string;
  target: OrbitLinkTarget;
}

/**
 * Every bare page URL of this deployment in `text`, left to right.
 *
 * A URL only counts as bare when it stands as its own token: whitespace, the start of the text or an
 * opening bracket before it. That is what keeps `**https://…**`, `看看https://…` and
 * `[名字](https://…)` untouched — markup and prose glued around a link, not a pasted URL — and it is
 * the conservative direction: a URL this misses stays the link it is today, while one it wrongly
 * took would cut a sentence in half.
 */
export function scanPageURLs(text: string, host: string): OrbitLinkMatch[] {
  const matches: OrbitLinkMatch[] = [];
  // A URL that is a markdown link's destination is that link's, not a pasted URL: it already has a
  // label in front of it, and a card would eat the label's link and leave `[名字](` and `)` as prose.
  const destinations = linkDestinations(text);
  const scheme = /https?:\/\//gi;
  let found: RegExpExecArray | null;
  while ((found = scheme.exec(text)) !== null) {
    const start = found.index;
    if (destinations.some(([from, to]) => start >= from && start < to)) continue;
    // `<https://…>` — the angle brackets are markdown's autolink, and belong to the span the card
    // replaces rather than to the text either side of it.
    const bracketed = start > 0 && text[start - 1] === '<';
    const consumedStart = bracketed ? start - 1 : start;
    if (!isOpeningBoundary(consumedStart > 0 ? text[consumedStart - 1] : null)) continue;

    let end = start;
    while (end < text.length && !isURLTerminator(text[end])) end += 1;
    end = trimTrailingPunctuation(text, start, end);
    if (end <= start) continue;
    const consumedEnd = bracketed && text[end] === '>' ? end + 1 : end;

    const url = text.slice(start, end);
    const target = targetForPageURL(url, host);
    if (!target) continue;
    matches.push({ start: consumedStart, end: consumedEnd, url, target });
  }
  return matches;
}

/** The spans of every markdown link destination in the text: what is between the `(` of `](` and
 *  the `)` that closes it, balanced parens included (a URL may carry its own). */
function linkDestinations(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let search = 0;
  for (;;) {
    const marker = text.indexOf('](', search);
    if (marker === -1) return spans;
    let depth = 1;
    let end = marker + 2;
    while (end < text.length) {
      const ch = text[end];
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      end += 1;
    }
    spans.push([marker + 2, end]);
    search = end < text.length ? end + 1 : text.length;
  }
}

/**
 * The punctuation a URL can never end with, because it is the sentence's rather than the link's.
 *
 * An opening bracket character is handed back to the text only when it is unmatched inside the URL
 * — `…(x)` keeps its closer, and a `)` the author typed after a link does not become part of it.
 */
function trimTrailingPunctuation(text: string, start: number, end: number): number {
  const always = '.,;:!?。，、；：！？';
  const closers: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
    '）': '（',
    '」': '「',
    '』': '『',
    '】': '【',
    '〕': '〔',
    '》': '《',
  };
  let trimmed = end;
  while (trimmed > start) {
    const ch = text[trimmed - 1];
    if (always.includes(ch)) {
      trimmed -= 1;
      continue;
    }
    const opener = closers[ch];
    if (opener) {
      const body = text.slice(start, trimmed);
      const closed = body.split(ch).length - 1;
      const opened = body.split(opener).length - 1;
      if (closed > opened) {
        trimmed -= 1;
        continue;
      }
    }
    break;
  }
  return trimmed;
}

function isOpeningBoundary(ch: string | null): boolean {
  if (ch === null) return true;
  if (/\s/.test(ch)) return true;
  return '(<[「『【〔（"\'“”'.includes(ch);
}

function isURLTerminator(ch: string): boolean {
  return /\s/.test(ch) || ch === '<' || ch === '>';
}

// MARK: - where a card goes

/** One piece of a paragraph after the cards were lifted out of it. */
export type OrbitLinkPart =
  | { kind: 'card'; ref: OrbitLinkRef }
  /** A stretch of the paragraph that is left as prose. `start`/`end` are offsets into the paragraph
   *  as it was written, already trimmed of the whitespace the card's removal left at the edges. */
  | { kind: 'text'; text: string; start: number; end: number };

/** The paragraph that is nothing but a reference link, and the destination it points at. */
const LONE_REFERENCE = /^\[([^\]]*)\]\((orbit-(?:task|session|project|list):[^)\s]+)\)$/;

/**
 * A paragraph's links, as parts to draw in order — or null when nothing in it becomes a card.
 *
 * What becomes a card:
 *   * a bare page URL of this deployment, anywhere in the paragraph — the card takes the URL's place
 *     and the words either side become paragraphs of their own. Empty fragments are dropped, so a
 *     paragraph that was nothing but the URL is nothing but the card.
 *   * a paragraph that is nothing but `[名字](orbit-task:<id>)` — the way an agent is instructed to
 *     reference work. In a sentence, a list item or a table cell the same reference stays the name
 *     link it is today: 69% of them are written mid-sentence, and a paragraph of them would be a
 *     wall of cards.
 */
export function placeParagraph(text: string, host: string): OrbitLinkPart[] | null {
  const lone = LONE_REFERENCE.exec(text.trim());
  if (lone) {
    const target = targetForReference(lone[2]);
    if (target) return [{ kind: 'card', ref: { target, source: { kind: 'ref', ref: lone[2] } } }];
  }

  const matches = scanPageURLs(text, host);
  if (matches.length === 0) return null;

  const parts: OrbitLinkPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    pushText(parts, text, cursor, match.start);
    parts.push({ kind: 'card', ref: { target: match.target, source: { kind: 'url', url: match.url } } });
    cursor = match.end;
  }
  pushText(parts, text, cursor, text.length);
  return parts;
}

/**
 * The text either side of a card, as prose — unless there is nothing left of it.
 *
 * The full stop that ended `见 https://…/abc。` is not part of the URL: it is what made the link a
 * sentence, and it is left behind when the link becomes a card. Drawn as a paragraph of its own it
 * would be a line containing one full stop under the card, so it goes with the words it belonged
 * to, which the card has already replaced.
 */
function pushText(parts: OrbitLinkPart[], text: string, from: number, to: number): void {
  const raw = text.slice(from, to);
  const leading = raw.length - raw.replace(/^\s+/, '').length;
  const trailing = raw.length - raw.replace(/\s+$/, '').length;
  const start = from + leading;
  const end = Math.max(start, to - trailing);
  const trimmed = text.slice(start, end);
  if (trimmed === '' || isOnlyPunctuation(trimmed)) return;
  parts.push({ kind: 'text', text: trimmed, start, end });
}

/** Whether a fragment is nothing but the sentence's own punctuation. */
function isOnlyPunctuation(text: string): boolean {
  const punctuation = '.,;:!?…·、。，；：！？\'"“”‘’()[]{}<>「」『』（）【】《》';
  return [...text].every((ch) => /\s/.test(ch) || punctuation.includes(ch));
}

// MARK: - the react-markdown pipeline

/** The tag a card node wears, and the key `components` in `MD` maps to the card component. It is
 *  not a JSX intrinsic element — it exists only so react-markdown can find the card by name. */
export const ORBIT_LINK_CARD_TAG = 'orbit-link-card';

/** An mdast node, as much of one as this file reads: the tree belongs to the plugin's caller. */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/**
 * The remark plugin: every paragraph that holds a link a card can stand for is split around it, and
 * the card is spliced in where the link was.
 *
 * This is OrbitKit's `OrbitLinkPlacement`, run on the tree react-markdown parses instead of on its
 * own block model — the same pass, so the transcript keeps rendering the blocks it always did once a
 * card is standing where a link used to be. Paragraphs are the only place either end looks: a link
 * in a list item, a quote, a heading or a table cell stays where it is.
 */
export function orbitLinkRemarkPlugin({ host }: { host: string }) {
  return (tree: MarkdownNode, file?: { value?: unknown }): void => {
    const source = typeof file?.value === 'string' ? file.value : '';
    const children = Array.isArray(tree.children) ? tree.children : [];
    const out: MarkdownNode[] = [];
    for (const node of children) {
      const parts = node?.type === 'paragraph' ? placeNode(node, source, host) : null;
      if (!parts) {
        out.push(node);
        continue;
      }
      for (const part of parts) {
        if (part.kind === 'card') out.push(cardNode(part.ref));
        else {
          const fragment = paragraphOf(node, part.start, part.end);
          if (fragment) out.push(fragment);
        }
      }
    }
    tree.children = out;
  };
}

/** The parts of one paragraph, with the offsets of its own source rather than of the whole message. */
function placeNode(node: MarkdownNode, source: string, host: string): OrbitLinkPart[] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || source === '') return null;
  // The paragraph exactly as it was written, inline markup and all: the rules are about tokens in
  // prose, and a reading of the rendered children could not tell `[名字](url)` from a bare URL.
  const parts = placeParagraph(source.slice(start, end), host);
  if (!parts) return null;
  return parts.map((part) =>
    part.kind === 'text' ? { ...part, start: part.start + start, end: part.end + start } : part,
  );
}

/** A card, as the tree carries it: the props `OrbitLinkCard` is drawn from, on a tag of our own. */
function cardNode(ref: OrbitLinkRef): MarkdownNode {
  return {
    type: 'orbitLinkCard',
    data: {
      hName: ORBIT_LINK_CARD_TAG,
      hProperties: {
        kind: ref.target.kind,
        id: ref.target.id,
        // `reference`, not `ref`: React keeps `ref` for itself, and a card whose written text
        // arrived on it would be drawn from nothing.
        ...(ref.source.kind === 'url'
          ? { url: ref.source.url }
          : { reference: ref.source.ref }),
      },
    },
  };
}

/**
 * The prose a card left behind, as a paragraph of its own — the paragraph's own inline nodes, cut to
 * the stretch they occupy, so a `**bold**` or a `[名字](orbit-task:…)` beside a link keeps its
 * shape instead of being re-read as text.
 *
 * A text node is cut by arithmetic on its own value, which is what a node's rendered text is when
 * the source spells it out. Where the two differ — an entity or an escape, where `&amp;` renders as
 * one character — the cut lands a few characters off inside that node; the alternative is to render
 * every fragment as plain text and lose the markup around every card.
 */
function paragraphOf(node: MarkdownNode, start: number, end: number): MarkdownNode | null {
  const children: MarkdownNode[] = [];
  for (const child of node.children ?? []) {
    const from = child.position?.start?.offset;
    const to = child.position?.end?.offset;
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    if (to <= start || from >= end) continue;
    if (from >= start && to <= end) {
      children.push(detached(child));
      continue;
    }
    if (child.type !== 'text' || typeof child.value !== 'string') continue;
    const cut = child.value.slice(Math.max(0, start - from), Math.max(0, end - from));
    if (cut !== '') children.push({ ...detached(child), value: cut });
  }
  return children.length === 0 ? null : { type: 'paragraph', children };
}

/** A node moved into a fragment of its own. Its position named where it was in the message, and
 *  after a cut it names a stretch of prose this node no longer stands for — a reader of positions
 *  (a plugin after this one, this file's own test reading the fragment back) would be told a lie. */
function detached(node: MarkdownNode): MarkdownNode {
  const { position: _position, ...rest } = node;
  return rest;
}
