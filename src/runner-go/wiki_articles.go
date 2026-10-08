package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// `orbit wiki articles`: a Wiki maintenance run writes its space's articles (contracts/wiki.contract.json
// `articles`, criterion 9).
//
// THE SERVER DECIDES WHAT IT CAN; THE MODEL WRITES. The plan names the topics whose entry set changed
// — which topic an entry is in is the server's (its anchors' paths first), and so is the fingerprint
// of each set. For each such topic this reads its entries, and a topic too big for one article is
// grouped HERE, by code: the entries' anchor paths weigh most, then their words (the demo's tf-idf
// spherical k-means). The model only names each group and writes each article, from the entries
// alone — never a session's text. What it wrote goes back to the server, which keeps a footnote only
// when it names an entry of the topic, deletes a sentence left without one, and cuts what passes the
// length the owner asked for. So nothing the model says about which entry backs a sentence is taken
// on trust.
//
// THE MODEL IS CALLED THE WAY `orbit wiki verify` CALLS IT (wiki_verify.go): the same clean launch —
// --bare, an empty HOME and CLAUDE_CONFIG_DIR, no tools and no MCP server, no session file — the same
// environment allowlist and the same apiKeyHelper, with the writer's own system prompt, and thinking
// off: CLAUDE_CODE_EFFORT_LEVEL=unset and MAX_THINKING_TOKENS=0 (the first alone still sends an
// adaptive thinking block). It stops at the first 401: every call after it would be refused the same
// way, and a real Claude Code spends three minutes retrying each.
//
// NO CLOCK. Nothing here schedules itself: the maintenance run (criterion 3) calls this when facts
// arrived, and a topic whose entries did not change is not written again.

// wikiArticlesPrecondition is contracts/wiki.contract.json `articles.cli.precondition`, word for word,
// and wiki_articles_test.go holds the two equal.
const wikiArticlesPrecondition = "Write articles only as a Wiki maintenance run of the space, and only from what the " +
	"model wrote: every sentence keeps a footnote to one of the topic's entries or is deleted, and a topic whose " +
	"entries did not change is left as it is."

var wikiArticlesDescription = wikiArticlesPrecondition + " This is a Wiki maintenance run's writing of its " +
	"space's articles: it asks the plan for the topics whose entry set changed (--topic, one of them), reads each " +
	"one's entries, groups a topic of more than " + strconv.Itoa(wikiArticleSplitAbove) + " entries into subtopics by their anchor paths and words, " +
	"has the local model — this session's provider's (ANTHROPIC_MODEL at ANTHROPIC_BASE_URL, the token in " +
	"ANTHROPIC_AUTH_TOKEN), through a clean Claude Code with thinking off — name each group and write each article " +
	"from the entries alone, and writes the topic's articles, which the server keeps only as far as their footnotes " +
	"name the topic's entries. It stops at the first 401 from the model's endpoint, and exits non-zero when any " +
	"topic it took up was left unwritten. Any session but a maintenance run of the space is refused " +
	"WIKI_NOT_MAINTENANCE_SESSION. For an account the Orbit server runs the wiki for (ORBIT_WIKI_EXECUTOR server, or " +
	"canary with the account on its list) the server answers WIKI_SERVER_EXECUTES: its wiki worker writes the " +
	"articles, so this asks no model, says so and exits 0."

// wikiArticleSystemPrompt is the whole system prompt the clean call carries (the demo's): the rest is
// in the prompt, one article or one name at a time.
const wikiArticleSystemPrompt = "You write concise encyclopedia-style wiki articles from given knowledge entries. " +
	"You output only what is asked."

// The contract's numbers (`articles.rules`), which wiki_articles_test.go holds to the JSON.
const (
	wikiArticleMinChars          = 400
	wikiArticleMaxChars          = 900
	wikiArticleSplitAbove        = 45
	wikiArticleGroupTarget       = 40
	wikiArticleGroupsMax         = 40
	wikiArticleGroupMin          = 8
	wikiArticleEntriesPerArticle = 30
	wikiArticleTitleMaxChars     = 120
)

const (
	// One article from the local model: decoding runs at tens of tokens a second, slower on a shared GPU.
	wikiArticleCallTimeout = 15 * time.Minute
	// The plan and a topic's input read every entry of the space: heavier than the door's other reads.
	wikiArticleReadTimeout = 2 * time.Minute
	// Calls in flight at once: the demo's eight saturated the GPU for everyone else on it.
	wikiArticleParallel = 4
	// A group whose model name cannot be read is named after the path most of it shares.
	wikiArticleNameMaxChars = 24
	// A draft shorter than rules.minChars is asked for again once, when its pool is at least this big:
	// a topic of three entries has not got 400 characters to say.
	wikiArticleRetryPoolMin = 8
)

var wikiSlugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ── The server's three routes ───────────────────────────────────────────────────────────────────

// wikiArticlePlan is `POST /api/runner/wiki/spaces/:id/article-plan`.
type wikiArticlePlan struct {
	SpaceID    string `json:"spaceId"`
	Seeded     int    `json:"seeded"`
	Entries    int    `json:"entries"`
	Unassigned int    `json:"unassigned"`
	Topics     []struct {
		Slug           string  `json:"slug"`
		Title          string  `json:"title"`
		Category       *string `json:"category"`
		EntryCount     int     `json:"entryCount"`
		EntrySetSha256 string  `json:"entrySetSha256"`
		ArticleSha256  *string `json:"articleSha256"`
		Changed        bool    `json:"changed"`
	} `json:"topics"`
}

// wikiArticleInput is `GET /api/runner/wiki/spaces/:id/articles/:slug/input`.
type wikiArticleInput struct {
	SpaceID string `json:"spaceId"`
	Topic   struct {
		Slug        string  `json:"slug"`
		Title       string  `json:"title"`
		Category    *string `json:"category"`
		Description *string `json:"description"`
	} `json:"topic"`
	EntrySetSha256 string             `json:"entrySetSha256"`
	ArticleSha256  *string            `json:"articleSha256"`
	Entries        []wikiArticleEntry `json:"entries"`
}

// wikiArticleEntry is one entry an article is written from, best supported first.
type wikiArticleEntry struct {
	ID       string                 `json:"id"`
	Revision int                    `json:"revision"`
	Kind     string                 `json:"kind"`
	Title    string                 `json:"title"`
	Summary  string                 `json:"summary"`
	Fields   map[string]interface{} `json:"fields"`
	Paths    []string               `json:"paths"`
	Sources  int                    `json:"sources"`
}

