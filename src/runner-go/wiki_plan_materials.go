package main

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

// What the drafting job reads of Orbit besides the repository (contracts/wiki.contract.json
// `plan.jobs.materials`): the owner's projects, the space's sessions of the last ninety days, and how the
// space's entries and topics are spread — read through the runner door, the titles already redacted, and
// laid out here the way the sample's prep_online.py laid them out: counts, and the session titles
// clustered (TF-IDF over words and Chinese bigrams, spherical k-means), so the model sees what the work
// has been about without reading three thousand titles.

// wikiPlanMaterialsRead is `GET /api/runner/wiki/spaces/:id/plan/materials`.
type wikiPlanMaterialsRead struct {
	SpaceID string `json:"spaceId"`
	Title   string `json:"title"`
	AsOf    string `json:"asOf"`
	Repo    struct {
		URLNorm       string `json:"urlNorm"`
		RootCommitSha string `json:"rootCommitSha"`
	} `json:"repo"`
	Workspace *struct {
		ID      string `json:"id"`
		WorkDir string `json:"workDir"`
	} `json:"workspace"`
	Projects []struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		Status    string `json:"status"`
		CreatedAt string `json:"createdAt"`
		Tasks     int    `json:"tasks"`
		Sessions  int    `json:"sessions"`
	} `json:"projects"`
	Sessions struct {
		Days  int `json:"days"`
		Total int `json:"total"`
		Items []struct {
			Title    string  `json:"title"`
			Month    string  `json:"month"`
			Task     bool    `json:"task"`
			Project  *string `json:"project"`
			Provider *string `json:"provider"`
		} `json:"items"`
	} `json:"sessions"`
	Entries []struct {
		Kind   string `json:"kind"`
		Status string `json:"status"`
		Count  int    `json:"count"`
	} `json:"entries"`
	Topics []struct {
		Slug         string   `json:"slug"`
		Title        string   `json:"title"`
		Category     *string  `json:"category"`
		PathPrefixes []string `json:"pathPrefixes"`
		Active       int      `json:"active"`
		Recent       []struct {
			Kind  string `json:"kind"`
			Title string `json:"title"`
		} `json:"recent"`
	} `json:"topics"`
}

// projectsText is the owner's projects, oldest first: when, how it stands, how much work it holds.
func (m *wikiPlanMaterialsRead) projectsText() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 项目标题清单（%s；owner 的全部项目，按创建时间）\n\n| 创建 | 状态 | 任务数 | 会话数 | 标题 |\n|---|---|---|---|---|\n", m.AsOf)
	for _, p := range m.Projects {
		created := p.CreatedAt
		if len(created) >= 10 {
			created = created[:10]
		}
		title := strings.NewReplacer("|", "/", "\n", " ").Replace(p.Title)
		fmt.Fprintf(&b, "| %s | %s | %d | %d | %s |\n", created, p.Status, p.Tasks, p.Sessions, cutRunes(title, 110))
	}
	fmt.Fprintf(&b, "\n共 %d 个项目。任务数特别大的是批量数据项目，不是产品功能。\n", len(m.Projects))
	return b.String()
}

var wikiPlanSessionPrefixes = []struct{ prefix, kind string }{
	{"执行任务：", "任务执行会话"},
	{"判断：", "判断会话"},
	{"[VERIFY]", "验证会话"},
}

