import { WIKI_KINDS, type WikiPlanMaterials, type WikiPlanTopic } from '@orbit/shared';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import { goCompare, goTrim } from './wiki-plan-format';

/**
 * What the drafting job reads of Orbit besides the repository (contract `plan.jobs.materials`), laid out the way
 * the runner's job lays it out (`src/runner-go/wiki_plan_materials.go`, the sample's prep_online.py): counts, and
 * the session titles clustered — TF-IDF over words and Chinese bigrams, spherical k-means — so the model sees
 * what the work has been about without reading three thousand titles.
 *
 * On the server the materials are the same function the runner door answers with (`wikiPlanMaterials`), read
 * once at the job's first run and kept on the plan job, so a replay drafts from the same words.
 *
 * THE CLUSTERING IS CPU WORK ON THE EVENT LOOP of a process that renews leases on timers (design §4.5): a few
 * thousand titles, eight rounds of k-means, some tens of milliseconds to a few hundred. It is cut into slices —
 * `wikiPlanCluster` hands the loop back every `sliceMs` — so a lease's renewal is never held up behind it.
 */

/** How often the clustering hands the event loop back, at most: well under any renewal interval. */
export const WIKI_PLAN_CLUSTER_SLICE_MS = 20;

/** The owner's projects, oldest first: when, how it stands, how much work it holds. */
export function wikiPlanProjectsText(m: WikiPlanMaterials): string {
  let b = `# 项目标题清单（${m.asOf}；owner 的全部项目，按创建时间）\n\n| 创建 | 状态 | 任务数 | 会话数 | 标题 |\n|---|---|---|---|---|\n`;
  for (const p of m.projects) {
    const created = p.createdAt.length >= 10 ? p.createdAt.slice(0, 10) : p.createdAt;
    const title = p.title.replaceAll('|', '/').replaceAll('\n', ' ');
    b += `| ${created} | ${p.status} | ${p.tasks} | ${p.sessions} | ${cutRunes(title, 110)} |\n`;
  }
  return `${b}\n共 ${m.projects.length} 个项目。任务数特别大的是批量数据项目，不是产品功能。\n`;
}

const SESSION_PREFIXES: ReadonlyArray<{ prefix: string; kind: string }> = [
  { prefix: '执行任务：', kind: '任务执行会话' },
  { prefix: '判断：', kind: '判断会话' },
  { prefix: '[VERIFY]', kind: '验证会话' },
];

/**
 * The space's sessions of the window: by month, kind, engine and project, and their titles clustered, each
 * cluster with its frequent terms and a few titles.
 */
export async function wikiPlanSessionsText(m: WikiPlanMaterials, sliceMs = WIKI_PLAN_CLUSTER_SLICE_MS): Promise<string> {
  const items = m.sessions.items;
  let b = `# 近 ${m.sessions.days} 天的会话（${m.asOf}；本 space 的 workspace）\n\n共 ${m.sessions.total} 个会话`;
  if (items.length < m.sessions.total) b += `，下面读的是最新的 ${items.length} 个`;
  b += '。\n\n';
  const byMonth = new Map<string, number>();
  const byKind = new Map<string, number>();
  const byEngine = new Map<string, number>();
  const byProject = new Map<string, number>();
  const bump = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const titles: string[] = [];
  for (const item of items) {
    bump(byMonth, item.month);
    let title = goTrimSpace(item.title);
    let kind = '自由会话';
    for (const p of SESSION_PREFIXES) {
      if (title.startsWith(p.prefix)) {
        kind = p.kind;
        title = goTrimSpace(title.slice(p.prefix.length));
        break;
      }
    }
    if (item.task && kind === '自由会话') kind = '任务执行会话';
    bump(byKind, kind);
    if (item.provider !== null && item.provider !== undefined) bump(byEngine, item.provider);
    if (item.project !== null && item.project !== undefined && item.project !== '') bump(byProject, item.project);
    titles.push(title);
  }
  b += `按月：${wikiPlanCounts(byMonth, false, 0)}\n\n按类型：${wikiPlanCounts(byKind, true, 0)}\n\n按引擎：${wikiPlanCounts(byEngine, true, 8)}\n\n`;
  if (byProject.size > 0) {
    b += '## 会话最多的项目（前 30）\n\n';
    for (const kv of wikiPlanTop(byProject, 30)) b += `- ${kv.n} · ${cutRunes(kv.key, 100)}\n`;
    b += '\n';
  }
  const { groups, unclustered } = await wikiPlanCluster(titles, 36, sliceMs);
  if (groups.length > 0) {
    b += `## 标题聚类（TF-IDF + 球面 k-means，k=${groups.length}；去掉「执行任务：」「判断：」前缀；每组：会话数、高频词、示例标题）\n\n`;
    for (const [i, g] of groups.entries()) {
      b += `### 组 ${i + 1}（${g.size} 个，不同标题 ${g.distinct} 个）高频词：${g.terms.join(' / ')}\n`;
      for (const title of g.examples) b += `- ${cutRunes(title, 90)}\n`;
      b += '\n';
    }
    if (unclustered > 0) b += `（${unclustered} 个标题太短或全是常见词，未参与聚类。）\n`;
  }
  return b;
}

