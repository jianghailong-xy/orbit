import { createHash } from 'node:crypto';
import { WIKI_DOC_BUILD_RULES, WIKI_DOC_RULES, WIKI_REPO_OPS, uuidToBase62, type WikiDocMaterialRecord } from '@orbit/shared';
import { stripNul } from '../runner-api/strip-nul';
import { collapseWhitespace, cutRunes, goTrimSpace } from './wiki-import-extract';

/**
 * `orbit wiki docs build`'s writer, on the server (contracts/wiki.contract.json `docs.build`, `docs.build.server`;
 * design §8, P7): the deterministic half of `src/runner-go/wiki_docs_build.go`, function for function — what a
 * section's material is, how it is filtered, capped and fingerprinted, how a design document's section, a code
 * symbol and a contract are cut out of a file, how a quote is folded and found, the prompts word for word, and how
 * the model's answers are read back into footnotes and a material ledger.
 *
 * NOTHING HERE READS ANYTHING. The repository comes in through `WikiDocRepo` — on the server, a file read by the
 * space's runner at the snapshot's commit (wiki-docs-build-job.ts) — and the records through the material the
 * server gathers (wiki-docs-material.ts). wiki-docs-build.ts runs a build over these functions.
 *
 * GO'S READING OF TEXT. Where the runner and the server must answer the same for the same input — the
 * fingerprint above all, which decides whether a section is written again whichever path wrote it last — the
 * port reads text the way Go does: a character is a code point, `\s` in a pattern is RE2's ASCII [\t\n\f\r ],
 * `.` is anything but a newline, `strings.TrimSpace` and `unicode.IsSpace` are Go's, and the fingerprint is the
 * sha256 of Go's json.Marshal (struct fields in their order, map keys sorted, `<`, `>`, `&` and U+2028/9 escaped).
 * src/shared/src/wiki-docs-build.fixture.json holds both implementations to the same answers.
 */

// ── The contract's numbers and words ────────────────────────────────────────────────────────────

/** The whole system prompt each call carries (`wikiDocsBuildSystemPrompt`): the rest is in the prompt. */
export const WIKI_DOCS_BUILD_SYSTEM_PROMPT = '你是 Orbit 的技术文档作者。你只根据给你的材料写，不编造事实、名字、数字和路径。'
  + '用中文写，代码名、路径、命令保留原文。只输出要求的内容。';

/** What of the repository one piece carries (wiki_docs_build.go's sample sizes). */
export const WIKI_DOC_PIECE_RULES = {
  docSectionChars: 4200,
  symbolChars: 3200,
  symbolLines: 70,
  commentLines: 25,
  fileHeadChars: 1800,
  fileHeadLines: 40,
  declsPerFile: 3,
  declChars: 2600,
  declLines: 50,
  filesPerDir: 4,
  contractChars: 2500,
} as const;

/** The section kinds whose material is the design documents and the code first. */
const MECHANISM_KINDS = new Set(['concepts', 'flow', 'interface', 'data', 'ops']);

const KIND_WORDS: Record<string, string> = {
  overview: '概述', concepts: '概念', flow: '流程', interface: '接口', data: '数据与配置', ops: '运维',
  pitfalls: '已知的坑', decisions: '决策与理由', conventions: '约定', other: '其他',
};

const WEIGHT_WORDS: Record<string, string> = {
  decision: '决定', merge: '合并记录', output: '命令输出', error: '报错', other: '其他',
};

/** `docs.dispositionActions`, in the order a section's line names them. */
const DISPOSITION_ACTIONS = ['adopt', 'merge', 'drop', 'over_cap', 'filtered'] as const;

// ── What the plan says ──────────────────────────────────────────────────────────────────────────

/** A section of the confirmed plan, as the writer reads it (`wikiDocsPlanSection`). */
export interface WikiDocsPlanSection {
  key: string;
  title: string;
  kind: string;
  covers: string;
  length: number;
  sources: {
    docs: Array<{ path: string; section: string | null }> | null;
    code: Array<{ path: string; symbols: string[] | null }> | null;
    contracts: Array<{ path: string }> | null;
    sessions: {
      projects: Array<{ id: string }> | null;
      since: string | null;
      until: string | null;
      keywords: string[] | null;
      anchorPaths: string[] | null;
      entryKinds: string[] | null;
      topics: string[] | null;
      evidence: string;
    } | null;
  };
}

/** A document of the confirmed plan (`wikiDocsPlanDoc`). */
export interface WikiDocsPlanDoc {
  slug: string;
  title: string;
  question: string;
  audience: string[] | null;
  sections: WikiDocsPlanSection[];
}

// ── Go's reading of text ────────────────────────────────────────────────────────────────────────

/** RE2's `\s`, which every Go pattern below means by it. */
const S = '[\\t\\n\\f\\r ]';

/** unicode.IsSpace. */
const GO_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

function isGoSpace(ch: string | undefined): boolean {
  return ch !== undefined && GO_SPACE.test(ch);
}

/** A text's characters, as Go's []rune holds them. */
function runesOf(text: string): string[] {
  return Array.from(text);
}

function runeCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** strings.Trim(text, "`"). */
function trimBackticks(text: string): string {
  return text.replace(/^`+|`+$/gu, '');
}

/** regexp.QuoteMeta. */
function quoteMeta(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$]/gu, (ch) => `\\${ch}`);
}

/** A Go struct for `goMarshal`: its fields in their declared order, an omitted field left out by the caller. */
class GoStruct {
  constructor(readonly fields: ReadonlyArray<readonly [string, unknown]>) {}
}

function goString(text: string): string {
  return JSON.stringify(text).replace(/[<>&\u007f\u2028\u2029]/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** json.Marshal: a GoStruct's fields in order, an object's keys sorted by their bytes (a Go map). */
function goMarshal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof GoStruct) return `{${value.fields.map(([key, field]) => `${goString(key)}:${goMarshal(field)}`).join(',')}}`;
  if (typeof value === 'string') return goString(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => goMarshal(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((key) => `${goString(key)}:${goMarshal(object[key])}`).join(',')}}`;
}

/** publicID: a uuid in its base62 spelling, anything else as it is. */
function publicId(id: string): string {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(id) ? uuidToBase62(id) : id;
}

function goSprintf(template: string, ...args: Array<string | number>): string {
  let next = 0;
  return template.replace(/%[sd]/gu, () => String(args[next++]));
}

// ── The material ────────────────────────────────────────────────────────────────────────────────

/** Lines (1-based, inclusive) of a repository piece, or characters (code points, end exclusive) of a record. */
export interface WikiDocRange {
  start: number;
  end: number;
}

/**
 * One piece of a section's material (`wikiDocPiece`): a design document's section, code, a contract, or a record
 * the server gathered. `action`, `into` and `reason` are what became of it; `handed`, whether the model saw it.
 */
export interface WikiDocPiece {
  id: string;
  kind: string;
  path: string;
  lines: WikiDocRange;
  section: string;
  symbol: string;
  ref: string;
  chars: WikiDocRange;
  text: string;
  record: WikiDocMaterialRecord | null;
  action: string;
  into: string;
  reason: string;
  handed: boolean;
}

/** A piece with nothing in it yet: Go's zero value of wikiDocPiece. */
export function wikiDocPiece(over: Partial<WikiDocPiece>): WikiDocPiece {
  return {
    id: '', kind: '', path: '', lines: { start: 0, end: 0 }, section: '', symbol: '', ref: '', chars: { start: 0, end: 0 },
    text: '', record: null, action: '', into: '', reason: '', handed: false, ...over,
  };
}

export function wikiDocIsRepoKind(kind: string): boolean {
  return kind === 'design_doc' || kind === 'code' || kind === 'contract';
}

/** Where a piece is, as its disposition names it: path#Lstart-end, or the record's id. */
export function wikiDocDispositionRef(piece: WikiDocPiece): string {
  return wikiDocIsRepoKind(piece.kind) ? `${piece.path}#L${piece.lines.start}-${piece.lines.end}` : piece.ref;
}