// sessionsText is the space's sessions of the window: by month, kind, engine and project, and their
// titles clustered, each cluster with its frequent terms and a few titles.
func (m *wikiPlanMaterialsRead) sessionsText() string {
	items := m.Sessions.Items
	var b strings.Builder
	fmt.Fprintf(&b, "# 近 %d 天的会话（%s；本 space 的 workspace）\n\n共 %d 个会话", m.Sessions.Days, m.AsOf, m.Sessions.Total)
	if len(items) < m.Sessions.Total {
		fmt.Fprintf(&b, "，下面读的是最新的 %d 个", len(items))
	}
	b.WriteString("。\n\n")
	byMonth, byKind, byEngine, byProject := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	titles := make([]string, 0, len(items))
	for _, item := range items {
		byMonth[item.Month]++
		title := strings.TrimSpace(item.Title)
		kind := "自由会话"
		for _, p := range wikiPlanSessionPrefixes {
			if strings.HasPrefix(title, p.prefix) {
				kind = p.kind
				title = strings.TrimSpace(strings.TrimPrefix(title, p.prefix))
				break
			}
		}
		if item.Task && kind == "自由会话" {
			kind = "任务执行会话"
		}
		byKind[kind]++
		if item.Provider != nil {
			byEngine[*item.Provider]++
		}
		if item.Project != nil && *item.Project != "" {
			byProject[*item.Project]++
		}
		titles = append(titles, title)
	}
	fmt.Fprintf(&b, "按月：%s\n\n按类型：%s\n\n按引擎：%s\n\n", wikiPlanCounts(byMonth, false, 0), wikiPlanCounts(byKind, true, 0), wikiPlanCounts(byEngine, true, 8))
	if len(byProject) > 0 {
		b.WriteString("## 会话最多的项目（前 30）\n\n")
		for _, kv := range wikiPlanTop(byProject, 30) {
			fmt.Fprintf(&b, "- %d · %s\n", kv.n, cutRunes(kv.key, 100))
		}
		b.WriteString("\n")
	}
	groups, unclustered := wikiPlanCluster(titles, 36)
	if len(groups) > 0 {
		fmt.Fprintf(&b, "## 标题聚类（TF-IDF + 球面 k-means，k=%d；去掉「执行任务：」「判断：」前缀；每组：会话数、高频词、示例标题）\n\n", len(groups))
		for i, g := range groups {
			fmt.Fprintf(&b, "### 组 %d（%d 个，不同标题 %d 个）高频词：%s\n", i+1, g.size, g.distinct, strings.Join(g.terms, " / "))
			for _, title := range g.examples {
				fmt.Fprintf(&b, "- %s\n", cutRunes(title, 90))
			}
			b.WriteString("\n")
		}
		if unclustered > 0 {
			fmt.Fprintf(&b, "（%d 个标题太短或全是常见词，未参与聚类。）\n", unclustered)
		}
	}
	return b.String()
}