// wikiArticlePart is one part of `POST /api/runner/wiki/spaces/:id/articles/:slug`.
type wikiArticlePart struct {
	Part     int      `json:"part"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title"`
	Markdown string   `json:"markdown"`
	Notes    []string `json:"notes"`
	Entries  []string `json:"entries,omitempty"`
}

type wikiArticleWrite struct {
	EntrySetSha256 string            `json:"entrySetSha256"`
	Ref            string            `json:"ref,omitempty"`
	Model          string            `json:"model,omitempty"`
	Articles       []wikiArticlePart `json:"articles"`
}

// wikiArticleStats is what the server's validation did (contract `articles.validation`).
type wikiArticleStats struct {
	Sentences        int `json:"sentences"`
	SentencesDeleted int `json:"sentencesDeleted"`
	Markers          int `json:"markers"`
	MarkersStripped  int `json:"markersStripped"`
	SentencesTrimmed int `json:"sentencesTrimmed"`
	Chars            int `json:"chars"`
	Footnotes        int `json:"footnotes"`
}

func (s *wikiArticleStats) add(o wikiArticleStats) {
	s.Sentences += o.Sentences
	s.SentencesDeleted += o.SentencesDeleted
	s.Markers += o.Markers
	s.MarkersStripped += o.MarkersStripped
	s.SentencesTrimmed += o.SentencesTrimmed
	s.Chars += o.Chars
	s.Footnotes += o.Footnotes
}

type wikiArticleWriteAnswer struct {
	Written   bool    `json:"written"`
	Unchanged bool    `json:"unchanged"`
	Reason    *string `json:"reason"`
	Parts     []struct {
		Part  int              `json:"part"`
		Kind  string           `json:"kind"`
		Title string           `json:"title"`
		Kept  bool             `json:"kept"`
		Stats wikiArticleStats `json:"stats"`
	} `json:"parts"`
	Stats wikiArticleStats `json:"stats"`
}

func (t *Transport) planWikiArticles(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/article-plan"
	// A POST only because a space with no topic is given the default ones, which happens once: a space that
	// has topics is given none (and the insert skips duplicates), so the plan may be asked for again.
	_, err := t.doWiki(http.MethodPost, path, map[string]interface{}{}, &out, wikiArticleReadTimeout, sessionHeader(sessionID), true)
	return out, err
}

func (t *Transport) wikiArticleInput(sessionID, spaceID, slug string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/articles/" + url.PathEscape(slug) + "/input"
	_, err := t.doWiki(http.MethodGet, path, nil, &out, wikiArticleReadTimeout, sessionHeader(sessionID), true)
	return out, err
}

func (t *Transport) writeWikiArticles(sessionID, spaceID, slug string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/articles/" + url.PathEscape(slug)
	// A topic's articles are replaced whole, and only when the stored ones were written from another entry
	// set: the same write landing again finds its own fingerprint stored, and answers unchanged.
	_, err := t.doWiki(http.MethodPost, path, body, &out, wikiArticleReadTimeout, sessionHeader(sessionID), true)
	return out, err
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiArticlesSummary is what a run did, and what `--json` prints.
type wikiArticlesSummary struct {
	SpaceID   string                 `json:"spaceId"`
	Model     string                 `json:"model"`
	Seeded    int                    `json:"seeded"`
	Topics    []wikiArticlesTopicRun `json:"topics"`
	Written   int                    `json:"written"`
	Unchanged int                    `json:"unchanged"`
	Failed    int                    `json:"failed"`
	Calls     int                    `json:"calls"`
	Usage     wikiModelUsage         `json:"usage"`
	Stats     wikiArticleStats       `json:"stats"`
	Stopped   string                 `json:"stopped,omitempty"`
	// ServerExecutes is a run the server answered WIKI_SERVER_EXECUTES: the account's articles are the server's
	// wiki worker's to write, so this one asked no model and wrote nothing.
	ServerExecutes bool `json:"serverExecutes,omitempty"`
}

// wikiArticlesTopicRun is one topic the run took up.
type wikiArticlesTopicRun struct {
	Slug    string                `json:"slug"`
	Entries int                   `json:"entries"`
	Outcome string                `json:"outcome"` // written | unchanged | failed
	Why     string                `json:"why,omitempty"`
	Parts   []wikiArticlesPartRun `json:"parts,omitempty"`
}

type wikiArticlesPartRun struct {
	Part    int              `json:"part"`
	Kind    string           `json:"kind"`
	Title   string           `json:"title"`
	Entries int              `json:"entries"`
	Kept    bool             `json:"kept"`
	Stats   wikiArticleStats `json:"stats"`
}

// wikiModelUsage is what the model calls cost, as Claude Code reported it.
type wikiModelUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
}

// wikiArticleAuthError is the model's endpoint refusing the token: every call after it would be too.
type wikiArticleAuthError struct{ detail string }

func (e *wikiArticleAuthError) Error() string {
	return "the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's provider " +
		"injected; no more articles were written. " + e.detail
}