/** The project settlement card's message (contract `docs.build.templates`): the web composes it, nobody's words. */
const TEMPLATE_TURN = /^[\t\n\f\r ]*About [“"]/u;

/** Take out, by rule, what the model is never handed: the platform's template messages, and a text twice. */
export function wikiDocFilter(pieces: WikiDocPiece[]): void {
  const seen = new Map<string, string>();
  for (const piece of pieces) {
    if (piece.kind === 'turn' && TEMPLATE_TURN.test(piece.text) && piece.text.includes('Orbit has not recorded it done')) {
      piece.action = 'filtered';
      piece.reason = '平台自动生成的复查模板消息（项目结算卡片发出），不是 owner 原话';
      continue;
    }
    const key = createHash('sha256').update(goTrimSpace(piece.text), 'utf8').digest('hex');
    const first = seen.get(key);
    if (first !== undefined) {
      piece.action = 'filtered';
      piece.reason = `与 ${first} 的原文相同，只留一条`;
      continue;
    }
    seen.set(key, piece.id);
  }
}

/**
 * Keep what fits the section's cap (`docs.build.rules`), in the order its kind takes material: a mechanism's
 * documents and code first, the others' records first. The first piece is kept whatever its size.
 */
export function wikiDocSelect(kind: string, pieces: WikiDocPiece[]): void {
  const order: Record<string, number> = MECHANISM_KINDS.has(kind) ? { D: 0, C: 1, K: 2, S: 3 } : { S: 0, D: 1, C: 2, K: 3 };
  const rank = (piece: WikiDocPiece): number => order[piece.id.slice(0, 1)] ?? 0;
  const ranked = pieces.filter((piece) => piece.action === '');
  // Array.prototype.sort is stable, as sort.SliceStable is.
  ranked.sort((a, b) => rank(a) - rank(b));
  let total = 0;
  let kept = 0;
  for (const piece of ranked) {
    const size = runeCount(piece.text) + WIKI_DOC_BUILD_RULES.materialHeaderChars;
    if (kept > 0 && total + size > WIKI_DOC_BUILD_RULES.materialMaxChars) {
      piece.action = 'over_cap';
      piece.reason = `本节材料已满（上限 ${WIKI_DOC_BUILD_RULES.materialMaxChars} 字符），没有交给模型`;
      continue;
    }
    piece.handed = true;
    total += size;
    kept += 1;
  }
}

export function wikiDocHanded(pieces: readonly WikiDocPiece[]): WikiDocPiece[] {
  return pieces.filter((piece) => piece.handed);
}

/** A section's definition in the plan as the fingerprint takes it: its projects by id alone, spelled one way. */
export function wikiDocDefinition(section: WikiDocsPlanSection): Record<string, unknown> {
  const sources: Record<string, unknown> = {
    docs: section.sources.docs === null ? null : section.sources.docs.map((doc) => new GoStruct([['path', doc.path], ['section', doc.section]])),
    code: section.sources.code === null ? null : section.sources.code.map((code) => new GoStruct([['path', code.path], ['symbols', code.symbols]])),
    contracts: section.sources.contracts === null ? null : section.sources.contracts.map((contract) => new GoStruct([['path', contract.path]])),
    sessions: null,
  };
  const s = section.sources.sessions;
  if (s) {
    const projects = (s.projects ?? []).map((project) => publicId(project.id)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    sources.sessions = {
      projects, since: s.since, until: s.until, keywords: s.keywords, anchorPaths: s.anchorPaths,
      entryKinds: s.entryKinds, topics: s.topics, evidence: s.evidence,
    };
  }
  return { title: section.title, kind: section.kind, covers: section.covers, length: section.length, sources };
}

function rangeStruct(range: WikiDocRange): GoStruct {
  return new GoStruct([['start', range.start], ['end', range.end]]);
}

/**
 * A section's materialSha256 (contract `docs.fingerprint`): its definition and every piece gathered for it, as
 * gathered — not the commit it was read at.
 */
export function wikiDocFingerprint(section: WikiDocsPlanSection, pieces: readonly WikiDocPiece[]): string {
  const parts = pieces.map((piece) => {
    const fields: Array<[string, unknown]> = [['kind', piece.kind]];
    if (wikiDocIsRepoKind(piece.kind)) {
      if (piece.path !== '') fields.push(['path', piece.path]);
      fields.push(['lines', rangeStruct(piece.lines)]);
      if (piece.section !== '') fields.push(['section', piece.section]);
      if (piece.symbol !== '') fields.push(['symbol', piece.symbol]);
    } else {
      const ref = publicId(piece.ref);
      if (ref !== '') fields.push(['ref', ref]);
      fields.push(['chars', rangeStruct(piece.chars)]);
      const via = piece.record?.via ? publicId(piece.record.via.entryId) : '';
      if (via !== '') fields.push(['via', via]);
    }
    fields.push(['text', piece.text]);
    return new GoStruct(fields);
  });
  return wikiDocDigest({ definition: wikiDocDefinition(section), material: parts });
}

/** An overview's fingerprint: its definition and the fingerprints of the sections it sums up, after this run. */
export function wikiDocOverviewFingerprint(section: WikiDocsPlanSection, doc: WikiDocsPlanDoc, index: number, fingerprints: readonly string[]): string {
  const parts: GoStruct[] = [];
  doc.sections.forEach((other, i) => {
    if (i === index || other.kind === 'overview') return;
    parts.push(new GoStruct([['key', other.key], ['fingerprint', fingerprints[i] ?? '']]));
  });
  return wikiDocDigest({ definition: wikiDocDefinition(section), sections: parts });
}

export function wikiDocDigest(value: unknown): string {
  return createHash('sha256').update(goMarshal(value), 'utf8').digest('hex');
}

/**
 * The words a section is about, to match declarations in a file it names without symbols: code spans and
 * identifiers in its title and covers, and the Chinese words of its title.
 */
export function wikiDocSectionWords(section: Pick<WikiDocsPlanSection, 'covers' | 'title'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const word = goTrimSpace(raw);
    if (word !== '' && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  };
  const both = `${section.covers} ${section.title}`;
  for (const match of both.matchAll(/`([^`]+)`/gu)) add(match[1]);
  for (const match of both.matchAll(/[A-Za-z][A-Za-z0-9_]{3,}/gu)) add(match[0]);
  for (const match of section.title.matchAll(/\p{Script=Han}{2,4}/gu)) add(match[0]);
  return out;
}

// ── The repository at the commit ────────────────────────────────────────────────────────────────

/** One file as it was read at the commit: its text, and whether the read stopped short of its end. */
export interface WikiDocShown {
  text: string;
  /**
   * The read stopped at `repoOps.read.boundedChars`, the window a runner without the whole-file capability
   * gives: `text` is the file's first whole lines, not all of it. Something past them is not found here, and
   * says so, rather than being taken for something else.
   */
  cut: boolean;
}

/**
 * The checkout at the one commit a run reads (`wikiDocRepo`). `show` is `git show <sha>:<path>` — a directory
 * shows as git shows a tree — and `under` is every file under a directory, in git's order.
 */
export interface WikiDocRepo {
  readonly sha: string;
  show(path: string): WikiDocShown | null;
  under(dir: string): string[];
}

/** A path as the plan writes it, the way the writer reads it: no space, no backticks, no leading ./. */
export function wikiDocCleanPath(path: string): string {
  return trimBackticks(goTrimSpace(path)).replace(/^\.\//u, '');
}

/** What a piece past the read's end is missing for: the window a runner without the whole-file capability gives. */
const PAST_THE_READ = `(past the first ${WIKI_REPO_OPS.boundedChars} characters a read of the file gives)`;

/**
 * The repository's half of a section's material at the commit `repo` reads (`wikiDocRepoPieces`): its design
 * documents' sections, its code and its contracts, each numbered in its kind (D1, C1, K1), and what the commit
 * does not have.
 */
export function wikiDocRepoPieces(repo: WikiDocRepo, section: WikiDocsPlanSection): { pieces: WikiDocPiece[]; missing: string[] } {
  const pieces: WikiDocPiece[] = [];
  const missing: string[] = [];
  const count = new Map<string, number>();
  const add = (prefix: string, piece: WikiDocPiece): void => {
    const n = (count.get(prefix) ?? 0) + 1;
    count.set(prefix, n);
    piece.id = `${prefix}${n}`;
    pieces.push(piece);
  };
  const words = wikiDocSectionWords(section);
  for (const source of section.sources.docs ?? []) {
    const heading = source.section ?? '';
    const found = wikiDocDocSection(repo, source.path, heading);
    if (!found.piece) {
      missing.push(goTrimSpace(`${source.path} § ${heading}`) + (found.past ? ` ${PAST_THE_READ}` : ''));
      continue;
    }
    const piece = found.piece;
    const duplicate = pieces.some((other) => other.kind === 'design_doc' && other.path === piece.path && other.lines.start === piece.lines.start);
    if (!duplicate) add('D', piece);
  }
  for (const source of section.sources.code ?? []) {
    const got = wikiDocCodePieces(repo, source.path, source.symbols ?? [], words);
    missing.push(...got.missing);
    for (const piece of got.pieces) add('C', piece);
  }
  for (const source of section.sources.contracts ?? []) {
    const piece = wikiDocContract(repo, source.path);
    if (!piece) {
      missing.push(source.path);
      continue;
    }
    add('K', piece);
  }
  return { pieces, missing };
}

const HEADING_LINE = new RegExp(`^(#{1,6})${S}+([^\\n]*?)${S}*#*${S}*$`, 'u');
const FENCE_LINE = new RegExp(`^${S}*(\`\`\`+|~~~+)`, 'u');
const NUMBERED = new RegExp(`^${S}*§?${S}*(\\d+(?:\\.\\d+)*)\\b`, 'u');
const NORM_STRIP = /[`*_#§]/gu;
const NORM_LEAD = new RegExp(`^${S}*(\\d+(\\.\\d+)*)[.、)]?${S}*`, 'u');
const NORM_PUNCT = /[\t\n\f\r （）()：:，,。.、“”"'「」/\-—–]+/gu;

/** A heading as headings are matched (`wikiDocHeadingKey`): lowercase, its numbering and punctuation gone. */
export function wikiDocHeadingKey(text: string): string {
  return text.toLowerCase().replace(NORM_STRIP, '').replace(NORM_LEAD, '').replace(NORM_PUNCT, '');
}

/**
 * A design document's section (`docSection`): its heading's lines up to the next heading of the same or a higher
 * level, cut at a line to fit. With no section named, the document from its top.
 *
 * The heading named — by its words or its number — is taken before one whose words only contain the name or are
 * contained in it. In a file the read cut short only the first is looked for: a heading past the cut may be the
 * one named, and a near one before it would be the wrong section (`past` says so).
 */
export function wikiDocDocSection(repo: WikiDocRepo, path: string, section: string): { piece: WikiDocPiece | null; past: boolean } {
  const shown = repo.show(path);
  if (!shown) return { piece: null, past: false };
  const lines = shown.text.split('\n');
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fence = '';
  lines.forEach((line, i) => {
    const opened = FENCE_LINE.exec(line);
    if (opened) {
      fence = fence === '' ? opened[1].slice(0, 3) : '';
      return;
    }
    if (fence !== '') return;
    const heading = HEADING_LINE.exec(line);
    if (heading) headings.push({ line: i, level: heading[1].length, text: goTrimSpace(heading[2]) });
  });
  let start = 0;
  let level = 0;
  let title = path;
  if (headings.length > 0) title = headings[0].text;
  if (goTrimSpace(section) !== '') {
    const want = wikiDocHeadingKey(section);
    const number = NUMBERED.exec(section);
    const numbered = number ? new RegExp(`^${S}*§?${S}*${quoteMeta(number[1])}(?:[.\\t\\n\\f\\r :：、)]|$)`, 'u') : null;
    let found = false;
    for (let pass = 0; pass < (shown.cut ? 1 : 2) && !found; pass += 1) {
      for (const h of headings) {
        const key = wikiDocHeadingKey(h.text);
        const named = key === want || (numbered !== null && numbered.test(h.text));
        const near = (runeCount(want) >= 4 && key.includes(want)) || (runeCount(key) >= 4 && want.includes(key));
        if ((pass === 0 && named) || (pass === 1 && near)) {
          start = h.line;
          level = h.level;
          title = h.text;
          found = true;
          break;
        }
      }
    }
    if (!found) return { piece: null, past: shown.cut };
  }
  let end = lines.length;
  for (const h of headings) {
    if (h.line > start && (level === 0 || h.level <= level)) {
      end = h.line;
      break;
    }
  }
  while (end > start + 1 && goTrimSpace(lines[end - 1]) === '') end -= 1;
  const last = wikiDocFit(lines, start, end, WIKI_DOC_PIECE_RULES.docSectionChars);
  return {
    piece: wikiDocPiece({
      kind: 'design_doc', path: path.replace(/^\.\//u, ''), section: title,
      lines: { start: start + 1, end: last }, text: lines.slice(start, last).join('\n'),
    }),
    past: false,
  };
}

/** The last line (1-based, inclusive) of lines[start:end] that keeps the text within max characters — at least the first. */
export function wikiDocFit(lines: readonly string[], start: number, end: number, max: number): number {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += runeCount(lines[i]) + 1;
    if (total > max && i > start) return i;
  }
  return end;
}

const COMMENT_LINE = new RegExp(`^${S}*(//|/\\*|\\*|///|#)`, 'u');
const SYMBOL_TAIL = new RegExp(`${S}*\\[[^\\n]*?\\]${S}*$`, 'u');
const SYMBOL_ARGS = /\([^\n]*\)$/u;

/**
 * The line (0-based) a symbol is defined on, or -1 (`wikiDocSymbolLine`): a Go method on its receiver type, a
 * TypeScript method in its class, a function, type, class, interface, const or var.
 */
export function wikiDocSymbolLine(content: string, path: string, symbol: string): number {
  let s = trimBackticks(goTrimSpace(symbol)).replace(SYMBOL_TAIL, '');
  s = goTrimSpace(s.replace(SYMBOL_ARGS, ''));
  if (s === '') return -1;
  const parts = s.split('.');
  const name = quoteMeta(parts[parts.length - 1]);
  const lines = content.split('\n');
  const patterns: string[] = [];
  if (parts.length >= 2) {
    const owner = quoteMeta(parts[parts.length - 2]);
    if (path.endsWith('.go')) {
      patterns.push(`^func \\(\\w+ \\*?${owner}(?:\\[[^\\]]*\\])?\\) ${name}\\(`);
    } else {
      const klass = new RegExp(`\\b(class|struct|extension|enum|actor|interface)${S}+${owner}\\b`, 'u');
      const method = new RegExp(
        `^${S}+(?:@\\w+(?:\\([^)]*\\))?${S}+)*(?:public |private |protected |static |async |readonly |override |func |mutating |nonisolated |get |set )*`
          + `${name}${S}*[(<:=]`,
        'u',
      );
      for (let i = 0; i < lines.length; i += 1) {
        if (!klass.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length && j < i + 4000; j += 1) {
          if (method.test(lines[j])) return j;
        }
        break;
      }
    }
  }
  if (path.endsWith('.go')) {
    patterns.push(`^func ${name}[\\[(]`, `^type ${name}\\b`, `^${S}*(?:const|var)${S}+${name}\\b`, `^\\t${name}${S}+=`);
  } else if (path.endsWith('.swift')) {
    patterns.push(`\\b(?:struct|class|enum|protocol|actor)${S}+${name}\\b`, `\\bfunc ${name}${S}*[(<]`);
  } else {
    patterns.push(
      `^export (?:default )?(?:abstract )?(?:async )?(?:function\\*?|class|interface|type|enum|const|let)${S}+${name}\\b`,
      `^(?:async )?(?:function\\*?|class|interface|type|enum|const|let)${S}+${name}\\b`,
      `^${S}+(?:public |protected |private |static |async |readonly |override )*${name}${S}*[(<]`,
    );
  }
  for (const pattern of patterns) {
    const re = new RegExp(pattern, 'u');
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) return i;
    }
  }
  return -1;
}

/**
 * A definition from line i (`wikiDocExtract`): the comment above it, then on until its braces close (or, with
 * none, a blank line), at most maxLines, cut at a line to fit maxChars. Answers its first and last line (1-based)
 * and its text.
 */
export function wikiDocExtract(content: string, i: number, maxLines: number, maxChars: number): { start: number; end: number; text: string } {
  const lines = content.split('\n');
  let start = i;
  while (start > 0 && start > i - WIKI_DOC_PIECE_RULES.commentLines && COMMENT_LINE.test(lines[start - 1])) start -= 1;
  let depth = 0;
  let end = i;
  let opened = false;
  for (let j = i; j < lines.length && j < i + maxLines; j += 1) {
    depth += countOf(lines[j], '{') - countOf(lines[j], '}');
    if (lines[j].includes('{')) opened = true;
    end = j;
    if (opened && depth <= 0) break;
    if (!opened && j > i && goTrimSpace(lines[j]) === '') break;
  }
  const last = wikiDocFit(lines, start, end + 1, maxChars);
  return { start: start + 1, end: last, text: lines.slice(start, last).join('\n') };
}

function countOf(text: string, ch: string): number {
  let n = 0;
  for (let at = text.indexOf(ch); at >= 0; at = text.indexOf(ch, at + 1)) n += 1;
  return n;
}

const DECLARATION = new RegExp(`^(?:export )?(?:async )?(?:func|function|class|type|interface|const|struct|enum)${S}+(?:\\(\\w+ \\*?\\w+\\) )?(\\w+)`, 'u');
const HEAD_LINE = new RegExp(`^${S}*(//|/\\*|\\*|package|import|#)`, 'u');

/**
 * What a code source names (`codePieces`): each symbol's definition; with no symbols, the file's head comment and
 * the declarations the section's words match; a directory, the first files under it.
 */
export function wikiDocCodePieces(repo: WikiDocRepo, rawPath: string, symbols: readonly string[], words: readonly string[]): { pieces: WikiDocPiece[]; missing: string[] } {
  const path = wikiDocCleanPath(rawPath);
  const shown = repo.show(path);
  if (!shown) {
    let files = repo.under(path);
    if (files.length === 0) return { pieces: [], missing: [`${path} (not at origin/main)`] };
    if (files.length > WIKI_DOC_PIECE_RULES.filesPerDir) files = files.slice(0, WIKI_DOC_PIECE_RULES.filesPerDir);
    const out: WikiDocPiece[] = [];
    const missing: string[] = [];
    for (const file of files) {
      const got = wikiDocCodePieces(repo, file, [], [...words, ...symbols]);
      out.push(...got.pieces);
      missing.push(...got.missing);
    }
    return { pieces: out, missing };
  }
  const content = shown.text;
  const out: WikiDocPiece[] = [];
  const missing: string[] = [];
  for (const symbol of symbols) {
    const i = wikiDocSymbolLine(content, path, symbol);
    if (i < 0) {
      missing.push(`${path} :: ${symbol}${shown.cut ? ` ${PAST_THE_READ}` : ''}`);
      continue;
    }
    const got = wikiDocExtract(content, i, WIKI_DOC_PIECE_RULES.symbolLines, WIKI_DOC_PIECE_RULES.symbolChars);
    out.push(wikiDocPiece({ kind: 'code', path, symbol, lines: { start: got.start, end: got.end }, text: got.text }));
  }
  if (symbols.length > 0) return { pieces: out, missing };
  const lines = content.split('\n');
  let head = 0;
  while (head < lines.length && head < WIKI_DOC_PIECE_RULES.fileHeadLines && (goTrimSpace(lines[head]) === '' || HEAD_LINE.test(lines[head]))) head += 1;
  if (head > 0) {
    const last = wikiDocFit(lines, 0, head, WIKI_DOC_PIECE_RULES.fileHeadChars);
    out.push(wikiDocPiece({ kind: 'code', path, lines: { start: 1, end: last }, text: lines.slice(0, last).join('\n') }));
  }
  const matched: Array<{ score: number; line: number }> = [];
  lines.forEach((line, i) => {
    if (!DECLARATION.test(line)) return;
    const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n').toLowerCase();
    let score = 0;
    for (const word of words) {
      if (word !== '' && window.includes(word.toLowerCase())) score += 1;
    }
    if (score > 0) matched.push({ score, line: i });
  });
  matched.sort((a, b) => b.score - a.score);
  for (const [k, m] of matched.entries()) {
    if (k === WIKI_DOC_PIECE_RULES.declsPerFile) break;
    const got = wikiDocExtract(content, m.line, WIKI_DOC_PIECE_RULES.declLines, WIKI_DOC_PIECE_RULES.declChars);
    const name = DECLARATION.exec(lines[m.line])?.[1] ?? '';
    out.push(wikiDocPiece({ kind: 'code', path, symbol: name, lines: { start: got.start, end: got.end }, text: got.text }));
  }
  return { pieces: out, missing };
}

/** A contract file, cut at a line to fit (`contract`). */
export function wikiDocContract(repo: WikiDocRepo, rawPath: string): WikiDocPiece | null {
  const path = wikiDocCleanPath(rawPath);
  const shown = repo.show(path);
  if (!shown) return null;
  const lines = shown.text.split('\n');
  let end = lines.length;
  while (end > 1 && goTrimSpace(lines[end - 1]) === '') end -= 1;
  const last = wikiDocFit(lines, 0, end, WIKI_DOC_PIECE_RULES.contractChars);
  return wikiDocPiece({ kind: 'contract', path, lines: { start: 1, end: last }, text: lines.slice(0, last).join('\n') });
}

// ── Quotes, folded and found ────────────────────────────────────────────────────────────────────

/** The full-width punctuation a quote is compared as its ASCII counterpart (contract `docs.verification.normalization`). */
const PUNCTUATION: Readonly<Record<string, string>> = {
  '，': ',', '。': '.', '：': ':', '；': ';', '（': '(', '）': ')', '！': '!', '？': '?', '「': '"', '」': '"',
  '“': '"', '”': '"', '‘': "'", '’': "'", '、': ',', '『': '"', '』': '"', '【': '[', '】': ']', '—': '-', '–': '-',
};

const ESCAPABLE = '\\`*_{}[]()#+-.!|"';

/**
 * Fold runes[from:to] the way a quote is compared (`wikiDocFold`) — punctuation read as ASCII, ** __ and
 * backticks dropped, an escape read as what it escapes, whitespace dropped, and with skip the characters of each
 * line's leading comment marker — and answer, for each UTF-16 unit of the folded text, the rune it came from.
 *
 * The server's own `findQuote` (wiki-docs.ts) folds the same way but reads NFC first; this one reads the file as
 * it is, because the lines a quote is found at are counted in the file as it is.
 */
function fold(runes: readonly string[], from: number, to: number, skip: readonly boolean[] | null): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  for (let i = from; i < to; i += 1) {
    if (skip?.[i]) continue;
    let ch = runes[i];
    if (isGoSpace(ch) || ch === '`') continue;
    if ((ch === '*' || ch === '_') && i + 1 < to && runes[i + 1] === ch) {
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < to && ESCAPABLE.includes(runes[i + 1])) continue;
    ch = PUNCTUATION[ch] ?? ch;
    text += ch;
    for (let unit = 0; unit < ch.length; unit += 1) at.push(i);
  }
  return { text, at };
}

const COMMENT_MARKER = new RegExp(`^(?:/{2,3}|/\\*+|\\*+/?|#)${S}?`, 'u');

/** Each line's leading comment marker and the space after it (`wikiDocCommentSkips`). */
function commentSkips(runes: readonly string[]): boolean[] {
  const skip = new Array<boolean>(runes.length).fill(false);
  let lineStart = 0;
  while (lineStart <= runes.length) {
    let end = lineStart;
    while (end < runes.length && runes[end] !== '\n') end += 1;
    let first = lineStart;
    while (first < end && isGoSpace(runes[first])) first += 1;
    const limit = Math.min(first + 64, end);
    const marker = COMMENT_MARKER.exec(runes.slice(first, limit).join(''));
    if (marker && marker[0] !== '') {
      const length = runeCount(marker[0]);
      for (let k = first; k < first + length; k += 1) skip[k] = true;
    }
    lineStart = end + 1;
  }
  return skip;
}

/**
 * Where quote is in source (`wikiDocFind`), in runes [start, end), within runes[from:to]: one passage, folded,
 * first as it stands and then with each line's comment marker off; or null.
 */
export function wikiDocFind(source: readonly string[], quote: string, from: number, to: number): { start: number; end: number } | null {
  const quoteRunes = runesOf(quote);
  const needle = fold(quoteRunes, 0, quoteRunes.length, null).text;
  if (runeCount(needle) < WIKI_DOC_RULES.quoteMinChars) return null;
  const lo = Math.max(0, from);
  const hi = Math.min(source.length, to);
  if (lo >= hi) return null;
  for (const skip of [null, commentSkips(source)]) {
    const folded = fold(source, lo, hi, skip);
    const i = folded.text.indexOf(needle);
    if (i >= 0) return { start: folded.at[i], end: folded.at[i + needle.length - 1] + 1 };
  }
  return null;
}

/** The lines a quote is found at in a file (`wikiDocLocate`): within the lines it was taken from first, then anywhere. */
export function wikiDocLocate(content: string, quote: string, within: WikiDocRange | null): WikiDocRange | null {
  const runes = runesOf(content);
  const lineStarts = [0];
  runes.forEach((ch, i) => {
    if (ch === '\n') lineStarts.push(i + 1);
  });
  const lineOf = (at: number): number => {
    // sort.Search: the first k whose start is past `at` — the count of starts at or before it.
    let lo = 0;
    let hi = lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] > at) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const tries: Array<[number, number]> = [];
  if (within && within.start >= 1 && within.start <= lineStarts.length) {
    const from = lineStarts[within.start - 1];
    const to = within.end < lineStarts.length ? lineStarts[within.end] : runes.length;
    tries.push([from, to]);
  }
  tries.push([0, runes.length]);
  for (const [from, to] of tries) {
    const found = wikiDocFind(runes, quote, from, to);
    if (found) return { start: lineOf(found.start), end: lineOf(found.end - 1) };
  }
  return null;
}

