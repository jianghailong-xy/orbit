import { WIKI_ARTICLE_RULES, type WikiArticleInputEntry, type WikiArticleKind } from '@orbit/shared';
import { validateArticlePart } from '../wiki/wiki-articles';

/**
 * The writer's half of the articles (contracts/wiki.contract.json `articles`, `jobs.kindRuns.articles`),
 * ported from `src/runner-go/wiki_articles.go` for the server's `articles` job: the prompts the model is
 * asked, how what it answers is read, and the grouping of a topic too big for one article.
 *
 * WORD FOR WORD WHERE THE MODEL READS IT. The system prompt, the article and overview prompts, the entry
 * lines, the naming prompt and the retry suffix are the runner's text, so the System model is asked exactly
 * what the session's provider was. What the server decides is not here: which entries a topic has, its
 * fingerprint and what of a draft survives are `wiki/wiki-articles.ts`'s, the one implementation both paths
 * write through.
 *
 * ONE COUNT OF A DRAFT. The runner estimated what the server would keep of a draft before deciding to ask
 * again (`wikiArticleDraftChars`, "roughly"); here the server's own validation is in the same process, so the
 * estimate is the count the server keeps: `validateArticlePart` with no cap.
 *
 * THE GROUPING IS CODE, AND THE SAME EVERY TIME. A topic of more than `rules.splitAbove` entries is grouped by
 * spherical k-means over tf-idf vectors in which anchor paths weigh most (the demo's `cluster`, the runner's
 * `groupWikiArticleEntries`), step for step: the same tokens and weights, the same farthest-first seeds, the
 * same six rounds with the same capacity and the same folding of small groups, every sum taken over the
 * tokens in one order. It is CPU work on the worker's one thread, so it yields the event loop every
 * `WIKI_ARTICLE_WRITER.groupingSliceMs` (design §4.5): the lease renewals and the queue's own timers run while a
 * topic of thousands of entries is grouped.
 */

/** The writer's own numbers, the runner's (`wiki_articles.go`); the contract's are `WIKI_ARTICLE_RULES`. */
export const WIKI_ARTICLE_WRITER = {
  /** A group's name is at most this many characters; one the model's answer does not give is a path's. */
  nameMaxChars: 24,
  /** A draft shorter than rules.minChars is asked for again once, when its pool has at least this many
   *  entries: a topic of three entries has not got 400 characters to say. */
  retryPoolMin: 8,
  /** How long the grouping computes before it lets the event loop run (design §4.5). */
  groupingSliceMs: 8,
} as const;

/** The whole system prompt of every call the articles make (the demo's): the rest is in the prompt. */
export const WIKI_ARTICLE_SYSTEM_PROMPT = 'You write concise encyclopedia-style wiki articles from given knowledge entries. '
  + 'You output only what is asked.';

/** One entry as the writer reads it: what the input route answers for each entry of a topic. */
export type WikiArticleWriterEntry = Pick<WikiArticleInputEntry, 'id' | 'kind' | 'title' | 'summary' | 'fields' | 'paths' | 'sources'>;

/** At most this many characters, counted as code points (the runner's `cutRunes`). */
export function cutCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** `1 source`, `3 sources`: the runner's `wikiCount`. */
function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Code point order, which is the byte order of UTF-8: how the runner sorted every key. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate stands for a code point above U+FFFF: it sorts after every unit of the basic plane.
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/**
 * A value as Go's `json.Marshal` writes it, which is what the runner put in a prompt for a field that is not
 * text: object keys sorted, `<`, `>` and `&` escaped, and U+2028 and U+2029 escaped.
 */
