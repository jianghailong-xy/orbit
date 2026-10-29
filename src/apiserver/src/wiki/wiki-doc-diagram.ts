import { WIKI_DOC_DIAGRAM_RULES } from '@orbit/shared';

/**
 * A section's diagram (contract `docs.diagram`): the Mermaid flowchart a section's writer may draw, read as the small
 * part of Mermaid's flowchart syntax the contract states (`docs.diagram.syntax`) and written out again in one spelling —
 * the diagram's own node and subgraph ids, every label quoted, the characters Mermaid reads in a label written as its
 * entity codes — so a page draws only what was read here. Anything else in the block is no diagram, and neither is one
 * past the rules' sizes: the caller drops the block.
 *
 * What the diagram shows — each node's label (its id where it has none), each link's label and each subgraph's title —
 * comes back with it, for the check against the section's sourced sentences (wiki-docs.ts `keepSourcedDiagrams`).
 */
export interface WikiDocDiagram {
  /** The flowchart written out again: the diagram block's text, which a page draws. */
  source: string;
  /** Every text it shows, as `docs.diagram.labels` reads a label. */
  labels: string[];
}

const DIRECTIONS = new Set(['TB', 'TD', 'BT', 'RL', 'LR']);
const HEADER = /^(?:flowchart|graph)(?:\s+(\S+))?$/u;
const SKIPPED = /^(?:style|classDef|class|linkStyle|click)\b/u;
const ID = /^[A-Za-z0-9_]+(?:[-.][A-Za-z0-9_]+)*/u;
const CLASS_SUFFIX = /^:::[A-Za-z0-9_-]+/u;
/** -->, ---, -.->, -.-, ==>, === and the two-headed ones; a longer run of - or = is the same link. */
const LINK = /^(<?)(-{2,}|={2,}|-\.+-)(>?)/u;
/** `-- text -->` and its kin: the label between the link's opening and its end. */
const TEXT_LINK = /^(--|==|-\.)\s+(.+?)\s+(-{2,}>|-{3,}|={2,}>|={3,}|\.-+>|\.-+)(?![-=.>])/u;
const PIPE_LABEL = /^\|([^|]*)\|/u;
const SUBGRAPH = /^subgraph(?:\s+(.+))?$/u;
const SUBGRAPH_TITLED = new RegExp(`^(${ID.source.slice(1)})\\s*\\[(?:"([^"]*)"|([^\\]]*))\\]$`, 'u');
const SUBGRAPH_DIRECTION = /^direction\s+(\S+)$/u;

/** The shapes a node may wear, an opening that is the start of a longer one listed first. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['([', '])'], ['[[', ']]'], ['[(', ')]'], ['((', '))'], ['{{', '}}'], ['[', ']'], ['(', ')'], ['{', '}'],
];

/** The characters Mermaid reads in a label, as its entity codes. */
const ENTITIES: Readonly<Record<string, string>> = { '"': '#quot;', '#': '#35;', '<': '#lt;', '>': '#gt;', '&': '#amp;' };
/** A footnote marker the model left in a label: [3], [D1], [C2, S1], 【S1】. */
const MARKER = /\s*[[【]\s*[A-Z]?\d{1,4}(?:\s*[,，、]\s*[A-Z]?\d{1,4})*\s*[\]】]/gu;

interface Node {
  kind: 'node';
  /** Its id as written out: n1, n2, … in the order the nodes first appear. */
  n: string;
  id: string;
  label: string | null;
  shape: readonly [string, string];
}

interface Group {
  kind: 'group';
  /** Its id as written out: s1, s2, … */
  s: string;
  id: string | null;
  title: string;
  direction: string | null;
  items: Array<Node | Group>;
}

interface Link {
  from: string;
  to: string;
  op: string;
  label: string | null;
}

