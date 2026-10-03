import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  toUuid,
  WIKI_DOC_DISPOSITION_ACTIONS,
  WIKI_DOC_FOOTNOTE_KINDS,
  WIKI_DOC_RECORD_KINDS,
  WIKI_DOC_REPO_KINDS,
  WIKI_DOC_RULES,
  WIKI_DOC_SCHEMA,
  WIKI_DOCS_AFFECTED_RULES,
  type WikiAnchorState,
  type WikiDocBlockKind,
  type WikiDocChecker,
  type WikiDocDisposition,
  type WikiDocDispositionAction,
  type WikiDocFootnoteKind,
  type WikiDocFootnoteView,
  type WikiDocMaterial,
  type WikiDocRecordKind,
  type WikiDocRepoKind,
  type WikiDocSchemaLevel,
  type WikiDocSectionStats,
  type WikiDocSectionView,
  type WikiDocSentenceCounts,
  type WikiDocSentenceStatus,
  type WikiDocSentenceView,
  type WikiDocStatus,
  type WikiDocVerdict,
  type WikiDocView,
  type WikiDocViaEntry,
  type WikiDocWithdrawReason,
  type WikiDocWriteResult,
  type WikiDocsAffected,
  type WikiDocsDirectory,
  type WikiDocsIndex,
  type WikiDocsIndexItem,
  type WikiDocsPathWithdrawalResult,
  type WikiDocsWriterState,
  type WikiEntryKind,
  type WikiEntryStatus,
  type WikiFieldError,
  type WikiPlanSectionKind,
  type WikiSourceKind,
  type WikiTrust,
} from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { markersOf, splitSentences, wikiRepoPath, withoutMarkers } from './wiki-articles';
import { docWithdrawReason } from './wiki-doc-withdrawal';
import { wikiDocsAffected, withdrawDocSentencesByPath } from './wiki-docs-affected';
import { conditionView, gatherDocMaterial, type StoredSessionCondition } from './wiki-docs-material';
import { ownerEnvLiterals } from './wiki-dossier';
import { isWikiMaintenanceSession } from './wiki-maintenance-settings';
import { requireConfirmedPlan } from './wiki-plan';
import { WikiRefusalError, WikiService, type WikiPrincipal } from './wiki.service';

/**
 * The documents (criterion 9, revised 2026-09-28; contracts/wiki.contract.json `docs`, migration 0326):
 * a space's documents, written section by section from the plan its owner confirmed, every footnote
 * pointing at a first-hand original with its verbatim quote, and the entry it was found through kept
 * as the via entry.
 *
 * WHAT THE SERVER DECIDES. The model writes and the runner gathers; this file decides what can be decided
 * without either. Which plan a document is written from (`requireConfirmedPlan`, and the version the
 * write names); whether a section needs writing at all (its material's fingerprint); what the body's
 * sentences are (`parseSectionBody`, the articles' cut); whether a record's quote is in the record
 * (`findQuote`, after reading it again and redacting it — the server's own check, never the writer's
 * word); and what each sentence therefore is (`classifyDoc`: sourced, transition, unsourced, unverified
 * or withdrawn) and whether the whole document needs review.
 *
 * WHAT IT TAKES ON TRUST. The repository: a design document, code or a contract exists only in a
 * checkout, which the server has none of. The runner checks those quotes at a sha and says so; the
 * footnote is stored as the runner's check at that sha, and one without a sha is refused.
 *
 * A VIEW. Nothing points at these tables: no source kind names them, so a document is never a source;
 * the push and the agent's search and get read `wiki_entry` and nothing else. The owner reads, on the
 * user door; a maintenance run writes, on the runner door.
 *
 * NOT A SESSIONS OR PROJECTS DEPENDENCY: this reads the wiki's rows, the records a footnote names and
 * the titles a page shows, through Prisma, like the articles and the plan beside it.
 */

type Tx = Prisma.TransactionClient;

// ── The write, read ─────────────────────────────────────────────────────────────────────────────

const REPO_KINDS = new Set<string>(WIKI_DOC_REPO_KINDS);
const RECORD_KINDS = new Set<string>(WIKI_DOC_RECORD_KINDS);
const FOOTNOTE_KINDS = new Set<string>(WIKI_DOC_FOOTNOTE_KINDS);
const DISPOSITION_ACTIONS = new Set<string>(WIKI_DOC_DISPOSITION_ACTIONS);
/** A material's id in its section, as the runner gives it: `D1`, `C12`, `S3`. */
const MATERIAL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{7,64}$/u;
/** A full commit: what origin/main names, and what a section's `repoSha` is compared with. */
const COMMIT = /^[0-9a-f]{40}$/u;

interface RepoFootnote {
  repo: true;
  kind: WikiDocRepoKind;
  path: string;
  sha: string;
  lineStart: number;
  lineEnd: number;
  section: string | null;
  symbol: string | null;
  quote: string | null;
  excerpt: string | null;
  verified: boolean;
  viaEntryId: string | null;
}

interface RecordFootnote {
  repo: false;
  kind: WikiDocRecordKind;
  ref: string;
  chars: { start: number; end: number } | null;
  quote: string | null;
  viaEntryId: string | null;
}

type Footnote = RepoFootnote | RecordFootnote;

/** One section of a write, as the request carried it. */
interface SectionWrite {
  key: string;
  materialSha256: string;
  markdown: string;
  footnotes: Footnote[];
  /** What became of each piece of its material (contract `docs.dispositions`), as the write sent it. */
  dispositions: WikiDocDisposition[];
  /** Where it is in the request, for the errors that name it. */
  at: string;
}

interface DocWrite {
  planVersion: number;
  /** The origin/main commit the run read the repository at, kept with every section written. */
  repoSha: string;
  model: string | null;
  sections: SectionWrite[];
}

/** Characters, as code points: what every limit counts. */
function chars(text: string): number {
  return Array.from(text).length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every error a write has, collected rather than thrown at the first: the runner fixes them all at once. */
class Problems {
  readonly list: WikiFieldError[] = [];

  fail(path: string, message: string): void {
    this.list.push({ path, message });
  }

  /** The keys of `value` the schema does not have at `level`, each named. */
  fields(value: Record<string, unknown>, path: string, level: WikiDocSchemaLevel): void {
    const known = new Set<string>(WIKI_DOC_SCHEMA[level]);
    for (const key of Object.keys(value)) {
      if (!known.has(key)) this.fail(path ? `${path}.${key}` : key, `${key} is not a field of ${level} (${WIKI_DOC_SCHEMA[level].join(', ')}): remove it`);
    }
  }

  text(value: unknown, path: string, max: number): string | null {
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(path, 'is required: a string that is not blank');
      return null;
    }
    if (chars(value) > max) this.fail(path, `is at most ${max} characters`);
    return value.trim();
  }

  optionalText(value: unknown, path: string, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string, or null');
      return null;
    }
    const text = value.trim();
    if (text === '') return null;
    if (chars(text) > max) this.fail(path, `is at most ${max} characters`);
    return text;
  }

  integer(value: unknown, path: string, min: number): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      this.fail(path, `must be a whole number, ${min} or more`);
      return null;
    }
    return value;
  }

  range(value: unknown, path: string, level: 'lines' | 'chars'): { start: number; end: number } | null {
    if (!isObject(value)) {
      this.fail(path, level === 'lines' ? 'is required: { start, end }, 1-based and inclusive' : 'must be { start, end }, end exclusive, or null');
      return null;
    }
    this.fields(value, path, level);
    const start = this.integer(value.start, `${path}.start`, level === 'lines' ? 1 : 0);
    const end = this.integer(value.end, `${path}.end`, level === 'lines' ? 1 : 1);
    if (start === null || end === null) return null;
    if (level === 'lines' ? end < start : end <= start) {
      this.fail(`${path}.end`, level === 'lines' ? 'is the last line: not before start' : 'is where the range stops: after start');
      return null;
    }
    return { start, end };
  }
}

/** The plan version a write names, read before anything else: a stale write is refused as stale. */
function planVersionOf(body: unknown): number | null {
  const value = isObject(body) ? body.planVersion : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The write's body, checked for shape against the schema and the confirmed plan's document. */
function parseWrite(body: unknown, planKeys: ReadonlySet<string>, slug: string, problems: Problems): DocWrite {
  const write: DocWrite = { planVersion: 0, repoSha: '', model: null, sections: [] };
  if (!isObject(body)) {
    problems.fail('', 'the body is an object: { planVersion, repoSha, model, sections }');
    return write;
  }
  problems.fields(body, '', 'write');
  write.planVersion = problems.integer(body.planVersion, 'planVersion', 1) ?? 0;
  const repoSha = typeof body.repoSha === 'string' ? body.repoSha.trim() : '';
  if (!COMMIT.test(repoSha)) {
    problems.fail('repoSha', 'is required: the origin/main commit the repository was read at, 40 lowercase hex characters (each section is kept with it)');
  }
  write.repoSha = repoSha;
  write.model = problems.optionalText(body.model, 'model', 200);
  const sections = body.sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > WIKI_DOC_RULES.sectionsPerWrite) {
    problems.fail('sections', `must hold 1 to ${WIKI_DOC_RULES.sectionsPerWrite} sections`);
    return write;
  }
  const seen = new Set<string>();
  sections.forEach((value, i) => {
    const at = `sections[${i}]`;
    if (!isObject(value)) {
      problems.fail(at, 'must be an object: { key, materialSha256, markdown, footnotes }');
      return;
    }
    problems.fields(value, at, 'section');
    const key = problems.text(value.key, `${at}.key`, 64);
    if (key !== null) {
      if (!planKeys.has(key)) {
        problems.fail(`${at}.key`, `${key} is not a section of document ${slug} in the confirmed plan (its sections: ${[...planKeys].join(', ')})`);
      } else if (seen.has(key)) {
        problems.fail(`${at}.key`, `section ${key} is written once per write`);
      }
      seen.add(key);
    }
    const material = typeof value.materialSha256 === 'string' ? value.materialSha256 : '';
    if (!HEX64.test(material)) problems.fail(`${at}.materialSha256`, 'is the fingerprint of the section\'s material: 64 lowercase hex characters');
    let markdown = '';
    if (typeof value.markdown !== 'string' || value.markdown.trim() === '') {
      problems.fail(`${at}.markdown`, 'is required: the section\'s body, not blank');
    } else if (chars(value.markdown) > WIKI_DOC_RULES.markdownMaxChars) {
      problems.fail(`${at}.markdown`, `is at most ${WIKI_DOC_RULES.markdownMaxChars} characters`);
    } else {
      markdown = value.markdown;
    }
    const footnotes: Footnote[] = [];
    if (!Array.isArray(value.footnotes) || value.footnotes.length > WIKI_DOC_RULES.footnotesPerSection) {
      problems.fail(`${at}.footnotes`, `must be a list of at most ${WIKI_DOC_RULES.footnotesPerSection} footnotes`);
    } else {
      value.footnotes.forEach((raw, j) => {
        const footnote = parseFootnote(raw, `${at}.footnotes[${j}]`, problems);
        if (footnote) footnotes.push(footnote);
      });
    }
    const dispositions = parseDispositions(value.dispositions, `${at}.dispositions`, problems);
    write.sections.push({ key: key ?? '', materialSha256: material, markdown, footnotes, dispositions, at });
  });
  return write;
}