export function goJson(value: unknown): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort(compareCodePoints)) {
        out[key] = ordered((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return (JSON.stringify(ordered(value)) ?? 'null')
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

// ── The prompts ─────────────────────────────────────────────────────────────────────────────────

/** What of each kind's fields an entry line carries (the demo's). */
const KEY_FIELDS: Record<string, readonly string[]> = {
  principle: ['statement', 'rationale'],
  convention: ['rule', 'exceptions'],
  decision: ['decision', 'alternatives', 'consequences'],
  pitfall: ['symptom', 'cause', 'fix'],
  recipe: ['steps', 'verify'],
  concept: ['definition', 'boundaries'],
};

/** One numbered entry as the model reads it. */
export function wikiArticleEntryLine(n: number, entry: WikiArticleWriterEntry): string {
  const parts: string[] = [];
  for (const key of KEY_FIELDS[entry.kind] ?? []) {
    const value = (entry.fields ?? {})[key];
    if (value === undefined || value === null) continue;
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else if (Array.isArray(value)) {
      text = value
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const option = (item as Record<string, unknown>).option;
            const why = (item as Record<string, unknown>).whyRejected;
            return `${typeof option === 'string' ? option : ''}（${typeof why === 'string' ? why : ''}）`;
          }
          return goJson(item);
        })
        .join('; ');
    } else {
      text = goJson(value);
    }
    if (text.trim() === '') continue;
    parts.push(`${key}: ${cutCodePoints(text, 220)}`);
  }
  return `[${n}] (${entry.kind}, ${count(entry.sources, 'source', 'sources')}) ${entry.title} —— `
    + `${cutCodePoints(entry.summary, 240)} | ${cutCodePoints(parts.join(' | '), 520)}`;
}

/** One part's prompt: an article (or a subtopic's), or the overview of a split topic. */
export function wikiArticlePrompt(
  kind: WikiArticleKind,
  topicTitle: string,
  title: string,
  fed: readonly WikiArticleWriterEntry[],
  subs: string,
): string {
  const entries = fed.map((entry, i) => wikiArticleEntryLine(i + 1, entry)).join('\n');
  if (kind === 'overview') {
    return `Write the overview of the wiki topic "${topicTitle}". The topic is split into these sub-articles:
${subs}

Using ONLY the numbered entries below (the most important ones of each sub-article), write in English:
- first line: "# " + the topic title
- two or three short paragraphs that tell a reader what this topic covers and point out its most important rules and traps.
Rules:
- EVERY sentence must end with one or more footnote markers such as [2] or [2][5], the numbers of the entries it is based on. A sentence without a marker will be deleted.
- State only what the entries say; do not invent facts, versions, dates, numbers or paths.
- LENGTH: 450-750 characters in total, 6-9 sentences. Anything past ${WIKI_ARTICLE_RULES.maxChars} characters is cut off.
Output only the Markdown.

ENTRIES:
${entries}`;
  }
  const scope = kind === 'subtopic' ? ` (a part of the topic "${topicTitle}")` : '';
  return `Write a wiki article titled "${title}"${scope}, using ONLY the numbered knowledge entries below.

Format (Markdown, in English; keep code identifiers, paths and commands verbatim in backticks):
- first line: "# " + a concise article title
- a lead paragraph of 2-3 sentences: what this area is about and its most important rules and traps
- then 2-4 sections "## heading" of 2-3 sentences each that group the knowledge (for example Conventions / Decisions / Common pitfalls / Practices / Concepts — choose what fits)
Rules:
- EVERY sentence must end with one or more footnote markers such as [3] or [3][7], the numbers of the entries it is based on. A sentence without a marker will be deleted.
- State only what the entries say; do not invent facts, versions, dates, numbers or paths. If entries disagree, say so and cite both.
- Prefer the most important and most corroborated entries (more sources = more corroborated); you need not cite every entry.
- Mark a trap that an entry says is fixed as (fixed).
- LENGTH: 450-800 characters in total, 8-11 sentences, one point per sentence. Anything past ${WIKI_ARTICLE_RULES.maxChars} characters is cut off.
Output only the Markdown article.

ENTRIES:
${entries}`;
}

/** What is added to a prompt whose first draft kept fewer than `rules.minChars` characters. */
export function wikiArticleRetrySuffix(chars: number): string {
  return `\n\nA previous draft kept only ${chars} characters with footnotes: write the whole length asked for, every sentence with its markers.`;
}

/**
 * The prompt that names one group, told the names its topic's other groups already have: named all at once,
 * a topic's groups come back as near-synonyms of each other.
 */
export function wikiArticleNamePrompt(topicTitle: string, members: readonly WikiArticleWriterEntry[], taken: readonly string[]): string {
  const titles = members.slice(0, 14).map((entry) => `- ${cutCodePoints(entry.title, 60)}`);
  let prompt = `Below are the titles of the entries filed in one group under the wiki topic "${topicTitle}":\n${titles.join('\n')}\n\n`
    + 'Give this group a short English subheading (at most 14 characters; code names may stay) that sums up what they have in common.';
  if (taken.length > 0) {
    prompt += `\nThe topic's other groups are already called: ${taken.join(', ')}. Give this one a name different from all of them that says what `
      + 'only this group covers, not just another way of saying one of theirs.';
  }
  return `${prompt} Output only the subheading.`;
}