/** The text of lines [start, end] of a file, cut to what an excerpt may hold (`wikiDocLines`). */
export function wikiDocLines(content: string, lines: WikiDocRange): string {
  const all = content.split('\n');
  if (lines.start < 1 || lines.start > all.length) return '';
  const end = Math.min(lines.end, all.length);
  return cutRunes(all.slice(lines.start - 1, end).join('\n'), WIKI_DOC_RULES.excerptMaxChars);
}

// ── The prompts ─────────────────────────────────────────────────────────────────────────────────

function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

// The four prompts, word for word as wiki_docs_build.go writes them (its fmt.Sprintf templates).

const WIKI_DOC_MERGE_TEMPLATE = `# 任务：为文档《%s》的第 %d 节做「归并」：把下面的材料合成这一节要写的「现状」

## 这一节
第 %d 节「%s」（%s，约 %d 字）：%s

## 材料（D=设计文档章节，C=代码，K=契约，都取自 origin/main；S=会话等一手记录的原文，已脱敏）
%s

## 归并规则（owner 已定）
1. 同一件事有多条材料时合成一条现状；新决定覆盖旧的。
2. 证据分量：决定（owner 原话与拍板、判据修订）> 合并记录（合并回执、交付评论）> 命令与测试输出 > 报错原文；同一分量取时间最新的一条。S 材料的标题写了它的证据分量和日期。
3. 不能当证据：agent 的猜测（「可能」「我怀疑」「估计」）、后来被推翻的说法、与本节无关的材料。
4. 讲机制的节以设计文档和代码为准；会话材料只用来说明「为什么」「坑」「决策」。代码与文档说法不一致时，以 origin/main 上的代码为准，并把不一致写进现状。
5. 被推翻的旧说法不进现状；如果它能解释当初为什么这么设计，可以写成「曾经……后来改为……」，并注明新旧两条材料。

## 输出格式
先逐条写处置，每条材料一行，一条不漏：
<编号> | 采用 | <一句理由>
<编号> | 合并到 <编号> | <一句理由>
<编号> | 舍弃 | <一句理由>
然后写：
现状：
- <一条要点，一句话> [<编号>][<编号>]
（3–8 条要点，每条标出依据的材料编号）
`;

