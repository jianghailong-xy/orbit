import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  toUuid,
  WIKI_ARTICLE_CATEGORIES,
  WIKI_ARTICLE_ENTRIES_LISTED,
  WIKI_ARTICLE_KINDS,
  WIKI_ARTICLE_RULES,
  WIKI_DEFAULT_TOPICS,
  wikiArticleChars,
  type WikiArticleBlock,
  type WikiArticleCategory,
  type WikiArticleCitation,
  type WikiArticleDirectory,
  type WikiArticleDirectoryTopic,
  type WikiArticleFootnote,
  type WikiArticleIndex,
  type WikiArticleInput,
  type WikiArticleKind,
  type WikiArticlePartRef,
  type WikiArticlePlan,
  type WikiArticleStats,
  type WikiArticleView,
  type WikiArticleWriteResult,
  type WikiEntry,
  type WikiEntryKind,
  type WikiEntryStatus,
  type WikiTrust,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { currentWikiExecutorSwitch, wikiExecutorServes } from './wiki-executor-switch';
import { isWikiMaintenanceSession } from './wiki-maintenance-settings';
import { ENTRY_SELECT, entryView, WikiRefusalError, type WikiPrincipal } from './wiki.service';

/**
 * The articles (criterion 9; contracts/wiki.contract.json `articles`, migration 0317): each topic's
 * article, written by the local model from the topic's active entries, every sentence footnoted to one
 * of them — the view a person reads, over the entries that stay the store.
 *
 * WHAT THE SERVER DECIDES, AND WHAT IT DOES NOT. The model writes; this file decides everything that
 * can be decided without it. Which topic an entry is in (`assignTopics`: its anchors' paths first, the
 * slug it names second, its words last), the fingerprint of a topic's entry set (`entrySetSha256`),
 * whether a write would change anything, and what of the model's text survives (`validateArticlePart`:
 * a footnote must name an entry of the topic, a sentence must keep one, and an article stops at
 * `rules.maxChars`). So a write names the entries it was generated from, and the server checks them
 * against the topic as it stands rather than taking the writer's word for either.
 *
 * A VIEW, AND A CACHE. Nothing points at `wiki_topic_summary`: no source kind names it, so an article
 * can never be cited (sourceRules.firstHand); the push and the agent's search and get read
 * `wiki_entry` and nothing else, so an article reaches no agent. A topic's rows are replaced together,
 * and only when its entry set changed — no clock rewrites one (hard constraint 5).
 *
 * WHO WRITES. A Wiki maintenance run of the space (`isWikiMaintenanceSession`, the one test criterion
 * 2 exported) through the runner door, the wiki worker's `articles` job (origin `maintenance`, no
 * session, no user: `wikiArticlesJobPrincipal`), and an import the API server's container runs itself
 * for a preview space (origin `import`, no session, no user). No door builds the last two: they exist
 * only for code running in the server's own processes. The owner reads, on the user door, and writes
 * nothing here — an article is the model's summary of what the owner can edit, the entries.
 *
 * NOT A SESSIONS OR PROJECTS DEPENDENCY: this reads the wiki's rows and one session row, through
 * Prisma, like the maintenance routes beside it.
 */

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A path as topics' prefixes are written: relative to the repository. A checkout's absolute prefix —
 * a worktree's `…/.orbit/worktrees/<id>/`, or `/root/orbit/` — and a leading `./` are dropped
 * (contract `articles.membership.paths`).
 */
export function wikiRepoPath(path: string): string {
  let out = path.trim().replace(/\\/gu, '/');
  out = out.replace(/^.*?\/\.orbit\/worktrees\/[^/]+\//u, '');
  out = out.replace(/^\/root\/orbit\//u, '');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/**
 * Every repo-relative path an entry names: its path and symbol anchors, a pitfall's trigger paths,
 * and a convention's scope up to its first wildcard. In the order it names them, once each.
 */
export function wikiEntryPaths(entry: { kind: string; anchors: unknown; trigger?: unknown; scope?: unknown }): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const path = wikiRepoPath(value);
    if (path && !out.includes(path)) out.push(path);
  };
  if (Array.isArray(entry.anchors)) {
    for (const anchor of entry.anchors) {
      const shaped = anchor as { type?: unknown; path?: unknown } | null;
      if (shaped && (shaped.type === 'path' || shaped.type === 'symbol')) add(shaped.path);
    }
  }
  if (entry.kind === 'pitfall') {
    const paths = (entry.trigger as { paths?: unknown } | null | undefined)?.paths;
    if (Array.isArray(paths)) paths.forEach(add);
  }
  if (entry.kind === 'convention' && Array.isArray(entry.scope)) {
    for (const glob of entry.scope) {
      if (typeof glob !== 'string') continue;
      const cut = glob.search(/[*?[{]/u);
      add(cut === -1 ? glob : glob.slice(0, cut));
    }
  }
  return out;
}

// ── Membership: which topic an entry is in ──────────────────────────────────────────────────────

/** What membership reads of an entry. */
export interface MemberEntry {
  id: string;
  revision: number;
  title: string;
  summary: string;
  aliases: readonly string[];
  /** The slugs it names itself. */
  topics: readonly string[];
  paths: readonly string[];
}

/** What membership reads of a topic. */
export interface MemberTopic {
  slug: string;
  title: string;
  description: string | null;
  pathPrefixes: readonly string[];
}

/** How an entry came to be in its topic, in the order the steps are tried. */
export type MembershipStep = 'paths' | 'declared' | 'text';

export interface Membership {
  /** Entry id → the slug of the one topic it is in. An entry no step placed is absent. */
  topicOf: Map<string, string>;
  /** Entry id → the step that placed it. */
  how: Map<string, MembershipStep>;
  /** Slug → its entries, in the order they were given. */
  bySlug: Map<string, MemberEntry[]>;
  unassigned: number;
}

/**
 * The words and CJK bigrams of a text — the demo's tokens for title and summary text — counted by
 * their number in `vocabulary`, which numbers each token the first time any text meets it (`df` grows
 * beside it). A word is ASCII and a bigram is two Han characters, so the two never share a token.
 */
function tokenCounts(text: string, vocabulary: Map<string, number>, df: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  const add = (token: string): void => {
    let id = vocabulary.get(token);
    if (id === undefined) {
      id = vocabulary.size;
      vocabulary.set(token, id);
      df.push(0);
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z_][a-z0-9_.-]{2,}/gu)) add(match[0].replace(/[.-]+$/u, ''));
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/gu)) {
    const run = match[0];
    for (let i = 0; i + 1 < run.length; i += 1) add(run.slice(i, i + 2));
  }
  return counts;
}