/**
 * A section's material ledger (contract `docs.dispositions`): optional, at most
 * `rules.dispositionsPerSection`, every piece named once, a merge into another piece of the same ledger.
 */
function parseDispositions(value: unknown, at: string, problems: Problems): WikiDocDisposition[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > WIKI_DOC_RULES.dispositionsPerSection) {
    problems.fail(at, `must be a list of at most ${WIKI_DOC_RULES.dispositionsPerSection} dispositions`);
    return [];
  }
  const out: WikiDocDisposition[] = [];
  const named = new Set<string>();
  value.forEach((raw, i) => {
    const path = `${at}[${i}]`;
    if (!isObject(raw)) {
      problems.fail(path, 'must be an object: { material, kind, ref, action, into, reason }');
      return;
    }
    problems.fields(raw, path, 'disposition');
    const material = typeof raw.material === 'string' ? raw.material.trim() : '';
    if (!MATERIAL_ID.test(material)) problems.fail(`${path}.material`, 'is the id the runner gave the material in its section: a letter, then up to 15 letters, digits, _ or -');
    else if (named.has(material)) problems.fail(`${path}.material`, `${material} is named twice: each piece of material has one disposition`);
    named.add(material);
    const kind = raw.kind;
    if (typeof kind !== 'string' || !FOOTNOTE_KINDS.has(kind)) problems.fail(`${path}.kind`, `must be one of ${WIKI_DOC_FOOTNOTE_KINDS.join(', ')}`);
    const ref = problems.text(raw.ref, `${path}.ref`, WIKI_DOC_RULES.textMaxChars);
    const action = raw.action;
    if (typeof action !== 'string' || !DISPOSITION_ACTIONS.has(action)) problems.fail(`${path}.action`, `must be one of ${WIKI_DOC_DISPOSITION_ACTIONS.join(', ')}`);
    let into: string | null = null;
    if (raw.into !== undefined && raw.into !== null) {
      if (typeof raw.into !== 'string' || !MATERIAL_ID.test(raw.into.trim())) problems.fail(`${path}.into`, 'must name a material of this section, or be null');
      else into = raw.into.trim();
    }
    if (action === 'merge' && into === null) problems.fail(`${path}.into`, 'is required for a merge: the material it was merged into');
    if (action !== 'merge' && into !== null) problems.fail(`${path}.into`, 'is only for a merge: null otherwise');
    if (into !== null && into === material) problems.fail(`${path}.into`, 'names the material itself: a piece is merged into another');
    const reason = problems.text(raw.reason, `${path}.reason`, WIKI_DOC_RULES.reasonMaxChars);
    if (MATERIAL_ID.test(material) && typeof kind === 'string' && FOOTNOTE_KINDS.has(kind) && ref !== null && typeof action === 'string'
      && DISPOSITION_ACTIONS.has(action) && reason !== null) {
      out.push({ material, kind: kind as WikiDocFootnoteKind, ref, action: action as WikiDocDispositionAction, into, reason });
    }
  });
  // A merge names another piece of the same ledger.
  value.forEach((raw, i) => {
    const into = isObject(raw) && typeof raw.into === 'string' ? raw.into.trim() : '';
    if (into !== '' && MATERIAL_ID.test(into) && !named.has(into)) {
      problems.fail(`${at}[${i}].into`, `${into} is not a material of this section's dispositions`);
    }
  });
  return out;
}

function parseFootnote(value: unknown, at: string, problems: Problems): Footnote | null {
  if (!isObject(value)) {
    problems.fail(at, 'must be an object');
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || (!REPO_KINDS.has(kind) && !RECORD_KINDS.has(kind))) {
    problems.fail(`${at}.kind`, `must be one of ${[...WIKI_DOC_REPO_KINDS, ...WIKI_DOC_RECORD_KINDS].join(', ')}`);
    return null;
  }
  let quote: string | null = null;
  if (value.quote !== undefined && value.quote !== null) {
    if (typeof value.quote !== 'string') problems.fail(`${at}.quote`, 'must be the verbatim quote, a string, or null');
    else if (chars(value.quote.trim()) > WIKI_DOC_RULES.quoteMaxChars) problems.fail(`${at}.quote`, `is at most ${WIKI_DOC_RULES.quoteMaxChars} characters`);
    else quote = value.quote.trim() === '' ? null : value.quote.trim();
  }
  let viaEntryId: string | null = null;
  if (value.viaEntryId !== undefined && value.viaEntryId !== null) {
    try {
      viaEntryId = toUuid(String(value.viaEntryId));
    } catch {
      problems.fail(`${at}.viaEntryId`, 'must name an entry of the space by its id');
    }
  }
  if (REPO_KINDS.has(kind)) {
    problems.fields(value, at, 'repoFootnote');
    const rawPath = problems.text(value.path, `${at}.path`, WIKI_DOC_RULES.textMaxChars);
    const path = rawPath === null ? null : wikiRepoPath(rawPath);
    if (path !== null && (path === '' || path.startsWith('/'))) problems.fail(`${at}.path`, 'is a path relative to the repository');
    const sha = typeof value.sha === 'string' ? value.sha.trim() : '';
    if (!SHA.test(sha)) {
      problems.fail(
        `${at}.sha`,
        'a repository footnote is pinned to the commit it was read at: sha is required, 7 to 64 lowercase hex characters (the server cannot read the repository, so it keeps the runner\'s check only at a sha)',
      );
    }
    const lines = problems.range(value.lines, `${at}.lines`, 'lines');
    if (typeof value.verified !== 'boolean') problems.fail(`${at}.verified`, 'is required: whether the runner found the quote in those lines at that sha');
    const section = problems.optionalText(value.section, `${at}.section`, WIKI_DOC_RULES.textMaxChars);
    const symbol = problems.optionalText(value.symbol, `${at}.symbol`, WIKI_DOC_RULES.textMaxChars);
    let excerpt: string | null = null;
    if (value.excerpt !== undefined && value.excerpt !== null) {
      if (typeof value.excerpt !== 'string') problems.fail(`${at}.excerpt`, 'must be the quoted lines as read, a string, or null');
      else if (chars(value.excerpt) > WIKI_DOC_RULES.excerptMaxChars) problems.fail(`${at}.excerpt`, `is at most ${WIKI_DOC_RULES.excerptMaxChars} characters`);
      else excerpt = value.excerpt.trim() === '' ? null : value.excerpt;
    }
    if (path === null || !SHA.test(sha) || lines === null || typeof value.verified !== 'boolean') return null;
    return {
      repo: true,
      kind: kind as WikiDocRepoKind,
      path,
      sha,
      lineStart: lines.start,
      lineEnd: lines.end,
      section,
      symbol,
      quote,
      excerpt,
      verified: value.verified,
      viaEntryId,
    };
  }
  problems.fields(value, at, 'recordFootnote');
  const ref = problems.text(value.ref, `${at}.ref`, WIKI_DOC_RULES.textMaxChars);
  const range = value.chars === undefined || value.chars === null ? null : problems.range(value.chars, `${at}.chars`, 'chars');
  if (ref === null) return null;
  return { repo: false, kind: kind as WikiDocRecordKind, ref, chars: range, quote, viaEntryId };
}

function invalid(errors: readonly WikiFieldError[]): WikiRefusalError {
  const listed = errors.slice(0, WIKI_DOC_RULES.errorsMax);
  return new WikiRefusalError({
    code: 'WIKI_DOC_INVALID',
    message:
      `The document write does not have the shape the contract gives it (docs.schema): ${errors.length} error${errors.length === 1 ? '' : 's'}`
        + (errors.length > listed.length ? `, the first ${listed.length} listed` : '')
        + '. Nothing was written; fix every one and send it again.',
    errors: listed,
  });
}

// ── A section's body: blocks and sentences ──────────────────────────────────────────────────────

/** One sentence as the body gives it: the block it is in, its text, and the footnotes (0-based) it names. */
export interface BodySentence {
  block: number;
  text: string;
  notes: number[];
}

/** A block as stored (`wiki_doc_section.blocks`): a heading's or a code block's text; sentences live apart. */
export interface BodyBlock {
  kind: WikiDocBlockKind;
  text?: string;
}