const WIKI_DOC_WRITE_TEMPLATE = `# 任务：写文档《%s》的第 %d 节

## 这篇文档
- 读者带着的问题：%s
- 写给谁：%s
- 全篇大纲：
%s

## 本节
「%s」（%s，约 %d 字）：%s

## 归并后的现状（上一步的结果）
%s

## 可用材料（只可引用这些，编号不变）
%s

## 写法
- 写成连贯的技术文档段落：先讲是什么，再讲怎么运转、为什么。不要逐条罗列材料，不要写「材料显示」「根据会话记录」这类话。
- 每个陈述事实的句子，各自在句末标出依据的材料编号，如 [D1] 或 [C2][S3]。「决策与理由」「已知的坑」「约定」这类段落也要逐句标注，不能只在段末标一次。
- 讲机制（概念、流程、接口、数据、运维）只依据 D/C/K 材料；S 材料只用来讲为什么、已知的坑、决策。
- 契约和设计文档里的缩写与编号（例如 SR50、PAC §12、G0–G6 这类）第一次出现时，先用半句话说明它指什么，再用；说明不了就不用缩写，直接说它指的那件事。
- 过渡句、概括句可以不标编号，但不能带出材料里没有的新事实（新的名字、数字、路径、结论）。
- 不写材料里没有的事实。材料之间有冲突时写现状，必要时用一句话交代变化。
- 代码名、路径、命令用反引号，照原文写。长度约 %d 字。

## 引文
正文之后另起一行写「引文：」，为正文里用到的每个编号各写一行逐字引文：从该材料原文里原样抄出支撑你那句话的一小段（10–80 字，一字不改，不翻译，不把两处拼在一起，不加省略号）。正文里出现的每一个编号都必须有一行引文。
[D1] 「……」
[S3] 「……」

## 输出格式
只输出下面这些，不要前言：
### %s
<正文>

引文：
[编号] 「逐字引文」
`;

