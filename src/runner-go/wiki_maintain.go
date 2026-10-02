package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// `orbit wiki maintain` and `orbit wiki check`: a space's Wiki maintenance run, and the judge of it
// (contracts/wiki.contract.json `maintenance.job`, design §8.2, criterion 3).
//
// A DETERMINISTIC PIPELINE, NOT AN AGENT. The owner's decision of 2026-09-27: the maintenance session does
// not work through the wiki's tools a step at a time (the demo that did cost $350 and wandered). It runs
// this one command, which does the whole run in code — where it starts, the dossiers since the cursor, the
// model's extraction, the checks, the proposals, the verification, the anchors, the articles and the
// cursor — and calls the local model only where a model is needed, each time through its own clean
// Claude Code (wiki_verify.go's launch, allowlist and apiKeyHelper; thinking off). The session's own model
// only starts it and reports what it printed.
//
// THE DOCUMENTS FOLLOW WHAT CHANGED (criterion 3, revision 3). After the anchors the run writes again only
// the sections of the confirmed plan's documents that its facts touched — the entries that fit them, the
// repository material they cite that changed on origin/main — and proposes a change to the plan for what
// fits no section (wiki_maintain_docs.go). The topic articles are no longer written.
//
// THE CURSOR MOVES ONCE THE OPS ARE RECORDED (criterion 3, revision 4). As soon as every batch is recorded,
// the run moves the space's cursor past the sessions its ops came from — to the last page it read, the position
// its task expects and `orbit wiki check` holds it to, or, when the breaker held ops back, to where their pages
// start — before the verification, the anchors and the documents. One of those that fails still ends the run
// `failed` — its consecutive failures go up by one, and the report says where it stopped and that the cursor
// had moved — but the next run does not read those sessions again, nor spend the local model on them twice: a
// space thirteen days behind (2026-10-02) cannot afford a run's work done over. What fails before the ops are
// recorded — any step up to the proposals, a model endpoint that refuses the token, an op the server refuses, a
// run cut short — moves nothing. An op the verification got no verdict for, asked twice, is not a step that
// failed: it is not live, it keeps waiting, and the next run adopts it, as it adopts what any ended session left
// waiting.
//
// A SPACE THAT IS BEHIND WRITES NO DOCUMENT (`maintenance.job.catchUp.docs`). A run its trigger made while the
// space's oldest pending fact was more than a day old skips the documents and the plan proposal: the first run
// after the space has caught up writes again every section the entries and origin/main changed meanwhile.
//
// WHAT THE MODEL SAYS IS CHECKED BEFORE IT IS PROPOSED, and proposed only as the space's maintenance run.
// Each entry is held to its dossier the way the demo's extract.py held it: a known kind with its fields,
// every source a line of the dossier and its quote copied from that line, every anchor something that
// exists on the checkout's origin/main. Then each batch is proposed with dryRun first, so what the server
// would refuse is dropped rather than recorded, and the ops the review mode would apply are held to what
// the dry runs say the run's circuit breaker has left before a single one is written: what does not fit
// is held back, with its dossiers, for the next run.
//
// A QUOTE IS THE RECORD'S OWN WORDS, AT THE PLACE THE LINE NAMES (criterion 2, revision 2). A dossier line
// is the dossier's writing — a tool call as `$ command → ok: first line … last line`, a message cut short —
// and each of its sources says where in the record's text its words are. A quote the model copied from
// those words is proposed as the record's words there, with the place as its locator; a quote that is the
// dossier's own shorthand, or that runs across a gap the dossier cut, cites the record without a quote.

// wikiMaintainPrecondition and wikiCheckPrecondition are contracts/wiki.contract.json
// `maintenance.job.cli.maintainPrecondition` and `checkPrecondition`, word for word; wiki_maintain_test.go
// holds them equal.
const wikiMaintainPrecondition = "Run this only as a Wiki maintenance run of the space, once, and let it finish: it " +
	"proposes as the space's maintenance run, and it moves the cursor only past the sessions whose ops it recorded — " +
	"a run that failed or was cut short before that moves nothing, one that fails after it still ends failed, and one " +
	"whose breaker held ops back stops it where their dossiers start."

const wikiCheckPrecondition = "Judge a maintenance run only by what this reads: it passes when the space's cursor " +
	"reached the position the task expects and the server refused none of the run's ops, and a run cannot pass it by " +
	"saying it finished."

var wikiMaintainDescription = wikiMaintainPrecondition + " This is a Wiki maintenance run, whole: it reads where the " +
	"run starts, fetches the maintenance workspace's checkout (which must be a clone of the space's repository), reads " +
	"the dossiers since the space's cursor up to the position its task expects, has the local model — this session's " +
	"provider's, through a clean Claude Code with thinking off — extract at most " + strconv.Itoa(wikiMaintainEntriesPerSession) +
	" entries from each, checks every entry against its dossier and the checkout, proposes them by topic with dryRun " +
	"first and then as the space's maintenance run — holding back, for the next run, the dossiers whose entries the " +
	"run's circuit breaker has no room for — advances the cursor past the sessions whose ops it recorded, has them " +
	"verified in an automatic space (an op it gets no verdict for, asked twice, is not live and waits for the next run, " +
	"which adopts it; that fails nothing), re-verifies the anchors, and writes again only the sections of the confirmed " +
	"plan's documents that the entries and origin/main's changes touched (proposing a change to the plan for what fits " +
	"no section, writing no document when no plan is confirmed, and none while the space is catching up). It prints " +
	"what it did, the token spend included, and exits non-zero when the run failed. When the Orbit server answers 5xx " +
	"or nothing at all it waits for it, 15 minutes at most, before the run starts and before it reports a run that " +
	"stopped on it, and it says whose a failure was and whether the run may be run again. Any session but a " +
	"maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION."

var wikiCheckDescription = wikiCheckPrecondition + " This is a Wiki maintenance task's acceptance command: it asks the " +
	"server whether --space's cursor is at or past the position --expect-cursor names, and whether the run of the task " +
	"that expects it ended succeeded with no op refused, and exits 0 only when both hold — non-zero otherwise, with " +
	"each reason a sentence. It reads and writes nothing else, and needs no session: a task's acceptance command runs " +
	"in a shell with none."

// The contract's numbers (`maintenance.job.rules`), which wiki_maintain_test.go holds to the JSON.
const (
	wikiMaintainRunSessionsMax     = 20
	wikiMaintainEntriesPerSession  = 6
	wikiMaintainExtractConcurrency = 4
	// The most ops ended sessions left waiting that one run adopts and verifies: the rest wait for the next.
	wikiMaintainAdoptOpsMax = 50
)

const (
	// Dossiers a page carries while the run reads toward its expected position.
	wikiMaintainPageSessions = 5
	// What one changeset may hold (`limits.opsPerChangeset`), and what a Manual space's request may leave
	// waiting for the owner (`limits.opsPerTurn`).
	wikiMaintainOpsPerChangeset = 30
	wikiMaintainOpsPerTurn      = 5
	// The local model sits behind a tunnel that drops: a run waits this long for its /health before it gives up.
	wikiMaintainHealthWait = 3 * time.Minute
	wikiMaintainHealthPoll = 10 * time.Second
	// The longest a run waits for an Orbit server that answers 5xx or nothing at all
	// (`maintenance.job.recovery.rules.serverWaitMinutes`), before it starts and before it reports a run
	// that stopped on it.
	wikiMaintainServerWait = 15 * time.Minute
	// The quote a source carries, at most (`limits.quoteMaxChars`).
	wikiMaintainQuoteMaxChars = 300
	// How much of a repository's README tells the model what the repository is.
	wikiMaintainAboutMaxChars = 300
	// The whole run, as the maintenance session's Bash waits for it (wiki_maintenance_session.go): a
	// maintenance run, or a plan job's draft (wiki_plan_draft.go) — four steps of the local model and up to
	// three gate rounds, which on a shared GPU takes longer than a maintenance run ever has.
	wikiMaintainRunBudget = 5 * time.Hour
)

// wikiMaintainSystemPrompt is the demo's EXTRACT_SYSTEM: the whole system prompt an extraction call carries.
const wikiMaintainSystemPrompt = "You compile durable engineering knowledge from a coding-agent work record into wiki " +
	"entries. You output only a JSON array."

// wikiMaintainKinds are the kinds an extraction may give (the phase-1 kinds): principle among them only so
// it can be counted and set aside, since a principle is the owner's alone.
var wikiMaintainKinds = []string{"principle", "convention", "decision", "pitfall", "recipe", "concept"}

// ── The server's routes ─────────────────────────────────────────────────────────────────────────

// wikiMaintainContext is `GET /api/runner/wiki/spaces/:id/maintenance/run`.
type wikiMaintainContext struct {
	SpaceID string `json:"spaceId"`
	Title   string `json:"title"`
	Repo    struct {
		URLNorm       string `json:"urlNorm"`
		RootCommitSha string `json:"rootCommitSha"`
	} `json:"repo"`
	ReviewMode    string `json:"reviewMode"`
	ActiveEntries int    `json:"activeEntries"`
	Breaker       struct {
		MinActiveEntries  int `json:"minActiveEntries"`
		MaxChangedPercent int `json:"maxChangedPercent"`
	} `json:"breaker"`
	Workspace *struct {
		ID      string `json:"id"`
		WorkDir string `json:"workDir"`
	} `json:"workspace"`
	Topics []struct {
		Slug        string `json:"slug"`
		Title       string `json:"title"`
		Description string `json:"description"`
	} `json:"topics"`
	TaskID      string `json:"taskId"`
	Expect      string `json:"expect"`
	RunSessions int    `json:"runSessions"`
	// CatchUp is how the run was made (`maintenance.job.catchUp`): "active" or "paused" while the space was behind,
	// when the run writes no document and proposes no change to the plan; empty otherwise.
	CatchUp string `json:"catchUp"`
}

func (t *Transport) wikiMaintainRunContext(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/run"
	_, err := t.doWiki(http.MethodGet, path, nil, &out, taskOpTimeout, sessionHeader(sessionID), true)
	return out, err
}

// listWikiDossiersUntil is `orbit wiki dossier`'s page with the run's stop: a page never goes past until.
func (t *Transport) listWikiDossiersUntil(sessionID, spaceID, after, until string, limit int) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	values := url.Values{}
	if after != "" {
		values.Set("after", after)
	}
	if until != "" {
		values.Set("until", until)
	}
	values.Set("limit", strconv.Itoa(limit))
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/dossiers?" + values.Encode()
	_, err := t.doWiki(http.MethodGet, path, nil, &out, wikiDossierPageTimeout, sessionHeader(sessionID), true)
	return out, err
}

// proposeWikiMaintenance is one batch, proposed as the space's maintenance run. A request none of whose
// ops was recorded comes back as a 4xx carrying every op's outcome, as any refused proposal does.
func (t *Transport) proposeWikiMaintenance(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/changesets"
	_, err := t.doWiki(http.MethodPost, path, body, &out, wikiDossierPageTimeout, sessionHeader(sessionID), wikiRecordsOnce(body))
	return out, err
}

