package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
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

// `orbit wiki docs build`: a Wiki maintenance run writes its space's documents from the plan its owner
// confirmed, section by section (contracts/wiki.contract.json `docs.build`, criterion 9 revised
// 2026-09-28).
//
// EACH SECTION IS TAKEN BY ITS OWN SOURCES. The plan says where a section's material is: design-document
// sections, code symbols and contracts, which exist only in a checkout and are read here at the commit
// origin/main names after a fetch; and a session condition, whose records exist only in the database and
// which the server gathers (`GET …/docs/:slug/material`): the entries it picks, as the way in to the
// first-hand records they cite, and the owner's words and the tasks' comments its projects, window and
// keywords find — every record redacted and placed. The platform's own template messages and repeated
// texts are taken out, and what is left is cut to the section's cap, a mechanism taking documents and
// code first and the rest taking records first.
//
// A SECTION WHOSE MATERIAL DID NOT CHANGE IS NOT WRITTEN. The fingerprint is taken over the section's
// definition in the plan and every piece gathered for it; when it is the one the server holds for the
// section (`GET …/docs`) and nothing of the section was withdrawn, the model is not asked at all.
//
// THE MODEL MERGES, THEN WRITES — AND THE CODE CHECKS. One clean call merges the pieces it was handed
// into the section's current state and says of each whether it was adopted, merged into another or
// dropped, and why (evidence: decision > merge record > command output > error, the newest first; a
// mechanism is the code's to settle); the ledger goes to the server with the section. A second call
// writes the section from the pieces it kept, each footnote with a verbatim quote. A repository quote is
// looked for here, in the file at the commit, and its lines are the lines it was found at; a record's
// quote is looked for in the text the server handed out, and checked again by the server. A footnote
// left without a quote that holds, and a paragraph that marks only its last sentence, are each asked
// about once more. The overview is written last, from the other sections as they are written, citing
// their footnotes and nothing else.
//
// THE MODEL IS CALLED THE WAY `orbit wiki verify` CALLS IT (wiki_verify.go, through askWikiModel): --bare,
// an empty HOME and CLAUDE_CONFIG_DIR, no tools and no MCP server, no session file, the environment
// allowlist and the apiKeyHelper, thinking off. The run waits for the endpoint's /health first, and stops
// at the first 401: every call after it would be refused the same way.
//
// WHO CALLS IT. A build job (contract `plan.jobs`, kind build) — the task the owner's confirmation of a
// version makes — runs it whole in its session, and says how far it got and how it ended on its job; a
// maintenance run calls it for the sections its facts touched alone (wiki_maintain_docs.go), at the commit
// it compared them at.
//
// NO CLOCK. Nothing here schedules itself: a maintenance run and a build job call it after facts arrived.

// wikiDocsBuildPrecondition is contracts/wiki.contract.json `docs.build.precondition`, word for word, and
// wiki_docs_build_test.go holds the two equal.
const wikiDocsBuildPrecondition = "Build documents only as a Wiki maintenance run of the space, and only from " +
	"the plan its owner confirmed: every footnote carries its verbatim quote, a repository quote is checked in the " +
	"checkout at the commit it names, and a section whose material did not change is left as it is."

var wikiDocsBuildDescription = wikiDocsBuildPrecondition + " This is a Wiki maintenance run's writing of its " +
	"space's documents: for each document of the confirmed plan (--doc, one of them; --section, one section of it), " +
	"it gathers each section's material — design-document sections, code symbols and contracts from the checkout's " +
	"origin/main (--repo, fetched first), and the records the server finds by the section's session condition, " +
	"redacted — fingerprints it, and leaves a section whose fingerprint the server already holds unwritten. Otherwise " +
	"the local model — this session's provider's (ANTHROPIC_MODEL at ANTHROPIC_BASE_URL, the token in " +
	"ANTHROPIC_AUTH_TOKEN), through a clean Claude Code with thinking off — merges the material (adopt, merge or drop, " +
	"each with a reason, sent with the section) and writes the section, a verbatim quote for every footnote; repository " +
	"quotes are checked here at the commit, records by the server. A document's overview is written last. It stops at " +
	"the first 401 from the model's endpoint, and exits non-zero when any section it took up was left unwritten. Any " +
	"session but a maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION. For an account the Orbit server " +
	"runs the wiki for (ORBIT_WIKI_EXECUTOR server, or canary with the account on its list) the server answers " +
	"WIKI_SERVER_EXECUTES: its wiki worker builds the documents when the owner confirms a plan, so this asks no model, " +
	"says so and exits 0."

// wikiDocsBuildSystemPrompt is the whole system prompt the clean call carries: the rest is in the prompt.
const wikiDocsBuildSystemPrompt = "你是 Orbit 的技术文档作者。你只根据给你的材料写，不编造事实、名字、数字和路径。" +
	"用中文写，代码名、路径、命令保留原文。只输出要求的内容。"

// The contract's numbers (`docs.build.rules`), which wiki_docs_build_test.go holds to the JSON.
const (
	wikiDocMaterialMaxChars    = 22000
	wikiDocMaterialHeaderChars = 120
	wikiDocBuildParallel       = 4
)

const (
	// One section from the local model: decoding runs at tens of tokens a second, slower on a shared GPU.
	wikiDocBuildCallTimeout = 20 * time.Minute
	// What of the repository one piece carries (the sample's sizes): a design document's section, a
	// symbol with its comment, a file's head, a declaration matched by the section's words, a contract.
	wikiDocDocSectionChars = 4200
	wikiDocSymbolChars     = 3200
	wikiDocSymbolLines     = 70
	wikiDocCommentLines    = 25
	wikiDocFileHeadChars   = 1800
	wikiDocFileHeadLines   = 40
	wikiDocDeclsPerFile    = 3
	wikiDocDeclChars       = 2600
	wikiDocDeclLines       = 50
	wikiDocFilesPerDir     = 4
	wikiDocContractChars   = 2500
)

// wikiDocMechanismKinds are the section kinds whose material is the design documents and the code first.
var wikiDocMechanismKinds = map[string]bool{"concepts": true, "flow": true, "interface": true, "data": true, "ops": true}

var wikiDocKindWords = map[string]string{
	"overview": "概述", "concepts": "概念", "flow": "流程", "interface": "接口", "data": "数据与配置", "ops": "运维",
	"pitfalls": "已知的坑", "decisions": "决策与理由", "conventions": "约定", "other": "其他",
}

var wikiDocWeightWords = map[string]string{
	"decision": "决定", "merge": "合并记录", "output": "命令输出", "error": "报错", "other": "其他",
}

// ── What the server says ────────────────────────────────────────────────────────────────────────

// wikiDocsPlanAnswer is `GET …/plan`, as far as the writer reads it: the confirmed version's documents.
type wikiDocsPlanAnswer struct {
	Confirmed *struct {
		Version int               `json:"version"`
		Docs    []wikiDocsPlanDoc `json:"docs"`
	} `json:"confirmed"`
}

type wikiDocsPlanDoc struct {
	Slug     string                `json:"slug"`
	Title    string                `json:"title"`
	Question string                `json:"question"`
	Audience []string              `json:"audience"`
	Sections []wikiDocsPlanSection `json:"sections"`
}

