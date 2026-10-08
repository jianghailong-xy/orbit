import {
  WIKI_MAINTAIN_JOB,
  WIKI_PLAN_SECTION_KINDS,
  WIKI_SLUG_PATTERN,
  type WikiPlanVersion,
} from '@orbit/shared';
import { cutRunes, goTrimSpace } from './wiki-import-extract';
import {
  emptyWikiPlanHeader,
  parseWikiPlanDocBody,
  wikiPlanDocInput,
  wikiPlanLabel,
  wikiPlanRange,
  wikiPlanUnwrap,
  type WikiPlanCat,
  type WikiPlanDoc,
  type WikiPlanDocRead,
  type WikiPlanHeader,
  type WikiPlanSection,
  type WikiPlanSectionDraft,
} from './wiki-plan-format';
import { wikiQuote } from './wiki-plan-gate';

/**
 * The one change to the plan a maintenance run may propose (contracts/wiki.contract.json `plan.proposals`,
 * `maintenance.job.run.steps`, the docs step; design §8, P8): the knowledge the confirmed plan has no place
 * for — entries, and design documents new on origin/main that no section cites — put to the model, whose
 * answer is checked here against the space's snapshot and again by the server's gate. Ported from
 * `src/runner-go/wiki_maintain_docs.go` (proposePlanChange, wikiProposalPrompt, parseWikiProposal,
 * assembleWikiProposal, wikiProposalSection), which does the same on the runner until P10 removes it.
 *
 * What is not a port is where the repository is read: the runner held a document's headings, a file's
 * symbols and the contracts inventory to its checkout, and the server holds them to the space's snapshot of
 * origin/main (`WikiPlanRepo`, the same gate the plan job uses).
 *
 * Nothing here touches the database or the model: the job asks, and this reads.
 */

/** A design document origin/main has that it did not at the plan's commit, and no section cites. */
export interface WikiNewDesignDoc {
  path: string;
  renamedFrom: string;
  commit: string;
  title: string;
  headings: string[];
  opening: string;
}

/** An entry that fits no section of the confirmed plan (contract `docs.reads.affected.unplaced`). */
export interface WikiUnplacedEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  topics: string[];
  anchorPaths: string[];
  changedAt: string;
}

/** The confirmed plan as the proposal reads it: its version, its categories and its documents. */
export interface WikiMaintainPlanRead {
  version: number;
  categories: WikiPlanCat[];
  docs: WikiPlanDocRead[];
}

/** The repository's readings the proposal is held to, as the space's snapshot answers them. */
export interface WikiMaintainProposalRepo {
  /** A document of origin/main with a heading that reads as `section`. */
  hasDocSection(path: string, section: string): boolean;
  /** Whether a path names anything at the commit (a file, a directory, a glob). */
  hasPath(path: string): boolean;
  /** A source file that declares the symbol. */
  hasSymbol(path: string, symbol: string): boolean;
  /** A contracts/ file of origin/main. */
  hasContract(path: string): boolean;
}

/** One piece of knowledge the plan has no place for, as the model is told it. */
export interface WikiMaintainProposalItem {
  id: string;
  design?: WikiNewDesignDoc;
  entry?: WikiUnplacedEntry;
}

/** The model's answer, read. */
export interface WikiMaintainProposalAnswer {
  target: string;
  newDoc: boolean;
  reason: string;
  covers: string[];
  category: string;
  slug: string;
  header: WikiPlanHeader;
  sections: WikiPlanSectionDraft[];
  stray: string[];
}

/** The proposal the server gates, and what this side found wrong with it. */
export interface WikiMaintainProposalRequest {
  reason: string;
  change: { doc: WikiPlanDoc; category: WikiPlanCat | null };
  facts: Array<{ kind: string; id: string }>;
}

const COVER_ID = /K\d+/gu;