// advanceWikiMaintenance moves the space's cursor past the sessions whose ops the run recorded (`POST
// …/maintenance/advance`): the position alone, never the run's health. It may land any number of times — a
// cursor at or past the token moves nothing — so it is sent again through a transient failure.
func (t *Transport) advanceWikiMaintenance(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/advance"
	_, err := t.doWiki(http.MethodPost, path, body, &out, taskOpTimeout, sessionHeader(sessionID), true)
	return out, err
}

// finishWikiMaintenance ends the run: the cursor advanced as `orbit wiki cursor advance` would, and the
// report kept. Only a succeeded run's end is sent again through a transient failure (wikiReportsSuccess).
func (t *Transport) finishWikiMaintenance(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/finish"
	_, err := t.doWiki(http.MethodPost, path, body, &out, taskOpTimeout, sessionHeader(sessionID), wikiReportsSuccess(body))
	return out, err
}

// checkWikiMaintenance asks the check with no session: a task's acceptance command runs with none.
func (t *Transport) checkWikiMaintenance(spaceID, expect string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/check?" + url.Values{"expect": {expect}}.Encode()
	_, err := t.doWiki(http.MethodGet, path, nil, &out, taskOpTimeout, nil, true)
	return out, err
}

// ── What a run reports ──────────────────────────────────────────────────────────────────────────

// wikiMaintainReport is contracts/wiki.contract.json `maintenance.job.report`: what the run did, in counts.
type wikiMaintainReport struct {
	StoppedAt string `json:"stoppedAt,omitempty"`
	Sessions  int    `json:"sessions"`
	Dossiers  int    `json:"dossiers"`
	Unchanged int    `json:"unchanged"`
	OffTopic  int    `json:"offTopic"`
	Entries   struct {
		Extracted  int `json:"extracted"`
		Kept       int `json:"kept"`
		Dropped    int `json:"dropped"`
		Foreign    int `json:"foreign"`
		Principles int `json:"principles"`
	} `json:"entries"`
	Ops struct {
		Proposed         int `json:"proposed"`
		Recorded         int `json:"recorded"`
		Refused          int `json:"refused"`
		SelfCheckDropped int `json:"selfCheckDropped"`
		// HeldBack is what the review queue's quotas held back, HeldBackByBreaker what the run's circuit breaker did.
		HeldBack          int `json:"heldBack"`
		HeldBackByBreaker int `json:"heldBackByBreaker"`
		Applied           int `json:"applied"`
		Waiting           int `json:"waiting"`
	} `json:"ops"`
	Verification *wikiMaintainVerification `json:"verification,omitempty"`
	Anchors      *wikiMaintainAnchors      `json:"anchors,omitempty"`
	Docs         *wikiMaintainDocsReport   `json:"docs,omitempty"`
	Tokens       struct {
		Input  int `json:"input"`
		Output int `json:"output"`
		Calls  int `json:"calls"`
	} `json:"tokens"`
	Seconds int `json:"seconds"`

	// CursorAdvanced is the cursor moved past the sessions whose ops the run recorded, before the steps after the
	// proposals: a step that failed after it failed the run, and the next run does not read those sessions again.
	CursorAdvanced bool `json:"cursorAdvanced,omitempty"`
}

type wikiMaintainVerification struct {
	Verified int `json:"verified"`
	Failed   int `json:"failed"`
	// WaitingForNextRun is every op the run got no verdict for — its own after both passes, and the adopted
	// ones: none is live, each keeps waiting for its verification, and the next run adopts it.
	WaitingForNextRun int `json:"waitingForNextRun"`
	// What the run adopted of the ops ended sessions left waiting, counted apart from its own.
	Adopted *wikiMaintainAdopted `json:"adopted,omitempty"`
}

// wikiMaintainAdopted is the report's count of the adopted ops (contract `reviewModes.verification.adoption`):
// how many the run took over, and how many of them it got a verdict for.
type wikiMaintainAdopted struct {
	Ops      int `json:"ops"`
	Verified int `json:"verified"`
	Failed   int `json:"failed"`
}

type wikiMaintainAnchors struct {
	Entries int `json:"entries"`
	Changed int `json:"changed"`
	Missing int `json:"missing"`
}

// wikiMaintainSummary is what the command prints, and what --json writes.
type wikiMaintainSummary struct {
	SpaceID string `json:"spaceId"`
	Model   string `json:"model,omitempty"`
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
	// FailureKind is whose a failed run's failure was (`maintenance.job.recovery.failureKinds`): infra when
	// it stopped on the Orbit server or the model's endpoint, content otherwise.
	FailureKind string `json:"failureKind,omitempty"`
	// ServerGone is a server that answered 5xx or nothing at all for the whole of wikiMaintainServerWait:
	// the run could not be told to it, and is not to be run again in this session.
	ServerGone bool               `json:"serverGone,omitempty"`
	Advanced   bool               `json:"advanced"`
	Cursor     string             `json:"cursor,omitempty"`
	Refused    []string           `json:"refused,omitempty"`
	Report     wikiMaintainReport `json:"report"`
}

// wikiMaintainStop is why a run ends before it succeeded: the step, and what went wrong there.
type wikiMaintainStop struct {
	step string
	err  error
}

func (s *wikiMaintainStop) Error() string { return s.step + ": " + s.err.Error() }

// serverDown reports a run that stopped because the Orbit server answered 5xx or nothing at all.
func (s *wikiMaintainStop) serverDown() bool {
	return wikiServerDown(s.err) || wikiServerDownWords.MatchString(s.err.Error())
}

// kind is whose the stop was (`maintenance.job.recovery.failureKinds`): the infrastructure's when the Orbit
// server or the model's endpoint could not answer, the run's own otherwise.
func (s *wikiMaintainStop) kind() string {
	var endpoint *wikiMaintainEndpointDown
	if s.serverDown() || errors.As(s.err, &endpoint) {
		return "infra"
	}
	return "content"
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiMaintainOptions are the command's flags.
type wikiMaintainOptions struct {
	model       string
	concurrency int
}

// wikiMaintainRun is one run's state: where it reports, what it read, and what it has spent.
type wikiMaintainRun struct {
	t         *Transport
	sessionID string
	spaceID   string
	opts      wikiMaintainOptions
	progress  io.Writer
	started   time.Time

	context wikiMaintainContext
	cfg     wikiVerifyConfig
	claude  string
	repo    *wikiImportRepo
	about   string
	cursor  string

	// The pages read, in order, and the last of them each session's dossier was on.
	pages  []wikiMaintainPageRead
	pageOf map[string]int
	// What the dry runs said of the run's circuit breaker, the least room of them; nil until one says it.
	breakerRead *wikiMaintainBreakerReading
	// What moving the cursor once the ops were recorded did (advance): whether it moved, and where it stands.
	advanced bool
	position string

	mu      sync.Mutex
	report  wikiMaintainReport
	refused []string
}

// wikiMaintainPageRead is one page the run read, as the server's tokens name it: where it starts and where it ends.
type wikiMaintainPageRead struct {
	from, cursor string
}

func (r *wikiMaintainRun) say(format string, args ...interface{}) {
	fmt.Fprintf(r.progress, format+"\n", args...)
}

// runWikiMaintain is the whole run. Whatever ends it, the server hears how it ended — unless the server
// refused the run at its start, when there is no run to end.
func runWikiMaintain(t *Transport, sessionID, spaceID string, opts wikiMaintainOptions, progress io.Writer) (wikiMaintainSummary, error) {
	r := &wikiMaintainRun{t: t, sessionID: sessionID, spaceID: spaceID, opts: opts, progress: progress, started: time.Now()}
	summary := wikiMaintainSummary{SpaceID: spaceID, Outcome: "failed"}
	raw, err := t.wikiMaintainRunContext(sessionID, spaceID)
	if err != nil && wikiServerDown(err) && r.awaitServer(err) {
		// Started while the server was down — the retry the task's prompt allows, on 2026-10-01 spent at
		// once on the 500 of a server whose disk had filled: it starts once the server answers again.
		raw, err = t.wikiMaintainRunContext(sessionID, spaceID)
	}
	if err != nil {
		if wikiServerDown(err) {
			summary.FailureKind, summary.ServerGone = "infra", true
			summary.Error = "start: the Orbit server did not answer (" + wikiServerDownCause(err) + ")"
			return summary, fmt.Errorf("orbit wiki maintain: the Orbit server answered 5xx or nothing at all for %s (%s), so nothing "+
				"was read or proposed: an infrastructure failure, not the run's. Do not run it again in this session: the next "+
				"run takes the same dossiers", wikiServerWait.budget, wikiServerDownCause(err))
		}
		return summary, wikiMaintainCallError(spaceID, err)
	}
	if err := json.Unmarshal(raw, &r.context); err != nil {
		return summary, fmt.Errorf("orbit wiki maintain: the server's run context is not the shape this build reads: %w", err)
	}
	stop := r.steps()
	r.report.Seconds = int(time.Since(r.started).Seconds())
	summary.Model = r.cfg.model
	summary.Refused = r.refused
	body := map[string]interface{}{}
	if stop == nil {
		body["outcome"] = "succeeded"
		body["to"] = r.cursor
	} else {
		r.report.StoppedAt = stop.step
		body["outcome"] = "failed"
		body["error"] = cutRunes(stop.Error(), 2000)
		body["failureKind"] = stop.kind()
		summary.Error = stop.Error()
		summary.FailureKind = stop.kind()
	}
	body["report"] = r.report
	summary.Report = r.report
	// A run that stopped on the server waits for it before it says so: a failure's report is sent once, and
	// one sent into a server that is down is lost — as the retry the task's prompt allows would be.
	if stop != nil && stop.serverDown() && !r.awaitServer(stop.err) {
		summary.ServerGone = true
		return summary, fmt.Errorf("orbit wiki maintain: the run failed at %s, and the Orbit server did not come back within %s, "+
			"so it could not be told: an infrastructure failure, not the run's. Do not run it again in this session: %s",
			stop, wikiServerWait.budget, r.nextRunReads())
	}
	answerRaw, finishErr := t.finishWikiMaintenance(sessionID, spaceID, body)
	if finishErr != nil && stop == nil && wikiServerDown(finishErr) && r.awaitServer(finishErr) {
		// A run's report of success may land any number of times (wikiReportsSuccess): once more, now the
		// server answers, rather than hours of the local model's work thrown away on one 500.
		answerRaw, finishErr = t.finishWikiMaintenance(sessionID, spaceID, body)
	}
	if finishErr != nil {
		finish := wikiMaintainCallError(spaceID, finishErr)
		if stop != nil {
			return summary, fmt.Errorf("orbit wiki maintain: the run failed at %s, and the server could not be told: %v", stop, finish)
		}
		return summary, fmt.Errorf("orbit wiki maintain: every step succeeded, and the cursor could not be advanced: %w", finish)
	}
	var answer wikiCursorAdvanceAnswer
	_ = json.Unmarshal(answerRaw, &answer)
	// The cursor may have moved when the ops were recorded (advance), and the end then moves it no further.
	summary.Advanced = answer.Advanced || r.advanced
	summary.Cursor = firstNonEmpty(answer.State.Position, r.position)
	if stop != nil && summary.FailureKind == "infra" {
		return summary, fmt.Errorf("orbit wiki maintain: the run failed at %s; %s. The failure was the "+
			"infrastructure's, not the run's, and the server answers again: the run may be run once more", stop, r.cursorAfterFailure())
	}
	if stop != nil {
		return summary, fmt.Errorf("orbit wiki maintain: the run failed at %s; %s", stop, r.cursorAfterFailure())
	}
	summary.Outcome = "succeeded"
	return summary, nil
}

// cursorAfterFailure says where a run that failed left the cursor: past the sessions whose ops it recorded, or
// where it was.
func (r *wikiMaintainRun) cursorAfterFailure() string {
	if r.report.CursorAdvanced {
		return "the cursor had already moved past the sessions whose ops it recorded, and the next run does not read them again"
	}
	return "the cursor did not move"
}

// nextRunReads says what the next run reads after a run that failed.
func (r *wikiMaintainRun) nextRunReads() string {
	if r.report.CursorAdvanced {
		return "the cursor had already moved past the sessions whose ops it recorded, and the next run takes the dossiers after them"
	}
	return "the next run takes the same dossiers"
}

// ── When the server does not answer ─────────────────────────────────────────────────────────────

// wikiServerWaitPolicy is how a run waits for an Orbit server that answered 5xx or nothing at all
// (`maintenance.job.recovery.inSession`): it asks again after first, doubling, never more than max apart,
// for budget at most. wikiServerWait is the one a run uses; a test gives it a clock of its own.
type wikiServerWaitPolicy struct {
	first, max, budget time.Duration
	now                func() time.Time
	sleep              func(time.Duration)
}

var wikiServerWait = wikiServerWaitPolicy{
	first:  5 * time.Second,
	max:    time.Minute,
	budget: wikiMaintainServerWait,
	now:    time.Now,
	sleep:  time.Sleep,
}

// wait is the pause before the nth ask: first, doubled n-1 times, and never more than max.
func (p wikiServerWaitPolicy) wait(n int) time.Duration {
	if n <= 20 && p.first<<(n-1) < p.max {
		return p.first << (n - 1)
	}
	return p.max
}

// awaitServer waits for the Orbit server to answer again, asking it a read that changes nothing
// (wikiServerAnswers), and says so on the run's progress. True once it answers — with anything but a 5xx —
// and false when the policy's budget ran out first.
func (r *wikiMaintainRun) awaitServer(cause error) bool {
	p := wikiServerWait
	began := p.now()
	r.say("The Orbit server did not answer (%s): waiting for it, %s at most.", wikiServerDownCause(cause), p.budget)
	for asks := 1; ; asks++ {
		wait := p.wait(asks)
		if p.now().Sub(began)+wait > p.budget {
			r.say("The Orbit server did not come back within %s.", p.budget)
			return false
		}
		p.sleep(wait)
		if err := r.t.wikiServerAnswers(r.sessionID, r.spaceID); err == nil || !wikiServerDown(err) {
			r.say("The Orbit server answers again, after %s.", p.now().Sub(began).Round(time.Second))
			return true
		}
	}
}

// wikiServerAnswers asks the Orbit server, once and on a connection of its own, one read that changes
// nothing: a page of one of the session's own ops waiting for their verification. It reads the server's
// database, so a server whose disk filled is not taken for one that answers, as /api/health would be.
func (t *Transport) wikiServerAnswers(sessionID, spaceID string) error {
	if err := validatePathSegmentID(spaceID); err != nil {
		return err
	}
	client := t.wikiClient()
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/verifications?limit=1"
	err := t.doVia(nil, client, http.MethodGet, path, nil, nil, taskOpTimeout, sessionHeader(sessionID))
	var answer *transportHTTPError
	if err != nil && !errors.As(err, &answer) {
		t.wikiRetire(client)
	}
	return err
}

// wikiServerDown reports a call the Orbit server could not answer: a 5xx — the gateway's while the server
// restarts, or its own 500 while its database is gone (2026-10-01, the disk full) — or no answer at all.
// Every other answer is the server's word on the request, and is not waited out.
func wikiServerDown(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.statusCode >= 500 && httpErr.statusCode <= 599
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	_, _, transient := wikiTransient(err, "", "", time.Now())
	return transient
}

// wikiServerDownWords is a 5xx or a lost connection as it reads once a step has put the call's failure
// into words of its own.
var wikiServerDownWords = regexp.MustCompile(`-> 5\d\d\b|\b(?:connection refused|connection reset by peer|server sent GOAWAY|no such host)\b`)

// wikiServerDownCause says what the server did, in a few words: the route and the status it answered, or
// the transport's failure without the request.
func wikiServerDownCause(err error) string {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		return strings.TrimSpace(fmt.Sprintf("%s %s answered %d %s", httpErr.method, strings.SplitN(httpErr.path, "?", 2)[0],
			httpErr.statusCode, http.StatusText(httpErr.statusCode)))
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err.Error()
	}
	return err.Error()
}