type wikiDocsPlanSection struct {
	Key     string `json:"key"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	Covers  string `json:"covers"`
	Length  int    `json:"length"`
	Sources struct {
		Docs      []wikiPlanDocSource      `json:"docs"`
		Code      []wikiPlanCodeSource     `json:"code"`
		Contracts []wikiPlanContractSource `json:"contracts"`
		Sessions  *struct {
			Projects []struct {
				ID string `json:"id"`
			} `json:"projects"`
			Since       *string  `json:"since"`
			Until       *string  `json:"until"`
			Keywords    []string `json:"keywords"`
			AnchorPaths []string `json:"anchorPaths"`
			EntryKinds  []string `json:"entryKinds"`
			Topics      []string `json:"topics"`
			Evidence    string   `json:"evidence"`
		} `json:"sessions"`
	} `json:"sources"`
}

// wikiDocsStateAnswer is `GET …/docs`: what is written, section by section.
type wikiDocsStateAnswer struct {
	PlanVersion *int `json:"planVersion"`
	Docs        []struct {
		Slug     string `json:"slug"`
		Sections []struct {
			Key            string `json:"key"`
			MaterialSha256 string `json:"materialSha256"`
			RepoSha        string `json:"repoSha"`
			Stale          bool   `json:"stale"`
		} `json:"sections"`
	} `json:"docs"`
}

// wikiDocStored is what the server holds of one section: its fingerprint, and whether it waits to be rewritten.
type wikiDocStored struct {
	materialSha256 string
	stale          bool
}

// wikiDocMaterialAnswer is `GET …/docs/:slug/material?section=<key>`.
type wikiDocMaterialAnswer struct {
	Records    []wikiDocMaterialRecord `json:"records"`
	Unresolved []struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	} `json:"unresolved"`
}

// wikiDocMaterialRecord is one record the server gathered, redacted and placed.
type wikiDocMaterialRecord struct {
	Kind  string `json:"kind"`
	Ref   string `json:"ref"`
	Found string `json:"found"`
	Via   *struct {
		EntryID string `json:"entryId"`
		Title   string `json:"title"`
		Kind    string `json:"kind"`
	} `json:"via"`
	Weight       string       `json:"weight"`
	OwnerWords   bool         `json:"ownerWords"`
	Label        *string      `json:"label"`
	At           *string      `json:"at"`
	SessionTitle *string      `json:"sessionTitle"`
	TaskTitle    *string      `json:"taskTitle"`
	ProjectTitle *string      `json:"projectTitle"`
	NotePath     *string      `json:"notePath"`
	Text         string       `json:"text"`
	Chars        wikiDocRange `json:"chars"`
	Length       int          `json:"length"`
}

// wikiDocView is `GET …/docs/:slug`, as far as an overview reads it: the sentences and their footnotes.
type wikiDocView struct {
	Sections []struct {
		Key     string `json:"key"`
		Title   string `json:"title"`
		Written bool   `json:"written"`
		Blocks  []struct {
			Kind      string  `json:"kind"`
			Text      *string `json:"text"`
			Sentences []struct {
				Text  string `json:"text"`
				Notes []int  `json:"notes"`
			} `json:"sentences"`
		} `json:"blocks"`
	} `json:"sections"`
	Footnotes []wikiDocViewFootnote `json:"footnotes"`
}

// wikiDocViewFootnote is one footnote of the document as the read numbers it.
type wikiDocViewFootnote struct {
	N          int     `json:"n"`
	Kind       string  `json:"kind"`
	Quote      *string `json:"quote"`
	Path       *string `json:"path"`
	LineStart  *int    `json:"lineStart"`
	LineEnd    *int    `json:"lineEnd"`
	Section    *string `json:"section"`
	Symbol     *string `json:"symbol"`
	RecordID   *string `json:"recordId"`
	CharStart  *int    `json:"charStart"`
	CharEnd    *int    `json:"charEnd"`
	ViaEntryID *string `json:"viaEntryId"`
}

// wikiDocWriteAnswer is the write's answer, as far as the run reports it.
type wikiDocWriteAnswer struct {
	Status   string `json:"status"`
	Sections []struct {
		Key     string          `json:"key"`
		Outcome string          `json:"outcome"`
		Stats   json.RawMessage `json:"stats"`
	} `json:"sections"`
	Counts map[string]int `json:"counts"`
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiDocsBuildSummary is what a run did, and what `--json` prints.
type wikiDocsBuildSummary struct {
	SpaceID     string                `json:"spaceId"`
	PlanVersion int                   `json:"planVersion"`
	RepoSha     string                `json:"repoSha"`
	Model       string                `json:"model,omitempty"`
	Docs        []wikiDocsBuildDocRun `json:"docs"`
	Written     int                   `json:"written"`
	Unchanged   int                   `json:"unchanged"`
	Failed      int                   `json:"failed"`
	Calls       int                   `json:"calls"`
	Usage       wikiModelUsage        `json:"usage"`
	Seconds     float64               `json:"seconds"`
	Stopped     string                `json:"stopped,omitempty"`
	// ServerExecutes is a run the server answered WIKI_SERVER_EXECUTES: the account's documents are the server's
	// wiki worker's to build, so this one asked no model and wrote nothing more.
	ServerExecutes bool `json:"serverExecutes,omitempty"`
	// Job is the build job this run was, and how it told the server it ended; nil for any other run.
	Job *wikiDocsBuildJobEnd `json:"job,omitempty"`
}

// wikiDocsBuildJobEnd is a build job's end, as the run said it (contract `plan.jobs.finish`).
type wikiDocsBuildJobEnd struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
}

type wikiDocsBuildDocRun struct {
	Slug     string                    `json:"slug"`
	Status   string                    `json:"status,omitempty"`
	Counts   map[string]int            `json:"counts,omitempty"`
	Sections []wikiDocsBuildSectionRun `json:"sections"`
}

// wikiDocsBuildSectionRun is one section the run took up.
type wikiDocsBuildSectionRun struct {
	Key            string `json:"key"`
	Title          string `json:"title"`
	Kind           string `json:"kind"`
	Outcome        string `json:"outcome"` // written | unchanged | failed
	Why            string `json:"why,omitempty"`
	MaterialSha256 string `json:"materialSha256"`
	// The pieces gathered, and what became of them.
	Pieces   int            `json:"pieces"`
	Actions  map[string]int `json:"actions,omitempty"`
	Missing  []string       `json:"missing,omitempty"`
	Footnote struct {
		Total int `json:"total"`
		// Quotes the run found in their originals itself: a repository file at the commit, a record's text.
		Found   int `json:"found"`
		NoQuote int `json:"noQuote"`
	} `json:"footnotes"`
	Calls   int             `json:"calls"`
	Usage   wikiModelUsage  `json:"usage"`
	Seconds float64         `json:"seconds"`
	Stats   json.RawMessage `json:"stats,omitempty"`
}

type wikiDocsBuildOptions struct {
	spaceID, doc, section, repo, model string
	// only is the sections to take up, by document slug: a maintenance run's, what its facts touched (nil: every
	// section). A document's overview is taken up with any other section of it.
	only map[string]map[string]bool
	// sha is the origin/main commit to read the repository at, fetched already by the caller; empty: fetch it here.
	sha string
	// onDoc hears of each document as it is taken up — done of total, and the document — and of the end (doc nil).
	onDoc func(done, total int, doc *wikiDocsPlanDoc)
}

// wikiDocsBuildRun is one run's state: where it reads and reports, the model it asks, and what it spent.
type wikiDocsBuildRun struct {
	t           *Transport
	sessionID   string
	spaceID     string
	planVersion int
	repo        *wikiDocRepo
	modelName   string
	progress    io.Writer

	modelOnce sync.Once
	modelErr  error
	cfg       wikiVerifyConfig
	claude    string

	mu    sync.Mutex
	calls int
	usage wikiModelUsage
	stop  error
	// wikiDocWrites serializes the writes of one document: each classifies the whole document again.
	writes sync.Mutex
}

// runWikiDocsBuild writes the documents of the space's confirmed plan — or the one --doc names, or one
// section of it — and says what it did.
func runWikiDocsBuild(t *Transport, sessionID string, opts wikiDocsBuildOptions, progress io.Writer) (summary wikiDocsBuildSummary, err error) {
	started := time.Now()
	summary = wikiDocsBuildSummary{SpaceID: opts.spaceID, Docs: []wikiDocsBuildDocRun{}}
	raw, err := t.wikiPlanState(sessionID, opts.spaceID)
	if wikiServerExecutes(err) {
		summary.ServerExecutes = true
		return summary, nil
	}
	if err != nil {
		return summary, wikiDocsBuildCallError(opts.spaceID, err)
	}
	var plan wikiDocsPlanAnswer
	if err := json.Unmarshal(raw, &plan); err != nil {
		return summary, fmt.Errorf("orbit wiki docs build: the server's plan is not the shape this build reads: %w", err)
	}
	if plan.Confirmed == nil {
		return summary, fmt.Errorf("orbit wiki docs build: space %s has no plan its owner confirmed, so no document is "+
			"written (WIKI_PLAN_UNCONFIRMED): a document is written only from the plan the owner confirmed", opts.spaceID)
	}
	summary.PlanVersion = plan.Confirmed.Version
	docs := plan.Confirmed.Docs
	if opts.doc != "" {
		docs = nil
		for _, doc := range plan.Confirmed.Docs {
			if doc.Slug == opts.doc {
				docs = append(docs, doc)
			}
		}
		if len(docs) == 0 {
			return summary, fmt.Errorf("orbit wiki docs build: the confirmed plan of space %s has no document %q: --doc names one of its slugs", opts.spaceID, opts.doc)
		}
		if opts.section != "" {
			found := false
			for _, section := range docs[0].Sections {
				found = found || section.Key == opts.section
			}
			if !found {
				return summary, fmt.Errorf("orbit wiki docs build: document %s has no section %q in the confirmed plan: --section names one of its keys", opts.doc, opts.section)
			}
		}
	}
	if opts.only != nil {
		var taken []wikiDocsPlanDoc
		for _, doc := range docs {
			if len(opts.only[doc.Slug]) > 0 {
				taken = append(taken, doc)
			}
		}
		docs = taken
	}
	raw, err = t.wikiDocsState(sessionID, opts.spaceID)
	if wikiServerExecutes(err) {
		// The server builds this account's documents (contract `docs.build.server`): before any model is asked.
		summary.ServerExecutes = true
		return summary, nil
	}
	if err != nil {
		return summary, wikiDocsBuildCallError(opts.spaceID, err)
	}
	var state wikiDocsStateAnswer
	if err := json.Unmarshal(raw, &state); err != nil {
		return summary, fmt.Errorf("orbit wiki docs build: the server's record of what is written is not the shape this build reads: %w", err)
	}
	stored := map[string]map[string]wikiDocStored{}
	for _, doc := range state.Docs {
		stored[doc.Slug] = map[string]wikiDocStored{}
		for _, section := range doc.Sections {
			stored[doc.Slug][section.Key] = wikiDocStored{materialSha256: section.MaterialSha256, stale: section.Stale}
		}
	}
	root, err := wikiDocsCheckout(opts.repo)
	if err != nil {
		return summary, err
	}
	sha := opts.sha
	if sha == "" {
		if sha, err = fetchWikiDocsRef(root); err != nil {
			return summary, err
		}
	}
	summary.RepoSha = sha
	fmt.Fprintf(progress, "Space %s: plan version %d, %s; the repository at origin/main %s in %s.\n", opts.spaceID,
		plan.Confirmed.Version, wikiCount(len(docs), "document", "documents"), shortWikiHash(sha), root)
	run := &wikiDocsBuildRun{
		t: t, sessionID: sessionID, spaceID: opts.spaceID, planVersion: plan.Confirmed.Version,
		repo: newWikiDocRepo(root, sha), modelName: opts.model, progress: progress,
	}
	defer func() {
		summary.Model = run.cfg.model
		summary.Calls = run.calls
		summary.Usage = run.usage
		summary.Seconds = time.Since(started).Seconds()
	}()
	for i, doc := range docs {
		if opts.onDoc != nil {
			opts.onDoc(i, len(docs), &docs[i])
		}
		result := run.document(doc, stored[doc.Slug], opts.section, opts.only[doc.Slug])
		if run.serverExecutes() {
			// The switch gave the account to the server while this ran: what is left is the server's to write.
			summary.ServerExecutes = true
			return summary, nil
		}
		summary.Docs = append(summary.Docs, result)
		for _, section := range result.Sections {
			switch section.Outcome {
			case "written":
				summary.Written++
			case "unchanged":
				summary.Unchanged++
			default:
				summary.Failed++
			}
		}
		if stop := run.stopped(); stop != nil {
			summary.Stopped = stop.Error()
			return summary, stop
		}
	}
	if opts.onDoc != nil {
		opts.onDoc(len(docs), len(docs), nil)
	}
	return summary, nil
}

func (r *wikiDocsBuildRun) stopped() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stop
}

// serverExecutes is whether the server answered WIKI_SERVER_EXECUTES to a call of this run.
func (r *wikiDocsBuildRun) serverExecutes() bool {
	return errors.Is(r.stopped(), errWikiServerExecutes)
}

// heardServerExecutes stops the run when the server answered WIKI_SERVER_EXECUTES: no section after it asks a
// model. It reports whether err was that answer.
func (r *wikiDocsBuildRun) heardServerExecutes(err error) bool {
	if !wikiServerExecutes(err) {
		return false
	}
	r.mu.Lock()
	if r.stop == nil {
		r.stop = errWikiServerExecutes
	}
	r.mu.Unlock()
	return true
}

// model is the endpoint, the token and the model, read once there is something to write, and the
// endpoint's /health waited for.
func (r *wikiDocsBuildRun) model() error {
	r.modelOnce.Do(func() {
		cfg := wikiVerifyConfig{
			baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
			token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
			model:   firstNonEmpty(strings.TrimSpace(r.modelName), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
		}
		switch {
		case cfg.baseURL == "":
			r.modelErr = errors.New("orbit wiki docs build has the model this session's provider names write, and this session's " +
				"environment names no endpoint (ANTHROPIC_BASE_URL): run it in a session on the local model's provider")
			return
		case cfg.token == "":
			r.modelErr = errors.New("orbit wiki docs build reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is " +
				"not set in this session: run it in a session on the local model's provider")
			return
		case cfg.model == "":
			r.modelErr = errors.New("orbit wiki docs build needs the model to write with: ANTHROPIC_MODEL, which this session's " +
				"provider names, is not set — pass --model")
			return
		}
		claude, err := wikiVerifyClaudePath()
		if err != nil {
			r.modelErr = err
			return
		}
		if err := wikiMaintainWaitForEndpoint(cfg.baseURL, r.progress); err != nil {
			r.modelErr = err
			return
		}
		r.cfg, r.claude = cfg, claude
	})
	return r.modelErr
}

// wikiDocBuildRetryWaits are the pauses before each try of one call: the tunnel to the local model drops,
// and one lost call would otherwise cost the section. A 401 is never tried again.
var wikiDocBuildRetryWaits = []time.Duration{0, 10 * time.Second, 30 * time.Second}

// ask is one clean call, counted against the section and the run, tried again after a failure that is
// not a 401; a 401 stops the run.
func (r *wikiDocsBuildRun) ask(section *wikiDocsBuildSectionRun, prompt string) (string, error) {
	var last error
	for _, wait := range wikiDocBuildRetryWaits {
		if stop := r.stopped(); stop != nil {
			return "", stop
		}
		time.Sleep(wait)
		ctx, cancel := context.WithTimeout(context.Background(), wikiDocBuildCallTimeout)
		text, usage, err := askWikiModel(ctx, r.claude, r.cfg, wikiDocsBuildSystemPrompt, prompt)
		cancel()
		r.mu.Lock()
		r.calls++
		r.usage.InputTokens += usage.InputTokens
		r.usage.OutputTokens += usage.OutputTokens
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) && r.stop == nil {
			r.stop = errors.New("the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's " +
				"provider injected; no more sections were written. " + auth.detail)
		}
		r.mu.Unlock()
		section.Calls++
		section.Usage.InputTokens += usage.InputTokens
		section.Usage.OutputTokens += usage.OutputTokens
		if err == nil {
			return text, nil
		}
		if errors.As(err, &auth) {
			return "", r.stopped()
		}
		last = err
	}
	return "", last
}

// ── A document ──────────────────────────────────────────────────────────────────────────────────

// wikiDocWrittenSection is a section as this run wrote it — Markdown with [n], and its footnotes — for the
// overview to read.
type wikiDocWrittenSection struct {
	markdown  string
	footnotes []wikiDocFootnote
}

// document writes one document: its sections (all, --section, or those `take` names), then its overview,
// last — taken up with any other section of the document, since it summarizes them.
func (r *wikiDocsBuildRun) document(doc wikiDocsPlanDoc, stored map[string]wikiDocStored, only string, take map[string]bool) wikiDocsBuildDocRun {
	result := wikiDocsBuildDocRun{Slug: doc.Slug, Sections: []wikiDocsBuildSectionRun{}}
	if stored == nil {
		stored = map[string]wikiDocStored{}
	}
	var body, overviews []int
	for i, section := range doc.Sections {
		if only != "" && section.Key != only {
			continue
		}
		if section.Kind == "overview" {
			overviews = append(overviews, i)
		} else if take == nil || take[section.Key] {
			body = append(body, i)
		}
	}
	if take != nil && len(body) == 0 {
		var named []int
		for _, i := range overviews {
			if take[doc.Sections[i].Key] {
				named = append(named, i)
			}
		}
		overviews = named
	}
	runs := make([]wikiDocsBuildSectionRun, len(doc.Sections))
	written := make([]*wikiDocWrittenSection, len(doc.Sections))
	fingerprints := make([]string, len(doc.Sections))
	for i, section := range doc.Sections {
		fingerprints[i] = stored[section.Key].materialSha256
	}
	var mu sync.Mutex
	slots := make(chan struct{}, wikiDocBuildParallel)
	var wg sync.WaitGroup
	for _, i := range body {
		wg.Add(1)
		slots <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-slots }()
			run, section, answer := r.section(doc, i, stored[doc.Sections[i].Key])
			mu.Lock()
			defer mu.Unlock()
			runs[i] = run
			if section != nil {
				written[i] = section
			}
			if run.Outcome != "failed" {
				fingerprints[i] = run.MaterialSha256
			}
			if answer != nil {
				result.Status, result.Counts = answer.Status, answer.Counts
			}
		}(i)
	}
	wg.Wait()
	for _, i := range overviews {
		run, answer := r.overview(doc, i, stored[doc.Sections[i].Key], fingerprints, written)
		runs[i] = run
		if answer != nil {
			result.Status, result.Counts = answer.Status, answer.Counts
		}
	}
	for i := range doc.Sections {
		if runs[i].Key != "" {
			result.Sections = append(result.Sections, runs[i])
		}
	}
	return result
}

// section gathers, fingerprints, merges, writes, checks and submits one section that is not an overview.
func (r *wikiDocsBuildRun) section(doc wikiDocsPlanDoc, index int, stored wikiDocStored) (wikiDocsBuildSectionRun, *wikiDocWrittenSection, *wikiDocWriteAnswer) {
	planSection := doc.Sections[index]
	started := time.Now()
	run := wikiDocsBuildSectionRun{Key: planSection.Key, Title: planSection.Title, Kind: planSection.Kind, Actions: map[string]int{}}
	label := doc.Slug + "#" + planSection.Key
	fail := func(why string) (wikiDocsBuildSectionRun, *wikiDocWrittenSection, *wikiDocWriteAnswer) {
		run.Outcome, run.Why = "failed", why
		run.Seconds = time.Since(started).Seconds()
		fmt.Fprintf(r.progress, "%s: not written — %s\n", label, why)
		return run, nil, nil
	}
	pieces, missing, err := r.gather(doc, planSection)
	if err != nil {
		return fail(err.Error())
	}
	run.Pieces, run.Missing = len(pieces), missing
	wikiDocFilter(pieces)
	wikiDocSelect(planSection.Kind, pieces)
	run.MaterialSha256 = wikiDocFingerprint(planSection, pieces)
	if stored.materialSha256 == run.MaterialSha256 && !stored.stale {
		run.Outcome = "unchanged"
		run.Seconds = time.Since(started).Seconds()
		fmt.Fprintf(r.progress, "%s: its material is the one it was written from (%s), so it is left as it is.\n", label, run.MaterialSha256[:12])
		return run, nil, nil
	}
	if err := r.model(); err != nil {
		return fail(err.Error())
	}
	handed := wikiDocHanded(pieces)
	var state []string
	if len(handed) > 0 {
		text, err := r.ask(&run, wikiDocMergePrompt(doc, index, handed))
		if err != nil {
			return fail("the merge: " + err.Error())
		}
		state = wikiDocApplyMerge(text, pieces)
	}
	used := []*wikiDocPiece{}
	for _, piece := range pieces {
		if piece.action == "adopt" || piece.action == "merge" {
			used = append(used, piece)
		}
	}
	prompt := wikiDocWritePrompt(doc, index, state, used)
	text, err := r.ask(&run, prompt)
	if err != nil {
		return fail("the writing: " + err.Error())
	}
	draft := wikiDocParseWritten(text, used)
	// A paragraph that marks only its last sentence is asked for once more, marked sentence by sentence.
	if lonely := wikiDocEndOnlyParagraphs(draft.body); len(lonely) > 0 {
		again, err := r.ask(&run, prompt+wikiDocEndOnlyNote(lonely))
		if err != nil && r.stopped() != nil {
			return fail("the writing: " + err.Error())
		}
		if err == nil {
			retry := wikiDocParseWritten(again, used)
			if strings.TrimSpace(retry.body) != "" && len(wikiDocEndOnlyParagraphs(retry.body)) < len(lonely) {
				draft = retry
			}
		}
	}
	if strings.TrimSpace(draft.body) == "" {
		return fail("the model wrote no body for it")
	}
	section := r.footnotes(&run, draft, used)
	// A footnote with no quote that holds is asked about once more.
	if missingQuotes := wikiDocUnfoundCitations(draft, section, used); len(missingQuotes) > 0 {
		text, err := r.ask(&run, wikiDocQuoteRepairPrompt(draft, missingQuotes, used))
		if err != nil && r.stopped() != nil {
			return fail("the quotes: " + err.Error())
		}
		if err == nil {
			for id, quotes := range wikiDocParseQuotes(text) {
				draft.quotes[id] = append(quotes, draft.quotes[id]...)
			}
			section = r.footnotes(&run, draft, used)
		}
	}
	for _, piece := range pieces {
		run.Actions[piece.action]++
	}
	write := wikiDocSection{
		Key:            planSection.Key,
		MaterialSha256: run.MaterialSha256,
		Markdown:       section.markdown,
		Footnotes:      section.footnotes,
		Dispositions:   wikiDocDispositions(pieces),
	}
	answer, err := r.submit(doc.Slug, write)
	if err != nil {
		return fail(err.Error())
	}
	run.Outcome = "written"
	if len(answer.Sections) > 0 {
		run.Stats = answer.Sections[0].Stats
		if answer.Sections[0].Outcome == "unchanged" {
			run.Outcome = "unchanged"
		}
	}
	run.Seconds = time.Since(started).Seconds()
	fmt.Fprintf(r.progress, "%s: written — %d pieces of material (%s), %s, %d of them with a quote this run found in its original.\n",
		label, len(pieces), wikiDocActionLine(run.Actions), wikiCount(run.Footnote.Total, "footnote", "footnotes"), run.Footnote.Found)
	return run, &section, answer
}

// submit writes one section of a document; the writes of one document go one at a time.
func (r *wikiDocsBuildRun) submit(slug string, section wikiDocSection) (*wikiDocWriteAnswer, error) {
	r.writes.Lock()
	defer r.writes.Unlock()
	request := wikiDocWriteRequest{PlanVersion: r.planVersion, RepoSha: r.repo.sha, Model: r.cfg.model, Sections: []wikiDocSection{section}}
	raw, err := r.t.writeWikiDoc(r.sessionID, r.spaceID, slug, request)
	if r.heardServerExecutes(err) {
		return nil, errWikiServerExecutes
	}
	if err != nil {
		if refusal, ok := wikiDocRefused(err); ok {
			var lines []string
			for _, e := range refusal.Errors {
				lines = append(lines, e.Path+": "+e.Message)
			}
			return nil, fmt.Errorf("the server refused the write (%s): %s", wikiDocInvalidCode, strings.Join(lines, "; "))
		}
		return nil, wikiDocsBuildCallError(r.spaceID, err)
	}
	var answer wikiDocWriteAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		return nil, fmt.Errorf("the server's answer to the write is not the shape this build reads: %w", err)
	}
	return &answer, nil
}

// ── The overview, last ──────────────────────────────────────────────────────────────────────────

// wikiDocOverviewNote is one footnote of the document's other sections, as the overview may cite it.
type wikiDocOverviewNote struct {
	id       string
	footnote wikiDocFootnote
}

// overview writes a document's overview from its other sections as they are written, citing their
// footnotes (and their quotes) and nothing else. Its material is theirs: it is written again whenever
// one of them is.
func (r *wikiDocsBuildRun) overview(doc wikiDocsPlanDoc, index int, stored wikiDocStored, fingerprints []string, written []*wikiDocWrittenSection) (wikiDocsBuildSectionRun, *wikiDocWriteAnswer) {
	planSection := doc.Sections[index]
	started := time.Now()
	run := wikiDocsBuildSectionRun{Key: planSection.Key, Title: planSection.Title, Kind: planSection.Kind, Actions: map[string]int{}}
	label := doc.Slug + "#" + planSection.Key
	fail := func(why string) (wikiDocsBuildSectionRun, *wikiDocWriteAnswer) {
		run.Outcome, run.Why = "failed", why
		run.Seconds = time.Since(started).Seconds()
		fmt.Fprintf(r.progress, "%s: not written — %s\n", label, why)
		return run, nil
	}
	if stop := r.stopped(); stop != nil {
		return fail(stop.Error())
	}
	run.MaterialSha256 = wikiDocOverviewFingerprint(planSection, doc, index, fingerprints)
	if stored.materialSha256 == run.MaterialSha256 && !stored.stale {
		run.Outcome = "unchanged"
		run.Seconds = time.Since(started).Seconds()
		fmt.Fprintf(r.progress, "%s: the sections it sums up are the ones it was written from, so it is left as it is.\n", label)
		return run, nil
	}
	// The other sections as they are written: this run's own, and the server's for the ones it left alone.
	var view *wikiDocView
	for i, section := range doc.Sections {
		if i == index || section.Kind == "overview" || written[i] != nil || fingerprints[i] == "" {
			continue
		}
		raw, err := r.t.wikiDocWritten(r.sessionID, r.spaceID, doc.Slug)
		if r.heardServerExecutes(err) {
			return fail(errWikiServerExecutes.Error())
		}
		if err != nil {
			return fail("reading the sections it sums up: " + wikiDocsBuildCallError(r.spaceID, err).Error())
		}
		view = &wikiDocView{}
		if err := json.Unmarshal(raw, view); err != nil {
			return fail("the server's document is not the shape this build reads: " + err.Error())
		}
		break
	}
	sections, notes := wikiDocOverviewMaterial(doc, index, written, view)
	if len(sections) == 0 {
		return fail("none of the sections it sums up is written yet")
	}
	run.Pieces = len(notes)
	if err := r.model(); err != nil {
		return fail(err.Error())
	}
	text, err := r.ask(&run, wikiDocOverviewPrompt(doc, index, sections, notes))
	if err != nil {
		return fail("the writing: " + err.Error())
	}
	body := wikiDocStripHeading(wikiDocBodyOf(text))
	markdown, footnotes := r.overviewFootnotes(body, notes)
	if strings.TrimSpace(markdown) == "" {
		return fail("the model wrote no body for it")
	}
	run.Footnote.Total = len(footnotes)
	for _, footnote := range footnotes {
		if footnote.Quote == nil {
			run.Footnote.NoQuote++
		} else if footnote.Verified == nil || *footnote.Verified {
			run.Footnote.Found++
		}
	}
	answer, err := r.submit(doc.Slug, wikiDocSection{
		Key: planSection.Key, MaterialSha256: run.MaterialSha256, Markdown: markdown, Footnotes: footnotes,
		Dispositions: []wikiDocDisposition{},
	})
	if err != nil {
		return fail(err.Error())
	}
	run.Outcome = "written"
	if len(answer.Sections) > 0 {
		run.Stats = answer.Sections[0].Stats
	}
	run.Seconds = time.Since(started).Seconds()
	fmt.Fprintf(r.progress, "%s: the overview written last, from %s, with %s.\n", label,
		wikiCount(len(sections), "section", "sections"), wikiCount(len(footnotes), "footnote", "footnotes"))
	return run, answer
}

// wikiDocOverviewMaterial is what the overview is written from: each other section's text with its
// footnotes as [F<n>], numbered across the document, the same original and quote once.
func wikiDocOverviewMaterial(doc wikiDocsPlanDoc, index int, written []*wikiDocWrittenSection, view *wikiDocView) ([]string, []wikiDocOverviewNote) {
	var sections []string
	var notes []wikiDocOverviewNote
	seen := map[string]string{}
	name := func(footnote wikiDocFootnote) string {
		key, _ := json.Marshal([]interface{}{footnote.Kind, footnote.Path, footnote.Lines, footnote.Ref, footnote.Chars, footnote.Quote})
		if id, ok := seen[string(key)]; ok {
			return id
		}
		id := fmt.Sprintf("F%d", len(notes)+1)
		seen[string(key)] = id
		notes = append(notes, wikiDocOverviewNote{id: id, footnote: footnote})
		return id
	}
	stored := map[string]int{}
	if view != nil {
		for i, section := range view.Sections {
			stored[section.Key] = i
		}
	}
	for i, section := range doc.Sections {
		if i == index || section.Kind == "overview" {
			continue
		}
		var text string
		if written[i] != nil {
			text = wikiArticleMarker.ReplaceAllStringFunc(written[i].markdown, func(marker string) string {
				n, _ := strconv.Atoi(strings.Trim(marker, "[]"))
				if n < 1 || n > len(written[i].footnotes) {
					return ""
				}
				return "[" + name(written[i].footnotes[n-1]) + "]"
			})
		} else if at, ok := stored[section.Key]; ok && view.Sections[at].Written {
			byN := map[int]wikiDocFootnote{}
			for _, footnote := range view.Footnotes {
				byN[footnote.N] = wikiDocFootnoteFromView(footnote)
			}
			var b strings.Builder
			for _, block := range view.Sections[at].Blocks {
				if block.Text != nil && block.Kind == "heading" {
					b.WriteString("#### " + *block.Text + "\n")
					continue
				}
				if block.Kind == "code" {
					continue
				}
				for _, sentence := range block.Sentences {
					b.WriteString(sentence.Text)
					for _, n := range sentence.Notes {
						if footnote, ok := byN[n]; ok {
							b.WriteString("[" + name(footnote) + "]")
						}
					}
				}
				b.WriteString("\n\n")
			}
			text = strings.TrimSpace(b.String())
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		sections = append(sections, fmt.Sprintf("【第 %d 节 %s】\n%s", i+1, section.Title, text))
	}
	return sections, notes
}

// wikiDocFootnoteFromView is a stored footnote as a write carries it again.
func wikiDocFootnoteFromView(view wikiDocViewFootnote) wikiDocFootnote {
	footnote := wikiDocFootnote{Kind: view.Kind, Quote: view.Quote}
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	footnote.ViaEntryID = deref(view.ViaEntryID)
	if view.Path != nil {
		footnote.Path, footnote.Section, footnote.Symbol = *view.Path, deref(view.Section), deref(view.Symbol)
		if view.LineStart != nil && view.LineEnd != nil {
			footnote.Lines = &wikiDocRange{Start: *view.LineStart, End: *view.LineEnd}
		}
		return footnote
	}
	footnote.Ref = deref(view.RecordID)
	if view.CharStart != nil && view.CharEnd != nil {
		footnote.Chars = &wikiDocRange{Start: *view.CharStart, End: *view.CharEnd}
	}
	return footnote
}

// overviewFootnotes turns the overview's [F<n>] into its own [n], each footnote the cited one as it
// stands — a repository quote looked for again at this run's commit.
func (r *wikiDocsBuildRun) overviewFootnotes(body string, notes []wikiDocOverviewNote) (string, []wikiDocFootnote) {
	byID := map[string]wikiDocFootnote{}
	for _, note := range notes {
		byID[note.id] = note.footnote
	}
	footnotes := []wikiDocFootnote{}
	numberOf := map[string]int{}
	markdown := wikiDocRewriteMarkers(body, func(id string) (int, bool) {
		footnote, ok := byID[id]
		if !ok {
			return 0, false
		}
		if n, ok := numberOf[id]; ok {
			return n, true
		}
		if wikiDocIsRepoKind(footnote.Kind) {
			footnote = r.recheckRepoFootnote(footnote)
		}
		footnotes = append(footnotes, footnote)
		numberOf[id] = len(footnotes)
		return len(footnotes), true
	})
	return markdown, footnotes
}

// recheckRepoFootnote looks for a repository footnote's quote again at this run's commit: the lines it
// is found at now, or the lines it named, not found.
func (r *wikiDocsBuildRun) recheckRepoFootnote(footnote wikiDocFootnote) wikiDocFootnote {
	footnote.Sha = r.repo.sha
	no := false
	footnote.Verified = &no
	content, ok := r.repo.show(footnote.Path)
	if !ok || footnote.Quote == nil {
		if footnote.Lines == nil {
			footnote.Lines = &wikiDocRange{Start: 1, End: 1}
		}
		return footnote
	}
	within := footnote.Lines
	if lines, found := wikiDocLocate(content, *footnote.Quote, within); found {
		yes := true
		footnote.Verified = &yes
		footnote.Lines = &lines
		footnote.Excerpt = wikiDocLines(content, lines)
	}
	if footnote.Lines == nil {
		footnote.Lines = &wikiDocRange{Start: 1, End: 1}
	}
	return footnote
}

// wikiDocOverviewFingerprint is an overview's: its definition and the fingerprints of the sections it
// sums up, as they stand after this run.
func wikiDocOverviewFingerprint(section wikiDocsPlanSection, doc wikiDocsPlanDoc, index int, fingerprints []string) string {
	type part struct {
		Key         string `json:"key"`
		Fingerprint string `json:"fingerprint"`
	}
	parts := []part{}
	for i, other := range doc.Sections {
		if i == index || other.Kind == "overview" {
			continue
		}
		parts = append(parts, part{Key: other.Key, Fingerprint: fingerprints[i]})
	}
	return wikiDocDigest(map[string]interface{}{"definition": wikiDocDefinition(section), "sections": parts})
}

// ── The material ────────────────────────────────────────────────────────────────────────────────

// wikiDocPiece is one piece of a section's material: a design document's section, code, a contract, or a
// record the server handed out.
type wikiDocPiece struct {
	id      string // D1, C1, K1, S1: its place in the section
	kind    string // design_doc | code | contract | a record kind
	path    string
	lines   wikiDocRange
	section string
	symbol  string
	ref     string
	chars   wikiDocRange
	text    string
	record  *wikiDocMaterialRecord
	// What became of it, and why (docs.dispositionActions); handed is whether the model saw it.
	action string
	into   string
	reason string
	handed bool
}

func (p *wikiDocPiece) repo() bool { return wikiDocIsRepoKind(p.kind) }

func wikiDocIsRepoKind(kind string) bool {
	return kind == "design_doc" || kind == "code" || kind == "contract"
}

// dispositionRef is where a piece is, as its disposition names it: path#Lstart-end, or the record's id.
func (p *wikiDocPiece) dispositionRef() string {
	if p.repo() {
		return fmt.Sprintf("%s#L%d-%d", p.path, p.lines.Start, p.lines.End)
	}
	return p.ref
}

// wikiDocRepoPieces is the repository's half of a section's material at the commit `repo` reads: its design
// documents' sections, its code and its contracts, each numbered in its kind (D1, C1, K1), and what the
// commit does not have. A maintenance run reads it at two commits to tell whether what a section cites changed.
func wikiDocRepoPieces(repo *wikiDocRepo, section wikiDocsPlanSection) ([]*wikiDocPiece, []string) {
	var pieces []*wikiDocPiece
	var missing []string
	count := map[string]int{}
	add := func(prefix string, piece *wikiDocPiece) {
		count[prefix]++
		piece.id = fmt.Sprintf("%s%d", prefix, count[prefix])
		pieces = append(pieces, piece)
	}
	words := wikiDocSectionWords(section)
	for _, source := range section.Sources.Docs {
		heading := ""
		if source.Section != nil {
			heading = *source.Section
		}
		piece, ok := repo.docSection(source.Path, heading)
		if !ok {
			missing = append(missing, strings.TrimSpace(source.Path+" § "+heading))
			continue
		}
		duplicate := false
		for _, other := range pieces {
			duplicate = duplicate || (other.kind == "design_doc" && other.path == piece.path && other.lines.Start == piece.lines.Start)
		}
		if !duplicate {
			add("D", piece)
		}
	}
	for _, source := range section.Sources.Code {
		got, miss := repo.codePieces(source.Path, source.Symbols, words)
		missing = append(missing, miss...)
		for _, piece := range got {
			add("C", piece)
		}
	}
	for _, source := range section.Sources.Contracts {
		piece, ok := repo.contract(source.Path)
		if !ok {
			missing = append(missing, source.Path)
			continue
		}
		add("K", piece)
	}
	return pieces, missing
}

// gather reads a section's material: the repository's half here, the server's half from its door.
func (r *wikiDocsBuildRun) gather(doc wikiDocsPlanDoc, section wikiDocsPlanSection) ([]*wikiDocPiece, []string, error) {
	pieces, missing := wikiDocRepoPieces(r.repo, section)
	count := map[string]int{}
	add := func(prefix string, piece *wikiDocPiece) {
		count[prefix]++
		piece.id = fmt.Sprintf("%s%d", prefix, count[prefix])
		pieces = append(pieces, piece)
	}
	if section.Sources.Sessions != nil {
		raw, err := r.t.wikiDocMaterialOf(r.sessionID, r.spaceID, doc.Slug, section.Key)
		if r.heardServerExecutes(err) {
			return nil, nil, errWikiServerExecutes
		}
		if err != nil {
			return nil, nil, fmt.Errorf("the server's material: %w", wikiDocsBuildCallError(r.spaceID, err))
		}
		var answer wikiDocMaterialAnswer
		if err := json.Unmarshal(raw, &answer); err != nil {
			return nil, nil, fmt.Errorf("the server's material is not the shape this build reads: %w", err)
		}
		for i := range answer.Records {
			record := answer.Records[i]
			add("S", &wikiDocPiece{kind: record.Kind, ref: record.Ref, chars: record.Chars, text: record.Text, record: &record})
		}
		for _, item := range answer.Unresolved {
			missing = append(missing, item.Kind+" "+item.Ref+" (no record of this account answers it)")
		}
	}
	return pieces, missing, nil
}

// wikiDocTemplate is the project settlement card's message: the web composes it, the owner only presses
// the button, so it is nobody's words (contract `docs.build.templates`).
var wikiDocTemplate = regexp.MustCompile(`^\s*About [“"]`)

// wikiDocFilter takes out, by rule, what the model is never handed: the platform's template messages and
// a text another piece of the section already carries.
func wikiDocFilter(pieces []*wikiDocPiece) {
	seen := map[string]string{}
	for _, piece := range pieces {
		if piece.kind == "turn" && wikiDocTemplate.MatchString(piece.text) && strings.Contains(piece.text, "Orbit has not recorded it done") {
			piece.action, piece.reason = "filtered", "平台自动生成的复查模板消息（项目结算卡片发出），不是 owner 原话"
			continue
		}
		sum := sha256.Sum256([]byte(strings.TrimSpace(piece.text)))
		key := hex.EncodeToString(sum[:])
		if first, ok := seen[key]; ok {
			piece.action, piece.reason = "filtered", "与 "+first+" 的原文相同，只留一条"
			continue
		}
		seen[key] = piece.id
	}
}

// wikiDocSelect keeps what fits the section's cap, in the order its kind takes material: a mechanism's
// documents and code first, the others' records first. The first piece is kept whatever its size.
func wikiDocSelect(kind string, pieces []*wikiDocPiece) {
	rank := func(piece *wikiDocPiece) int {
		order := map[string]int{"D": 0, "C": 1, "K": 2, "S": 3}
		if !wikiDocMechanismKinds[kind] {
			order = map[string]int{"S": 0, "D": 1, "C": 2, "K": 3}
		}
		return order[piece.id[:1]]
	}
	ranked := []*wikiDocPiece{}
	for _, piece := range pieces {
		if piece.action == "" {
			ranked = append(ranked, piece)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return rank(ranked[i]) < rank(ranked[j]) })
	total, kept := 0, 0
	for _, piece := range ranked {
		size := utf8.RuneCountInString(piece.text) + wikiDocMaterialHeaderChars
		if kept > 0 && total+size > wikiDocMaterialMaxChars {
			piece.action = "over_cap"
			piece.reason = fmt.Sprintf("本节材料已满（上限 %d 字符），没有交给模型", wikiDocMaterialMaxChars)
			continue
		}
		piece.handed = true
		total += size
		kept++
	}
}

func wikiDocHanded(pieces []*wikiDocPiece) []*wikiDocPiece {
	var out []*wikiDocPiece
	for _, piece := range pieces {
		if piece.handed {
			out = append(out, piece)
		}
	}
	return out
}

// wikiDocDefinition is a section's definition in the plan, as the fingerprint takes it: the projects of its
// session condition by id alone, spelled one way.
func wikiDocDefinition(section wikiDocsPlanSection) map[string]interface{} {
	sources := map[string]interface{}{
		"docs": section.Sources.Docs, "code": section.Sources.Code, "contracts": section.Sources.Contracts, "sessions": nil,
	}
	if s := section.Sources.Sessions; s != nil {
		projects := []string{}
		for _, project := range s.Projects {
			projects = append(projects, publicID(project.ID))
		}
		sort.Strings(projects)
		sources["sessions"] = map[string]interface{}{
			"projects": projects, "since": s.Since, "until": s.Until, "keywords": s.Keywords, "anchorPaths": s.AnchorPaths,
			"entryKinds": s.EntryKinds, "topics": s.Topics, "evidence": s.Evidence,
		}
	}
	return map[string]interface{}{"title": section.Title, "kind": section.Kind, "covers": section.Covers, "length": section.Length, "sources": sources}
}

// wikiDocFingerprint is a section's materialSha256 (contract `docs.fingerprint`): its definition and every
// piece gathered for it, as gathered — not the commit it was read at.
func wikiDocFingerprint(section wikiDocsPlanSection, pieces []*wikiDocPiece) string {
	type part struct {
		Kind    string        `json:"kind"`
		Path    string        `json:"path,omitempty"`
		Lines   *wikiDocRange `json:"lines,omitempty"`
		Section string        `json:"section,omitempty"`
		Symbol  string        `json:"symbol,omitempty"`
		Ref     string        `json:"ref,omitempty"`
		Chars   *wikiDocRange `json:"chars,omitempty"`
		Via     string        `json:"via,omitempty"`
		Text    string        `json:"text"`
	}
	parts := []part{}
	for _, piece := range pieces {
		p := part{Kind: piece.kind, Text: piece.text}
		if piece.repo() {
			lines := piece.lines
			p.Path, p.Lines, p.Section, p.Symbol = piece.path, &lines, piece.section, piece.symbol
		} else {
			chars := piece.chars
			p.Ref, p.Chars = publicID(piece.ref), &chars
			if piece.record != nil && piece.record.Via != nil {
				p.Via = publicID(piece.record.Via.EntryID)
			}
		}
		parts = append(parts, p)
	}
	return wikiDocDigest(map[string]interface{}{"definition": wikiDocDefinition(section), "material": parts})
}

func wikiDocDigest(value interface{}) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// wikiDocSectionWords are the words a section is about, to match declarations in a file it names without
// symbols: code spans and identifiers in its title and covers, and the Chinese words of its title.
func wikiDocSectionWords(section wikiDocsPlanSection) []string {
	seen := map[string]bool{}
	var out []string
	add := func(word string) {
		word = strings.TrimSpace(word)
		if word != "" && !seen[word] {
			seen[word] = true
			out = append(out, word)
		}
	}
	both := section.Covers + " " + section.Title
	for _, match := range regexp.MustCompile("`([^`]+)`").FindAllStringSubmatch(both, -1) {
		add(match[1])
	}
	for _, word := range regexp.MustCompile(`[A-Za-z][A-Za-z0-9_]{3,}`).FindAllString(both, -1) {
		add(word)
	}
	for _, word := range regexp.MustCompile(`\p{Han}{2,4}`).FindAllString(section.Title, -1) {
		add(word)
	}
	return out
}

// ── The repository at origin/main ───────────────────────────────────────────────────────────────

// wikiDocRepo is the checkout at the one commit the run reads: every file shown once.
type wikiDocRepo struct {
	root, sha string
	mu        sync.Mutex
	blobs     map[string]*string
	files     []string
	listed    bool
}

func newWikiDocRepo(root, sha string) *wikiDocRepo {
	return &wikiDocRepo{root: root, sha: sha, blobs: map[string]*string{}}
}

// show is a file at the commit, or false when the commit has no such file.
func (r *wikiDocRepo) show(path string) (string, bool) {
	path = strings.TrimPrefix(strings.Trim(strings.TrimSpace(path), "`"), "./")
	r.mu.Lock()
	defer r.mu.Unlock()
	if blob, ok := r.blobs[path]; ok {
		if blob == nil {
			return "", false
		}
		return *blob, true
	}
	out, code, _, err := wikiAnchorGit(r.root, wikiAnchorGitTimeout, "show", r.sha+":"+path)
	if err != nil || code != 0 || path == "" {
		r.blobs[path] = nil
		return "", false
	}
	text := string(out)
	r.blobs[path] = &text
	return text, true
}

// under is every file under a directory at the commit, in git's order.
func (r *wikiDocRepo) under(dir string) []string {
	r.mu.Lock()
	if !r.listed {
		r.listed = true
		out, code, _, err := wikiAnchorGit(r.root, wikiAnchorGitTimeout, "ls-tree", "-r", "--name-only", r.sha)
		if err == nil && code == 0 {
			r.files = strings.Split(strings.TrimSpace(string(out)), "\n")
		}
	}
	files := r.files
	r.mu.Unlock()
	prefix := strings.TrimSuffix(strings.TrimPrefix(strings.Trim(strings.TrimSpace(dir), "`"), "./"), "/") + "/"
	var out []string
	for _, file := range files {
		if strings.HasPrefix(file, prefix) {
			out = append(out, file)
		}
	}
	return out
}

var (
	wikiDocHeadingLine = regexp.MustCompile(`^(#{1,6})\s+(.*?)\s*#*\s*$`)
	wikiDocFenceLine   = regexp.MustCompile("^\\s*(```+|~~~+)")
	wikiDocNumbered    = regexp.MustCompile(`^\s*§?\s*(\d+(?:\.\d+)*)\b`)
	wikiDocNormStrip   = regexp.MustCompile("[`*_#§]")
	wikiDocNormLead    = regexp.MustCompile(`^\s*(\d+(\.\d+)*)[.、)]?\s*`)
	wikiDocNormPunct   = regexp.MustCompile(`[\s（）()：:，,。.、“”"'「」/\-—–]+`)
)

// wikiDocHeadingKey is a heading as headings are matched: lowercase, its numbering and punctuation gone.
func wikiDocHeadingKey(s string) string {
	s = strings.ToLower(s)
	s = wikiDocNormStrip.ReplaceAllString(s, "")
	s = wikiDocNormLead.ReplaceAllString(s, "")
	return wikiDocNormPunct.ReplaceAllString(s, "")
}

// docSection is a design document's section: its heading's lines up to the next heading of the same or a
// higher level, cut at a line to fit. With no section named, the document from its top.
func (r *wikiDocRepo) docSection(path, section string) (*wikiDocPiece, bool) {
	content, ok := r.show(path)
	if !ok {
		return nil, false
	}
	lines := strings.Split(content, "\n")
	type heading struct {
		line, level int
		text        string
	}
	var headings []heading
	fence := ""
	for i, line := range lines {
		if m := wikiDocFenceLine.FindStringSubmatch(line); m != nil {
			if fence == "" {
				fence = m[1][:3]
			} else {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		if m := wikiDocHeadingLine.FindStringSubmatch(line); m != nil {
			headings = append(headings, heading{line: i, level: len(m[1]), text: strings.TrimSpace(m[2])})
		}
	}
	start, level, title := 0, 0, path
	if len(headings) > 0 {
		title = headings[0].text
	}
	if strings.TrimSpace(section) != "" {
		want := wikiDocHeadingKey(section)
		number := wikiDocNumbered.FindStringSubmatch(section)
		// The heading named — by its words or its number — before one whose words only contain the name or
		// are contained in it: a short heading («2. Space») is contained in many a longer one's name.
		found := false
		for pass := 0; pass < 2 && !found; pass++ {
			for _, h := range headings {
				key := wikiDocHeadingKey(h.text)
				named := key == want ||
					(number != nil && regexp.MustCompile(`^\s*§?\s*`+regexp.QuoteMeta(number[1])+`(?:[.\s:：、)]|$)`).MatchString(h.text))
				near := (utf8.RuneCountInString(want) >= 4 && strings.Contains(key, want)) ||
					(utf8.RuneCountInString(key) >= 4 && strings.Contains(want, key))
				if (pass == 0 && named) || (pass == 1 && near) {
					start, level, title, found = h.line, h.level, h.text, true
					break
				}
			}
		}
		if !found {
			return nil, false
		}
	}
	end := len(lines)
	for _, h := range headings {
		if h.line > start && (level == 0 || h.level <= level) {
			end = h.line
			break
		}
	}
	for end > start+1 && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	last := wikiDocFit(lines, start, end, wikiDocDocSectionChars)
	return &wikiDocPiece{
		kind: "design_doc", path: strings.TrimPrefix(path, "./"), section: title,
		lines: wikiDocRange{Start: start + 1, End: last}, text: strings.Join(lines[start:last], "\n"),
	}, true
}

// wikiDocFit is the last line (1-based, inclusive) of lines[start:end] that keeps the text within max
// characters — at least the first.
func wikiDocFit(lines []string, start, end, max int) int {
	total := 0
	for i := start; i < end; i++ {
		total += utf8.RuneCountInString(lines[i]) + 1
		if total > max && i > start {
			return i
		}
	}
	return end
}

var wikiDocCommentLine = regexp.MustCompile(`^\s*(//|/\*|\*|///|#)`)

// symbolLine is the line (0-based) a symbol is defined on, or -1: a Go method on its receiver type, a
// TypeScript method in its class, a function, type, class, interface, const or var.
func wikiDocSymbolLine(content, path, symbol string) int {
	s := regexp.MustCompile(`\s*\[.*?\]\s*$`).ReplaceAllString(strings.Trim(strings.TrimSpace(symbol), "`"), "")
	s = strings.TrimSpace(regexp.MustCompile(`\(.*\)$`).ReplaceAllString(s, ""))
	if s == "" {
		return -1
	}
	parts := strings.Split(s, ".")
	name := regexp.QuoteMeta(parts[len(parts)-1])
	lines := strings.Split(content, "\n")
	var patterns []string
	if len(parts) >= 2 {
		owner := regexp.QuoteMeta(parts[len(parts)-2])
		if strings.HasSuffix(path, ".go") {
			patterns = append(patterns, `^func \(\w+ \*?`+owner+`(?:\[[^\]]*\])?\) `+name+`\(`)
		} else {
			class := regexp.MustCompile(`\b(class|struct|extension|enum|actor|interface)\s+` + owner + `\b`)
			method := regexp.MustCompile(`^\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:public |private |protected |static |async |readonly |override |func |mutating |nonisolated |get |set )*` + name + `\s*[(<:=]`)
			for i, line := range lines {
				if class.MatchString(line) {
					for j := i + 1; j < len(lines) && j < i+4000; j++ {
						if method.MatchString(lines[j]) {
							return j
						}
					}
					break
				}
			}
		}
	}
	switch {
	case strings.HasSuffix(path, ".go"):
		patterns = append(patterns, `^func `+name+`[\[(]`, `^type `+name+`\b`, `^\s*(?:const|var)\s+`+name+`\b`, `^\t`+name+`\s+=`)
	case strings.HasSuffix(path, ".swift"):
		patterns = append(patterns, `\b(?:struct|class|enum|protocol|actor)\s+`+name+`\b`, `\bfunc `+name+`\s*[(<]`)
	default:
		patterns = append(patterns,
			`^export (?:default )?(?:abstract )?(?:async )?(?:function\*?|class|interface|type|enum|const|let)\s+`+name+`\b`,
			`^(?:async )?(?:function\*?|class|interface|type|enum|const|let)\s+`+name+`\b`,
			`^\s+(?:public |protected |private |static |async |readonly |override )*`+name+`\s*[(<]`)
	}
	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		for i, line := range lines {
			if re.MatchString(line) {
				return i
			}
		}
	}
	return -1
}

// wikiDocExtract is a definition from line i: the comment above it, then on until its braces close (or,
// with none, a blank line), at most maxLines, cut at a line to fit maxChars.
func wikiDocExtract(content string, i, maxLines, maxChars int) (int, int, string) {
	lines := strings.Split(content, "\n")
	start := i
	for start > 0 && start > i-wikiDocCommentLines && wikiDocCommentLine.MatchString(lines[start-1]) {
		start--
	}
	depth, end, opened := 0, i, false
	for j := i; j < len(lines) && j < i+maxLines; j++ {
		depth += strings.Count(lines[j], "{") - strings.Count(lines[j], "}")
		if strings.Contains(lines[j], "{") {
			opened = true
		}
		end = j
		if opened && depth <= 0 {
			break
		}
		if !opened && j > i && strings.TrimSpace(lines[j]) == "" {
			break
		}
	}
	last := wikiDocFit(lines, start, end+1, maxChars)
	return start + 1, last, strings.Join(lines[start:last], "\n")
}

var wikiDocDeclaration = regexp.MustCompile(`^(?:export )?(?:async )?(?:func|function|class|type|interface|const|struct|enum)\s+(?:\(\w+ \*?\w+\) )?(\w+)`)

// codePieces is what a code source names: each symbol's definition; with no symbols, the file's head
// comment and the declarations the section's words match; a directory, the first files under it.
func (r *wikiDocRepo) codePieces(path string, symbols, words []string) ([]*wikiDocPiece, []string) {
	path = strings.TrimPrefix(strings.Trim(strings.TrimSpace(path), "`"), "./")
	if _, ok := r.show(path); !ok {
		files := r.under(path)
		if len(files) == 0 {
			return nil, []string{path + " (not at origin/main)"}
		}
		if len(files) > wikiDocFilesPerDir {
			files = files[:wikiDocFilesPerDir]
		}
		var out []*wikiDocPiece
		var missing []string
		for _, file := range files {
			got, miss := r.codePieces(file, nil, append(append([]string{}, words...), symbols...))
			out = append(out, got...)
			missing = append(missing, miss...)
		}
		return out, missing
	}
	content, _ := r.show(path)
	var out []*wikiDocPiece
	var missing []string
	for _, symbol := range symbols {
		i := wikiDocSymbolLine(content, path, symbol)
		if i < 0 {
			missing = append(missing, path+" :: "+symbol)
			continue
		}
		start, end, text := wikiDocExtract(content, i, wikiDocSymbolLines, wikiDocSymbolChars)
		out = append(out, &wikiDocPiece{kind: "code", path: path, symbol: symbol, lines: wikiDocRange{Start: start, End: end}, text: text})
	}
	if len(symbols) > 0 {
		return out, missing
	}
	lines := strings.Split(content, "\n")
	head := 0
	for head < len(lines) && head < wikiDocFileHeadLines &&
		(strings.TrimSpace(lines[head]) == "" || regexp.MustCompile(`^\s*(//|/\*|\*|package|import|#)`).MatchString(lines[head])) {
		head++
	}
	if head > 0 {
		last := wikiDocFit(lines, 0, head, wikiDocFileHeadChars)
		out = append(out, &wikiDocPiece{kind: "code", path: path, lines: wikiDocRange{Start: 1, End: last}, text: strings.Join(lines[:last], "\n")})
	}
	type scored struct{ score, line int }
	var matched []scored
	for i, line := range lines {
		if !wikiDocDeclaration.MatchString(line) {
			continue
		}
		from := i - 6
		if from < 0 {
			from = 0
		}
		window := strings.ToLower(strings.Join(lines[from:i+1], "\n"))
		score := 0
		for _, word := range words {
			if word != "" && strings.Contains(window, strings.ToLower(word)) {
				score++
			}
		}
		if score > 0 {
			matched = append(matched, scored{score, i})
		}
	}
	sort.SliceStable(matched, func(a, b int) bool { return matched[a].score > matched[b].score })
	for k, m := range matched {
		if k == wikiDocDeclsPerFile {
			break
		}
		start, end, text := wikiDocExtract(content, m.line, wikiDocDeclLines, wikiDocDeclChars)
		name := wikiDocDeclaration.FindStringSubmatch(lines[m.line])[1]
		out = append(out, &wikiDocPiece{kind: "code", path: path, symbol: name, lines: wikiDocRange{Start: start, End: end}, text: text})
	}
	return out, missing
}

// contract is a contract file, cut at a line to fit.
func (r *wikiDocRepo) contract(path string) (*wikiDocPiece, bool) {
	path = strings.TrimPrefix(strings.Trim(strings.TrimSpace(path), "`"), "./")
	content, ok := r.show(path)
	if !ok {
		return nil, false
	}
	lines := strings.Split(content, "\n")
	end := len(lines)
	for end > 1 && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	last := wikiDocFit(lines, 0, end, wikiDocContractChars)
	return &wikiDocPiece{kind: "contract", path: path, lines: wikiDocRange{Start: 1, End: last}, text: strings.Join(lines[:last], "\n")}, true
}

// ── Quotes, folded and found ────────────────────────────────────────────────────────────────────

// wikiDocPunctuation is the full-width punctuation a quote is compared as its ASCII counterpart
// (contract `docs.verification.normalization`).
var wikiDocPunctuation = map[rune]rune{
	'，': ',', '。': '.', '：': ':', '；': ';', '（': '(', '）': ')', '！': '!', '？': '?', '「': '"', '」': '"',
	'“': '"', '”': '"', '‘': '\'', '’': '\'', '、': ',', '『': '"', '』': '"', '【': '[', '】': ']', '—': '-', '–': '-',
}

const wikiDocEscapable = "\\`*_{}[]()#+-.!|\""

// wikiDocFold folds runes[from:to] the way a quote is compared — punctuation read as ASCII, ** __ and
// backticks dropped, an escape read as what it escapes, whitespace dropped, and with skip the characters of
// each line's leading comment marker — and answers, for each folded rune, the index it came from.
func wikiDocFold(runes []rune, from, to int, skip []bool) ([]rune, []int) {
	var out []rune
	var at []int
	for i := from; i < to; i++ {
		if skip != nil && skip[i] {
			continue
		}
		ch := runes[i]
		if unicode.IsSpace(ch) || ch == '`' {
			continue
		}
		if (ch == '*' || ch == '_') && i+1 < to && runes[i+1] == ch {
			i++
			continue
		}
		if ch == '\\' && i+1 < to && strings.ContainsRune(wikiDocEscapable, runes[i+1]) {
			continue
		}
		if mapped, ok := wikiDocPunctuation[ch]; ok {
			ch = mapped
		}
		out = append(out, ch)
		at = append(at, i)
	}
	return out, at
}

var wikiDocCommentMarker = regexp.MustCompile(`^(?:/{2,3}|/\*+|\*+/?|#)\s?`)

// wikiDocCommentSkips marks each line's leading comment marker and the space after it.
func wikiDocCommentSkips(runes []rune) []bool {
	skip := make([]bool, len(runes))
	lineStart := 0
	for lineStart <= len(runes) {
		end := lineStart
		for end < len(runes) && runes[end] != '\n' {
			end++
		}
		first := lineStart
		for first < end && unicode.IsSpace(runes[first]) {
			first++
		}
		limit := first + 64
		if limit > end {
			limit = end
		}
		if m := wikiDocCommentMarker.FindString(string(runes[first:limit])); m != "" {
			for k := first; k < first+utf8.RuneCountInString(m); k++ {
				skip[k] = true
			}
		}
		lineStart = end + 1
	}
	return skip
}

// wikiDocFind is where quote is in source, in runes, [start, end), within runes[from:to]: one passage,
// folded, first as it stands and then with each line's comment marker off; or false.
func wikiDocFind(source []rune, quote string, from, to int) (int, int, bool) {
	needle, _ := wikiDocFold([]rune(quote), 0, utf8.RuneCountInString(quote), nil)
	if len(needle) < wikiDocQuoteMinChars {
		return 0, 0, false
	}
	if from < 0 {
		from = 0
	}
	if to > len(source) {
		to = len(source)
	}
	if from >= to {
		return 0, 0, false
	}
	for _, skip := range [][]bool{nil, wikiDocCommentSkips(source)} {
		folded, at := wikiDocFold(source, from, to, skip)
		if i := strings.Index(string(folded), string(needle)); i >= 0 {
			// Index is in bytes of the folded string: back to runes.
			k := utf8.RuneCountInString(string(folded)[:i])
			return at[k], at[k+len(needle)-1] + 1, true
		}
	}
	return 0, 0, false
}

// wikiDocLocate is the lines a quote is found at in a file: within the lines it was taken from first, then
// anywhere in the file.
func wikiDocLocate(content, quote string, within *wikiDocRange) (wikiDocRange, bool) {
	runes := []rune(content)
	lineStarts := []int{0}
	for i, ch := range runes {
		if ch == '\n' {
			lineStarts = append(lineStarts, i+1)
		}
	}
	lineOf := func(at int) int { return sort.Search(len(lineStarts), func(k int) bool { return lineStarts[k] > at }) }
	tries := [][2]int{}
	if within != nil && within.Start >= 1 && within.Start <= len(lineStarts) {
		from := lineStarts[within.Start-1]
		to := len(runes)
		if within.End < len(lineStarts) {
			to = lineStarts[within.End]
		}
		tries = append(tries, [2]int{from, to})
	}
	tries = append(tries, [2]int{0, len(runes)})
	for _, try := range tries {
		if start, end, ok := wikiDocFind(runes, quote, try[0], try[1]); ok {
			return wikiDocRange{Start: lineOf(start), End: lineOf(end - 1)}, true
		}
	}
	return wikiDocRange{}, false
}

// wikiDocLines is the text of lines [start, end] of a file, cut to what an excerpt may hold.
func wikiDocLines(content string, lines wikiDocRange) string {
	all := strings.Split(content, "\n")
	if lines.Start < 1 || lines.Start > len(all) {
		return ""
	}
	end := lines.End
	if end > len(all) {
		end = len(all)
	}
	return cutRunes(strings.Join(all[lines.Start-1:end], "\n"), wikiDocExcerptMaxChars)
}

// ── The prompts ─────────────────────────────────────────────────────────────────────────────────

func wikiDocKindWord(kind string) string {
	if word, ok := wikiDocKindWords[kind]; ok {
		return word
	}
	return kind
}

// wikiDocHeader is a piece's first line as the model reads it: what it is, where it is, and — a record —
// who said it, when, with what weight, and the entry it came through.
func wikiDocHeader(piece *wikiDocPiece) string {
	switch piece.kind {
	case "design_doc":
		return fmt.Sprintf("[%s] 设计文档 %s § %s（L%d–L%d，origin/main）", piece.id, piece.path, piece.section, piece.lines.Start, piece.lines.End)
	case "code":
		symbol := ""
		if piece.symbol != "" {
			symbol = " · " + piece.symbol
		}
		return fmt.Sprintf("[%s] 代码 %s%s（L%d–L%d，origin/main）", piece.id, piece.path, symbol, piece.lines.Start, piece.lines.End)
	case "contract":
		return fmt.Sprintf("[%s] 契约 %s（L%d–L%d，origin/main）", piece.id, piece.path, piece.lines.Start, piece.lines.End)
	}
	record := piece.record
	who := wikiDocWho(piece)
	when, where, via := "", "", ""
	if record != nil {
		if record.At != nil && len(*record.At) >= 10 {
			when = (*record.At)[:10]
		}
		for _, name := range []*string{record.SessionTitle, record.TaskTitle, record.NotePath} {
			if name != nil && *name != "" {
				where = cutRunes(*name, 60)
				break
			}
		}
		if record.Via != nil {
			via = "，经条目《" + record.Via.Title + "》"
		}
		if record.ProjectTitle != nil && *record.ProjectTitle != "" {
			where += "（项目「" + cutRunes(*record.ProjectTitle, 40) + "」）"
		}
	}
	weight := ""
	if record != nil {
		if word, ok := wikiDocWeightWords[record.Weight]; ok {
			weight = " · 证据分量：" + word
		}
	}
	return fmt.Sprintf("[%s] 记录原文 · %s · %s · 「%s」%s%s", piece.id, who, when, where, via, weight)
}

// wikiDocWho is who a record's words are.
func wikiDocWho(piece *wikiDocPiece) string {
	record := piece.record
	label := ""
	if record != nil && record.Label != nil {
		label = *record.Label
	}
	switch piece.kind {
	case "turn":
		if record != nil && record.OwnerWords {
			return "owner 原话"
		}
		return "会话消息"
	case "event":
		switch label {
		case "assistant":
			return "agent 回复"
		case "thinking":
			return "agent 思考"
		case "tool_use":
			return "agent 工具调用"
		case "tool_result":
			if record != nil && record.Weight == "error" {
				return "工具结果（报错）"
			}
			return "工具结果"
		case "error":
			return "报错"
		}
		return "会话事件 " + label
	case "tool_call":
		if record != nil && record.Weight == "error" {
			return "命令输出（报错）"
		}
		return "命令输出"
	case "task_comment":
		if record != nil && record.OwnerWords {
			return "owner 评论"
		}
		return "agent 交付评论"
	case "approval":
		return "owner 的回答"
	case "owner_decision":
		return "owner 的决定"
	case "merge_receipt":
		return "合并回执"
	case "note":
		return "导入的笔记"
	case "task":
		return "任务描述"
	}
	return piece.kind
}

func wikiDocBlock(piece *wikiDocPiece) string {
	body := piece.text
	if piece.kind == "code" {
		body = "```\n" + body + "\n```"
	}
	return wikiDocHeader(piece) + "\n" + body
}

func wikiDocOutline(doc wikiDocsPlanDoc, current int) string {
	var lines []string
	for i, section := range doc.Sections {
		mark := ""
		if i == current {
			mark = "　← 本节"
		}
		lines = append(lines, fmt.Sprintf("  %d. %s（%s）—— %s%s", i+1, section.Title, wikiDocKindWord(section.Kind), section.Covers, mark))
	}
	return strings.Join(lines, "\n")
}

// wikiDocMergePrompt asks the model to merge the pieces it is handed into the section's current state, and
// to say what became of each.
func wikiDocMergePrompt(doc wikiDocsPlanDoc, index int, handed []*wikiDocPiece) string {
	section := doc.Sections[index]
	var blocks []string
	for _, piece := range handed {
		blocks = append(blocks, wikiDocBlock(piece))
	}
	return fmt.Sprintf(`# 任务：为文档《%s》的第 %d 节做「归并」：把下面的材料合成这一节要写的「现状」

## 这一节
第 %d 节「%s」（%s，约 %d 字）：%s

## 材料（D=设计文档章节，C=代码，K=契约，都取自 origin/main；S=会话等一手记录的原文，已脱敏）
%s

## 归并规则（owner 已定）
1. 同一件事有多条材料时合成一条现状；新决定覆盖旧的。
2. 证据分量：决定（owner 原话与拍板、判据修订）> 合并记录（合并回执、交付评论）> 命令与测试输出 > 报错原文；同一分量取时间最新的一条。S 材料的标题写了它的证据分量和日期。
3. 不能当证据：agent 的猜测（「可能」「我怀疑」「估计」）、后来被推翻的说法、与本节无关的材料。
4. 讲机制的节以设计文档和代码为准；会话材料只用来说明「为什么」「坑」「决策」。代码与文档说法不一致时，以 origin/main 上的代码为准，并把不一致写进现状。
5. 被推翻的旧说法不进现状；如果它能解释当初为什么这么设计，可以写成「曾经……后来改为……」，并注明新旧两条材料。

## 输出格式
先逐条写处置，每条材料一行，一条不漏：
<编号> | 采用 | <一句理由>
<编号> | 合并到 <编号> | <一句理由>
<编号> | 舍弃 | <一句理由>
然后写：
现状：
- <一条要点，一句话> [<编号>][<编号>]
（3–8 条要点，每条标出依据的材料编号）
`, doc.Title, index+1, index+1, section.Title, wikiDocKindWord(section.Kind), section.Length, section.Covers, strings.Join(blocks, "\n\n"))
}

// wikiDocWritePrompt asks the model to write the section from the pieces it kept, with a verbatim quote for
// every footnote it marks.
func wikiDocWritePrompt(doc wikiDocsPlanDoc, index int, state []string, used []*wikiDocPiece) string {
	section := doc.Sections[index]
	stateText := "（无）"
	if len(state) > 0 {
		stateText = "- " + strings.Join(state, "\n- ")
	}
	materials := "（归并后没有可用材料。只写一两句本篇的边界说明，不陈述新事实。）"
	if len(used) > 0 {
		var blocks []string
		for _, piece := range used {
			blocks = append(blocks, wikiDocBlock(piece))
		}
		materials = strings.Join(blocks, "\n\n")
	}
	return fmt.Sprintf(`# 任务：写文档《%s》的第 %d 节

## 这篇文档
- 读者带着的问题：%s
- 写给谁：%s
- 全篇大纲：
%s

## 本节
「%s」（%s，约 %d 字）：%s

## 归并后的现状（上一步的结果）
%s

## 可用材料（只可引用这些，编号不变）
%s

## 写法
- 写成连贯的技术文档段落：先讲是什么，再讲怎么运转、为什么。不要逐条罗列材料，不要写「材料显示」「根据会话记录」这类话。
- 每个陈述事实的句子，各自在句末标出依据的材料编号，如 [D1] 或 [C2][S3]。「决策与理由」「已知的坑」「约定」这类段落也要逐句标注，不能只在段末标一次。
- 讲机制（概念、流程、接口、数据、运维）只依据 D/C/K 材料；S 材料只用来讲为什么、已知的坑、决策。
- 契约和设计文档里的缩写与编号（例如 SR50、PAC §12、G0–G6 这类）第一次出现时，先用半句话说明它指什么，再用；说明不了就不用缩写，直接说它指的那件事。
- 过渡句、概括句可以不标编号，但不能带出材料里没有的新事实（新的名字、数字、路径、结论）。
- 不写材料里没有的事实。材料之间有冲突时写现状，必要时用一句话交代变化。
- 代码名、路径、命令用反引号，照原文写。长度约 %d 字。

## 引文
正文之后另起一行写「引文：」，为正文里用到的每个编号各写一行逐字引文：从该材料原文里原样抄出支撑你那句话的一小段（10–80 字，一字不改，不翻译，不把两处拼在一起，不加省略号）。正文里出现的每一个编号都必须有一行引文。
[D1] 「……」
[S3] 「……」

## 输出格式
只输出下面这些，不要前言：
### %s
<正文>

引文：
[编号] 「逐字引文」
`, doc.Title, index+1, doc.Question, strings.Join(doc.Audience, "；"), wikiDocOutline(doc, index), section.Title,
		wikiDocKindWord(section.Kind), section.Length, section.Covers, stateText, materials, section.Length, section.Title)
}

// wikiDocOverviewPrompt asks for the overview from the other sections as they are written.
func wikiDocOverviewPrompt(doc wikiDocsPlanDoc, index int, sections []string, notes []wikiDocOverviewNote) string {
	section := doc.Sections[index]
	var quotes []string
	for _, note := range notes {
		quote := "（无引文）"
		if note.footnote.Quote != nil {
			quote = "「" + *note.footnote.Quote + "」"
		}
		quotes = append(quotes, "["+note.id+"] "+quote)
	}
	return fmt.Sprintf(`# 任务：写文档《%s》的第 %d 节「%s」（概述，约 %d 字）

## 这篇文档
- 读者带着的问题：%s
- 写给谁：%s
- 这一节要概括：%s

## 下文各节已经写好（正文里的 [F编号] 是它们的脚注）
%s

## 这些脚注的逐字引文
%s

## 写法
- 用一两段话告诉读者：这篇讲的东西是什么、怎么运转、读完能知道什么；点出最重要的几件事。
- 只概括下文已经写了的内容，不引入新事实。每个陈述事实的句子在句末沿用下文该事实所用的 [F编号]，只用上面列出的编号。
- 不写「本文将介绍」这类空话。

## 输出格式
只输出下面这些，不要前言：
### %s
<正文>
`, doc.Title, index+1, section.Title, section.Length, doc.Question, strings.Join(doc.Audience, "；"), section.Covers,
		strings.Join(sections, "\n\n"), strings.Join(quotes, "\n"), section.Title)
}

// wikiDocQuoteRepairPrompt asks once more for the quotes that were missing or not found in their originals.
func wikiDocQuoteRepairPrompt(draft wikiDocDraft, ids []string, used []*wikiDocPiece) string {
	byID := map[string]*wikiDocPiece{}
	for _, piece := range used {
		byID[piece.id] = piece
	}
	var parts []string
	for _, id := range ids {
		piece := byID[id]
		sentences := wikiDocSentencesCiting(draft.body, id)
		parts = append(parts, fmt.Sprintf("## [%s] 标在这些句子上：\n%s\n材料原文：\n%s", id, strings.Join(sentences, "\n"), piece.text))
	}
	return fmt.Sprintf(`# 任务：给下面几个脚注补逐字引文

你刚写的一节里，这些编号的引文缺了，或者在材料原文里找不到。请为每个编号从它的材料原文里原样抄出一段支撑那些句子的文字（10–80 字，一字不改，不翻译，不把两处拼在一起，不加省略号）。

%s

## 输出格式
每个编号一行，只输出这些：
[编号] 「逐字引文」
`, strings.Join(parts, "\n\n"))
}

func wikiDocEndOnlyNote(lonely []string) string {
	return "\n\n## 上一稿的问题\n上一稿有段落只在段末标了一次编号，前面陈述事实的句子没有标：\n" +
		"- " + strings.Join(lonely, "\n- ") + "\n这次每个陈述事实的句子都要在句末标出它自己依据的编号。\n"
}

// ── Reading what the model wrote ────────────────────────────────────────────────────────────────

var (
	wikiDocDispositionLine = regexp.MustCompile(`^\s*[-*]?\s*\[?([A-Z]\d{1,4})\]?\s*[|｜]\s*(采用|舍弃|合并到\s*\[?([A-Z]\d{1,4})\]?)\s*(?:[|｜]\s*(.*))?$`)
	wikiDocStateLine       = regexp.MustCompile(`^\s*现状\s*[:：]`)
	wikiDocBullet          = regexp.MustCompile(`^\s*([-*•]|\d+[.、])\s*`)
	wikiDocQuoteLine       = regexp.MustCompile(`^\s*[-*]?\s*[\[【]([A-Z]\d{1,4})[\]】]\s*[:：]?\s*[「“"『](.*)[」”"』]\s*$`)
	wikiDocQuotesStart     = regexp.MustCompile(`(?m)^\s*\**引文\**\s*[:：]\s*$`)
	// A material marker: D, C, K and S name a section's pieces, F an overview's footnotes. Anything else in
	// brackets is the text's own ([P0], [x]) and is left as it is.
	wikiDocIDMarker = regexp.MustCompile(`[\[【]\s*([DCKSF]\d{1,4}(?:\s*[,，、]\s*[DCKSF]\d{1,4})*)\s*[\]】]`)
)

// wikiDocApplyMerge reads the merge's dispositions onto the pieces it was handed, and answers the state
// it wrote. A piece it said nothing of is adopted; a merge into a piece that is not the section's, or into
// itself, is read as an adoption.
func wikiDocApplyMerge(text string, pieces []*wikiDocPiece) []string {
	byID := map[string]*wikiDocPiece{}
	for _, piece := range pieces {
		if piece.handed {
			byID[piece.id] = piece
		}
	}
	var state []string
	inState := false
	said := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		if wikiDocStateLine.MatchString(line) {
			inState = true
			continue
		}
		if inState {
			if wikiDocBullet.MatchString(line) && strings.TrimSpace(wikiDocBullet.ReplaceAllString(line, "")) != "" {
				state = append(state, strings.TrimSpace(wikiDocBullet.ReplaceAllString(line, "")))
			}
			continue
		}
		m := wikiDocDispositionLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		piece := byID[m[1]]
		if piece == nil || said[m[1]] {
			continue
		}
		said[m[1]] = true
		reason := strings.TrimSpace(m[4])
		switch {
		case m[2] == "采用":
			piece.action = "adopt"
		case m[2] == "舍弃":
			piece.action = "drop"
		default:
			if target := byID[m[3]]; target != nil && m[3] != piece.id {
				piece.action, piece.into = "merge", m[3]
			} else {
				piece.action = "adopt"
				reason = strings.TrimSpace(fmt.Sprintf("（合并目标 %s 不是本节交给模型的材料，按采用）%s", m[3], reason))
			}
		}
		if reason == "" {
			reason = "归并没有写理由"
		}
		piece.reason = reason
	}
	for _, piece := range byID {
		if piece.action == "" {
			piece.action, piece.reason = "adopt", "归并没有写这条的处置，按采用交给写作"
		}
	}
	return state
}

// wikiDocDraft is what the model wrote: the body with its material markers, and the quotes it gave.
type wikiDocDraft struct {
	body   string
	quotes map[string][]string
}

// wikiDocBodyOf is the answer up to its quotes.
func wikiDocBodyOf(text string) string {
	if loc := wikiDocQuotesStart.FindStringIndex(text); loc != nil {
		return strings.TrimSpace(text[:loc[0]])
	}
	return strings.TrimSpace(text)
}

// wikiDocStripHeading drops a first line that is a heading: the plan names the section.
func wikiDocStripHeading(body string) string {
	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) > 0 && wikiDocHeadingLine.MatchString(strings.TrimSpace(lines[0])) {
		lines = lines[1:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// wikiDocParseQuotes reads `[ID] 「quote」` lines.
func wikiDocParseQuotes(text string) map[string][]string {
	quotes := map[string][]string{}
	for _, line := range strings.Split(text, "\n") {
		if m := wikiDocQuoteLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil && strings.TrimSpace(m[2]) != "" {
			quotes[m[1]] = append(quotes[m[1]], strings.TrimSpace(m[2]))
		}
	}
	return quotes
}

func wikiDocParseWritten(text string, used []*wikiDocPiece) wikiDocDraft {
	draft := wikiDocDraft{body: wikiDocStripHeading(wikiDocBodyOf(text)), quotes: map[string][]string{}}
	if loc := wikiDocQuotesStart.FindStringIndex(text); loc != nil {
		draft.quotes = wikiDocParseQuotes(text[loc[1]:])
	}
	return draft
}

// wikiDocRewriteMarkers turns every material marker outside code spans — [D1], [C2][S3], [D1, S3], 【S1】 —
// into footnote numbers, by name: one name answers false and its marker is dropped.
func wikiDocRewriteMarkers(body string, name func(id string) (int, bool)) string {
	segments := strings.Split(body, "`")
	for i := range segments {
		if i%2 == 1 {
			continue
		}
		segments[i] = wikiDocIDMarker.ReplaceAllStringFunc(segments[i], func(marker string) string {
			inner := wikiDocIDMarker.FindStringSubmatch(marker)[1]
			var out strings.Builder
			for _, id := range regexp.MustCompile(`[DCKSF]\d{1,4}`).FindAllString(inner, -1) {
				if n, ok := name(id); ok {
					out.WriteString("[" + strconv.Itoa(n) + "]")
				}
			}
			return out.String()
		})
	}
	return strings.Join(segments, "`")
}

// footnotes turns the draft into the section a write carries: the markers numbered by first appearance,
// each footnote the piece it names with the first of its quotes that holds — a repository quote found in
// the file at the commit (its lines where it was found), a record's in the text the server handed out.
func (r *wikiDocsBuildRun) footnotes(run *wikiDocsBuildSectionRun, draft wikiDocDraft, used []*wikiDocPiece) wikiDocWrittenSection {
	byID := map[string]*wikiDocPiece{}
	for _, piece := range used {
		byID[piece.id] = piece
	}
	// A list even when empty: a section with no footnote sends [] (docs.schemaNote), never null.
	footnotes := []wikiDocFootnote{}
	numberOf := map[string]int{}
	markdown := wikiDocRewriteMarkers(draft.body, func(id string) (int, bool) {
		piece := byID[id]
		if piece == nil {
			return 0, false
		}
		if n, ok := numberOf[id]; ok {
			return n, true
		}
		if len(footnotes) >= wikiDocFootnotesMax {
			return 0, false
		}
		footnotes = append(footnotes, r.footnoteFor(piece, draft.quotes[id]))
		numberOf[id] = len(footnotes)
		return len(footnotes), true
	})
	run.Footnote.Total, run.Footnote.Found, run.Footnote.NoQuote = len(footnotes), 0, 0
	for _, footnote := range footnotes {
		switch {
		case footnote.Quote == nil:
			run.Footnote.NoQuote++
		case footnote.Verified != nil && *footnote.Verified:
			run.Footnote.Found++
		case footnote.Verified == nil && footnote.found:
			run.Footnote.Found++
		}
	}
	return wikiDocWrittenSection{markdown: cutRunes(markdown, wikiDocMarkdownMaxChars), footnotes: footnotes}
}

// footnoteFor is one piece's footnote, with the first of its quotes that holds, or the first of them.
func (r *wikiDocsBuildRun) footnoteFor(piece *wikiDocPiece, quotes []string) wikiDocFootnote {
	var candidates []string
	for _, quote := range quotes {
		quote = strings.TrimSpace(quote)
		if quote != "" {
			candidates = append(candidates, cutRunes(quote, wikiDocQuoteMaxChars))
		}
	}
	footnote := wikiDocFootnote{Kind: piece.kind}
	if piece.record != nil && piece.record.Via != nil {
		footnote.ViaEntryID = piece.record.Via.EntryID
	}
	if piece.repo() {
		no := false
		lines := piece.lines
		footnote.Path, footnote.Sha, footnote.Lines, footnote.Verified = piece.path, r.repo.sha, &lines, &no
		footnote.Section, footnote.Symbol = piece.section, piece.symbol
		footnote.Excerpt = cutRunes(piece.text, wikiDocExcerptMaxChars)
		content, ok := r.repo.show(piece.path)
		for _, quote := range candidates {
			if !ok {
				break
			}
			if found, hit := wikiDocLocate(content, quote, &piece.lines); hit {
				yes := true
				q := quote
				footnote.Quote, footnote.Verified, footnote.Lines = &q, &yes, &found
				footnote.Excerpt = wikiDocLines(content, found)
				return footnote
			}
		}
		if len(candidates) > 0 {
			q := candidates[0]
			footnote.Quote = &q
		}
		return footnote
	}
	chars := piece.chars
	footnote.Ref, footnote.Chars = piece.ref, &chars
	text := []rune(piece.text)
	for _, quote := range candidates {
		if _, _, hit := wikiDocFind(text, quote, 0, len(text)); hit {
			q := quote
			footnote.Quote, footnote.found = &q, true
			return footnote
		}
	}
	if len(candidates) > 0 {
		q := candidates[0]
		footnote.Quote = &q
	}
	return footnote
}

// wikiDocUnfoundCitations are the ids the body cites whose footnote has no quote that holds.
func wikiDocUnfoundCitations(draft wikiDocDraft, section wikiDocWrittenSection, used []*wikiDocPiece) []string {
	cited := []string{}
	seen := map[string]bool{}
	byID := map[string]*wikiDocPiece{}
	for _, piece := range used {
		byID[piece.id] = piece
	}
	wikiDocRewriteMarkers(draft.body, func(id string) (int, bool) {
		if byID[id] != nil && !seen[id] {
			seen[id] = true
			cited = append(cited, id)
		}
		return 0, false
	})
	var out []string
	for k, id := range cited {
		if k >= len(section.footnotes) {
			break
		}
		footnote := section.footnotes[k]
		holds := footnote.Quote != nil && ((footnote.Verified != nil && *footnote.Verified) || (footnote.Verified == nil && footnote.found))
		if !holds {
			out = append(out, id)
		}
	}
	return out
}

// wikiDocSentencesCiting are the body's sentences that carry id.
func wikiDocSentencesCiting(body, id string) []string {
	var out []string
	for _, line := range strings.Split(body, "\n") {
		for _, sentence := range wikiArticleSentences(strings.TrimSpace(line)) {
			if regexp.MustCompile(`[\[【][^\]】]*\b`+regexp.QuoteMeta(id)+`\b[^\]】]*[\]】]`).MatchString(sentence) {
				out = append(out, "- "+strings.TrimSpace(sentence))
			}
		}
	}
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}

// wikiDocEndOnlyParagraphs are the paragraphs that mark only their last sentence while an earlier one states
// a fact (it carries a fact token): each shown by its first sentence.
func wikiDocEndOnlyParagraphs(body string) []string {
	var out []string
	for _, paragraph := range regexp.MustCompile(`\n\s*\n`).Split(body, -1) {
		paragraph = strings.TrimSpace(paragraph)
		if paragraph == "" || strings.HasPrefix(paragraph, "#") || strings.HasPrefix(paragraph, "```") {
			continue
		}
		joined := strings.Join(strings.Fields(strings.ReplaceAll(paragraph, "\n", " ")), " ")
		sentences := wikiArticleSentences(joined)
		if len(sentences) < 2 {
			continue
		}
		marked := func(s string) bool { return wikiDocIDMarker.MatchString(s) }
		if !marked(sentences[len(sentences)-1]) {
			continue
		}
		for _, sentence := range sentences[:len(sentences)-1] {
			if !marked(sentence) && len(wikiDocFactTokens(sentence)) > 0 {
				out = append(out, cutRunes(strings.TrimSpace(sentences[0]), 80))
				break
			}
		}
	}
	return out
}

var wikiDocFactToken = regexp.MustCompile("`[^`]+`|\\b[A-Za-z_][A-Za-z0-9_./-]*[A-Za-z0-9_]\\b|\\d{2,}|\\d+(?:\\.\\d+)?\\s*(?:秒|分钟|小时|天|个|条|次|%|ms|s|MB|KB)")

// wikiDocFactTokens are a sentence's fact tokens (contract `docs.factTokens`), markers aside.
func wikiDocFactTokens(sentence string) []string {
	sentence = wikiDocIDMarker.ReplaceAllString(sentence, "")
	var out []string
	for _, token := range wikiDocFactToken.FindAllString(sentence, -1) {
		code := strings.HasPrefix(token, "`")
		token = strings.ToLower(strings.Join(strings.Fields(strings.Trim(token, "`")), ""))
		if token == "" {
			continue
		}
		if !code && token[0] >= 'a' && token[0] <= 'z' || !code && token[0] == '_' {
			if len(token) < 3 || contains([]string{"the", "and", "for", "with", "not", "are", "can", "its", "but", "via"}, token) {
				continue
			}
		}
		out = append(out, token)
	}
	return out
}

// wikiDocDispositions is the section's material ledger as the write carries it.
func wikiDocDispositions(pieces []*wikiDocPiece) []wikiDocDisposition {
	out := []wikiDocDisposition{}
	for _, piece := range pieces {
		if len(out) == wikiDocDispositionsMax {
			break
		}
		disposition := wikiDocDisposition{
			Material: piece.id, Kind: piece.kind, Ref: cutRunes(piece.dispositionRef(), 1000), Action: piece.action,
			Reason: cutRunes(strings.TrimSpace(piece.reason), wikiDocReasonMaxChars),
		}
		if disposition.Reason == "" {
			disposition.Reason = "（没有理由）"
		}
		if piece.action == "merge" {
			into := piece.into
			disposition.Into = &into
		}
		out = append(out, disposition)
	}
	return out
}

func wikiDocActionLine(actions map[string]int) string {
	var parts []string
	for _, action := range wikiDocDispositionActions {
		if actions[action] > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", actions[action], action))
		}
	}
	return strings.Join(parts, ", ")
}

// ── The checkout ────────────────────────────────────────────────────────────────────────────────

// wikiDocsCheckout is the checkout the documents are read from: --repo, or the checkout this command runs in.
func wikiDocsCheckout(flagValue string) (string, error) {
	dir, from := strings.TrimSpace(flagValue), "--repo"
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("orbit wiki docs build: there is no working directory to read the repository in: %w", err)
		}
		dir, from = wd, "the working directory"
	}
	abs, err := filepath.Abs(expandTilde(dir))
	if err != nil {
		return "", fmt.Errorf("orbit wiki docs build: %s (%s): %w", dir, from, err)
	}
	out, code, stderr, err := wikiAnchorGit(abs, wikiAnchorGitTimeout, "rev-parse", "--show-toplevel")
	if err != nil || code != 0 {
		return "", fmt.Errorf("orbit wiki docs build: %s (%s) is not a git checkout of the space's repository, so nothing was "+
			"read or written: %s", abs, from, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	return strings.TrimSpace(string(out)), nil
}

// fetchWikiDocsRef fetches origin's main and answers the commit origin/main names after it: every
// repository piece of the run is read, and every repository quote checked, at that one commit.
func fetchWikiDocsRef(repo string) (string, error) {
	if _, code, stderr, err := wikiAnchorGit(repo, wikiAnchorFetchTimeout, "fetch", "--quiet", "--no-tags", "origin", wikiAnchorsVerifyRefspec); err != nil || code != 0 {
		return "", fmt.Errorf("orbit wiki docs build: git fetch origin main failed in %s, so nothing was written — a document "+
			"read from an origin/main that was not just fetched says nothing about main: %s", repo, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	out, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}")
	ref := strings.TrimSpace(string(out))
	if err != nil || code != 0 || !wikiCommitSha.MatchString(ref) {
		return "", fmt.Errorf("orbit wiki docs build: origin/main names no commit in %s after the fetch: %s",
			repo, firstNonEmpty(strings.TrimSpace(stderr), errString(err), ref))
	}
	return ref, nil
}

// ── Errors, in words ────────────────────────────────────────────────────────────────────────────

func wikiDocsBuildCallError(spaceID string, err error) error {
	const command = "orbit wiki docs build"
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("%s: %w", command, err)
	}
	code := httpErr.code()
	switch {
	case wikiDisabledByServer(err):
		return wikiCallError(command, err)
	case code == wikiNotMaintenanceSessionCode:
		return fmt.Errorf("%s: only a Wiki maintenance run of space %s writes its documents — a session whose task is in the "+
			"space's hidden «Wiki maintenance» list — and this session is not one (%s). Nothing was read or written", command, spaceID, code)
	case code == wikiPlanUnconfirmedCode:
		return fmt.Errorf("%s: space %s has no plan its owner confirmed (%s), so no document is written", command, spaceID, code)
	case code == wikiPlanStaleCode:
		return fmt.Errorf("%s: the plan changed while the documents were written (%s): nothing more was written, and the next "+
			"run writes them from the plan in force", command, code)
	case code != "":
		return fmt.Errorf("%s: %w", command, err)
	case httpErr.statusCode == http.StatusForbidden:
		return fmt.Errorf("%s: the Orbit server does not know this session (ORBIT_SESSION_ID) as one this runner hosts, so it "+
			"answered 403 and nothing was read or written. Run it from inside the maintenance session", command)
	case wikiMaintenanceDoorMissing(err):
		return fmt.Errorf("%s: this Orbit server has no documents door yet (it answered 404 for %s /api%s): it predates the "+
			"documents, so nothing was read or written. Upgrade the Orbit server", command, httpErr.method, strings.SplitN(httpErr.path, "?", 2)[0])
	case httpErr.statusCode == http.StatusNotFound:
		return fmt.Errorf("%s: this account has no wiki space %s, or its plan no such document or section (the server "+
			"answered 404, which is its answer for another account's space too), so nothing was written", command, spaceID)
	}
	return fmt.Errorf("%s: %w", command, err)
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func cliWikiDocsBuild(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki docs build")
	space := fs.String("space", "", "the space this maintenance run maintains")
	doc := fs.String("doc", "", "only this document of the confirmed plan")
	section := fs.String("section", "", "only this section of --doc")
	repo := fs.String("repo", "", "the checkout of the space's repository")
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
	slug, key := strings.TrimSpace(*doc), strings.TrimSpace(*section)
	if slug != "" && !wikiSlugPattern.MatchString(slug) {
		return fmt.Errorf("--doc must be a document's slug in the plan: lowercase letters and digits joined by hyphens, like session-runtime")
	}
	if key != "" && slug == "" {
		return fmt.Errorf("--section names a section of the document --doc names: pass --doc too")
	}
	if key != "" && !wikiSlugPattern.MatchString(key) {
		return fmt.Errorf("--section must be a section's key in the plan: lowercase letters and digits joined by hyphens, like s3")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	opts := wikiDocsBuildOptions{spaceID: spaceID, doc: slug, section: key, repo: *repo, model: *model}
	job, err := wikiDocsBuildJobOf(t, ctx.sessionID, spaceID)
	if wikiServerExecutes(err) {
		// The server runs this account's wiki (contract `docs.build.server`): the plan job routes refuse this session
		// too — a build task made before the switch included — so it asks no model and writes nothing.
		return printWikiDocsBuildSummary(out, *jsonOut, wikiDocsBuildSummary{SpaceID: spaceID, Docs: []wikiDocsBuildDocRun{}, ServerExecutes: true}, nil)
	}
	if err != nil {
		return err
	}
	if job != nil {
		if slug != "" {
			return fmt.Errorf("orbit wiki docs build: this session runs build job %s, which writes every document of the confirmed "+
				"plan: --doc and --section are a maintenance run's, not a build's", job.ID)
		}
		fmt.Fprintf(progress, "Build job %s: the documents of the confirmed plan (version %d when it was asked for).\n", job.ID, derefInt(job.Version))
		opts.onDoc = func(done, total int, doc *wikiDocsPlanDoc) {
			body := map[string]interface{}{"docs": map[string]int{"done": done, "total": total}, "current": nil}
			if doc != nil {
				body["current"] = map[string]string{"slug": doc.Slug, "title": doc.Title}
			}
			if _, err := t.progressWikiPlanJob(ctx.sessionID, spaceID, body); err != nil {
				fmt.Fprintf(progress, "The server did not take the build's progress (%v); the build goes on.\n", err)
			}
		}
	}
	summary, runErr := runWikiDocsBuild(t, ctx.sessionID, opts, progress)
	if job != nil {
		jobErr := runErr
		if summary.ServerExecutes && jobErr == nil {
			// A build task made before the switch gave the account to the server: this session writes none of it,
			// and its job ends saying why.
			jobErr = fmt.Errorf("%s: the Orbit server builds this account's documents with the deployment's System model, so "+
				"this session wrote none — the owner's next confirmation of a plan asks the server for them", wikiServerExecutesCode)
		}
		end, finishErr := finishWikiDocsBuildJob(t, ctx.sessionID, spaceID, *job, summary, jobErr)
		// The switch gave the account to the server while this ran: the job's end is refused like every other route,
		// so nothing was said of it here, and the job ends with its task.
		if refused := summary.ServerExecutes && wikiServerExecutes(finishErr); !refused {
			summary.Job = &end
			if finishErr != nil && runErr == nil {
				runErr = finishErr
			}
		}
	}
	return printWikiDocsBuildSummary(out, *jsonOut, summary, runErr)
}

// printWikiDocsBuildSummary says how the run went — compact JSON with --json — and answers the command's error:
// the run's own, else none for a run the server answered WIKI_SERVER_EXECUTES, else whether a section it took up
// was left unwritten.
func printWikiDocsBuildSummary(out io.Writer, asJSON bool, summary wikiDocsBuildSummary, runErr error) error {
	if asJSON {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiDocsBuildSummary(summary))
	}
	if runErr != nil {
		return runErr
	}
	if summary.ServerExecutes {
		return nil
	}
	if summary.Failed > 0 {
		return fmt.Errorf("%s left unwritten: the next run tries again", wikiCount(summary.Failed, "section was", "sections were"))
	}
	return nil
}

// wikiDocsBuildJobOf is the build job the calling session runs (contract `plan.jobs.run.build`), read — and
// recorded as started — through GET …/plan/job; nil for a session whose task was made for no job, or for
// another kind of job, and for a server that has no plan jobs.
func wikiDocsBuildJobOf(t *Transport, sessionID, spaceID string) (*wikiPlanJobRead, error) {
	raw, err := t.wikiPlanJobContext(sessionID, spaceID)
	if err != nil {
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && (httpErr.code() == wikiPlanNoJobCode || wikiMaintenanceDoorMissing(err)) {
			return nil, nil
		}
		return nil, wikiDocsBuildCallError(spaceID, err)
	}
	var context wikiPlanJobContextRead
	if err := json.Unmarshal(raw, &context); err != nil {
		return nil, fmt.Errorf("orbit wiki docs build: the server's plan job is not the shape this build reads: %w", err)
	}
	if context.Job.Kind != "build" {
		return nil, nil
	}
	return &context.Job, nil
}

// finishWikiDocsBuildJob tells the server how the build job ended (contract `plan.jobs.finish`): succeeded,
// with the confirmed version it wrote and its report, when no section it took up was left unwritten; failed,
// with why, otherwise.
func finishWikiDocsBuildJob(t *Transport, sessionID, spaceID string, job wikiPlanJobRead, summary wikiDocsBuildSummary, runErr error) (wikiDocsBuildJobEnd, error) {
	version := summary.PlanVersion
	if version == 0 {
		version = derefInt(job.Version)
	}
	end := wikiDocsBuildJobEnd{ID: job.ID, Version: version, Outcome: "succeeded"}
	switch {
	case runErr != nil:
		end.Outcome, end.Error = "failed", runErr.Error()
	case summary.Failed > 0:
		end.Outcome, end.Error = "failed", wikiCount(summary.Failed, "section was", "sections were")+" left unwritten"
	}
	written := 0
	for _, doc := range summary.Docs {
		complete := len(doc.Sections) > 0
		for _, section := range doc.Sections {
			complete = complete && section.Outcome != "failed"
		}
		if complete {
			written++
		}
	}
	report := map[string]interface{}{
		"planVersion": version,
		"repoSha":     summary.RepoSha,
		"docs":        map[string]int{"total": len(summary.Docs), "written": written},
		"sections":    map[string]int{"written": summary.Written, "unchanged": summary.Unchanged, "failed": summary.Failed},
		"tokens":      map[string]int{"input": summary.Usage.InputTokens, "output": summary.Usage.OutputTokens, "calls": summary.Calls},
		"seconds":     int(summary.Seconds),
		"model":       nil,
	}
	if summary.Model != "" {
		report["model"] = summary.Model
	}
	body := map[string]interface{}{"outcome": end.Outcome, "report": report}
	if version > 0 {
		body["version"] = version
	}
	if end.Error != "" {
		body["error"] = cutRunes(end.Error, 2000)
	}
	if _, err := t.finishWikiPlanJob(sessionID, spaceID, body); err != nil {
		return end, fmt.Errorf("orbit wiki docs build: the build ended %s, and the server could not be told: %w", end.Outcome, wikiDocsBuildCallError(spaceID, err))
	}
	return end, nil
}

func derefInt(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

func describeWikiDocsBuildSummary(s wikiDocsBuildSummary) string {
	if s.ServerExecutes {
		line := fmt.Sprintf("The Orbit server builds the documents of space %s (%s): its wiki worker builds them when the owner "+
			"confirms a plan, with the deployment's System model. Nothing was asked of this session's model.", s.SpaceID, wikiServerExecutesCode)
		if s.Job != nil {
			line += fmt.Sprintf(" Build job %s ended %s (version %d).", s.Job.ID, s.Job.Outcome, s.Job.Version)
		}
		return line
	}
	sections := s.Written + s.Unchanged + s.Failed
	if sections == 0 {
		line := fmt.Sprintf("Space %s: no section of the confirmed plan (version %d) was taken up.", s.SpaceID, s.PlanVersion)
		if s.Stopped != "" {
			line += " Stopped: " + s.Stopped
		}
		if s.Job != nil {
			line += fmt.Sprintf(" Build job %s ended %s (version %d).", s.Job.ID, s.Job.Outcome, s.Job.Version)
		}
		return line
	}
	line := fmt.Sprintf("Space %s, plan version %d, repository at %s: %s written, %s unchanged, %s failed", s.SpaceID,
		s.PlanVersion, shortWikiHash(s.RepoSha), wikiCount(s.Written, "section", "sections"), wikiCount(s.Unchanged, "section", "sections"),
		wikiCount(s.Failed, "section", "sections"))
	if s.Calls > 0 {
		line += fmt.Sprintf("; %d model calls to %s, %d tokens in and %d out, %.0fs", s.Calls, s.Model, s.Usage.InputTokens, s.Usage.OutputTokens, s.Seconds)
	}
	line += "."
	for _, doc := range s.Docs {
		if doc.Status != "" {
			line += fmt.Sprintf(" %s: %s", doc.Slug, doc.Status)
			if n := doc.Counts["sentences"]; n > 0 {
				line += fmt.Sprintf(" (%d of %d sentences sourced)", doc.Counts["sourced"], n)
			}
			line += "."
		}
	}
	if s.Stopped != "" {
		line += " Stopped: " + s.Stopped
	}
	if s.Job != nil {
		line += fmt.Sprintf(" Build job %s ended %s (version %d).", s.Job.ID, s.Job.Outcome, s.Job.Version)
	}
	return line
}
