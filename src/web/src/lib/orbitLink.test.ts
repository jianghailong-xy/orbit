import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { orbitLinkRemarkPlugin } from './orbitLink';

/**
 * Which links in a conversation become Orbit cards, and where the card goes.
 *
 * The rules are written once, in `src/shared/src/orbit-link.fixture.json`, and this file is the web
 * half of a pair: OrbitKit's `OrbitLinkTests` walks the same file, so the two ends cannot drift into
 * two sets of rules that happen to agree today. The fixture is looked up by walking up from this
 * file and a missing one is a FAILURE — never a skip: a check that quietly opts out reports green on
 * exactly the day the thing it watches goes missing.
 *
 * What is asserted here is the whole pipeline the browser runs — remark parses the message, the
 * plugin splits what becomes a card — and not a second reading of the text beside it: a test of a
 * rule the client does not use would pass while the page showed something else.
 */

// MARK: - the fixture

interface FixtureCase {
  name: string;
  text: string;
  host?: string;
  blocks: unknown[];
}

interface Fixture {
  host: string;
  cases: FixtureCase[];
}

const RELATIVE = 'src/shared/src/orbit-link.fixture.json';

/** The repo root, found by walking up from this file until the shared fixture is under foot. Not a
 *  fixed number of hops: how deep this file sits is not what is being asserted. */
function fixturePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 12; up += 1) {
    const candidate = join(dir, RELATIVE);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    `${RELATIVE} was not found above this test file. The fixture is the contract both clients are ` +
      'proved against; if it moved, move this check with it rather than deleting it.',
  );
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath(), 'utf8'));

// MARK: - the pipeline the browser runs

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  align?: Array<string | null>;
  url?: string;
  alt?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** Parse a message and place its cards, exactly as `MD` does: gfm first (a table has to be a table
 *  before anything can read it), then the Orbit-link plugin. */
function treeFor(text: string, host: string): MarkdownNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(orbitLinkRemarkPlugin, { host });
  const tree = processor.parse(text) as unknown as MarkdownNode;
  processor.runSync(tree as never, text as never);
  return tree;
}

/** The fixture's block for one node: a card, or the markdown as it was written. */
function blockOf(node: MarkdownNode, source: string): unknown {
  if (node.type === 'orbitLinkCard') {
    const props = node.data?.hProperties ?? {};
    return {
      card: {
        kind: props.kind,
        id: props.id,
        ...(props.url !== undefined ? { url: props.url } : { ref: props.reference }),
      },
    };
  }
  return { markdown: markdownBlock(node, source) };
}

/**
 * The raw markdown of a node: what the fixture's `text` is. Sliced out of the message by the
 * position remark recorded rather than rebuilt from the rendered children — `[名字](url)` and
 * `` `code` `` are part of what a block says, and only the source still has them.
 *
 * A node the plugin created has no position (it is not in the message), and its own children are
 * what it says.
 */
function textOf(node: MarkdownNode | undefined, source: string): string {
  if (!node) return '';
  const from = node.position?.start?.offset;
  const to = node.position?.end?.offset;
  if (typeof from === 'number' && typeof to === 'number') return source.slice(from, to);
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map((child) => textOf(child, source)).join('');
}

/** What a block says, from its inline children: the marker a block wears on the outside (`##`, a
 *  table's `|`) is not part of it, and only the children know where the markers end. */
function inlineText(node: MarkdownNode, source: string): string {
  return (node.children ?? []).map((child) => textOf(child, source)).join('');
}