/**
 * How much of `path` one of a topic's patterns claims (contract `articles.membership.paths`): the
 * prefix's length when the path starts with it — a prefix that ends in `/` also names the directory
 * itself, as an anchor at `src/web` names what `src/web/` does — and, for a pattern that starts with
 * `*`, the length of the rest when the path ends with it (`*.swift` claims a bare `ConsoleModel.swift`).
 * 0 when it claims nothing. The longest claim wins, so a directory's prefix outranks a suffix.
 */
export function pathClaim(path: string, pattern: string): number {
  if (pattern === '' || pattern === '*') return 0;
  if (pattern.startsWith('*')) return path.endsWith(pattern.slice(1)) ? pattern.length - 1 : 0;
  if (path.startsWith(pattern)) return pattern.length;
  if (pattern.endsWith('/') && path === pattern.slice(0, -1)) return pattern.length;
  return 0;
}

/**
 * Put each entry in exactly one topic (contract `articles.membership.order`):
 *
 *   1. PATHS. Each path the entry names votes for the topic with the longest claim on it
 *      (`pathClaim`); the most votes win, then the longer claim, then the earlier topic. Where an entry is anchored
 *      in the code is the better witness of what it is about than its wording — the demo's topics,
 *      filed by words, collected articles on database writes under "sessions".
 *   2. DECLARED. Failing that, the first slug the entry names that is a topic of the space.
 *   3. TEXT. Failing that, the topic whose words it is closest to: tf-idf cosine over words and CJK
 *      bigrams, against each topic's own title and description plus the entries the first two
 *      steps placed there. An entry close to none is in no topic.
 *
 * Deterministic: the same entries and topics, in the same order, give the same answer.
 */
export function assignTopics(entries: readonly MemberEntry[], topics: readonly MemberTopic[]): Membership {
  const topicOf = new Map<string, string>();
  const how = new Map<string, MembershipStep>();
  const index = new Map(topics.map((topic, i) => [topic.slug, i]));
  const pending: MemberEntry[] = [];

  // Every topic's patterns, longest first: the first that claims a path claims the most of it. A path
  // several entries name is claimed once.
  const patterns = topics
    .flatMap((topic, i) => topic.pathPrefixes.map((pattern) => ({ i, pattern, length: pattern.startsWith('*') ? pattern.length - 1 : pattern.length })))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length || a.i - b.i);
  const claimed = new Map<string, { i: number; length: number } | null>();
  const claimOf = (path: string): { i: number; length: number } | null => {
    let known = claimed.get(path);
    if (known === undefined) {
      known = null;
      for (const p of patterns) {
        if (pathClaim(path, p.pattern) > 0) {
          known = { i: p.i, length: p.length };
          break;
        }
      }
      claimed.set(path, known);
    }
    return known;
  };

  for (const entry of entries) {
    const votes = new Map<number, { count: number; longest: number }>();
    for (const path of entry.paths) {
      const claim = claimOf(path);
      if (!claim) continue;
      const vote = votes.get(claim.i) ?? { count: 0, longest: 0 };
      vote.count += 1;
      vote.longest = Math.max(vote.longest, claim.length);
      votes.set(claim.i, vote);
    }
    let winner = -1;
    let won = { count: 0, longest: 0 };
    for (const [i, vote] of votes) {
      const better = vote.count > won.count
        || (vote.count === won.count && vote.longest > won.longest)
        || (vote.count === won.count && vote.longest === won.longest && i < winner);
      if (winner < 0 || better) {
        winner = i;
        won = vote;
      }
    }
    if (winner >= 0) {
      topicOf.set(entry.id, topics[winner].slug);
      how.set(entry.id, 'paths');
      continue;
    }
    const declared = entry.topics.find((slug) => index.has(slug));
    if (declared !== undefined) {
      topicOf.set(entry.id, declared);
      how.set(entry.id, 'declared');
      continue;
    }
    pending.push(entry);
  }

  if (pending.length > 0) {
    // Tokens numbered as they are first met, so a vector is two typed arrays and a topic's centroid
    // one dense array: an 11,000-entry space is scored in a fraction of a second instead of seconds
    // of string-keyed maps on the request's thread.
    const vocabulary = new Map<string, number>();
    const df: number[] = [];
    const tokenize = (text: string): Map<number, number> => tokenCounts(text, vocabulary, df);
    const entryText = (entry: MemberEntry): string => `${entry.title} ${entry.summary} ${entry.aliases.join(' ')}`;
    const topicText = (topic: MemberTopic): string =>
      `${topic.title} ${topic.description ?? ''} ${topic.slug.replace(/-/gu, ' ')}`;
    const entryCounts = entries.map((entry) => tokenize(entryText(entry)));
    const topicCounts = topics.map((topic) => tokenize(topicText(topic)));
    for (const counts of [...entryCounts, ...topicCounts]) for (const id of counts.keys()) df[id] += 1;
    // Inverse document frequency over every entry and every topic's own text.
    const documents = entries.length + topics.length;
    const idf = Float64Array.from(df, (n) => Math.log(1 + documents / n));
    const weigh = (counts: Map<number, number>): { ids: Int32Array; weights: Float64Array } => {
      const ids = new Int32Array(counts.size);
      const weights = new Float64Array(counts.size);
      let at = 0;
      let norm = 0;
      for (const [id, count] of counts) {
        const weight = count * idf[id];
        ids[at] = id;
        weights[at] = weight;
        norm += weight * weight;
        at += 1;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let j = 0; j < weights.length; j += 1) weights[j] /= norm;
      return { ids, weights };
    };
    const size = vocabulary.size;
    const centroids = topics.map((_topic, i) => {
      const centroid = new Float64Array(size);
      const own = weigh(topicCounts[i]);
      for (let j = 0; j < own.ids.length; j += 1) centroid[own.ids[j]] += own.weights[j];
      return centroid;
    });
    entries.forEach((entry, at) => {
      const slug = topicOf.get(entry.id);
      if (slug === undefined) return;
      const centroid = centroids[index.get(slug)!];
      const vector = weigh(entryCounts[at]);
      for (let j = 0; j < vector.ids.length; j += 1) centroid[vector.ids[j]] += vector.weights[j];
    });
    for (const centroid of centroids) {
      let norm = 0;
      for (let j = 0; j < size; j += 1) norm += centroid[j] * centroid[j];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let j = 0; j < size; j += 1) centroid[j] /= norm;
    }
    const position = new Map(entries.map((entry, at) => [entry.id, at]));
    for (const entry of pending) {
      const vector = weigh(entryCounts[position.get(entry.id)!]);
      let best = -1;
      let bestScore = 0;
      centroids.forEach((centroid, i) => {
        let score = 0;
        for (let j = 0; j < vector.ids.length; j += 1) score += centroid[vector.ids[j]] * vector.weights[j];
        if (score > bestScore) {
          best = i;
          bestScore = score;
        }
      });
      if (best < 0) continue;
      topicOf.set(entry.id, topics[best].slug);
      how.set(entry.id, 'text');
    }
  }

  const bySlug = new Map<string, MemberEntry[]>(topics.map((topic) => [topic.slug, []]));
  for (const entry of entries) {
    const slug = topicOf.get(entry.id);
    if (slug !== undefined) bySlug.get(slug)!.push(entry);
  }
  return { topicOf, how, bySlug, unassigned: entries.length - topicOf.size };
}