// wikiArticlesConfigFromEnv is the model the articles are written with: the one this session's provider
// injected, as `orbit wiki verify` reads it. --model names another model on the same endpoint.
func wikiArticlesConfigFromEnv(model string) (wikiVerifyConfig, error) {
	cfg := wikiVerifyConfig{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
		token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
		model:   firstNonEmpty(strings.TrimSpace(model), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
	}
	switch {
	case cfg.baseURL == "":
		return cfg, fmt.Errorf("orbit wiki articles has the model this session's provider names write them, and this " +
			"session's environment names no endpoint (ANTHROPIC_BASE_URL): run it in a session on the local model's provider")
	case cfg.token == "":
		return cfg, fmt.Errorf("orbit wiki articles reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is " +
			"not set in this session: run it in a session on the local model's provider")
	case cfg.model == "":
		return cfg, fmt.Errorf("orbit wiki articles needs the model to write with: ANTHROPIC_MODEL, which this session's " +
			"provider names, is not set — pass --model")
	}
	return cfg, nil
}

// wikiArticlesRun is one run's state: where it reports, and what it has spent.
type wikiArticlesRun struct {
	t         *Transport
	sessionID string
	spaceID   string
	cfg       wikiVerifyConfig
	claude    string
	ref       string
	progress  io.Writer

	mu    sync.Mutex
	calls int
	usage wikiModelUsage
}

// runWikiArticles writes the articles of the topics whose entries changed — or of the one --topic
// names — and says what it did. The model's config is read only once there is something to write.
func runWikiArticles(t *Transport, sessionID, spaceID, only, model string, progress io.Writer) (summary wikiArticlesSummary, err error) {
	summary = wikiArticlesSummary{SpaceID: spaceID, Topics: []wikiArticlesTopicRun{}}
	raw, err := t.planWikiArticles(sessionID, spaceID)
	if wikiServerExecutes(err) {
		summary.ServerExecutes = true
		return summary, nil
	}
	if err != nil {
		return summary, wikiArticlesCallError(spaceID, "", err)
	}
	var plan wikiArticlePlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return summary, fmt.Errorf("orbit wiki articles: the server's plan is not the shape this build reads: %w", err)
	}
	summary.Seeded = plan.Seeded
	if plan.Seeded > 0 {
		fmt.Fprintf(progress, "Space %s had no topic: it was given the %s every space starts with.\n", spaceID, wikiCount(plan.Seeded, "default topic", "default topics"))
	}
	targets := []string{}
	found := only == ""
	for _, topic := range plan.Topics {
		if only != "" && topic.Slug != only {
			continue
		}
		found = true
		if !topic.Changed {
			if only != "" {
				summary.Unchanged++
				summary.Topics = append(summary.Topics, wikiArticlesTopicRun{Slug: topic.Slug, Entries: topic.EntryCount, Outcome: "unchanged"})
				fmt.Fprintf(progress, "topic %s: its articles were written from exactly these %s already, so nothing is written.\n",
					topic.Slug, wikiCount(topic.EntryCount, "entry", "entries"))
			}
			continue
		}
		targets = append(targets, topic.Slug)
	}
	if !found {
		return summary, fmt.Errorf("orbit wiki articles: space %s has no topic %q: `--topic` names one of the slugs its plan lists", spaceID, only)
	}
	if len(targets) == 0 {
		return summary, nil
	}
	cfg, err := wikiArticlesConfigFromEnv(model)
	if err != nil {
		return summary, err
	}
	summary.Model = cfg.model
	// The verifier's Claude Code: the binary this session runs on, or the machine's own.
	claude, err := wikiVerifyClaudePath()
	if err != nil {
		return summary, err
	}
	if err := wikiVerifyEndpointUp(cfg.baseURL); err != nil {
		return summary, err
	}
	run := &wikiArticlesRun{t: t, sessionID: sessionID, spaceID: spaceID, cfg: cfg, claude: claude, ref: wikiArticlesRef(), progress: progress}
	// Named results: what the calls cost is written into the summary however the run ends.
	defer func() {
		summary.Calls = run.calls
		summary.Usage = run.usage
	}()
	for _, slug := range targets {
		result, stop := run.topic(slug)
		if errors.Is(stop, errWikiServerExecutes) {
			// The switch gave the account to the server while this ran: what is left is the server's to write.
			summary.ServerExecutes = true
			return summary, nil
		}
		summary.Topics = append(summary.Topics, result)
		switch result.Outcome {
		case "written":
			summary.Written++
		case "unchanged":
			summary.Unchanged++
		default:
			summary.Failed++
		}
		for _, part := range result.Parts {
			summary.Stats.add(part.Stats)
		}
		if stop != nil {
			summary.Stopped = stop.Error()
			return summary, stop
		}
	}
	return summary, nil
}

// wikiArticlesRef is the commit the checkout's origin/main stands at: the ref the articles are
// "generated at" (design §12.1). Empty when there is no such ref here.
func wikiArticlesRef() string {
	out, err := exec.Command("git", "rev-parse", "--verify", "-q", "origin/main^{commit}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// topic writes one topic's articles. It answers a stop — a 401 — as its second value, which ends the run.
func (r *wikiArticlesRun) topic(slug string) (wikiArticlesTopicRun, error) {
	result := wikiArticlesTopicRun{Slug: slug}
	fail := func(why string) wikiArticlesTopicRun {
		result.Outcome = "failed"
		result.Why = why
		fmt.Fprintf(r.progress, "topic %s: not written — %s\n", slug, why)
		return result
	}
	raw, err := r.t.wikiArticleInput(r.sessionID, r.spaceID, slug)
	if wikiServerExecutes(err) {
		return result, errWikiServerExecutes
	}
	if err != nil {
		return fail(wikiArticlesCallError(r.spaceID, slug, err).Error()), nil
	}
	var input wikiArticleInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return fail("the server's input is not the shape this build reads: " + err.Error()), nil
	}
	result.Entries = len(input.Entries)
	if len(input.Entries) == 0 {
		return fail("the topic has no entry to write from"), nil
	}
	parts, err := r.compose(input)
	var auth *wikiArticleAuthError
	if errors.As(err, &auth) {
		return fail("the model endpoint answered 401"), err
	}
	if err != nil {
		return fail(err.Error()), nil
	}
	body := wikiArticleWrite{EntrySetSha256: input.EntrySetSha256, Ref: r.ref, Model: r.cfg.model, Articles: parts}
	raw, err = r.t.writeWikiArticles(r.sessionID, r.spaceID, slug, body)
	if wikiServerExecutes(err) {
		return result, errWikiServerExecutes
	}
	if err != nil {
		return fail(wikiArticlesCallError(r.spaceID, slug, err).Error()), nil
	}
	var answer wikiArticleWriteAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		return fail("the server's answer is not the shape this build reads: " + err.Error()), nil
	}
	for i, part := range answer.Parts {
		entries := len(input.Entries)
		if i < len(parts) && parts[i].Kind == "subtopic" {
			entries = len(parts[i].Entries)
		}
		result.Parts = append(result.Parts, wikiArticlesPartRun{Part: part.Part, Kind: part.Kind, Title: part.Title, Entries: entries, Kept: part.Kept, Stats: part.Stats})
	}
	switch {
	case answer.Unchanged:
		result.Outcome = "unchanged"
		fmt.Fprintf(r.progress, "topic %s: its articles were written from these entries already, so nothing was written.\n", slug)
	case answer.Written:
		result.Outcome = "written"
		fmt.Fprintf(r.progress, "topic %s: %s written from %s — %d characters; %d of %d sentences deleted, %d of %d footnotes stripped.\n",
			slug, wikiCount(countKept(answer), "article", "articles"), wikiCount(len(input.Entries), "entry", "entries"),
			answer.Stats.Chars, answer.Stats.SentencesDeleted, answer.Stats.Sentences, answer.Stats.MarkersStripped, answer.Stats.Markers)
	default:
		reason := "the server wrote nothing"
		if answer.Reason != nil {
			reason = *answer.Reason
		}
		return fail(reason), nil
	}
	return result, nil
}