/** The plan's read as this module's shape: the version's categories and its documents with their sections' sources. */
export function wikiMaintainPlanOf(version: WikiPlanVersion): WikiMaintainPlanRead {
  return {
    version: version.version,
    categories: (version.categories ?? []).map((category) => ({
      key: category.key,
      title: category.title,
      question: category.question ?? '',
      forAgents: category.forAgents === true,
    })),
    docs: version.docs.map((doc) => ({
      category: doc.category,
      slug: doc.slug,
      title: doc.title,
      question: doc.question,
      audience: doc.audience,
      scopeIn: doc.scopeIn,
      scopeOut: doc.scopeOut,
      length: doc.length,
      protected: doc.protected === true,
      extra: (doc.extra ?? null) as Record<string, unknown> | null,
      sections: doc.sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        covers: section.covers,
        length: section.length,
        extra: (section.extra ?? null) as Record<string, unknown> | null,
        sources: {
          docs: (section.sources?.docs ?? []).map((source) => ({ path: source.path, section: source.section ?? null })),
          code: (section.sources?.code ?? []).map((source) => ({ path: source.path, symbols: source.symbols ?? [] })),
          contracts: (section.sources?.contracts ?? []).map((source) => ({ path: source.path })),
          sessions: section.sources?.sessions == null
            ? null
            : {
              projects: (section.sources.sessions.projects ?? []).map((project) => ({ id: project.id, title: project.title ?? null })),
              since: section.sources.sessions.since ?? null,
              until: section.sources.sessions.until ?? null,
              keywords: section.sources.sessions.keywords ?? [],
              anchorPaths: section.sources.sessions.anchorPaths ?? [],
              entryKinds: section.sources.sessions.entryKinds ?? [],
              topics: section.sources.sessions.topics ?? [],
              evidence: section.sources.sessions.evidence ?? '',
            },
        },
      })),
    })),
  };
}

/** The commit a design document landed in, cut for the prompt. */
function shortHash(sha: string): string {
  return sha.slice(0, 12);
}

/** Ask the model where the knowledge the plan has no place for belongs. */
export function wikiMaintainProposalPrompt(plan: WikiMaintainPlanRead, items: readonly WikiMaintainProposalItem[]): string {
  let knowledge = '';
  for (const item of items) {
    if (item.design) {
      const d = item.design;
      knowledge += `[${item.id}] 新设计文档 ${d.path}`;
      if (d.title !== '') knowledge += `「${d.title}」`;
      knowledge += `（提交 ${shortHash(d.commit)} 加入 origin/main`;
      if (d.renamedFrom !== '') knowledge += `，由 ${d.renamedFrom} 改名而来`;
      knowledge += '）\n';
      if (d.opening !== '') knowledge += `    开头：${d.opening}\n`;
      if (d.headings.length > 0) knowledge += `    章节：${d.headings.join('；')}\n`;
      continue;
    }
    if (item.entry) {
      const e = item.entry;
      knowledge += `[${item.id}] 条目（${e.kind}）「${e.title}」：${e.summary}`;
      if (e.anchorPaths.length > 0) knowledge += `；锚点 ${e.anchorPaths.join('、')}`;
      if (e.topics.length > 0) knowledge += `；主题 ${e.topics.join('、')}`;
      knowledge += '\n';
    }
  }
  let catalogue = '';
  for (const category of plan.categories) {
    catalogue += `## 大类 \`${category.key}\`「${category.title}」`;
    if (category.question) catalogue += ` —— ${category.question}`;
    catalogue += '\n';
    for (const doc of plan.docs) {
      if (doc.category !== category.key) continue;
      const titles = doc.sections.map((section, n) => `${n + 1}.${section.title}（${section.kind}）`);
      catalogue += `- \`${doc.slug}\`《${doc.title}》｜${doc.question}｜含：${doc.scopeIn.join('；')}\n  各节：${titles.join(' ')}\n`;
    }
  }
  return `
# 任务：维护作业的 plan 修改建议
这个 wiki 的文档按 owner 确认的 plan（第 ${plan.version} 版，目录见下）逐节写。维护作业找到了一些新知识，plan 里没有任何一节讲它们（下面「新知识」）。
请从中挑出能放在一起的一组——讲同一件事、放在同一处读起来连贯的几条（至少一条，挑不出就只挑一条；有新设计文档时先考虑它），建议放进 plan 的哪一篇：放进现有的一篇（给它加一节或几节），或者新增一篇。
和这一组讲的不是同一件事的新知识，这次不要放，留给下一次维护作业再提：不要为了一次放完，把不相干的知识凑进同一篇或同一节，也不要新增「杂项」「其他」「散落条目」这类没有具体主题的篇。不要改动别的篇，也不要删节。

## 新知识
${knowledge}
## plan 的目录
${catalogue}
## 每一节的材料来源
- 讲机制的节（concepts / flow / interface / data / ops）：出处写设计文档和代码。新设计文档写「- 文档：<路径> § <章节标题>」，章节标题原样抄上面列出的；不写 § 就是整篇。
- 已知的坑、决策与理由、约定（pitfalls / decisions / conventions）：出处写去会话里找原话的条件「- 会话：关键词 <词>、<词>；锚点 <路径前缀>；kind <pitfall/decision/convention/…>；主题 <slug>；要找：<要找什么样的原文>」。关键词要选新知识条目里确实出现的词。
- 只用上面出现过的路径、章节标题和主题；不要编造。

## 输出格式
只输出下面的内容，不要前言和总结，不要 JSON：
放入：<现有一篇的 slug，原样抄目录里反引号中的>（或者写「放入：新篇」）
理由：<一两句：新知识是什么，为什么放在这里>
覆盖：<这条建议用到的新知识编号，如 K1、K3>
如果是新篇，再写这几行：
大类：<目录里一个大类的 key>
slug：<新篇的 slug：小写字母、数字，用连字符连接>
标题：<中文标题>
问题：<读者带着什么问题来，一句话>
读者：<谁>：<读完能做什么>
含：<要点>；<要点>
篇幅：<a–b 字>
然后写要新增的节，一节或几节：
### 1. <节标题> | <type> | <中文字数>
讲什么：<这一节具体讲什么，1–2 句>
- 文档：<docs/….md> § <章节标题>
- 会话：关键词 …；锚点 …；kind …；主题 …；要找：…
`;
}