// steps runs the pipeline in order, and answers where it stopped, or nil.
func (r *wikiMaintainRun) steps() *wikiMaintainStop {
	fail := func(step string, err error) *wikiMaintainStop { return &wikiMaintainStop{step: step, err: err} }
	if err := r.checkout(); err != nil {
		return fail("checkout", err)
	}
	dossiers, err := r.dossiers()
	if err != nil {
		return fail("dossiers", err)
	}
	var ops []wikiMaintainOp
	if len(dossiers) > 0 {
		if err := r.model(); err != nil {
			return fail("model", err)
		}
		if ops, err = r.extractAll(dossiers); err != nil {
			return fail("extract", err)
		}
	}
	batches, err := r.selfCheck(ops)
	if err != nil {
		return fail("self-check", err)
	}
	batches = r.breaker(batches)
	if err := r.propose(batches); err != nil {
		return fail("propose", err)
	}
	if err := r.advance(); err != nil {
		return fail("advance", err)
	}
	if err := r.verify(); err != nil {
		return fail("verify", err)
	}
	if err := r.anchors(); err != nil {
		return fail("anchors", err)
	}
	if err := r.docs(); err != nil {
		return fail("docs", err)
	}
	return nil
}

// ── The checkout ────────────────────────────────────────────────────────────────────────────────

// checkout is the maintenance workspace's work directory, fetched, and held to the space's repository: its
// origin is the space's, and so is its first commit when the server knows it.
func (r *wikiMaintainRun) checkout() error {
	if r.context.Workspace == nil || strings.TrimSpace(r.context.Workspace.WorkDir) == "" {
		return errors.New("the space's maintenance workspace has no work directory: the run has no checkout to re-verify " +
			"anchors in or to hold the model's paths to; give the workspace one in its settings")
	}
	dir := wikiMaintainExpand(strings.TrimSpace(r.context.Workspace.WorkDir))
	root, err := wikiImportGit(dir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return fmt.Errorf("the maintenance workspace's work directory %s is not a git checkout", dir)
	}
	ref, err := fetchWikiAnchorsRef(root)
	if err != nil {
		return err
	}
	if want := strings.TrimSpace(r.context.Repo.URLNorm); want != "" {
		origin, _ := wikiImportGit(root, "remote", "get-url", "origin")
		if got := normalizeWikiRepoURL(origin); got != want {
			return fmt.Errorf("the maintenance workspace's checkout %s is a clone of %s, not of the space's repository %s: "+
				"its anchors and paths would be checked against the wrong code, so nothing was read or proposed. Point the "+
				"space's maintenance at a workspace whose checkout is the space's repository", root, firstNonEmpty(got, "no origin"), want)
		}
	}
	if sha := strings.ToLower(strings.TrimSpace(r.context.Repo.RootCommitSha)); sha != "" {
		roots, _ := wikiImportGit(root, "rev-list", "--max-parents=0", ref)
		if !contains(strings.Fields(roots), sha) {
			return fmt.Errorf("the maintenance workspace's checkout %s does not start from the space's first commit %s: "+
				"it is another repository behind the same URL, so nothing was read or proposed", root, sha)
		}
	}
	r.repo = openWikiImportRepoAt(root)
	if r.repo == nil {
		return fmt.Errorf("the checkout %s could not be listed at origin/main", root)
	}
	r.about = wikiMaintainAbout(root, ref)
	r.say("Checkout %s at origin/main %s.", root, shortWikiHash(ref))
	return nil
}

// wikiMaintainExpand is a work directory as the owner typed it, `~` read as this runner account's home —
// the passwd entry's, not $HOME's: inside a maintenance session HOME is the session's own empty directory.
func wikiMaintainExpand(dir string) string {
	if dir != "~" && !strings.HasPrefix(dir, "~/") {
		return dir
	}
	home := ""
	if u, err := user.Current(); err == nil {
		home = u.HomeDir
	}
	if home == "" {
		home = userHome()
	}
	if dir == "~" {
		return home
	}
	return filepath.Join(home, dir[2:])
}

var (
	wikiRepoSCP    = regexp.MustCompile(`^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]\S*)$`)
	wikiRepoScheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	wikiRepoRemote = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*)://(?:[^@/]*@)?([^/]*)(.*)$`)
)

// normalizeWikiRepoURL is the server's normalizeRepoUrl (canonicalRepoUrl, then no scheme, no trailing / or
// .git): `git@github.com:a/b.git` and `https://github.com/a/b` both read `github.com/a/b`.
func normalizeWikiRepoURL(raw string) string {
	u := strings.TrimSpace(raw)
	if m := wikiRepoSCP.FindStringSubmatch(u); m != nil && !wikiRepoScheme.MatchString(u) {
		u = "ssh://" + m[1] + "/" + m[2]
	}
	if m := wikiRepoRemote.FindStringSubmatch(u); m != nil {
		u = strings.ToLower(m[1]) + "://" + strings.ToLower(m[2]) + m[3]
	}
	trim := func(s string) string {
		for {
			next := strings.TrimSuffix(strings.TrimRight(s, "/"), ".git")
			if next == s {
				return s
			}
			s = next
		}
	}
	return trim(wikiRepoScheme.ReplaceAllString(trim(u), ""))
}

var (
	wikiMaintainTag      = regexp.MustCompile(`<[^>]*>`)
	wikiMaintainMdLink   = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	wikiMaintainEmphasis = regexp.MustCompile("[*_`]{1,3}")
)

// wikiMaintainAbout is a sentence or two of what the repository is: the first paragraph of its README on
// origin/main that says something, markup taken out. Empty when there is none.
func wikiMaintainAbout(root, ref string) string {
	readme, err := wikiImportGit(root, "show", ref+":README.md")
	if err != nil {
		return ""
	}
	for _, paragraph := range strings.Split(readme, "\n\n") {
		text := wikiMaintainTag.ReplaceAllString(paragraph, " ")
		text = wikiMaintainMdLink.ReplaceAllString(text, "$1")
		text = wikiMaintainEmphasis.ReplaceAllString(html.UnescapeString(text), "")
		text = strings.Join(strings.Fields(text), " ")
		if strings.HasPrefix(text, "#") || len([]rune(text)) < 40 {
			continue
		}
		return cutRunes(text, wikiMaintainAboutMaxChars)
	}
	return ""
}

// ── The model ───────────────────────────────────────────────────────────────────────────────────