func countKept(answer wikiArticleWriteAnswer) int {
	n := 0
	for _, part := range answer.Parts {
		if part.Kept {
			n++
		}
	}
	return n
}

// compose has the model write a topic's parts: one article, or — past rules.splitAbove entries — a
// named subtopic article per group and an overview over them.
func (r *wikiArticlesRun) compose(input wikiArticleInput) ([]wikiArticlePart, error) {
	entries := input.Entries
	topicTitle := input.Topic.Title
	if len(entries) <= wikiArticleSplitAbove {
		part, err := r.write("article", topicTitle, topicTitle, entries, len(entries), "")
		if err != nil {
			return nil, err
		}
		part.Part = 0
		return []wikiArticlePart{part}, nil
	}
	groups := groupWikiArticleEntries(entries)
	fmt.Fprintf(r.progress, "topic %s: %s split into %s by their paths and words.\n", input.Topic.Slug,
		wikiCount(len(entries), "entry", "entries"), wikiCount(len(groups), "subtopic", "subtopics"))
	// One group after another, each told the names already taken: named at once, a topic's groups come
	// back as near-synonyms of each other.
	names := make([]string, len(groups))
	for i, group := range groups {
		name, err := r.name(topicTitle, pickEntries(entries, group), names[:i])
		if err != nil {
			return nil, err
		}
		names[i] = name
	}
	subs := make([]wikiArticlePart, len(groups))
	var overview wikiArticlePart
	var lines []string
	var top []wikiArticleEntry
	for i, group := range groups {
		lines = append(lines, fmt.Sprintf("- %s（%d 条）", names[i], len(group)))
		members := pickEntries(entries, group)
		for j := 0; j < 2 && j < len(members); j++ {
			top = append(top, members[j])
		}
	}
	if len(top) > wikiArticleEntriesPerArticle {
		top = top[:wikiArticleEntriesPerArticle]
	}
	if err := parallelWikiCalls(len(groups)+1, func(i int) error {
		if i == len(groups) {
			part, err := r.write("overview", topicTitle, topicTitle, top, len(entries), strings.Join(lines, "\n"))
			overview = part
			return err
		}
		members := pickEntries(entries, groups[i])
		part, err := r.write("subtopic", topicTitle, names[i], members, len(members), "")
		if err != nil {
			return err
		}
		part.Part = i + 1
		part.Entries = make([]string, len(members))
		for j, entry := range members {
			part.Entries[j] = entry.ID
		}
		subs[i] = part
		return nil
	}); err != nil {
		return nil, err
	}
	overview.Part = 0
	return append([]wikiArticlePart{overview}, subs...), nil
}

// pickEntries is a group's entries, in the order the topic's input ranked them.
func pickEntries(entries []wikiArticleEntry, group []int) []wikiArticleEntry {
	out := make([]wikiArticleEntry, len(group))
	for i, index := range group {
		out[i] = entries[index]
	}
	return out
}

// parallelWikiCalls runs n calls, wikiArticleParallel at a time, and answers the first error — a 401
// first of all, which the calls still running would only meet again.
func parallelWikiCalls(n int, call func(i int) error) error {
	var wg sync.WaitGroup
	slots := make(chan struct{}, wikiArticleParallel)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		slots <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-slots }()
			errs[i] = call(i)
		}(i)
	}
	wg.Wait()
	var first error
	for _, err := range errs {
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) {
			return err
		}
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}

// write has the model write one part from its entries — the best supported rules.entriesPerArticle of
// them — asking once more when the draft falls short of rules.minChars and the pool had more to say.
func (r *wikiArticlesRun) write(kind, topicTitle, title string, pool []wikiArticleEntry, poolSize int, subs string) (wikiArticlePart, error) {
	fed := pool
	if len(fed) > wikiArticleEntriesPerArticle {
		fed = fed[:wikiArticleEntriesPerArticle]
	}
	prompt := wikiArticlePrompt(kind, topicTitle, title, fed, subs)
	text, err := r.ask(prompt)
	if err != nil {
		return wikiArticlePart{}, err
	}
	if chars := wikiArticleDraftChars(text, len(fed)); chars < wikiArticleMinChars && poolSize >= wikiArticleRetryPoolMin {
		again, err := r.ask(prompt + fmt.Sprintf("\n\nA previous draft kept only %d characters with footnotes: write the whole length asked for, every sentence with its markers.", chars))
		if err != nil {
			return wikiArticlePart{}, err
		}
		if wikiArticleDraftChars(again, len(fed)) > chars {
			text = again
		}
	}
	notes := make([]string, len(fed))
	for i, entry := range fed {
		notes[i] = entry.ID
	}
	return wikiArticlePart{Kind: kind, Title: wikiArticleTitle(text, title), Markdown: text, Notes: notes}, nil
}

// name has the model name one group — differently from the names its topic's other groups already
// have — falling back on the path most of it shares, then on its first title.
func (r *wikiArticlesRun) name(topicTitle string, members []wikiArticleEntry, taken []string) (string, error) {
	var titles []string
	for i, entry := range members {
		if i == 14 {
			break
		}
		titles = append(titles, "- "+cutRunes(entry.Title, 60))
	}
	prompt := fmt.Sprintf("下面是 wiki 里「%s」主题下归在同一组的条目标题：\n%s\n\n给这组起一个简短的中文小标题（不超过 14 个字，可保留代码名），概括它们共同讲的事。",
		topicTitle, strings.Join(titles, "\n"))
	if len(taken) > 0 {
		prompt += "\n同一主题的其他组已经叫：" + strings.Join(taken, "、") + "。起一个和它们都不同的名字，说出这组独有的内容，不要只换个说法。"
	}
	text, err := r.ask(prompt + "只输出这个小标题。")
	if err != nil {
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) {
			return "", err
		}
		text = ""
	}
	if name := wikiArticleGroupName(text); name != "" {
		return name, nil
	}
	return wikiArticleFallbackName(members), nil
}

// wikiArticleRetryWaits are the pauses before each try of one call: the local model sits behind a
// tunnel that drops, and one lost call would otherwise cost a whole topic's other calls. A 401 is
// never tried again.
var wikiArticleRetryWaits = []time.Duration{0, 10 * time.Second, 30 * time.Second}