/** Hand back what was wrong with the last answer. */
export function wikiMaintainProposalRedo(problems: readonly string[]): string {
  const listed = problems.slice(0, 30);
  return `\n## 上一次的答案有这些问题，请改正后按同样的格式重写整个答案\n- ${listed.join('\n- ')}\n`;
}

/** Read the model's answer: its own lines first, then a document's header and sections in the plan's line format. */
export function parseWikiMaintainProposal(text: string): WikiMaintainProposalAnswer {
  const answer: WikiMaintainProposalAnswer = {
    target: '', newDoc: false, reason: '', covers: [], category: '', slug: '', header: emptyWikiPlanHeader(), sections: [], stray: [],
  };
  const rest: string[] = [];
  for (const raw of text.split('\n')) {
    const line = goTrimSpace(goTrimLeft(goTrimSpace(raw), '-*•'));
    const [label, value] = wikiPlanLabel(line);
    switch (label.toLowerCase()) {
      case '放入': {
        const trimmed = trimChars(value, '`「」《》 ');
        if (trimmed.includes('新篇') || trimmed.toLowerCase() === 'new') answer.newDoc = true;
        else answer.target = trimmed;
        continue;
      }
      case '理由':
        answer.reason = value;
        continue;
      case '覆盖':
        answer.covers = (value.toUpperCase().match(COVER_ID) ?? []);
        continue;
      case '大类':
        answer.category = trimChars(value, '`「」 ');
        continue;
      case 'slug':
        answer.slug = trimChars(value, '`「」 ');
        continue;
      default:
        rest.push(raw);
    }
  }
  const body = parseWikiPlanDocBody(rest.join('\n'));
  answer.header = body.header;
  answer.sections = body.sections;
  answer.stray = body.stray;
  return answer;
}