const WIKI_DOC_OVERVIEW_TEMPLATE = `# 任务：写文档《%s》的第 %d 节「%s」（概述，约 %d 字）

## 这篇文档
- 读者带着的问题：%s
- 写给谁：%s
- 这一节要概括：%s

## 下文各节已经写好（正文里的 [F编号] 是它们的脚注）
%s

## 这些脚注的逐字引文
%s

## 写法
- 用一两段话告诉读者：这篇讲的东西是什么、怎么运转、读完能知道什么；点出最重要的几件事。
- 只概括下文已经写了的内容，不引入新事实。每个陈述事实的句子在句末沿用下文该事实所用的 [F编号]，只用上面列出的编号。
- 不写「本文将介绍」这类空话。

## 输出格式
只输出下面这些，不要前言：
### %s
<正文>
`;

const WIKI_DOC_QUOTE_REPAIR_TEMPLATE = `# 任务：给下面几个脚注补逐字引文

你刚写的一节里，这些编号的引文缺了，或者在材料原文里找不到。请为每个编号从它的材料原文里原样抄出一段支撑那些句子的文字（10–80 字，一字不改，不翻译，不把两处拼在一起，不加省略号）。

%s

## 输出格式
每个编号一行，只输出这些：
[编号] 「逐字引文」
`;


/**
 * A piece's first line as the model reads it (`wikiDocHeader`): what it is, where it is, and — a record — who said
 * it, when, with what weight, and the entry it came through.
 */
export function wikiDocHeader(piece: WikiDocPiece): string {
  switch (piece.kind) {
    case 'design_doc':
      return `[${piece.id}] 设计文档 ${piece.path} § ${piece.section}（L${piece.lines.start}–L${piece.lines.end}，origin/main）`;
    case 'code':
      return `[${piece.id}] 代码 ${piece.path}${piece.symbol !== '' ? ` · ${piece.symbol}` : ''}（L${piece.lines.start}–L${piece.lines.end}，origin/main）`;
    case 'contract':
      return `[${piece.id}] 契约 ${piece.path}（L${piece.lines.start}–L${piece.lines.end}，origin/main）`;
    default:
      break;
  }
  const record = piece.record;
  const who = wikiDocWho(piece);
  let when = '';
  let where = '';
  let via = '';
  if (record) {
    // Go slices the first ten bytes; a timestamp is ASCII.
    if (record.at !== null && record.at.length >= 10) when = record.at.slice(0, 10);
    for (const name of [record.sessionTitle, record.taskTitle, record.notePath]) {
      if (name !== null && name !== undefined && name !== '') {
        where = cutRunes(name, 60);
        break;
      }
    }
    if (record.via) via = `，经条目《${record.via.title}》`;
    if (record.projectTitle !== null && record.projectTitle !== undefined && record.projectTitle !== '') where += `（项目「${cutRunes(record.projectTitle, 40)}」）`;
  }
  const weight = record && WEIGHT_WORDS[record.weight] !== undefined ? ` · 证据分量：${WEIGHT_WORDS[record.weight]}` : '';
  return `[${piece.id}] 记录原文 · ${who} · ${when} · 「${where}」${via}${weight}`;
}

/** Who a record's words are (`wikiDocWho`). */
export function wikiDocWho(piece: WikiDocPiece): string {
  const record = piece.record;
  const label = record?.label ?? '';
  switch (piece.kind) {
    case 'turn':
      return record?.ownerWords ? 'owner 原话' : '会话消息';
    case 'event':
      switch (label) {
        case 'assistant':
          return 'agent 回复';
        case 'thinking':
          return 'agent 思考';
        case 'tool_use':
          return 'agent 工具调用';
        case 'tool_result':
          return record?.weight === 'error' ? '工具结果（报错）' : '工具结果';
        case 'error':
          return '报错';
        default:
          return `会话事件 ${label}`;
      }
    case 'tool_call':
      return record?.weight === 'error' ? '命令输出（报错）' : '命令输出';
    case 'task_comment':
      return record?.ownerWords ? 'owner 评论' : 'agent 交付评论';
    case 'approval':
      return 'owner 的回答';
    case 'owner_decision':
      return 'owner 的决定';
    case 'merge_receipt':
      return '合并回执';
    case 'note':
      return '导入的笔记';
    case 'task':
      return '任务描述';
    default:
      return piece.kind;
  }
}

function block(piece: WikiDocPiece): string {
  const body = piece.kind === 'code' ? `\`\`\`\n${piece.text}\n\`\`\`` : piece.text;
  return `${wikiDocHeader(piece)}\n${body}`;
}

function outline(doc: WikiDocsPlanDoc, current: number): string {
  return doc.sections
    .map((section, i) => `  ${i + 1}. ${section.title}（${kindWord(section.kind)}）—— ${section.covers}${i === current ? '　← 本节' : ''}`)
    .join('\n');
}

function audience(doc: WikiDocsPlanDoc): string {
  return (doc.audience ?? []).join('；');
}

/** Ask the model to merge the pieces it is handed into the section's current state, and to say what became of each. */
export function wikiDocMergePrompt(doc: WikiDocsPlanDoc, index: number, handed: readonly WikiDocPiece[]): string {
  const section = doc.sections[index];
  return goSprintf(
    WIKI_DOC_MERGE_TEMPLATE,
    doc.title, index + 1, index + 1, section.title, kindWord(section.kind), section.length, section.covers,
    handed.map((piece) => block(piece)).join('\n\n'),
  );
}

/** Ask the model to write the section from the pieces it kept, with a verbatim quote for every footnote it marks. */
export function wikiDocWritePrompt(doc: WikiDocsPlanDoc, index: number, state: readonly string[], used: readonly WikiDocPiece[]): string {
  const section = doc.sections[index];
  const stateText = state.length > 0 ? `- ${state.join('\n- ')}` : '（无）';
  const materials = used.length > 0
    ? used.map((piece) => block(piece)).join('\n\n')
    : '（归并后没有可用材料。只写一两句本篇的边界说明，不陈述新事实。）';
  return goSprintf(
    WIKI_DOC_WRITE_TEMPLATE,
    doc.title, index + 1, doc.question, audience(doc), outline(doc, index), section.title, kindWord(section.kind),
    section.length, section.covers, stateText, materials, section.length, section.title,
  );
}