// ask is one clean call, counted, tried again after a failure that is not a 401.
func (r *wikiArticlesRun) ask(prompt string) (string, error) {
	var last error
	for _, wait := range wikiArticleRetryWaits {
		time.Sleep(wait)
		ctx, cancel := context.WithTimeout(context.Background(), wikiArticleCallTimeout)
		text, usage, err := askWikiModel(ctx, r.claude, r.cfg, wikiArticleSystemPrompt, prompt)
		cancel()
		r.mu.Lock()
		r.calls++
		r.usage.InputTokens += usage.InputTokens
		r.usage.OutputTokens += usage.OutputTokens
		r.mu.Unlock()
		if err == nil {
			return text, nil
		}
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) {
			return "", err
		}
		last = err
	}
	return "", last
}

// ── The prompts, and reading what comes back ────────────────────────────────────────────────────

// wikiArticleKeyFields is what of each kind's fields an entry line carries (the demo's).
var wikiArticleKeyFields = map[string][]string{
	"principle":  {"statement", "rationale"},
	"convention": {"rule", "exceptions"},
	"decision":   {"decision", "alternatives", "consequences"},
	"pitfall":    {"symptom", "cause", "fix"},
	"recipe":     {"steps", "verify"},
	"concept":    {"definition", "boundaries"},
}

// wikiArticleEntryLine is one numbered entry as the model reads it.
func wikiArticleEntryLine(n int, entry wikiArticleEntry) string {
	var parts []string
	for _, key := range wikiArticleKeyFields[entry.Kind] {
		value, ok := entry.Fields[key]
		if !ok || value == nil {
			continue
		}
		var text string
		switch v := value.(type) {
		case string:
			text = v
		case []interface{}:
			var items []string
			for _, item := range v {
				switch x := item.(type) {
				case string:
					items = append(items, x)
				case map[string]interface{}:
					option, _ := x["option"].(string)
					why, _ := x["whyRejected"].(string)
					items = append(items, option+"（"+why+"）")
				default:
					raw, _ := json.Marshal(x)
					items = append(items, string(raw))
				}
			}
			text = strings.Join(items, "; ")
		default:
			raw, _ := json.Marshal(v)
			text = string(raw)
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		parts = append(parts, key+": "+cutRunes(text, 220))
	}
	return fmt.Sprintf("[%d] (%s, %s) %s —— %s | %s", n, entry.Kind, wikiCount(entry.Sources, "source", "sources"),
		entry.Title, cutRunes(entry.Summary, 240), cutRunes(strings.Join(parts, " | "), 520))
}

// wikiArticlePrompt is one part's prompt: an article (or a subtopic's), or the overview of a split topic.
func wikiArticlePrompt(kind, topicTitle, title string, fed []wikiArticleEntry, subs string) string {
	lines := make([]string, len(fed))
	for i, entry := range fed {
		lines[i] = wikiArticleEntryLine(i+1, entry)
	}
	entries := strings.Join(lines, "\n")
	if kind == "overview" {
		return fmt.Sprintf(`Write the overview of the wiki topic "%s". The topic is split into these sub-articles:
%s

Using ONLY the numbered entries below (the most important ones of each sub-article), write in Chinese:
- first line: "# " + the topic title
- two or three short paragraphs that tell a reader what this topic covers and point out its most important rules and traps.
Rules:
- EVERY sentence must end with one or more footnote markers such as [2] or [2][5], the numbers of the entries it is based on. A sentence without a marker will be deleted.
- State only what the entries say; do not invent facts, versions, dates, numbers or paths.
- LENGTH: 450-750 Chinese characters in total, 6-9 sentences. Anything past %d characters is cut off.
Output only the Markdown.

ENTRIES:
%s`, topicTitle, subs, wikiArticleMaxChars, entries)
	}
	scope := ""
	if kind == "subtopic" {
		scope = fmt.Sprintf(` (a part of the topic "%s")`, topicTitle)
	}
	return fmt.Sprintf(`Write a wiki article titled "%s"%s, using ONLY the numbered knowledge entries below.

Format (Markdown, in Chinese; keep code identifiers, paths and commands verbatim in backticks):
- first line: "# " + a concise article title
- a lead paragraph of 2-3 sentences: what this area is about and its most important rules and traps
- then 2-4 sections "## heading" of 2-3 sentences each that group the knowledge (for example 约定 / 决策 / 常见的坑 / 做法 / 概念 — choose what fits)
Rules:
- EVERY sentence must end with one or more footnote markers such as [3] or [3][7], the numbers of the entries it is based on. A sentence without a marker will be deleted.
- State only what the entries say; do not invent facts, versions, dates, numbers or paths. If entries disagree, say so and cite both.
- Prefer the most important and most corroborated entries (more sources = more corroborated); you need not cite every entry.
- Mark a trap that an entry says is fixed as 已修.
- LENGTH: 450-800 Chinese characters in total, 8-11 sentences, one point per sentence. Anything past %d characters is cut off.
Output only the Markdown article.

ENTRIES:
%s`, title, scope, wikiArticleMaxChars, entries)
}

var (
	wikiArticleMarker     = regexp.MustCompile(`\[(\d{1,3})\]`)
	wikiArticleLeadMarker = regexp.MustCompile(`^\s*\[\d{1,3}\]`)
	wikiArticleListItem   = regexp.MustCompile(`^(?:[-*+]|\d+[.)])\s+`)
)

// wikiArticleDraftChars is roughly what the server will keep of a draft (contract `articles.validation`):
// the characters of the sentences that carry a marker in range, markers and headings left out. The
// server's count is the one that is kept; this only decides whether to ask once more.
func wikiArticleDraftChars(markdown string, notes int) int {
	total := 0
	for _, raw := range strings.Split(markdown, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = wikiArticleListItem.ReplaceAllString(line, "")
		for _, sentence := range wikiArticleSentences(line) {
			valid := false
			var text strings.Builder
			// A marker inside a code span is code (`arr[0]`), as the server reads it.
			for i, segment := range strings.Split(sentence, "`") {
				if i%2 == 1 {
					text.WriteString("`" + segment + "`")
					continue
				}
				for _, match := range wikiArticleMarker.FindAllStringSubmatch(segment, -1) {
					if n, err := strconv.Atoi(match[1]); err == nil && n >= 1 && n <= notes {
						valid = true
					}
				}
				text.WriteString(wikiArticleMarker.ReplaceAllString(segment, ""))
			}
			if valid {
				total += utf8.RuneCountInString(strings.TrimSpace(text.String()))
			}
		}
	}
	return total
}

// wikiArticleSentences cuts a line at 。！？, and at a full stop or an ASCII ? or ! followed by a space
// or the line's end, the way the server does, keeping each sentence's markers with it.
func wikiArticleSentences(line string) []string {
	var out []string
	runes := []rune(line)
	var current strings.Builder
	inCode := false
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		current.WriteRune(ch)
		if ch == '`' {
			inCode = !inCode
			continue
		}
		if inCode {
			continue
		}
		atBreak := i+1 == len(runes) || unicode.IsSpace(runes[i+1])
		// An ASCII ? or ! after a space or another ? or ! is code left outside backticks (a ?? b).
		ascii := (ch == '?' || ch == '!') && atBreak && i > 0 && !unicode.IsSpace(runes[i-1]) && runes[i-1] != '?' && runes[i-1] != '!'
		ends := strings.ContainsRune("。！？", ch) || (ch == '.' && atBreak) || ascii
		if !ends {
			continue
		}
		j := i + 1
		for j < len(runes) {
			if strings.ContainsRune("」』\"”’）)", runes[j]) {
				current.WriteRune(runes[j])
				j++
				continue
			}
			rest := string(runes[j:])
			if loc := wikiArticleLeadMarker.FindStringIndex(rest); loc != nil {
				current.WriteString(rest[:loc[1]])
				j += utf8.RuneCountInString(rest[:loc[1]])
				continue
			}
			break
		}
		out = append(out, current.String())
		current.Reset()
		i = j - 1
	}
	if strings.TrimSpace(current.String()) != "" {
		out = append(out, current.String())
	}
	return out
}