/** Go's strings.Trim. */
function trimChars(value: string, cutset: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && cutset.includes(value[start])) start += 1;
  while (end > start && cutset.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Go's strings.TrimLeft. */
function goTrimLeft(value: string, cutset: string): string {
  let start = 0;
  while (start < value.length && cutset.includes(value[start])) start += 1;
  return value.slice(start);
}

/**
 * Turn the answer into the proposal the server gates: the document as it should read — the plan's own, with
 * the new sections after its last, or a new one — and the facts it came from. What is wrong with it that this
 * side can see — a missing line, a kind the plan does not have, a file, document section, symbol or contract
 * origin/main does not have — comes back as problems, for the model.
 */
export function assembleWikiMaintainProposal(
  plan: WikiMaintainPlanRead,
  answer: WikiMaintainProposalAnswer,
  items: readonly WikiMaintainProposalItem[],
  repo: WikiMaintainProposalRepo,
): { request: WikiMaintainProposalRequest; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const facts: Array<{ kind: string; id: string }> = [];
  const seen = new Set<string>();
  for (const id of answer.covers) {
    const item = byId.get(id);
    if (!item) {
      problems.push(`「覆盖」里的 ${wikiQuote(id)} 不是新知识的编号`);
      continue;
    }
    const fact = item.design ? { kind: 'commit', id: item.design.commit } : { kind: 'entry', id: item.entry!.id };
    if (!seen.has(`${fact.kind}${fact.id}`)) {
      seen.add(`${fact.kind}${fact.id}`);
      facts.push(fact);
    }
  }
  if (goTrimSpace(answer.reason) === '') problems.push('「理由」一行缺了：写明新知识是什么、为什么放在这里');
  if (facts.length === 0) problems.push('「覆盖」一行缺了：列出这条建议用到的新知识编号，如 K1、K2');
  if (answer.sections.length === 0) problems.push('没有要新增的节：至少写一节「### 1. <节标题> | <type> | <中文字数>」');
  const sections: WikiPlanSection[] = [];
  answer.sections.forEach((draft, i) => {
    const made = wikiMaintainProposalSection(`第 ${i + 1} 节`, draft, repo);
    problems.push(...made.problems);
    sections.push(made.section);
  });
  for (const line of answer.stray) problems.push(`${wikiQuote(cutRunes(line, 60))} 不是这个格式里的一行：删掉它`);

  let doc: WikiPlanDoc;
  const category: WikiPlanCat | null = null;
  if (answer.newDoc) {
    const h = answer.header;
    doc = {
      category: answer.category,
      slug: answer.slug,
      title: h.title,
      question: h.question,
      audience: h.audience,
      scopeIn: h.scopeIn,
      scopeOut: [],
      length: { min: 0, max: 0 },
      sections,
    };
    if (!plan.categories.some((c) => c.key === answer.category)) {
      problems.push(`「大类」${wikiQuote(answer.category)} 不是目录里的大类：原样抄一个大类的 key`);
    }
    if (!new RegExp(WIKI_SLUG_PATTERN, 'u').test(answer.slug)) {
      problems.push(`「slug」${wikiQuote(answer.slug)} 不是 slug：小写字母和数字，用连字符连接`);
    }
    for (const existing of plan.docs) {
      if (existing.slug === answer.slug) {
        problems.push(`slug ${wikiQuote(answer.slug)} 已经是现有的一篇：新篇要用新的 slug，放进现有的一篇就写「放入：${answer.slug}」`);
      }
    }
    if (h.title === '' || h.question === '' || h.audience.length === 0 || h.scopeIn.length === 0) {
      problems.push('新篇要写全「标题」「问题」「读者」「含」「篇幅」五行');
    }
    const range = wikiPlanRange(h.length);
    if (range.ok) doc.length = { min: range.min, max: range.max };
    else problems.push(`「篇幅」${wikiQuote(h.length)} 不是篇幅：写成 <a–b 字>`);
  } else {
    const target = plan.docs.find((one) => one.slug === answer.target);
    if (!target) {
      problems.push(`「放入」${wikiQuote(answer.target)} 不是目录里的一篇：原样抄一篇的 slug，或写「放入：新篇」`);
      doc = { category: '', slug: '', title: '', question: '', audience: [], scopeIn: [], scopeOut: [], length: { min: 0, max: 0 }, sections: [] };
    } else {
      if (target.protected) problems.push(`${target.slug} 是受保护的篇，不能改：放进别的篇，或新增一篇`);
      const base = wikiPlanDocInput(target);
      doc = { ...base, protected: false, sections: [...base.sections, ...sections] };
    }
  }
  return {
    request: { reason: cutRunes(goTrimSpace(answer.reason), 2000), change: { doc, category }, facts },
    problems,
  };
}

/** One new section as the model wrote it, checked against the snapshot: its kind, its length, and every file, document section, symbol and contract it names. */
export function wikiMaintainProposalSection(
  at: string,
  draft: WikiPlanSectionDraft,
  repo: WikiMaintainProposalRepo,
): { section: WikiPlanSection; problems: string[] } {
  const problems: string[] = [];
  const section: WikiPlanSection = {
    title: draft.title,
    kind: wikiPlanUnwrap(draft.kind),
    covers: draft.covers,
    length: 0,
    sources: { docs: [], code: [], contracts: [], sessions: null },
  };
  if (!(WIKI_PLAN_SECTION_KINDS as readonly string[]).includes(section.kind)) {
    problems.push(`${at}的 type ${wikiQuote(section.kind)} 不是节的类型：${WIKI_PLAN_SECTION_KINDS.join('、')} 之一`);
  }
  const range = wikiPlanRange(draft.length);
  if (range.ok) section.length = range.min;
  else problems.push(`${at}的字数 ${wikiQuote(draft.length)} 不是数字`);
  if (goTrimSpace(draft.covers) === '') problems.push(`${at}缺「讲什么」`);
  section.sources.docs = draft.docs.map((source) => ({ path: source.path, section: source.section ?? null }));
  section.sources.code = draft.code.map((source) => ({ path: source.path, symbols: source.symbols ?? [] }));
  section.sources.contracts = draft.contracts.map((path) => ({ path }));
  for (const source of draft.docs) {
    const heading = source.section ?? '';
    if (repo.hasDocSection(source.path, heading)) continue;
    if (!repo.hasPath(source.path)) problems.push(`${at}的文档 ${wikiQuote(source.path)} 在 origin/main 上没有`);
    else problems.push(`${at}的文档 ${source.path} 里没有章节 ${wikiQuote(heading)}：原样抄新知识里列出的章节标题，或不写 §`);
  }
  for (const source of draft.code) {
    const symbols = source.symbols ?? [];
    const missing = symbols.length === 0
      ? (repo.hasPath(source.path) ? [] : [`${source.path} (not at origin/main)`])
      : symbols.filter((symbol) => !repo.hasSymbol(source.path, symbol)).map((symbol) => `${source.path}#${symbol}`);
    if (missing.length > 0) problems.push(`${at}的代码在 origin/main 上找不到：${missing.join('、')}`);
  }
  for (const path of draft.contracts) {
    if (!repo.hasContract(path)) problems.push(`${at}的契约 ${wikiQuote(path)} 在 origin/main 上没有`);
  }
  if (draft.sessions) {
    section.sources.sessions = {
      projects: draft.sessions.projects ?? [],
      since: draft.sessions.since || null,
      until: draft.sessions.until || null,
      keywords: draft.sessions.keywords ?? [],
      anchorPaths: draft.sessions.anchorPaths ?? [],
      entryKinds: (draft.sessions.entryKinds ?? []).map((kind) => wikiPlanUnwrap(kind)),
      topics: draft.sessions.topics ?? [],
      evidence: draft.sessions.evidence ?? '',
    };
  }
  return { section, problems };
}

/** The numbers a run's proposal is held to, re-exported for the job: rounds at most, items at most. */
export const WIKI_MAINTAIN_PROPOSAL = {
  roundsMax: WIKI_MAINTAIN_JOB.proposalRoundsMax,
  itemsMax: WIKI_MAINTAIN_JOB.proposalItemsMax,
} as const;