/** One footnote of the document's other sections, as the overview may cite it. */
export interface WikiDocOverviewNote {
  id: string;
  footnote: WikiDocFootnote;
}

/** Ask for the overview from the other sections as they are written. */
export function wikiDocOverviewPrompt(doc: WikiDocsPlanDoc, index: number, sections: readonly string[], notes: readonly WikiDocOverviewNote[]): string {
  const section = doc.sections[index];
  const quotes = notes.map((note) => `[${note.id}] ${note.footnote.quote !== null ? `「${note.footnote.quote}」` : '（无引文）'}`);
  return goSprintf(
    WIKI_DOC_OVERVIEW_TEMPLATE,
    doc.title, index + 1, section.title, section.length, doc.question, audience(doc), section.covers,
    sections.join('\n\n'), quotes.join('\n'), section.title,
  );
}

/** Ask once more for the quotes that were missing or not found in their originals. */
export function wikiDocQuoteRepairPrompt(draft: WikiDocDraft, ids: readonly string[], used: readonly WikiDocPiece[]): string {
  const byId = new Map(used.map((piece) => [piece.id, piece]));
  const parts = ids.map((id) => {
    const piece = byId.get(id);
    const sentences = wikiDocSentencesCiting(draft.body, id);
    return `## [${id}] 标在这些句子上：\n${sentences.join('\n')}\n材料原文：\n${piece?.text ?? ''}`;
  });
  return goSprintf(WIKI_DOC_QUOTE_REPAIR_TEMPLATE, parts.join('\n\n'));
}

/** What a draft whose paragraphs marked only their last sentence is told when it is asked again. */
export function wikiDocEndOnlyNote(lonely: readonly string[]): string {
  return '\n\n## 上一稿的问题\n上一稿有段落只在段末标了一次编号，前面陈述事实的句子没有标：\n'
    + `- ${lonely.join('\n- ')}\n这次每个陈述事实的句子都要在句末标出它自己依据的编号。\n`;
}

// ── Reading what the model wrote ────────────────────────────────────────────────────────────────

const DISPOSITION_LINE = new RegExp(
  `^${S}*[-*]?${S}*\\[?([A-Z]\\d{1,4})\\]?${S}*[|｜]${S}*(采用|舍弃|合并到${S}*\\[?([A-Z]\\d{1,4})\\]?)${S}*(?:[|｜]${S}*([^\\n]*))?$`,
  'u',
);
const STATE_LINE = new RegExp(`^${S}*现状${S}*[:：]`, 'u');
const BULLET = new RegExp(`^${S}*([-*•]|\\d+[.、])${S}*`, 'u');
const QUOTE_LINE = new RegExp(`^${S}*[-*]?${S}*[\\[【]([A-Z]\\d{1,4})[\\]】]${S}*[:：]?${S}*[「“"『]([^\\n]*)[」”"』]${S}*$`, 'u');
const QUOTES_START = new RegExp(`^${S}*\\**引文\\**${S}*[:：]${S}*$`, 'mu');
/**
 * A material marker: D, C, K and S name a section's pieces, F an overview's footnotes. Anything else in brackets is
 * the text's own ([P0], [x]) and is left as it is.
 */
const ID_MARKER = new RegExp(`[\\[【]${S}*([DCKSF]\\d{1,4}(?:${S}*[,，、]${S}*[DCKSF]\\d{1,4})*)${S}*[\\]】]`, 'gu');
const ID_MARKER_ONE = new RegExp(ID_MARKER.source, 'u');
const ID = /[DCKSF]\d{1,4}/gu;

/**
 * Read the merge's dispositions onto the pieces it was handed, and answer the state it wrote (`wikiDocApplyMerge`).
 * A piece it said nothing of is adopted; a merge into a piece that is not the section's, or into itself, is read as
 * an adoption.
 */
export function wikiDocApplyMerge(text: string, pieces: WikiDocPiece[]): string[] {
  const byId = new Map<string, WikiDocPiece>();
  for (const piece of pieces) if (piece.handed) byId.set(piece.id, piece);
  const state: string[] = [];
  let inState = false;
  const said = new Set<string>();
  for (const line of text.split('\n')) {
    if (STATE_LINE.test(line)) {
      inState = true;
      continue;
    }
    if (inState) {
      const rest = goTrimSpace(line.replace(BULLET, ''));
      if (BULLET.test(line) && rest !== '') state.push(rest);
      continue;
    }
    const m = DISPOSITION_LINE.exec(line);
    if (!m) continue;
    const piece = byId.get(m[1]);
    if (!piece || said.has(m[1])) continue;
    said.add(m[1]);
    let reason = goTrimSpace(m[4] ?? '');
    if (m[2] === '采用') {
      piece.action = 'adopt';
    } else if (m[2] === '舍弃') {
      piece.action = 'drop';
    } else if (byId.has(m[3]) && m[3] !== piece.id) {
      piece.action = 'merge';
      piece.into = m[3];
    } else {
      piece.action = 'adopt';
      reason = goTrimSpace(`（合并目标 ${m[3]} 不是本节交给模型的材料，按采用）${reason}`);
    }
    piece.reason = reason === '' ? '归并没有写理由' : reason;
  }
  for (const piece of byId.values()) {
    if (piece.action === '') {
      piece.action = 'adopt';
      piece.reason = '归并没有写这条的处置，按采用交给写作';
    }
  }
  return state;
}

/** What the model wrote: the body with its material markers, and the quotes it gave (`wikiDocDraft`). */
export interface WikiDocDraft {
  body: string;
  quotes: Map<string, string[]>;
}

/** The answer up to its quotes. */
export function wikiDocBodyOf(text: string): string {
  const at = QUOTES_START.exec(text);
  return goTrimSpace(at ? text.slice(0, at.index) : text);
}

/** Drop a first line that is a heading: the plan names the section. */
export function wikiDocStripHeading(body: string): string {
  let lines = goTrimSpace(body).split('\n');
  if (lines.length > 0 && HEADING_LINE.test(goTrimSpace(lines[0]))) lines = lines.slice(1);
  return goTrimSpace(lines.join('\n'));
}

/** `[ID] 「quote」` lines. */
export function wikiDocParseQuotes(text: string): Map<string, string[]> {
  const quotes = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = QUOTE_LINE.exec(goTrimSpace(line));
    if (m && goTrimSpace(m[2]) !== '') quotes.set(m[1], [...(quotes.get(m[1]) ?? []), goTrimSpace(m[2])]);
  }
  return quotes;
}

export function wikiDocParseWritten(text: string): WikiDocDraft {
  const draft: WikiDocDraft = { body: wikiDocStripHeading(wikiDocBodyOf(text)), quotes: new Map() };
  const at = QUOTES_START.exec(text);
  if (at) draft.quotes = wikiDocParseQuotes(text.slice(at.index + at[0].length));
  return draft;
}

/**
 * Turn every material marker outside code spans — [D1], [C2][S3], [D1, S3], 【S1】 — into footnote numbers, by
 * name (`wikiDocRewriteMarkers`): an id `name` answers null for is dropped with its marker.
 */
export function wikiDocRewriteMarkers(body: string, name: (id: string) => number | null): string {
  const segments = body.split('`');
  for (let i = 0; i < segments.length; i += 2) {
    segments[i] = segments[i].replace(ID_MARKER, (_marker: string, inner: string) => {
      let out = '';
      for (const id of inner.match(ID) ?? []) {
        const n = name(id);
        if (n !== null) out += `[${n}]`;
      }
      return out;
    });
  }
  return segments.join('`');
}

// ── Footnotes ───────────────────────────────────────────────────────────────────────────────────

/**
 * One footnote of a section as a write carries it (contract `docs.schema`): a repository original with its path,
 * sha, lines and this run's own check; or a record by its id, which the server checks. Go's wikiDocFootnote, its
 * omitempty fields left out when empty. `found` is the writer's own finding of a record's quote in the text the
 * server handed out, and is never sent.
 */
export interface WikiDocFootnote {
  kind: string;
  path?: string;
  sha?: string;
  lines?: WikiDocRange | null;
  section?: string;
  symbol?: string;
  excerpt?: string;
  verified?: boolean | null;
  ref?: string;
  chars?: WikiDocRange | null;
  quote: string | null;
  viaEntryId?: string;
  found?: boolean;
}

/**
 * A footnote as the write sends it: the contract's fields, the empty ones left out as Go's omitempty leaves them.
 * The excerpt and the quote go without any U+0000 (contract `docs.build.server.nul`): they are the lines a
 * document shows, Postgres keeps no NUL in text, and the file they come from is kept whole in the read cache.
 */
