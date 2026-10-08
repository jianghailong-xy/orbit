import { WIKI_PLAN_SERVER_JOB, type WikiPlanGateError, type WikiPlanMaterials } from '@orbit/shared';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import type { WikiPlanAssembled } from './wiki-plan-gate';
import {
  goCompare,
  wikiPlanDocInput,
  wikiPlanDocLines,
  wikiPlanSectionLines,
  wikiPlanSessionsLine,
  wikiPlanSessionsOf,
  type WikiPlanCat,
  type WikiPlanDoc,
  type WikiPlanDocRead,
  type WikiPlanMove,
  type WikiPlanNewFieldDraft,
  type WikiPlanSectionDraft,
  type WikiPlanUnit,
} from './wiki-plan-format';
import { wikiPlanProjectsText, wikiPlanSpaceText, wikiPlanTopicBlocks, wikiPlanTopicsBrief } from './wiki-plan-materials';
import { shortWikiHash, WIKI_PLAN_MATERIAL_CAPS, type WikiPlanRepo } from './wiki-plan-repo';

/**
 * What the drafting job asks the model, step by step (contract `plan.jobs.server`) — ported word for word from
 * `src/runner-go/wiki_plan_prompts.go` (the sample's draft_plan.py and p1_revise.py, made general): the materials
 * each step reads, and the line format each answer is written in. The prompts are Chinese, as the owner's plan
 * is; the paths, symbols and commands in them are the repository's own. `wiki-plan.fixture.json` holds them to
 * the runner's bytes.
 */

/** A version as the plan's read gives it: what a draft revises (WikiPlanVersion of @orbit/shared, the fields read here). */
export interface WikiPlanVersionRead {
  version: number;
  status: string;
  target: { min: number; max: number };
  categories: Array<{ key: string; title: string; question: string; forAgents: boolean }>;
  newFields: WikiPlanNewFieldDraft[];
  docs: WikiPlanDocRead[];
}

/**
 * What the prompts and the gate read of a run: the space, the repository at the sha, the materials, the version
 * revised and the catalogue being drafted (the runner's `wikiPlanRun`, its fields).
 */
export interface WikiPlanRunState {
  spaceTitle: string;
  /** YYYY-MM-DD: the day the materials were read. */
  date: string;
  repo: WikiPlanRepo;
  materials: WikiPlanMaterials;
  /** The sessions' text, clustered once (the clustering hands the event loop back, so it is read ahead). */
  sessionsText: string;
  target: { min: number; max: number };
  instructions: string;
  base: WikiPlanVersionRead | null;
  /** The version revised: number → slug, and slug → document. */
  baseIds: Map<string, string>;
  baseDocs: Map<string, WikiPlanDocRead>;
  cats: WikiPlanCat[];
  units: WikiPlanUnit[];
  moves: WikiPlanMove[];
}

/** Every drafting call's whole system prompt: what the model is for (wikiPlanSystemPrompt). */
export const WIKI_PLAN_SYSTEM_PROMPT = WIKI_PLAN_SERVER_JOB.systemPrompt;

export const WIKI_PLAN_BACKGROUND = `
## 背景
这个 wiki 给人读的主视图是一组「产品与技术文档」：读者打开一篇，就能知道这个功能是什么、怎么运转、接口在哪、怎么运维、有哪些已知的坑、为什么这么设计。
先起草一份 plan 交 owner 确认，再按 plan 定向取材、逐节写文档：讲机制的节，出处是设计文档、代码和契约；坑、决策、约定，出处是会话里的原话。
plan 由代码检查闸把关：文件、文档章节、符号、项目、主题都要在材料里核得到，篇数要在目标范围内，格式以外的字段一律退回。
`;

/** One material, numbered and labelled. */
function material(n: number, label: string, body: string): string {
  return `<材料 ${n}：${label}>\n${goTrimSpace(body)}\n</材料 ${n}>\n`;
}

function materialsHead(r: WikiPlanRunState): string {
  return `# 材料（从 origin/main ${shortWikiHash(r.repo.sha)} 与 Orbit 只读取出，${r.date}；space「${r.spaceTitle}」）\n\n`;
}

/**
 * What the catalogue is drafted from: the repository's overview, structure, documents and contracts, and the
 * owner's projects, the space's sessions and what the wiki already holds.
 */
