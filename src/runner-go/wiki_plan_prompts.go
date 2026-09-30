package main

import (
	"fmt"
	"strings"
	"time"
)

// What the drafting job asks the model, step by step (the sample's draft_plan.py and p1_revise.py, made
// general): the materials each step reads, and the line format each answer is written in. The prompts are
// Chinese, as the owner's plan is; the paths, symbols and commands in them are the repository's own.

const wikiPlanBackground = `
## 背景
这个 wiki 给人读的主视图是一组「产品与技术文档」：读者打开一篇，就能知道这个功能是什么、怎么运转、接口在哪、怎么运维、有哪些已知的坑、为什么这么设计。
先起草一份 plan 交 owner 确认，再按 plan 定向取材、逐节写文档：讲机制的节，出处是设计文档、代码和契约；坑、决策、约定，出处是会话里的原话。
plan 由代码检查闸把关：文件、文档章节、符号、项目、主题都要在材料里核得到，篇数要在目标范围内，格式以外的字段一律退回。
`

// wrap is one material, numbered and labelled.
func wikiPlanMaterial(n int, label, body string) string {
	return fmt.Sprintf("<材料 %d：%s>\n%s\n</材料 %d>\n", n, label, strings.TrimSpace(body), n)
}

func (r *wikiPlanRun) materialsHead() string {
	return fmt.Sprintf("# 材料（从 origin/main %s 与 Orbit 只读取出，%s；space「%s」）\n\n", shortWikiHash(r.repo.sha),
		time.Now().UTC().Format("2006-01-02"), r.job.Space.Title)
}

// fullMaterials is what the catalogue is drafted from: the repository's overview, structure, documents
// and contracts, and the owner's projects, the space's sessions and what the wiki already holds.
func (r *wikiPlanRun) fullMaterials() string {
	var b strings.Builder
	b.WriteString(r.materialsHead())
	n := 0
	add := func(label, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		n++
		b.WriteString(wikiPlanMaterial(n, label, body) + "\n")
	}
	add("仓库概览（docs/README.md 与 docs/architecture.md，或 README.md）", r.repo.overviewText(14000))
	add("仓库结构：各包、目录与源文件、入口、数据模型", r.repo.layoutText(32000))
	add("文档标题树：设计、契约与运维文档的章节", r.repo.docsTreeText(45000))
	add("contracts 清单", r.repo.contractsText())
	add("项目标题清单", r.online.projectsText())
	add("近期会话的统计与标题聚类", r.online.sessionsText())
	add("这个 space 的条目与主题", r.online.spaceText())
	return b.String()
}

// detailMaterials is what each category's documents are detailed from.
func (r *wikiPlanRun) detailMaterials() string {
	var b strings.Builder
	b.WriteString(r.materialsHead())
	b.WriteString(wikiPlanMaterial(1, "仓库概览", r.repo.overviewText(10000)) + "\n")
	b.WriteString(wikiPlanMaterial(2, "文档清单与二级章节（只用这里出现的文档路径）", r.repo.docsTreeText(30000)) + "\n")
	b.WriteString(wikiPlanMaterial(3, "仓库结构（只用这里出现的代码路径）", r.repo.layoutText(26000)) + "\n")
	b.WriteString(wikiPlanMaterial(4, "contracts 清单", r.repo.contractsText()) + "\n")
	b.WriteString(wikiPlanMaterial(5, "项目标题清单（原样抄标题）", r.online.projectsText()) + "\n")
	b.WriteString(wikiPlanMaterial(6, "这个 space 的主题", r.online.topicsBrief()) + "\n")
	return b.String()
}