export function wikiDocFootnoteWire(footnote: WikiDocFootnote): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: footnote.kind };
  if (footnote.path) out.path = footnote.path;
  if (footnote.sha) out.sha = footnote.sha;
  if (footnote.lines) out.lines = { start: footnote.lines.start, end: footnote.lines.end };
  if (footnote.section) out.section = footnote.section;
  if (footnote.symbol) out.symbol = footnote.symbol;
  if (footnote.excerpt) out.excerpt = stripNul(footnote.excerpt);
  if (footnote.verified !== undefined && footnote.verified !== null) out.verified = footnote.verified;
  if (footnote.ref) out.ref = footnote.ref;
  if (footnote.chars) out.chars = { start: footnote.chars.start, end: footnote.chars.end };
  out.quote = footnote.quote === null ? null : stripNul(footnote.quote);
  if (footnote.viaEntryId) out.viaEntryId = footnote.viaEntryId;
  return out;
}

/** A section as this run wrote it — Markdown with [n], and its footnotes — for the overview to read. */
export interface WikiDocWrittenSection {
  markdown: string;
  footnotes: WikiDocFootnote[];
}

/** How a section's footnotes came out, for its run's report. */
export interface WikiDocFootnoteCounts {
  total: number;
  found: number;
  noQuote: number;
}

/**
 * One piece's footnote, with the first of its quotes that holds, or the first of them (`footnoteFor`): a
 * repository quote is looked for in the file at the commit (its lines the lines it is found at), a record's in
 * the text the server handed out.
 */
export function wikiDocFootnoteFor(repo: WikiDocRepo, piece: WikiDocPiece, quotes: readonly string[] | undefined): WikiDocFootnote {
  const candidates: string[] = [];
  for (const raw of quotes ?? []) {
    const quote = goTrimSpace(raw);
    if (quote !== '') candidates.push(cutRunes(quote, WIKI_DOC_RULES.quoteMaxChars));
  }
  const footnote: WikiDocFootnote = { kind: piece.kind, quote: null };
  if (piece.record?.via) footnote.viaEntryId = piece.record.via.entryId;
  if (wikiDocIsRepoKind(piece.kind)) {
    footnote.path = piece.path;
    footnote.sha = repo.sha;
    footnote.lines = { ...piece.lines };
    footnote.verified = false;
    footnote.section = piece.section;
    footnote.symbol = piece.symbol;
    footnote.excerpt = cutRunes(piece.text, WIKI_DOC_RULES.excerptMaxChars);
    const shown = repo.show(piece.path);
    for (const quote of candidates) {
      if (!shown) break;
      const found = wikiDocLocate(shown.text, quote, piece.lines);
      if (found) {
        footnote.quote = quote;
        footnote.verified = true;
        footnote.lines = found;
        footnote.excerpt = wikiDocLines(shown.text, found);
        return footnote;
      }
    }
    if (candidates.length > 0) footnote.quote = candidates[0];
    return footnote;
  }
  footnote.ref = piece.ref;
  footnote.chars = { ...piece.chars };
  const text = runesOf(piece.text);
  for (const quote of candidates) {
    if (wikiDocFind(text, quote, 0, text.length)) {
      footnote.quote = quote;
      footnote.found = true;
      return footnote;
    }
  }
  if (candidates.length > 0) footnote.quote = candidates[0];
  return footnote;
}

/**
 * The draft as the section a write carries (`footnotes`): the markers numbered by first appearance, each footnote
 * the piece it names with the first of its quotes that holds.
 */
export function wikiDocFootnotes(repo: WikiDocRepo, draft: WikiDocDraft, used: readonly WikiDocPiece[]): { section: WikiDocWrittenSection; counts: WikiDocFootnoteCounts } {
  const byId = new Map(used.map((piece) => [piece.id, piece]));
  // A list even when empty: a section with no footnote sends [] (docs.schemaNote), never null.
  const footnotes: WikiDocFootnote[] = [];
  const numberOf = new Map<string, number>();
  const markdown = wikiDocRewriteMarkers(draft.body, (id) => {
    const piece = byId.get(id);
    if (!piece) return null;
    const n = numberOf.get(id);
    if (n !== undefined) return n;
    if (footnotes.length >= WIKI_DOC_RULES.footnotesPerSection) return null;
    footnotes.push(wikiDocFootnoteFor(repo, piece, draft.quotes.get(id)));
    numberOf.set(id, footnotes.length);
    return footnotes.length;
  });
  const counts: WikiDocFootnoteCounts = { total: footnotes.length, found: 0, noQuote: 0 };
  for (const footnote of footnotes) {
    if (footnote.quote === null) counts.noQuote += 1;
    else if (footnote.verified === true) counts.found += 1;
    else if ((footnote.verified === undefined || footnote.verified === null) && footnote.found) counts.found += 1;
  }
  return { section: { markdown: cutRunes(markdown, WIKI_DOC_RULES.markdownMaxChars), footnotes }, counts };
}

/** The ids the body cites whose footnote has no quote that holds (`wikiDocUnfoundCitations`). */
export function wikiDocUnfoundCitations(draft: WikiDocDraft, section: WikiDocWrittenSection, used: readonly WikiDocPiece[]): string[] {
  const byId = new Set(used.map((piece) => piece.id));
  const cited: string[] = [];
  const seen = new Set<string>();
  wikiDocRewriteMarkers(draft.body, (id) => {
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      cited.push(id);
    }
    return null;
  });
  const out: string[] = [];
  for (const [k, id] of cited.entries()) {
    if (k >= section.footnotes.length) break;
    const footnote = section.footnotes[k];
    const holds = footnote.quote !== null
      && (footnote.verified === true || ((footnote.verified === undefined || footnote.verified === null) && footnote.found === true));
    if (!holds) out.push(id);
  }
  return out;
}

/** The body's sentences that carry id. */
export function wikiDocSentencesCiting(body: string, id: string): string[] {
  const marker = new RegExp(`[\\[【][^\\]】]*\\b${quoteMeta(id)}\\b[^\\]】]*[\\]】]`, 'u');
  const out: string[] = [];
  for (const line of body.split('\n')) {
    for (const sentence of wikiDocSentences(goTrimSpace(line))) {
      if (marker.test(sentence)) out.push(`- ${goTrimSpace(sentence)}`);
    }
  }
  return out.slice(0, 5);
}

/**
 * The paragraphs that mark only their last sentence while an earlier one states a fact (it carries a fact token):
 * each shown by its first sentence.
 */
export function wikiDocEndOnlyParagraphs(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(new RegExp(`\\n${S}*\\n`, 'u'))) {
    const paragraph = goTrimSpace(raw);
    if (paragraph === '' || paragraph.startsWith('#') || paragraph.startsWith('```')) continue;
    const sentences = wikiDocSentences(collapseWhitespace(paragraph.split('\n').join(' ')));
    if (sentences.length < 2) continue;
    const marked = (sentence: string): boolean => ID_MARKER_ONE.test(sentence);
    if (!marked(sentences[sentences.length - 1])) continue;
    for (const sentence of sentences.slice(0, -1)) {
      if (!marked(sentence) && wikiDocFactTokens(sentence).length > 0) {
        out.push(cutRunes(goTrimSpace(sentences[0]), 80));
        break;
      }
    }
  }
  return out;
}

const FACT_TOKEN = new RegExp(
  `\`[^\`]+\`|\\b[A-Za-z_][A-Za-z0-9_./-]*[A-Za-z0-9_]\\b|\\d{2,}|\\d+(?:\\.\\d+)?${S}*(?:秒|分钟|小时|天|个|条|次|%|ms|s|MB|KB)`,
  'gu',
);
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'not', 'are', 'can', 'its', 'but', 'via']);

/** A sentence's fact tokens (contract `docs.factTokens`), markers aside — Go's list, repeats and all. */
export function wikiDocFactTokens(sentence: string): string[] {
  const out: string[] = [];
  for (const match of sentence.replace(ID_MARKER, '').matchAll(FACT_TOKEN)) {
    const code = match[0].startsWith('`');
    const token = collapseWhitespace(trimBackticks(match[0])).split(' ').join('').toLowerCase();
    if (token === '') continue;
    if (!code && /^[a-z_]/u.test(token) && (Buffer.byteLength(token, 'utf8') < 3 || STOP_WORDS.has(token))) continue;
    out.push(token);
  }
  return out;
}

/** The section's material ledger as the write carries it (contract `docs.dispositions`). */
export function wikiDocDispositions(pieces: readonly WikiDocPiece[]): Array<{ material: string; kind: string; ref: string; action: string; into: string | null; reason: string }> {
  const out: Array<{ material: string; kind: string; ref: string; action: string; into: string | null; reason: string }> = [];
  for (const piece of pieces) {
    if (out.length === WIKI_DOC_RULES.dispositionsPerSection) break;
    const reason = cutRunes(goTrimSpace(piece.reason), WIKI_DOC_RULES.reasonMaxChars);
    out.push({
      material: piece.id,
      kind: piece.kind,
      ref: cutRunes(wikiDocDispositionRef(piece), 1000),
      action: piece.action,
      into: piece.action === 'merge' ? piece.into : null,
      reason: reason === '' ? '（没有理由）' : reason,
    });
  }
  return out;
}