/** A label as the check reads it and the page shows it (contract `docs.diagram.labels`). */
export function diagramLabel(text: string): string {
  return text.replace(/<br\s*\/?>/giu, ' ').replace(MARKER, '').replace(/`/gu, '').replace(/\s+/gu, ' ').trim();
}

function quoted(label: string): string {
  return `"${label.replace(/["#<>&]/gu, (ch) => ENTITIES[ch])}"`;
}

/** A link's line and heads, written out one way; null for what is no link (`--` alone opens a labelled one). */
function linkOp(from: string, line: string, to: string): string | null {
  const style = line.startsWith('=') ? 'thick' : line.includes('.') ? 'dotted' : 'solid';
  if (from === '<' && to !== '>') return null;
  if (to === '' && style !== 'dotted' && line.length < 3) return null;
  const body = style === 'thick' ? '==' : style === 'dotted' ? '-.-' : '--';
  if (to === '') return style === 'thick' ? '===' : style === 'dotted' ? '-.-' : '---';
  return `${from}${body}>`;
}

/** A text link's end, by the way it opened and the way it ends: `-- x -->` is -->, `-. x .-` is -.-. */
function textLinkOp(open: string, end: string): string {
  const head = end.endsWith('>');
  if (open === '==') return head ? '==>' : '===';
  if (open === '-.') return head ? '-.->' : '-.-';
  return head ? '-->' : '---';
}

/** The diagram in a fenced mermaid block, or null when it is not the flowchart the contract reads. */
export function parseDiagram(text: string): WikiDocDiagram | null {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
    .map((line) => line.trim().replace(/;+$/u, '').trim())
    .filter((line) => line !== '' && !line.startsWith('%%'));
  const header = HEADER.exec(lines[0] ?? '');
  if (!header) return null;
  const direction = header[1] ?? 'TB';
  if (!DIRECTIONS.has(direction)) return null;

  const nodes = new Map<string, Node>();
  const groups: Group[] = [];
  const top: Array<Node | Group> = [];
  const links: Link[] = [];
  const open: Group[] = [];
  const itemsHere = (): Array<Node | Group> => open[open.length - 1]?.items ?? top;

  /** One node of a statement, registered where it first appears, and where the statement goes on; null when there is none. */
  const readNode = (line: string, at: number): { id: string; next: number } | null => {
    const id = ID.exec(line.slice(at))?.[0];
    if (!id) return null;
    let next = at + id.length;
    let label: string | null = null;
    let shape: readonly [string, string] | null = null;
    for (const candidate of SHAPES) {
      if (!line.startsWith(candidate[0], next)) continue;
      let p = next + candidate[0].length;
      if (line[p] === '"') {
        const end = line.indexOf('"', p + 1);
        if (end < 0) return null;
        label = line.slice(p + 1, end);
        p = end + 1;
        if (!line.startsWith(candidate[1], p)) return null;
      } else {
        const end = line.indexOf(candidate[1], p);
        if (end < 0) return null;
        label = line.slice(p, end);
        p = end;
      }
      next = p + candidate[1].length;
      shape = candidate;
      break;
    }
    const suffix = CLASS_SUFFIX.exec(line.slice(next));
    if (suffix) next += suffix[0].length;
    let node = nodes.get(id);
    if (!node) {
      node = { kind: 'node', n: `n${nodes.size + 1}`, id, label: null, shape: SHAPES[5] };
      nodes.set(id, node);
      itemsHere().push(node);
    }
    if (shape) {
      node.shape = shape;
      node.label = label;
    }
    return { id, next };
  };

  /** A chain of nodes joined by links: false when the line is not one. */
  const readStatement = (line: string): boolean => {
    const first = readNode(line, 0);
    if (!first) return false;
    let from = first.id;
    let at = first.next;
    for (;;) {
      while (line[at] === ' ' || line[at] === '\t') at += 1;
      if (at >= line.length) return true;
      const rest = line.slice(at);
      let op: string | null = null;
      let label: string | null = null;
      const texted = TEXT_LINK.exec(rest);
      if (texted) {
        op = textLinkOp(texted[1], texted[3]);
        label = texted[2];
        at += texted[0].length;
      } else {
        const link = LINK.exec(rest);
        if (!link) return false;
        op = linkOp(link[1], link[2], link[3]);
        if (op === null) return false;
        at += link[0].length;
        const piped = PIPE_LABEL.exec(line.slice(at));
        if (piped) {
          label = piped[1].trim().replace(/^"(.*)"$/u, '$1');
          at += piped[0].length;
        }
      }
      while (line[at] === ' ' || line[at] === '\t') at += 1;
      const to = readNode(line, at);
      if (!to) return false;
      links.push({ from, to: to.id, op, label });
      from = to.id;
      at = to.next;
    }
  };

  for (const line of lines.slice(1)) {
    if (SKIPPED.test(line)) continue;
    if (line === 'end') {
      if (open.length === 0) return null;
      open.pop();
      continue;
    }
    const turned = SUBGRAPH_DIRECTION.exec(line);
    if (turned && open.length > 0) {
      if (!DIRECTIONS.has(turned[1])) return null;
      open[open.length - 1].direction = turned[1];
      continue;
    }
    const subgraph = SUBGRAPH.exec(line);
    if (subgraph) {
      const head = (subgraph[1] ?? '').trim();
      if (head === '') return null;
      const titled = SUBGRAPH_TITLED.exec(head);
      let id: string | null = null;
      let title: string;
      if (titled) {
        id = titled[1];
        title = titled[2] ?? titled[3] ?? '';
      } else if (/^"[^"]*"$/u.test(head)) {
        title = head.slice(1, -1);
      } else if (ID.exec(head)?.[0] === head) {
        id = head;
        title = head;
      } else {
        title = head;
      }
      const group: Group = { kind: 'group', s: `s${groups.length + 1}`, id, title: diagramLabel(title) || (id ?? ''), direction: null, items: [] };
      if (group.title === '') return null;
      itemsHere().push(group);
      groups.push(group);
      open.push(group);
      continue;
    }
    if (!readStatement(line)) return null;
  }
  if (open.length > 0) return null;

  // A link's end that is a subgraph's id is the subgraph — unless the diagram gave that id a label of its own.
  const groupOf = new Map(groups.filter((group) => group.id !== null).map((group) => [group.id!, group]));
  const endOf = new Map<string, string>();
  for (const node of nodes.values()) {
    const group = groupOf.get(node.id);
    if (!group) {
      endOf.set(node.id, node.n);
      continue;
    }
    if (node.label !== null) return null;
    endOf.set(node.id, group.s);
    nodes.delete(node.id);
    const remove = (items: Array<Node | Group>): void => {
      const at = items.indexOf(node);
      if (at >= 0) items.splice(at, 1);
      for (const item of items) if (item.kind === 'group') remove(item.items);
    };
    remove(top);
  }
  if (nodes.size === 0 || nodes.size > WIKI_DOC_DIAGRAM_RULES.nodesMax || links.length > WIKI_DOC_DIAGRAM_RULES.edgesMax) return null;

  const labels: string[] = [];
  const shown = (raw: string): string | null => {
    const label = diagramLabel(raw);
    if (Array.from(label).length > WIKI_DOC_DIAGRAM_RULES.labelMaxChars) return null;
    labels.push(label);
    return label;
  };
  const out = [`flowchart ${direction}`];
  const write = (items: ReadonlyArray<Node | Group>, depth: number): boolean => {
    const pad = '  '.repeat(depth);
    for (const item of items) {
      if (item.kind === 'node') {
        const label = shown((item.label !== null ? diagramLabel(item.label) : '') || item.id);
        if (label === null) return false;
        out.push(`${pad}${item.n}${item.shape[0]}${quoted(label)}${item.shape[1]}`);
        continue;
      }
      const title = shown(item.title);
      if (title === null) return false;
      out.push(`${pad}subgraph ${item.s}[${quoted(title)}]`);
      if (item.direction !== null) out.push(`${pad}  direction ${item.direction}`);
      if (!write(item.items, depth + 1)) return false;
      out.push(`${pad}end`);
    }
    return true;
  };
  if (!write(top, 1)) return null;
  for (const link of links) {
    const label = link.label === null ? '' : diagramLabel(link.label);
    if (label !== '' && shown(label) === null) return null;
    out.push(`  ${endOf.get(link.from)} ${link.op}${label === '' ? '' : `|${quoted(label)}|`} ${endOf.get(link.to)}`);
  }
  return { source: out.join('\n'), labels };
}