// docMaterials is what one document's outline is written from: its documents' whole heading trees, its
// code's symbols, and the topics it names — the targeted materials of the sample's doc_materials.
func (r *wikiPlanRun) docMaterials(unit *wikiPlanUnit) string {
	docs, code, topics := append([]string{}, unit.Header.KeyDocs...), append([]string{}, unit.Header.KeyCode...), append([]string{}, unit.Header.Topics...)
	sections := unit.Sections
	if unit.Kept != nil {
		kept := wikiPlanDocInput(*unit.Kept)
		for _, s := range kept.Sections {
			sections = append(sections, wikiPlanSectionDraft{Docs: s.Sources.Docs, Code: s.Sources.Code})
			if s.Sources.Sessions != nil {
				topics = append(topics, s.Sources.Sessions.Topics...)
			}
		}
	}
	for _, s := range sections {
		for _, d := range s.Docs {
			docs = append(docs, d.Path)
		}
		for _, c := range s.Code {
			code = append(code, c.Path)
		}
		if s.Sessions != nil {
			topics = append(topics, s.Sessions.Topics...)
		}
	}
	var trees strings.Builder
	seen := map[string]bool{}
	for _, file := range docs {
		file = strings.TrimPrefix(strings.TrimSpace(file), "./")
		if seen[file] || r.repo.headings[file] == nil {
			continue
		}
		seen[file] = true
		trees.WriteString(r.repo.docBlock(file, 6))
	}
	if trees.Len() == 0 {
		trees.WriteString("（这一篇还没有主要依据的文档，或它们不在文档清单里）\n")
	}
	var b strings.Builder
	b.WriteString(r.materialsHead())
	b.WriteString(wikiPlanMaterial(1, "仓库概览", r.repo.overviewText(8000)) + "\n")
	b.WriteString(wikiPlanMaterial(2, "全部文档的清单（路径 [字节数] — 标题）", r.repo.docIndexText()) + "\n")
	b.WriteString(wikiPlanMaterial(3, "本篇主要依据的文档的章节树（「文档」行的 § 原样抄这里的章节标题）", trees.String()) + "\n")
	b.WriteString(wikiPlanMaterial(4, "本篇相关代码的符号（格式「路径: 符号, 类.方法 [HTTP 路由], 函数()」；「代码」行原样抄这里的路径和符号）", r.repo.codeExcerpt(code, 16000)) + "\n")
	b.WriteString(wikiPlanMaterial(5, "contracts 清单", r.repo.contractsText()) + "\n")
	b.WriteString(wikiPlanMaterial(6, "项目标题清单（「会话」行的项目原样抄这里的标题）", r.online.projectsText()) + "\n")
	b.WriteString(wikiPlanMaterial(7, "这个 space 的主题与本篇相关主题里最近的条目（「会话」行的主题只用这里的 slug）", r.online.topicBlocks(topics)) + "\n")
	return b.String()
}

