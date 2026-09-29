package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// `orbit wiki plan draft` and `orbit wiki plan revise`: a space's plan job, run (contracts/wiki.contract.json
// `plan.jobs.run`, criterion 11).
//
// THE MODEL DRAFTS, THE GATE DECIDES. The local model writes the plan in four small steps — the
// catalogue's skeleton, each category's documents in detail, each document's outline with where every
// section's material comes from, and a draft of the rules — or, for a revision, the new catalogue with
// what each document is made from, and the documents that merge or are new. Everything it says is then
// held to a gate this runner runs before the server's: every field is one the plan has, the count is the
// target's, a protected document is carried as it is, a section moves out only if it is a convention,
// and every file, docs section, symbol, project, topic and `→ 3.2` it names is there. What either gate
// finds goes back to the model, unit by unit — the documents that failed, or the catalogue — and the
// draft is gated again: three rounds at most. Only a draft both gates let through is stored.
//
// THE SAMPLE'S LESSONS, IN CODE. One call a unit and a compact line format (a whole catalogue in one call
// ran into an hour's timeout); every answer streamed to disk and kept, so a rerun of the same job reuses
// what was written; symbols and headings checked against the tree (0.7% of the sample's 5,600 references
// were not there); protected documents and moved sections checked, since a revision moved sections out of
// protected documents; the count held to its target (a revision asked for 30 stopped at 40); and the
// numbers of documents in the text resolved against the catalogue they were written for, so a `见 3.3`
// that now points at a merged-away document is caught rather than kept.

// ── What the runner door answers ────────────────────────────────────────────────────────────────

type wikiPlanJobRead struct {
	ID           string  `json:"id"`
	SpaceID      string  `json:"spaceId"`
	Kind         string  `json:"kind"`
	Trigger      string  `json:"trigger"`
	State        string  `json:"state"`
	Instructions *string `json:"instructions"`
	TaskID       *string `json:"taskId"`
	Provider     *string `json:"provider"`
	SessionID    *string `json:"sessionId"`
	Attempt      *int    `json:"attempt"`
	AttemptsMax  int     `json:"attemptsMax"`
	Version      *int    `json:"version"`
}

// wikiPlanJobContextRead is `GET /api/runner/wiki/spaces/:id/plan/job`.
type wikiPlanJobContextRead struct {
	Job   wikiPlanJobRead `json:"job"`
	Space struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Repo  struct {
			URLNorm       string `json:"urlNorm"`
			RootCommitSha string `json:"rootCommitSha"`
		} `json:"repo"`
		Workspace *struct {
			ID      string `json:"id"`
			WorkDir string `json:"workDir"`
		} `json:"workspace"`
	} `json:"space"`
}

// wikiPlanVersionRead is one version as the plan's read gives it.
type wikiPlanVersionRead struct {
	Version    int                `json:"version"`
	Status     string             `json:"status"`
	Target     wikiPlanLength     `json:"target"`
	Categories []wikiPlanCategory `json:"categories"`
	NewFields  []wikiPlanNewField `json:"newFields"`
	Docs       []wikiPlanDocRead  `json:"docs"`
}