// spaceText is how the space's entries and topics are spread: kind by status, and each topic with its
// category, path prefixes, active entries and its newest ones.
func (m *wikiPlanMaterialsRead) spaceText() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# space「%s」现状（%s）\n\n条目是原子事实，kind 取 %s。\n\n## 条目 kind × 状态\n\n", m.Title, m.AsOf, strings.Join(wikiEntryKinds, " / "))
	if len(m.Entries) == 0 {
		b.WriteString("（还没有条目）\n")
	}
	for _, e := range m.Entries {
		fmt.Fprintf(&b, "- %s / %s: %d\n", e.Kind, e.Status, e.Count)
	}
	b.WriteString("\n## 现有主题（slug「名称」分类 · active 条目数；路径前缀；最近的几条条目）\n\n")
	if len(m.Topics) == 0 {
		b.WriteString("（还没有主题）\n")
	}
	for _, t := range m.Topics {
		category := "-"
		if t.Category != nil && *t.Category != "" {
			category = *t.Category
		}
		fmt.Fprintf(&b, "### %s「%s」 分类 %s · active %d 条\n", t.Slug, t.Title, category, t.Active)
		if len(t.PathPrefixes) > 0 {
			fmt.Fprintf(&b, "路径前缀：%s\n", strings.Join(t.PathPrefixes, " "))
		}
		for _, e := range t.Recent {
			fmt.Fprintf(&b, "- %s：%s\n", e.Kind, cutRunes(e.Title, 70))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// topicsBrief is the topics on one line: what a section's session condition may name.
func (m *wikiPlanMaterialsRead) topicsBrief() string {
	if len(m.Topics) == 0 {
		return "（这个 space 还没有主题：会话条件里不写主题）"
	}
	parts := make([]string, 0, len(m.Topics))
	for _, t := range m.Topics {
		parts = append(parts, fmt.Sprintf("%s「%s」·%d", t.Slug, t.Title, t.Active))
	}
	return "现有主题（slug「名称」·active 条目数）：" + strings.Join(parts, "；")
}

// topicBlocks are the named topics with their newest entries: the materials of one document.
func (m *wikiPlanMaterialsRead) topicBlocks(slugs []string) string {
	var b strings.Builder
	b.WriteString(m.topicsBrief() + "\n")
	want := map[string]bool{}
	for _, slug := range slugs {
		want[strings.Trim(strings.TrimSpace(slug), "`")] = true
	}
	for _, t := range m.Topics {
		if !want[t.Slug] {
			continue
		}
		fmt.Fprintf(&b, "### %s「%s」\n", t.Slug, t.Title)
		for _, e := range t.Recent {
			fmt.Fprintf(&b, "- %s：%s\n", e.Kind, cutRunes(e.Title, 90))
		}
	}
	return b.String()
}

type wikiPlanCount struct {
	key string
	n   int
}

func wikiPlanTop(counts map[string]int, max int) []wikiPlanCount {
	out := make([]wikiPlanCount, 0, len(counts))
	for key, n := range counts {
		out = append(out, wikiPlanCount{key, n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].n != out[j].n {
			return out[i].n > out[j].n
		}
		return out[i].key < out[j].key
	})
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return out
}

func wikiPlanCounts(counts map[string]int, byCount bool, max int) string {
	if len(counts) == 0 {
		return "（无）"
	}
	var list []wikiPlanCount
	if byCount {
		list = wikiPlanTop(counts, max)
	} else {
		for key, n := range counts {
			list = append(list, wikiPlanCount{key, n})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].key < list[j].key })
	}
	parts := make([]string, 0, len(list))
	for _, kv := range list {
		parts = append(parts, fmt.Sprintf("%s %d", kv.key, kv.n))
	}
	return strings.Join(parts, "，")
}

// ── Clustering the titles ───────────────────────────────────────────────────────────────────────

type wikiPlanTitleGroup struct {
	size, distinct int
	terms          []string
	examples       []string
}

var (
	wikiPlanWord = regexp.MustCompile(`[a-z_][a-z0-9_.\-]{2,}`)
	wikiPlanCJK  = regexp.MustCompile(`[\p{Han}]+`)
)

type wikiPlanVec map[string]float64

func wikiPlanNorm(v wikiPlanVec) wikiPlanVec {
	sum := 0.0
	for _, x := range v {
		sum += x * x
	}
	if sum == 0 {
		return v
	}
	n := math.Sqrt(sum)
	for k, x := range v {
		v[k] = x / n
	}
	return v
}

func wikiPlanDotVec(a, b wikiPlanVec) float64 {
	if len(a) > len(b) {
		a, b = b, a
	}
	s := 0.0
	for k, x := range a {
		s += x * b[k]
	}
	return s
}