/**
 * The fingerprint of an entry set (contract `articles.fingerprint`): sha256 of `<id>:<revision>`,
 * one line each, sorted by id. An entry that joins, leaves or is amended changes it.
 */
export function entrySetSha256(entries: ReadonlyArray<{ id: string; revision: number }>): string {
  const lines = entries.map((entry) => `${entry.id}:${entry.revision}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// ── Validation: what of the model's text survives ───────────────────────────────────────────────

/** A part as validated: its blocks, the entries its footnotes name in order, and what was done. */
export interface ValidatedPart {
  blocks: WikiArticleBlock[];
  /** The entry behind each footnote number, in order: footnote n is cited[n - 1]. */
  cited: string[];
  stats: WikiArticleStats;
}

const MARKER = /\[(\d{1,3})\]/gu;
/** Full-width stops end a sentence wherever they stand. */
const TERMINALS = new Set(['。', '！', '？']);
const CLOSERS = new Set(['」', '』', '"', '”', '’', '）', ')']);

/**
 * The text outside backtick code spans, with the spans kept whole: a `[0]` inside `arr[0]` is code,
 * never a footnote, and a `?` inside a code span ends no sentence.
 */
function outsideCode(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const parts = text.split('`');
  parts.forEach((part, i) => {
    // An unmatched last backtick leaves an odd tail: read it as prose.
    const code = i % 2 === 1 && i < parts.length - 1;
    if (part === '' && !code) return;
    out.push({ code, text: code ? `\`${part}\`` : part });
  });
  return out;
}

/**
 * One line of prose cut into sentences (contract `articles.validation.sentences`): at 。！？, and at
 * a full stop or an ASCII ? or ! followed by a space or the end of the line, outside code spans. An
 * ASCII ? or ! that follows a space or another ? or ! ends nothing: that is code a model left outside
 * backticks (`lastTurnAt ?? createdAt`, `a != b`), and cutting there leaves half a sentence. Closing
 * quotes and brackets, and the footnote markers that follow, stay with the sentence they close.
 */
export function splitSentences(line: string): string[] {
  const out: string[] = [];
  const chars = Array.from(line);
  let current = '';
  let inCode = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    current += ch;
    if (ch === '`') {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const atBreak = i + 1 === chars.length || /\s/u.test(chars[i + 1]);
    const ends = TERMINALS.has(ch)
      || (ch === '.' && atBreak)
      || ((ch === '?' || ch === '!') && atBreak && i > 0 && !/[\s?!]/u.test(chars[i - 1]));
    if (!ends) continue;
    let j = i + 1;
    for (;;) {
      if (j < chars.length && CLOSERS.has(chars[j])) {
        current += chars[j];
        j += 1;
        continue;
      }
      const marker = /^\s*\[\d{1,3}\]/u.exec(chars.slice(j).join(''));
      if (marker) {
        current += marker[0];
        j += Array.from(marker[0]).length;
        continue;
      }
      break;
    }
    out.push(current);
    current = '';
    i = j - 1;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

/** Footnote markers out of prose, and the space a marker leaves before punctuation. The documents cut theirs the same way (`wiki-docs.ts`). */
export function withoutMarkers(text: string): string {
  return outsideCode(text)
    .map((segment) => (segment.code ? segment.text : segment.text.replace(/\s*\[\d{1,3}\]/gu, '')))
    .join('')
    .replace(/\s+([。！？，；：.,;:!?）)」』])/gu, '$1')
    .trim();
}

/** The footnote numbers a piece of prose carries, outside its code spans, in order. */
export function markersOf(text: string): number[] {
  const out: number[] = [];
  for (const segment of outsideCode(text)) {
    if (segment.code) continue;
    for (const match of segment.text.matchAll(MARKER)) out.push(Number(match[1]));
  }
  return out;
}

const blockChars = (block: WikiArticleBlock): number =>
  block.sentences.reduce((sum, sentence) => sum + wikiArticleChars(sentence.text), 0);

/**
 * What of one part survives (contract `articles.validation`):
 *
 *   - a marker [n] survives only when notes[n-1] names an entry in `allowed` — the topic's entries; one
 *     out of range, naming another topic's entry, or naming nothing (`null`: not an id at all) is
 *     stripped;
 *   - a sentence left with no marker is deleted;
 *   - past `maxChars`, the last sentence of the longest block that has more than one is dropped until
 *     the rest fit;
 *   - the footnotes are renumbered 1, 2, … in the order they first appear.
 *
 * The first first-level heading is the model's title for the whole, not part of the body; every other
 * heading starts a block.
 */
export function validateArticlePart(
  markdown: string,
  notes: ReadonlyArray<string | null>,
  allowed: ReadonlySet<string>,
  maxChars: number,
): ValidatedPart {
  const stats: WikiArticleStats = {
    sentences: 0,
    sentencesDeleted: 0,
    markers: 0,
    markersStripped: 0,
    sentencesTrimmed: 0,
    chars: 0,
    footnotes: 0,
  };
  const drafts: Array<{ heading: string | null; sentences: Array<{ text: string; entries: string[] }> }> = [];
  let sawTitle = false;
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    const heading = /^(#{1,6})\s*(.*?)\s*#*$/u.exec(line);
    if (heading) {
      if (heading[1].length === 1 && !sawTitle) {
        sawTitle = true;
        continue;
      }
      const text = withoutMarkers(heading[2]).replace(/^\*\*(.*)\*\*$/u, '$1').trim();
      drafts.push({ heading: text === '' ? null : text, sentences: [] });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/u.test(line)) continue;
    if (drafts.length === 0) drafts.push({ heading: null, sentences: [] });
    const prose = line.replace(/^(?:[-*+]|\d+[.)])\s+/u, '').replace(/^>\s*/u, '');
    for (const sentence of splitSentences(prose)) {
      const markers = markersOf(sentence);
      const text = withoutMarkers(sentence);
      stats.markers += markers.length;
      // A run of markers with nothing around them is not a sentence anybody wrote.
      if (!/[\p{L}\p{N}]/u.test(text)) {
        stats.markersStripped += markers.length;
        continue;
      }
      stats.sentences += 1;
      const entries: string[] = [];
      for (const n of markers) {
        const id = n >= 1 && n <= notes.length ? notes[n - 1] : null;
        if (id === null || !allowed.has(id)) {
          stats.markersStripped += 1;
          continue;
        }
        if (!entries.includes(id)) entries.push(id);
      }
      if (entries.length === 0) {
        stats.sentencesDeleted += 1;
        continue;
      }
      drafts[drafts.length - 1].sentences.push({ text, entries });
    }
  }
  const kept = drafts.filter((draft) => draft.sentences.length > 0);

  // The cap: the tail of the longest block goes first, and a lone sentence is never cut in half.
  let total = kept.reduce((sum, draft) => sum + draft.sentences.reduce((n, s) => n + wikiArticleChars(s.text), 0), 0);
  while (total > maxChars) {
    let pick = -1;
    let pickChars = -1;
    kept.forEach((draft, i) => {
      if (draft.sentences.length < 2) return;
      const chars = draft.sentences.reduce((n, s) => n + wikiArticleChars(s.text), 0);
      if (chars >= pickChars) {
        pick = i;
        pickChars = chars;
      }
    });
    if (pick < 0) {
      if (kept.length <= 1) break;
      const dropped = kept.pop()!;
      stats.sentencesTrimmed += dropped.sentences.length;
      total -= dropped.sentences.reduce((n, s) => n + wikiArticleChars(s.text), 0);
      continue;
    }
    const dropped = kept[pick].sentences.pop()!;
    stats.sentencesTrimmed += 1;
    total -= wikiArticleChars(dropped.text);
  }

  const cited: string[] = [];
  const blocks: WikiArticleBlock[] = kept.map((draft) => ({
    heading: draft.heading,
    sentences: draft.sentences.map((sentence) => ({
      text: sentence.text,
      notes: sentence.entries.map((id) => {
        let n = cited.indexOf(id);
        if (n < 0) {
          cited.push(id);
          n = cited.length - 1;
        }
        return n + 1;
      }),
    })),
  }));
  stats.chars = blocks.reduce((sum, block) => sum + blockChars(block), 0);
  stats.footnotes = cited.length;
  return { blocks, cited, stats };
}

/** The sum of several parts' statistics: what a whole write did. */
export function sumStats(all: readonly WikiArticleStats[]): WikiArticleStats {
  const sum: WikiArticleStats = {
    sentences: 0,
    sentencesDeleted: 0,
    markers: 0,
    markersStripped: 0,
    sentencesTrimmed: 0,
    chars: 0,
    footnotes: 0,
  };
  for (const stats of all) {
    for (const key of Object.keys(sum) as Array<keyof WikiArticleStats>) sum[key] += stats[key];
  }
  return sum;
}

// ── A write's body, read ────────────────────────────────────────────────────────────────────────

interface ParsedPart {
  part: number;
  kind: WikiArticleKind;
  title: string;
  markdown: string;
  /** Each note as an entry uuid, or null when it is not an id at all. */
  notes: Array<string | null>;
  entries: string[] | null;
}

interface ParsedWrite {
  entrySetSha256: string;
  ref: string | null;
  model: string | null;
  parts: ParsedPart[];
}

function asUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return toUuid(value.trim());
  } catch {
    return null;
  }
}