export function wikiPlanFullMaterials(r: WikiPlanRunState): string {
  let b = materialsHead(r);
  let n = 0;
  const add = (label: string, body: string): void => {
    if (goTrimSpace(body) === '') return;
    n += 1;
    b += `${material(n, label, body)}\n`;
  };
  add('仓库概览（docs/README.md 与 docs/architecture.md，或 README.md）', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.full));
  add('仓库结构：各包、目录与源文件、入口、数据模型', r.repo.layoutText(WIKI_PLAN_MATERIAL_CAPS.layout.full));
  add('文档标题树：设计、契约与运维文档的章节', r.repo.docsTreeText(WIKI_PLAN_MATERIAL_CAPS.docsTree.full));
  add('contracts 清单', r.repo.contractsText());
  add('项目标题清单', wikiPlanProjectsText(r.materials));
  add('近期会话的统计与标题聚类', r.sessionsText);
  add('这个 space 的条目与主题', wikiPlanSpaceText(r.materials));
  return b;
}

/** What each category's documents are detailed from. */
export function wikiPlanDetailMaterials(r: WikiPlanRunState): string {
  return materialsHead(r)
    + `${material(1, '仓库概览', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.detail))}\n`
    + `${material(2, '文档清单与二级章节（只用这里出现的文档路径）', r.repo.docsTreeText(WIKI_PLAN_MATERIAL_CAPS.docsTree.detail))}\n`
    + `${material(3, '仓库结构（只用这里出现的代码路径）', r.repo.layoutText(WIKI_PLAN_MATERIAL_CAPS.layout.detail))}\n`
    + `${material(4, 'contracts 清单', r.repo.contractsText())}\n`
    + `${material(5, '项目标题清单（原样抄标题）', wikiPlanProjectsText(r.materials))}\n`
    + `${material(6, '这个 space 的主题', wikiPlanTopicsBrief(r.materials))}\n`;
}

/**
 * What one document's outline is written from: its documents' whole heading trees, its code's symbols, and the
 * topics it names — the targeted materials of the sample's doc_materials.
 */
export function wikiPlanDocMaterials(r: WikiPlanRunState, unit: WikiPlanUnit): string {
  const docs = [...unit.header.keyDocs];
  const code = [...unit.header.keyCode];
  const topics = [...unit.header.topics];
  const sections: Array<Pick<WikiPlanSectionDraft, 'docs' | 'code' | 'sessions'>> = [...unit.sections];
  if (unit.kept) {
    for (const s of wikiPlanDocInput(unit.kept).sections) {
      sections.push({ docs: s.sources.docs, code: s.sources.code, sessions: null });
      if (s.sources.sessions) topics.push(...s.sources.sessions.topics);
    }
  }
  for (const s of sections) {
    for (const d of s.docs) docs.push(d.path);
    for (const c of s.code) code.push(c.path);
    if (s.sessions) topics.push(...s.sessions.topics);
  }
  let trees = '';
  const seen = new Set<string>();
  for (const raw of docs) {
    let file = goTrimSpace(raw);
    if (file.startsWith('./')) file = file.slice(2);
    if (seen.has(file) || !r.repo.hasHeadings(file)) continue;
    seen.add(file);
    trees += r.repo.docBlock(file, 6);
  }
  if (trees === '') trees = '（这一篇还没有主要依据的文档，或它们不在文档清单里）\n';
  return materialsHead(r)
    + `${material(1, '仓库概览', r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.doc))}\n`
    + `${material(2, '全部文档的清单（路径 [字节数] — 标题）', r.repo.docIndexText())}\n`
    + `${material(3, '本篇主要依据的文档的章节树（「文档」行的 § 原样抄这里的章节标题）', trees)}\n`
    + `${material(4, '本篇相关代码的符号（格式「路径: 符号, 类.方法 [HTTP 路由], 函数()」；「代码」行原样抄这里的路径和符号）', r.repo.codeExcerpt(code, WIKI_PLAN_MATERIAL_CAPS.codeExcerpt))}\n`
    + `${material(5, 'contracts 清单', r.repo.contractsText())}\n`
    + `${material(6, '项目标题清单（「会话」行的项目原样抄这里的标题）', wikiPlanProjectsText(r.materials))}\n`
    + `${material(7, '这个 space 的主题与本篇相关主题里最近的条目（「会话」行的主题只用这里的 slug）', wikiPlanTopicBlocks(r.materials, topics))}\n`;
}

