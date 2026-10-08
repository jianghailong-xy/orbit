import { goTrimSpace } from './wiki-import-extract';

/**
 * The compact line format the model drafts a plan in, and how the drafting job reads it back
 * (contracts/wiki.contract.json `plan.jobs.server`, design §8, P6) — ported from
 * `src/runner-go/wiki_plan_format.go`, which does the same on the runner until P10 removes it.
 *
 * The model writes Markdown lines with a few fixed labels, never JSON — a forty-document catalogue in JSON
 * is what ran into the sample's hour-long timeout — and this file turns them into the plan's schema. It
 * never rewrites a word the model wrote: a line it cannot place is kept as stray and handed back by the gate
 * as a field the plan does not have.
 *
 * ONE READING, TWO IMPLEMENTATIONS. Until P10 the runner and the server both read these answers, and the
 * project's criterion asks that the same answer read the same on both (`wiki-plan.fixture.json` holds the
 * two to the same outputs). So the regular expressions below are RE2's, spelled for JavaScript: RE2's `\s`
 * is the five ASCII spaces (`S` below) and its `.` every character but a newline, and a label is looked for
 * within Go's byte offsets, not JavaScript's code units.
 */

// ── Go's own readings of text ───────────────────────────────────────────────────────────────────────

/** RE2's `\s`: tab, newline, form feed, carriage return and space — and nothing else, not even U+3000. */
const S = '[\\t\\n\\f\\r ]';
/** RE2's `\S`. */
const NS = '[^\\t\\n\\f\\r ]';

/** strings.Trim(text, cutset): every leading and trailing character of the set. */
export function goTrim(text: string, cutset: string): string {
  return goTrimRight(goTrimLeft(text, cutset), cutset);
}

/** strings.TrimLeft(text, cutset). */
export function goTrimLeft(text: string, cutset: string): string {
  const set = new Set(cutset);
  const runes = [...text];
  let start = 0;
  while (start < runes.length && set.has(runes[start])) start += 1;
  return runes.slice(start).join('');
}

/** strings.TrimRight(text, cutset). */
export function goTrimRight(text: string, cutset: string): string {
  const set = new Set(cutset);
  const runes = [...text];
  let end = runes.length;
  while (end > 0 && set.has(runes[end - 1])) end -= 1;
  return runes.slice(0, end).join('');
}

/** strings.FieldsFunc(text, f): the runs of characters between the ones `f` holds, none empty. */
export function goFieldsFunc(text: string, split: (rune: string) => boolean): string[] {
  const out: string[] = [];
  let field = '';
  for (const rune of text) {
    if (split(rune)) {
      if (field !== '') out.push(field);
      field = '';
      continue;
    }
    field += rune;
  }
  if (field !== '') out.push(field);
  return out;
}

/** The characters of a text, as Go's `len([]rune(text))` counts them. */
export function runeCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Go's sort.Strings: by the strings' bytes, which for UTF-8 is by code point. */
export function goCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** strings.Cut(text, sep). */
function goCut(text: string, sep: string): [string, string, boolean] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, '', false] : [text.slice(0, i), text.slice(i + sep.length), true];
}

/** One match as Go's FindStringSubmatch gives it: the match and every group, '' for a group that took no part. */
function submatch(pattern: RegExp, text: string): string[] | null {
  const m = pattern.exec(text);
  return m ? m.map((group) => group ?? '') : null;
}

// ── What the model's answers are read into ──────────────────────────────────────────────────────────

/** One category of the catalogue being drafted. */
export interface WikiPlanCat {
  key: string;
  title: string;
  question: string;
  forAgents: boolean;
}

export interface WikiPlanDocSource {
  path: string;
  section: string | null;
}

export interface WikiPlanCodeSource {
  path: string;
  symbols: string[];
}

/** A section's session condition as the model wrote it. */
export interface WikiPlanSessionsDraft {
  projects: string[];
  keywords: string[];
  anchorPaths: string[];
  entryKinds: string[];
  topics: string[];
  since: string;
  until: string;
  evidence: string;
  stray: string[];
}

/** One section as the model wrote it. */
export interface WikiPlanSectionDraft {
  title: string;
  kind: string;
  length: string;
  covers: string;
  docs: WikiPlanDocSource[];
  code: WikiPlanCodeSource[];
  contracts: string[];
  sessions: WikiPlanSessionsDraft | null;
  stray: string[];
}

/** A document's header as the model wrote it. */
export interface WikiPlanHeader {
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: string[];
  length: string;
  keyDocs: string[];
  keyCode: string[];
  keyContracts: string[];
  topics: string[];
  projects: string[];
}