type wikiPlanDocRead struct {
	Category  string                 `json:"category"`
	Slug      string                 `json:"slug"`
	Title     string                 `json:"title"`
	Question  string                 `json:"question"`
	Audience  []string               `json:"audience"`
	ScopeIn   []string               `json:"scopeIn"`
	ScopeOut  []wikiPlanScopeOut     `json:"scopeOut"`
	Length    wikiPlanLength         `json:"length"`
	Protected bool                   `json:"protected"`
	Extra     map[string]interface{} `json:"extra"`
	Sections  []struct {
		Key     string                 `json:"key"`
		Title   string                 `json:"title"`
		Kind    string                 `json:"kind"`
		Covers  string                 `json:"covers"`
		Length  int                    `json:"length"`
		Extra   map[string]interface{} `json:"extra"`
		Sources struct {
			Docs      []wikiPlanDocSource      `json:"docs"`
			Code      []wikiPlanCodeSource     `json:"code"`
			Contracts []wikiPlanContractSource `json:"contracts"`
			Sessions  *struct {
				Projects []struct {
					ID    string  `json:"id"`
					Title *string `json:"title"`
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
	} `json:"sections"`
}

type wikiPlanStateRead struct {
	Confirmed *wikiPlanVersionRead `json:"confirmed"`
	Draft     *wikiPlanVersionRead `json:"draft"`
}

// wikiPlanDocInput is a document of a version as a draft carries it: every field as it was, a session
// condition's projects by their ids, and its sections' keys.
func wikiPlanDocInput(read wikiPlanDocRead) wikiPlanDoc {
	doc := wikiPlanDoc{
		Category: read.Category, Slug: read.Slug, Title: read.Title, Question: read.Question,
		Audience: append([]string{}, read.Audience...), ScopeIn: append([]string{}, read.ScopeIn...),
		ScopeOut: append([]wikiPlanScopeOut{}, read.ScopeOut...), Length: read.Length, Protected: read.Protected,
	}
	if len(read.Extra) > 0 {
		doc.Extra = read.Extra
	}
	for _, s := range read.Sections {
		section := wikiPlanSection{Key: s.Key, Title: s.Title, Kind: s.Kind, Covers: s.Covers, Length: s.Length}
		if len(s.Extra) > 0 {
			section.Extra = s.Extra
		}
		section.Sources.Docs = append([]wikiPlanDocSource{}, s.Sources.Docs...)
		section.Sources.Code = append([]wikiPlanCodeSource{}, s.Sources.Code...)
		section.Sources.Contracts = append([]wikiPlanContractSource{}, s.Sources.Contracts...)
		if c := s.Sources.Sessions; c != nil {
			sessions := &wikiPlanSessions{Since: c.Since, Until: c.Until, Keywords: c.Keywords, AnchorPaths: c.AnchorPaths,
				EntryKinds: c.EntryKinds, Topics: c.Topics, Evidence: c.Evidence}
			for _, p := range c.Projects {
				sessions.Projects = append(sessions.Projects, p.ID)
			}
			section.Sources.Sessions = sessions
		}
		doc.Sections = append(doc.Sections, section)
	}
	return doc
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiPlanOptions are the command's flags.
type wikiPlanOptions struct {
	kind         string // draft | revise
	target       *wikiPlanLength
	model        string
	concurrency  int
	workDir      string
	instructions string
}

// wikiPlanAttemptReport is one gate round: what the runner's own gate found, and the server's, by check.
type wikiPlanAttemptReport struct {
	Attempt int            `json:"attempt"`
	Local   int            `json:"local"`
	Server  int            `json:"server"`
	Checks  map[string]int `json:"checks"`
}

// wikiPlanReport is contracts/wiki.contract.json `plan.jobs.report`.
type wikiPlanReport struct {
	Categories int                     `json:"categories"`
	Docs       int                     `json:"docs"`
	Sections   int                     `json:"sections"`
	Target     wikiPlanLength          `json:"target"`
	Attempts   []wikiPlanAttemptReport `json:"attempts"`
	Repo       *struct {
		Sha     string `json:"sha"`
		Checked int    `json:"checked"`
		Missing int    `json:"missing"`
	} `json:"repo"`
	Tokens struct {
		Input  int `json:"input"`
		Output int `json:"output"`
		Calls  int `json:"calls"`
	} `json:"tokens"`
	Seconds    int    `json:"seconds"`
	Model      string `json:"model"`
	RulesDraft string `json:"rulesDraft,omitempty"`
}

// wikiPlanSummary is what the command prints, and what --json writes.
type wikiPlanSummary struct {
	SpaceID string              `json:"spaceId"`
	JobID   string              `json:"jobId,omitempty"`
	Kind    string              `json:"kind"`
	Outcome string              `json:"outcome"`
	Version *int                `json:"version,omitempty"`
	Error   string              `json:"error,omitempty"`
	Errors  []wikiPlanGateError `json:"errors,omitempty"`
	Report  wikiPlanReport      `json:"report"`
	WorkDir string              `json:"workDir,omitempty"`
}

// wikiPlanRun is one run's state: the job, what it drafts from, the draft being written, and what it spent.
type wikiPlanRun struct {
	t         *Transport
	sessionID string
	spaceID   string
	opts      wikiPlanOptions
	progress  io.Writer
	started   time.Time

	job          wikiPlanJobContextRead
	base         *wikiPlanVersionRead
	baseIDs      map[string]string // the version revised: number → slug
	baseDocs     map[string]wikiPlanDocRead
	target       wikiPlanLength
	instructions string
	repo         *wikiPlanRepo
	online       wikiPlanMaterialsRead
	cfg          wikiVerifyConfig
	claude       string
	work         string
	fresh        bool

	mu    sync.Mutex
	usage wikiModelUsage
	calls int
	stop  error

	cats       []wikiPlanCat
	units      []*wikiPlanUnit
	moves      []wikiPlanMove
	rules      string
	report     wikiPlanReport
	lastErrors []wikiPlanGateError
	lastDraft  *wikiPlanDraft
}

func (r *wikiPlanRun) say(format string, args ...interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fmt.Fprintf(r.progress, format+"\n", args...)
}

// runWikiPlan is the whole run. Once the job is read, whatever ends the run, the server hears how.
func runWikiPlan(t *Transport, sessionID, spaceID string, opts wikiPlanOptions, progress io.Writer) (wikiPlanSummary, error) {
	r := &wikiPlanRun{t: t, sessionID: sessionID, spaceID: spaceID, opts: opts, progress: progress, started: time.Now()}
	summary := wikiPlanSummary{SpaceID: spaceID, Kind: opts.kind, Outcome: "failed"}
	raw, err := t.wikiPlanJobContext(sessionID, spaceID)
	if err != nil {
		return summary, wikiPlanCallError("orbit wiki plan "+opts.kind, spaceID, err)
	}
	if err := json.Unmarshal(raw, &r.job); err != nil {
		return summary, fmt.Errorf("orbit wiki plan %s: the server's job is not the shape this build reads: %w", opts.kind, err)
	}
	summary.JobID = r.job.Job.ID
	if r.job.Job.State != "running" {
		return summary, fmt.Errorf("orbit wiki plan %s: this session's plan job is %s, not running: a job runs once, and "+
			"a new draft is asked for by the space's owner", opts.kind, r.job.Job.State)
	}
	version, stop := r.steps()
	r.report.Seconds = int(time.Since(r.started).Seconds())
	r.report.Tokens.Input, r.report.Tokens.Output, r.report.Tokens.Calls = r.usage.InputTokens, r.usage.OutputTokens, r.calls
	r.report.Model = r.cfg.model
	r.report.Target = r.target
	if r.rules != "" {
		r.report.RulesDraft = cutRunes(r.rules, 6000)
	}
	summary.Report = r.report
	summary.WorkDir = r.work
	finish := map[string]interface{}{"report": r.report, "attempt": len(r.report.Attempts)}
	if len(r.report.Attempts) == 0 {
		delete(finish, "attempt")
	}
	if stop == nil {
		finish["outcome"] = "succeeded"
		finish["version"] = version
		summary.Outcome, summary.Version = "succeeded", &version
	} else {
		finish["outcome"] = "failed"
		finish["error"] = cutRunes(stop.Error(), 2000)
		summary.Error = stop.Error()
		if len(r.lastErrors) > 0 {
			errs := r.lastErrors
			if len(errs) > wikiPlanErrorsMax {
				errs = errs[:wikiPlanErrorsMax]
			}
			finish["errors"] = errs
			summary.Errors = errs
		}
		if r.lastDraft != nil {
			if body, err := json.Marshal(r.lastDraft); err == nil && len(body) <= wikiPlanDraftMaxBytes {
				finish["draft"] = r.lastDraft
			}
		}
	}
	if _, err := t.finishWikiPlanJob(sessionID, spaceID, finish); err != nil {
		call := wikiPlanCallError("orbit wiki plan "+opts.kind, spaceID, err)
		if stop != nil {
			return summary, fmt.Errorf("orbit wiki plan %s failed (%v), and the server could not be told: %v", opts.kind, stop, call)
		}
		return summary, fmt.Errorf("orbit wiki plan %s stored version %d, and the server could not be told the job ended: %w", opts.kind, version, call)
	}
	if stop != nil {
		return summary, fmt.Errorf("orbit wiki plan %s: %w", opts.kind, stop)
	}
	return summary, nil
}

// The contract's numbers this side holds a run to (`plan.jobs.rules`, `plan.rules.errorsMax`).
const (
	wikiPlanAttemptsMax   = 3
	wikiPlanErrorsMax     = 200
	wikiPlanDraftMaxBytes = 1_000_000
)

// steps runs the job and answers the version it stored, or why it did not.
func (r *wikiPlanRun) steps() (int, error) {
	if err := r.readPlan(); err != nil {
		return 0, err
	}
	if err := r.checkout(); err != nil {
		return 0, err
	}
	if err := r.readMaterials(); err != nil {
		return 0, err
	}
	if err := r.model(); err != nil {
		return 0, err
	}
	if err := r.workDir(); err != nil {
		return 0, err
	}
	var assembled wikiPlanAssembled
	for attempt := 1; attempt <= wikiPlanAttemptsMax; attempt++ {
		if _, err := r.t.progressWikiPlanJob(r.sessionID, r.spaceID, map[string]interface{}{"attempt": attempt}); err != nil {
			return 0, wikiPlanCallError("orbit wiki plan "+r.opts.kind, r.spaceID, err)
		}
		r.say("Attempt %d of %d.", attempt, wikiPlanAttemptsMax)
		var err error
		if attempt == 1 {
			err = r.firstDraft()
		} else {
			err = r.redo(attempt, r.lastErrors, assembled)
		}
		if err != nil {
			return 0, err
		}
		assembled = r.assemble()
		r.lastDraft = &assembled.plan
		r.saveJSON(fmt.Sprintf("a%d/draft.json", attempt), assembled.plan)
		round := wikiPlanAttemptReport{Attempt: attempt, Local: len(assembled.errors), Checks: map[string]int{}}
		r.report.Categories, r.report.Docs, r.report.Sections = len(assembled.plan.Categories), len(assembled.plan.Docs), assembled.sections
		r.report.Repo = &struct {
			Sha     string `json:"sha"`
			Checked int    `json:"checked"`
			Missing int    `json:"missing"`
		}{assembled.repo.Sha, assembled.repo.Checked, len(assembled.repo.Missing)}
		if len(assembled.errors) > 0 {
			for _, e := range assembled.errors {
				round.Checks[e.Check]++
			}
			r.report.Attempts = append(r.report.Attempts, round)
			r.lastErrors = assembled.errors
			r.saveJSON(fmt.Sprintf("a%d/errors.json", attempt), assembled.errors)
			r.say("Attempt %d: this runner's gate found %s (%s); handing them back to the model.", attempt,
				wikiCount(len(assembled.errors), "error", "errors"), wikiPlanChecksLine(round.Checks))
			continue
		}
		version, refused, err := r.submit(assembled)
		if err != nil {
			return 0, err
		}
		if refused == nil {
			r.report.Attempts = append(r.report.Attempts, round)
			r.say("Attempt %d: both gates let the draft through; it is version %d.", attempt, version)
			return version, nil
		}
		round.Server = len(refused)
		for _, e := range refused {
			round.Checks[e.Check]++
		}
		r.report.Attempts = append(r.report.Attempts, round)
		r.lastErrors = refused
		r.saveJSON(fmt.Sprintf("a%d/errors.json", attempt), refused)
		r.say("Attempt %d: the server's gate refused it with %s (%s); handing them back to the model.", attempt,
			wikiCount(len(refused), "error", "errors"), wikiPlanChecksLine(round.Checks))
	}
	return 0, fmt.Errorf("the draft did not pass the plan's gate in %d rounds: %s on the last, the first of them: %s",
		wikiPlanAttemptsMax, wikiCount(len(r.lastErrors), "error", "errors"), wikiPlanErrorLine(r.lastErrors[0]))
}

func wikiPlanChecksLine(checks map[string]int) string {
	names := make([]string, 0, len(checks))
	for name := range checks {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s %d", name, checks[name]))
	}
	return strings.Join(parts, ", ")
}

func wikiPlanErrorLine(e wikiPlanGateError) string {
	return fmt.Sprintf("[%s] %s: %s", e.Check, e.Path, e.Message)
}

// readPlan is the version the draft revises — the space's draft when it has one, else its confirmed
// version — the target the draft is held to, and a revision's instructions.
func (r *wikiPlanRun) readPlan() error {
	raw, err := r.t.wikiPlanState(r.sessionID, r.spaceID)
	if err != nil {
		return wikiPlanCallError("orbit wiki plan "+r.opts.kind, r.spaceID, err)
	}
	var state wikiPlanStateRead
	if err := json.Unmarshal(raw, &state); err != nil {
		return fmt.Errorf("the server's plan is not the shape this build reads: %w", err)
	}
	r.base = state.Draft
	if r.base == nil {
		r.base = state.Confirmed
	}
	r.target = wikiPlanLength{Min: wikiPlanDocsMin, Max: wikiPlanDocsMax}
	if r.base != nil && r.base.Target.Min > 0 {
		r.target = r.base.Target
	}
	if r.opts.target != nil {
		r.target = *r.opts.target
	}
	r.baseIDs, r.baseDocs = map[string]string{}, map[string]wikiPlanDocRead{}
	if r.base != nil {
		for c, cat := range r.base.Categories {
			n := 0
			for _, doc := range r.base.Docs {
				if doc.Category == cat.Key {
					n++
					id := fmt.Sprintf("%d.%d", c+1, n)
					r.baseIDs[id] = doc.Slug
					r.baseDocs[doc.Slug] = doc
				}
			}
		}
		r.say("The plan stands at version %d (%s): %d documents; the draft is held to %d–%d.", r.base.Version, r.base.Status, len(r.base.Docs), r.target.Min, r.target.Max)
	} else {
		r.say("The space has no plan yet; the draft is held to %d–%d documents.", r.target.Min, r.target.Max)
	}
	r.instructions = strings.TrimSpace(r.opts.instructions)
	if r.opts.kind == "revise" && r.instructions == "" && r.job.Job.Instructions != nil {
		r.instructions = strings.TrimSpace(*r.job.Job.Instructions)
	}
	if r.opts.kind == "revise" && r.instructions == "" {
		return errors.New("a revision needs the owner's instructions: pass --instructions <file>, or run it as the plan job the owner's redraft made, which carries them")
	}
	return nil
}

// checkout is the maintenance workspace's work directory, fetched, and held to the space's repository.
func (r *wikiPlanRun) checkout() error {
	workspace := r.job.Space.Workspace
	if workspace == nil || strings.TrimSpace(workspace.WorkDir) == "" {
		return errors.New("the space's maintenance workspace has no work directory: the draft has no checkout to read the " +
			"repository from; give the workspace one in its settings")
	}
	dir := wikiMaintainExpand(strings.TrimSpace(workspace.WorkDir))
	root, err := wikiImportGit(dir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return fmt.Errorf("the maintenance workspace's work directory %s is not a git checkout", dir)
	}
	ref, err := fetchWikiAnchorsRef(root)
	if err != nil {
		return err
	}
	if want := strings.TrimSpace(r.job.Space.Repo.URLNorm); want != "" {
		origin, _ := wikiImportGit(root, "remote", "get-url", "origin")
		if got := normalizeWikiRepoURL(origin); got != want {
			return fmt.Errorf("the maintenance workspace's checkout %s is a clone of %s, not of the space's repository %s: "+
				"the plan would be drafted from the wrong code", root, firstNonEmpty(got, "no origin"), want)
		}
	}
	if sha := strings.ToLower(strings.TrimSpace(r.job.Space.Repo.RootCommitSha)); sha != "" {
		roots, _ := wikiImportGit(root, "rev-list", "--max-parents=0", ref)
		if !contains(strings.Fields(roots), sha) {
			return fmt.Errorf("the maintenance workspace's checkout %s does not start from the space's first commit %s", root, sha)
		}
	}
	repo, err := loadWikiPlanRepo(root, ref)
	if err != nil {
		return err
	}
	r.repo = repo
	r.say("Checkout %s at origin/main %s: %d files, %d documents, %d source files indexed.", root, shortWikiHash(ref), len(repo.files), len(repo.headings), len(repo.symbols))
	return nil
}

func (r *wikiPlanRun) readMaterials() error {
	raw, err := r.t.wikiPlanMaterials(r.sessionID, r.spaceID)
	if err != nil {
		return wikiPlanCallError("orbit wiki plan "+r.opts.kind, r.spaceID, err)
	}
	if err := json.Unmarshal(raw, &r.online); err != nil {
		return fmt.Errorf("the server's materials are not the shape this build reads: %w", err)
	}
	r.say("Materials: %d projects, %d of %d sessions of the last %d days, %d topics.", len(r.online.Projects),
		len(r.online.Sessions.Items), r.online.Sessions.Total, r.online.Sessions.Days, len(r.online.Topics))
	return nil
}

// model is the clean Claude Code the draft is written with, and its endpoint, waited for.
func (r *wikiPlanRun) model() error {
	cfg := wikiVerifyConfig{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
		token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
		model:   firstNonEmpty(strings.TrimSpace(r.opts.model), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
	}
	switch {
	case cfg.baseURL == "":
		return errors.New("the draft is written with the model this session's provider names, and this session's " +
			"environment names no endpoint (ANTHROPIC_BASE_URL): a plan job is pinned to the local model's provider")
	case cfg.token == "":
		return errors.New("the draft reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is not set in this session")
	case cfg.model == "":
		return errors.New("the draft needs the model to write with: ANTHROPIC_MODEL, which this session's provider names, is not set — pass --model")
	}
	r.cfg = cfg
	claude, err := wikiVerifyClaudePath()
	if err != nil {
		return err
	}
	r.claude = claude
	return wikiPlanWaitForEndpoint(cfg.baseURL, r.progress)
}

// ── The work directory ──────────────────────────────────────────────────────────────────────────

// workDir is where the run keeps every answer, stream and draft: --work-dir, or one a job has on this
// runner (so a rerun of the same job finds what the first one wrote). What it holds is reused only for the
// same job, repository sha, version and instructions.
func (r *wikiPlanRun) workDir() error {
	dir := strings.TrimSpace(r.opts.workDir)
	if dir == "" {
		dir = filepath.Join(machineHome(), "wiki-plan", r.spaceID, firstNonEmpty(r.job.Job.ID, "run"))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("the work directory %s could not be made: %w", dir, err)
	}
	r.work = dir
	baseVersion := 0
	if r.base != nil {
		baseVersion = r.base.Version
	}
	sum := sha256.Sum256([]byte(r.instructions))
	meta := map[string]interface{}{"kind": r.opts.kind, "sha": r.repo.sha, "baseVersion": baseVersion, "job": r.job.Job.ID,
		"target": r.target, "instructions": hex.EncodeToString(sum[:8]), "model": r.cfg.model}
	want, _ := json.Marshal(meta)
	if have, err := os.ReadFile(filepath.Join(dir, "meta.json")); err != nil || string(have) != string(want) {
		for _, old := range []string{"a1", "a2", "a3", "streams", "calls.jsonl"} {
			_ = os.RemoveAll(filepath.Join(dir, old))
		}
		r.fresh = true
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), want, 0o644); err != nil {
			return err
		}
	}
	materials := map[string]string{
		"materials/repo.md":      r.repo.layoutText(0),
		"materials/docs-tree.md": r.repo.docsTreeText(0),
		"materials/contracts.md": r.repo.contractsText(),
		"materials/projects.md":  r.online.projectsText(),
		"materials/sessions.md":  r.online.sessionsText(),
		"materials/space.md":     r.online.spaceText(),
	}
	for name, text := range materials {
		r.saveText(name, text)
	}
	r.say("Work directory %s%s.", dir, map[bool]string{true: "", false: " (reusing what an earlier run of this job wrote)"}[r.fresh])
	return nil
}

func (r *wikiPlanRun) saveText(name, text string) {
	file := filepath.Join(r.work, name)
	_ = os.MkdirAll(filepath.Dir(file), 0o755)
	_ = os.WriteFile(file, []byte(text), 0o644)
}

func (r *wikiPlanRun) saveJSON(name string, value interface{}) {
	if body, err := json.MarshalIndent(value, "", " "); err == nil {
		r.saveText(name, string(body))
	}
}

func (r *wikiPlanRun) readSaved(name string) (string, bool) {
	body, err := os.ReadFile(filepath.Join(r.work, name))
	if err != nil || strings.TrimSpace(string(body)) == "" {
		return "", false
	}
	return string(body), true
}

// ── One call ────────────────────────────────────────────────────────────────────────────────────

// wikiPlanRetryWaits are the pauses before each try of one call; a 401 is never tried again.
var wikiPlanRetryWaits = []time.Duration{0, 10 * time.Second, 30 * time.Second}

// ask is one unit's answer: kept from an earlier run of this job when it wrote one, else one clean call
// (tried again after a failure that is not a 401), streamed into the work directory and kept there.
func (r *wikiPlanRun) ask(attempt int, step, unit, prompt string, parses func(string) bool) (string, error) {
	name := fmt.Sprintf("a%d/%s-%s.md", attempt, step, wikiPlanFileName(unit))
	if saved, ok := r.readSaved(name); ok && (parses == nil || parses(saved)) {
		return saved, nil
	}
	var last error
	for try, wait := range wikiPlanRetryWaits {
		r.mu.Lock()
		stop := r.stop
		r.mu.Unlock()
		if stop != nil {
			return "", stop
		}
		time.Sleep(wait)
		if err := wikiPlanWaitForEndpoint(r.cfg.baseURL, r.progress); err != nil {
			return "", err
		}
		stream := filepath.Join(r.work, "streams", fmt.Sprintf("a%d-%s-%s-%d.jsonl", attempt, step, wikiPlanFileName(unit), try+1))
		ctx, cancel := context.WithTimeout(context.Background(), wikiPlanCallTimeout)
		began := time.Now()
		text, usage, err := askWikiPlanModel(ctx, r.claude, r.cfg, prompt, stream)
		cancel()
		call := wikiPlanCall{Step: step, Unit: unit, Attempt: attempt, Input: usage.InputTokens, Output: usage.OutputTokens,
			Seconds: time.Since(began).Seconds(), OK: err == nil, Stream: stream}
		if err != nil {
			call.Error = cutRunes(err.Error(), 300)
		}
		r.ledger(call)
		var auth *wikiPlanAuthError
		if errors.As(err, &auth) {
			r.mu.Lock()
			if r.stop == nil {
				r.stop = err
			}
			r.mu.Unlock()
			return "", err
		}
		if err == nil && (parses == nil || parses(text)) {
			r.saveText(name, text)
			return text, nil
		}
		if err == nil {
			err = errors.New("the answer does not follow the format it was asked for")
			prompt += "\n\n（注意：严格按上面的输出格式输出，不要别的内容。）"
		}
		last = err
		r.say("%s %s: %v; asking again.", step, unit, err)
	}
	return "", fmt.Errorf("%s %s: %w", step, unit, last)
}

func (r *wikiPlanRun) ledger(call wikiPlanCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.usage.InputTokens += call.Input
	r.usage.OutputTokens += call.Output
	if body, err := json.Marshal(call); err == nil {
		if f, err := os.OpenFile(filepath.Join(r.work, "calls.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = f.Write(append(body, '\n'))
			_ = f.Close()
		}
	}
}

var wikiPlanUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func wikiPlanFileName(unit string) string {
	name := wikiPlanUnsafe.ReplaceAllString(unit, "_")
	if name == "" {
		return "unit"
	}
	return name
}

// parallel runs call for 0..n-1, concurrency at a time, and answers the first error that stops the run.
func (r *wikiPlanRun) parallel(n int, call func(i int) error) error {
	width := r.opts.concurrency
	if width < 1 {
		width = 1
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	next := make(chan int)
	for w := 0; w < width; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				if err := call(i); err != nil {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for i := 0; i < n; i++ {
		next <- i
	}
	close(next)
	wg.Wait()
	return first
}

// ── The first draft ─────────────────────────────────────────────────────────────────────────────

// firstDraft is attempt 1: the four steps of a draft, or a revision's catalogue and rewrites.
func (r *wikiPlanRun) firstDraft() error {
	if r.opts.kind == "revise" && r.base != nil {
		return r.revise(1)
	}
	return r.draft(1)
}

// draft writes the plan in the sample's four steps: the catalogue's skeleton; each category's documents in
// detail; each document's outline and sources, beside the draft of the rules.
func (r *wikiPlanRun) draft(attempt int) error {
	r.say("Step 1 of 4: the catalogue.")
	answer, err := r.ask(attempt, "skeleton", "catalogue", r.fullMaterials()+"\n"+r.skeletonPrompt(), func(text string) bool {
		return parseWikiPlanCatalogue(text) != nil
	})
	if err != nil {
		return err
	}
	catalogue := parseWikiPlanCatalogue(answer)
	r.adoptCatalogue(catalogue, false)
	r.say("The catalogue: %d categories, %d documents.", len(r.cats), len(r.units))
	if err := r.catalogueToTarget(attempt); err != nil {
		return err
	}
	var rulesErr error
	var rulesDone sync.WaitGroup
	rulesDone.Add(1)
	go func() {
		defer rulesDone.Done()
		text, err := r.ask(attempt, "rules", "rules", r.rulesPrompt(), nil)
		if err != nil {
			rulesErr = err
			return
		}
		r.rules = text
	}()
	err = r.writeBodies(attempt, r.units)
	rulesDone.Wait()
	if err != nil {
		return err
	}
	if rulesErr != nil {
		var auth *wikiPlanAuthError
		if errors.As(rulesErr, &auth) {
			return rulesErr
		}
		r.say("Step 4 of 4: the rules draft was not written (%v); the plan does not need it.", rulesErr)
	}
	return nil
}

// wikiPlanCountTries is how many times a draft's catalogue outside the target is written again before any
// document of it is: the gate would refuse the count whole, and every body written for documents that are
// then merged away is paid for twice. A count still outside after them is the gate's to hand back.
const wikiPlanCountTries = 2

// catalogueToTarget sends a draft's catalogue that is outside the target back with the gate's own count
// error, before any document's body is written for it. A revision's is left to the gate: it carries most
// of its documents as they were, so little is written for nothing.
func (r *wikiPlanRun) catalogueToTarget(attempt int) error {
	if r.opts.kind == "revise" && r.base != nil {
		return nil
	}
	for try := 1; try <= wikiPlanCountTries; try++ {
		count, outside := wikiPlanCountError(len(r.units), r.target)
		if !outside {
			return nil
		}
		r.say("The catalogue has %d documents, outside %d–%d: written again before any document of it (%d of %d).",
			len(r.units), r.target.Min, r.target.Max, try, wikiPlanCountTries)
		if err := r.redoCatalogue(attempt, fmt.Sprintf("catalogue-count-%d", try), []wikiPlanGateError{count}, wikiPlanAssembled{}); err != nil {
			return err
		}
		r.say("The catalogue: %d categories, %d documents.", len(r.cats), len(r.units))
	}
	return nil
}

// writeBodies writes the given documents' bodies: their categories' details (step 2), then each one's
// outline (step 3); or, in a revision, each one's rewrite.
func (r *wikiPlanRun) writeBodies(attempt int, units []*wikiPlanUnit) error {
	if len(units) == 0 {
		return nil
	}
	if r.opts.kind == "revise" && r.base != nil {
		return r.rewrite(attempt, units)
	}
	r.say("Step 2 of 4: %s in detail.", wikiCount(len(units), "document", "documents"))
	byCat := map[int][]*wikiPlanUnit{}
	var cats []int
	for _, unit := range units {
		if _, ok := byCat[unit.Cat]; !ok {
			cats = append(cats, unit.Cat)
		}
		byCat[unit.Cat] = append(byCat[unit.Cat], unit)
	}
	catalogue := r.catalogueText()
	prefix := r.detailMaterials() + "\n# 文档目录\n" + catalogue + "\n"
	if err := r.parallel(len(cats), func(i int) error {
		c := cats[i]
		var ids []string
		for _, unit := range byCat[c] {
			ids = append(ids, unit.ID)
		}
		answer, err := r.ask(attempt, "details", fmt.Sprintf("%d-%s", c+1, strings.Join(ids, "_")), prefix+r.detailPrompt(c, ids), func(text string) bool {
			return len(parseWikiPlanDetails(text)) > 0
		})
		if err != nil {
			return r.unitFailure(err)
		}
		details := parseWikiPlanDetails(answer)
		for _, unit := range byCat[c] {
			if header, ok := details[unit.ID]; ok {
				unit.Header = header
			}
		}
		return nil
	}); err != nil {
		return err
	}
	r.say("Step 3 of 4: the outlines of %s.", wikiCount(len(units), "document", "documents"))
	refs := r.currentRefs()
	return r.parallel(len(units), func(i int) error {
		unit := units[i]
		answer, err := r.ask(attempt, "outline", unit.Slug, r.docMaterials(unit)+"\n# 文档目录\n"+catalogue+"\n"+r.outlinePrompt(unit), func(text string) bool {
			_, sections, _ := parseWikiPlanDocBody(text)
			return len(sections) > 0
		})
		if err != nil {
			return r.unitFailure(err)
		}
		_, sections, stray := parseWikiPlanDocBody(answer)
		unit.Sections, unit.Stray, unit.HasBody, unit.Refs = sections, stray, true, refs
		return nil
	})
}

// unitFailure is a unit's call that failed for good: a 401 ends the run; anything else leaves the unit
// without what it would have written, which the gate then names, and the next round writes again.
func (r *wikiPlanRun) unitFailure(err error) error {
	var auth *wikiPlanAuthError
	if errors.As(err, &auth) {
		return err
	}
	r.say("%v", err)
	return nil
}

// adoptCatalogue makes a catalogue the draft's: its categories, and its documents — a document of the
// same slug as one already written keeping what was written of it. In a revision, a document of the
// version revised that the catalogue names is carried: a protected one as it is, one made from it alone
// with its outline, less the sections moved out.
func (r *wikiPlanRun) adoptCatalogue(catalogue *wikiPlanCatalogue, revision bool) {
	previous := map[string]*wikiPlanUnit{}
	for _, unit := range r.units {
		previous[unit.Slug] = unit
	}
	// What each document takes in by moves, before and after: a document whose moved sections changed is
	// written again, whatever else stayed.
	incoming := func(moves []wikiPlanMove) map[string]string {
		out := map[string]string{}
		for _, move := range moves {
			if move.Target != nil {
				out[move.Target.Slug] += fmt.Sprintf("%s§%d,", move.From, move.Section)
			}
		}
		return out
	}
	before, after := incoming(r.moves), incoming(catalogue.Moves)
	r.cats = catalogue.Cats
	r.moves = catalogue.Moves
	for i := range r.cats {
		if r.cats[i].Key == "" || !wikiSlugPattern.MatchString(r.cats[i].Key) {
			// A key the model left out or misspelled: the category's number, which the owner never sees.
			if r.cats[i].Key == "" {
				r.cats[i].Key = fmt.Sprintf("c%d", i+1)
			}
		}
	}
	var units []*wikiPlanUnit
	kept := map[*wikiPlanUnit]*wikiPlanUnit{}
	for _, card := range catalogue.Units {
		unit := card
		if old, ok := previous[card.Slug]; ok && sameSources(old.Sources, card.Sources) && before[card.Slug] == after[card.Slug] {
			old.Cat, old.Title, old.Question, old.CardScope, old.Sources = card.Cat, card.Title, card.Question, card.CardScope, card.Sources
			old.Stray = card.Stray
			unit = old
			kept[card] = old
		}
		units = append(units, unit)
	}
	for i := range r.moves {
		if old, ok := kept[r.moves[i].Target]; ok {
			r.moves[i].Target = old
		}
	}
	r.units = units
	r.number()
	receives := map[*wikiPlanUnit]bool{}
	for _, move := range r.moves {
		if move.Target != nil {
			receives[move.Target] = true
		}
	}
	for _, unit := range r.units {
		base, ok := r.baseDocs[unit.Slug]
		if ok && base.Protected {
			doc := wikiPlanDocInput(base)
			unit.Protected, unit.Kept, unit.HasBody = &doc, nil, true
			continue
		}
		unit.Protected = nil
		if !revision || unit.HasBody {
			continue
		}
		unit.Kept, unit.KeptDrop = nil, nil
		if len(unit.Sources) == 1 && !receives[unit] {
			if slug, ok := r.baseIDs[unit.Sources[0]]; ok {
				doc := r.baseDocs[slug]
				unit.Kept, unit.KeptDrop, unit.Refs = &doc, map[int]bool{}, r.baseIDs
				for _, move := range r.moves {
					if move.From == unit.Sources[0] {
						unit.KeptDrop[move.Section] = true
					}
				}
			}
		}
	}
}

func sameSources(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// number gives the documents their numbers in the catalogue: category by category, in order.
func (r *wikiPlanRun) number() {
	counts := map[int]int{}
	sort.SliceStable(r.units, func(i, j int) bool { return r.units[i].Cat < r.units[j].Cat })
	for _, unit := range r.units {
		counts[unit.Cat]++
		unit.ID = fmt.Sprintf("%d.%d", unit.Cat+1, counts[unit.Cat])
	}
}

// currentRefs is the catalogue as it stands, number → slug: what a body written now means by `见 3.2`.
func (r *wikiPlanRun) currentRefs() map[string]string {
	out := map[string]string{}
	for _, unit := range r.units {
		out[unit.ID] = unit.Slug
	}
	return out
}

// ── A revision ──────────────────────────────────────────────────────────────────────────────────

// revise is a revision's first round: the new catalogue, with what each document is made from and the
// sections moved into the agents' category; then the documents that merge or are new, written again.
func (r *wikiPlanRun) revise(attempt int) error {
	r.say("Revising version %d with the owner's instructions: the new catalogue.", r.base.Version)
	answer, err := r.ask(attempt, "revise-catalogue", "catalogue", r.revisionCataloguePrompt(nil, ""), func(text string) bool {
		return parseWikiPlanCatalogue(text) != nil
	})
	if err != nil {
		return err
	}
	r.adoptCatalogue(parseWikiPlanCatalogue(answer), true)
	var rewrite []*wikiPlanUnit
	for _, unit := range r.units {
		if unit.Protected == nil && unit.Kept == nil {
			rewrite = append(rewrite, unit)
		}
	}
	r.say("The new catalogue: %d categories, %d documents; %d carried as they were, %d to write again.", len(r.cats), len(r.units), len(r.units)-len(rewrite), len(rewrite))
	return r.rewrite(attempt, rewrite)
}

// rewrite writes again the documents of a revision that merge, are new, or take moved sections.
func (r *wikiPlanRun) rewrite(attempt int, units []*wikiPlanUnit) error {
	catalogue := r.catalogueText()
	refs := r.currentRefs()
	return r.parallel(len(units), func(i int) error {
		unit := units[i]
		answer, err := r.ask(attempt, "revise-doc", unit.Slug, r.rewritePrompt(unit, catalogue), func(text string) bool {
			_, sections, _ := parseWikiPlanDocBody(text)
			return len(sections) > 0
		})
		if err != nil {
			return r.unitFailure(err)
		}
		header, sections, stray := parseWikiPlanDocBody(answer)
		unit.Header, unit.Sections, unit.Stray, unit.HasBody, unit.Refs, unit.Kept = header, sections, stray, true, refs, nil
		return nil
	})
}

// ── Another round ───────────────────────────────────────────────────────────────────────────────

// redo hands what the gates found back to the model: the catalogue's errors to a catalogue it writes again,
// each document's to that document. A protected document is never written again.
func (r *wikiPlanRun) redo(attempt int, errs []wikiPlanGateError, last wikiPlanAssembled) error {
	byUnit := map[*wikiPlanUnit][]wikiPlanGateError{}
	var catalogue []wikiPlanGateError
	for _, e := range errs {
		if i, ok := wikiPlanDocIndex(e.Path); ok && !wikiPlanCatalogueLevel(e.Path) && i < len(last.units) && last.units[i].Protected == nil {
			byUnit[last.units[i]] = append(byUnit[last.units[i]], e)
			continue
		}
		catalogue = append(catalogue, e)
	}
	if len(catalogue) > 0 {
		r.say("Round %d: the catalogue again, for %s.", attempt, wikiCount(len(catalogue), "error", "errors"))
		if err := r.redoCatalogue(attempt, "catalogue", catalogue, last); err != nil {
			return err
		}
		if err := r.catalogueToTarget(attempt); err != nil {
			return err
		}
	}
	var fix []*wikiPlanUnit
	var write []*wikiPlanUnit
	present := map[*wikiPlanUnit]bool{}
	for _, unit := range r.units {
		present[unit] = true
		if unit.Protected == nil && unit.Kept == nil && !unit.HasBody {
			write = append(write, unit)
		}
	}
	for unit := range byUnit {
		if present[unit] && unit.HasBody || present[unit] && unit.Kept != nil {
			fix = append(fix, unit)
		}
	}
	sort.Slice(fix, func(i, j int) bool { return fix[i].ID < fix[j].ID })
	if len(write) > 0 {
		r.say("Round %d: writing %s the catalogue now has.", attempt, wikiCount(len(write), "document", "documents"))
		if err := r.writeBodies(attempt, write); err != nil {
			return err
		}
	}
	if len(fix) == 0 {
		return nil
	}
	r.say("Round %d: %s written again with their errors.", attempt, wikiCount(len(fix), "document", "documents"))
	catalogueText := r.catalogueText()
	refs := r.currentRefs()
	return r.parallel(len(fix), func(i int) error {
		unit := fix[i]
		prompt := r.docMaterials(unit) + "\n" + r.redoDocPrompt(unit, byUnit[unit], last, catalogueText)
		answer, err := r.ask(attempt, "redo-doc", unit.Slug, prompt, func(text string) bool {
			_, sections, _ := parseWikiPlanDocBody(text)
			return len(sections) > 0
		})
		if err != nil {
			return r.unitFailure(err)
		}
		header, sections, stray := parseWikiPlanDocBody(answer)
		// A line the answer left out is the line as it stood: what was not wrong need not be written again.
		header = wikiPlanMergeHeader(header, last.headerOf(unit))
		unit.Header, unit.Sections, unit.Stray, unit.HasBody, unit.Refs, unit.Kept = header, sections, stray, true, refs, nil
		return nil
	})
}

// headerOf is a document's header as the last round assembled it, in the line format's terms, its
// scope-out targets as the numbers they have now.
func (a wikiPlanAssembled) headerOf(unit *wikiPlanUnit) wikiPlanHeader {
	for i, u := range a.units {
		if u != unit {
			continue
		}
		doc := a.plan.Docs[i]
		h := wikiPlanHeader{Title: doc.Title, Question: doc.Question, Audience: doc.Audience, ScopeIn: doc.ScopeIn}
		for _, out := range doc.ScopeOut {
			var ids []string
			for _, slug := range out.Docs {
				if id, ok := a.slugIDs[slug]; ok {
					ids = append(ids, id)
				}
			}
			text := out.Text
			if len(ids) > 0 {
				text += "（见 " + strings.Join(ids, "、") + "）"
			}
			h.ScopeOut = append(h.ScopeOut, text)
		}
		if doc.Length.Min > 0 {
			h.Length = fmt.Sprintf("%d–%d 字", doc.Length.Min, doc.Length.Max)
		}
		return h
	}
	return wikiPlanHeader{Title: unit.Title, Question: unit.Question, ScopeIn: unit.CardScope}
}

// wikiPlanMergeHeader is a header written again, each field it left out taken from the one before.
func wikiPlanMergeHeader(next, prev wikiPlanHeader) wikiPlanHeader {
	if next.Title == "" {
		next.Title = prev.Title
	}
	if next.Question == "" {
		next.Question = prev.Question
	}
	if len(next.Audience) == 0 {
		next.Audience = prev.Audience
	}
	if len(next.ScopeIn) == 0 {
		next.ScopeIn = prev.ScopeIn
	}
	if len(next.ScopeOut) == 0 {
		next.ScopeOut = prev.ScopeOut
	}
	if next.Length == "" {
		next.Length = prev.Length
	}
	return next
}

// redoCatalogue writes the catalogue again with its errors; its answer is kept as unit's.
func (r *wikiPlanRun) redoCatalogue(attempt int, unit string, errs []wikiPlanGateError, last wikiPlanAssembled) error {
	lines := r.errorLines(errs, last)
	var answer string
	var err error
	parses := func(text string) bool { return parseWikiPlanCatalogue(text) != nil }
	if r.opts.kind == "revise" && r.base != nil {
		answer, err = r.ask(attempt, "revise-catalogue", unit, r.revisionCataloguePrompt(errs, lines), parses)
	} else {
		answer, err = r.ask(attempt, "skeleton", unit, r.fullMaterials()+"\n"+r.catalogueRedoPrompt(lines), parses)
	}
	if err != nil {
		return err
	}
	r.adoptCatalogue(parseWikiPlanCatalogue(answer), r.opts.kind == "revise" && r.base != nil)
	return nil
}

var wikiPlanDocPath = regexp.MustCompile(`^plan\.docs\[(\d+)\]`)

// wikiPlanDocIndex is the document an error's path is in.
func wikiPlanDocIndex(path string) (int, bool) {
	m := wikiPlanDocPath.FindStringSubmatch(path)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	return n, err == nil
}

var wikiPlanSectionPath = regexp.MustCompile(`^plan\.docs\[(\d+)\](?:\.sections\[(\d+)\])?(.*)$`)

// errorLines are errors as the model reads them: which document and section, then what is wrong.
func (r *wikiPlanRun) errorLines(errs []wikiPlanGateError, last wikiPlanAssembled) string {
	var b strings.Builder
	for _, e := range errs {
		where := e.Path
		if m := wikiPlanSectionPath.FindStringSubmatch(e.Path); m != nil {
			i, _ := strconv.Atoi(m[1])
			if i < len(last.plan.Docs) {
				doc := last.plan.Docs[i]
				where = fmt.Sprintf("%s《%s》", last.units[i].ID, doc.Title)
				if m[2] != "" {
					j, _ := strconv.Atoi(m[2])
					if j < len(doc.Sections) {
						where += fmt.Sprintf(" 第 %d 节「%s」", j+1, doc.Sections[j].Title)
					}
				}
				if tail := strings.TrimPrefix(m[3], "."); tail != "" {
					where += " · " + tail
				}
			}
		}
		fmt.Fprintf(&b, "- [%s] %s：%s\n", e.Check, where, e.Message)
	}
	return b.String()
}