// model is the clean Claude Code the extraction runs on, and its endpoint, waited for.
func (r *wikiMaintainRun) model() error {
	cfg := wikiVerifyConfig{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
		token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
		model:   firstNonEmpty(strings.TrimSpace(r.opts.model), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
	}
	switch {
	case cfg.baseURL == "":
		return errors.New("the run extracts with the model this session's provider names, and this session's environment " +
			"names no endpoint (ANTHROPIC_BASE_URL): a maintenance run is pinned to the local model's provider")
	case cfg.token == "":
		return errors.New("the run reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is not set in this session")
	case cfg.model == "":
		return errors.New("the run needs the model to extract with: ANTHROPIC_MODEL, which this session's provider names, is not set — pass --model")
	}
	r.cfg = cfg
	claude, err := wikiVerifyClaudePath()
	if err != nil {
		return err
	}
	r.claude = claude
	return wikiMaintainWaitForEndpoint(cfg.baseURL, r.progress)
}

// wikiMaintainWaitForEndpoint waits for the model's /health to answer 200, at most wikiMaintainHealthWait:
// the tunnel to the local model drops and comes back. One that never answered is the infrastructure's
// failure, not the run's (wikiMaintainEndpointDown).
func wikiMaintainWaitForEndpoint(baseURL string, progress io.Writer) error {
	deadline := time.Now().Add(wikiMaintainHealthWait)
	for {
		err := wikiVerifyEndpointUp(baseURL)
		if err == nil {
			return nil
		}
		if time.Now().Add(wikiMaintainHealthPoll).After(deadline) {
			return &wikiMaintainEndpointDown{err: err}
		}
		fmt.Fprintf(progress, "The model endpoint is not up yet (%v); waiting.\n", err)
		time.Sleep(wikiMaintainHealthPoll)
	}
}

// wikiMaintainEndpointDown is the model's endpoint not answering for the whole of wikiMaintainHealthWait: the
// infrastructure under the run failed, not the run (`maintenance.job.recovery.failureKinds`).
type wikiMaintainEndpointDown struct{ err error }

func (e *wikiMaintainEndpointDown) Error() string { return e.err.Error() }
func (e *wikiMaintainEndpointDown) Unwrap() error { return e.err }

// wikiMaintainAuthError is the endpoint refusing the token: every call after it would be refused the same way.
type wikiMaintainAuthError struct{ detail string }

func (e *wikiMaintainAuthError) Error() string {
	return "the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's provider injected; " +
		"nothing more was asked. " + e.detail
}

// ask is one clean Claude Code call to the local model, counted: wiki_verify.go's launch through
// askWikiModel, with the extraction's system prompt and thinking off.
func (r *wikiMaintainRun) ask(prompt string) (string, error) {
	return r.askAs(wikiMaintainSystemPrompt, prompt)
}

// ── The dossiers ────────────────────────────────────────────────────────────────────────────────

// dossiers reads the pages from the cursor up to the position the task expects — or, for a run no task
// expects anything of, as many sessions as the run may cover — and keeps the dossiers not processed yet.
func (r *wikiMaintainRun) dossiers() ([]wikiDossier, error) {
	var out []wikiDossier
	after := ""
	sessions := 0
	r.pageOf = map[string]int{}
	for pages := 0; ; pages++ {
		limit := wikiMaintainPageSessions
		if r.context.Expect == "" {
			left := r.context.RunSessions - sessions
			if left <= 0 {
				break
			}
			if left < limit {
				limit = left
			}
		}
		raw, err := r.t.listWikiDossiersUntil(r.sessionID, r.spaceID, after, r.context.Expect, limit)
		if err != nil {
			return nil, wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--after", err)
		}
		var page wikiDossierPage
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, fmt.Errorf("the server's page is not the shape this build reads: %w", err)
		}
		r.cursor = page.Cursor
		// Where the page starts is the token it was read after, to a server whose pages do not say it.
		r.pages = append(r.pages, wikiMaintainPageRead{from: firstNonEmpty(page.From, after), cursor: page.Cursor})
		for _, batch := range page.Batches {
			sessions += batch.Sessions
		}
		for _, dossier := range page.Dossiers {
			sessions++
			r.pageOf[dossier.SessionID] = len(r.pages) - 1
			if dossier.Unchanged {
				r.report.Unchanged++
				continue
			}
			out = append(out, dossier)
		}
		if !page.More || (page.Cursor == after && pages > 0) {
			break
		}
		after = page.Cursor
	}
	r.report.Sessions = sessions
	r.report.Dossiers = len(out)
	r.say("Read %s after the space's cursor: %s to extract from, %s already processed.", wikiCount(sessions, "session", "sessions"),
		wikiCount(len(out), "dossier", "dossiers"), wikiCount(r.report.Unchanged, "dossier", "dossiers"))
	return out, nil
}

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────

// wikiMaintainOp is one add the run may propose, and where it came from.
type wikiMaintainOp struct {
	body    map[string]interface{}
	topic   string
	session string
	title   string
}

// extractAll asks the model about every dossier, a few at a time, and stops the run at the first 401.
func (r *wikiMaintainRun) extractAll(dossiers []wikiDossier) ([]wikiMaintainOp, error) {
	concurrency := r.opts.concurrency
	if concurrency <= 0 {
		concurrency = wikiMaintainExtractConcurrency
	}
	results := make([][]wikiMaintainOp, len(dossiers))
	failures := make([]error, len(dossiers))
	if err := wikiMaintainParallel(len(dossiers), concurrency, func(i int) error {
		ops, err := r.extract(dossiers[i])
		results[i], failures[i] = ops, err
		return err
	}); err != nil {
		var auth *wikiMaintainAuthError
		if errors.As(err, &auth) {
			return nil, err
		}
	}
	var ops []wikiMaintainOp
	seen := map[string]bool{}
	for i, list := range results {
		if failures[i] != nil {
			return nil, fmt.Errorf("the model gave no usable answer for session %s: %w", dossiers[i].SessionID, failures[i])
		}
		for _, op := range list {
			key := strings.ToLower(op.title)
			if seen[key] {
				r.report.Entries.Dropped++
				continue
			}
			seen[key] = true
			ops = append(ops, op)
		}
	}
	r.report.Entries.Kept = len(ops)
	r.say("Extracted %s from %s (%s off topic, %s dropped by the checks, %s anchored outside the repository).",
		wikiCount(len(ops), "entry", "entries"), wikiCount(len(dossiers), "dossier", "dossiers"),
		wikiCount(r.report.OffTopic, "session", "sessions"), wikiCount(r.report.Entries.Dropped, "entry", "entries"),
		wikiCount(r.report.Entries.Foreign, "entry", "entries"))
	return ops, nil
}

// wikiMaintainParallel runs n calls, width at a time, and starts none after the first 401: every call after
// it would be refused the same way, and a real Claude Code spends three minutes retrying each. It answers
// the 401, or else the first error.
func wikiMaintainParallel(n, width int, call func(i int) error) error {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first, auth error
	slots := make(chan struct{}, width)
	for i := 0; i < n; i++ {
		slots <- struct{}{}
		mu.Lock()
		stop := auth != nil
		mu.Unlock()
		if stop {
			<-slots
			break
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-slots }()
			err := call(i)
			mu.Lock()
			defer mu.Unlock()
			var refused *wikiMaintainAuthError
			if errors.As(err, &refused) && auth == nil {
				auth = err
			}
			if err != nil && first == nil {
				first = err
			}
		}(i)
	}
	wg.Wait()
	if auth != nil {
		return auth
	}
	return first
}

// extract is one dossier: the model's answer, checked, and — when some of it did not hold up — asked for
// once more (the demo's retry).
func (r *wikiMaintainRun) extract(dossier wikiDossier) ([]wikiMaintainOp, error) {
	lines := wikiMaintainLines(dossier)
	prompt := wikiMaintainPrompt(r.context, r.about, dossier.Text)
	answer, err := r.ask(prompt)
	if err != nil {
		return nil, err
	}
	if wikiMaintainOffTopic(answer) {
		r.mu.Lock()
		r.report.OffTopic++
		r.mu.Unlock()
		r.say("  %q: not about this repository — nothing taken from it", cutRunes(dossier.Title, 60))
		return nil, nil
	}
	entries, parsed := parseWikiImportAnswer(answer)
	built := r.build(entries, dossier, lines)
	problems := built.problems
	if !parsed {
		problems = []string{"the answer was not a JSON array of entries"}
	}
	if !parsed || len(built.problems) > 0 {
		retry, err := r.ask(prompt + wikiMaintainRetrySuffix(answer, parsed, built))
		if err != nil {
			var auth *wikiMaintainAuthError
			if errors.As(err, &auth) {
				return nil, err
			}
		} else if again, ok := parseWikiImportAnswer(retry); ok {
			built.merge(r.build(again, dossier, lines))
		}
	}
	if built.dropped > 0 || !parsed {
		if len(problems) > 3 {
			problems = problems[:3]
		}
		r.say("  %q: %s dropped — %s", cutRunes(dossier.Title, 60), wikiCount(built.dropped, "entry", "entries"), strings.Join(problems, "; "))
	}
	r.mu.Lock()
	r.report.Entries.Extracted += built.extracted
	r.report.Entries.Dropped += built.dropped
	r.report.Entries.Foreign += built.foreign
	r.report.Entries.Principles += built.principles
	r.mu.Unlock()
	if len(built.ops) > wikiMaintainEntriesPerSession {
		built.ops = built.ops[:wikiMaintainEntriesPerSession]
	}
	return built.ops, nil
}

// wikiMaintainOffTopic is the model saying the session is not about this repository: `{"offTopic": true}`.
func wikiMaintainOffTopic(answer string) bool {
	text := strings.TrimSpace(answer)
	if m := wikiImportFence.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	var said struct {
		OffTopic bool `json:"offTopic"`
	}
	if strings.HasPrefix(text, "{") && json.Unmarshal([]byte(text), &said) == nil {
		return said.OffTopic
	}
	return false
}

// wikiMaintainLine is one line of a dossier a source may name: its text, the record behind it, and where in
// that record's text the line's words are.
type wikiMaintainLine struct {
	text   string
	kind   string
	id     string
	author string
	spans  []wikiDossierSpan
}

var wikiMaintainLineHead = regexp.MustCompile(`^L(\d+) ([a-z-]+): ?(.*)$`)

// wikiMaintainLines are a dossier's named lines: each `L12 owner: …` with the lines that continue it, and
// the record its sources map the name to. The server writes every newline of a line's text as a newline and
// four spaces (wiki-dossier.ts), a blank one included, so a line continues exactly as far as the lines under
// it carry that indent; an omission marker (`   … (N lines omitted)`) has three, and ends it.
func wikiMaintainLines(dossier wikiDossier) map[string]wikiMaintainLine {
	records := map[string]wikiDossierSource{}
	for _, source := range dossier.Sources {
		records[source.Ref] = source
	}
	lines := map[string]wikiMaintainLine{}
	current := ""
	for _, raw := range strings.Split(dossier.Text, "\n") {
		if m := wikiMaintainLineHead.FindStringSubmatch(raw); m != nil {
			current = "L" + m[1]
			record, ok := records[current]
			if !ok {
				current = ""
				continue
			}
			lines[current] = wikiMaintainLine{text: m[3], kind: record.Kind, id: record.ID, author: m[2], spans: record.Spans}
			continue
		}
		if current == "" || !strings.HasPrefix(raw, wikiMaintainContinuation) {
			current = ""
			continue
		}
		line := lines[current]
		line.text += "\n" + strings.TrimPrefix(raw, wikiMaintainContinuation)
		lines[current] = line
	}
	return lines
}