export function emptyWikiPlanHeader(): WikiPlanHeader {
  return { title: '', question: '', audience: [], scopeIn: [], scopeOut: [], length: '', keyDocs: [], keyCode: [], keyContracts: [], topics: [], projects: [] };
}

// ── The plan's schema, as a draft carries it (`plan.schema`, wiki_plan.go) ─────────────────────────

export interface WikiPlanSessions {
  projects: string[];
  since: string | null;
  until: string | null;
  keywords: string[];
  anchorPaths: string[];
  entryKinds: string[];
  topics: string[];
  evidence: string;
}

export interface WikiPlanSources {
  docs: WikiPlanDocSource[];
  code: WikiPlanCodeSource[];
  contracts: Array<{ path: string }>;
  sessions: WikiPlanSessions | null;
}

export interface WikiPlanSection {
  /** Stable within its document; the server gives one to a section that has none. Omitted when empty. */
  key?: string;
  title: string;
  kind: string;
  covers: string;
  length: number;
  sources: WikiPlanSources;
  extra?: Record<string, unknown>;
}

export interface WikiPlanScopeOut {
  text: string;
  docs: string[];
}

export interface WikiPlanDoc {
  category: string;
  slug: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: WikiPlanScopeOut[];
  length: { min: number; max: number };
  /** Only the owner protects a document; a draft carries a protected one exactly as it was. Omitted when false. */
  protected?: boolean;
  sections: WikiPlanSection[];
  extra?: Record<string, unknown>;
}

export interface WikiPlanCategory {
  key: string;
  title: string;
  question?: string;
  forAgents?: boolean;
  extra?: Record<string, unknown>;
}

export interface WikiPlanNewFieldDraft {
  at: string;
  name: string;
  why: string;
}

export interface WikiPlanDraft {
  categories: WikiPlanCategory[];
  docs: WikiPlanDoc[];
  newFields?: WikiPlanNewFieldDraft[];
}

/** One version's document as the plan's read gives it (WikiPlanDoc of @orbit/shared, the fields this reads). */
export interface WikiPlanDocRead {
  category: string;
  slug: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: Array<{ text: string; docs: string[] }>;
  length: { min: number; max: number };
  protected: boolean;
  extra: Record<string, unknown> | null;
  sections: Array<{
    key: string;
    title: string;
    kind: string;
    covers: string;
    length: number;
    extra: Record<string, unknown> | null;
    sources: {
      docs: Array<{ path: string; section: string | null }>;
      code: Array<{ path: string; symbols: string[] }>;
      contracts: Array<{ path: string }>;
      sessions: {
        projects: Array<{ id: string; title: string | null }>;
        since: string | null;
        until: string | null;
        keywords: string[];
        anchorPaths: string[];
        entryKinds: string[];
        topics: string[];
        evidence: string;
      } | null;
    };
  }>;
}

/**
 * A document of a version as a draft carries it (wikiPlanDocInput): every field as it was, a session
 * condition's projects by their ids, and its sections' keys.
 */
export function wikiPlanDocInput(read: WikiPlanDocRead): WikiPlanDoc {
  const doc: WikiPlanDoc = {
    category: read.category,
    slug: read.slug,
    title: read.title,
    question: read.question,
    audience: [...(read.audience ?? [])],
    scopeIn: [...(read.scopeIn ?? [])],
    scopeOut: (read.scopeOut ?? []).map((out) => ({ text: out.text, docs: [...(out.docs ?? [])] })),
    length: { min: read.length.min, max: read.length.max },
    sections: [],
  };
  if (read.protected) doc.protected = true;
  if (read.extra && Object.keys(read.extra).length > 0) doc.extra = read.extra;
  for (const s of read.sections ?? []) {
    const section: WikiPlanSection = {
      title: s.title,
      kind: s.kind,
      covers: s.covers,
      length: s.length,
      sources: {
        docs: (s.sources.docs ?? []).map((d) => ({ path: d.path, section: d.section ?? null })),
        code: (s.sources.code ?? []).map((c) => ({ path: c.path, symbols: [...(c.symbols ?? [])] })),
        contracts: (s.sources.contracts ?? []).map((c) => ({ path: c.path })),
        sessions: null,
      },
    };
    if (s.key) section.key = s.key;
    if (s.extra && Object.keys(s.extra).length > 0) section.extra = s.extra;
    const c = s.sources.sessions;
    if (c) {
      section.sources.sessions = {
        projects: (c.projects ?? []).map((p) => p.id),
        since: c.since ?? null,
        until: c.until ?? null,
        keywords: [...(c.keywords ?? [])],
        anchorPaths: [...(c.anchorPaths ?? [])],
        entryKinds: [...(c.entryKinds ?? [])],
        topics: [...(c.topics ?? [])],
        evidence: c.evidence ?? '',
      };
    }
    doc.sections.push(section);
  }
  return doc;
}