/** The catalogue as it stands, in the line format, with the documents' numbers now. */
export function wikiPlanCatalogueText(r: WikiPlanRunState): string {
  let b = '';
  r.cats.forEach((cat, c) => {
    b += `## ${c + 1}. ${cat.title} \`${cat.key}\` —— ${cat.question}${cat.forAgents ? ' [agents]' : ''}\n`;
    for (const unit of r.units) {
      if (unit.cat !== c) continue;
      const scope = unit.header.scopeIn.length > 0 ? unit.header.scopeIn : unit.cardScope;
      const mark = unit.protectedDoc ? '［受保护］' : '';
      b += `- ${unit.id} ${unit.title} \`${unit.slug}\`${mark}｜${unit.question}｜含：${scope.join('；')}\n`;
    }
    b += '\n';
  });
  return b;
}

/** The documents of the version revised the owner protected: a draft keeps them as they are. */
export function wikiPlanProtectedBlock(r: WikiPlanRunState): string {
  if (!r.base) return '';
  const lines: string[] = [];
  for (const [id, slug] of r.baseIds) {
    const doc = r.baseDocs.get(slug)!;
    if (doc.protected) lines.push(`- \`${doc.slug}\` ${doc.title}（现在的 ${id}，大类 \`${doc.category}\`）`);
  }
  if (lines.length === 0) return '';
  lines.sort(goCompare);
  return '\n## 受保护的篇（owner 设的，原样保留）\n下面这些篇必须出现在目录里：slug 不变，放在 key 相同的大类里（那个大类的 key 也不能改）；它们的内容不用你写，'
    + `也不能从它们移出任何一节。\n${lines.join('\n')}\n`;
}

function guidanceBlock(r: WikiPlanRunState): string {
  return r.instructions === '' ? '' : `\n## owner 的要求（照做）\n${r.instructions}\n`;
}

const CATALOGUE_FORMAT = '## 输出格式\n只输出下面的 Markdown，不要前言和总结：\n'
  + '## <大类序号>. <大类标题> `<大类 key：英文小写与短横线>` —— <这一类回答读者什么问题>（给 agent 的大类在行末加 [agents]）\n'
  + '- <篇 id，如 1.2> <中文标题> `<英文小写短横线 slug>`｜<读者带着什么问题来，一句话>｜含：<要点>；<要点>；<要点>\n';

/** Step 1: the catalogue's skeleton. */
export function wikiPlanSkeletonPrompt(r: WikiPlanRunState): string {
  return `
# 任务：起草 wiki「${r.spaceTitle}」的 plan —— 第一步：文档目录的骨架
${WIKI_PLAN_BACKGROUND}
## 要求
- 按产品功能组织，不按代码目录。一个大类下放若干篇文档；一篇文档回答读者的一组相关问题。
- 覆盖材料里出现的主要产品功能（参考仓库结构、文档标题树、contracts、项目与会话聚类）。一次性的数据或实验项目不单独成篇。
- 规模：共 ${r.target.min}–${r.target.max} 篇（检查闸按这个数拦，少了多了都退回），分成 5–12 个大类。相邻文档不重叠。
- 给写代码的 agent 看的开发约定（怎么跑测试、铺依赖、提交与合并、会话里怎么跑命令）单列一个大类，放在最后，这一行末尾写 [agents]。
- 篇的 slug 在整份目录里不重复；大类的 key 不重复。
${wikiPlanProtectedBlock(r)}${guidanceBlock(r)}
${CATALOGUE_FORMAT}`;
}

/** The catalogue again, with what the gate found in it. */
export function wikiPlanCatalogueRedoPrompt(r: WikiPlanRunState, errorLines: string): string {
  return `
# 任务：改正 wiki「${r.spaceTitle}」的 plan 的目录
这份目录没过检查闸，下面是逐条错误。改正每一条，其余保持原样：能保留的篇保留，slug 不变。
## 错误
${errorLines}
## 这一轮的目录
${wikiPlanCatalogueText(r)}
## 要求（同第一步）
- 共 ${r.target.min}–${r.target.max} 篇；给写代码的 agent 看的开发约定单列一个大类，放在最后，行末写 [agents]；篇的 slug 与大类的 key 都不重复。
${wikiPlanProtectedBlock(r)}${guidanceBlock(r)}
${CATALOGUE_FORMAT}`;
}

