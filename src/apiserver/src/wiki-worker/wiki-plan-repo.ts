import { WIKI_PLAN_SERVER_JOB } from '@orbit/shared';
import { goTrimSpace } from './wiki-import-extract';
import { goCompare, goFieldsFunc, goTrim } from './wiki-plan-format';

/**
 * What the drafting job reads of the repository, and how it checks what the plan says of it (contract
 * `plan.jobs.server`, design §4.3) — ported from `src/runner-go/wiki_plan_repo.go`, which reads the same off a
 * checkout on the runner until P10 removes it.
 *
 * THE SNAPSHOT, NOT A CHECKOUT. The server holds no repository: the space's runner indexes origin/main once a
 * commit (`repoOps` snapshot — every path with its size, every document's headings, every source file's symbols,
 * the contracts' top-level keys) and the job reads that. Everything the runner's job read of the tree is read here
 * from the same index at the same sha, so the materials the model drafts from and the references the gate checks
 * are one tree, and the sha goes into the draft's repoCheck.
 *
 * WHAT THE INDEX DOES NOT CARRY is text: the overview's documents, schema.prisma's models, and — for the one
 * check that reads a file — the text of a file a symbol is looked for in when its index does not name it. Those
 * are read at the same sha through the runner's `read` operation, at most `repoOps.read.sectionChars` characters a
 * file, and handed to this class (`withTexts`). That limit is the one place the two paths can differ: a symbol
 * whose every part a file spells only past its first 22,000 characters is found on the runner and not here.
 *
 * A REFERENCE IS FOUND OR IT IS NOT. A file is a path of the tree (or a directory, or a glob that matches one); a
 * docs section is one of that document's headings; a symbol is one of that file's indexed declarations — or,
 * since the index is regex-level, an identifier every part of which that file spells as a word.
 */

/** The snapshot index (`repoOps` snapshot, wiki_repo_ops.go `wikiRepoOpIndex`): the fields the plan reads. */
export interface WikiPlanSnapshotIndex {
  sha: string;
  date: string;
  files: Array<{ path: string; size: number }>;
  docs: Array<{ path: string; title: string; headings: Array<{ level: number; text: string }> | null }>;
  symbols: Record<string, string[] | null> | null;
  contracts: Array<{ path: string; size: number; keys?: string[] | null }> | null;
}

export interface WikiPlanHeading {
  level: number;
  text: string;
}

/** The plan's character caps of the repository's materials, the runner's numbers (wiki_plan_prompts.go). */
export const WIKI_PLAN_MATERIAL_CAPS = WIKI_PLAN_SERVER_JOB.materialCaps;

/** The overview's documents, in the order the runner reads them, and the README they fall back to. */
export const WIKI_PLAN_OVERVIEW_DOCS = ['docs/README.md', 'docs/architecture.md'] as const;
export const WIKI_PLAN_OVERVIEW_FALLBACK = 'README.md';

/** A test, a fixture or a snapshot: not what a document explains. */
const TEST_FILE = /(\.spec\.tsx?|\.test\.tsx?|_test\.go|\.fixture\.json|\.snap)$|\/Tests\/|\/test-support\/|\/__tests__\/|\/testdata\//u;

/** The docs a plan does not draft from: the mockups and the evidence bundles. */
const EXCLUDED_DOCS = ['docs/mocks/', 'docs/evidence/'];

/** Go's path.Ext: the suffix from the final dot of the final element, or ''. */
export function goExt(file: string): string {
  for (let i = file.length - 1; i >= 0 && file[i] !== '/'; i -= 1) {
    if (file[i] === '.') return file.slice(i);
  }
  return '';
}

/** Go's path.Base and path.Dir for the clean relative paths of a tree. */
export function goBase(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? file : file.slice(i + 1);
}

export function goDir(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : file.slice(0, i);
}

export function wikiPlanIsSource(file: string): boolean {
  if (TEST_FILE.test(file) || file.includes('node_modules/')) return false;
  return ['.go', '.ts', '.tsx', '.swift'].includes(goExt(file));
}

export function wikiPlanIsDoc(file: string): boolean {
  if (!file.toLowerCase().endsWith('.md') || file.includes('node_modules/')) return false;
  return !EXCLUDED_DOCS.some((prefix) => file.startsWith(prefix));
}