function markdownBlock(node: MarkdownNode, source: string): unknown {
  switch (node.type) {
    case 'paragraph': {
      // A paragraph holding nothing but an image is the fixture's `image` block.
      const only = node.children?.length === 1 ? node.children[0] : undefined;
      if (only?.type === 'image') return { type: 'image', source: only.url, alt: only.alt };
      return { type: 'paragraph', text: textOf(node, source) };
    }
    case 'heading':
      // The `##` is the block's marker, not part of what it says — the same reason a list item's
      // bullet is not in its text. Read off the inline children rather than the source span.
      return { type: 'heading', level: node.depth, text: inlineText(node, source) };
    case 'blockquote':
      return { type: 'quote', text: textOf(node.children?.[0], source) };
    case 'code':
      return { type: 'code', language: node.lang ?? null, code: node.value ?? '' };
    case 'thematicBreak':
      return { type: 'rule' };
    case 'list':
      return { type: 'list', items: listItems(node, source) };
    case 'table':
      // A cell's own `|` is the table's plumbing, not its text — read off the cell's children.
      return {
        type: 'table',
        headers: (node.children?.[0]?.children ?? []).map((cell) => inlineText(cell, source)),
        rows: (node.children ?? [])
          .slice(1)
          .map((row) => (row.children ?? []).map((cell) => inlineText(cell, source))),
        alignments: (node.align ?? []).map((align) => align ?? 'none'),
      };
    default:
      throw new Error(
        `the shared fixture has a block this reading does not know: "${node.type}". Read it here ` +
          'the way the transcript draws it, or the two ends are being proved against different sets.',
      );
  }
}

function listItems(list: MarkdownNode, source: string, indent = 0): unknown[] {
  return (list.children ?? []).flatMap((item, index) => {
    const paragraphs = item.children ?? [];
    const own = paragraphs.filter((child) => child.type !== 'list');
    const nested = paragraphs.filter((child) => child.type === 'list');
    return [
      {
        indent,
        ordered: list.ordered === true,
        number: list.ordered === true ? (list.start ?? 1) + index : null,
        text: own.map((child) => textOf(child, source).trim()).join('\n'),
        checkbox: item.checked ?? null,
      },
      ...nested.flatMap((child) => listItems(child, source, indent + 1)),
    ];
  });
}

// MARK: - the cases

describe('the shared cases, walked in full', () => {
  it('is the file both clients are proved against, with its cases still in it', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
    const names = fixture.cases.map((item) => item.name);
    // The coverage the fixture is for, so a case deleted in passing is a failure rather than one
    // fewer line of output. Deliberately a check on the shapes, not on the exact sentences — the
    // same list OrbitKit's half of this pair asserts.
    for (const required of ['url at the start', 'url alone', 'url at the end', 'middle of a sentence']) {
      expect(names.some((name) => name.includes(required)), `no case covers "${required}"`).toBe(true);
    }
    expect(names.filter((name) => name.startsWith('excluded')).length).toBeGreaterThanOrEqual(6);
    for (const required of [
      'a reference written into a sentence',
      'a reference in a list item',
      'a reference in a table cell',
      'alone in a paragraph',
    ]) {
      expect(names.some((name) => name.includes(required)), `no case covers "${required}"`).toBe(
        true,
      );
    }
  });

  for (const item of fixture.cases) {
    it(item.name, () => {
      const tree = treeFor(item.text, item.host ?? fixture.host);
      const got = (tree.children ?? []).map((node) => blockOf(node, item.text));
      expect(got).toEqual(item.blocks);
    });
  }
});

describe('what the page does with a link the cards do not cover', () => {
  it('leaves every block that is not a paragraph alone, cards and all', () => {
    // A message that mixes all four: the paragraph becomes a card, and the same URL written into a
    // list item, a quote and a heading stays where it is — the fixture proves each one on its own,
    // and this is the one message a reader actually meets.
    const url = 'https://orbitd.io/tasks/34TcwNgAIo6tGUiIKjqnQ';
    const tree = treeFor(`先看 ${url}\n\n- ${url}\n\n> ${url}\n\n# ${url}`, 'orbitd.io');
    expect((tree.children ?? []).map((node) => node.type)).toEqual([
      'paragraph',
      'orbitLinkCard',
      'list',
      'blockquote',
      'heading',
    ]);
  });

  it('asks for nothing when the message holds no link of this deployment', () => {
    const tree = treeFor('就是一句话，没有链接。', 'orbitd.io');
    expect((tree.children ?? []).map((node) => node.type)).toEqual(['paragraph']);
  });
});