/** How the space's entries and topics are spread: kind by status, and each topic with its category, path prefixes, active entries and its newest ones. */
export function wikiPlanSpaceText(m: WikiPlanMaterials): string {
  let b = `# space「${m.title}」现状（${m.asOf}）\n\n条目是原子事实，kind 取 ${WIKI_KINDS.join(' / ')}。\n\n## 条目 kind × 状态\n\n`;
  if (m.entries.length === 0) b += '（还没有条目）\n';
  for (const e of m.entries) b += `- ${e.kind} / ${e.status}: ${e.count}\n`;
  b += '\n## 现有主题（slug「名称」分类 · active 条目数；路径前缀；最近的几条条目）\n\n';
  if (m.topics.length === 0) b += '（还没有主题）\n';
  for (const t of m.topics) {
    const category = t.category !== null && t.category !== undefined && t.category !== '' ? t.category : '-';
    b += `### ${t.slug}「${t.title}」 分类 ${category} · active ${t.active} 条\n`;
    if (t.pathPrefixes.length > 0) b += `路径前缀：${t.pathPrefixes.join(' ')}\n`;
    for (const e of t.recent) b += `- ${e.kind}：${cutRunes(e.title, 70)}\n`;
    b += '\n';
  }
  return b;
}

/** The topics on one line: what a section's session condition may name. */
export function wikiPlanTopicsBrief(m: { topics: readonly WikiPlanTopic[] }): string {
  if (m.topics.length === 0) return '（这个 space 还没有主题：会话条件里不写主题）';
  return `现有主题（slug「名称」·active 条目数）：${m.topics.map((t) => `${t.slug}「${t.title}」·${t.active}`).join('；')}`;
}

/** The named topics with their newest entries: the materials of one document. */
export function wikiPlanTopicBlocks(m: WikiPlanMaterials, slugs: readonly string[]): string {
  let b = `${wikiPlanTopicsBrief(m)}\n`;
  const want = new Set(slugs.map((slug) => goTrim(goTrimSpace(slug), '`')));
  for (const t of m.topics) {
    if (!want.has(t.slug)) continue;
    b += `### ${t.slug}「${t.title}」\n`;
    for (const e of t.recent) b += `- ${e.kind}：${cutRunes(e.title, 90)}\n`;
  }
  return b;
}

interface WikiPlanCount {
  key: string;
  n: number;
}

/** The counts, most first and then by key, at most `max` of them (0: all). */
export function wikiPlanTop(counts: ReadonlyMap<string, number>, max: number): WikiPlanCount[] {
  const out = [...counts.entries()].map(([key, n]) => ({ key, n }));
  out.sort((a, b) => b.n - a.n || goCompare(a.key, b.key));
  return max > 0 && out.length > max ? out.slice(0, max) : out;
}

export function wikiPlanCounts(counts: ReadonlyMap<string, number>, byCount: boolean, max: number): string {
  if (counts.size === 0) return '（无）';
  const list = byCount
    ? wikiPlanTop(counts, max)
    : [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => goCompare(a.key, b.key));
  return list.map((kv) => `${kv.key} ${kv.n}`).join('，');
}

// ── Clustering the titles ───────────────────────────────────────────────────────────────────────────

export interface WikiPlanTitleGroup {
  size: number;
  distinct: number;
  terms: string[];
  examples: string[];
}

const WORD = /[a-z_][a-z0-9_.-]{2,}/gu;
const CJK = /\p{Script=Han}+/gu;

type Vec = Map<string, number>;

function norm(v: Vec): Vec {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  if (sum === 0) return v;
  const n = Math.sqrt(sum);
  for (const [k, x] of v) v.set(k, x / n);
  return v;
}

function dot(a: Vec, b: Vec): number {
  const [small, large] = a.size > b.size ? [b, a] : [a, b];
  let s = 0;
  for (const [k, x] of small) s += x * (large.get(k) ?? 0);
  return s;
}