/** Step 2: one category's documents, each with its reader, scope, length and key materials. */
export function wikiPlanDetailPrompt(r: WikiPlanRunState, cat: number, ids: readonly string[]): string {
  return `
# 任务：起草 plan —— 第二步：给大类「${r.cats[cat].title}」下的每篇文档补全信息
上面是整份目录。只处理大类 ${cat + 1} 的这几篇：${ids.join('、')}。
${WIKI_PLAN_BACKGROUND}
## 每篇要写的
- 读者：写给谁看（如「新加入的开发者」「部署与运维的人」「写 agent 提示词的人」「owner」），每项写明读完要能做什么；
- 含：讲到的内容，3–6 条；不含：明确不讲的内容，每条注明归到哪篇（写目录里的篇 id）；
- 篇幅：中文字数范围；
- 文档：主要依据的设计或契约文档（只用材料 2 里出现的路径）；
- 代码：主要依据的代码位置（目录或文件，只用材料 3 里出现的路径）；
- 契约：相关契约文件（材料 4，没有就写「无」）；
- 主题：现有条目主要在哪些主题（只用材料 6 的 slug，没有就写「无」）；
- 项目：相关项目标题（原样抄材料 5 的标题，最多 5 个，没有就写「无」）。

## 输出格式
只输出下面的 Markdown，每篇一段，不要前言和总结：
### <篇 id> <标题>
读者：<谁>：<读完能做什么>；<谁>：<读完能做什么>
含：<要点>；<要点>；<要点>
不含：<内容>（见 <篇 id>）；<内容>（见 <篇 id>）
篇幅：<a–b 字>
文档：<docs/…>、<docs/…>
代码：<src/…>、<src/…>
契约：<contracts/… 或 无>
主题：<slug>、<slug>
项目：「<项目标题>」「<项目标题>」
`;
}

const OUTLINE_RULES = `
## 大纲
- 参考顺序：概述 → 概念 → 流程/状态机 → 接口 → 数据与配置 → 运维 → 已知的坑 → 决策与理由 → 约定。按本篇内容增删、合并或改名，不必每篇都全有。
- 5–9 节。每节给出：节标题、type（overview / concepts / flow / interface / data / ops / pitfalls / decisions / conventions / other 之一）、字数、讲什么（这一节具体讲什么，1–2 句，写实际内容，不写空话）。
- 只写本篇范围内的内容；目录里归到别篇的，不要写进来。提到别篇时写「见 <篇 id>」，篇 id 以目录为准。

## 每一节的材料来源
- 讲机制的节（concepts / flow / interface / data / ops），出处是代码和设计文档：文档写到章节标题（原样抄材料 3 的章节标题），代码写到文件和符号（原样抄材料 4 的路径与符号）。
- 「已知的坑」「决策与理由」「约定」这几节，出处是会话里的一手原文，由现有条目引路。要写明按什么条件去找：相关项目（原样抄材料 6 的标题）、时间窗、关键词、锚点路径（代码路径前缀）、条目 kind（principle / convention / decision / pitfall / recipe / concept）、现有主题 slug（只用材料 7 的），以及要找什么样的原文。
- 概述节可以没有自己的出处，但「讲什么」里要写它概括哪几节。
- 只引用材料里确实出现的文件、章节标题、符号、项目名、主题；找不到合适的就少写，不要编。

## 每一节的格式（一行一项，用不上的行省略，不要加别的行）
### <序号>. <节标题> | <type> | <中文字数>
讲什么：<这一节具体讲什么，1–2 句>
- 文档：<docs/….md> § <原样抄的章节标题>
- 代码：<src/… 文件路径>: <原样抄的符号名>, <符号名>
- 契约：<contracts/…>
- 会话：项目「<项目标题>」「…」；时间 <YYYY-MM-DD> 至 <YYYY-MM-DD 或 今>；关键词 <词>、<词>；锚点 <路径前缀>、<…>；kind <pitfall/decision/convention/…>；主题 <slug>；要找：<要找什么样的原文>
「文档」「代码」可以各写多行，每行一处。
`;

function firstNonEmptyList(...lists: string[][]): string[] {
  return lists.find((list) => list.length > 0) ?? [];
}