/**
 * One document of the draft: its card in the catalogue, what the model wrote of it, and — in a revision —
 * the document of the version revised it is carried from.
 */
export interface WikiPlanUnit {
  /** Its number in the catalogue this attempt assembles ("3.2"), and its category (an index of the run's). */
  id: string;
  cat: number;
  /** The card, from the catalogue. */
  slug: string;
  title: string;
  question: string;
  cardScope: string[];
  /** The body: its header and its outline, from the details and outline steps, a revision's rewrite, or a redo. */
  header: WikiPlanHeader;
  sections: WikiPlanSectionDraft[];
  stray: string[];
  hasBody: boolean;
  /** The catalogue its body was written against, id → slug: what "见 3.3" in it meant then. */
  refs: Map<string, string> | null;
  /** Carried from the version revised: a protected document, as it is; or one a revision keeps whole, less the sections it moved out. */
  protectedDoc: WikiPlanDoc | null;
  kept: WikiPlanDocRead | null;
  keptDrop: Set<number> | null;
  /** A revision's: the documents of the version revised it is made from, by their numbers there. */
  sources: string[];
}

function newUnit(fields: Pick<WikiPlanUnit, 'cat' | 'title' | 'slug' | 'question'>): WikiPlanUnit {
  return {
    id: '', cat: fields.cat, slug: fields.slug, title: fields.title, question: fields.question, cardScope: [],
    header: emptyWikiPlanHeader(), sections: [], stray: [], hasBody: false, refs: null, protectedDoc: null,
    kept: null, keptDrop: null, sources: [],
  };
}

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────────