/** What became of a section's material, as its line says it: `3 adopt, 1 merge`. */
export function wikiDocActionLine(actions: Readonly<Record<string, number>>): string {
  return DISPOSITION_ACTIONS.filter((action) => (actions[action] ?? 0) > 0).map((action) => `${actions[action]} ${action}`).join(', ');
}

// ── The overview ────────────────────────────────────────────────────────────────────────────────

/** `GET …/docs/:slug` as far as an overview reads it: the sentences and their footnotes. */
export interface WikiDocViewForOverview {
  sections: Array<{
    key: string;
    written: boolean;
    blocks: Array<{ kind: string; text?: string | null; sentences?: Array<{ text: string; notes: number[] }> }>;
  }>;
  footnotes: Array<{
    n: number;
    kind: string;
    quote: string | null;
    path: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    section: string | null;
    symbol: string | null;
    recordId: string | null;
    charStart: number | null;
    charEnd: number | null;
    viaEntryId: string | null;
  }>;
}

const ARTICLE_MARKER = /\[(\d{1,3})\]/gu;

/**
 * What the overview is written from (`wikiDocOverviewMaterial`): each other section's text with its footnotes as
 * [F<n>], numbered across the document, the same original and quote once.
 */
export function wikiDocOverviewMaterial(
  doc: WikiDocsPlanDoc,
  index: number,
  written: ReadonlyArray<WikiDocWrittenSection | null>,
  view: WikiDocViewForOverview | null,
): { sections: string[]; notes: WikiDocOverviewNote[] } {
  const sections: string[] = [];
  const notes: WikiDocOverviewNote[] = [];
  const seen = new Map<string, string>();
  const name = (footnote: WikiDocFootnote): string => {
    const key = JSON.stringify([footnote.kind, footnote.path ?? '', footnote.lines ?? null, footnote.ref ?? '', footnote.chars ?? null, footnote.quote]);
    const known = seen.get(key);
    if (known !== undefined) return known;
    const id = `F${notes.length + 1}`;
    seen.set(key, id);
    notes.push({ id, footnote });
    return id;
  };
  const stored = new Map<string, number>();
  view?.sections.forEach((section, i) => stored.set(section.key, i));
  doc.sections.forEach((section, i) => {
    if (i === index || section.kind === 'overview') return;
    let text = '';
    const mine = written[i];
    if (mine) {
      text = mine.markdown.replace(ARTICLE_MARKER, (_marker: string, digits: string) => {
        const n = Number(digits);
        if (n < 1 || n > mine.footnotes.length) return '';
        return `[${name(mine.footnotes[n - 1])}]`;
      });
    } else if (view && stored.has(section.key) && view.sections[stored.get(section.key)!].written) {
      const byN = new Map<number, WikiDocFootnote>();
      for (const footnote of view.footnotes) byN.set(footnote.n, wikiDocFootnoteFromView(footnote));
      let b = '';
      for (const one of view.sections[stored.get(section.key)!].blocks) {
        if (one.text !== undefined && one.text !== null && one.kind === 'heading') {
          b += `#### ${one.text}\n`;
          continue;
        }
        if (one.kind === 'code') continue;
        for (const sentence of one.sentences ?? []) {
          b += sentence.text;
          for (const n of sentence.notes) {
            const footnote = byN.get(n);
            if (footnote) b += `[${name(footnote)}]`;
          }
        }
        b += '\n\n';
      }
      text = goTrimSpace(b);
    }
    if (goTrimSpace(text) === '') return;
    sections.push(`【第 ${i + 1} 节 ${section.title}】\n${text}`);
  });
  return { sections, notes };
}

/** A stored footnote as a write carries it again (`wikiDocFootnoteFromView`). */
export function wikiDocFootnoteFromView(view: WikiDocViewForOverview['footnotes'][number]): WikiDocFootnote {
  const footnote: WikiDocFootnote = { kind: view.kind, quote: view.quote };
  if (view.viaEntryId) footnote.viaEntryId = view.viaEntryId;
  if (view.path !== null) {
    footnote.path = view.path;
    footnote.section = view.section ?? '';
    footnote.symbol = view.symbol ?? '';
    if (view.lineStart !== null && view.lineEnd !== null) footnote.lines = { start: view.lineStart, end: view.lineEnd };
    return footnote;
  }
  footnote.ref = view.recordId ?? '';
  if (view.charStart !== null && view.charEnd !== null) footnote.chars = { start: view.charStart, end: view.charEnd };
  return footnote;
}

/**
 * Look a repository footnote's quote up again at this run's commit (`recheckRepoFootnote`): the lines it is found at
 * now, or the lines it named, not found.
 */
export function wikiDocRecheckRepoFootnote(repo: WikiDocRepo, original: WikiDocFootnote): WikiDocFootnote {
  const footnote: WikiDocFootnote = { ...original, sha: repo.sha, verified: false };
  const shown = repo.show(footnote.path ?? '');
  if (!shown || footnote.quote === null) {
    if (!footnote.lines) footnote.lines = { start: 1, end: 1 };
    return footnote;
  }
  const found = wikiDocLocate(shown.text, footnote.quote, footnote.lines ?? null);
  if (found) {
    footnote.verified = true;
    footnote.lines = found;
    footnote.excerpt = wikiDocLines(shown.text, found);
  }
  if (!footnote.lines) footnote.lines = { start: 1, end: 1 };
  return footnote;
}

/**
 * The overview's [F<n>] as its own [n] (`overviewFootnotes`), each footnote the cited one as it stands — a
 * repository quote looked for again at this run's commit.
 */
export function wikiDocOverviewFootnotes(repo: WikiDocRepo, body: string, notes: readonly WikiDocOverviewNote[]): { markdown: string; footnotes: WikiDocFootnote[] } {
  const byId = new Map(notes.map((note) => [note.id, note.footnote]));
  const footnotes: WikiDocFootnote[] = [];
  const numberOf = new Map<string, number>();
  const markdown = wikiDocRewriteMarkers(body, (id) => {
    const cited = byId.get(id);
    if (!cited) return null;
    const n = numberOf.get(id);
    if (n !== undefined) return n;
    footnotes.push(wikiDocIsRepoKind(cited.kind) ? wikiDocRecheckRepoFootnote(repo, cited) : { ...cited });
    numberOf.set(id, footnotes.length);
    return footnotes.length;
  });
  return { markdown, footnotes };
}

// ── Sentences ───────────────────────────────────────────────────────────────────────────────────

/**
 * A line cut at 。！？, and at a full stop or an ASCII ? or ! followed by a space or the line's end, each sentence
 * keeping its markers — `wikiArticleSentences` (src/runner-go/wiki_articles.go), which the build reads by.
 */
export function wikiDocSentences(line: string): string[] {
  const out: string[] = [];
  const runes = runesOf(line);
  let current = '';
  let inCode = false;
  for (let i = 0; i < runes.length; i += 1) {
    const ch = runes[i];
    current += ch;
    if (ch === '`') {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const atBreak = i + 1 === runes.length || isGoSpace(runes[i + 1]);
    // An ASCII ? or ! after a space or another ? or ! is code left outside backticks (a ?? b).
    const ascii = (ch === '?' || ch === '!') && atBreak && i > 0 && !isGoSpace(runes[i - 1]) && runes[i - 1] !== '?' && runes[i - 1] !== '!';
    const ends = '。！？'.includes(ch) || (ch === '.' && atBreak) || ascii;
    if (!ends) continue;
    let j = i + 1;
    while (j < runes.length) {
      if ('」』"”’）)'.includes(runes[j])) {
        current += runes[j];
        j += 1;
        continue;
      }
      const lead = leadMarkerLength(runes, j);
      if (lead > 0) {
        current += runes.slice(j, j + lead).join('');
        j += lead;
        continue;
      }
      break;
    }
    out.push(current);
    current = '';
    i = j - 1;
  }
  if (goTrimSpace(current) !== '') out.push(current);
  return out;
}

/** How many runes from j `^\s*\[\d{1,3}\]` matches (RE2's \s), or 0. */
function leadMarkerLength(runes: readonly string[], j: number): number {
  let k = j;
  while (k < runes.length && ' \t\n\f\r'.includes(runes[k])) k += 1;
  if (runes[k] !== '[') return 0;
  let digits = 0;
  while (digits < 3 && k + 1 + digits < runes.length && /^[0-9]$/u.test(runes[k + 1 + digits])) digits += 1;
  if (digits === 0 || runes[k + 1 + digits] !== ']') return 0;
  return k + 2 + digits - j;
}