/** Step 3: one document's outline, and where each section's material comes from. */
export function wikiPlanOutlinePrompt(unit: WikiPlanUnit): string {
  const h = unit.header;
  const card = `- ${unit.id} ${unit.title} \`${unit.slug}\`｜${unit.question}\n读者：${h.audience.join('；')}\n`
    + `含：${firstNonEmptyList(h.scopeIn, unit.cardScope).join('；')}\n不含：${h.scopeOut.join('；')}\n篇幅：${h.length}\n`;
  return `
# 本篇
${card}
# 任务：起草 plan 的第三步 —— 给《${unit.title}》写大纲，并为每一节写明材料来源
${OUTLINE_RULES}
## 输出格式
只输出本篇的大纲，从第一个「### 1.」开始，不要前言和总结，不要 JSON。
`;
}

const DOC_FORMAT = `## 输出格式
只输出这一篇，不要前言和总结，不要 JSON。先写这六行，再写大纲：
标题：<中文标题>
问题：<读者带着什么问题来，一句话>
读者：<谁>：<读完能做什么>；<谁>：<读完能做什么>
含：<要点>；<要点>；<要点>
不含：<内容>（见 <篇 id>）；<内容>（见 <篇 id>）
篇幅：<a–b 字>

### 1. <节标题> | <type> | <中文字数>
讲什么：…
- 文档：…
- 代码：…
- 契约：…
- 会话：…
`;

/**
 * A revision's rewrite of one document: the documents of the version revised it is made from, and the sections
 * moved into it, as one coherent outline.
 */
export function wikiPlanRewritePrompt(r: WikiPlanRunState, unit: WikiPlanUnit, catalogue: string): string {
  let sources = '';
  const names = wikiPlanProjectNames(r);
  for (const id of unit.sources) {
    const slug = r.baseIds.get(id);
    if (slug === undefined) continue;
    const doc = wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs.get(slug)!), names);
    const drop = new Set<number>();
    for (const move of r.moves) if (move.from === id) drop.add(move.section);
    sources += `【现在的 ${id}《${doc.title}》】\n${wikiPlanDocLines(doc, true, drop)}\n`;
  }
  for (const move of r.moves) {
    if (move.target !== unit) continue;
    const slug = r.baseIds.get(move.from);
    if (slug === undefined) continue;
    const doc = wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs.get(slug)!), names);
    if (move.section >= 1 && move.section <= doc.sections.length) {
      sources += `【现在的 ${move.from} 第 ${move.section} 节（移入本篇）】${wikiPlanSectionLines(1, doc.sections[move.section - 1])}\n`;
    }
  }
  if (sources === '') sources = '（全新的一篇：没有现在的内容，按目录和 owner 的要求写）\n';
  return `${wikiPlanDocMaterials(r, unit)}
# 新目录（篇 id 以这里为准）
${catalogue}
# 任务：写新草稿里《${unit.title}》这一篇的读者、范围和大纲
## 这一篇在新目录里
- ${unit.id} ${unit.title} \`${unit.slug}\`｜${unit.question}｜含：${unit.cardScope.join('；')}
## owner 的要求
${r.instructions}
## 它由这些现在的内容组成（原大纲，含每节的材料来源）
${sources}
## 要求
- 把上面的内容合成一篇连贯的文档大纲：去掉重复，按读者要问的顺序排；5–10 节；已有的材料来源原样保留在对应的节下，不要编新的来源。
- 「不含」里写明归到哪篇，用新目录的篇 id。
${OUTLINE_RULES}
${DOC_FORMAT}`;
}

/** One document again, with what the gate found in it. */
export function wikiPlanRedoDocPrompt(
  r: WikiPlanRunState,
  unit: WikiPlanUnit,
  errs: readonly WikiPlanGateError[],
  last: WikiPlanAssembled,
  catalogue: string,
): string {
  let current = '';
  last.units.forEach((u, i) => {
    if (u === unit) current = wikiPlanDocLinesWithRefs(wikiPlanDocNamed(last.plan.docs[i], wikiPlanProjectNames(r)), last.slugIds);
  });
  return `
# 目录（篇 id 以这里为准）
${catalogue}
# 任务：改正 plan 里《${unit.title}》这一篇（${unit.id}）
这一篇没过检查闸，下面是逐条错误。改正每一条：文件、章节、符号、项目、主题只用材料里有的；找不到合适的出处就删掉那一处，不要编；其余保持原样。
## 错误
${wikiPlanErrorLines(errs, last)}
## 这一篇现在的样子
${current}
${OUTLINE_RULES}
${DOC_FORMAT}`;
}