// wikiMaintainContinuation is the indent a dossier line's own later lines carry.
const wikiMaintainContinuation = "    "

// wikiMaintainBuilt is what a set of the model's entries became: the adds that hold up, and what was
// wrong with the rest (for the retry).
type wikiMaintainBuilt struct {
	ops        []wikiMaintainOp
	rejected   []map[string]interface{}
	problems   []string
	extracted  int
	dropped    int
	foreign    int
	principles int
	titles     map[string]bool
}

func (b *wikiMaintainBuilt) merge(retry wikiMaintainBuilt) {
	for _, op := range retry.ops {
		if b.titles[strings.ToLower(op.title)] {
			continue
		}
		b.titles[strings.ToLower(op.title)] = true
		b.ops = append(b.ops, op)
		if b.dropped > 0 {
			b.dropped--
		}
	}
	// A principle in the retry is one the first answer already had, and was counted there.
	b.foreign += retry.foreign
}

var wikiMaintainDate = regexp.MustCompile(`started (\d{4}-\d{2}-\d{2})`)

// build checks each entry the way the demo's extract.py validated it, and makes an add of the ones that
// hold up: a known kind with its fields, sources that are lines of the dossier with their quotes copied
// from those lines, and anchors that exist in the checkout. An entry whose code anchors all point outside
// the repository is another repository's knowledge, and is dropped.
func (r *wikiMaintainRun) build(entries []map[string]interface{}, dossier wikiDossier, lines map[string]wikiMaintainLine) wikiMaintainBuilt {
	built := wikiMaintainBuilt{titles: map[string]bool{}}
	date := time.Now().UTC().Format("2006-01-02")
	if m := wikiMaintainDate.FindStringSubmatch(dossier.Text); m != nil {
		date = m[1]
	}
	topics := map[string]bool{}
	for _, topic := range r.context.Topics {
		topics[topic.Slug] = true
	}
	for _, entry := range entries {
		built.extracted++
		kind, _ := entry["kind"].(string)
		kind = strings.ToLower(strings.TrimSpace(kind))
		title := wikiImportText(entry["title"], 120)
		if kind == "principle" {
			// A principle is the owner's alone to write (WIKI_KIND_OWNER_ONLY): set aside, and counted.
			built.principles++
			continue
		}
		problems := []string{}
		reject := func(list ...string) {
			built.dropped++
			built.rejected = append(built.rejected, entry)
			for _, problem := range list {
				built.problems = append(built.problems, fmt.Sprintf("entry %q: %s", cutRunes(title, 40), problem))
			}
		}
		if !contains(wikiMaintainKinds, kind) {
			reject(fmt.Sprintf("kind %q is not one of %s", kind, strings.Join(wikiMaintainKinds[1:], ", ")))
			continue
		}
		summary := wikiImportText(entry["summary"], 280)
		if title == "" {
			problems = append(problems, "title is missing")
		}
		if summary == "" {
			problems = append(problems, "summary is missing")
		}
		nested, _ := entry["fields"].(map[string]interface{})
		field := func(name string) interface{} {
			if value, ok := entry[name]; ok {
				return value
			}
			return nested[name]
		}
		fields := map[string]interface{}{}
		note := wikiImportNote{date: date}
		for _, name := range wikiImportRequired[kind] {
			value, problem := wikiImportField(name, field(name), note)
			if problem != "" {
				problems = append(problems, problem)
				continue
			}
			fields[name] = value
		}
		for _, name := range wikiImportOptional[kind] {
			if text := wikiImportText(field(name), 4000); text != "" {
				fields[name] = text
			}
		}
		sources, sourceProblems := wikiMaintainSources(entry["sources"], lines)
		problems = append(problems, sourceProblems...)
		if len(sources) == 0 {
			problems = append(problems, "no valid source: cite a line of the case file, with its quote copied from it")
		}
		if len(problems) > 0 {
			reject(problems...)
			continue
		}
		given, _ := entry["anchors"].(map[string]interface{})
		named := len(wikiImportTextList(given["paths"])) + len(wikiImportTextList(given["commits"]))
		anchors := r.repo.anchors(entry["anchors"])
		if named > 0 && len(anchors) == 0 {
			// Every code anchor it names is outside this repository: the knowledge is another repository's.
			built.foreign++
			continue
		}
		draft := map[string]interface{}{"kind": kind, "title": title, "summary": summary, "fields": fields}
		topic, _ := entry["topic"].(string)
		topic = strings.TrimSpace(topic)
		if topics[topic] {
			draft["topics"] = []interface{}{topic}
		} else {
			topic = ""
		}
		if len(anchors) > 0 {
			draft["anchors"] = anchors
		}
		if built.titles[strings.ToLower(title)] {
			built.dropped++
			continue
		}
		built.titles[strings.ToLower(title)] = true
		built.ops = append(built.ops, wikiMaintainOp{
			body:    map[string]interface{}{"op": "add", "entry": draft, "sources": sources},
			topic:   topic,
			session: dossier.SessionID,
			title:   title,
		})
	}
	return built
}

// wikiMaintainSources are an entry's `[{ref, quote}]` as the sources an add cites: the record behind each
// line it names. A quote that is not copied from that line is a problem. One that is, is proposed as the
// record's own words where the line's spans put them — its quote those words, its locator their place — and a
// quote the spans do not hold, the dossier's shorthand for the record, leaves the record cited without one.
func wikiMaintainSources(raw interface{}, lines map[string]wikiMaintainLine) ([]interface{}, []string) {
	list, _ := raw.([]interface{})
	var sources []interface{}
	var problems []string
	seen := map[string]bool{}
	for _, item := range list {
		source, _ := item.(map[string]interface{})
		ref := strings.TrimSpace(fmt.Sprint(source["ref"]))
		line, ok := lines[ref]
		if !ok {
			problems = append(problems, fmt.Sprintf("source ref %s is not a line of the case file", ref))
			continue
		}
		quote := wikiImportText(source["quote"], 4000)
		plainQuote := wikiMaintainPlain(quote)
		if len([]rune(plainQuote)) < 4 {
			problems = append(problems, fmt.Sprintf("source %s has no quote", ref))
			continue
		}
		if !strings.Contains(wikiMaintainPlain(line.text), plainQuote) {
			problems = append(problems, fmt.Sprintf("quote for %s is not copied exactly from that line", ref))
			continue
		}
		key := line.kind + ":" + line.id
		if seen[key] {
			continue
		}
		seen[key] = true
		cited := map[string]interface{}{"kind": line.kind, "ref": line.id}
		if len(line.spans) == 0 {
			// A server from before dossier lines said where their words are: the line's own words, which the
			// self-check's dry run holds to the record.
			cited["quote"] = cutRunes(quote, wikiMaintainQuoteMaxChars)
		} else if words, start, end, ok := wikiMaintainPlace(line.spans, quote); ok {
			cited["quote"] = words
			cited["locator"] = map[string]interface{}{"start": start, "end": end}
		}
		sources = append(sources, cited)
	}
	return sources, problems
}

// wikiMaintainPlace finds a quote in the words a line's spans hold, read as a quote is compared
// (wikiMaintainPlain: markdown marks and curly quotes aside, a run of whitespace one space), and answers the
// record's own words there — marks, quotes and spacing as the record has them — and where they are: code points
// of the record's redacted text, cut to the quote limit. A quote no single span holds, or whose words the
// redactor took out, is not the record's words, and is not placed.
func wikiMaintainPlace(spans []wikiDossierSpan, quote string) (string, int, int, bool) {
	want := []rune(wikiMaintainPlain(quote))
	if len(want) == 0 {
		return "", 0, 0, false
	}
	for _, span := range spans {
		words := []rune(span.Text)
		plain, at := wikiMaintainPlainRunes(words)
		i := wikiMaintainRunesIndex(plain, want)
		if i < 0 {
			continue
		}
		start, end := at[i], at[i+len(want)-1]+1
		if end-start > wikiMaintainQuoteMaxChars {
			end = start + wikiMaintainQuoteMaxChars
		}
		found := string(words[start:end])
		if strings.Contains(found, "[redacted]") {
			return "", 0, 0, false
		}
		return found, span.Start + start, span.Start + end, true
	}
	return "", 0, 0, false
}

// wikiMaintainRunesIndex is where needle first stands in haystack, or -1.
func wikiMaintainRunesIndex(haystack, needle []rune) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		j := 0
		for j < len(needle) && haystack[i+j] == needle[j] {
			j++
		}
		if j == len(needle) {
			return i
		}
	}
	return -1
}

// wikiMaintainPlainRunes is wikiMaintainPlain over runes, with where each rune it keeps stands in the runes it
// was given: a run of whitespace is the one space at its first rune.
func wikiMaintainPlainRunes(words []rune) ([]rune, []int) {
	plain := make([]rune, 0, len(words))
	at := make([]int, 0, len(words))
	space := -1
	for i, r := range words {
		switch {
		case r == '`' || r == '*':
			continue
		case unicode.IsSpace(r):
			if space < 0 {
				space = i
			}
			continue
		}
		if space >= 0 && len(plain) > 0 {
			plain = append(plain, ' ')
			at = append(at, space)
		}
		space = -1
		switch r {
		case '“', '”', '„':
			r = '"'
		case '‘', '’':
			r = '\''
		}
		plain = append(plain, r)
		at = append(at, i)
	}
	return plain, at
}