// wikiArticleTitle is the draft's own "# " title when it wrote one, else the title it was asked for.
func wikiArticleTitle(markdown, fallback string) string {
	for _, raw := range strings.Split(markdown, "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "# ") {
			continue
		}
		title := strings.TrimSpace(wikiArticleMarker.ReplaceAllString(strings.TrimPrefix(line, "# "), ""))
		title = strings.Trim(title, "*#` ")
		if title != "" {
			return cutRunes(title, wikiArticleTitleMaxChars)
		}
		break
	}
	return cutRunes(strings.TrimSpace(fallback), wikiArticleTitleMaxChars)
}

// wikiArticleGroupName reads a group's name from the model's answer: its last line, without the quotes,
// bullets and emphasis a model wraps a short answer in.
func wikiArticleGroupName(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	last = strings.TrimLeft(last, "#*-「『\"“ \t")
	last = strings.TrimRight(last, "」』\"”* \t。")
	return cutRunes(strings.TrimSpace(last), wikiArticleNameMaxChars)
}

// wikiArticleFallbackName names a group by the three-segment path most of its entries share, or by its
// first entry's title.
func wikiArticleFallbackName(members []wikiArticleEntry) string {
	counts := map[string]int{}
	for _, entry := range members {
		for _, path := range entry.Paths {
			segments := strings.Split(path, "/")
			if len(segments) > 3 {
				segments = segments[:3]
			}
			counts[strings.Join(segments, "/")]++
		}
	}
	best, bestN := "", 0
	for prefix, n := range counts {
		if n > bestN || (n == bestN && prefix < best) {
			best, bestN = prefix, n
		}
	}
	if best != "" {
		return cutRunes(best, wikiArticleNameMaxChars)
	}
	if len(members) > 0 {
		return cutRunes(members[0].Title, 14)
	}
	return "其他"
}

// ── Grouping: a big topic's subtopics, by code ──────────────────────────────────────────────────

// wikiTerm is one weighted token of a sparse vector; a vector's terms are sorted by key, so every sum
// over them is taken in one order and the grouping is the same on every run.
type wikiTerm struct {
	key    string
	weight float64
}

type wikiVector []wikiTerm

var (
	wikiArticleWord = regexp.MustCompile(`[a-z_][a-z0-9_.-]{2,}`)
	wikiArticleHan  = regexp.MustCompile(`\p{Han}+`)
)

// wikiArticleTokens is the demo's: every 2-to-6-segment prefix of each path the entry names, weighing
// three, and the words and CJK bigrams of its title and summary, one each.
func wikiArticleTokens(entry wikiArticleEntry) map[string]float64 {
	tokens := map[string]float64{}
	for _, path := range entry.Paths {
		segments := strings.Split(path, "/")
		for i := 2; i <= len(segments) && i <= 6; i++ {
			tokens["P:"+strings.Join(segments[:i], "/")] += 3
		}
	}
	text := strings.ToLower(entry.Title + " " + entry.Summary)
	for _, word := range wikiArticleWord.FindAllString(text, -1) {
		tokens["W:"+word]++
	}
	for _, run := range wikiArticleHan.FindAllString(text, -1) {
		runes := []rune(run)
		for i := 0; i+1 < len(runes); i++ {
			tokens["C:"+string(runes[i:i+2])]++
		}
	}
	return tokens
}