/**
 * How a revision's prompts name the projects of the version it revises: by title, the way the drafting prompts
 * name every project and the gate reads them back — never by id, which a local model copies wrong. A project
 * keeps its id where its title is not one only it has in the owner's list (a title two projects share names
 * neither), where the list may be cut short (materialsProjectsMax), or where the title would not read back whole
 * from a session line.
 */
export function wikiPlanProjectNames(r: WikiPlanRunState): Map<string, string> {
  const names = new Map<string, string>();
  if (r.materials.projects.length >= WIKI_PLAN_MATERIALS_PROJECTS_MAX) return names;
  const titled = new Map<string, number>();
  for (const p of r.materials.projects) titled.set(p.title, (titled.get(p.title) ?? 0) + 1);
  for (const doc of r.baseDocs.values()) {
    for (const s of doc.sections) {
      const c = s.sources.sessions;
      if (!c) continue;
      for (const p of c.projects) {
        if (p.title === null || titled.get(p.title) !== 1) continue;
        const back = wikiPlanSessionsOf(wikiPlanSessionsLine({
          projects: [p.title], since: null, until: null, keywords: [], anchorPaths: [], entryKinds: [], topics: [], evidence: '',
        })).projects;
        if (back.length === 1 && back[0] === p.title) names.set(p.id, p.title);
      }
    }
  }
  return names;
}

/** `plan.jobs.rules.materialsProjectsMax`: a list that long may leave some out. */
export const WIKI_PLAN_MATERIALS_PROJECTS_MAX = 500;

/** A document as a prompt shows it: its session conditions' projects by the names given (wikiPlanProjectNames), any other as it is. */
export function wikiPlanDocNamed(doc: WikiPlanDoc, names: ReadonlyMap<string, string>): WikiPlanDoc {
  return {
    ...doc,
    sections: doc.sections.map((s) => (s.sources.sessions
      ? { ...s, sources: { ...s.sources, sessions: { ...s.sources.sessions, projects: s.sources.sessions.projects.map((p) => names.get(p) || p) } } }
      : s)),
  };
}

/**
 * A document in the line format with its scope-out targets as numbers of the catalogue now: what the model is
 * shown of what it wrote.
 */
export function wikiPlanDocLinesWithRefs(doc: WikiPlanDoc, slugIds: ReadonlyMap<string, string>): string {
  const shown: WikiPlanDoc = {
    ...doc,
    scopeOut: doc.scopeOut.map((out) => {
      const ids = out.docs.map((slug) => slugIds.get(slug) ?? slug);
      return { text: ids.length > 0 ? `${out.text}（见 ${ids.join('、')}）` : out.text, docs: [] };
    }),
  };
  return wikiPlanDocLines(shown, true, null);
}

/**
 * A revision's catalogue (R1): the version revised, the owner's instructions, and — in a later round — what the
 * gate found in the last one.
 */
export function wikiPlanRevisionCataloguePrompt(r: WikiPlanRunState, errs: readonly WikiPlanGateError[], errorLines: string): string {
  const base = r.base!;
  let brief = '';
  base.categories.forEach((cat, c) => {
    brief += `## ${c + 1}. ${cat.title} \`${cat.key}\` —— ${cat.question}${cat.forAgents ? ' [agents]' : ''}\n`;
    let n = 0;
    for (const doc of base.docs) {
      if (doc.category !== cat.key) continue;
      n += 1;
      const mark = doc.protected ? '［受保护］' : '';
      brief += `- ${c + 1}.${n} ${doc.title} \`${doc.slug}\`${mark}（${doc.length.min}–${doc.length.max} 字）：${doc.question}｜含：${doc.scopeIn.join('；')}\n`;
      doc.sections.forEach((s, i) => {
        brief += `    §${i + 1} ${s.title}（${s.kind}）：${cutRunes(s.covers, 120)}\n`;
      });
    }
    brief += '\n';
  });
  const again = errs.length > 0
    ? `\n## 上一轮修订出的目录没过检查闸，逐条错误如下，改正每一条\n${errorLines}\n## 上一轮修订出的目录\n${wikiPlanCatalogueText(r)}\n`
    : '';
  return `
# 任务：按 owner 的要求修订 plan 的目录（v${base.version} → 新草稿）

## owner 的要求
${r.instructions}

# 现在的 plan（v${base.version}，${base.categories.length} 个大类、${base.docs.length} 篇；每篇下列出它的节与类型）
${brief}${again}
## 要求
- 目标：共 ${r.target.min}–${r.target.max} 篇（检查闸按这个数拦，少了多了都退回）。合并时把被并入的篇的内容作为新篇的节，不丢内容；新篇的标题和问题要覆盖合并进来的内容。
- 标了［受保护］的篇原样保留：标题、slug、所在大类（key）都不改，也不从它们移出任何一节。
- 给写代码的 agent 看的开发约定单列一个大类，行末写 [agents]；只能把类型为 conventions 的节移过去，别的类型的节不移。
- 每篇都要写明「来源」：由现在的哪些篇组成（写现在的 id）；全新的一篇写「来源：无」。
- 新的篇 id 按新大类顺序编号；slug 沿用来源篇的 slug（合并时用主要来源的），全新的篇起新的 slug；大类 key 尽量沿用。

## 输出格式
只输出下面的 Markdown，不要前言：
## <大类序号>. <大类标题> \`<大类 key>\` —— <这一类回答读者什么问题>
- <新 id> <中文标题> \`<slug>\`｜<读者带着什么问题来>｜来源：<现在的 id>、<现在的 id>｜含：<要点>；<要点>；<要点>
（每篇一行）

最后写：
### 移到给 agent 的大类的节
- <现在的 id> §<节号> → <新 id>
（每行一节；没有就写「无」）
`;
}