// wikiMaintainPlain is text as the demo's norm_quote compared it: backticks and asterisks out, curly
// quotes straight, runs of whitespace one space.
func wikiMaintainPlain(text string) string {
	text = strings.NewReplacer("`", "", "**", "", "*", "", "“", `"`, "”", `"`, "„", `"`, "‘", "'", "’", "'").Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

// wikiMaintainRetrySuffix asks once more, naming what did not hold up (prompts.py's retry_suffix).
func wikiMaintainRetrySuffix(answer string, parsed bool, built wikiMaintainBuilt) string {
	if !parsed {
		return "\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n" + lastRunes(answer, 3000) +
			"\n\nPROBLEMS:\n- the output was not a valid JSON array of flat entry objects\nOutput a JSON array with corrected " +
			"versions of ONLY these rejected entries (flat objects as specified; copy quotes exactly from the cited line; fill " +
			"every required field). Drop an entry you cannot support. Output the JSON array only."
	}
	rejected, _ := json.Marshal(built.rejected)
	problems := built.problems
	if len(problems) > 12 {
		problems = problems[:12]
	}
	return "\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n" + cutRunes(string(rejected), 6000) + "\n\nPROBLEMS:\n- " +
		strings.Join(problems, "\n- ") + "\nOutput a JSON array with corrected versions of ONLY these rejected entries (flat " +
		"objects as specified; copy quotes exactly from the cited line; fill every required field). Drop an entry you cannot " +
		"support. Output the JSON array only."
}

// ── Self-check, breaker, proposals ──────────────────────────────────────────────────────────────

// wikiMaintainBatch is one changeset's worth of ops, of one topic, and what the dry run said of each.
type wikiMaintainBatch struct {
	topic string
	ops   []wikiMaintainOp
	// changes says of each op whether the review mode would change an entry with it, now or on a verdict — or
	// would have, had the batch left the breaker room for it: what the breaker counts.
	changes []bool
}

// selfCheck groups the ops by topic into batches and proposes each with dryRun: a quote the server does not
// find is taken off its source and the op checked again, an op still refused is dropped, and one the review
// queue holds back is left out. One the breaker refuses stays, for the breaker step to hold to what every
// batch would change together.
func (r *wikiMaintainRun) selfCheck(ops []wikiMaintainOp) ([]wikiMaintainBatch, error) {
	size := wikiMaintainOpsPerChangeset
	if r.context.ReviewMode == "manual" {
		size = wikiMaintainOpsPerTurn
	}
	byTopic := map[string][]wikiMaintainOp{}
	for _, op := range ops {
		byTopic[op.topic] = append(byTopic[op.topic], op)
	}
	names := make([]string, 0, len(byTopic))
	for topic := range byTopic {
		names = append(names, topic)
	}
	sort.Strings(names)
	var batches []wikiMaintainBatch
	for _, topic := range names {
		list := byTopic[topic]
		for start := 0; start < len(list); start += size {
			end := start + size
			if end > len(list) {
				end = len(list)
			}
			batch, err := r.dryRun(topic, list[start:end])
			if err != nil {
				return nil, err
			}
			if len(batch.ops) > 0 {
				batches = append(batches, batch)
			}
		}
	}
	return batches, nil
}

// dryRun checks one batch, twice at most: the second time with the quotes the server did not find taken off.
func (r *wikiMaintainRun) dryRun(topic string, ops []wikiMaintainOp) (wikiMaintainBatch, error) {
	for round := 0; ; round++ {
		answer, err := r.send(topic, ops, true)
		if err != nil {
			return wikiMaintainBatch{}, err
		}
		r.noteBreaker(answer.Breaker)
		batch := wikiMaintainBatch{topic: topic}
		stripped := false
		for i, op := range ops {
			outcome := wikiImportOutcomeAt(answer.Ops, i)
			status, _ := outcome["status"].(string)
			code, message := wikiImportReason(outcome)
			switch {
			case status == "refused" && code == "WIKI_QUOTA" && strings.HasPrefix(message, "circuit breaker"):
				// Past what the run may still change, counted over this batch alone: the breaker step counts it
				// with every other batch's.
				batch.ops = append(batch.ops, op)
				batch.changes = append(batch.changes, true)
			case status == "refused" && code == "WIKI_QUOTE_NOT_FOUND" && round == 0:
				// A quote is the record's words where the dossier placed them, but a server can read a record
				// otherwise — one from before a tool call's text held its input finds no command in it. Cite the
				// record without the quote rather than drop what it supports.
				wikiMaintainStripQuotes(op.body)
				stripped = true
				batch.ops = append(batch.ops, op)
				batch.changes = append(batch.changes, false)
			case status == "refused" && (code == "WIKI_QUOTA" || code == "WIKI_REVIEW_QUEUE_FULL"):
				r.report.Ops.HeldBack++
			case status == "refused" || status == "conflict" || status == "":
				r.report.Ops.SelfCheckDropped++
				r.say("  dropped by the self-check: %q (%s)", op.title, firstNonEmpty(message, status, "no answer"))
			default:
				batch.ops = append(batch.ops, op)
				batch.changes = append(batch.changes, status == "applied" || outcome["waitsFor"] == "verification")
			}
		}
		if !stripped || round > 0 {
			return batch, nil
		}
		ops = batch.ops
	}
}

// wikiMaintainStripQuotes takes the quotes off an add's sources, and the places they were quoted from.
func wikiMaintainStripQuotes(body map[string]interface{}) {
	sources, _ := body["sources"].([]interface{})
	for _, item := range sources {
		if source, ok := item.(map[string]interface{}); ok {
			delete(source, "quote")
			delete(source, "locator")
		}
	}
}

// breaker holds back, before anything is written, what the run may not change (contract
// `maintenance.job.run.steps`, the breaker). How much more the run may change through the review mode is the
// server's to say: its dry runs answer with the run's circuit breaker as it stands — the entries the run
// began with, and what it has spent, an earlier attempt in this session included. The pages are kept in the
// order they were read while what their ops would change fits; from the first page that does not fit, every
// op is held back and the cursor stops where that page starts. The next run reads those dossiers again, so
// what is held back is not lost, and what was proposed is not read twice: a session on more than one page
// goes with the last of them, the one a stopped cursor leaves it on.
func (r *wikiMaintainRun) breaker(batches []wikiMaintainBatch) []wikiMaintainBatch {
	remaining, bounded := r.remaining()
	if !bounded {
		return batches
	}
	need := make([]int, len(r.pages))
	for _, batch := range batches {
		for i, op := range batch.ops {
			if batch.changes[i] {
				need[r.pageOf[op.session]]++
			}
		}
	}
	stop, used := len(r.pages), 0
	for page := range r.pages {
		if used+need[page] > remaining {
			stop = page
			break
		}
		used += need[page]
	}
	if stop == len(r.pages) {
		return batches
	}
	var kept []wikiMaintainBatch
	for _, batch := range batches {
		left := wikiMaintainBatch{topic: batch.topic}
		for i, op := range batch.ops {
			if r.pageOf[op.session] >= stop {
				r.report.Ops.HeldBackByBreaker++
				continue
			}
			left.ops = append(left.ops, op)
			left.changes = append(left.changes, batch.changes[i])
		}
		if len(left.ops) > 0 {
			kept = append(kept, left)
		}
	}
	r.cursor = r.pages[stop].from
	r.say("The breaker held back %s from page %d on, past the %s the run may still change: the cursor stops where "+
		"that page starts, and the next run reads its dossiers again.",
		wikiCount(r.report.Ops.HeldBackByBreaker, "op", "ops"), stop+1, wikiCount(remaining, "entry", "entries"))
	return kept
}

// noteBreaker keeps what a dry run said of the run's circuit breaker. Every dry run is answered before anything
// of the run is recorded, so they agree unless something else changed the space in between: then the least room
// is the one to hold to.
func (r *wikiMaintainRun) noteBreaker(reading *wikiMaintainBreakerReading) {
	if reading == nil {
		return
	}
	held := r.breakerRead
	if held == nil || (reading.Remaining != nil && (held.Remaining == nil || *reading.Remaining < *held.Remaining)) {
		r.breakerRead = reading
	}
}

// remaining is how many more entries the run may change through the review mode, and whether anything bounds
// it: what the dry runs said — or, from a server whose dry runs say nothing of the breaker, the share of the
// active entries the run's context counted, as this command held its batches to before they did.
func (r *wikiMaintainRun) remaining() (int, bool) {
	if reading := r.breakerRead; reading != nil {
		if reading.Remaining == nil {
			return 0, false
		}
		return *reading.Remaining, true
	}
	active, min, percent := r.context.ActiveEntries, r.context.Breaker.MinActiveEntries, r.context.Breaker.MaxChangedPercent
	if min <= 0 || percent <= 0 || active < min {
		return 0, false
	}
	return active * percent / 100, true
}

// propose records each batch as the space's maintenance run. An op the server refuses now — after it
// passed the dry run — fails the run once every batch has been sent.
func (r *wikiMaintainRun) propose(batches []wikiMaintainBatch) error {
	for _, batch := range batches {
		answer, err := r.send(batch.topic, batch.ops, false)
		if err != nil {
			return err
		}
		r.report.Ops.Proposed += len(batch.ops)
		for i, op := range batch.ops {
			outcome := wikiImportOutcomeAt(answer.Ops, i)
			switch status, _ := outcome["status"].(string); status {
			case "applied":
				r.report.Ops.Recorded++
				r.report.Ops.Applied++
			case "pending":
				r.report.Ops.Recorded++
				r.report.Ops.Waiting++
			default:
				r.report.Ops.Refused++
				code, message := wikiImportReason(outcome)
				r.refused = append(r.refused, fmt.Sprintf("%q: %s", op.title, firstNonEmpty(strings.TrimSpace(code+" "+message), status)))
			}
		}
	}
	r.say("Proposed %s: %d applied, %d waiting, %d refused (%d dropped by the self-check, %d held back by the review queue, "+
		"%d held back by the breaker).",
		wikiCount(r.report.Ops.Proposed, "op", "ops"), r.report.Ops.Applied, r.report.Ops.Waiting, r.report.Ops.Refused,
		r.report.Ops.SelfCheckDropped, r.report.Ops.HeldBack, r.report.Ops.HeldBackByBreaker)
	if r.report.Ops.Refused > 0 {
		return fmt.Errorf("the server refused %s the dry run had passed: %s", wikiCount(r.report.Ops.Refused, "op", "ops"),
			strings.Join(r.refused, "; "))
	}
	return nil
}

// advance moves the space's cursor past the sessions whose ops the run recorded, as soon as every batch is
// recorded (contract `maintenance.job.run.steps`, advance; criterion 3 revision 4): to the last page the run read
// or, when the breaker held ops back, to where their pages start. Nothing of how the run ends is said here: a step
// after it that fails still fails the run, and the cursor stays where this put it, so the next run does not read
// those sessions again. A server that predates the route moves the cursor at the run's end, as it always did.
func (r *wikiMaintainRun) advance() error {
	if r.cursor == "" {
		return nil
	}
	raw, err := r.t.advanceWikiMaintenance(r.sessionID, r.spaceID, map[string]interface{}{"to": r.cursor})
	if err != nil {
		if wikiMaintenanceDoorMissing(err) {
			r.say("This Orbit server predates moving the cursor once the ops are recorded: it moves at the run's end.")
			return nil
		}
		return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--to", err)
	}
	var answer wikiCursorAdvanceAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		return fmt.Errorf("the server's answer to the cursor's move is not the shape this build reads: %w", err)
	}
	r.advanced, r.position = answer.Advanced, answer.State.Position
	r.report.CursorAdvanced = true
	if answer.Advanced {
		r.say("The ops are recorded: the cursor moved past their sessions, to %s.", firstNonEmpty(answer.State.Position, r.cursor))
	} else {
		r.say("The ops are recorded: the cursor already stood past their sessions.")
	}
	return nil
}

// wikiMaintainAnswer is a proposal's answer, as far as a run reads it.
type wikiMaintainAnswer struct {
	ChangesetID string                   `json:"changesetId"`
	Ops         []map[string]interface{} `json:"ops"`
	// Breaker is a dry run's reading of the circuit breaker before the batch's ops (contract `refusalRules.dryRun`).
	Breaker *wikiMaintainBreakerReading `json:"breaker"`
}

// wikiMaintainBreakerReading is the circuit breaker as a dry run found it: for a maintenance run's changeset, the
// whole run's — the active entries it began with, those it has changed through the review mode, and how many more
// it may change. Remaining is nil where no op is held to the breaker.
type wikiMaintainBreakerReading struct {
	Scope         string `json:"scope"`
	ActiveAtStart int    `json:"activeAtStart"`
	Changed       int    `json:"changed"`
	Remaining     *int   `json:"remaining"`
}