func wikiUnit(weights map[string]float64) wikiVector {
	keys := make([]string, 0, len(weights))
	for key := range weights {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	norm := 0.0
	for _, key := range keys {
		norm += weights[key] * weights[key]
	}
	norm = math.Sqrt(norm)
	if norm == 0 {
		norm = 1
	}
	out := make(wikiVector, len(keys))
	for i, key := range keys {
		out[i] = wikiTerm{key: key, weight: weights[key] / norm}
	}
	return out
}

// wikiDot is the dot product of two sorted vectors, a merge in key order.
func wikiDot(a, b wikiVector) float64 {
	sum := 0.0
	for i, j := 0, 0; i < len(a) && j < len(b); {
		switch {
		case a[i].key == b[j].key:
			sum += a[i].weight * b[j].weight
			i++
			j++
		case a[i].key < b[j].key:
			i++
		default:
			j++
		}
	}
	return sum
}

// groupWikiArticleEntries splits a big topic's entries into subtopics (the demo's `cluster`): spherical
// k-means over tf-idf vectors in which anchor paths weigh most, k about one group per
// rules.groupTarget entries (at most rules.groupsMax), seeded farthest-first from the best-supported
// entry, each group capped at twice the target so one cannot swallow the topic, and a group smaller
// than rules.groupMin folded into its nearest. Every entry is in exactly one group, and the groups are
// in the order their seeds were taken.
func groupWikiArticleEntries(entries []wikiArticleEntry) [][]int {
	n := len(entries)
	if n == 0 {
		return nil
	}
	k := int(math.Ceil(float64(n) / wikiArticleGroupTarget))
	if k > wikiArticleGroupsMax {
		k = wikiArticleGroupsMax
	}
	if k < 2 {
		k = 2
	}
	if k > n {
		k = n
	}
	raw := make([]map[string]float64, n)
	df := map[string]int{}
	for i, entry := range entries {
		raw[i] = wikiArticleTokens(entry)
		for token := range raw[i] {
			df[token]++
		}
	}
	vectors := make([]wikiVector, n)
	for i := range entries {
		weights := map[string]float64{}
		for token, count := range raw[i] {
			if df[token] > 1 || strings.HasPrefix(token, "P:") {
				weights[token] = count * math.Log(1+float64(n)/float64(df[token]))
			}
		}
		vectors[i] = wikiUnit(weights)
	}
	// Seeds, farthest first from the best-supported entry.
	seeds := []int{0}
	isSeed := map[int]bool{0: true}
	best := make([]float64, n)
	for i := range entries {
		best[i] = wikiDot(vectors[i], vectors[0])
	}
	for len(seeds) < k {
		pick := -1
		for i := range entries {
			if isSeed[i] {
				continue
			}
			if pick < 0 || best[i] < best[pick] {
				pick = i
			}
		}
		seeds = append(seeds, pick)
		isSeed[pick] = true
		for i := range entries {
			if d := wikiDot(vectors[i], vectors[pick]); d > best[i] {
				best[i] = d
			}
		}
	}
	centroids := make([]wikiVector, k)
	for g, seed := range seeds {
		centroids[g] = vectors[seed]
	}
	capacity := wikiArticleGroupTarget * 2
	assign := make([]int, n)
	for round := 0; round < 6; round++ {
		sims := make([][]float64, n)
		top := make([]float64, n)
		for i := range entries {
			sims[i] = make([]float64, k)
			for g := range centroids {
				sims[i][g] = wikiDot(vectors[i], centroids[g])
				if g == 0 || sims[i][g] > top[i] {
					top[i] = sims[i][g]
				}
			}
		}
		order := make([]int, n)
		for i := range order {
			order[i] = i
		}
		// The most confident first; a full group passes an entry to its next best.
		sort.SliceStable(order, func(a, b int) bool { return top[order[a]] > top[order[b]] })
		size := make([]int, k)
		for _, i := range order {
			groups := make([]int, k)
			for g := range groups {
				groups[g] = g
			}
			sort.SliceStable(groups, func(a, b int) bool { return sims[i][groups[a]] > sims[i][groups[b]] })
			for _, g := range groups {
				if size[g] < capacity {
					assign[i] = g
					size[g]++
					break
				}
			}
		}
		for g := range centroids {
			sum := map[string]float64{}
			members := 0
			for i := range entries {
				if assign[i] != g {
					continue
				}
				members++
				for _, term := range vectors[i] {
					sum[term.key] += term.weight
				}
			}
			if members > 0 {
				centroids[g] = wikiUnit(sum)
			}
		}
	}
	groups := make([][]int, k)
	for i := range entries {
		groups[assign[i]] = append(groups[assign[i]], i)
	}
	var kept, small [][]int
	for _, group := range groups {
		switch {
		case len(group) == 0:
		case len(group) < wikiArticleGroupMin:
			small = append(small, group)
		default:
			kept = append(kept, group)
		}
	}
	if len(kept) == 0 {
		// Nothing reached the minimum: the groups stand as they are.
		return append(kept, small...)
	}
	for _, group := range small {
		for _, i := range group {
			target, score := 0, -1.0
			for g, members := range kept {
				sum := map[string]float64{}
				for _, j := range members {
					for _, term := range vectors[j] {
						sum[term.key] += term.weight
					}
				}
				if s := wikiDot(vectors[i], wikiUnit(sum)); s > score {
					target, score = g, s
				}
			}
			kept[target] = append(kept[target], i)
		}
	}
	for _, group := range kept {
		sort.Ints(group)
	}
	return kept
}

// ── The clean Claude Code ───────────────────────────────────────────────────────────────────────

// wikiArticleClaudeArgs is the verifier's clean launch (wikiVerifyClaudeArgs) with another system
// prompt in place of the verifier's: the same flags, so the two cannot drift apart.
func wikiArticleClaudeArgs(model, settings, system string) []string {
	args := wikiVerifyClaudeArgs(model, settings)
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--system-prompt" {
			args[i+1] = system
		}
	}
	return args
}