/** Step 4: a draft of the rules the documents are written and maintained by. */
export function wikiPlanRulesPrompt(r: WikiPlanRunState): string {
  return `${r.repo.overviewText(WIKI_PLAN_MATERIAL_CAPS.overview.doc)}\n# 文档目录\n${wikiPlanCatalogueText(r)}
# 任务：起草 plan 的第四步 —— 三条规则的草案
这三条规则由维护作业和文档写作照着执行。请写成能照做、能用代码检查的规则。

## 不能违背的约束
- 出处只能是一手记录：turn / event / tool_call / task / task_comment / approval / evidence / owner_decision / merge_receipt / criterion / commit / note，以及 origin/main 上的代码与文档；wiki 条目和文档本身不能当出处。
- 会话原文交给模型之前先脱敏。
- 维护由事实触发（新会话结算、任务终态、审批回答、merge receipt、判据修订），不用定时器。
- 文档只是视图：不推送给 agent，不能被引用为出处。
- 讲机制的节，出处是代码和设计文档；坑、决策、约定，出处是会话原话，条目只作中间层（via entry）。

## 三条规则分别要回答
### 1. 引用规则：什么算事实陈述；每种出处的定位格式；脚注显示什么、链到哪里；什么原文立得住、新旧说法冲突时怎么选；概述句与过渡句怎么处理；核对不过的句子怎么办。
### 2. 归并规则：同一件事的多条条目、多段原文怎样合成「现状」；被推翻的旧说法放哪里；每条材料怎么记采用、合并还是舍弃。
### 3. 维护规则：新知识怎么按 plan 找到它该进的节、只重写受影响的节；条目被 Reject 或退役时怎么撤下引用它的句子；落不进任何一节的新知识怎么写成 plan 修改建议。

## 输出格式
只输出 Markdown：三个二级标题「## 引用规则」「## 归并规则」「## 维护规则」，下面用编号条目写。总长 2000–3500 字。
`;
}

const SECTION_PATH = /^plan\.docs\[(\d+)\](?:\.sections\[(\d+)\])?([^\n]*)$/u;

/** Errors as the model reads them: which document and section, then what is wrong. */
export function wikiPlanErrorLines(errs: readonly WikiPlanGateError[], last: WikiPlanAssembled): string {
  let b = '';
  for (const e of errs) {
    let where = e.path;
    const m = SECTION_PATH.exec(e.path);
    if (m) {
      const i = Number.parseInt(m[1], 10);
      if (i < last.plan.docs.length) {
        const doc = last.plan.docs[i];
        where = `${last.units[i].id}《${doc.title}》`;
        if (m[2] !== undefined && m[2] !== '') {
          const j = Number.parseInt(m[2], 10);
          if (j < doc.sections.length) where += ` 第 ${j + 1} 节「${doc.sections[j].title}」`;
        }
        const tail = (m[3] ?? '').startsWith('.') ? m[3].slice(1) : m[3] ?? '';
        if (tail !== '') where += ` · ${tail}`;
      }
    }
    b += `- [${e.check}] ${where}：${e.message}\n`;
  }
  return b;
}