// ── Reading what comes back ─────────────────────────────────────────────────────────────────────

/**
 * What the server will keep of a draft, in characters (contract `articles.validation`): its sentences that
 * keep a footnote naming one of the entries it was written from, markers and headings left out. It is the
 * server's own count — `validateArticlePart`, with no cap — which decides whether to ask once more.
 */
export function wikiArticleDraftChars(markdown: string, notes: readonly string[]): number {
  return validateArticlePart(markdown, notes, new Set(notes), Number.POSITIVE_INFINITY).stats.chars;
}

const MARKER = /\[(\d{1,3})\]/gu;

/** Trim the characters of `set` off the start (`left`) or the end of `text`, as Go's TrimLeft / TrimRight do. */
function trimSet(text: string, set: string, side: 'left' | 'right' | 'both'): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  if (side !== 'right') while (start < end && set.includes(chars[start])) start += 1;
  if (side !== 'left') while (end > start && set.includes(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join('');
}

/** The draft's own `# ` title when it wrote one, else the title it was asked for. */
export function wikiArticleTitle(markdown: string, fallback: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('# ')) continue;
    const title = trimSet(line.slice(2).replace(MARKER, '').trim(), '*#` ', 'both');
    if (title !== '') return cutCodePoints(title, WIKI_ARTICLE_RULES.titleMaxChars);
    break;
  }
  return cutCodePoints(fallback.trim(), WIKI_ARTICLE_RULES.titleMaxChars);
}

/**
 * A group's name from the model's answer: its last line, without the quotes, bullets and emphasis a model
 * wraps a short answer in. Empty when there is none.
 */
export function wikiArticleGroupName(text: string): string {
  const lines = text.trim().split('\n');
  let last = lines[lines.length - 1].trim();
  last = trimSet(last, '#*-「『"“ \t', 'left');
  last = trimSet(last, '」』"”* \t。', 'right');
  return cutCodePoints(last.trim(), WIKI_ARTICLE_WRITER.nameMaxChars);
}

/** A group named by the three-segment path most of its entries share, else by its first entry's title. */
export function wikiArticleFallbackName(members: readonly Pick<WikiArticleWriterEntry, 'title' | 'paths'>[]): string {
  const counts = new Map<string, number>();
  for (const entry of members) {
    for (const path of entry.paths) {
      const prefix = path.split('/').slice(0, 3).join('/');
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  for (const [prefix, n] of counts) {
    if (n > bestN || (n === bestN && compareCodePoints(prefix, best) < 0)) {
      best = prefix;
      bestN = n;
    }
  }
  if (best !== '') return cutCodePoints(best, WIKI_ARTICLE_WRITER.nameMaxChars);
  if (members.length > 0) return cutCodePoints(members[0].title, 14);
  return 'Other';
}

// ── Grouping: a big topic's subtopics, by code ──────────────────────────────────────────────────

/** A sparse vector: token numbers ascending — which is the tokens' code point order — and their weights. */
interface SparseVector {
  ids: Int32Array;
  weights: Float64Array;
}

/** How long the grouping computes before it lets the event loop run, unless the caller says otherwise. */
export interface WikiArticleGroupingOptions {
  /** Milliseconds of work between two yields; 0 yields at every check. */
  sliceMs?: number;
}

/**
 * The yield: `setImmediate` lets every timer and every I/O callback that came due run before the next slice —
 * a lease renewal, a NOTIFY, a request's partial write. Only when a slice has used its time, so a small topic
 * is grouped in one go.
 */
function slicer(sliceMs: number): () => Promise<void> | null {
  let last = performance.now();
  return () => {
    if (performance.now() - last < sliceMs) return null;
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        last = performance.now();
        resolve();
      });
    });
  };
}

const PATH_WEIGHT = 3;
const WORD = /[a-z_][a-z0-9_.-]{2,}/gu;
const HAN = /\p{Script=Han}+/gu;

/**
 * The demo's tokens: every 2-to-6-segment prefix of each path the entry names, weighing three, and the words
 * and CJK bigrams of its title and summary, one each.
 */