// catalogueText is the catalogue as it stands, in the line format, with the documents' numbers now.
func (r *wikiPlanRun) catalogueText() string {
	var b strings.Builder
	for c, cat := range r.cats {
		agents := ""
		if cat.ForAgents {
			agents = " [agents]"
		}
		fmt.Fprintf(&b, "## %d. %s `%s` —— %s%s\n", c+1, cat.Title, cat.Key, cat.Question, agents)
		for _, unit := range r.units {
			if unit.Cat != c {
				continue
			}
			scope := unit.CardScope
			if len(unit.Header.ScopeIn) > 0 {
				scope = unit.Header.ScopeIn
			}
			mark := ""
			if unit.Protected != nil {
				mark = "［受保护］"
			}
			fmt.Fprintf(&b, "- %s %s `%s`%s｜%s｜含：%s\n", unit.ID, unit.Title, unit.Slug, mark, unit.Question, strings.Join(scope, "；"))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// protectedBlock names the documents of the version revised the owner protected: a draft keeps them as they are.
func (r *wikiPlanRun) protectedBlock() string {
	if r.base == nil {
		return ""
	}
	var lines []string
	for id, slug := range r.baseIDs {
		doc := r.baseDocs[slug]
		if doc.Protected {
			lines = append(lines, fmt.Sprintf("- `%s` %s（现在的 %s，大类 `%s`）", doc.Slug, doc.Title, id, doc.Category))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	sortStrings(lines)
	return "\n## 受保护的篇（owner 设的，原样保留）\n下面这些篇必须出现在目录里：slug 不变，放在 key 相同的大类里（那个大类的 key 也不能改）；它们的内容不用你写，" +
		"也不能从它们移出任何一节。\n" + strings.Join(lines, "\n") + "\n"
}

func (r *wikiPlanRun) guidanceBlock() string {
	if r.instructions == "" {
		return ""
	}
	return "\n## owner 的要求（照做）\n" + r.instructions + "\n"
}

const wikiPlanCatalogueFormat = "## 输出格式\n只输出下面的 Markdown，不要前言和总结：\n" +
	"## <大类序号>. <大类标题> `<大类 key：英文小写与短横线>` —— <这一类回答读者什么问题>（给 agent 的大类在行末加 [agents]）\n" +
	"- <篇 id，如 1.2> <中文标题> `<英文小写短横线 slug>`｜<读者带着什么问题来，一句话>｜含：<要点>；<要点>；<要点>\n"

// skeletonPrompt is step 1: the catalogue's skeleton.
func (r *wikiPlanRun) skeletonPrompt() string {
	return fmt.Sprintf(`
# 任务：起草 wiki「%s」的 plan —— 第一步：文档目录的骨架
%s
## 要求
- 按产品功能组织，不按代码目录。一个大类下放若干篇文档；一篇文档回答读者的一组相关问题。
- 覆盖材料里出现的主要产品功能（参考仓库结构、文档标题树、contracts、项目与会话聚类）。一次性的数据或实验项目不单独成篇。
- 规模：共 %d–%d 篇（检查闸按这个数拦，少了多了都退回），分成 5–12 个大类。相邻文档不重叠。
- 给写代码的 agent 看的开发约定（怎么跑测试、铺依赖、提交与合并、会话里怎么跑命令）单列一个大类，放在最后，这一行末尾写 [agents]。
- 篇的 slug 在整份目录里不重复；大类的 key 不重复。
%s%s
%s`, r.job.Space.Title, wikiPlanBackground, r.target.Min, r.target.Max, r.protectedBlock(), r.guidanceBlock(), wikiPlanCatalogueFormat)
}

// catalogueRedoPrompt asks for the catalogue again, with what the gate found in it.
func (r *wikiPlanRun) catalogueRedoPrompt(errorLines string) string {
	return fmt.Sprintf(`
# 任务：改正 wiki「%s」的 plan 的目录
这份目录没过检查闸，下面是逐条错误。改正每一条，其余保持原样：能保留的篇保留，slug 不变。
## 错误
%s
## 这一轮的目录
%s
## 要求（同第一步）
- 共 %d–%d 篇；给写代码的 agent 看的开发约定单列一个大类，放在最后，行末写 [agents]；篇的 slug 与大类的 key 都不重复。
%s%s
%s`, r.job.Space.Title, errorLines, r.catalogueText(), r.target.Min, r.target.Max, r.protectedBlock(), r.guidanceBlock(), wikiPlanCatalogueFormat)
}

// detailPrompt is step 2: one category's documents, each with its reader, scope, length and key materials.
func (r *wikiPlanRun) detailPrompt(cat int, ids []string) string {
	return fmt.Sprintf(`
# 任务：起草 plan —— 第二步：给大类「%s」下的每篇文档补全信息
上面是整份目录。只处理大类 %d 的这几篇：%s。
%s
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
`, r.cats[cat].Title, cat+1, strings.Join(ids, "、"), wikiPlanBackground)
}

const wikiPlanOutlineRules = `
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
`

// outlinePrompt is step 3: one document's outline, and where each section's material comes from.
func (r *wikiPlanRun) outlinePrompt(unit *wikiPlanUnit) string {
	card := fmt.Sprintf("- %s %s `%s`｜%s\n读者：%s\n含：%s\n不含：%s\n篇幅：%s\n", unit.ID, unit.Title, unit.Slug, unit.Question,
		strings.Join(unit.Header.Audience, "；"), strings.Join(firstNonEmptyList(unit.Header.ScopeIn, unit.CardScope), "；"),
		strings.Join(unit.Header.ScopeOut, "；"), unit.Header.Length)
	return fmt.Sprintf(`
# 本篇
%s
# 任务：起草 plan 的第三步 —— 给《%s》写大纲，并为每一节写明材料来源
%s
## 输出格式
只输出本篇的大纲，从第一个「### 1.」开始，不要前言和总结，不要 JSON。
`, card, unit.Title, wikiPlanOutlineRules)
}

func firstNonEmptyList(lists ...[]string) []string {
	for _, list := range lists {
		if len(list) > 0 {
			return list
		}
	}
	return nil
}

const wikiPlanDocFormat = `## 输出格式
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
`

// rewritePrompt is a revision's rewrite of one document: the documents of the version revised it is made
// from, and the sections moved into it, as one coherent outline.
func (r *wikiPlanRun) rewritePrompt(unit *wikiPlanUnit, catalogue string) string {
	var sources strings.Builder
	for _, id := range unit.Sources {
		slug, ok := r.baseIDs[id]
		if !ok {
			continue
		}
		doc := wikiPlanDocInput(r.baseDocs[slug])
		drop := map[int]bool{}
		for _, move := range r.moves {
			if move.From == id {
				drop[move.Section] = true
			}
		}
		fmt.Fprintf(&sources, "【现在的 %s《%s》】\n%s\n", id, doc.Title, wikiPlanDocLines(doc, true, drop))
	}
	for _, move := range r.moves {
		if move.Target != unit {
			continue
		}
		slug, ok := r.baseIDs[move.From]
		if !ok {
			continue
		}
		doc := wikiPlanDocInput(r.baseDocs[slug])
		if move.Section >= 1 && move.Section <= len(doc.Sections) {
			fmt.Fprintf(&sources, "【现在的 %s 第 %d 节（移入本篇）】%s\n", move.From, move.Section, wikiPlanSectionLines(1, doc.Sections[move.Section-1]))
		}
	}
	if sources.Len() == 0 {
		sources.WriteString("（全新的一篇：没有现在的内容，按目录和 owner 的要求写）\n")
	}
	return r.docMaterials(unit) + fmt.Sprintf(`
# 新目录（篇 id 以这里为准）
%s
# 任务：写新草稿里《%s》这一篇的读者、范围和大纲
## 这一篇在新目录里
- %s %s `+"`%s`"+`｜%s｜含：%s
## owner 的要求
%s
## 它由这些现在的内容组成（原大纲，含每节的材料来源）
%s
## 要求
- 把上面的内容合成一篇连贯的文档大纲：去掉重复，按读者要问的顺序排；5–10 节；已有的材料来源原样保留在对应的节下，不要编新的来源。
- 「不含」里写明归到哪篇，用新目录的篇 id。
%s
%s`, catalogue, unit.Title, unit.ID, unit.Title, unit.Slug, unit.Question, strings.Join(unit.CardScope, "；"), r.instructions,
		sources.String(), wikiPlanOutlineRules, wikiPlanDocFormat)
}

// redoDocPrompt asks for one document again, with what the gate found in it.
func (r *wikiPlanRun) redoDocPrompt(unit *wikiPlanUnit, errs []wikiPlanGateError, last wikiPlanAssembled, catalogue string) string {
	current := ""
	for i, u := range last.units {
		if u == unit {
			current = wikiPlanDocLinesWithRefs(last.plan.Docs[i], last.slugIDs)
		}
	}
	return fmt.Sprintf(`
# 目录（篇 id 以这里为准）
%s
# 任务：改正 plan 里《%s》这一篇（%s）
这一篇没过检查闸，下面是逐条错误。改正每一条：文件、章节、符号、项目、主题只用材料里有的；找不到合适的出处就删掉那一处，不要编；其余保持原样。
## 错误
%s
## 这一篇现在的样子
%s
%s
%s`, catalogue, unit.Title, unit.ID, r.errorLines(errs, last), current, wikiPlanOutlineRules, wikiPlanDocFormat)
}

// wikiPlanDocLinesWithRefs is a document in the line format with its scope-out targets as numbers of the
// catalogue now: what the model is shown of what it wrote.
func wikiPlanDocLinesWithRefs(doc wikiPlanDoc, slugIDs map[string]string) string {
	shown := doc
	shown.ScopeOut = nil
	for _, out := range doc.ScopeOut {
		var ids []string
		for _, slug := range out.Docs {
			if id, ok := slugIDs[slug]; ok {
				ids = append(ids, id)
			} else {
				ids = append(ids, slug)
			}
		}
		text := out.Text
		if len(ids) > 0 {
			text += "（见 " + strings.Join(ids, "、") + "）"
		}
		shown.ScopeOut = append(shown.ScopeOut, wikiPlanScopeOut{Text: text})
	}
	return wikiPlanDocLines(shown, true, nil)
}

// revisionCataloguePrompt is a revision's catalogue (R1): the version revised, the owner's instructions,
// and — in a later round — what the gate found in the last one.
func (r *wikiPlanRun) revisionCataloguePrompt(errs []wikiPlanGateError, errorLines string) string {
	var brief strings.Builder
	for c, cat := range r.base.Categories {
		agents := ""
		if cat.ForAgents {
			agents = " [agents]"
		}
		fmt.Fprintf(&brief, "## %d. %s `%s` —— %s%s\n", c+1, cat.Title, cat.Key, cat.Question, agents)
		n := 0
		for _, doc := range r.base.Docs {
			if doc.Category != cat.Key {
				continue
			}
			n++
			id := fmt.Sprintf("%d.%d", c+1, n)
			mark := ""
			if doc.Protected {
				mark = "［受保护］"
			}
			fmt.Fprintf(&brief, "- %s %s `%s`%s（%d–%d 字）：%s｜含：%s\n", id, doc.Title, doc.Slug, mark, doc.Length.Min, doc.Length.Max,
				doc.Question, strings.Join(doc.ScopeIn, "；"))
			for i, s := range doc.Sections {
				fmt.Fprintf(&brief, "    §%d %s（%s）：%s\n", i+1, s.Title, s.Kind, cutRunes(s.Covers, 120))
			}
		}
		brief.WriteString("\n")
	}
	again := ""
	if len(errs) > 0 {
		again = fmt.Sprintf("\n## 上一轮修订出的目录没过检查闸，逐条错误如下，改正每一条\n%s\n## 上一轮修订出的目录\n%s\n", errorLines, r.catalogueText())
	}
	return fmt.Sprintf(`
# 任务：按 owner 的要求修订 plan 的目录（v%d → 新草稿）

## owner 的要求
%s

# 现在的 plan（v%d，%d 个大类、%d 篇；每篇下列出它的节与类型）
%s%s
## 要求
- 目标：共 %d–%d 篇（检查闸按这个数拦，少了多了都退回）。合并时把被并入的篇的内容作为新篇的节，不丢内容；新篇的标题和问题要覆盖合并进来的内容。
- 标了［受保护］的篇原样保留：标题、slug、所在大类（key）都不改，也不从它们移出任何一节。
- 给写代码的 agent 看的开发约定单列一个大类，行末写 [agents]；只能把类型为 conventions 的节移过去，别的类型的节不移。
- 每篇都要写明「来源」：由现在的哪些篇组成（写现在的 id）；全新的一篇写「来源：无」。
- 新的篇 id 按新大类顺序编号；slug 沿用来源篇的 slug（合并时用主要来源的），全新的篇起新的 slug；大类 key 尽量沿用。

## 输出格式
只输出下面的 Markdown，不要前言：
## <大类序号>. <大类标题> `+"`<大类 key>`"+` —— <这一类回答读者什么问题>
- <新 id> <中文标题> `+"`<slug>`"+`｜<读者带着什么问题来>｜来源：<现在的 id>、<现在的 id>｜含：<要点>；<要点>；<要点>
（每篇一行）

最后写：
### 移到给 agent 的大类的节
- <现在的 id> §<节号> → <新 id>
（每行一节；没有就写「无」）
`, r.base.Version, r.instructions, r.base.Version, len(r.base.Categories), len(r.base.Docs), brief.String(), again, r.target.Min, r.target.Max)
}

// rulesPrompt is step 4: a draft of the rules the documents are written and maintained by.
func (r *wikiPlanRun) rulesPrompt() string {
	return r.repo.overviewText(8000) + "\n# 文档目录\n" + r.catalogueText() + `
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
`
}
