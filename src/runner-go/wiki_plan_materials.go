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
	fmt.Fprintf(&b, "# Project titles (%s; all of the owner's projects, by when they were created)\n\n| Created | Status | Tasks | Sessions | Title |\n|---|---|---|---|---|\n", m.AsOf)
	for _, p := range m.Projects {
		created := p.CreatedAt
		if len(created) >= 10 {
			created = created[:10]
		}
		title := strings.NewReplacer("|", "/", "\n", " ").Replace(p.Title)
		fmt.Fprintf(&b, "| %s | %s | %d | %d | %s |\n", created, p.Status, p.Tasks, p.Sessions, cutRunes(title, 110))
	}
	fmt.Fprintf(&b, "\n%s in all. Projects with a very large number of tasks are bulk data projects, not product features.\n",
		wikiCount(len(m.Projects), "project", "projects"))
	return b.String()
}

// wikiPlanSessionPrefixes are the title prefixes a session's kind is read from: `Task: ` and `Judgment: ` as
// Orbit names those sessions, and the `执行任务：` and `判断：` older sessions were named with.
var wikiPlanSessionPrefixes = []struct {
	prefix *regexp.Regexp
	kind   string
}{
	{regexp.MustCompile(`^(?:Task:|执行任务：)`), "task run session"},
	{regexp.MustCompile(`^(?:Judgment:|判断：)`), "judgment session"},
	{regexp.MustCompile(`^\[VERIFY\]`), "verification session"},
}