export interface SectionBody {
  blocks: BodyBlock[];
  sentences: BodySentence[];
  markersDropped: number;
  chars: number;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const FENCE = /^\s{0,3}(```|~~~)/u;
const ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)、])\s+(.*)$/u;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;
const QUOTED = /^\s{0,3}>\s?(.*)$/u;

/**
 * A section's Markdown cut into blocks and sentences (contract `docs.markdown`). A first line that is a
 * heading is the section's own title — the plan names it — and is dropped. A fenced block is code and is
 * not checked; a heading line is a heading block; a list item is an item block, which an indented line
 * under it continues; the other lines up to a blank line are one paragraph. Paragraphs and items are cut
 * into sentences exactly as the articles are (`splitSentences`), so a ； ends nothing. A marker [n]
 * names footnote n of the section; one outside 1 to `footnotes` names none and is dropped.
 */
export function parseSectionBody(markdown: string, footnotes: number): SectionBody {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (start < lines.length && HEADING.test(lines[start])) start += 1;

  const drafts: Array<{ kind: WikiDocBlockKind; text: string }> = [];
  let paragraph: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) drafts.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (line.trim().startsWith(fence.marker)) {
        drafts.push({ kind: 'code', text: fence.lines.join('\n') });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const opens = FENCE.exec(line);
    if (opens) {
      flush();
      fence = { marker: opens[1], lines: [] };
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      drafts.push({ kind: 'heading', text: heading[2] });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      drafts.push({ kind: 'item', text: item[1].trim() });
      continue;
    }
    const last = drafts[drafts.length - 1];
    if (paragraph.length === 0 && last?.kind === 'item' && /^\s/u.test(line)) {
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }
    const quoted = QUOTED.exec(line);
    paragraph.push((quoted ? quoted[1] : line).trim());
  }
  if (fence) drafts.push({ kind: 'code', text: fence.lines.join('\n') });
  flush();

  const body: SectionBody = { blocks: [], sentences: [], markersDropped: 0, chars: 0 };
  for (const draft of drafts) {
    if (draft.kind === 'code') {
      if (draft.text.trim() !== '') body.blocks.push({ kind: 'code', text: draft.text });
      continue;
    }
    if (draft.kind === 'heading') {
      body.markersDropped += markersOf(draft.text).length;
      const text = withoutMarkers(draft.text).replace(/^\*\*(.*)\*\*$/u, '$1').trim();
      if (text !== '') body.blocks.push({ kind: 'heading', text });
      continue;
    }
    const block = body.blocks.length;
    let kept = 0;
    for (const piece of splitSentences(draft.text)) {
      const marks = markersOf(piece);
      const text = withoutMarkers(piece);
      // A run of markers with nothing around them is not a sentence anybody wrote.
      if (!/[\p{L}\p{N}]/u.test(text)) {
        body.markersDropped += marks.length;
        continue;
      }
      const notes: number[] = [];
      for (const n of marks) {
        if (n < 1 || n > footnotes) {
          body.markersDropped += 1;
          continue;
        }
        if (!notes.includes(n - 1)) notes.push(n - 1);
      }
      body.sentences.push({ block, text, notes });
      body.chars += chars(text);
      kept += 1;
    }
    if (kept > 0) body.blocks.push({ kind: draft.kind });
  }
  return body;
}

// ── Quotes: folded, then found ──────────────────────────────────────────────────────────────────

/** Full-width punctuation read as its ASCII counterpart (contract `docs.verification.normalization`). */
const QUOTE_PUNCTUATION: Readonly<Record<string, string>> = {
  '，': ',',
  '。': '.',
  '：': ':',
  '；': ';',
  '（': '(',
  '）': ')',
  '！': '!',
  '？': '?',
  '「': '"',
  '」': '"',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '、': ',',
  '『': '"',
  '』': '"',
  '【': '[',
  '】': ']',
  '—': '-',
  '–': '-',
};

/** The characters a Markdown escape stands for. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|', '"']);

/** A text folded for comparison, and for each UTF-16 unit of it the code point of the source it came from. */
interface Folded {
  text: string;
  at: number[];
}

/**
 * Fold `chars[from, to)` the way a quote is compared: punctuation read as ASCII, `**`, `__` and backticks
 * dropped, an escape read as what it escapes, whitespace dropped — and, with `skip`, the characters a
 * leading comment marker is made of.
 */
function fold(chars: readonly string[], from: number, to: number, skip: readonly boolean[] | null): Folded {
  let text = '';
  const at: number[] = [];
  for (let i = from; i < to; i += 1) {
    if (skip?.[i]) continue;
    const ch = chars[i];
    if (/\s/u.test(ch) || ch === '`') continue;
    if ((ch === '*' || ch === '_') && i + 1 < to && chars[i + 1] === ch) {
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < to && ESCAPABLE.has(chars[i + 1])) continue;
    const out = QUOTE_PUNCTUATION[ch] ?? ch;
    text += out;
    for (let unit = 0; unit < out.length; unit += 1) at.push(i);
  }
  return { text, at };
}

/** The characters of each line's leading comment marker (`//`, `///`, `/*`, `*`, `*\/`, `#`) and the space after it. */
function commentMarkers(chars: readonly string[]): boolean[] {
  const skip = new Array<boolean>(chars.length).fill(false);
  let lineStart = 0;
  while (lineStart <= chars.length) {
    let end = lineStart;
    while (end < chars.length && chars[end] !== '\n') end += 1;
    let first = lineStart;
    while (first < end && /\s/u.test(chars[first])) first += 1;
    const marker = /^(?:\/{2,3}|\/\*+|\*+\/?|#)\s?/u.exec(chars.slice(first, Math.min(end, first + 64)).join(''));
    if (marker) {
      const length = Array.from(marker[0]).length;
      for (let k = first; k < first + length; k += 1) skip[k] = true;
    }
    lineStart = end + 1;
  }
  return skip;
}

/** A quote folded, as it is looked for. */
export function foldQuote(quote: string): string {
  const chars = Array.from(quote.normalize('NFC'));
  return fold(chars, 0, chars.length, null).text;
}

/**
 * Where `quote` is in `source`, in code points of the NFC form of `source`, or null (contract
 * `docs.verification`): both folded, the source once as it is and once with each line's leading comment
 * marker off. One passage or nothing — an ellipsis is not a gap, a translation or a paraphrase is not the
 * words, and two passages joined as one are found only where they stand together. `within` narrows the
 * search to that range of the source. A quote that folds to fewer than `rules.quoteMinChars` characters
 * would be found anywhere, so it is found nowhere.
 */
export function findQuote(source: string, quote: string, within: { start: number; end: number } | null = null): { start: number; end: number } | null {
  const needle = foldQuote(quote);
  if (chars(needle) < WIKI_DOC_RULES.quoteMinChars) return null;
  const points = Array.from(source.normalize('NFC'));
  const from = within ? Math.max(0, within.start) : 0;
  const to = within ? Math.min(points.length, within.end) : points.length;
  if (from >= to) return null;
  for (const skip of [null, commentMarkers(points)]) {
    const folded = fold(points, from, to, skip);
    const i = folded.text.indexOf(needle);
    if (i >= 0) return { start: folded.at[i], end: folded.at[i + needle.length - 1] + 1 };
  }
  return null;
}

// ── Fact tokens and the sentences' statuses ────────────────────────────────────────────────────

/** Code spans, ASCII identifiers and paths, numbers of two or more digits, numbers with a unit — in that order. */
const FACT_TOKEN = /`[^`]+`|\b[A-Za-z_][A-Za-z0-9_./-]*[A-Za-z0-9_]\b|\d{2,}|\d+(?:\.\d+)?\s*(?:秒|分钟|小时|天|个|条|次|%|ms|s|MB|KB)/gu;
/** English words too common to be a fact. */
const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'are', 'can', 'its', 'but', 'via']);

/** A text's fact tokens (contract `docs.factTokens`), lowercased with whitespace dropped. */
export function factTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(FACT_TOKEN)) {
    const raw = match[0];
    const code = raw.startsWith('`');
    const token = (code ? raw.slice(1, -1) : raw).replace(/\s+/gu, '').toLowerCase();
    if (token === '') continue;
    if (!code && /^[a-z_]/u.test(token) && (token.length < 3 || STOP.has(token))) continue;
    out.add(token);
  }
  return [...out];
}

/** A sentence as the whole document's classification reads it. */
export interface Judged {
  text: string;
  /** Carries at least one footnote. */
  marked: boolean;
  status: WikiDocSentenceStatus;
  newTokens: string[];
}

/**
 * The statuses of a document's sentences (contract `docs.classification`). A sentence with footnotes
 * keeps what its footnotes made it (sourced, unverified, withdrawn); one without is a transition when
 * every fact token in it is among those of the document's sourced sentences and headings, and unsourced
 * otherwise. Decided over the whole document at once, so a transition in one section answers to what
 * the others say. Changes `sentences` in place.
 */
export function classifyDoc(headings: readonly string[], sentences: Judged[]): void {
  const known = new Set<string>();
  for (const heading of headings) for (const token of factTokens(heading)) known.add(token);
  for (const sentence of sentences) {
    if (sentence.status === 'sourced') for (const token of factTokens(sentence.text)) known.add(token);
  }
  for (const sentence of sentences) {
    if (sentence.marked || sentence.status === 'withdrawn') continue;
    const fresh = factTokens(sentence.text).filter((token) => !known.has(token));
    sentence.status = fresh.length === 0 ? 'transition' : 'unsourced';
    sentence.newTokens = fresh.sort();
  }
}