// send proposes one batch — dryRun or not — and reads every op's outcome, a refused request included.
func (r *wikiMaintainRun) send(topic string, ops []wikiMaintainOp, dryRun bool) (wikiMaintainAnswer, error) {
	list := make([]interface{}, 0, len(ops))
	sessions := map[string]bool{}
	for _, op := range ops {
		list = append(list, op.body)
		sessions[op.session] = true
	}
	about := firstNonEmpty(topic, "no topic")
	body := map[string]interface{}{
		"ops": list,
		"rationale": cutRunes(fmt.Sprintf("Wiki maintenance run: %s on %s, extracted by %s from %s since the space's cursor.",
			wikiCount(len(ops), "entry", "entries"), about, firstNonEmpty(r.cfg.model, "the local model"),
			wikiCount(len(sessions), "session", "sessions")), 2000),
	}
	if dryRun {
		body["dryRun"] = true
	} else {
		sum, _ := json.Marshal(list)
		digest := sha256.Sum256(append([]byte(r.sessionID+"\x00"), sum...))
		body["idempotencyKey"] = "wiki-maintain-" + hex.EncodeToString(digest[:16])
	}
	raw, err := r.t.proposeWikiMaintenance(r.sessionID, r.spaceID, body)
	var answer wikiMaintainAnswer
	if err != nil {
		var httpErr *transportHTTPError
		if !errors.As(err, &httpErr) || json.Unmarshal([]byte(httpErr.body), &answer) != nil || answer.Ops == nil {
			return answer, wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
		}
		return answer, nil
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return answer, fmt.Errorf("the server's answer is not the shape this build reads: %w", err)
	}
	return answer, nil
}

// ── Verification and anchors ────────────────────────────────────────────────────────────────────

// verify has the local model verify the run's own ops in an automatic space (`orbit wiki verify`), gives
// the ones left without a verdict one more pass, and then adopts what ended sessions left waiting. What
// still has no verdict waits for the next run, and fails nothing.
func (r *wikiMaintainRun) verify() error {
	if r.context.ReviewMode != "automatic" {
		return nil
	}
	if r.report.Ops.Recorded > 0 {
		if err := r.verifyOwn(); err != nil {
			return err
		}
	}
	return r.adopt()
}

// verifyOwn verifies the ops this run proposed, in two passes at most. The second asks again about the ops
// the first got no verdict for, telling the model why an answer of its was not a verdict and which ids a
// duplicate may name; it reads the answer as strictly. What still has no verdict fails nothing, as an
// adopted op without one fails nothing (contract `maintenance.job.run.steps`, verify): nothing applies
// without a verdict, so it is not live, and it keeps waiting for its verification, which the next run adopts
// once this run's session has ended. A 401 and an error from the server still end the run failed.
func (r *wikiMaintainRun) verifyOwn() error {
	result := &wikiMaintainVerification{}
	r.report.Verification = result
	var refused map[string]string
	for pass := 0; pass < 2; pass++ {
		summary, err := runWikiVerify(r.t, r.sessionID, r.spaceID, r.cfg, 0, refused, r.progress)
		r.report.Tokens.Calls += summary.Looked
		r.report.Tokens.Input += summary.Usage.InputTokens
		r.report.Tokens.Output += summary.Usage.OutputTokens
		result.Verified += summary.Verified
		result.Failed = summary.Failed
		if err != nil {
			return err
		}
		if summary.Failed == 0 || summary.Stopped != "" {
			break
		}
		refused = map[string]string{}
		for _, failure := range summary.Failures {
			if failure.refused != "" {
				refused[failure.OpID] = failure.refused
			}
		}
	}
	if result.Failed > 0 {
		result.WaitingForNextRun += result.Failed
		r.say("%s of the run's own got no verdict: not live, and the next run adopts %s.",
			wikiCount(result.Failed, "op", "ops"), wikiPronoun(result.Failed))
	}
	return nil
}

// wikiPronoun is how a sentence names a count of ops after it has said it.
func wikiPronoun(n int) string {
	if n == 1 {
		return "it"
	}
	return "them"
}

// adopt verifies what ended sessions left waiting for their verification in the space — a failed run's
// ops, a session that ended before it verified its own — which nobody else is left to verify (contract
// `reviewModes.verification.adoption`): at most wikiMaintainAdoptOpsMax of them, oldest first, after the
// run's own, so that one a later op of the same knowledge is live beside is offered it as a duplicate.
// One left without a verdict waits for the next run and fails nothing; the report counts them apart.
func (r *wikiMaintainRun) adopt() error {
	raw, err := r.t.listWikiVerifications(wikiAdoptedVerifications.route, r.sessionID, r.spaceID, "", 1)
	if err != nil {
		if wikiMaintenanceDoorMissing(err) {
			r.say("This Orbit server predates adopting what ended sessions left waiting for their verification: none was adopted.")
			return nil
		}
		return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
	}
	var page wikiVerificationPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return fmt.Errorf("the server's list of what ended sessions left waiting is not the shape this build reads: %w", err)
	}
	if page.Mode != "automatic" || len(page.Items) == 0 {
		return nil
	}
	// A run that extracted nothing has not asked the model anything yet.
	if r.claude == "" {
		if err := r.model(); err != nil {
			return err
		}
	}
	summary := wikiVerifySummary{SpaceID: r.spaceID, Model: r.cfg.model, Failures: []wikiVerifyFailure{}}
	err = verifyWikiOps(r.t, wikiAdoptedVerifications, r.sessionID, r.spaceID, r.cfg, r.claude, wikiMaintainAdoptOpsMax, nil, &summary, r.progress)
	r.report.Tokens.Calls += summary.Looked
	r.report.Tokens.Input += summary.Usage.InputTokens
	r.report.Tokens.Output += summary.Usage.OutputTokens
	if r.report.Verification == nil {
		r.report.Verification = &wikiMaintainVerification{}
	}
	r.report.Verification.Adopted = &wikiMaintainAdopted{Ops: summary.Looked, Verified: summary.Verified, Failed: summary.Failed}
	r.report.Verification.WaitingForNextRun += summary.Failed
	if err != nil {
		return err
	}
	r.say("Adopted %s ended sessions left waiting for their verification: %d verified, %d without a verdict, which wait for the next run.",
		wikiCount(summary.Looked, "op", "ops"), summary.Verified, summary.Failed)
	return nil
}

// anchors re-verifies the space's anchors in the run's checkout (`orbit wiki anchors verify --repo`).
func (r *wikiMaintainRun) anchors() error {
	summary, err := runWikiAnchorsVerify(r.t, r.sessionID, r.spaceID, r.repo.root)
	r.report.Anchors = &wikiMaintainAnchors{Entries: summary.Entries, Changed: summary.Changed, Missing: summary.Missing}
	if err != nil {
		return err
	}
	if summary.Failed > 0 || summary.Refused > 0 {
		return fmt.Errorf("git could not check %s, and the server refused %s",
			wikiCount(summary.Failed, "anchor", "anchors"), wikiCount(summary.Refused, "entry", "entries"))
	}
	r.say("Re-verified the anchors of %s: %d changed, %d missing.", wikiCount(summary.Entries, "entry", "entries"), summary.Changed, summary.Missing)
	return nil
}

// ── The prompt ──────────────────────────────────────────────────────────────────────────────────

// wikiMaintainPrompt is the demo's extraction prompt (prompts.py EXTRACT_INSTRUCTIONS, the A2+6 run: at most
// six entries, the few-shot example), for this space's repository: the model is told which repository the
// case is about and what it is, and to say so when the case is about something else.
func wikiMaintainPrompt(context wikiMaintainContext, about, dossier string) string {
	name := context.Title
	if context.Repo.URLNorm != "" {
		name = filepath.Base(context.Repo.URLNorm)
	}
	var scope strings.Builder
	fmt.Fprintf(&scope, "THE REPOSITORY: %q", name)
	if context.Repo.URLNorm != "" {
		fmt.Fprintf(&scope, " (%s)", context.Repo.URLNorm)
	}
	if about != "" {
		fmt.Fprintf(&scope, " — %s", about)
	}
	var topics strings.Builder
	for _, topic := range context.Topics {
		fmt.Fprintf(&topics, "- %s: %s\n", topic.Slug, firstNonEmpty(topic.Description, topic.Title))
	}
	return `Below is a CASE FILE: a compressed timeline of one piece of work in the "` + name + `" repository (one task, possibly retried, or one standalone chat session).
` + scope.String() + `
Each line starts with a ref (like L37) and a speaker:
- owner: the human account owner (their words carry the most weight); user: a message most likely typed by the owner
- sender / parent: a message from another agent (a coordinator) — not the owner
- taskprompt: the task's opening prompt (title, description) written by the owner or a coordinator
- agent: the coding agent's reply; think: sentences from the agent's private reasoning; sub-agent: a helper agent
- tool: a tool call and its result ("ERR:" marks a failure, "×N" folds repeated reads/edits)
- comment / merge / blocker / openitem / system: task records
"… (N lines omitted)" marks lines left out.

FIRST: if this case is not about the repository above and the way it is developed — another product, a personal errand, a conversation about something else — output exactly {"offTopic": true} and nothing else.

TASK: extract the knowledge from this case that would change how a future agent works in this repository and that it could NOT learn by reading the code for one minute:
- owner rules and corrections (how the owner wants things done) -> convention (or principle, if it is a general value with a reason)
- decisions the owner made, with the alternatives and why they were rejected -> decision
- traps and surprises: something behaved differently than expected, with the cause and the fix -> pitfall
- a multi-step procedure that was run and verified to work -> recipe
- the meaning of a project-specific term or mechanism that is easy to get wrong -> concept
Do NOT extract: task progress or status reports, what was built, one-off facts about this task only, generic programming advice, or anything the code states plainly. Prefer fewer, stronger entries. If there is nothing worth keeping, output [].

OUTPUT: a JSON array (at most ` + strconv.Itoa(wikiMaintainEntriesPerSession) + ` objects), nothing else — no prose, no code fence. Each object is FLAT:
{"kind": "principle|convention|decision|pitfall|recipe|concept",
 "title": "<= 60 chars, states the knowledge itself (not the task)",
 "summary": "one or two short sentences a future agent can act on",
 "topic": one topic key from the TOPIC TABLE,
 ...the kind's own fields at the top level (below)...,
 "anchors": {"paths": [repo-relative file paths named in the case], "commits": [commit shas named in the case]},
 "sources": [{"ref": "L12", "quote": "exact words copied from line L12"}],
 "verified": true if the case shows it confirmed by a command or result, false if it is only claimed}
The kind's own fields (all required; be terse: each text field is one short sentence, <= 60 Chinese characters or 30 English words):
- principle: "statement", "rationale"
- convention: "rule", "scope": ["where it applies"], "exceptions" ("" if none)
- decision: "context", "decision", "alternatives": [{"option": "...", "whyRejected": "..."}], "consequences", "decidedAt": "YYYY-MM-DD"
- pitfall: "trigger": {"paths": [...], "commands": [...], "errorSignature": "..."} (at least one non-empty; [] for an empty list), "symptom", "cause", "fix"
- recipe: "steps": ["..."], "verify": {"command": "...", "expectedExit": 0}
- concept: "definition", "boundaries"
RULES:
- sources: 1 or 2 per entry. The quote is a contiguous span copied character for character from the line with that ref (<= 150 chars, no "…", no paraphrase, no translation). Quote the words the line carries from its record, never the case file's own markers ("$ ", "→ ok:", "ERR:", "(steer)", "…[cut]", "×N"). Never quote a span holding [redacted]. Prefer spans without double-quote characters; if one is unavoidable, escape it as \".
- Write titles and text fields in the language the owner uses in the case (usually Chinese); keep code, paths and commands verbatim.
- Only put a path in anchors if it appears in the case and is a path of this repository; never invent paths or shas.

TOPIC TABLE:
` + topics.String() + `
EXAMPLE (a fictional repository, for format only):
CASE: 修复上传测试偶发失败
task · 1 session(s) · 2025-03-02 → 2025-03-02 · task status DONE · completion EXECUTABLE

L1 meta: ── session 1 · 2025-03-02 09:10 · claude ──
L2 taskprompt: 请开始执行任务「修复上传测试偶发失败」。任务描述：CI 上 upload.spec.ts 偶发超时。
   … (3 lines omitted)
L6 tool: $ npm test -w api -- upload.spec.ts → ERR: Exit code 1 … Error: connect ECONNREFUSED 127.0.0.1:9000
L7 think: Turns out STORAGE_PORT is read when the module is imported, before the fixture sets it.
L8 tool: edit src/api/test/storage-fixture.ts → ok
L9 tool: $ npm test -w api -- upload.spec.ts → ok: 14 passing
L10 owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。
L11 agent: 好的。根因：STORAGE_PORT 在模块导入时就被读取，fixture 之后才设置，所以测试连到了默认的 9000。已改成 fixture 返回 url。
OUTPUT:
[{"kind":"pitfall","title":"STORAGE_PORT 在导入时读取，fixture 之后再设无效","summary":"测试里改 STORAGE_PORT 必须在 import 之前，否则连到默认 9000 报 ECONNREFUSED。","topic":"testing","trigger":{"paths":["src/api/test/storage-fixture.ts"],"commands":["npm test -w api -- upload.spec.ts"],"errorSignature":"connect ECONNREFUSED 127.0.0.1:9000"},"symptom":"上传测试偶发 ECONNREFUSED 127.0.0.1:9000","cause":"STORAGE_PORT 在模块导入时读取，fixture 设置得太晚","fix":"fixture 返回 url，测试从返回值取地址","anchors":{"paths":["src/api/test/storage-fixture.ts"],"commits":[]},"sources":[{"ref":"L6","quote":"Error: connect ECONNREFUSED 127.0.0.1:9000"},{"ref":"L11","quote":"STORAGE_PORT 在模块导入时就被读取，fixture 之后才设置"}],"verified":true},
 {"kind":"convention","title":"测试 fixture 不写死端口，从返回值取","summary":"写测试 fixture 时端口一律从 fixture 返回值获取。","topic":"testing","rule":"fixture 里不要写死端口，一律从 fixture 的返回值里取","scope":["测试 fixture"],"exceptions":"","anchors":{"paths":[],"commits":[]},"sources":[{"ref":"L10","quote":"以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。"}],"verified":false}]

A case with only routine progress (edits, a passing test, "done") -> []
A case about something other than the repository above -> {"offTopic": true}

==== CASE FILE ====
` + dossier + `
==== END OF CASE FILE ====
Output the JSON array now.`
}