/** A clock that hands the event loop back once a slice of it has been used. */
function slicer(sliceMs: number): () => Promise<void> {
  let started = performance.now();
  return async () => {
    if (performance.now() - started < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    started = performance.now();
  };
}

/**
 * Titles grouped by what they say (the sample's clustering, made deterministic: the first seed is the first
 * title that has any term, and each next the one farthest from every seed), biggest group first. Answers the
 * groups and how many titles had nothing to cluster by.
 */
export async function wikiPlanCluster(
  titles: readonly string[],
  wanted: number,
  sliceMs = WIKI_PLAN_CLUSTER_SLICE_MS,
): Promise<{ groups: WikiPlanTitleGroup[]; unclustered: number }> {
  const tick = slicer(sliceMs);
  const raw: Vec[] = [];
  const df = new Map<string, number>();
  for (const title of titles) {
    const terms: Vec = new Map();
    for (const word of title.toLowerCase().match(WORD) ?? []) terms.set(`W:${word}`, (terms.get(`W:${word}`) ?? 0) + 2);
    for (const run of title.match(CJK) ?? []) {
      const chars = [...run];
      for (let j = 0; j + 1 < chars.length; j += 1) {
        const term = `C:${chars[j]}${chars[j + 1]}`;
        terms.set(term, (terms.get(term) ?? 0) + 1);
      }
    }
    raw.push(terms);
    for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    await tick();
  }
  const n = titles.length;
  const vecs: Vec[] = [];
  const idx: number[] = [];
  for (const [i, terms] of raw.entries()) {
    const v: Vec = new Map();
    for (const [term, c] of terms) {
      const d = df.get(term) ?? 0;
      if (d >= 2 && d <= n * 0.3) v.set(term, c * Math.log(1 + n / d));
    }
    vecs.push(norm(v));
    if (v.size > 0) idx.push(i);
  }
  if (idx.length === 0) return { groups: [], unclustered: titles.length };
  let k = wanted;
  if (k > Math.floor(idx.length / 3)) k = Math.floor(idx.length / 3);
  if (k < 1) k = 1;
  const seeds = [idx[0]];
  const isSeed = new Set([idx[0]]);
  const best = new Map<number, number>();
  for (const i of idx) best.set(i, dot(vecs[i], vecs[idx[0]]));
  while (seeds.length < k) {
    let next = -1;
    let low = Infinity;
    for (const i of idx) {
      if (!isSeed.has(i) && best.get(i)! < low) {
        next = i;
        low = best.get(i)!;
      }
    }
    if (next < 0) break;
    seeds.push(next);
    isSeed.add(next);
    for (const i of idx) {
      const d = dot(vecs[i], vecs[next]);
      if (d > best.get(i)!) best.set(i, d);
      await tick();
    }
  }
  let cents: Vec[] = seeds.map((s) => new Map(vecs[s]));
  const assign = new Map<number, number>();
  for (let round = 0; round < 8; round += 1) {
    for (const i of idx) {
      let top = 0;
      let score = -Infinity;
      for (const [g, cent] of cents.entries()) {
        const d = dot(vecs[i], cent);
        if (d > score) {
          top = g;
          score = d;
        }
      }
      assign.set(i, top);
      await tick();
    }
    const next: Vec[] = cents.map(() => new Map());
    for (const i of idx) {
      const into = next[assign.get(i)!];
      for (const [term, x] of vecs[i]) into.set(term, (into.get(term) ?? 0) + x);
    }
    cents = cents.map((cent, g) => (next[g].size > 0 ? norm(next[g]) : cent));
  }
  const members = new Map<number, number[]>();
  for (const i of idx) members.set(assign.get(i)!, [...(members.get(assign.get(i)!) ?? []), i]);
  const order = [...members.keys()].sort((a, b) => members.get(b)!.length - members.get(a)!.length || a - b);
  const groups: WikiPlanTitleGroup[] = [];
  for (const g of order) {
    const list = members.get(g)!;
    const weight = new Map<string, number>();
    const distinct = new Set<string>();
    for (const i of list) {
      distinct.add(titles[i]);
      for (const [term, x] of vecs[i]) weight.set(term, (weight.get(term) ?? 0) + x);
    }
    const terms = [...weight.keys()]
      .sort((a, b) => (weight.get(a)! !== weight.get(b)! ? weight.get(b)! - weight.get(a)! : goCompare(a, b)))
      .slice(0, 10)
      .map((term) => term.slice(2));
    const ranked = [...list].sort((a, b) => dot(vecs[b], cents[g]) - dot(vecs[a], cents[g]));
    const examples: string[] = [];
    const seen = new Set<string>();
    for (const i of ranked) {
      if (!seen.has(titles[i])) {
        seen.add(titles[i]);
        examples.push(titles[i]);
      }
      if (examples.length === 5) break;
    }
    groups.push({ size: list.length, distinct: distinct.size, terms, examples });
    await tick();
  }
  return { groups, unclustered: titles.length - idx.length };
}