/** The files the runner's index read the text of (docs, sources, contracts): the ones a symbol is looked for in. */
export function wikiPlanHasText(file: string): boolean {
  return wikiPlanIsDoc(file) || wikiPlanIsSource(file) || file.startsWith('contracts/');
}

/** A directory under src/ (or the root) whose files make one program. */
function packageOf(file: string): string {
  const parts = file.split('/');
  if (parts.length >= 3 && parts[0] === 'src') return `${parts[0]}/${parts[1]}`;
  if (parts.length >= 2) return parts[0];
  return '.';
}

const ENTRY_NAMES = new Set([
  'main.go', 'main.ts', 'main.tsx', 'App.tsx', 'app.module.ts', 'index.ts', 'package.json', 'Package.swift', 'project.yml',
  'schema.prisma', 'go.mod',
]);

/** A text cut to maxChars characters, saying so. */
export function wikiPlanCut(text: string, maxChars: number): string {
  if (maxChars <= 0) return text;
  const runes = [...text];
  if (runes.length <= maxChars) return text;
  return `${runes.slice(0, maxChars).join('')}\n…（后略）\n`;
}

/** The first twelve characters of a sha, as the runner's messages name a commit. */
export function shortWikiHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

const PRISMA_MODEL = /^model (\w+) \{/gmu;

/** origin/main of the space's repository, as its snapshot indexes it. */
export class WikiPlanRepo {
  readonly sha: string;
  readonly date: string;
  /** Every blob of the tree, in Go's byte order. */
  readonly files: string[];
  private readonly fileSet: Set<string>;
  private readonly dirs = new Set<string>();
  private readonly sizes = new Map<string, number>();
  /** Every document's headings, for the documents that have any (a heading-less document reads as none, as on the runner). */
  private readonly headings = new Map<string, WikiPlanHeading[]>();
  private readonly symbols = new Map<string, string[]>();
  private readonly contractKeys = new Map<string, string[]>();
  /** What was read of files the index carries no text of: the overview, schema.prisma, and the gate's look into a file. */
  private readonly texts = new Map<string, string>();

  constructor(index: WikiPlanSnapshotIndex) {
    this.sha = index.sha;
    this.date = index.date ?? '';
    this.files = (index.files ?? []).map((file) => file.path).sort(goCompare);
    this.fileSet = new Set(this.files);
    for (const file of index.files ?? []) {
      this.sizes.set(file.path, file.size);
      for (let dir = goDir(file.path); dir !== '.' && dir !== '/'; dir = goDir(dir)) this.dirs.add(dir);
    }
    for (const doc of index.docs ?? []) {
      const headings = (doc.headings ?? []).map((h) => ({ level: h.level, text: h.text }));
      if (headings.length > 0) this.headings.set(doc.path, headings);
    }
    for (const [file, symbols] of Object.entries(index.symbols ?? {})) {
      if (symbols && symbols.length > 0) this.symbols.set(file, [...symbols]);
    }
    for (const contract of index.contracts ?? []) {
      if (contract.keys && contract.keys.length > 0) this.contractKeys.set(contract.path, [...contract.keys]);
    }
  }

  /** Texts read at this sha, by path. */
  withTexts(texts: ReadonlyMap<string, string> | Record<string, string>): this {
    const entries = texts instanceof Map ? [...texts.entries()] : Object.entries(texts);
    for (const [file, text] of entries) this.texts.set(file, text);
    return this;
  }

  hasFile(file: string): boolean {
    return this.fileSet.has(file);
  }

  hasHeadings(file: string): boolean {
    return this.headings.has(file);
  }

  /** The text read of a file, or '' when none was. */
  textOf(file: string): string {
    return this.texts.get(file) ?? '';
  }

  hasTextOf(file: string): boolean {
    return this.texts.has(file);
  }

  sizeOf(file: string): number {
    return this.sizes.get(file) ?? 0;
  }

  // ── The materials ───────────────────────────────────────────────────────────────────────────────

  /**
   * The repository's structure: its top level, each package with its entry points, and each directory with its
   * source files — tests and fixtures left out (the sample's repo.md, for any repository).
   */
  layoutText(maxChars: number): string {
    let b = `# 仓库结构（origin/main ${shortWikiHash(this.sha)}，提交时间 ${this.date}）\n\n只列源文件（去掉测试与夹具），路径相对仓库根。\n\n## 顶层\n\n`;
    const top = new Map<string, number>();
    const topFiles: string[] = [];
    for (const file of this.files) {
      const i = file.indexOf('/');
      if (i > 0) top.set(file.slice(0, i), (top.get(file.slice(0, i)) ?? 0) + 1);
      else topFiles.push(file);
    }
    for (const name of [...top.keys()].sort(goCompare)) b += `- \`${name}/\`（${top.get(name)} 个文件）\n`;
    if (topFiles.length > 0) b += `- 顶层文件：${topFiles.join(', ')}\n`;
    const packages = new Map<string, string[]>();
    const entries = new Map<string, string[]>();
    for (const file of this.files) {
      const pkg = packageOf(file);
      const inside = file.startsWith(`${pkg}/`) ? file.slice(pkg.length + 1) : file;
      if (ENTRY_NAMES.has(goBase(file)) && !file.includes('node_modules/') && inside.split('/').length - 1 <= 2) {
        entries.set(pkg, [...(entries.get(pkg) ?? []), file]);
      }
      if (wikiPlanIsSource(file)) packages.set(pkg, [...(packages.get(pkg) ?? []), file]);
    }
    const pkgs = [...packages.keys()].sort(goCompare);
    b += '\n## 各包与入口\n\n';
    for (const pkg of pkgs) {
      let line = `- \`${pkg}\`（${packages.get(pkg)!.length} 个源文件）`;
      if ((entries.get(pkg) ?? []).length > 0) line += `；入口与装配：${entries.get(pkg)!.join('、')}`;
      b += `${line}\n`;
    }
    b += '\n## 各目录的源文件\n';
    for (const pkg of pkgs) {
      b += `\n### ${pkg}\n`;
      const byDir = new Map<string, string[]>();
      for (const file of packages.get(pkg)!) byDir.set(goDir(file), [...(byDir.get(goDir(file)) ?? []), goBase(file)]);
      for (const dir of [...byDir.keys()].sort(goCompare)) {
        const files = byDir.get(dir)!;
        if (files.length <= 40) {
          b += `- ${dir}/（${files.length}）: ${files.join(', ')}\n`;
          continue;
        }
        // A flat directory of many files, as a Go package is: grouped by the prefix of their names.
        const groups = new Map<string, string[]>();
        for (const file of files) {
          const ext = goExt(file);
          const key = goFieldsFunc(ext === '' ? file : file.slice(0, file.length - ext.length), (c) => c === '_' || c === '-' || c === '.');
          const prefix = key.length > 0 ? key[0] : file;
          groups.set(prefix, [...(groups.get(prefix) ?? []), file]);
        }
        const prefixes = [...groups.keys()].sort((x, y) => groups.get(y)!.length - groups.get(x)!.length || goCompare(x, y));
        b += `- ${dir}/（${files.length}，按文件名前缀）:\n`;
        for (const prefix of prefixes) b += `  - ${prefix}: ${groups.get(prefix)!.join(', ')}\n`;
      }
    }
    for (const file of this.files) {
      if (goBase(file) !== 'schema.prisma') continue;
      const names = [...this.textOf(file).matchAll(PRISMA_MODEL)].map((m) => m[1]);
      if (names.length > 0) b += `\n## 数据模型（${file}）\n\n模型 ${names.length} 个：${names.join(', ')}\n`;
    }
    return wikiPlanCut(b, maxChars);
  }

  /** The documents a plan drafts from: docs/ (less the mockups and evidence) first, then every other Markdown file. */
  docFiles(): string[] {
    const docs: string[] = [];
    const others: string[] = [];
    for (const file of this.files) {
      if (!wikiPlanIsDoc(file)) continue;
      (file.startsWith('docs/') ? docs : others).push(file);
    }
    return [...docs, ...others];
  }

  /** Every document with its title and its second- and third-level headings (docs-tree.md). */
  docsTreeText(maxChars: number): string {
    let b = `# 文档标题树（origin/main ${shortWikiHash(this.sha)}）\n\n范围：docs/ 下的设计、契约与运维文档（不含 docs/mocks、docs/evidence），以及仓库里其他说明文件。`
      + '每篇列出 H1 标题与二、三级标题；[大小] 是字节数。\n\n';
    for (const file of this.docFiles()) b += this.docBlock(file, 3);
    return wikiPlanCut(b, maxChars);
  }

  /** One document's heading tree, to depth. */
  docBlock(file: string, depth: number): string {
    const headings = this.headings.get(file) ?? [];
    const h1 = headings.find((h) => h.level === 1)?.text ?? '';
    let b = `### ${file} [${this.sizeOf(file)}]${h1 !== '' ? ` — ${h1}` : ''}\n`;
    for (const h of headings) {
      if (h.level === 1 && h.text === h1) continue;
      if (h.level >= 2 && h.level <= depth) b += `${'  '.repeat(h.level - 2)}- ${h.text}\n`;
    }
    return `${b}\n`;
  }

  /** One line a document: its path, size and title. */
  docIndexText(): string {
    let b = '';
    for (const file of this.docFiles()) {
      const h1 = (this.headings.get(file) ?? []).find((h) => h.level === 1)?.text;
      b += `- ${file} [${this.sizeOf(file)}]${h1 !== undefined ? ` — ${h1}` : ''}\n`;
    }
    return b;
  }

  /**
   * The contracts/ inventory: each file with its top-level keys (contracts.md). The index carries an object's keys
   * only, so a contract whose JSON is an array — or an empty object — reads as the runner reads a file that is not
   * JSON at all.
   */
  contractsText(): string {
    let b = `# contracts/ 清单（origin/main ${shortWikiHash(this.sha)}）\n\n`;
    let n = 0;
    for (const file of this.files) {
      if (!file.startsWith('contracts/')) continue;
      n += 1;
      let desc = '（非 JSON）';
      const keys = this.contractKeys.get(file);
      if (keys) desc = `顶层键：${(keys.length > 14 ? [...keys.slice(0, 14), '…'] : keys).join(', ')}`;
      b += `- \`${file}\` [${this.sizeOf(file)}] ${desc}\n`;
    }
    if (n === 0) b += '（这个仓库没有 contracts/）\n';
    return b;
  }

  /** What tells the model what the repository is: docs/README.md and docs/architecture.md when it has them, else its README. */
  overviewText(maxChars: number): string {
    const parts: string[] = [];
    for (const file of this.overviewFiles()) parts.push(`<${file} 全文>\n${goTrimSpace(this.textOf(file))}\n</${file}>`);
    return wikiPlanCut(parts.join('\n\n'), maxChars);
  }

  /** The files the overview is made of, in its order: what the job reads at the sha before it drafts. */
  overviewFiles(): string[] {
    const files = WIKI_PLAN_OVERVIEW_DOCS.filter((file) => this.fileSet.has(file));
    if (files.length === 0 && this.fileSet.has(WIKI_PLAN_OVERVIEW_FALLBACK)) return [WIKI_PLAN_OVERVIEW_FALLBACK];
    return files;
  }

  /** The schema.prisma files whose models the layout lists. */
  schemaFiles(): string[] {
    return this.files.filter((file) => goBase(file) === 'schema.prisma');
  }

  /** The source files a list of paths, directories or globs names. */
  codeFiles(patterns: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of patterns) {
      const pattern = goTrim(goTrimSpace(raw), '`');
      if (pattern === '') continue;
      for (const file of this.files) {
        if (seen.has(file) || !this.symbols.has(file)) continue;
        if (wikiPlanPathMatches(pattern, file)) {
          seen.add(file);
          out.push(file);
        }
      }
    }
    return out.sort(goCompare);
  }

  /** The symbols of the files the patterns name, one file a line, within maxChars bytes (as the runner's builder counts). */
  codeExcerpt(patterns: readonly string[], maxChars: number): string {
    const files = this.codeFiles(patterns);
    let b = '';
    let bytes = 0;
    for (const [i, file] of files.entries()) {
      const symbols = this.symbols.get(file)!.slice(0, 36);
      const line = `${file}: ${symbols.join(', ')}\n`;
      const size = Buffer.byteLength(line, 'utf8');
      if (bytes + size > maxChars) {
        b += `…（另有 ${files.length - i} 个文件略去）\n`;
        break;
      }
      b += line;
      bytes += size;
    }
    return b === '' ? '（没有匹配到带符号的源文件）\n' : b;
  }

  // ── The references ──────────────────────────────────────────────────────────────────────────────

  /** Whether a path names anything at the sha: a file, a directory, or what a glob matches. */
  hasPath(raw: string): boolean {
    const pattern = trimDotSlash(goTrim(goTrimSpace(raw), '`'));
    if (pattern === '') return false;
    if (this.fileSet.has(pattern) || this.dirs.has(pattern.endsWith('/') ? pattern.slice(0, -1) : pattern)) return true;
    if (!/[*?[]/u.test(pattern)) return false;
    return this.files.some((file) => wikiPlanPathMatches(pattern, file));
  }

  /** Whether a document of the sha has a heading that reads as section. */
  hasDocSection(file: string, section: string): boolean {
    return wikiPlanFindSection(this.headings.get(trimDotSlash(goTrimSpace(file))) ?? [], section);
  }

  /**
   * Whether a file — or a file under a directory, or one a glob matches — declares the symbol at the sha: in the
   * index, or failing that, with every part of its name a word of what was read of that file.
   */
  hasSymbol(where: string, symbol: string): boolean {
    const key = wikiPlanSymbolKey(symbol);
    if (key === '') return false;
    const parts = key.match(IDENTIFIERS) ?? [];
    if (parts.length === 0) return false;
    for (const file of this.filesUnder(where)) {
      if ((this.symbols.get(file) ?? []).some((indexed) => wikiPlanSymbolKey(indexed) === key)) return true;
      const text = this.textOf(file);
      if (text === '') continue;
      if (parts.every((part) => wordIn(text, part))) return true;
    }
    return false;
  }

  /**
   * The files hasSymbol would read the text of to settle this symbol: those under `where` whose index does not
   * name it and whose text was not read yet. What the job reads at the sha before it gates a round.
   */
  textsWantedFor(where: string, symbol: string): string[] {
    const key = wikiPlanSymbolKey(symbol);
    if (key === '' || (key.match(IDENTIFIERS) ?? []).length === 0) return [];
    const wanted: string[] = [];
    for (const file of this.filesUnder(where)) {
      if ((this.symbols.get(file) ?? []).some((indexed) => wikiPlanSymbolKey(indexed) === key)) return [];
      if (wikiPlanHasText(file) && !this.texts.has(file)) wanted.push(file);
    }
    return wanted;
  }

  /** The source files a path, a directory or a glob names (a path the tree has, whatever it is). */
  filesUnder(where: string): string[] {
    const pattern = trimDotSlash(goTrim(goTrimSpace(where), '`'));
    if (this.fileSet.has(pattern)) return [pattern];
    return this.files.filter((file) => wikiPlanIsSource(file) && wikiPlanPathMatches(pattern, file));
  }

  /** What a file declares, as the gate offers it to a model that named one it does not have. */
  symbolsOf(where: string, max: number): string[] {
    const out: string[] = [];
    for (const file of this.filesUnder(where)) {
      for (const symbol of this.symbols.get(file) ?? []) {
        out.push(symbol);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  /** A document's headings, as the gate offers them to a model that named one it does not have. */
  headingsOf(file: string, max: number): string[] {
    const out: string[] = [];
    for (const h of this.headings.get(trimDotSlash(goTrimSpace(file))) ?? []) {
      if (h.level >= 2) out.push(h.text);
      if (out.length >= max) break;
    }
    return out;
  }
}

function trimDotSlash(text: string): string {
  return text.startsWith('./') ? text.slice(2) : text;
}

const IDENTIFIERS = /[A-Za-z_$][A-Za-z0-9_$]*/gu;

/** Whether text spells part as a whole word: neither neighbour a letter, a digit, `_` or `$`. */
function wordIn(text: string, part: string): boolean {
  const escaped = part.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`, 'u').test(text);
}

/** A file named by a path, a directory (with or without its slash) or a glob. */
export function wikiPlanPathMatches(input: string, file: string): boolean {
  const pattern = trimDotSlash(input);
  if (/[*?[]/u.test(pattern)) {
    if (goPathMatch(pattern, file)) return true;
    // `dir/**/x.ts` and `dir/**`: any depth.
    const i = pattern.indexOf('**');
    if (i >= 0) {
      const prefix = pattern.slice(0, i);
      let rest = pattern.slice(i + 2);
      if (rest.startsWith('/')) rest = rest.slice(1);
      if (!file.startsWith(prefix)) return false;
      if (rest === '') return true;
      let tail = file.slice(prefix.length);
      for (;;) {
        if (goPathMatch(rest, tail)) return true;
        const j = tail.indexOf('/');
        if (j < 0) return false;
        tail = tail.slice(j + 1);
      }
    }
    return false;
  }
  const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return file === pattern || file.startsWith(`${dir}/`);
}

// ── Go's path.Match, over characters ────────────────────────────────────────────────────────────────

class BadPattern extends Error {}

/** Go's path.Match: shell patterns over a slash-separated name; a malformed pattern matches nothing. */
export function goPathMatch(pattern: string, name: string): boolean {
  try {
    return matchPattern([...pattern], [...name]);
  } catch (error) {
    if (error instanceof BadPattern) return false;
    throw error;
  }
}

function matchPattern(input: string[], target: string[]): boolean {
  let pattern = input;
  let name = target;
  outer: while (pattern.length > 0) {
    const scanned = scanChunk(pattern);
    const { star, chunk } = scanned;
    pattern = scanned.rest;
    if (star && chunk.length === 0) return !name.includes('/');
    const here = matchChunk(chunk, name);
    if (here !== null && (here.length === 0 || pattern.length > 0)) {
      name = here;
      continue;
    }
    if (star) {
      for (let i = 0; i < name.length && name[i] !== '/'; i += 1) {
        const t = matchChunk(chunk, name.slice(i + 1));
        if (t !== null) {
          if (pattern.length === 0 && t.length > 0) continue;
          name = t;
          continue outer;
        }
      }
    }
    // Before answering no, the rest of the pattern must be well formed.
    while (pattern.length > 0) {
      const next = scanChunk(pattern);
      pattern = next.rest;
      matchChunk(next.chunk, []);
    }
    return false;
  }
  return name.length === 0;
}

function scanChunk(input: string[]): { star: boolean; chunk: string[]; rest: string[] } {
  let pattern = input;
  let star = false;
  while (pattern.length > 0 && pattern[0] === '*') {
    pattern = pattern.slice(1);
    star = true;
  }
  let inRange = false;
  let i = 0;
  scan: for (; i < pattern.length; i += 1) {
    switch (pattern[i]) {
      case '\\':
        if (i + 1 < pattern.length) i += 1;
        break;
      case '[':
        inRange = true;
        break;
      case ']':
        inRange = false;
        break;
      case '*':
        if (!inRange) break scan;
        break;
      default:
    }
  }
  return { star, chunk: pattern.slice(0, i), rest: pattern.slice(i) };
}

/** What is left of `s` after `chunk` matched its start, or null; throws BadPattern for a malformed chunk. */
function matchChunk(input: string[], target: string[]): string[] | null {
  let chunk = input;
  let s = target;
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;
    switch (chunk[0]) {
      case '[': {
        let r = '';
        if (!failed) {
          r = s[0];
          s = s.slice(1);
        }
        chunk = chunk.slice(1);
        let negated = false;
        if (chunk.length > 0 && chunk[0] === '^') {
          negated = true;
          chunk = chunk.slice(1);
        }
        let match = false;
        let ranges = 0;
        for (;;) {
          if (chunk.length > 0 && chunk[0] === ']' && ranges > 0) {
            chunk = chunk.slice(1);
            break;
          }
          const lo = getEsc(chunk);
          chunk = lo.rest;
          let hi = lo.rune;
          if (chunk[0] === '-') {
            const upper = getEsc(chunk.slice(1));
            chunk = upper.rest;
            hi = upper.rune;
          }
          if (!failed && lo.rune.codePointAt(0)! <= r.codePointAt(0)! && r.codePointAt(0)! <= hi.codePointAt(0)!) match = true;
          ranges += 1;
        }
        if (match === negated) failed = true;
        break;
      }
      case '?':
        if (!failed) {
          if (s[0] === '/') failed = true;
          s = s.slice(1);
        }
        chunk = chunk.slice(1);
        break;
      case '\\':
        chunk = chunk.slice(1);
        if (chunk.length === 0) throw new BadPattern();
      // falls through
      default:
        if (!failed) {
          if (chunk[0] !== s[0]) failed = true;
          s = s.slice(1);
        }
        chunk = chunk.slice(1);
    }
  }
  return failed ? null : s;
}

function getEsc(input: string[]): { rune: string; rest: string[] } {
  let chunk = input;
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') throw new BadPattern();
  if (chunk[0] === '\\') {
    chunk = chunk.slice(1);
    if (chunk.length === 0) throw new BadPattern();
  }
  const rune = chunk[0];
  const rest = chunk.slice(1);
  if (rest.length === 0) throw new BadPattern();
  return { rune, rest };
}

// ── Sections and symbols as two spellings compare ───────────────────────────────────────────────────

const HEADING_NUMBER = /^(?:§[\t\n\f\r ]*)?(?:第[\t\n\f\r ]*\d+[\t\n\f\r ]*[章节部分][\t\n\f\r ]*|\d+(?:\.\d+)*[.、)]?[\t\n\f\r ]+|[A-Z]\d*[.、)][\t\n\f\r ]+)/u;
const MARKUP = /[*_`]/gu;
const SPACES = /[\t\n\f\r ]+/gu;
const WIDTHS: Record<string, string> = { '（': '(', '）': ')', '：': ':', '，': ',', '；': ';', '　': ' ', '—': '-', '–': '-' };

/** A heading as two spellings of it compare: no markup, no numbering, one case, one width of punctuation, one space. */
export function wikiPlanHeadingKey(input: string): string {
  let text = goTrimSpace(input);
  if (text.startsWith('§')) text = text.slice(1);
  text = goTrimSpace(text).replace(MARKUP, '');
  text = text.replace(/[（）：，；　—–]/gu, (c) => WIDTHS[c]);
  text = goTrimSpace(text).replace(HEADING_NUMBER, '');
  return goTrimSpace(text.replace(SPACES, ' ')).toLowerCase();
}

/** How a model names a subsection by the heading it sits under: «parent - child». */
const HEADING_PATH = /[\t\n\f\r ]+(?:-|—|–|>|›|\/)[\t\n\f\r ]+/gu;

/**
 * Whether one of headings reads as section — or, when section names one by the heading it sits under,
 * «parent - child», whether one inside a heading that reads as parent reads as child. A heading's own text may
 * hold « - », so every place the name can be cut is tried.
 */
export function wikiPlanFindSection(headings: readonly WikiPlanHeading[], section: string): boolean {
  const want = wikiPlanHeadingKey(section);
  if (want !== '' && headings.some((h) => wikiPlanHeadingKey(h.text) === want)) return true;
  for (const cut of section.matchAll(HEADING_PATH)) {
    const parent = wikiPlanHeadingKey(section.slice(0, cut.index));
    if (parent === '') continue;
    for (const [i, h] of headings.entries()) {
      if (wikiPlanHeadingKey(h.text) !== parent) continue;
      let end = i + 1;
      while (end < headings.length && headings[end].level > h.level) end += 1;
      if (wikiPlanFindSection(headings.slice(i + 1, end), section.slice(cut.index! + cut[0].length))) return true;
    }
  }
  return false;
}

const SYMBOL_SUFFIX = /[\t\n\f\r ]*(\[[^\n]*\]|（[^\n]*）|\([^\n]*\))[\t\n\f\r ]*$/gu;

/** A symbol as the index and the model both spell it: no route, no parentheses. */
export function wikiPlanSymbolKey(input: string): string {
  let symbol = goTrim(goTrimSpace(input), '`');
  if (symbol.startsWith('ext ')) symbol = symbol.slice(4);
  for (;;) {
    const next = symbol.replace(SYMBOL_SUFFIX, '');
    if (next === symbol) break;
    symbol = goTrimSpace(next);
  }
  return symbol.endsWith('()') ? symbol.slice(0, -2) : symbol;
}