// wikiMaintainBashEnv lets the maintenance session's one Bash call — `orbit wiki maintain` — run to its end.
// Claude Code gives a command two minutes and then moves it to the background, where a run whose only
// tool is that shell, with no Read to follow the output file, could never learn how it ended: so the
// default and the most a command may ask for are the whole run's budget, and background tasks are off.
func wikiMaintainBashEnv() []string {
	budget := strconv.FormatInt(wikiMaintainRunBudget.Milliseconds(), 10)
	return []string{
		"BASH_DEFAULT_TIMEOUT_MS=" + budget,
		"BASH_MAX_TIMEOUT_MS=" + budget,
		"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
	}
}

// ── The commands ────────────────────────────────────────────────────────────────────────────────

func cliWikiMaintain(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki maintain")
	space := fs.String("space", "", "the space this maintenance run maintains")
	model := fs.String("model", "", "the model to extract with")
	concurrency := fs.Int("concurrency", 0, "model calls in flight at once while extracting")
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
	if flagWasSet(fs, "concurrency") && (*concurrency < 1 || *concurrency > 16) {
		return fmt.Errorf("--concurrency must be a whole number from 1 to 16: the model calls in flight at once")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	summary, runErr := runWikiMaintain(t, ctx.sessionID, spaceID, wikiMaintainOptions{model: *model, concurrency: *concurrency}, progress)
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiMaintainSummary(summary))
	}
	return runErr
}

// describeWikiMaintainSummary is the run in a few lines: what the maintenance session reports.
func describeWikiMaintainSummary(s wikiMaintainSummary) string {
	var b strings.Builder
	r := s.Report
	fmt.Fprintf(&b, "Wiki maintenance run of space %s: %s.", s.SpaceID, s.Outcome)
	if s.Error != "" {
		fmt.Fprintf(&b, " Stopped at %s.", s.Error)
	}
	fmt.Fprintf(&b, "\n- sessions: %d read, %d dossiers extracted from, %d already processed, %d off topic",
		r.Sessions, r.Dossiers, r.Unchanged, r.OffTopic)
	fmt.Fprintf(&b, "\n- entries: %d extracted, %d kept, %d dropped by the checks, %d anchored outside the repository, %d principles set aside",
		r.Entries.Extracted, r.Entries.Kept, r.Entries.Dropped, r.Entries.Foreign, r.Entries.Principles)
	fmt.Fprintf(&b, "\n- ops: %d proposed, %d recorded (%d applied, %d waiting), %d refused, %d dropped by the self-check, %d held back by the review queue, %d held back by the breaker",
		r.Ops.Proposed, r.Ops.Recorded, r.Ops.Applied, r.Ops.Waiting, r.Ops.Refused, r.Ops.SelfCheckDropped, r.Ops.HeldBack, r.Ops.HeldBackByBreaker)
	if r.Verification != nil {
		fmt.Fprintf(&b, "\n- verification: %d verified, %d without a verdict", r.Verification.Verified, r.Verification.Failed)
		if a := r.Verification.Adopted; a != nil {
			fmt.Fprintf(&b, "\n- adopted: %d ops ended sessions left waiting for their verification, %d verified, %d without a verdict",
				a.Ops, a.Verified, a.Failed)
		}
		if n := r.Verification.WaitingForNextRun; n > 0 {
			fmt.Fprintf(&b, "\n- waiting for the next run: %s without a verdict, not live; the next run adopts %s",
				wikiCount(n, "op", "ops"), wikiPronoun(n))
		}
	}
	if r.Anchors != nil {
		fmt.Fprintf(&b, "\n- anchors: %d entries re-verified, %d changed, %d missing", r.Anchors.Entries, r.Anchors.Changed, r.Anchors.Missing)
	}
	if d := r.Docs; d != nil {
		b.WriteString(describeWikiMaintainDocs(d))
	}
	fmt.Fprintf(&b, "\n- tokens: %d in, %d out, over %d model calls to %s; %d seconds", r.Tokens.Input, r.Tokens.Output, r.Tokens.Calls,
		firstNonEmpty(s.Model, "the local model"), r.Seconds)
	for _, refused := range s.Refused {
		fmt.Fprintf(&b, "\n- refused: %s", refused)
	}
	switch {
	case s.Outcome == "succeeded" && s.Advanced:
		fmt.Fprintf(&b, "\nThe cursor advanced to %s.", s.Cursor)
	case s.Outcome == "succeeded":
		b.WriteString("\nThe cursor already stood there: nothing new was covered.")
	case r.CursorAdvanced:
		b.WriteString("\nThe cursor had moved past the sessions whose ops the run recorded before it failed: the next run does " +
			"not read them again.")
	default:
		b.WriteString("\nThe cursor did not move: the next run reads the same dossiers again.")
	}
	if s.Outcome == "succeeded" && r.Ops.HeldBackByBreaker > 0 {
		b.WriteString(" The breaker held back what the run had no room for: the next run reads those dossiers again.")
	}
	switch {
	case s.ServerGone:
		next := "the next run takes the same dossiers"
		if r.CursorAdvanced {
			next = "the next run takes the dossiers after the sessions whose ops this one recorded"
		}
		fmt.Fprintf(&b, "\nThe Orbit server answered 5xx or nothing at all for %s: an infrastructure failure, not the run's. "+
			"Do not run it again in this session — %s.", wikiServerWait.budget, next)
	case s.Outcome != "succeeded" && s.FailureKind == "infra":
		b.WriteString("\nThe failure was the infrastructure's — the Orbit server or the model's endpoint — not the run's, and the " +
			"Orbit server answers again: the run may be run once more.")
	}
	return b.String()
}

// wikiMaintainCallError says what a refused start of the run came to.
func wikiMaintainCallError(spaceID string, err error) error {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.code() == wikiNotMaintenanceSessionCode {
		return fmt.Errorf("orbit wiki maintain: only a Wiki maintenance run of space %s runs it — a session whose task is in "+
			"the space's hidden «Wiki maintenance» list — and this session is not one (%s). Nothing was read or proposed",
			spaceID, wikiNotMaintenanceSessionCode)
	}
	return wikiMaintenanceCallError("orbit wiki maintain", spaceID, "--to", err)
}

// wikiMaintainCheck is `GET …/maintenance/check`'s answer.
type wikiMaintainCheck struct {
	SpaceID  string `json:"spaceId"`
	Expect   string `json:"expect"`
	Position string `json:"position"`
	Reached  bool   `json:"reached"`
	Run      *struct {
		TaskID     string `json:"taskId"`
		SessionID  string `json:"sessionId"`
		Outcome    string `json:"outcome"`
		OpsRefused *int   `json:"opsRefused"`
		EndedAt    string `json:"endedAt"`
	} `json:"run"`
	OK       bool     `json:"ok"`
	Problems []string `json:"problems"`
}

// cliWikiCheck is the maintenance task's acceptance command. It needs no session, and exits non-zero
// unless the server says the run did what its task expected.
func cliWikiCheck(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit wiki check")
	space := fs.String("space", "", "the space the maintenance task maintains")
	expect := fs.String("expect-cursor", "", "the cursor token the task was made with")
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
	token := strings.TrimSpace(*expect)
	if token == "" {
		return fmt.Errorf("--expect-cursor is required: the cursor token the maintenance task was made with")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.checkWikiMaintenance(spaceID, token)
	if err != nil {
		return wikiMaintenanceCallError("orbit wiki check", spaceID, "--expect-cursor", err)
	}
	var check wikiMaintainCheck
	if err := json.Unmarshal(raw, &check); err != nil {
		return fmt.Errorf("orbit wiki check: the server's answer is not the shape this build reads: %w", err)
	}
	if *jsonOut {
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiMaintainCheck(check))
	}
	if !check.OK {
		return fmt.Errorf("orbit wiki check: the maintenance run of space %s did not do what its task expected", spaceID)
	}
	return nil
}

func describeWikiMaintainCheck(c wikiMaintainCheck) string {
	if c.OK {
		return fmt.Sprintf("Space %s: the cursor reached the position the task expects, and the run ended succeeded with no op refused.", c.SpaceID)
	}
	lines := []string{fmt.Sprintf("Space %s: the maintenance run did not do what its task expected.", c.SpaceID)}
	for _, problem := range c.Problems {
		lines = append(lines, "- "+problem)
	}
	return strings.Join(lines, "\n")
}