// wikiArticleEnv is the verifier's allowlisted environment (wikiVerifyEnv) with thinking off whatever
// the provider declared: CLAUDE_CODE_EFFORT_LEVEL=unset takes the effort out of the request, and
// MAX_THINKING_TOKENS=0 the adaptive thinking block that unset alone still sends.
func wikiArticleEnv(home, config string, cfg wikiVerifyConfig) []string {
	var env []string
	for _, kv := range wikiVerifyEnv(home, config, cfg) {
		if strings.HasPrefix(kv, "CLAUDE_CODE_EFFORT_LEVEL=") || strings.HasPrefix(kv, "MAX_THINKING_TOKENS=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "CLAUDE_CODE_EFFORT_LEVEL=unset", "MAX_THINKING_TOKENS=0")
}

// askWikiModel runs one clean Claude Code over prompt and returns the model's answer and what it cost.
func askWikiModel(ctx context.Context, claude string, cfg wikiVerifyConfig, system, prompt string) (string, wikiModelUsage, error) {
	var usage wikiModelUsage
	scratch, err := os.MkdirTemp("", "orbit-wiki-articles-")
	if err != nil {
		return "", usage, err
	}
	defer os.RemoveAll(scratch)
	home := filepath.Join(scratch, "home")
	config := filepath.Join(scratch, "config")
	for _, dir := range []string{home, config} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", usage, err
		}
		if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
			return "", usage, err
		}
	}
	settings := filepath.Join(scratch, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"apiKeyHelper":"printenv ANTHROPIC_AUTH_TOKEN"}`), 0o600); err != nil {
		return "", usage, err
	}
	cmd := exec.CommandContext(ctx, claude, wikiArticleClaudeArgs(cfg.model, settings, system)...)
	cmd.Dir = scratch
	cmd.Env = wikiArticleEnv(home, config, cfg)
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	text, usage, err := readWikiModelResult(stdout.Bytes())
	if err != nil {
		if ctx.Err() != nil {
			return "", usage, fmt.Errorf("Claude Code gave no answer within %s", wikiArticleCallTimeout)
		}
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) {
			return "", usage, err
		}
		return "", usage, fmt.Errorf("%v (%v): %s", err, runErr, lastLines(stderr.String(), 3))
	}
	return text, usage, nil
}

// readWikiModelResult reads a --output-format json result: the answer, what it cost, and a 401 as the
// error that ends the run.
func readWikiModelResult(out []byte) (string, wikiModelUsage, error) {
	var usage wikiModelUsage
	var result struct {
		IsError        bool   `json:"is_error"`
		Result         string `json:"result"`
		APIErrorStatus *int   `json:"api_error_status"`
		Usage          struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(lastJSONLine(out), &result); err != nil {
		return "", usage, errors.New("Claude Code gave no result")
	}
	usage.InputTokens = result.Usage.InputTokens + result.Usage.CacheReadInputTokens + result.Usage.CacheCreationInputTokens
	usage.OutputTokens = result.Usage.OutputTokens
	if (result.APIErrorStatus != nil && *result.APIErrorStatus == http.StatusUnauthorized) || (result.IsError && wikiVerify401.MatchString(result.Result)) {
		return "", usage, &wikiArticleAuthError{detail: result.Result}
	}
	if result.IsError {
		return "", usage, fmt.Errorf("Claude Code reported an error: %s", result.Result)
	}
	return result.Result, usage, nil
}

// ── Errors, in words ────────────────────────────────────────────────────────────────────────────

// wikiArticlesCallError says what a call to the articles routes came to. slug is the topic, when the
// call was about one.
func wikiArticlesCallError(spaceID, slug string, err error) error {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("orbit wiki articles: %w", err)
	}
	code := httpErr.code()
	switch {
	case wikiDisabledByServer(err):
		return wikiCallError("orbit wiki articles", err)
	case code == wikiNotMaintenanceSessionCode:
		return fmt.Errorf("orbit wiki articles: only a Wiki maintenance run of space %s writes its articles — a session "+
			"whose task is in the space's hidden «Wiki maintenance» list — and this session is not one (%s). Nothing was "+
			"read or written", spaceID, code)
	case code == wikiArticleStaleCode:
		return fmt.Errorf("the topic's entries changed while its articles were written (%s): nothing was written, and the "+
			"next run writes them from the entries as they stand", code)
	case code != "":
		return fmt.Errorf("orbit wiki articles: %w", err)
	case httpErr.statusCode == http.StatusForbidden:
		return fmt.Errorf("orbit wiki articles: the Orbit server does not know this session (ORBIT_SESSION_ID) as one this " +
			"runner hosts, so it answered 403 and nothing was read or written. Run it from inside the maintenance session")
	case httpErr.statusCode == http.StatusNotFound && strings.Contains(httpErr.body, "no such wiki topic"):
		return fmt.Errorf("orbit wiki articles: space %s has no topic %q (404)", spaceID, slug)
	case httpErr.statusCode == http.StatusNotFound && strings.Contains(httpErr.body, "no such wiki space"):
		return fmt.Errorf("orbit wiki articles: this account has no wiki space %s (the server answered 404, which is its "+
			"answer for another account's space too), so nothing was read or written. Check --space", spaceID)
	case httpErr.statusCode == http.StatusNotFound:
		return fmt.Errorf("orbit wiki articles: this Orbit server has no articles door yet (it answered 404 for %s /api%s): "+
			"it predates the articles, so nothing was read or written. Upgrade the Orbit server",
			httpErr.method, strings.SplitN(httpErr.path, "?", 2)[0])
	}
	return fmt.Errorf("orbit wiki articles: %w", err)
}

// wikiArticleStaleCode is the refusal only the articles' write gives (contract `refusals`).
const wikiArticleStaleCode = "WIKI_ARTICLE_STALE"

// wikiServerExecutesCode is the runner door's answer for an account the Orbit server runs the wiki for
// (contract `refusals`, `articles.serverExecution`): the server's wiki worker writes the articles with the
// deployment's System model, and no session's provider is asked.
const wikiServerExecutesCode = "WIKI_SERVER_EXECUTES"

// errWikiServerExecutes stops a run whose topic the server answered WIKI_SERVER_EXECUTES for.
var errWikiServerExecutes = errors.New(wikiServerExecutesCode)

// wikiServerExecutes reports a call the server answered WIKI_SERVER_EXECUTES.
func wikiServerExecutes(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.code() == wikiServerExecutesCode
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func cliWikiArticles(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki articles")
	space := fs.String("space", "", "the space this maintenance run maintains")
	topic := fs.String("topic", "", "only this topic")
	model := fs.String("model", "", "the model to write with")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID, err := wikiMaintenanceSpace(*space)
	if err != nil {
		return err
	}
	slug := strings.TrimSpace(*topic)
	if slug != "" && !wikiSlugPattern.MatchString(slug) {
		return fmt.Errorf("--topic must be a topic's slug: lowercase letters and digits joined by hyphens, like database")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	summary, runErr := runWikiArticles(t, ctx.sessionID, spaceID, slug, *model, progress)
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiArticlesSummary(summary))
	}
	if runErr != nil {
		return runErr
	}
	if summary.ServerExecutes {
		return nil
	}
	if summary.Failed > 0 {
		return fmt.Errorf("%s left unwritten: the next run tries again", wikiCount(summary.Failed, "topic was", "topics were"))
	}
	return nil
}

func describeWikiArticlesSummary(s wikiArticlesSummary) string {
	if s.ServerExecutes {
		return fmt.Sprintf("The Orbit server writes the articles of space %s (%s): its wiki worker writes them after a "+
			"maintenance run, with the deployment's System model. Nothing was asked of this session's model.", s.SpaceID, wikiServerExecutesCode)
	}
	if len(s.Topics) == 0 {
		return fmt.Sprintf("No topic of space %s has entries its articles were not written from: nothing to write.", s.SpaceID)
	}
	line := fmt.Sprintf("Space %s: articles written for %s, %s unchanged, %s failed", s.SpaceID,
		wikiCount(s.Written, "topic", "topics"), wikiCount(s.Unchanged, "topic", "topics"), wikiCount(s.Failed, "topic", "topics"))
	if s.Calls > 0 {
		line += fmt.Sprintf("; %d model calls to %s, %d tokens in and %d out", s.Calls, s.Model, s.Usage.InputTokens, s.Usage.OutputTokens)
	}
	if s.Stats.Sentences > 0 {
		line += fmt.Sprintf("; %d of %d sentences deleted, %d of %d footnotes stripped", s.Stats.SentencesDeleted, s.Stats.Sentences,
			s.Stats.MarkersStripped, s.Stats.Markers)
	}
	line += "."
	if s.Stopped != "" {
		line += " Stopped: " + s.Stopped
	}
	return line
}