const CAT_LINE = new RegExp(`^#{1,3}${S}*(\\d+)[.、]${S}*([^\\n]+?)${S}*(?:——|—|--)${S}*([^\\n]+)$`, 'u');
const DOC_LINE = new RegExp(`^[-*]${S}*(\\d+\\.\\d+)${S}+([^\\n]+?)${S}*\`([^\`]+)\`${S}*[|｜]${S}*([^\\n]+?)${S}*[|｜]${S}*([^\\n]+)$`, 'u');
const BACKTICK = /`([^`]*)`/u;
const BACKTICKS = /`([^`]*)`/gu;
const AGENTS = /\[agents\]|［agents］|（给 ?agent）|\(给 ?agent\)/u;
const AGENTS_ALL = /\[agents\]|［agents］|（给 ?agent）|\(给 ?agent\)/gu;
const MOVE_LINE = new RegExp(`^[-*]${S}*(\\d+\\.\\d+)${S}*§${S}*(\\d+)${S}*(?:→|->|=>)${S}*(\\d+\\.\\d+)`, 'u');
/** wikiPlanIDs: a document's number, `3.2`. */
export const WIKI_PLAN_IDS = /\d+\.\d+/gu;

/** A section a revision moves out of a document of the version revised. */
export interface WikiPlanMove {
  /** The document's number in the version revised. */
  from: string;
  /** The section's number there, from 1. */
  section: number;
  /** The document's number in the new catalogue, as the model wrote it. */
  to: string;
  /** The document of the new catalogue it moves into; null when the model's number names none. */
  target: WikiPlanUnit | null;
}

/** A catalogue as read from the model: its categories, each document's card, and — a revision's — each document's sources and the sections it moves. */
export interface WikiPlanCatalogue {
  cats: WikiPlanCat[];
  units: WikiPlanUnit[];
  moves: WikiPlanMove[];
  stray: string[];
}

/**
 * A catalogue: `## n. title `key` —— question [agents]` and `- n.m title `slug`｜question｜含：…` (a revision's also
 * carries `来源：…` and a list of moved sections). Documents are numbered again in order, whatever the model
 * numbered them; its own numbers name them only in its list of moves. Null for an answer with no category and
 * no document.
 */
export function parseWikiPlanCatalogue(text: string): WikiPlanCatalogue | null {
  const out: WikiPlanCatalogue = { cats: [], units: [], moves: [], stray: [] };
  const modelIds = new Map<string, WikiPlanUnit>();
  let inMoves = false;
  for (const raw of text.split('\n')) {
    const line = goTrimSpace(raw);
    if (line === '' || line === '---') continue;
    if (line.startsWith('#') && line.includes('移到')) {
      inMoves = true;
      continue;
    }
    if (inMoves) {
      const m = submatch(MOVE_LINE, line);
      if (m) {
        out.moves.push({ from: m[1], section: Number.parseInt(m[2], 10), to: m[3], target: null });
      } else {
        const none = goTrimSpace(goTrimLeft(line, '-*'));
        if (none !== '无' && none !== '（无）' && !line.startsWith('（')) out.stray.push(line);
      }
      continue;
    }
    const cat = submatch(CAT_LINE, line);
    if (cat) {
      let title = cat[2];
      let key = '';
      const k = submatch(BACKTICK, title);
      if (k) {
        key = goTrimSpace(k[1]);
        title = goTrimSpace(title.replace(BACKTICKS, ''));
      }
      const agents = AGENTS.test(line);
      const question = goTrimSpace(cat[3].replace(AGENTS_ALL, ''));
      title = goTrimSpace(title.replace(AGENTS_ALL, ''));
      out.cats.push({ key, title: goTrim(title, '* '), question, forAgents: agents });
      continue;
    }
    const doc = submatch(DOC_LINE, line);
    if (doc && out.cats.length > 0) {
      const unit = newUnit({ cat: out.cats.length - 1, title: goTrim(doc[2], '* '), slug: goTrimSpace(doc[3]), question: goTrimSpace(doc[4]) });
      for (const part of wikiPlanSplitBar(doc[5])) {
        const [label, value] = wikiPlanLabel(part);
        if (label === '含') unit.cardScope = wikiPlanSplitList(value);
        else if (label === '来源') unit.sources = value.match(WIKI_PLAN_IDS) ?? [];
        else unit.stray.push(part);
      }
      modelIds.set(doc[1], unit);
      out.units.push(unit);
      continue;
    }
    out.stray.push(line);
  }
  if (out.cats.length === 0 || out.units.length === 0) return null;
  // The model's numbers of the new catalogue, in its list of moves, name the documents they move into.
  for (const move of out.moves) move.target = modelIds.get(move.to) ?? null;
  return out;
}

/** The parts of a line the model wrote with ｜ or | between them, none empty. */
export function wikiPlanSplitBar(text: string): string[] {
  return goFieldsFunc(text, (r) => r === '|' || r === '｜').map((part) => goTrimSpace(part)).filter((part) => part !== '');
}

/**
 * `标签：值` split; a line with no label answers '' and itself. The label is looked for within the first
 * forty bytes of the line, as Go's loop over its runes reads them (a Chinese character is three).
 */
export function wikiPlanLabel(input: string): [string, string] {
  const text = goTrimSpace(input);
  let offset = 0;
  for (const rune of text) {
    if (rune === '：' || rune === ':') {
      const bytes = Buffer.from(text, 'utf8');
      const label = goTrimSpace(bytes.subarray(0, offset).toString('utf8'));
      if (label !== '' && runeCount(label) <= 12 && !/[ /`]/u.test(label)) {
        return [label, goTrimSpace(bytes.subarray(offset + Buffer.byteLength(rune, 'utf8')).toString('utf8'))];
      }
      break;
    }
    if (offset > 40) break;
    offset += Buffer.byteLength(rune, 'utf8');
  }
  return ['', text];
}

/** A list the model wrote with ；/; between its items. */
export function wikiPlanSplitList(text: string): string[] {
  return goFieldsFunc(text, (r) => r === '；' || r === ';')
    .map((part) => goTrimSpace(part))
    .filter((part) => part !== '' && part !== '无' && part !== '—' && part !== '-');
}

/** Names the model wrote with 、,， between them. */
export function wikiPlanSplitNames(input: string): string[] {
  const text = goTrimSpace(input);
  if (text === '' || text === '无' || text === '—' || text === '-' || text === '（无）') return [];
  return goFieldsFunc(text, (r) => r === '、' || r === ',' || r === '，')
    .map((part) => goTrim(goTrimSpace(part), '`「」'))
    .filter((part) => part !== '');
}

// ── One document's header and outline ───────────────────────────────────────────────────────────────

const SECTION_LINE = new RegExp(`^#{2,5}${S}*(\\d+)[.、]${S}*([^\\n]+?)${S}*[|｜]${S}*([A-Za-z]+)${S}*[|｜]${S}*([^\\n]+?)${S}*$`, 'u');
const DOC_HEADING = new RegExp(`^#{2,4}${S}*(\\d+\\.\\d+)${S}*([^\\n]*)$`, 'u');
const DATES = /\d{4}-\d{2}-\d{2}/gu;

/**
 * One document's header lines and its outline: what a revision's rewrite and a redo answer, and what the
 * details and outline steps answer between them.
 */
export function parseWikiPlanDocBody(text: string): { header: WikiPlanHeader; sections: WikiPlanSectionDraft[]; stray: string[] } {
  const header = emptyWikiPlanHeader();
  const sections: WikiPlanSectionDraft[] = [];
  const stray: string[] = [];
  let current: WikiPlanSectionDraft | null = null;
  let lastCovers = false;
  for (const raw of text.split('\n')) {
    const line = goTrimSpace(raw);
    if (line === '' || line === '---' || line === '```') continue;
    const m = submatch(SECTION_LINE, line);
    if (m) {
      current = {
        title: goTrim(m[2], '* '), kind: m[3].toLowerCase(), length: m[4], covers: '', docs: [], code: [], contracts: [],
        sessions: null, stray: [],
      };
      sections.push(current);
      lastCovers = false;
      continue;
    }
    if (DOC_HEADING.test(line) && current === null) continue; // `### 3.2 title`: the document's own heading
    const body = goTrimSpace(goTrimLeft(line, '-*•'));
    const [label, value] = wikiPlanLabel(body);
    if (current === null) {
      switch (label) {
        case '标题': header.title = value; break;
        case '问题': header.question = value; break;
        case '读者': header.audience = wikiPlanSplitList(value); break;
        case '含': header.scopeIn = wikiPlanSplitList(value); break;
        case '不含': header.scopeOut = wikiPlanSplitList(value); break;
        case '篇幅': header.length = value; break;
        case '文档': header.keyDocs = wikiPlanPaths(value); break;
        case '代码': header.keyCode = wikiPlanPaths(value); break;
        case '契约': header.keyContracts = wikiPlanPaths(value); break;
        case '主题': header.topics = wikiPlanSplitNames(value); break;
        case '项目': header.projects = wikiPlanProjectsOf(value); break;
        default: stray.push(body);
      }
      continue;
    }
    switch (label) {
      case '讲什么':
      case 'covers':
        current.covers = value;
        lastCovers = true;
        continue;
      case '文档':
        current.docs.push(...wikiPlanDocSourcesOf(value));
        break;
      case '代码':
        current.code.push(...wikiPlanCodeSourcesOf(value));
        break;
      case '契约':
        current.contracts.push(...wikiPlanPaths(value));
        break;
      case '会话':
      case '会话与条目':
        current.sessions = wikiPlanSessionsOf(value);
        break;
      case '':
        if (lastCovers && !line.startsWith('-')) {
          current.covers = goTrimSpace(`${current.covers} ${body}`);
          continue;
        }
        current.stray.push(body);
        break;
      default:
        current.stray.push(body);
    }
    lastCovers = false;
  }
  return { header, sections, stray };
}

/** A details answer: one `### n.m title` block a document, with its header lines. */
export function parseWikiPlanDetails(text: string): Map<string, WikiPlanHeader> {
  const out = new Map<string, WikiPlanHeader>();
  let id = '';
  let block: string[] = [];
  const flush = (): void => {
    if (id !== '') out.set(id, parseWikiPlanDocBody(block.join('\n')).header);
  };
  for (const raw of text.split('\n')) {
    const m = submatch(DOC_HEADING, goTrimSpace(raw));
    if (m) {
      flush();
      id = m[1];
      block = [];
      continue;
    }
    block.push(raw);
  }
  flush();
  return out;
}

const PATH_EXPAND = /([\w./-]+\/)[\t\n\f\r ]*[（(]([^）)]*)[）)]/gu;
const PATH_EXPANDS_FILES = /\.[a-z]{1,5}\b|\/$|\*/u;

/**
 * Paths as the model writes them: `a、b`, `dir/（x.ts、y.ts）` (files inside dir), `path（note）` (a note, not part
 * of the path).
 */
export function wikiPlanPaths(input: string): string[] {
  let text = goTrimSpace(input);
  if (text === '' || text === '无' || text === '（无）' || text === '—') return [];
  text = text.replace(PATH_EXPAND, (whole: string, dir: string, inner: string) => {
    const names = wikiPlanSplitNames(inner);
    if (names.length === 0 || !PATH_EXPANDS_FILES.test(inner)) return whole;
    return names.map((name) => dir + name).join('、');
  });
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const flush = (): void => {
    let part = goTrim(goTrimSpace(cur), '`「」');
    cur = '';
    if (part === '') return;
    const open = [...part].findIndex((r) => r === '（' || r === '(');
    if (open > 0) part = goTrimSpace([...part].slice(0, open).join(''));
    out.push(goTrim(part, '`'));
  };
  for (const r of text) {
    if (r === '（' || r === '(') depth += 1;
    else if ((r === '）' || r === ')') && depth > 0) depth -= 1;
    if (depth === 0 && (r === '、' || r === ',' || r === '，' || r === ';' || r === '；')) {
      flush();
      continue;
    }
    cur += r;
  }
  flush();
  return out;
}

/** `docs/x.md § heading` (or several `§` of one document). */
export function wikiPlanDocSourcesOf(text: string): WikiPlanDocSource[] {
  const [file, sections, has] = goCut(text, '§');
  const paths = wikiPlanPaths(file);
  if (paths.length === 0) return [];
  if (!has) return [{ path: paths[0], section: null }];
  const out: WikiPlanDocSource[] = [];
  for (const section of wikiPlanSectionNames(sections)) {
    const s = wikiPlanUnwrap(section);
    out.push(WHOLE_DOC.has(s) ? { path: paths[0], section: null } : { path: paths[0], section: s });
  }
  return out;
}

/**
 * `a、§ b` split into its sections: at a separator followed by `§`, and never inside parentheses, where a
 * heading's own text may name other sections — «2. 加固后的恢复策略（契约 §6.4、§6.5）» is one.
 */
export function wikiPlanSectionNames(text: string): string[] {
  const runes = [...text];
  const out: string[] = [];
  let name = '';
  let depth = 0;
  for (let i = 0; i < runes.length; i += 1) {
    const r = runes[i];
    if (r === '（' || r === '(') {
      depth += 1;
    } else if ((r === '）' || r === ')') && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && '、,，;；'.includes(r)) {
      let next = i + 1;
      while (next < runes.length && (runes[next] === ' ' || runes[next] === '　' || runes[next] === '\t')) next += 1;
      if (next < runes.length && runes[next] === '§') {
        out.push(name);
        name = '';
        i = next;
        continue;
      }
    }
    name += runes[i];
  }
  out.push(name);
  return out;
}

/** The names a model gives the whole of a document after `§`: no section. */
const WHOLE_DOC = new Set(['正文', '全文', '全篇', '整篇']);

/**
 * Parentheses a model put around a whole name taken off, and one left unmatched at either end — never the
 * closing one of a name that ends in its own, as «4. 数据模型（新表 `share_link`）» does.
 */
export function wikiPlanUnwrap(input: string): string {
  const opening = (r: string): boolean => r === '（' || r === '(';
  const closing = (r: string): boolean => r === '）' || r === ')';
  let text = input;
  for (;;) {
    const runes = [...goTrimSpace(text)];
    if (runes.length === 0) return '';
    let depth = 0;
    let opens = 0;
    let closes = 0;
    let wraps = opening(runes[0]);
    runes.forEach((r, i) => {
      if (opening(r)) {
        depth += 1;
        opens += 1;
      } else if (closing(r)) {
        depth -= 1;
        closes += 1;
        if (depth === 0 && i < runes.length - 1) wraps = false;
      }
    });
    const first = runes[0];
    const last = runes[runes.length - 1];
    if (closing(last) && closes > opens) text = runes.slice(0, -1).join('');
    else if (opening(first) && opens > closes) text = runes.slice(1).join('');
    else if (wraps && closing(last) && depth === 0) text = runes.slice(1, -1).join('');
    else return runes.join('');
  }
}

/**
 * Where another `path: symbols` begins on the same line, after a `；`: a path, then a colon. What follows a `；`
 * without one is more symbols of the path before it.
 */
const CODE_GROUP = new RegExp(`^[^\\t\\n\\f\\r :：,，、]+(?:/|\\.[A-Za-z0-9]+)[^\\t\\n\\f\\r :：,，、]*${S}*[:：]`, 'u');
const CODE_HEAD_SPACED = new RegExp(`^([^\\n]*?${NS})${S}*[:：]${S}+([^\\n]*)$`, 'u');
const CODE_HEAD_TIGHT = new RegExp(`^([^\\n]*?${NS})[:：]([^\\n]*)$`, 'u');

/** `src/x.go: a(), B.c`, and several of them on one line, `；` between them. */
export function wikiPlanCodeSourcesOf(text: string): WikiPlanCodeSource[] {
  const groups: string[] = [];
  for (const raw of goFieldsFunc(text, (r) => r === ';' || r === '；')) {
    const part = goTrimSpace(raw);
    if (part === '') continue;
    if (groups.length === 0 || CODE_GROUP.test(part)) groups.push(part);
    else groups[groups.length - 1] += `、${part}`;
  }
  return groups.flatMap((group) => wikiPlanCodeGroupOf(group));
}

/** One `src/x.go: a(), B.c`. */
function wikiPlanCodeGroupOf(text: string): WikiPlanCodeSource[] {
  let head = text;
  let rest = '';
  const spaced = submatch(CODE_HEAD_SPACED, text);
  const tight = spaced ? null : submatch(CODE_HEAD_TIGHT, text);
  if (spaced) [, head, rest] = spaced;
  else if (tight) [, head, rest] = tight;
  const symbols = goFieldsFunc(rest, (r) => r === ',' || r === '，' || r === '、')
    .map((part) => goTrim(goTrimSpace(part), '`'))
    .filter((part) => part !== '');
  return wikiPlanPaths(head).map((path) => ({ path, symbols: [...symbols] }));
}

/**
 * Project titles, each in 「」 — a 「」 inside one is part of its title, as in 「把「什么算完成」从项目末尾搬到开工前」 —
 * or, without them, between 、,，.
 */
export function wikiPlanProjectsOf(text: string): string[] {
  const out: string[] = [];
  let title = '';
  let depth = 0;
  for (const r of text) {
    if (r === '「') {
      if (depth > 0) title += r;
      depth += 1;
    } else if (r === '」' && depth > 0) {
      depth -= 1;
      if (depth > 0) {
        title += r;
      } else {
        const t = goTrimSpace(title);
        if (t !== '') {
          out.push(t);
          title = '';
        }
      }
    } else if (depth > 0) {
      title += r;
    }
  }
  return out.length > 0 ? out : wikiPlanSplitNames(text);
}

/** `项目「…」；时间 A 至 B；关键词 …；锚点 …；kind …；主题 …；要找：…`. */
export function wikiPlanSessionsOf(text: string): WikiPlanSessionsDraft {
  const out: WikiPlanSessionsDraft = {
    projects: [], keywords: [], anchorPaths: [], entryKinds: [], topics: [], since: '', until: '', evidence: '', stray: [],
  };
  let body = text;
  for (const mark of ['要找：', '要找:']) {
    const [before, after, ok] = goCut(body, mark);
    if (ok) {
      body = before;
      out.evidence = goTrimSpace(after);
      break;
    }
  }
  const kinds = (rest: string): string[] => goFieldsFunc(rest, (r) => r === '/' || r === '、' || r === ',' || r === '，' || r === ' ');
  for (const raw of goFieldsFunc(body, (r) => r === '；' || r === ';')) {
    const part = goTrimSpace(raw);
    if (part === '') continue;
    if (part.startsWith('项目')) {
      out.projects = wikiPlanProjectsOf(goTrimSpace(part.slice('项目'.length)));
    } else if (part.startsWith('时间')) {
      const dates: string[] = [...(part.match(DATES) ?? [])];
      if (dates.length > 0) out.since = dates[0];
      if (dates.length > 1) out.until = dates[1];
      if (dates.length === 0) out.stray.push(part);
    } else if (part.startsWith('关键词')) {
      out.keywords = wikiPlanSplitNames(part.slice('关键词'.length));
    } else if (part.startsWith('锚点路径')) {
      out.anchorPaths = wikiPlanSplitNames(part.slice('锚点路径'.length));
    } else if (part.startsWith('锚点')) {
      out.anchorPaths = wikiPlanSplitNames(part.slice('锚点'.length));
    } else if (part.toLowerCase().startsWith('kind')) {
      for (const k of kinds(part.slice(4))) {
        const kind = goTrimSpace(k);
        if (kind !== '') out.entryKinds.push(kind);
      }
    } else if (part.startsWith('条目 kind')) {
      out.entryKinds.push(...kinds(part.slice('条目 kind'.length)));
    } else if (part.startsWith('现有主题')) {
      out.topics = wikiPlanSplitNames(part.slice('现有主题'.length));
    } else if (part.startsWith('主题')) {
      out.topics = wikiPlanSplitNames(part.slice('主题'.length));
    } else {
      out.stray.push(part);
    }
  }
  return out;
}

// ── Numbers of documents in the text ────────────────────────────────────────────────────────────────

/** A pointer to another document written in words: `→ 3.2`, `见 3.2、3.3`, `see 3.2`. */
const CROSS_REF = new RegExp(`(→|->|参见|见|[Ss]ee)${S}*((?:\\d+\\.\\d+)(?:${S}*(?:[、,，]|和|及|与|and)${S}*\\d+\\.\\d+)*)`, 'gu');

/** The `（见 3.2）` a scope-out item ends with. */
export const WIKI_PLAN_SCOPE_OUT_REF = new RegExp(
  `${S}*[（(]${S}*(?:见|参见|→|see)${S}*((?:\\d+\\.\\d+)(?:${S}*(?:[、,，]|和|及|与)${S}*\\d+\\.\\d+)*)${S}*[）)]${S}*$`,
  'u',
);

/**
 * Every document number in text rewritten through rename (its number in the catalogue the text was written
 * against → its number now), and each one rename does not know named.
 */
export function wikiPlanRenumber(text: string, rename: (id: string) => string | null): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = text.replace(CROSS_REF, (whole: string, _arrow: string, list: string) => {
    const ids = list.replace(WIKI_PLAN_IDS, (id) => {
      const now = rename(id);
      if (now === null) {
        unknown.push(id);
        return id;
      }
      return now;
    });
    return whole.replace(list, () => ids);
  });
  return { text: out, unknown };
}

// ── Lengths ─────────────────────────────────────────────────────────────────────────────────────────

const NUMBERS = /\d[\d,]*/gu;

/** `1200–2000 字`, `约 1500 字` or `2,000`: the range a document is written to. */
export function wikiPlanRange(text: string): { min: number; max: number; ok: boolean } {
  const nums: number[] = [];
  for (const m of (text.match(NUMBERS) ?? []).slice(0, 2)) {
    const n = Number(m.replaceAll(',', ''));
    if (Number.isSafeInteger(n)) nums.push(n);
  }
  if (nums.length === 1) return { min: nums[0], max: nums[0], ok: nums[0] > 0 };
  if (nums.length === 2) return { min: nums[0], max: nums[1], ok: nums[0] > 0 && nums[1] >= nums[0] };
  return { min: 0, max: 0, ok: false };
}

// ── Writing a document back in the format ───────────────────────────────────────────────────────────

/**
 * A document of a version in the line format: what a revision hands the model of the documents a new one is
 * made from, and a redo of what it wrote.
 */
export function wikiPlanDocLines(doc: WikiPlanDoc, withHeader: boolean, drop: ReadonlySet<number> | null): string {
  let b = '';
  if (withHeader) {
    b += `标题：${doc.title}\n问题：${doc.question}\n读者：${doc.audience.join('；')}\n含：${doc.scopeIn.join('；')}\n`;
    const outs = doc.scopeOut.map((out) => out.text);
    if (outs.length > 0) b += `不含：${outs.join('；')}\n`;
    b += `篇幅：${doc.length.min}–${doc.length.max} 字\n`;
  }
  let n = 0;
  doc.sections.forEach((section, i) => {
    if (drop?.has(i + 1)) return;
    n += 1;
    b += wikiPlanSectionLines(n, section);
  });
  return b;
}

/** One section in the line format. */
export function wikiPlanSectionLines(n: number, s: WikiPlanSection): string {
  let b = `\n### ${n}. ${s.title} | ${s.kind} | ${s.length}\n讲什么：${s.covers}\n`;
  for (const d of s.sources.docs) {
    b += d.section !== null && d.section !== '' ? `- 文档：${d.path} § ${d.section}\n` : `- 文档：${d.path}\n`;
  }
  for (const c of s.sources.code) {
    b += c.symbols.length > 0 ? `- 代码：${c.path}: ${c.symbols.join(', ')}\n` : `- 代码：${c.path}\n`;
  }
  for (const c of s.sources.contracts) b += `- 契约：${c.path}\n`;
  if (s.sources.sessions) b += `- 会话：${wikiPlanSessionsLine(s.sources.sessions)}\n`;
  return b;
}

export function wikiPlanSessionsLine(s: WikiPlanSessions): string {
  const parts: string[] = [];
  if (s.projects.length > 0) parts.push(`项目${s.projects.map((p) => `「${p}」`).join('')}`);
  if (s.since !== null || s.until !== null) parts.push(`时间 ${s.since ?? ''} 至 ${s.until ?? '今'}`);
  if (s.keywords.length > 0) parts.push(`关键词 ${s.keywords.join('、')}`);
  if (s.anchorPaths.length > 0) parts.push(`锚点 ${s.anchorPaths.join('、')}`);
  if (s.entryKinds.length > 0) parts.push(`kind ${s.entryKinds.join('/')}`);
  if (s.topics.length > 0) parts.push(`主题 ${s.topics.join('、')}`);
  let line = parts.join('；');
  if (s.evidence !== '') line += `；要找：${s.evidence}`;
  return line;
}