// sessionsText is the space's sessions of the window: by month, kind, engine and project, and their
// titles clustered, each cluster with its frequent terms and a few titles.
func (m *wikiPlanMaterialsRead) sessionsText() string {
	items := m.Sessions.Items
	var b strings.Builder
	fmt.Fprintf(&b, "# Sessions of the last %d days (%s; this space's workspace)\n\n%s in all", m.Sessions.Days, m.AsOf,
		wikiCount(m.Sessions.Total, "session", "sessions"))
	if len(items) < m.Sessions.Total {
		fmt.Fprintf(&b, "; what follows reads the newest %d", len(items))
	}
	b.WriteString(".\n\n")
	byMonth, byKind, byEngine, byProject := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	titles := make([]string, 0, len(items))
	for _, item := range items {
		byMonth[item.Month]++
		title := strings.TrimSpace(item.Title)
		kind := "free session"
		for _, p := range wikiPlanSessionPrefixes {
			if prefix := p.prefix.FindString(title); prefix != "" {
				kind = p.kind
				title = strings.TrimSpace(title[len(prefix):])
				break
			}
		}
		if item.Task && kind == "free session" {
			kind = "task run session"
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
	fmt.Fprintf(&b, "By month: %s\n\nBy kind: %s\n\nBy engine: %s\n\n", wikiPlanCounts(byMonth, false, 0), wikiPlanCounts(byKind, true, 0), wikiPlanCounts(byEngine, true, 8))
	if len(byProject) > 0 {
		b.WriteString("## The projects with the most sessions (top 30)\n\n")
		for _, kv := range wikiPlanTop(byProject, 30) {
			fmt.Fprintf(&b, "- %d · %s\n", kv.n, cutRunes(kv.key, 100))
		}
		b.WriteString("\n")
	}
	groups, unclustered := wikiPlanCluster(titles, 36)
	if len(groups) > 0 {
		fmt.Fprintf(&b, "## Title clusters (TF-IDF + spherical k-means, k=%d; the \"Task:\" and \"Judgment:\" prefixes taken off; each group: "+
			"its sessions, frequent terms and example titles)\n\n", len(groups))
		for i, g := range groups {
			fmt.Fprintf(&b, "### Group %d (%s, %s) frequent terms: %s\n", i+1, wikiCount(g.size, "session", "sessions"),
				wikiCount(g.distinct, "distinct title", "distinct titles"), strings.Join(g.terms, " / "))
			for _, title := range g.examples {
				fmt.Fprintf(&b, "- %s\n", cutRunes(title, 90))
			}
			b.WriteString("\n")
		}
		if unclustered > 0 {
			fmt.Fprintf(&b, "(Not clustered: %s too short or made only of common words.)\n", wikiCount(unclustered, "title", "titles"))
		}
	}
	return b.String()
}

// spaceText is how the space's entries and topics are spread: kind by status, and each topic with its
// category, path prefixes, active entries and its newest ones.
func (m *wikiPlanMaterialsRead) spaceText() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# The space «%s» as it stands (%s)\n\nAn entry is an atomic fact; its kind is one of %s.\n\n## Entries by kind × status\n\n", m.Title, m.AsOf,
		strings.Join(wikiEntryKinds, " / "))
	if len(m.Entries) == 0 {
		b.WriteString("(no entries yet)\n")
	}
	for _, e := range m.Entries {
		fmt.Fprintf(&b, "- %s / %s: %d\n", e.Kind, e.Status, e.Count)
	}
	b.WriteString("\n## Existing topics (slug «name» category · active entries; path prefixes; the newest few entries)\n\n")
	if len(m.Topics) == 0 {
		b.WriteString("(no topics yet)\n")
	}
	for _, t := range m.Topics {
		category := "-"
		if t.Category != nil && *t.Category != "" {
			category = *t.Category
		}
		fmt.Fprintf(&b, "### %s «%s» category %s · %d active\n", t.Slug, t.Title, category, t.Active)
		if len(t.PathPrefixes) > 0 {
			fmt.Fprintf(&b, "Path prefixes: %s\n", strings.Join(t.PathPrefixes, " "))
		}
		for _, e := range t.Recent {
			fmt.Fprintf(&b, "- %s: %s\n", e.Kind, cutRunes(e.Title, 70))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// topicsBrief is the topics on one line: what a section's session condition may name.
func (m *wikiPlanMaterialsRead) topicsBrief() string {
	topics := make([]wikiPlanTopic, 0, len(m.Topics))
	for _, t := range m.Topics {
		topics = append(topics, wikiPlanTopic{Slug: t.Slug, Title: t.Title, Active: t.Active})
	}
	return wikiPlanTopicsBrief(topics)
}

// wikiPlanTopic is a topic of the space as a session condition may name it (contract `plan.gate.references`):
// its slug, its display name, and how many of the space's active entries name it.
type wikiPlanTopic struct {
	Slug   string `json:"slug"`
	Title  string `json:"title"`
	Active int    `json:"active"`
}

// wikiPlanTopicsBrief is topics on one line, as the drafting job's materials and the plan's gate list them.
func wikiPlanTopicsBrief(topics []wikiPlanTopic) string {
	if len(topics) == 0 {
		return "(this space has no topics yet: a session condition names no topic)"
	}
	parts := make([]string, 0, len(topics))
	for _, t := range topics {
		parts = append(parts, fmt.Sprintf("%s «%s» · %d", t.Slug, t.Title, t.Active))
	}
	return "Existing topics (slug «name» · active entries): " + strings.Join(parts, "; ")
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
		fmt.Fprintf(&b, "### %s «%s»\n", t.Slug, t.Title)
		for _, e := range t.Recent {
			fmt.Fprintf(&b, "- %s: %s\n", e.Kind, cutRunes(e.Title, 90))
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
		return "(none)"
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
	return strings.Join(parts, ", ")
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

// wikiPlanVec is a title's terms and their weights, in the order the terms were first met. Every sum over it
// runs in that order, so titles that tie cluster the same way on every run — and the same way as on the
// server, whose port of this keeps its terms in a Map, which iterates in that order too.
type wikiPlanVec struct {
	terms  []string
	weight map[string]float64
}

func newWikiPlanVec() *wikiPlanVec { return &wikiPlanVec{weight: map[string]float64{}} }

// add adds x to term's weight; a term met for the first time goes last.
func (v *wikiPlanVec) add(term string, x float64) {
	if _, ok := v.weight[term]; !ok {
		v.terms = append(v.terms, term)
	}
	v.weight[term] += x
}

func (v *wikiPlanVec) clone() *wikiPlanVec {
	out := &wikiPlanVec{terms: append([]string(nil), v.terms...), weight: make(map[string]float64, len(v.weight))}
	for term, x := range v.weight {
		out.weight[term] = x
	}
	return out
}

func wikiPlanNorm(v *wikiPlanVec) *wikiPlanVec {
	sum := 0.0
	for _, term := range v.terms {
		x := v.weight[term]
		sum += x * x
	}
	if sum == 0 {
		return v
	}
	n := math.Sqrt(sum)
	for _, term := range v.terms {
		v.weight[term] /= n
	}
	return v
}

func wikiPlanDotVec(a, b *wikiPlanVec) float64 {
	if len(a.terms) > len(b.terms) {
		a, b = b, a
	}
	s := 0.0
	for _, term := range a.terms {
		s += a.weight[term] * b.weight[term]
	}
	return s
}

// wikiPlanCluster groups titles by what they say (the sample's clustering, made deterministic: the first
// seed is the first title that has any term, and each next the one farthest from every seed), biggest
// group first. Answers the groups and how many titles had nothing to cluster by.
func wikiPlanCluster(titles []string, k int) ([]wikiPlanTitleGroup, int) {
	raw := make([]*wikiPlanVec, len(titles))
	df := map[string]int{}
	for i, title := range titles {
		terms := newWikiPlanVec()
		for _, word := range wikiPlanWord.FindAllString(strings.ToLower(title), -1) {
			terms.add("W:"+word, 2)
		}
		for _, run := range wikiPlanCJK.FindAllString(title, -1) {
			chars := []rune(run)
			for j := 0; j+1 < len(chars); j++ {
				terms.add("C:"+string(chars[j:j+2]), 1)
			}
		}
		raw[i] = terms
		for _, term := range terms.terms {
			df[term]++
		}
	}
	n := float64(len(titles))
	vecs := make([]*wikiPlanVec, len(titles))
	var idx []int
	for i, terms := range raw {
		v := newWikiPlanVec()
		for _, term := range terms.terms {
			if d := float64(df[term]); d >= 2 && d <= n*0.3 {
				v.add(term, terms.weight[term]*math.Log(1+n/d))
			}
		}
		vecs[i] = wikiPlanNorm(v)
		if len(v.terms) > 0 {
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
	cents := make([]*wikiPlanVec, len(seeds))
	for g, s := range seeds {
		cents[g] = vecs[s].clone()
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
		next := make([]*wikiPlanVec, len(cents))
		for g := range next {
			next[g] = newWikiPlanVec()
		}
		for _, i := range idx {
			for _, term := range vecs[i].terms {
				next[assign[i]].add(term, vecs[i].weight[term])
			}
		}
		for g := range next {
			if len(next[g].terms) > 0 {
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
			for _, term := range vecs[i].terms {
				weight[term] += vecs[i].weight[term]
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