export function wikiArticleTokens(entry: Pick<WikiArticleWriterEntry, 'title' | 'summary' | 'paths'>): Map<string, number> {
  const tokens = new Map<string, number>();
  const add = (key: string, weight: number): void => {
    tokens.set(key, (tokens.get(key) ?? 0) + weight);
  };
  for (const path of entry.paths) {
    const segments = path.split('/');
    for (let i = 2; i <= segments.length && i <= 6; i += 1) add(`P:${segments.slice(0, i).join('/')}`, PATH_WEIGHT);
  }
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  for (const match of text.matchAll(WORD)) add(`W:${match[0]}`, 1);
  for (const match of text.matchAll(HAN)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i + 1 < chars.length; i += 1) add(`C:${chars[i]}${chars[i + 1]}`, 1);
  }
  return tokens;
}

/** The dot product of two sparse vectors: a merge in token order, as the runner's `wikiDot`. */
function sparseDot(a: SparseVector, b: SparseVector): number {
  let sum = 0;
  for (let i = 0, j = 0; i < a.ids.length && j < b.ids.length;) {
    const x = a.ids[i];
    const y = b.ids[j];
    if (x === y) {
      sum += a.weights[i] * b.weights[j];
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return sum;
}

/**
 * The dot product of a sparse vector with a dense one. The same sum as the merge: the vector's tokens in
 * order, a token the dense one lacks adding an exact zero.
 */
function denseDot(a: SparseVector, dense: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.ids.length; i += 1) sum += a.weights[i] * dense[a.ids[i]];
  return sum;
}

/**
 * A summed vector made a unit one, in place (the runner's `wikiUnit`): the norm summed over the tokens in
 * order — a token nobody has adds an exact zero — and a zero norm read as one.
 */
function normalize(sum: Float64Array, into: Float64Array): void {
  let norm = 0;
  for (let id = 0; id < sum.length; id += 1) norm += sum[id] * sum[id];
  norm = Math.sqrt(norm);
  if (norm === 0) norm = 1;
  for (let id = 0; id < sum.length; id += 1) into[id] = sum[id] / norm;
}

/**
 * Split a big topic's entries into subtopics (the demo's `cluster`): spherical k-means over tf-idf vectors in
 * which anchor paths weigh most, k about one group per `rules.groupTarget` entries (at most `rules.groupsMax`,
 * at least two), seeded farthest-first from the best-supported entry, each group capped at twice the target
 * so one cannot swallow the topic, and a group smaller than `rules.groupMin` folded into its nearest. Every
 * entry is in exactly one group, each group lists its entries in the input's order, and the groups come in
 * the order their seeds were taken. The same entries in the same order give the same groups, every time.
 */
export async function groupWikiArticleEntries(
  entries: readonly Pick<WikiArticleWriterEntry, 'title' | 'summary' | 'paths'>[],
  options: WikiArticleGroupingOptions = {},
): Promise<number[][]> {
  const n = entries.length;
  if (n === 0) return [];
  const breathe = slicer(options.sliceMs ?? WIKI_ARTICLE_WRITER.groupingSliceMs);
  const pause = async (): Promise<void> => {
    const wait = breathe();
    if (wait) await wait;
  };
  const k = Math.min(n, Math.max(2, Math.min(Math.ceil(n / WIKI_ARTICLE_RULES.groupTarget), WIKI_ARTICLE_RULES.groupsMax)));

  // tf-idf: a token's weight is its count times log(1 + n / df), kept when more than one entry has it or it
  // is a path's — a path is what a group is first of all.
  const raw = entries.map((entry) => wikiArticleTokens(entry));
  const df = new Map<string, number>();
  for (const tokens of raw) for (const token of tokens.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const kept = [...df.keys()].filter((token) => df.get(token)! > 1 || token.startsWith('P:')).sort(compareCodePoints);
  const idOf = new Map(kept.map((token, id) => [token, id]));
  const size = kept.length;
  const vectors: SparseVector[] = [];
  for (const tokens of raw) {
    const pairs: Array<[number, number]> = [];
    for (const [token, weight] of tokens) {
      const id = idOf.get(token);
      if (id === undefined) continue;
      pairs.push([id, weight * Math.log(1 + n / df.get(token)!)]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    let norm = 0;
    for (const [, weight] of pairs) norm += weight * weight;
    norm = Math.sqrt(norm);
    if (norm === 0) norm = 1;
    vectors.push({ ids: Int32Array.from(pairs, (p) => p[0]), weights: Float64Array.from(pairs, (p) => p[1] / norm) });
    await pause();
  }

  // Seeds, farthest first from the best-supported entry: each next seed is the entry least like every seed
  // taken so far, the first of equals.
  const seeds = [0];
  const isSeed = new Uint8Array(n);
  isSeed[0] = 1;
  const best = new Float64Array(n);
  for (let i = 0; i < n; i += 1) best[i] = sparseDot(vectors[i], vectors[0]);
  while (seeds.length < k) {
    let pick = -1;
    for (let i = 0; i < n; i += 1) {
      if (isSeed[i]) continue;
      if (pick < 0 || best[i] < best[pick]) pick = i;
    }
    seeds.push(pick);
    isSeed[pick] = 1;
    for (let i = 0; i < n; i += 1) {
      const d = sparseDot(vectors[i], vectors[pick]);
      if (d > best[i]) best[i] = d;
    }
    await pause();
  }

  // Six rounds: everyone to the centroid it is nearest, the most confident first and a full group passing an
  // entry to its next best; then each centroid the unit sum of its members.
  const centroids = seeds.map((seed) => {
    const dense = new Float64Array(size);
    const v = vectors[seed];
    for (let j = 0; j < v.ids.length; j += 1) dense[v.ids[j]] = v.weights[j];
    return dense;
  });
  const capacity = WIKI_ARTICLE_RULES.groupTarget * 2;
  const assign = new Int32Array(n);
  const sum = new Float64Array(size);
  const sims = Array.from({ length: n }, () => new Float64Array(k));
  const top = new Float64Array(n);
  const groupOrder = Array.from({ length: k }, (_, g) => g);
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < n; i += 1) {
      for (let g = 0; g < k; g += 1) {
        sims[i][g] = denseDot(vectors[i], centroids[g]);
        if (g === 0 || sims[i][g] > top[i]) top[i] = sims[i][g];
      }
      await pause();
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (top[a] > top[b] ? -1 : top[a] < top[b] ? 1 : 0));
    const filled = new Int32Array(k);
    for (const i of order) {
      const ranked = [...groupOrder].sort((a, b) => (sims[i][a] > sims[i][b] ? -1 : sims[i][a] < sims[i][b] ? 1 : 0));
      for (const g of ranked) {
        if (filled[g] < capacity) {
          assign[i] = g;
          filled[g] += 1;
          break;
        }
      }
    }
    for (let g = 0; g < k; g += 1) {
      sum.fill(0);
      let members = 0;
      for (let i = 0; i < n; i += 1) {
        if (assign[i] !== g) continue;
        members += 1;
        const v = vectors[i];
        for (let j = 0; j < v.ids.length; j += 1) sum[v.ids[j]] += v.weights[j];
      }
      if (members > 0) normalize(sum, centroids[g]);
      await pause();
    }
  }

  const groups: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i += 1) groups[assign[i]].push(i);
  const big: number[][] = [];
  const small: number[][] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (group.length < WIKI_ARTICLE_RULES.groupMin) small.push(group);
    else big.push(group);
  }
  // Nothing reached the minimum: the groups stand as they are.
  if (big.length === 0) return small;

  // A small group's entries go one by one to the kept group whose unit sum they are nearest — that sum
  // counting the entries already folded into it, the first of equals.
  const sums = big.map((members) => {
    const dense = new Float64Array(size);
    for (const j of members) {
      const v = vectors[j];
      for (let t = 0; t < v.ids.length; t += 1) dense[v.ids[t]] += v.weights[t];
    }
    return dense;
  });
  const units = big.map(() => new Float64Array(size));
  const stale = big.map(() => true);
  for (const group of small) {
    for (const i of group) {
      let target = 0;
      let score = -1;
      for (let g = 0; g < big.length; g += 1) {
        if (stale[g]) {
          normalize(sums[g], units[g]);
          stale[g] = false;
        }
        const s = denseDot(vectors[i], units[g]);
        if (s > score) {
          target = g;
          score = s;
        }
      }
      big[target].push(i);
      const v = vectors[i];
      for (let t = 0; t < v.ids.length; t += 1) sums[target][v.ids[t]] += v.weights[t];
      stale[target] = true;
      await pause();
    }
  }
  for (const group of big) group.sort((a, b) => a - b);
  return big;
}