// wikiPlanCluster groups titles by what they say (the sample's clustering, made deterministic: the first
// seed is the first title that has any term, and each next the one farthest from every seed), biggest
// group first. Answers the groups and how many titles had nothing to cluster by.
func wikiPlanCluster(titles []string, k int) ([]wikiPlanTitleGroup, int) {
	raw := make([]map[string]float64, len(titles))
	df := map[string]int{}
	for i, title := range titles {
		terms := map[string]float64{}
		for _, word := range wikiPlanWord.FindAllString(strings.ToLower(title), -1) {
			terms["W:"+word] += 2
		}
		for _, run := range wikiPlanCJK.FindAllString(title, -1) {
			chars := []rune(run)
			for j := 0; j+1 < len(chars); j++ {
				terms["C:"+string(chars[j:j+2])]++
			}
		}
		raw[i] = terms
		for term := range terms {
			df[term]++
		}
	}
	n := float64(len(titles))
	vecs := make([]wikiPlanVec, len(titles))
	var idx []int
	for i, terms := range raw {
		v := wikiPlanVec{}
		for term, c := range terms {
			if d := float64(df[term]); d >= 2 && d <= n*0.3 {
				v[term] = c * math.Log(1+n/d)
			}
		}
		vecs[i] = wikiPlanNorm(v)
		if len(v) > 0 {
			idx = append(idx, i)
		}
	}
	if len(idx) == 0 {
		return nil, len(titles)
	}
	if k > len(idx)/3 {
		k = len(idx) / 3
	}
	if k < 1 {
		k = 1
	}
	seeds := []int{idx[0]}
	isSeed := map[int]bool{idx[0]: true}
	best := make(map[int]float64, len(idx))
	for _, i := range idx {
		best[i] = wikiPlanDotVec(vecs[i], vecs[idx[0]])
	}
	for len(seeds) < k {
		next, low := -1, math.Inf(1)
		for _, i := range idx {
			if !isSeed[i] && best[i] < low {
				next, low = i, best[i]
			}
		}
		if next < 0 {
			break
		}
		seeds = append(seeds, next)
		isSeed[next] = true
		for _, i := range idx {
			if d := wikiPlanDotVec(vecs[i], vecs[next]); d > best[i] {
				best[i] = d
			}
		}
	}
	cents := make([]wikiPlanVec, len(seeds))
	for g, s := range seeds {
		cents[g] = wikiPlanVec{}
		for term, x := range vecs[s] {
			cents[g][term] = x
		}
	}
	assign := make(map[int]int, len(idx))
	for round := 0; round < 8; round++ {
		for _, i := range idx {
			top, score := 0, math.Inf(-1)
			for g := range cents {
				if d := wikiPlanDotVec(vecs[i], cents[g]); d > score {
					top, score = g, d
				}
			}
			assign[i] = top
		}
		next := make([]wikiPlanVec, len(cents))
		for g := range next {
			next[g] = wikiPlanVec{}
		}
		for _, i := range idx {
			for term, x := range vecs[i] {
				next[assign[i]][term] += x
			}
		}
		for g := range next {
			if len(next[g]) > 0 {
				cents[g] = wikiPlanNorm(next[g])
			}
		}
	}
	members := map[int][]int{}
	for _, i := range idx {
		members[assign[i]] = append(members[assign[i]], i)
	}
	var groups []wikiPlanTitleGroup
	order := make([]int, 0, len(members))
	for g := range members {
		order = append(order, g)
	}
	sort.Slice(order, func(a, b int) bool {
		if len(members[order[a]]) != len(members[order[b]]) {
			return len(members[order[a]]) > len(members[order[b]])
		}
		return order[a] < order[b]
	})
	for _, g := range order {
		list := members[g]
		weight := map[string]float64{}
		distinct := map[string]bool{}
		for _, i := range list {
			distinct[titles[i]] = true
			for term, x := range vecs[i] {
				weight[term] += x
			}
		}
		terms := make([]string, 0, len(weight))
		for term := range weight {
			terms = append(terms, term)
		}
		sort.Slice(terms, func(a, b int) bool {
			if weight[terms[a]] != weight[terms[b]] {
				return weight[terms[a]] > weight[terms[b]]
			}
			return terms[a] < terms[b]
		})
		if len(terms) > 10 {
			terms = terms[:10]
		}
		for j := range terms {
			terms[j] = terms[j][2:]
		}
		sort.SliceStable(list, func(a, b int) bool {
			return wikiPlanDotVec(vecs[list[a]], cents[g]) > wikiPlanDotVec(vecs[list[b]], cents[g])
		})
		var examples []string
		seen := map[string]bool{}
		for _, i := range list {
			if !seen[titles[i]] {
				seen[titles[i]] = true
				examples = append(examples, titles[i])
			}
			if len(examples) == 5 {
				break
			}
		}
		groups = append(groups, wikiPlanTitleGroup{size: len(list), distinct: len(distinct), terms: terms, examples: examples})
	}
	return groups, len(titles) - len(idx)
}