export function countSentences(statuses: readonly WikiDocSentenceStatus[]): WikiDocSentenceCounts {
  const counts: WikiDocSentenceCounts = { sentences: statuses.length, sourced: 0, transition: 0, unsourced: 0, unverified: 0, withdrawn: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

/** The unsourced and unverified sentences' share of all of them. */
export function unsourcedShare(counts: WikiDocSentenceCounts): number {
  return counts.sentences === 0 ? 0 : (counts.unsourced + counts.unverified) / counts.sentences;
}

/** More than `rules.needsReviewAbove` of the sentences unsourced or unverified: the whole document needs review. */
export function docStatusOf(counts: WikiDocSentenceCounts): WikiDocStatus {
  // In whole numbers, so 5% exactly never tips over on a rounding.
  const percent = Math.round(WIKI_DOC_RULES.needsReviewAbove * 100);
  return (counts.unsourced + counts.unverified) * 100 > percent * counts.sentences ? 'needs_review' : 'ok';
}

// ── Records: where they are ─────────────────────────────────────────────────────────────────────

/** What the page links a record's footnote to (`wiki_doc_footnote.locator`, contract `docs.links`). */
interface RecordLink {
  sessionId?: string;
  seq?: number;
  at?: string;
  label?: string;
  taskId?: string;
  projectId?: string;
  path?: string;
}

type RecordReader = Pick<
  Prisma.TransactionClient,
  'conversationTurn' | 'runEvent' | 'toolCall' | 'task' | 'taskComment' | 'approval' | 'sessionMergeReceipt' | 'projectBlocker' | 'wikiNote'
>;

/**
 * Where one of the account's records is, for the page's link (contract `docs.links`): the session a turn,
 * an event, a tool call, an approval or a merge receipt is in — with the record's id, the pair a session's
 * deep link needs — a turn's or an event's number in it, a comment's task, an owner decision's project, a
 * note's path, and when and what it is. Its words are read through the one reader a record has
 * (`WikiService.sourceText`), not here.
 */
async function recordLink(db: RecordReader, ownerId: string, kind: WikiDocRecordKind, id: string): Promise<RecordLink> {
  const ownSession = { session: { ownerId } };
  switch (kind) {
    case 'turn': {
      const turn = await db.conversationTurn.findFirst({ where: { id, ...ownSession }, select: { sessionId: true, seq: true, kind: true, createdAt: true } });
      return turn ? { sessionId: turn.sessionId, seq: turn.seq, at: turn.createdAt.toISOString(), label: turn.kind } : {};
    }
    case 'event': {
      const event = await db.runEvent.findFirst({ where: { id, ...ownSession }, select: { sessionId: true, seq: true, type: true, createdAt: true } });
      return event ? { sessionId: event.sessionId, seq: event.seq, at: event.createdAt.toISOString(), label: event.type } : {};
    }
    case 'tool_call': {
      const call = await db.toolCall.findFirst({ where: { id, ...ownSession }, select: { sessionId: true, name: true, startedAt: true } });
      return call ? { sessionId: call.sessionId, label: call.name, ...(call.startedAt ? { at: call.startedAt.toISOString() } : {}) } : {};
    }
    case 'task': {
      const task = await db.task.findFirst({ where: { id, ownerId }, select: { createdAt: true } });
      return task ? { taskId: id, at: task.createdAt.toISOString() } : {};
    }
    case 'task_comment': {
      const comment = await db.taskComment.findFirst({ where: { id, task: { ownerId } }, select: { taskId: true, authorType: true, createdAt: true } });
      return comment ? { taskId: comment.taskId, at: comment.createdAt.toISOString(), label: comment.authorType } : {};
    }
    case 'approval': {
      const approval = await db.approval.findFirst({ where: { id, ...ownSession }, select: { sessionId: true, toolName: true, createdAt: true } });
      return approval ? { sessionId: approval.sessionId, at: approval.createdAt.toISOString(), label: approval.toolName } : {};
    }
    case 'merge_receipt': {
      const receipt = await db.sessionMergeReceipt.findFirst({ where: { id, ownerId }, select: { sessionId: true, taskId: true, result: true, createdAt: true } });
      return receipt
        ? { sessionId: receipt.sessionId, at: receipt.createdAt.toISOString(), label: receipt.result, ...(receipt.taskId ? { taskId: receipt.taskId } : {}) }
        : {};
    }
    case 'owner_decision': {
      const blocker = await db.projectBlocker.findFirst({ where: { id, project: { ownerId } }, select: { projectId: true, kind: true, resolvedAt: true } });
      return blocker ? { projectId: blocker.projectId, label: blocker.kind, ...(blocker.resolvedAt ? { at: blocker.resolvedAt.toISOString() } : {}) } : {};
    }
    case 'note': {
      const note = await db.wikiNote.findFirst({ where: { id, ownerId }, select: { path: true, createdAt: true } });
      return note ? { path: note.path, at: note.createdAt.toISOString() } : {};
    }
    default:
      return {};
  }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** A footnote as it is about to be stored. */
interface FootnoteRow {
  kind: WikiDocFootnoteKind;
  ref: string;
  sha: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  charStart: number | null;
  charEnd: number | null;
  locator: Record<string, unknown>;
  quote: string | null;
  excerpt: string | null;
  verdict: WikiDocVerdict;
  checkedBy: WikiDocChecker;
  viaEntryId: string | null;
}

/** A section as it is about to be stored: its body, its footnotes checked, its sentences' first statuses. */
interface PreparedSection {
  key: string;
  planSectionId: string;
  materialSha256: string;
  dispositions: WikiDocDisposition[];
  blocks: BodyBlock[];
  sentences: Array<BodySentence & { status: WikiDocSentenceStatus; newTokens: string[] }>;
  footnotes: FootnoteRow[];
  stats: WikiDocSectionStats;
}

const PLAN_SELECT = {
  id: true,
  version: true,
  confirmedAt: true,
  categories: true,
  docs: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      position: true,
      category: true,
      slug: true,
      title: true,
      question: true,
      audience: true,
      scopeIn: true,
      scopeOut: true,
      lengthMin: true,
      lengthMax: true,
      sections: { orderBy: { position: 'asc' }, select: { id: true, position: true, key: true, title: true, kind: true } },
    },
  },
} satisfies Prisma.WikiPlanSelect;

type PlanRow = Prisma.WikiPlanGetPayload<{ select: typeof PLAN_SELECT }>;
type PlanDocRow = PlanRow['docs'][number];

interface PlanCategory {
  key: string;
  title: string;
  question?: string;
  forAgents?: boolean;
}

/** Each document's number (`<category>.<n>`) and its category, in the plan's order. */
function numbering(plan: PlanRow): Map<string, { number: string; category: { key: string; number: number; title: string } }> {
  const categories = (plan.categories as unknown as PlanCategory[]) ?? [];
  const place = new Map(categories.map((category, i) => [category.key, { number: i + 1, title: category.title }]));
  const counted = new Map<string, number>();
  const out = new Map<string, { number: string; category: { key: string; number: number; title: string } }>();
  for (const doc of plan.docs) {
    const n = (counted.get(doc.category) ?? 0) + 1;
    counted.set(doc.category, n);
    const category = place.get(doc.category) ?? { number: categories.length + 1, title: doc.category };
    out.set(doc.slug, { number: `${category.number}.${n}`, category: { key: doc.category, number: category.number, title: category.title } });
  }
  return out;
}

/** What a document's classification counts as its headings: its title, its question and its sections' titles. */
function planHeadings(doc: PlanDocRow): string[] {
  return [doc.title, doc.question, ...doc.sections.map((section) => section.title)];
}

/** The redactor with the owner's literals, over a text that may be null. */
function redacted(text: string | null, literals: readonly string[]): string | null {
  return text === null ? null : redactSecrets(text, { literals }).text;
}

@Injectable()
export class WikiDocs {
  private readonly logger = new Logger(WikiDocs.name);

  constructor(
    private readonly prisma: PrismaService,
    // The one reader of a record's words (`sourceText`): what a footnote's quote is checked against.
    private readonly wiki: WikiService,
    // `wiki.changed` after a write commits (contract `realtime.publishedWhen`): an accelerant, defaulted
    // so a spec that builds this by hand need not stub it. `RealtimeModule` is global.
    private readonly realtime: RealtimeService = undefined as unknown as RealtimeService,
  ) {}

  // ── Who asks ──────────────────────────────────────────────────────────────────────────────────

  /** Another owner's space is the plain 404 every tenancy check answers (contract `refusalRules.notFound`). */
  private async requireSpace(ownerId: string, spaceId: string): Promise<void> {
    const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { id: true } });
    if (!space) throw new NotFoundException('no such wiki space');
  }

  /**
   * The writers (contract `docs.who.write`): a maintenance run of this space, asked the one test
   * criterion 2 exported, or the import the server's own container runs. The space is found first, so
   * another owner's is a 404 before it is anything else.
   */
  async assertWriter(principal: WikiPrincipal, spaceId: string): Promise<void> {
    await this.requireSpace(principal.ownerId, spaceId);
    if (principal.origin === 'import' && principal.sessionId === null && principal.userId === null) return;
    if (
      principal.origin === 'maintenance'
      && principal.sessionId !== null
      && (await isWikiMaintenanceSession(this.prisma, { ownerId: principal.ownerId, sessionId: principal.sessionId, spaceId }))
    ) {
      return;
    }
    throw new WikiRefusalError({
      code: 'WIKI_NOT_MAINTENANCE_SESSION',
      message:
        "only a Wiki maintenance run of this space writes its documents — a session whose task is in the space's hidden "
          + '«Wiki maintenance» list — or an import the server runs itself. This caller is neither.',
    });
  }

  /** The space's confirmed plan with its documents and sections, or null while it has none. */
  private async confirmedPlan(db: Pick<Prisma.TransactionClient, 'wikiPlan'>, ownerId: string, spaceId: string): Promise<PlanRow | null> {
    return db.wikiPlan.findFirst({ where: { ownerId, spaceId, status: 'confirmed' }, select: PLAN_SELECT });
  }

  // ── The runner door ───────────────────────────────────────────────────────────────────────────

  /** What is written, for a run to tell which sections to write again (contract `docs.reads.writerState`). */
  async writerState(principal: WikiPrincipal, spaceId: string): Promise<WikiDocsWriterState> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const [plan, docs] = await Promise.all([
      this.prisma.wikiPlan.findFirst({ where: { ownerId, spaceId, status: 'confirmed' }, select: { version: true } }),
      this.prisma.wikiDoc.findMany({
        where: { ownerId, spaceId },
        orderBy: { slug: 'asc' },
        select: {
          slug: true,
          planVersion: true,
          status: true,
          repoSha: true,
          updatedAt: true,
          sections: { orderBy: { key: 'asc' }, select: { key: true, materialSha256: true, repoSha: true, staleAt: true, generatedAt: true } },
        },
      }),
    ]);
    return {
      spaceId,
      planVersion: plan?.version ?? null,
      docs: docs.map((doc) => ({
        slug: doc.slug,
        planVersion: doc.planVersion,
        status: doc.status as WikiDocStatus,
        repoSha: doc.repoSha,
        updatedAt: doc.updatedAt.toISOString(),
        sections: doc.sections.map((section) => ({
          key: section.key,
          materialSha256: section.materialSha256,
          repoSha: section.repoSha,
          stale: section.staleAt !== null,
          generatedAt: section.generatedAt.toISOString(),
        })),
      })),
    };
  }

  /**
   * One document as it is written, for a maintenance run of the space (contract `docs.reads.writerDoc`):
   * the owner's read, on the runner door, so a run can write an overview over sections it left unchanged.
   */
  async writerDoc(principal: WikiPrincipal, spaceId: string, slug: string): Promise<WikiDocView> {
    await this.assertWriter(principal, spaceId);
    return this.doc(principal.ownerId, spaceId, slug);
  }

  /**
   * What a maintenance run of the space writes again because of the entries, and what it may propose
   * (contract `docs.reads.affected`): the written sections an entry that changed since they were written
   * fits, and the stale ones; the entries that fit no section and no proposal names; and what the
   * proposals already name. With no confirmed plan, plan is null and the run writes no document.
   */
  async affected(principal: WikiPrincipal, spaceId: string): Promise<WikiDocsAffected> {
    await this.assertWriter(principal, spaceId);
    return wikiDocsAffected(this.prisma, principal.ownerId, spaceId);
  }

  /**
   * Repository files a maintenance run found deleted or renamed on origin/main (contract
   * `docs.withdrawal.paths`): every sentence of the space's documents citing one is withdrawn as its anchor
   * gone missing, naming the path, and its section marked stale, in one transaction.
   */
  async withdrawPaths(principal: WikiPrincipal, spaceId: string, body: unknown): Promise<WikiDocsPathWithdrawalResult> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const problems = new Problems();
    const raw = isObject(body) ? body : null;
    if (!raw) throw invalid([{ path: '', message: 'the body is an object: { repoSha, paths: [{ path, change, to? }] }' }]);
    for (const key of Object.keys(raw)) {
      if (!['repoSha', 'paths'].includes(key)) problems.fail(key, `${key} is not a field of a withdrawal: repoSha, paths`);
    }
    if (typeof raw.repoSha !== 'string' || !COMMIT.test(raw.repoSha)) {
      problems.fail('repoSha', 'is the origin/main commit the paths are gone at: 40 lowercase hex characters');
    }
    const listed = Array.isArray(raw.paths) ? raw.paths : [];
    if (!Array.isArray(raw.paths) || raw.paths.length === 0) problems.fail('paths', 'names at least one repository path that is gone');
    if (listed.length > WIKI_DOCS_AFFECTED_RULES.withdrawPathsMax) problems.fail('paths', `names at most ${WIKI_DOCS_AFFECTED_RULES.withdrawPathsMax} paths`);
    const paths: string[] = [];
    listed.slice(0, WIKI_DOCS_AFFECTED_RULES.withdrawPathsMax).forEach((item, i) => {
      const at = `paths[${i}]`;
      if (!isObject(item)) {
        problems.fail(at, 'is an object: { path, change, to? }');
        return;
      }
      for (const key of Object.keys(item)) if (!['path', 'change', 'to'].includes(key)) problems.fail(`${at}.${key}`, `${key} is not a field of a path: path, change, to`);
      const path = typeof item.path === 'string' ? item.path.trim().replace(/^\.\//u, '') : '';
      if (path === '' || chars(path) > WIKI_DOC_RULES.textMaxChars) problems.fail(`${at}.path`, `is a repository path, at most ${WIKI_DOC_RULES.textMaxChars} characters`);
      if (item.change !== 'deleted' && item.change !== 'renamed') problems.fail(`${at}.change`, 'is deleted or renamed');
      if (item.to !== undefined && item.to !== null && typeof item.to !== 'string') problems.fail(`${at}.to`, 'is the path it was renamed to, or null');
      if (path !== '') paths.push(path);
    });
    if (problems.list.length > 0) throw invalid(problems.list);
    const outcome = await withTransactionRetry(
      this.prisma,
      (tx) => withdrawDocSentencesByPath(tx, ownerId, spaceId, [...new Set(paths)]),
      loggedRetry(this.logger, 'wiki.withdrawDocPaths'),
    );
    if (outcome.withdrawn > 0) this.realtime?.publishWikiChanged(ownerId, spaceId);
    return { spaceId, ...outcome };
  }

  /**
   * The server's half of one section's material (contract `docs.reads.material`, `docs.material`): the
   * section's session condition as the confirmed plan states it, the entries it picks, and the records
   * found through them or by its projects, window and keywords — each read through the one reader a
   * record has, redacted as a footnote's check reads it, and placed.
   */
  async material(principal: WikiPrincipal, spaceId: string, slug: string, key: string | undefined): Promise<WikiDocMaterial> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const sectionKey = (key ?? '').trim();
    if (sectionKey === '') {
      throw new BadRequestException('section is required: ?section=<key>, a section of the document in the space\'s confirmed plan');
    }
    const confirmed = await requireConfirmedPlan(this.prisma, { ownerId, spaceId });
    const section = await this.prisma.wikiPlanSection.findFirst({
      where: { ownerId, key: sectionKey, doc: { ownerId, slug, planId: confirmed.id } },
      select: { sources: true },
    });
    if (!section) throw new NotFoundException(`no section ${sectionKey} of document ${slug} in the space's confirmed plan`);
    const condition = ((section.sources as unknown as { sessions?: StoredSessionCondition | null }) ?? {}).sessions ?? null;
    const literals = await ownerEnvLiterals(this.prisma, ownerId);
    const gathered = await gatherDocMaterial(this.prisma, this.wiki, { ownerId, spaceId, condition, literals });
    return {
      spaceId,
      slug,
      section: sectionKey,
      planVersion: confirmed.version,
      condition: await conditionView(this.prisma, ownerId, condition),
      ...gathered,
    };
  }

  /**
   * Write sections of one document (contract `docs.routes.write`, `docs.regeneration`).
   *
   * In order: the caller is a writer of the space; the space has a confirmed plan (`requireConfirmedPlan`,
   * or WIKI_PLAN_UNCONFIRMED) and the document is one of its documents (else 404); the write names that
   * version (else WIKI_PLAN_STALE); it has the schema's shape and names the plan document's sections and
   * the space's entries (else WIKI_DOC_INVALID, everything wrong at once). Then every record footnote is
   * read again, redacted and checked, before the one transaction that stores the sections and classifies
   * the whole document again.
   */
  async write(principal: WikiPrincipal, spaceId: string, slug: string, body: unknown): Promise<WikiDocWriteResult> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const confirmed = await requireConfirmedPlan(this.prisma, { ownerId, spaceId });
    const plan = await this.confirmedPlan(this.prisma, ownerId, spaceId);
    const planDoc = plan?.docs.find((doc) => doc.slug === slug);
    if (!plan || !planDoc) throw new NotFoundException(`no document ${slug} in the space's confirmed plan`);
    const named = planVersionOf(body);
    if (named !== null && named !== confirmed.version) throw staleWrite(named, confirmed.version);

    const problems = new Problems();
    const planKeys = new Set(planDoc.sections.map((section) => section.key));
    const request = parseWrite(body, planKeys, slug, problems);
    const bodies = new Map<string, SectionBody>();
    for (const section of request.sections) {
      if (section.markdown === '') continue;
      const parsed = parseSectionBody(section.markdown, section.footnotes.length);
      if (parsed.sentences.length === 0) problems.fail(`${section.at}.markdown`, 'says nothing: a section is written as at least one sentence');
      bodies.set(section.at, parsed);
    }
    const viaIds = [...new Set(request.sections.flatMap((section) => section.footnotes.map((f) => f.viaEntryId)).filter((id): id is string => id !== null))];
    if (viaIds.length > 0) {
      const found = new Set(
        (await this.prisma.wikiEntry.findMany({ where: { ownerId, spaceId, id: { in: viaIds } }, select: { id: true } })).map((entry) => entry.id),
      );
      request.sections.forEach((section) =>
        section.footnotes.forEach((footnote, j) => {
          if (footnote.viaEntryId !== null && !found.has(footnote.viaEntryId)) {
            problems.fail(`${section.at}.footnotes[${j}].viaEntryId`, 'is not an entry of this space: a via entry is the entry of the space the original was found through');
          }
        }),
      );
    }
    if (problems.list.length > 0) throw invalid(problems.list);

    // Every record read again and checked, redacted as everything stored is, before the transaction.
    const literals = await ownerEnvLiterals(this.prisma, ownerId);
    const sectionOf = new Map(planDoc.sections.map((section) => [section.key, section]));
    const prepared: PreparedSection[] = [];
    for (const section of request.sections) {
      const parsedBody = bodies.get(section.at)!;
      const footnotes: FootnoteRow[] = [];
      for (const footnote of section.footnotes) footnotes.push(await this.checkFootnote(ownerId, footnote, literals));
      const stats: WikiDocSectionStats = {
        sentences: parsedBody.sentences.length,
        footnotes: footnotes.length,
        verified: footnotes.filter((f) => f.verdict === 'verified').length,
        notFound: footnotes.filter((f) => f.verdict === 'not_found').length,
        noQuote: footnotes.filter((f) => f.verdict === 'no_quote').length,
        unresolved: footnotes.filter((f) => f.verdict === 'unresolved').length,
        markersDropped: parsedBody.markersDropped,
        chars: parsedBody.chars,
      };
      prepared.push({
        key: section.key,
        planSectionId: sectionOf.get(section.key)!.id,
        materialSha256: section.materialSha256,
        dispositions: section.dispositions.map((disposition) => ({ ...disposition, reason: redacted(disposition.reason, literals)! })),
        blocks: parsedBody.blocks.map((block) => (block.text === undefined ? block : { ...block, text: redacted(block.text, literals)! })),
        sentences: parsedBody.sentences.map((sentence) => ({
          ...sentence,
          text: redacted(sentence.text, literals)!,
          status: sentence.notes.length === 0 ? 'transition' : 'unverified',
          newTokens: [],
        })),
        footnotes,
        stats,
      });
    }

    const outcome = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        return this.store(tx, { ownerId, spaceId, plan, planDoc, request, prepared, viaIds });
      },
      loggedRetry(this.logger, 'wiki.writeDoc'),
    );
    if (outcome.written.length > 0) this.realtime?.publishWikiChanged(ownerId, spaceId);
    const statsOf = new Map(prepared.map((section) => [section.key, section.stats]));
    return {
      spaceId,
      slug,
      docId: outcome.docId,
      planVersion: plan.version,
      status: outcome.status,
      sections: request.sections.map((section) => {
        const written = outcome.written.includes(section.key);
        return { key: section.key, outcome: written ? 'written' : 'unchanged', stats: written ? statsOf.get(section.key)! : null };
      }),
      counts: outcome.counts,
    };
  }

  /**
   * One footnote checked (contract `docs.verification`). A record is read again among the account's own
   * rows, redacted, and the quote — redacted the same way — looked for in it; a repository original is
   * the runner's check at its sha, which the server has no checkout to repeat.
   */
  private async checkFootnote(ownerId: string, footnote: Footnote, literals: readonly string[]): Promise<FootnoteRow> {
    const quote = redacted(footnote.quote, literals);
    if (footnote.repo) {
      const locator: Record<string, unknown> = {};
      if (footnote.section) locator.section = footnote.section;
      if (footnote.symbol) locator.symbol = footnote.symbol;
      return {
        kind: footnote.kind,
        ref: footnote.path,
        sha: footnote.sha,
        lineStart: footnote.lineStart,
        lineEnd: footnote.lineEnd,
        charStart: null,
        charEnd: null,
        locator,
        quote,
        excerpt: redacted(footnote.excerpt, literals),
        verdict: quote === null ? 'no_quote' : footnote.verified ? 'verified' : 'not_found',
        checkedBy: 'runner',
        viaEntryId: footnote.viaEntryId,
      };
    }
    let ref: string | null = null;
    try {
      ref = toUuid(footnote.ref);
    } catch {
      // It names no record at all: unresolved, kept as it came.
    }
    const row: FootnoteRow = {
      kind: footnote.kind,
      ref: ref ?? footnote.ref,
      sha: null,
      lineStart: null,
      lineEnd: null,
      charStart: null,
      charEnd: null,
      locator: {},
      quote,
      excerpt: null,
      verdict: 'unresolved',
      checkedBy: 'server',
      viaEntryId: footnote.viaEntryId,
    };
    // The record's words as a source's quote reads them: one reader, so a document and an entry citing the
    // same record check their quotes against the same text (wiki-verify-evidence.ts).
    const reader: WikiPrincipal = { origin: 'maintenance', ownerId, userId: null, sessionId: null, toolCallId: null };
    const record = ref === null ? null : await this.wiki.sourceText(this.prisma, reader, { kind: footnote.kind as WikiSourceKind, ref });
    if (!record) return row;
    row.locator = { ...(await recordLink(this.prisma, ownerId, footnote.kind, record.ref)) };
    if (quote === null) return { ...row, verdict: 'no_quote' };
    const text = redacted(record.text, literals);
    const found = text === null ? null : findQuote(text, quote, footnote.chars);
    if (!found) return { ...row, verdict: 'not_found' };
    return { ...row, verdict: 'verified', charStart: found.start, charEnd: found.end };
  }

  /**
   * The transaction a write is (db-write-inventory `wiki.writeDoc`): its via entries FOR SHARE, the plan
   * checked again, the document made if it is new and locked, the sections that need it replaced, and
   * every sentence of the document classified again.
   */
  private async store(
    tx: Tx,
    input: {
      ownerId: string;
      spaceId: string;
      plan: PlanRow;
      planDoc: PlanDocRow;
      request: DocWrite;
      prepared: PreparedSection[];
      viaIds: string[];
    },
  ): Promise<{ docId: string; written: string[]; status: WikiDocStatus; counts: WikiDocSentenceCounts }> {
    const { ownerId, spaceId, plan, planDoc, request, prepared, viaIds } = input;
    // The via entries first, FOR SHARE and in id order: a rejection of one waits for this to commit and
    // then withdraws what it wrote (`wiki-doc-withdrawal.ts`), and what they are now decides what is withdrawn here.
    const standing = viaIds.length === 0
      ? []
      : await tx.$queryRaw<Array<{ id: string; status: string; anchorState: string | null }>>(Prisma.sql`
          SELECT e."id"::text AS "id", e."status" AS "status", e."anchor_state" AS "anchorState"
            FROM "wiki_entry" e
           WHERE e."owner_id" = ${ownerId}::uuid AND e."id" = ANY(${viaIds}::uuid[])
           ORDER BY e."id"
           FOR SHARE`);
    const withdrawn = new Map<string, WikiDocWithdrawReason>();
    for (const entry of standing) {
      const reason = docWithdrawReason(entry);
      if (reason) withdrawn.set(entry.id, reason);
    }
    const confirmed = await requireConfirmedPlan(tx, { ownerId, spaceId });
    if (confirmed.version !== plan.version) throw staleWrite(plan.version, confirmed.version);

    const now = new Date();
    await tx.$queryRaw(Prisma.sql`
      INSERT INTO "wiki_doc" ("id", "space_id", "owner_id", "slug", "plan_id", "plan_version", "plan_doc_id", "status", "repo_sha", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${spaceId}::uuid, ${ownerId}::uuid, ${planDoc.slug}, ${plan.id}::uuid, ${plan.version}, ${planDoc.id}::uuid, 'ok',
              ${request.repoSha}, ${now}, ${now})
      ON CONFLICT ("space_id", "slug") DO NOTHING
      RETURNING "id"`);
    const [doc] = await tx.$queryRaw<Array<{ id: string; planVersion: number }>>(Prisma.sql`
      SELECT "id"::text AS "id", "plan_version" AS "planVersion" FROM "wiki_doc"
       WHERE "space_id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid AND "slug" = ${planDoc.slug}
       FOR NO KEY UPDATE`);
    const stored = await tx.wikiDocSection.findMany({
      where: { docId: doc.id, ownerId },
      select: { id: true, key: true, materialSha256: true, staleAt: true, blocks: true },
    });
    const storedByKey = new Map(stored.map((section) => [section.key, section]));
    // Unchanged: the fingerprint it was written from, and nothing withdrawn from it since.
    const toWrite = prepared.filter((section) => {
      const old = storedByKey.get(section.key);
      return !old || old.materialSha256 !== section.materialSha256 || old.staleAt !== null;
    });
    const planKeys = new Set(planDoc.sections.map((section) => section.key));
    const dropped = stored.filter((section) => !planKeys.has(section.key));
    if (toWrite.length === 0 && dropped.length === 0 && doc.planVersion === plan.version) {
      const statuses = await tx.wikiDocSentence.findMany({ where: { ownerId, section: { docId: doc.id } }, select: { status: true } });
      const counts = countSentences(statuses.map((row) => row.status as WikiDocSentenceStatus));
      return { docId: doc.id, written: [], status: docStatusOf(counts), counts };
    }

    // Sections the plan's document no longer has, and the ones rewritten: their sentences and footnotes go with them.
    const replaced = new Set(toWrite.map((section) => section.key));
    const gone = [...dropped.map((section) => section.id), ...stored.filter((section) => replaced.has(section.key)).map((section) => section.id)];
    if (gone.length > 0) await tx.wikiDocSection.deleteMany({ where: { ownerId, docId: doc.id, id: { in: gone } } });

    // What stays: its headings and its sentences, as the classification reads them.
    const keptSections = stored.filter((section) => planKeys.has(section.key) && !replaced.has(section.key));
    const kept = keptSections.length === 0
      ? []
      : await tx.$queryRaw<Array<{ id: string; text: string; status: string; newTokens: string[]; marked: boolean }>>(Prisma.sql`
          SELECT s."id"::text AS "id", s."text" AS "text", s."status" AS "status", s."new_tokens" AS "newTokens",
                 EXISTS (SELECT 1 FROM "wiki_doc_footnote" f WHERE f."sentence_id" = s."id" AND f."owner_id" = s."owner_id") AS "marked"
            FROM "wiki_doc_sentence" s
           WHERE s."owner_id" = ${ownerId}::uuid AND s."section_id" = ANY(${keptSections.map((section) => section.id)}::uuid[])`);
    const headings = [
      ...planHeadings(planDoc),
      ...keptSections.flatMap((section) => (section.blocks as unknown as BodyBlock[]).filter((b) => b.kind === 'heading').map((b) => b.text ?? '')),
      ...toWrite.flatMap((section) => section.blocks.filter((b) => b.kind === 'heading').map((b) => b.text ?? '')),
    ];

    // The new sentences' own statuses: withdrawn through an entry that no longer stands, sourced by a
    // verified footnote, unverified when none is; the rest are classified with the whole document below.
    const withdrawals = new Map<PreparedSection['sentences'][number], { reason: WikiDocWithdrawReason; entryId: string }>();
    for (const section of toWrite) {
      for (const sentence of section.sentences) {
        if (sentence.notes.length === 0) continue;
        const cited = sentence.notes.map((n) => section.footnotes[n]);
        const through = cited.find((footnote) => footnote.viaEntryId !== null && withdrawn.has(footnote.viaEntryId));
        if (through) {
          sentence.status = 'withdrawn';
          withdrawals.set(sentence, { reason: withdrawn.get(through.viaEntryId!)!, entryId: through.viaEntryId! });
        } else {
          sentence.status = cited.some((footnote) => footnote.verdict === 'verified') ? 'sourced' : 'unverified';
        }
      }
    }
    const judged: Array<Judged & { keptId?: string; fresh?: PreparedSection['sentences'][number] }> = [
      ...kept.map((row) => ({ text: row.text, marked: row.marked, status: row.status as WikiDocSentenceStatus, newTokens: row.newTokens, keptId: row.id })),
      ...toWrite.flatMap((section) => section.sentences.map((sentence) => ({
        text: sentence.text,
        marked: sentence.notes.length > 0,
        status: sentence.status,
        newTokens: [] as string[],
        fresh: sentence,
      }))),
    ];
    const before = new Map(kept.map((row) => [row.id, `${row.status}|${row.newTokens.join(',')}`]));
    classifyDoc(headings, judged);
    const judgedOf = new Map(judged.filter((j) => j.fresh).map((j) => [j.fresh!, j]));

    for (const section of toWrite) {
      const sectionId = randomUUID();
      const stale = section.sentences.some((sentence) => withdrawals.has(sentence));
      await tx.wikiDocSection.create({
        data: {
          id: sectionId,
          docId: doc.id,
          ownerId,
          key: section.key,
          planSectionId: section.planSectionId,
          materialSha256: section.materialSha256,
          blocks: section.blocks as unknown as Prisma.InputJsonValue,
          repoSha: request.repoSha,
          model: request.model,
          stats: section.stats as unknown as Prisma.InputJsonValue,
          dispositions: section.dispositions as unknown as Prisma.InputJsonValue,
          generatedAt: now,
          staleAt: stale ? now : null,
        },
        select: { id: true },
      });
      const sentenceIds = section.sentences.map(() => randomUUID());
      await tx.wikiDocSentence.createMany({
        data: section.sentences.map((sentence, position) => {
          const verdict = judgedOf.get(sentence)!;
          const withdrawal = withdrawals.get(sentence);
          return {
            id: sentenceIds[position],
            sectionId,
            ownerId,
            position,
            block: sentence.block,
            text: sentence.text,
            status: verdict.status,
            newTokens: verdict.status === 'unsourced' ? verdict.newTokens : [],
            withdrawnAt: withdrawal ? now : null,
            withdrawnEntryId: withdrawal?.entryId ?? null,
            withdrawnReason: withdrawal?.reason ?? null,
          };
        }),
      });
      const footnotes = section.sentences.flatMap((sentence, position) =>
        sentence.notes.map((n, order) => {
          const footnote = section.footnotes[n];
          return {
            sentenceId: sentenceIds[position],
            ownerId,
            position: order,
            kind: footnote.kind,
            ref: footnote.ref,
            sha: footnote.sha,
            lineStart: footnote.lineStart,
            lineEnd: footnote.lineEnd,
            charStart: footnote.charStart,
            charEnd: footnote.charEnd,
            locator: footnote.locator as Prisma.InputJsonValue,
            quote: footnote.quote,
            excerpt: footnote.excerpt,
            verdict: footnote.verdict,
            checkedBy: footnote.checkedBy,
            viaEntryId: footnote.viaEntryId,
          };
        }),
      );
      if (footnotes.length > 0) await tx.wikiDocFootnote.createMany({ data: footnotes });
    }
    // The sentences that stayed and read differently now that the others changed.
    for (const sentence of judged) {
      if (!sentence.keptId || before.get(sentence.keptId) === `${sentence.status}|${sentence.newTokens.join(',')}`) continue;
      await tx.wikiDocSentence.updateMany({
        where: { id: sentence.keptId, ownerId, status: { in: ['transition', 'unsourced'] } },
        data: { status: sentence.status, newTokens: sentence.status === 'unsourced' ? sentence.newTokens : [] },
      });
    }
    const counts = countSentences(judged.map((sentence) => sentence.status));
    const status = docStatusOf(counts);
    await tx.wikiDoc.updateMany({
      where: { id: doc.id, ownerId },
      data: {
        planId: plan.id,
        planVersion: plan.version,
        planDocId: planDoc.id,
        status,
        repoSha: request.repoSha,
        updatedAt: now,
      },
    });
    return { docId: doc.id, written: toWrite.map((section) => section.key), status, counts };
  }

  // ── The owner's three reads ───────────────────────────────────────────────────────────────────

  /** The confirmed plan's categories and documents, as written so far (contract `docs.reads.directory`). */
  async directory(ownerId: string, spaceId: string): Promise<WikiDocsDirectory> {
    await this.requireSpace(ownerId, spaceId);
    const plan = await this.confirmedPlan(this.prisma, ownerId, spaceId);
    if (!plan) return { spaceId, plan: null, docs: { total: 0, written: 0 }, categories: [] };
    const docs = await this.prisma.wikiDoc.findMany({
      where: { ownerId, spaceId, slug: { in: plan.docs.map((doc) => doc.slug) } },
      select: { slug: true, status: true, updatedAt: true, planVersion: true, sections: { select: { key: true, staleAt: true } } },
    });
    const written = new Map(docs.map((doc) => [doc.slug, doc]));
    const numbers = numbering(plan);
    const categories = (plan.categories as unknown as PlanCategory[]) ?? [];
    return {
      spaceId,
      plan: { version: plan.version, confirmedAt: plan.confirmedAt!.toISOString() },
      docs: { total: plan.docs.length, written: docs.length },
      categories: categories.map((category, i) => ({
        key: category.key,
        number: i + 1,
        title: category.title,
        question: category.question ?? '',
        forAgents: category.forAgents ?? false,
        docs: plan.docs
          .filter((doc) => doc.category === category.key)
          .map((doc) => {
            const stored = written.get(doc.slug);
            const sections = new Map((stored?.sections ?? []).map((section) => [section.key, section]));
            return {
              slug: doc.slug,
              number: numbers.get(doc.slug)!.number,
              title: doc.title,
              question: doc.question,
              written: stored !== undefined,
              status: (stored?.status as WikiDocStatus | undefined) ?? null,
              updatedAt: stored?.updatedAt.toISOString() ?? null,
              planVersion: stored?.planVersion ?? null,
              sections: doc.sections.map((section, n) => ({
                key: section.key,
                number: n + 1,
                title: section.title,
                kind: section.kind as WikiPlanSectionKind,
                written: sections.has(section.key),
                stale: sections.get(section.key)?.staleAt != null,
              })),
            };
          }),
      })),
    };
  }

  /**
   * One document of the confirmed plan, its sentences with their statuses and its footnotes resolved for
   * the page (contract `docs.reads.doc`). One the plan does not have is a 404; one it has and nobody has
   * written yet is `written: false`.
   */
  async doc(ownerId: string, spaceId: string, slug: string): Promise<WikiDocView> {
    await this.requireSpace(ownerId, spaceId);
    const plan = await this.confirmedPlan(this.prisma, ownerId, spaceId);
    const planDoc = plan?.docs.find((doc) => doc.slug === slug);
    if (!plan || !planDoc) throw new NotFoundException('no such document in this space\'s plan');
    const numbers = numbering(plan);
    const stored = await this.prisma.wikiDoc.findFirst({
      where: { ownerId, spaceId, slug },
      select: {
        status: true,
        planVersion: true,
        repoSha: true,
        updatedAt: true,
        sections: {
          select: {
            key: true,
            blocks: true,
            repoSha: true,
            model: true,
            dispositions: true,
            generatedAt: true,
            staleAt: true,
            sentences: {
              orderBy: { position: 'asc' },
              select: {
                block: true,
                text: true,
                status: true,
                newTokens: true,
                withdrawnAt: true,
                withdrawnEntryId: true,
                withdrawnPath: true,
                withdrawnReason: true,
                footnotes: {
                  orderBy: { position: 'asc' },
                  select: {
                    kind: true,
                    ref: true,
                    sha: true,
                    lineStart: true,
                    lineEnd: true,
                    charStart: true,
                    charEnd: true,
                    locator: true,
                    quote: true,
                    excerpt: true,
                    verdict: true,
                    checkedBy: true,
                    viaEntryId: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const storedSections = new Map((stored?.sections ?? []).map((section) => [section.key, section]));

    // Footnotes numbered by first appearance: the same original, place and quote cited twice is one number.
    type StoredFootnote = NonNullable<typeof stored>['sections'][number]['sentences'][number]['footnotes'][number];
    const footnotes: Array<StoredFootnote & { n: number }> = [];
    const numberOf = new Map<string, number>();
    const noteOf = (footnote: StoredFootnote): number => {
      const key = JSON.stringify([
        footnote.kind, footnote.ref, footnote.sha, footnote.lineStart, footnote.lineEnd, footnote.charStart, footnote.charEnd,
        footnote.quote, footnote.verdict, footnote.viaEntryId,
      ]);
      let n = numberOf.get(key);
      if (n === undefined) {
        n = footnotes.length + 1;
        numberOf.set(key, n);
        footnotes.push({ ...footnote, n });
      }
      return n;
    };
    const statuses: WikiDocSentenceStatus[] = [];
    const sections: WikiDocSectionView[] = planDoc.sections.map((planSection, i) => {
      const section = storedSections.get(planSection.key);
      const blocks = ((section?.blocks as unknown as BodyBlock[] | undefined) ?? []).map((block) => ({
        kind: block.kind,
        text: block.text ?? null,
        sentences: [] as WikiDocSentenceView[],
      }));
      for (const sentence of section?.sentences ?? []) {
        const status = sentence.status as WikiDocSentenceStatus;
        statuses.push(status);
        blocks[sentence.block]?.sentences.push({
          text: sentence.text,
          status,
          notes: [...new Set(sentence.footnotes.map(noteOf))],
          newTokens: sentence.newTokens,
          withdrawn: sentence.withdrawnAt
            ? {
              reason: sentence.withdrawnReason as WikiDocWithdrawReason,
              entryId: sentence.withdrawnEntryId,
              path: sentence.withdrawnPath,
              at: sentence.withdrawnAt.toISOString(),
            }
            : null,
        });
      }
      return {
        key: planSection.key,
        number: i + 1,
        title: planSection.title,
        kind: planSection.kind as WikiPlanSectionKind,
        written: section !== undefined,
        stale: section?.staleAt != null,
        staleAt: section?.staleAt?.toISOString() ?? null,
        generatedAt: section?.generatedAt.toISOString() ?? null,
        repoSha: section?.repoSha ?? null,
        model: section?.model ?? null,
        dispositions: (section?.dispositions as unknown as WikiDocDisposition[] | undefined) ?? [],
        blocks,
      };
    });

    // What the page links to: the sessions, tasks and projects the records are in, and the via entries.
    const locators = footnotes.map((footnote) => footnote.locator as RecordLink);
    const ids = (pick: (link: RecordLink) => string | undefined): string[] =>
      [...new Set(locators.map(pick).filter((id): id is string => typeof id === 'string'))];
    const viaIds = [...new Set(footnotes.map((footnote) => footnote.viaEntryId).filter((id): id is string => id !== null))];
    const [sessions, tasks, projects, entries] = await Promise.all([
      ids((link) => link.sessionId).length === 0
        ? []
        : this.prisma.session.findMany({ where: { ownerId, id: { in: ids((link) => link.sessionId) } }, select: { id: true, title: true } }),
      ids((link) => link.taskId).length === 0
        ? []
        : this.prisma.task.findMany({ where: { ownerId, id: { in: ids((link) => link.taskId) } }, select: { id: true, title: true } }),
      ids((link) => link.projectId).length === 0
        ? []
        : this.prisma.project.findMany({ where: { ownerId, id: { in: ids((link) => link.projectId) } }, select: { id: true, title: true } }),
      viaIds.length === 0
        ? []
        : this.prisma.wikiEntry.findMany({
          where: { ownerId, id: { in: viaIds } },
          select: { id: true, kind: true, title: true, status: true, trust: true, anchorState: true },
        }),
    ]);
    const titleOf = (rows: Array<{ id: string; title: string }>) => new Map(rows.map((row) => [row.id, row.title]));
    const sessionTitles = titleOf(sessions);
    const taskTitles = titleOf(tasks);
    const projectTitles = titleOf(projects);

    const footnoteViews: WikiDocFootnoteView[] = footnotes.map((footnote) => {
      const link = footnote.locator as RecordLink & { section?: string; symbol?: string };
      const repo = footnote.sha !== null;
      return {
        n: footnote.n,
        kind: footnote.kind as WikiDocFootnoteKind,
        verdict: footnote.verdict as WikiDocVerdict,
        checkedBy: footnote.checkedBy as WikiDocChecker,
        quote: footnote.quote,
        location: repo
          ? `${footnote.ref}@${footnote.sha}#L${footnote.lineStart}-${footnote.lineEnd}`
          : `${footnote.kind}:${footnote.ref}${footnote.charStart !== null ? `#c${footnote.charStart}-${footnote.charEnd}` : ''}`,
        path: repo ? footnote.ref : null,
        sha: footnote.sha,
        lineStart: footnote.lineStart,
        lineEnd: footnote.lineEnd,
        section: repo ? (link.section ?? null) : null,
        symbol: repo ? (link.symbol ?? null) : null,
        excerpt: footnote.excerpt,
        recordId: repo ? null : footnote.ref,
        charStart: footnote.charStart,
        charEnd: footnote.charEnd,
        sessionId: link.sessionId ?? null,
        sessionTitle: link.sessionId ? (sessionTitles.get(link.sessionId) ?? null) : null,
        seq: link.seq ?? null,
        at: link.at ?? null,
        label: link.label ?? null,
        taskId: link.taskId ?? null,
        taskTitle: link.taskId ? (taskTitles.get(link.taskId) ?? null) : null,
        projectId: link.projectId ?? null,
        projectTitle: link.projectId ? (projectTitles.get(link.projectId) ?? null) : null,
        notePath: footnote.kind === 'note' ? (link.path ?? null) : null,
        viaEntryId: footnote.viaEntryId,
      };
    });
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const viaEntries: WikiDocViaEntry[] = viaIds
      .filter((id) => entryById.has(id))
      .map((id) => {
        const entry = entryById.get(id)!;
        return {
          id: entry.id,
          kind: entry.kind as WikiEntryKind,
          title: entry.title,
          status: entry.status as WikiEntryStatus,
          trust: entry.trust as WikiTrust,
          anchorState: entry.anchorState as WikiAnchorState,
          notes: footnoteViews.filter((footnote) => footnote.viaEntryId === id).map((footnote) => footnote.n),
        };
      });

    const counts = countSentences(statuses);
    const place = numbers.get(slug)!;
    const titles = new Map(plan.docs.map((doc) => [doc.slug, doc.title]));
    return {
      spaceId,
      slug,
      number: place.number,
      title: planDoc.title,
      question: planDoc.question,
      audience: planDoc.audience,
      scopeIn: planDoc.scopeIn,
      scopeOut: ((planDoc.scopeOut as unknown as Array<{ text: string; docs?: string[] }>) ?? []).map((scope) => ({
        text: scope.text,
        docs: (scope.docs ?? []).map((other) => ({ slug: other, number: numbers.get(other)?.number ?? null, title: titles.get(other) ?? null })),
      })),
      category: place.category,
      length: { min: planDoc.lengthMin, max: planDoc.lengthMax },
      planVersion: plan.version,
      written: stored !== null,
      status: (stored?.status as WikiDocStatus | undefined) ?? null,
      writtenFromPlanVersion: stored?.planVersion ?? null,
      repoSha: stored?.repoSha ?? null,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
      counts,
      unsourcedShare: unsourcedShare(counts),
      sections,
      footnotes: footnoteViews,
      entries: viaEntries,
    };
  }

  /**
   * Every document of the confirmed plan, and every section whose title no other document shares, in
   * title order (contract `docs.reads.index`).
   */
  async index(ownerId: string, spaceId: string): Promise<WikiDocsIndex> {
    await this.requireSpace(ownerId, spaceId);
    const plan = await this.confirmedPlan(this.prisma, ownerId, spaceId);
    if (!plan) return { spaceId, plan: null, items: [] };
    const docs = await this.prisma.wikiDoc.findMany({
      where: { ownerId, spaceId },
      select: { slug: true, sections: { select: { key: true } } },
    });
    const written = new Map(docs.map((doc) => [doc.slug, new Set(doc.sections.map((section) => section.key))]));
    const numbers = numbering(plan);
    // A title more than one document has is a generic one — known pitfalls, conventions, overview.
    const shared = new Map<string, Set<string>>();
    for (const doc of plan.docs) {
      for (const section of doc.sections) {
        const title = section.title.trim();
        shared.set(title, (shared.get(title) ?? new Set()).add(doc.slug));
      }
    }
    const items: WikiDocsIndexItem[] = [];
    for (const doc of plan.docs) {
      const place = numbers.get(doc.slug)!;
      const category = { key: place.category.key, title: place.category.title };
      items.push({
        kind: 'doc',
        title: doc.title,
        docSlug: doc.slug,
        docNumber: place.number,
        docTitle: doc.title,
        sectionKey: null,
        sectionNumber: null,
        category,
        written: written.has(doc.slug),
      });
      doc.sections.forEach((section, i) => {
        if ((shared.get(section.title.trim())?.size ?? 0) > 1) return;
        items.push({
          kind: 'section',
          title: section.title,
          docSlug: doc.slug,
          docNumber: place.number,
          docTitle: doc.title,
          sectionKey: section.key,
          sectionNumber: i + 1,
          category,
          written: written.get(doc.slug)?.has(section.key) ?? false,
        });
      });
    }
    items.sort((a, b) => {
      const x = a.title.toLowerCase();
      const y = b.title.toLowerCase();
      if (x !== y) return x < y ? -1 : 1;
      if (a.docNumber !== b.docNumber) return a.docNumber < b.docNumber ? -1 : 1;
      return (a.sectionNumber ?? 0) - (b.sectionNumber ?? 0);
    });
    return { spaceId, plan: { version: plan.version, confirmedAt: plan.confirmedAt!.toISOString() }, items };
  }
}

function staleWrite(named: number, confirmed: number): WikiRefusalError {
  return new WikiRefusalError({
    code: 'WIKI_PLAN_STALE',
    message:
      `this document was written from plan version ${named}, and the plan in force is version ${confirmed}: nothing was written. `
        + 'Read the plan again and write the document from the version the owner confirmed.',
  });
}