function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be a string`);
  const text = value.trim();
  if (text === '') return null;
  if (wikiArticleChars(text) > 200) throw new BadRequestException(`${name} is at most 200 characters`);
  return text;
}

/**
 * The write's body, checked for shape: a fingerprint, part 0 (an article, or an overview with
 * subtopic parts 1… after it), each part's Markdown and notes. What the parts SAY is validated
 * afterwards, against the topic (`validateArticlePart`).
 */
export function parseArticleWrite(body: unknown): ParsedWrite {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('the body is an object: { entrySetSha256, articles: [...] }');
  }
  const raw = body as Record<string, unknown>;
  const sha = typeof raw.entrySetSha256 === 'string' ? raw.entrySetSha256.trim() : '';
  if (!/^[0-9a-f]{64}$/u.test(sha)) {
    throw new BadRequestException('entrySetSha256 must be the fingerprint the input route gave: 64 lowercase hex characters');
  }
  const articles = raw.articles;
  if (!Array.isArray(articles) || articles.length === 0 || articles.length > WIKI_ARTICLE_RULES.groupsMax + 1) {
    throw new BadRequestException(`articles must be 1 to ${WIKI_ARTICLE_RULES.groupsMax + 1} parts`);
  }
  const parts: ParsedPart[] = articles.map((value, i) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`articles[${i}] must be an object`);
    const item = value as Record<string, unknown>;
    const part = item.part;
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part > WIKI_ARTICLE_RULES.groupsMax) {
      throw new BadRequestException(`articles[${i}].part must be a whole number from 0 to ${WIKI_ARTICLE_RULES.groupsMax}`);
    }
    const kind = item.kind;
    if (typeof kind !== 'string' || !(WIKI_ARTICLE_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`articles[${i}].kind must be one of ${WIKI_ARTICLE_KINDS.join(', ')}`);
    }
    if ((kind === 'subtopic') !== (part >= 1)) {
      throw new BadRequestException(`articles[${i}]: part 0 is the article or the overview, and every later part a subtopic`);
    }
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/gu, ' ').trim() : '';
    if (title === '') throw new BadRequestException(`articles[${i}].title is required`);
    const markdown = item.markdown;
    if (typeof markdown !== 'string' || wikiArticleChars(markdown) > WIKI_ARTICLE_RULES.markdownMaxChars) {
      throw new BadRequestException(`articles[${i}].markdown must be text of at most ${WIKI_ARTICLE_RULES.markdownMaxChars} characters`);
    }
    const notes = item.notes;
    if (!Array.isArray(notes) || notes.length > 500) throw new BadRequestException(`articles[${i}].notes must be a list of at most 500 entry ids`);
    let entries: string[] | null = null;
    if (kind === 'subtopic') {
      if (!Array.isArray(item.entries) || item.entries.length === 0 || item.entries.length > 5_000) {
        throw new BadRequestException(`articles[${i}].entries must name the entries of its subtopic`);
      }
      entries = [...new Set(item.entries.map(asUuid).filter((id): id is string => id !== null))];
    }
    return {
      part,
      kind: kind as WikiArticleKind,
      title: cutChars(title, WIKI_ARTICLE_RULES.titleMaxChars),
      markdown,
      notes: notes.map(asUuid),
      entries,
    };
  });
  const numbers = parts.map((part) => part.part);
  if (new Set(numbers).size !== numbers.length) throw new BadRequestException('each part number appears once');
  const lead = parts.find((part) => part.part === 0);
  if (!lead) throw new BadRequestException('part 0, the article or the overview, is required');
  const subtopics = parts.filter((part) => part.part >= 1);
  if (lead.kind === 'article' && subtopics.length > 0) {
    throw new BadRequestException('a topic written as one article has no subtopic parts: make part 0 an overview');
  }
  if (lead.kind === 'overview' && subtopics.length === 0) {
    throw new BadRequestException('an overview comes with the subtopic articles it points at');
  }
  return {
    entrySetSha256: sha,
    ref: optionalText(raw.ref, 'ref'),
    model: optionalText(raw.model, 'model'),
    parts: [lead, ...subtopics.sort((a, b) => a.part - b.part)],
  };
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

/** A topic row as the articles read it. */
interface TopicRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  pathPrefixes: string[];
}

/** The directory's order within a category: the default topics' own, then by name. */
const DEFAULT_ORDER = new Map(WIKI_DEFAULT_TOPICS.map((topic, i) => [topic.slug, i]));

function byDirectoryOrder(a: { slug: string; title: string }, b: { slug: string; title: string }): number {
  const ai = DEFAULT_ORDER.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
  const bi = DEFAULT_ORDER.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.title < b.title ? -1 : a.title > b.title ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

const CATEGORY_TITLE = new Map<string, string>(WIKI_ARTICLE_CATEGORIES.map((c) => [c.key, c.title]));

function asCategory(value: string | null): WikiArticleCategory | null {
  return value !== null && CATEGORY_TITLE.has(value) ? (value as WikiArticleCategory) : null;
}

/** The spaces whose membership is kept at once: a maintenance run works one space at a time. */
const WIKI_MEMBERSHIPS_KEPT = 8;

/**
 * The principal the server's `articles` job reads and writes a space's articles as (contract
 * `articles.who.write`, `jobs.kindRuns.articles`): the space's maintenance, with no session and no user —
 * the server writes on its own account — and its revisions, were it to make any, authored `system`.
 */
export function wikiArticlesJobPrincipal(ownerId: string): WikiPrincipal {
  return { origin: 'maintenance', ownerId, userId: null, sessionId: null, toolCallId: null, authorKind: 'system' };
}

@Injectable()
export class WikiArticles {
  private readonly logger = new Logger(WikiArticles.name);

  /** Each space's last membership, by what it was computed from (`membership`). */
  private readonly memberships = new Map<string, { signature: string; members: Membership }>();

  constructor(
    private readonly prisma: PrismaService,
    // `wiki.changed` after a write commits (contract `realtime.publishedWhen`): an accelerant, and
    // defaulted so a spec that builds this by hand need not stub it. `RealtimeModule` is global.
    private readonly realtime: RealtimeService = undefined as unknown as RealtimeService,
  ) {}

  // ── Who asks ──────────────────────────────────────────────────────────────────────────────────

  /** Another owner's space is the plain 404 every tenancy check answers (contract `refusalRules.notFound`). */
  private async requireSpace(ownerId: string, spaceId: string): Promise<void> {
    const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { id: true } });
    if (!space) throw new NotFoundException('no such wiki space');
  }

  /**
   * The writers (contract `articles.who.write`): a maintenance run of this space, asked the one test
   * criterion 2 exported, the server's own `articles` job, or the import the server's own container
   * runs. The space is found first, so another owner's is a 404 before it is anything else.
   */
  async assertWriter(principal: WikiPrincipal, spaceId: string): Promise<void> {
    await this.requireSpace(principal.ownerId, spaceId);
    if (principal.origin === 'import' && principal.sessionId === null && principal.userId === null) return;
    // The server's articles job (`wikiArticlesJobPrincipal`): maintenance with no session and no user,
    // which no door builds — the runner door refuses a headless call before it names a principal.
    if (principal.origin === 'maintenance' && principal.sessionId === null && principal.userId === null) return;
    if (
      principal.origin === 'maintenance'
      && principal.sessionId !== null
      && (await isWikiMaintenanceSession(this.prisma, { ownerId: principal.ownerId, sessionId: principal.sessionId, spaceId }))
    ) {
      // An account the executor switch gives the server has its articles written by the wiki worker, with
      // the deployment's System model (contract `articles.serverExecution`): its maintenance session is
      // handed nothing to write from and writes nothing, so no session's provider is asked. Under the
      // default runner this is never true, and the session writes exactly as it always has.
      const executor = currentWikiExecutorSwitch();
      if (wikiExecutorServes(executor, principal.ownerId)) {
        throw new WikiRefusalError({
          code: 'WIKI_SERVER_EXECUTES',
          message:
            `the Orbit server writes this account's wiki articles (ORBIT_WIKI_EXECUTOR=${executor.mode}): its wiki worker `
              + "writes them after a maintenance run, with the deployment's System model, so this session's provider is not "
              + 'asked. Nothing was read or written.',
        });
      }
      return;
    }
    throw new WikiRefusalError({
      code: 'WIKI_NOT_MAINTENANCE_SESSION',
      message:
        "only a Wiki maintenance run of this space writes its articles — a session whose task is in the space's hidden "
          + '«Wiki maintenance» list — or an import the server runs itself. This caller is neither.',
    });
  }

  // ── What the space holds ──────────────────────────────────────────────────────────────────────

  private async topicsOf(ownerId: string, spaceId: string): Promise<TopicRow[]> {
    const rows = await this.prisma.wikiTopic.findMany({
      where: { ownerId, spaceId },
      select: { id: true, slug: true, title: true, description: true, category: true, pathPrefixes: true },
    });
    return rows.sort(byDirectoryOrder);
  }

  /** The space's active, untainted entries, as membership reads them, in id order. */
  private async memberEntries(ownerId: string, spaceId: string): Promise<MemberEntry[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      revision: number;
      kind: string;
      title: string;
      summary: string;
      aliases: string[];
      topics: string[];
      anchors: unknown;
      trigger: unknown;
      scope: unknown;
    }>>(Prisma.sql`
      SELECT e."id"::text AS "id",
             e."current_revision" AS "revision",
             e."kind" AS "kind",
             e."title" AS "title",
             e."summary" AS "summary",
             e."aliases" AS "aliases",
             e."topics" AS "topics",
             e."anchors" AS "anchors",
             e."fields" -> 'trigger' AS "trigger",
             e."fields" -> 'scope' AS "scope"
        FROM "wiki_entry" e
       WHERE e."owner_id" = ${ownerId}::uuid
         AND e."space_id" = ${spaceId}::uuid
         AND e."status" = 'active'
         AND NOT e."tainted"
       ORDER BY e."id"
    `);
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      title: row.title,
      summary: row.summary,
      aliases: row.aliases ?? [],
      topics: row.topics ?? [],
      paths: wikiEntryPaths(row),
    }));
  }

  /**
   * Which topic each of the space's entries is in. A run asks for its plan, then each topic's input,
   * then writes each topic, and every one of those needs the whole space's membership: it is
   * computed once and kept against what it was computed from — the topics as defined and every
   * entry's id and revision, which is all `assignTopics` reads (an entry's words and paths change
   * only with a new revision) — so the next ask of an unchanged space reuses it.
   */
  private async membership(ownerId: string, spaceId: string): Promise<{ topics: TopicRow[]; entries: MemberEntry[]; members: Membership }> {
    const [topics, entries] = await Promise.all([this.topicsOf(ownerId, spaceId), this.memberEntries(ownerId, spaceId)]);
    const hash = createHash('sha256');
    for (const topic of topics) hash.update(`${JSON.stringify([topic.slug, topic.title, topic.description, topic.pathPrefixes])}\n`);
    hash.update('--\n');
    for (const entry of entries) hash.update(`${entry.id}:${entry.revision}\n`);
    const signature = hash.digest('hex');
    const key = `${ownerId}:${spaceId}`;
    const kept = this.memberships.get(key);
    if (kept?.signature === signature) return { topics, entries, members: kept.members };
    const members = assignTopics(entries, topics);
    this.memberships.delete(key);
    this.memberships.set(key, { signature, members });
    while (this.memberships.size > WIKI_MEMBERSHIPS_KEPT) this.memberships.delete(this.memberships.keys().next().value!);
    return { topics, entries, members };
  }

  /** Each topic's part 0: the fingerprint it was written from, and when. */
  private async leads(ownerId: string, topicIds: readonly string[]): Promise<Map<string, { sha: string; generatedAt: Date }>> {
    if (topicIds.length === 0) return new Map();
    const rows = await this.prisma.wikiTopicSummary.findMany({
      where: { ownerId, topicId: { in: [...topicIds] }, part: 0 },
      select: { topicId: true, entrySetSha256: true, generatedAt: true },
    });
    return new Map(rows.map((row) => [row.topicId, { sha: row.entrySetSha256, generatedAt: row.generatedAt }]));
  }

  // ── The writer's three routes ─────────────────────────────────────────────────────────────────

  /**
   * Which topics need their articles written (contract `articles.routes.plan`): every topic with its
   * entries' fingerprint beside the one its article was written from. A space with no topic yet is
   * given the default ones first (`articles.seeding`), which is why this is a POST.
   */
  async plan(principal: WikiPrincipal, spaceId: string): Promise<WikiArticlePlan> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    let seeded = 0;
    if ((await this.prisma.wikiTopic.count({ where: { ownerId, spaceId } })) === 0) {
      const made = await this.prisma.wikiTopic.createMany({
        data: WIKI_DEFAULT_TOPICS.map((topic) => ({
          spaceId,
          ownerId,
          slug: topic.slug,
          title: topic.title,
          description: topic.description,
          category: topic.category,
          pathPrefixes: [...topic.pathPrefixes],
        })),
        skipDuplicates: true,
      });
      seeded = made.count;
      if (seeded > 0) this.realtime?.publishWikiChanged(ownerId, spaceId);
    }
    const { topics, entries, members } = await this.membership(ownerId, spaceId);
    const leads = await this.leads(ownerId, topics.map((topic) => topic.id));
    return {
      spaceId,
      seeded,
      entries: entries.length,
      unassigned: members.unassigned,
      topics: topics.map((topic) => {
        const own = members.bySlug.get(topic.slug) ?? [];
        const sha = entrySetSha256(own);
        const lead = leads.get(topic.id) ?? null;
        return {
          slug: topic.slug,
          title: topic.title,
          category: asCategory(topic.category),
          entryCount: own.length,
          entrySetSha256: sha,
          articleSha256: lead?.sha ?? null,
          generatedAt: lead?.generatedAt.toISOString() ?? null,
          changed: own.length > 0 && lead?.sha !== sha,
        };
      }),
    };
  }

  /**
   * What one topic's articles are written from (contract `articles.routes.input`): its entries, the
   * best supported first — the sources on each one's current revision, then the newest — with the
   * paths the grouping weighs and the fingerprint a write must name.
   */
  async input(principal: WikiPrincipal, spaceId: string, slug: string): Promise<WikiArticleInput> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const { topics, members } = await this.membership(ownerId, spaceId);
    const topic = topics.find((row) => row.slug === slug);
    if (!topic) throw new NotFoundException('no such wiki topic');
    const own = members.bySlug.get(slug) ?? [];
    const lead = (await this.leads(ownerId, [topic.id])).get(topic.id) ?? null;
    const ids = own.map((entry) => entry.id);
    const details = ids.length === 0
      ? []
      : await this.prisma.$queryRaw<Array<{
        id: string;
        kind: string;
        fields: Record<string, unknown>;
        trust: string;
        recordedAt: Date;
        sources: number;
      }>>(Prisma.sql`
        SELECT e."id"::text AS "id",
               e."kind" AS "kind",
               e."fields" AS "fields",
               e."trust" AS "trust",
               e."recorded_at" AS "recordedAt",
               (SELECT count(*)::int
                  FROM "wiki_entry_revision" r
                  JOIN "wiki_source" s ON s."revision_id" = r."id" AND s."owner_id" = r."owner_id"
                 WHERE r."entry_id" = e."id" AND r."owner_id" = e."owner_id"
                   AND r."revision" = e."current_revision" AND s."state" = 'live') AS "sources"
          FROM "wiki_entry" e
         WHERE e."owner_id" = ${ownerId}::uuid
           AND e."id" = ANY(${ids}::uuid[])
      `);
    const detail = new Map(details.map((row) => [row.id, row]));
    const entries = own
      .map((entry) => {
        const row = detail.get(entry.id)!;
        return {
          id: entry.id,
          revision: entry.revision,
          kind: row.kind as WikiEntryKind,
          title: entry.title,
          summary: entry.summary,
          fields: row.fields ?? {},
          paths: [...entry.paths],
          sources: row.sources,
          trust: row.trust as WikiTrust,
          recordedAt: row.recordedAt.toISOString(),
        };
      })
      .sort((a, b) => b.sources - a.sources || (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0) || (a.id < b.id ? -1 : 1));
    return {
      spaceId,
      topic: { slug: topic.slug, title: topic.title, category: asCategory(topic.category), description: topic.description },
      entrySetSha256: entrySetSha256(own),
      articleSha256: lead?.sha ?? null,
      entries,
    };
  }

  /**
   * Write one topic's articles (contract `articles.routes.write`, `articles.validation`,
   * `articles.regeneration`).
   *
   * The fingerprint the parts were written from decides whether anything is written: the one the
   * stored part 0 carries already is `unchanged` and rewrites nothing; one that is not the topic's
   * current set is WIKI_ARTICLE_STALE — the entries moved while the model wrote — and writes nothing
   * either, so what is stored always says exactly which entries it was written from. Then every part
   * is validated against the topic's entries, and the topic's rows are replaced in one transaction.
   */
  async write(principal: WikiPrincipal, spaceId: string, slug: string, body: unknown): Promise<WikiArticleWriteResult> {
    await this.assertWriter(principal, spaceId);
    const { ownerId } = principal;
    const request = parseArticleWrite(body);
    const { topics, members } = await this.membership(ownerId, spaceId);
    const topic = topics.find((row) => row.slug === slug);
    if (!topic) throw new NotFoundException('no such wiki topic');
    const own = members.bySlug.get(slug) ?? [];
    const current = entrySetSha256(own);
    const revisionOf = new Map(own.map((entry) => [entry.id, entry.revision]));
    const allowed = new Set(revisionOf.keys());

    const stored = (await this.leads(ownerId, [topic.id])).get(topic.id) ?? null;
    const quiet = (reason: string | null, unchanged: boolean): WikiArticleWriteResult => ({
      spaceId,
      slug,
      written: false,
      unchanged,
      reason,
      parts: [],
      stats: sumStats([]),
    });
    if (stored?.sha === request.entrySetSha256) return quiet(null, true);
    if (request.entrySetSha256 !== current) {
      throw new WikiRefusalError({
        code: 'WIKI_ARTICLE_STALE',
        message:
          `the entries of topic ${slug} changed while its articles were written (they were written from ${request.entrySetSha256.slice(0, 12)}, `
            + `the topic is now ${current.slice(0, 12)}): nothing was written, and the next run writes them from the entries as they stand`,
      });
    }

    const validated = request.parts.map((part) => {
      const pool = part.entries === null ? [...allowed] : part.entries.filter((id) => allowed.has(id));
      const result = validateArticlePart(part.markdown, part.notes, allowed, WIKI_ARTICLE_RULES.maxChars);
      return { part, pool, result, kept: result.blocks.length > 0 && pool.length > 0 };
    });
    const lead = validated[0];
    const partsAnswer = validated.map(({ part, result, kept }) => ({ part: part.part, kind: part.kind, title: part.title, kept, stats: result.stats }));
    if (!lead.kept) {
      return {
        ...quiet(`no sentence of part 0 kept a footnote to an entry of topic ${slug}, so nothing was written`, false),
        parts: partsAnswer,
        stats: sumStats(validated.map((v) => v.result.stats)),
      };
    }
    const subtopics = validated.slice(1).filter((v) => v.kept);
    // An overview whose every subtopic article was dropped would point at nothing: it stands alone.
    const leadKind: WikiArticleKind = lead.part.kind === 'overview' && subtopics.length === 0 ? 'article' : lead.part.kind;
    const citations = (cited: readonly string[]): WikiArticleCitation[] =>
      cited.map((entryId, i) => ({ n: i + 1, entryId, revision: revisionOf.get(entryId)! }));

    const written = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        // One writer of a topic at a time: the topic row, by NO KEY UPDATE (the summaries' foreign key
        // takes KEY SHARE on it, which this does not block). Under it the stored fingerprint is read
        // again, so of two writers of the same entries the second finds the first's and writes nothing.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "wiki_topic" WHERE "id" = ${topic.id}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
        const again = await tx.wikiTopicSummary.findFirst({
          where: { ownerId, topicId: topic.id, part: 0 },
          select: { entrySetSha256: true },
        });
        if (again?.entrySetSha256 === request.entrySetSha256) return false;
        await tx.wikiTopicSummary.deleteMany({ where: { ownerId, topicId: topic.id } });
        const made = await tx.wikiTopicSummary.create({
          data: {
            topicId: topic.id,
            ownerId,
            part: 0,
            kind: leadKind,
            title: lead.part.title,
            body: lead.result.blocks as unknown as Prisma.InputJsonValue,
            citations: citations(lead.result.cited) as unknown as Prisma.InputJsonValue,
            entryIds: lead.pool,
            entrySetSha256: request.entrySetSha256,
            ref: request.ref,
            model: request.model,
            stats: lead.result.stats as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        for (const sub of subtopics) {
          await tx.wikiTopicSummary.create({
            data: {
              topicId: topic.id,
              ownerId,
              part: sub.part.part,
              kind: 'subtopic',
              parentId: made.id,
              title: sub.part.title,
              body: sub.result.blocks as unknown as Prisma.InputJsonValue,
              citations: citations(sub.result.cited) as unknown as Prisma.InputJsonValue,
              entryIds: sub.pool,
              entrySetSha256: entrySetSha256(sub.pool.map((id) => ({ id, revision: revisionOf.get(id)! }))),
              ref: request.ref,
              model: request.model,
              stats: sub.result.stats as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
        }
        return true;
      },
      loggedRetry(this.logger, 'wiki.writeArticles'),
    );
    if (!written) return quiet(null, true);
    this.realtime?.publishWikiChanged(ownerId, spaceId);
    return {
      spaceId,
      slug,
      written: true,
      unchanged: false,
      reason: null,
      parts: partsAnswer,
      stats: sumStats(validated.map((v) => v.result.stats)),
    };
  }

  // ── The owner's three reads ───────────────────────────────────────────────────────────────────

  /** Every article row of a space, without its body: what the directory and the index list. */
  private async partsOf(ownerId: string, spaceId: string): Promise<Array<{
    topicId: string;
    part: number;
    kind: WikiArticleKind;
    title: string;
    entryCount: number;
    generatedAt: Date;
  }>> {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT s."topic_id"::text AS "topicId",
             s."part" AS "part",
             s."kind" AS "kind",
             s."title" AS "title",
             cardinality(s."entry_ids")::int AS "entryCount",
             s."generated_at" AS "generatedAt"
        FROM "wiki_topic_summary" s
        JOIN "wiki_topic" t ON t."id" = s."topic_id" AND t."owner_id" = s."owner_id"
       WHERE s."owner_id" = ${ownerId}::uuid
         AND t."space_id" = ${spaceId}::uuid
       ORDER BY s."part"
    `);
  }

  /** The category directory (contract `articles.reads.directory`). */
  async directory(ownerId: string, spaceId: string): Promise<WikiArticleDirectory> {
    await this.requireSpace(ownerId, spaceId);
    const [topics, parts] = await Promise.all([this.topicsOf(ownerId, spaceId), this.partsOf(ownerId, spaceId)]);
    const byTopic = new Map<string, typeof parts>();
    for (const part of parts) byTopic.set(part.topicId, [...(byTopic.get(part.topicId) ?? []), part]);
    const entry = (topic: TopicRow): WikiArticleDirectoryTopic => {
      const own = byTopic.get(topic.id) ?? [];
      const lead = own.find((part) => part.part === 0) ?? null;
      return {
        slug: topic.slug,
        title: topic.title,
        description: topic.description,
        category: asCategory(topic.category),
        article: lead
          ? { part: 0, kind: lead.kind, title: lead.title, entryCount: lead.entryCount, generatedAt: lead.generatedAt.toISOString() }
          : null,
        parts: own
          .filter((part) => part.part >= 1)
          .map((part) => ({ part: part.part, kind: part.kind, title: part.title, entryCount: part.entryCount })),
      };
    };
    return {
      spaceId,
      categories: WIKI_ARTICLE_CATEGORIES.map((category) => ({
        key: category.key,
        title: category.title,
        topics: topics.filter((topic) => topic.category === category.key).map(entry),
      })),
      uncategorized: topics.filter((topic) => asCategory(topic.category) === null).map(entry),
    };
  }

  /** One part of a topic's articles, its footnotes resolved to the entries they name (`articles.reads.article`). */
  async article(ownerId: string, spaceId: string, slug: string, part: number): Promise<WikiArticleView> {
    await this.requireSpace(ownerId, spaceId);
    const topic = await this.prisma.wikiTopic.findFirst({
      where: { ownerId, spaceId, slug },
      select: { id: true, slug: true, title: true, category: true },
    });
    if (!topic) throw new NotFoundException('no such wiki topic');
    const rows = await this.prisma.wikiTopicSummary.findMany({
      where: { ownerId, topicId: topic.id },
      orderBy: { part: 'asc' },
      select: {
        part: true,
        kind: true,
        title: true,
        body: true,
        citations: true,
        entryIds: true,
        stats: true,
        ref: true,
        model: true,
        generatedAt: true,
      },
    });
    const row = rows.find((candidate) => candidate.part === part);
    if (!row) throw new NotFoundException(part === 0 ? 'this topic has no article yet' : 'no such part of this topic');
    const ref = (candidate: (typeof rows)[number]): WikiArticlePartRef => ({
      part: candidate.part,
      kind: candidate.kind as WikiArticleKind,
      title: candidate.title,
      entryCount: candidate.entryIds.length,
    });
    const citations = (row.citations as unknown as WikiArticleCitation[]) ?? [];
    const named = await this.prisma.wikiEntry.findMany({
      where: { ownerId, id: { in: citations.map((citation) => citation.entryId) } },
      select: { id: true, kind: true, title: true, summary: true, status: true, trust: true, currentRevision: true },
    });
    const entryById = new Map(named.map((entry) => [entry.id, entry]));
    const footnotes: WikiArticleFootnote[] = citations.map((citation) => {
      const entry = entryById.get(citation.entryId);
      return {
        n: citation.n,
        entryId: citation.entryId,
        revision: citation.revision,
        entry: entry
          ? {
              id: entry.id,
              kind: entry.kind as WikiEntryKind,
              title: entry.title,
              summary: entry.summary,
              status: entry.status as WikiEntryStatus,
              trust: entry.trust as WikiTrust,
              currentRevision: entry.currentRevision,
            }
          : null,
      };
    });
    // What the list under the article is (`articles.reads.article`): every entry it was written from by
    // id, and the first WIKI_ARTICLE_ENTRIES_LISTED of them as they stand now — the cited ones first, so
    // a cap never drops an entry a footnote names — for the page to list by kind.
    const pool = new Set(row.entryIds);
    const cited = [...new Set(citations.map((citation) => citation.entryId))].filter((id) => pool.has(id));
    const listed = [...cited, ...row.entryIds.filter((id) => !cited.includes(id))].slice(0, WIKI_ARTICLE_ENTRIES_LISTED);
    const rank = new Map(listed.map((id, i) => [id, i]));
    const pooled = listed.length === 0
      ? []
      : await this.prisma.wikiEntry.findMany({ where: { ownerId, id: { in: listed } }, select: ENTRY_SELECT });
    pooled.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const lead = rows.find((candidate) => candidate.part === 0);
    const category = asCategory(topic.category);
    return {
      spaceId,
      topic: { slug: topic.slug, title: topic.title, category, categoryTitle: category ? CATEGORY_TITLE.get(category)! : null },
      part: row.part,
      kind: row.kind as WikiArticleKind,
      title: row.title,
      blocks: row.body as unknown as WikiArticleBlock[],
      footnotes,
      entryCount: row.entryIds.length,
      entryIds: row.entryIds,
      entries: pooled.map(entryView) as unknown as WikiEntry[],
      chars: (row.stats as unknown as WikiArticleStats).chars ?? 0,
      generatedAt: row.generatedAt.toISOString(),
      ref: row.ref,
      model: row.model,
      overview: row.part >= 1 && lead ? ref(lead) : null,
      parts: rows.filter((candidate) => candidate.part >= 1).map(ref),
    };
  }

  /** Every article of the space, A to Z by title (`articles.reads.index`). */
  async index(ownerId: string, spaceId: string): Promise<WikiArticleIndex> {
    await this.requireSpace(ownerId, spaceId);
    const [topics, parts] = await Promise.all([this.topicsOf(ownerId, spaceId), this.partsOf(ownerId, spaceId)]);
    const topicById = new Map(topics.map((topic) => [topic.id, topic]));
    const items = parts
      .filter((part) => topicById.has(part.topicId))
      .map((part) => {
        const topic = topicById.get(part.topicId)!;
        const first = part.title.trim().charAt(0);
        return {
          part: part.part,
          kind: part.kind,
          title: part.title,
          entryCount: part.entryCount,
          initial: /[A-Za-z]/u.test(first) ? first.toUpperCase() : '#',
          topic: { slug: topic.slug, title: topic.title },
        };
      })
      .sort((a, b) => {
        const x = a.title.toLowerCase();
        const y = b.title.toLowerCase();
        if (x !== y) return x < y ? -1 : 1;
        if (a.topic.slug !== b.topic.slug) return a.topic.slug < b.topic.slug ? -1 : 1;
        return a.part - b.part;
      });
    return { spaceId, items };
  }
}
