package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// `orbit wiki plan draft | revise | check`: a space's plan job, from the command line (contracts/wiki.contract.json
// `plan.jobs.cli`). draft and revise are the job's run alone — the session of the task the server made for
// the job, a maintenance session of the space — and check is that task's acceptance command, which runs
// with no session. None has an MCP tool beside it: they run a model, or judge a run.

// wikiPlanDraftPrecondition, wikiPlanRevisePrecondition and wikiPlanCheckPrecondition are
// contracts/wiki.contract.json `plan.jobs.cli`'s, word for word; wiki_plan_job_test.go holds them equal.
const wikiPlanDraftPrecondition = "Run this only as the plan job of the space, once, and let it finish: it drafts as the " +
	"space's maintenance run, and only a draft that passed the plan's gate is stored — three rounds at most, each handing " +
	"every error back to the model."

const wikiPlanRevisePrecondition = "Run this only as the plan job the owner's redraft made, once, and let it finish: it " +
	"revises the plan's newest version with the owner's instructions, and only a draft that passed the plan's gate is " +
	"stored — three rounds at most, each handing every error back to the model."

const wikiPlanCheckPrecondition = "Judge a plan job only by what this reads: it passes when the job's run stored a draft " +
	"that passed the plan's gate — or, a build's, wrote the documents of the confirmed version it was made for — and a run " +
	"cannot pass it by saying it finished."

var wikiPlanDraftDescription = wikiPlanDraftPrecondition + " This is a plan job's run, whole: it reads the job and the " +
	"plan as it stands, fetches the maintenance workspace's checkout, reads the repository at origin/main and what the " +
	"space's projects, sessions and entries say, has the local model — this session's provider's, through a clean Claude " +
	"Code with thinking off, its answers streamed to disk — draft the plan in four steps (the catalogue, each category's " +
	"documents, each document's outline and sources, a draft of the rules), gates it here (fields, count, protected " +
	"documents, and every file, docs section, symbol, project, topic and cross-reference) and then on the server, and " +
	"reports how the job ended. It prints the documents, the gate rounds with their errors, the token spend and the time, " +
	"and exits non-zero when no draft passed. Any session but the job's is refused."

var wikiPlanReviseDescription = wikiPlanRevisePrecondition + " This is a revision's run: the same as a draft's, but from " +
	"the plan's newest version and the owner's instructions (--instructions, else the job's own) — the model writes the " +
	"new catalogue with what each document is made from and the convention sections it moves into the agents' category, " +
	"then rewrites only the documents that merge or are new. A protected document is carried as it is, and a move out of " +
	"one, or of a section that is not a convention, is refused by the gate."

var wikiPlanCheckDescription = wikiPlanCheckPrecondition + " This is a plan job's acceptance command: it asks the server " +
	"whether the job --job of --space ended succeeded with a version of the space's plan, and exits 0 only then — " +
	"non-zero otherwise, with each reason a sentence. It reads and writes nothing else, and needs no session."

const wikiPlanHelp = `orbit wiki plan — draft or revise a space's plan as its plan job, and check what a job did

Usage:
  orbit wiki plan draft --space <id> [--target MIN-MAX] [--model MODEL] [--concurrency N] [--work-dir DIR] [--json]
  orbit wiki plan revise --space <id> [--instructions <file>] [--target MIN-MAX] [--model MODEL] [--concurrency N]
                         [--work-dir DIR] [--json]
  orbit wiki plan check --space <id> --job <id> [--json]

Commands:
  draft                    Draft the space's plan: the catalogue, each category's documents, each document's
                           outline and sources, a draft of the rules — one clean Claude Code call to the local
                           model a unit, its answer streamed to disk — gated here, then on the server; every
                           error goes back to the model, three rounds at most.
  revise                   Revise the plan's newest version with the owner's instructions: a new catalogue,
                           then the documents that merge or are new, gated the same way.
  check                    A plan job's acceptance command: 0 when the job stored a draft that passed the gate.

Options:
  --space ID               The space whose plan the job drafts. Required
  --target MIN-MAX         The document count the draft is held to, e.g. 20-35 (1 to 200). Default: the version
                           revised's, else 20-35
  --instructions FILE      revise: the owner's instructions, read from FILE ('-' reads stdin). Default: the job's
                           own, which the owner's redraft saved with it
  --model MODEL            The model to draft with. Default: ANTHROPIC_MODEL, the model this session's provider names
  --concurrency N          Model calls in flight at once, 1-16. Default 4
  --work-dir DIR           Where every answer, stream and draft of the run is kept, and a rerun of the same job
                           picks up what it finds. Default: under the runner's home, one a job
  --job ID                 check: the plan job the task was made for. Required
  --json                   Emit compact JSON

draft and revise run only in the session of the task the server made for a plan job — a Wiki maintenance
run of the space — and are refused to any other (WIKI_NOT_MAINTENANCE_SESSION, or WIKI_PLAN_NO_JOB for a
maintenance run whose task was made for no job). They wait for the model endpoint's /health, stop at the
first 401, print what they did — the documents, the gate rounds and their errors, the token spend and the
time — and exit non-zero when no draft passed. check needs no session.
`

// wikiPlanCLICapabilities are the plan's three verbs, beside the wiki's others (wikiCLICapabilities).
var wikiPlanCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "wiki_plan_draft",
		Argv:  []string{"orbit", "wiki", "plan", "draft"},
		Usage: "orbit wiki plan draft --space <id> [--target MIN-MAX] [--model MODEL] [--concurrency N] [--work-dir DIR] [--json]",
		Arguments: []string{
			"--space <id> (required; the space whose plan the job drafts)",
			"--target <min-max> (the document count the draft is held to; default the version revised's, else 20-35)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--concurrency <n> (1-16 model calls in flight; default 4)",
			"--work-dir <dir> (where the run keeps its answers, streams and drafts)",
			"--json",
		},
		Description: wikiPlanDraftDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":       map[string]interface{}{"type": "string", "description": "The space whose plan the job drafts."},
				"target":      map[string]interface{}{"type": "string", "description": "The document count the draft is held to, MIN-MAX."},
				"model":       map[string]interface{}{"type": "string", "description": "The model to draft with; ANTHROPIC_MODEL when left out."},
				"concurrency": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 16, "description": "Model calls in flight at once."},
				"work-dir":    map[string]interface{}{"type": "string", "description": "Where the run keeps its answers, streams and drafts."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:  "wiki_plan_revise",
		Argv:  []string{"orbit", "wiki", "plan", "revise"},
		Usage: "orbit wiki plan revise --space <id> [--instructions <file>] [--target MIN-MAX] [--model MODEL] [--concurrency N] [--work-dir DIR] [--json]",
		Arguments: []string{
			"--space <id> (required; the space whose plan the job revises)",
			"--instructions <file> (the owner's instructions; '-' reads stdin; default the job's own)",
			"--target <min-max> (the document count the draft is held to; default the version revised's)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--concurrency <n> (1-16 model calls in flight; default 4)",
			"--work-dir <dir> (where the run keeps its answers, streams and drafts)",
			"--json",
		},
		Description: wikiPlanReviseDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":        map[string]interface{}{"type": "string", "description": "The space whose plan the job revises."},
				"instructions": map[string]interface{}{"type": "string", "description": "A file with the owner's instructions; the job's own when left out."},
				"target":       map[string]interface{}{"type": "string", "description": "The document count the draft is held to, MIN-MAX."},
				"model":        map[string]interface{}{"type": "string", "description": "The model to draft with; ANTHROPIC_MODEL when left out."},
				"concurrency":  map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 16, "description": "Model calls in flight at once."},
				"work-dir":     map[string]interface{}{"type": "string", "description": "Where the run keeps its answers, streams and drafts."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:  "wiki_plan_check",
		Argv:  []string{"orbit", "wiki", "plan", "check"},
		Usage: "orbit wiki plan check --space <id> --job <id> [--json]",
		Arguments: []string{
			"--space <id> (required; the space the plan job drafts for)",
			"--job <id> (required; the plan job the task was made for)",
			"--json",
		},
		Description: wikiPlanCheckDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space": map[string]interface{}{"type": "string", "description": "The space the plan job drafts for."},
				"job":   map[string]interface{}{"type": "string", "description": "The plan job the task was made for."},
			},
			"required": []string{"space", "job"},
		},
	},
}

// ── The routes ──────────────────────────────────────────────────────────────────────────────────

// A plan's materials read every project and ninety days of sessions: heavier than the plan's other reads.
const wikiPlanReadTimeout = 2 * time.Minute

func (t *Transport) wikiPlanJobContext(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiPlanPath(spaceID)+"/job", nil, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

func (t *Transport) progressWikiPlanJob(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	// The round the run is on, said again, changes nothing: it may land twice.
	_, err := t.doWiki(http.MethodPost, wikiPlanPath(spaceID)+"/job/progress", body, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

func (t *Transport) finishWikiPlanJob(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	// The job ends once; the same end said again by its run is answered with what was kept: it may land twice.
	_, err := t.doWiki(http.MethodPost, wikiPlanPath(spaceID)+"/job/finish", body, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

func (t *Transport) wikiPlanMaterials(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiPlanPath(spaceID)+"/materials", nil, &out, wikiPlanReadTimeout, sessionHeader(sessionID), true)
	return out, err
}

// checkWikiPlanJob is the headless check: a task's acceptance command runs with no session.
func (t *Transport) checkWikiPlanJob(spaceID, jobID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiPlanPath(spaceID)+"/check?jobId="+url.QueryEscape(jobID), nil, &out, wikiPlanTimeout, nil, true)
	return out, err
}

// wikiPlanNoJobCode is the refusal a run's job routes give a session with no job, or a job that ended.
const wikiPlanNoJobCode = "WIKI_PLAN_NO_JOB"

// wikiPlanCallError says what a call to the plan's routes came to.
func wikiPlanCallError(command, spaceID string, err error) error {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("%s: %w", command, err)
	}
	switch code := httpErr.code(); {
	case code == wikiNotMaintenanceSessionCode:
		return fmt.Errorf("%s: only the plan job of space %s runs it — the session of the task the server made for a draft "+
			"of the space's plan, a Wiki maintenance run of the space — and this session is not one (%s). Nothing was read "+
			"or drafted", command, spaceID, code)
	case code == wikiPlanNoJobCode:
		return fmt.Errorf("%s: %s (%s). Nothing was drafted", command, refusalMessageOf(err), code)
	case code == wikiPlanStaleCode:
		return fmt.Errorf("%s: the plan changed while the draft was written (%s: %s): nothing was stored; the owner asks for "+
			"another draft", command, code, refusalMessageOf(err))
	case httpErr.statusCode == http.StatusNotFound && strings.Contains(httpErr.body, "no such plan job"):
		return fmt.Errorf("%s: space %s has no such plan job (404): check --job", command, spaceID)
	case wikiMaintenanceDoorMissing(err):
		return fmt.Errorf("%s: this Orbit server has no plan jobs yet (it answered 404 for %s /api%s): upgrade the Orbit server",
			command, httpErr.method, strings.SplitN(httpErr.path, "?", 2)[0])
	}
	return wikiMaintenanceCallError(command, spaceID, "--space", err)
}

// ── The commands ────────────────────────────────────────────────────────────────────────────────

// cliWikiPlan is `orbit wiki plan <draft|revise|check>`.
func cliWikiPlan(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || wantsHelp(args) && len(args) == 1 {
		_, err := fmt.Fprint(out, wikiPlanHelp)
		return err
	}
	verb := args[0]
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, wikiPlanHelp)
		return err
	}
	switch verb {
	case "check":
		return cliWikiPlanCheck(args[1:], out)
	case "draft", "revise":
		ctx, err := wikiCLIContext("orbit wiki plan " + verb)
		if err != nil {
			return err
		}
		return cliWikiPlanRun(verb, args[1:], in, out, ctx)
	}
	return fmt.Errorf("unknown plan command %q: its commands are draft, revise and check, as in "+
		"'orbit wiki plan draft --space <id>'\n\n%s", verb, wikiPlanHelp)
}

// wikiPlanTarget reads --target: MIN-MAX, within the ceiling the server holds a target to.
func wikiPlanTarget(raw string) (*wikiPlanLength, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	lo, hi, ok := strings.Cut(strings.NewReplacer("–", "-", "—", "-", "..", "-").Replace(raw), "-")
	min, err1 := strconv.Atoi(strings.TrimSpace(lo))
	max, err2 := strconv.Atoi(strings.TrimSpace(hi))
	if !ok || err1 != nil || err2 != nil || min < 1 || max < min || max > 200 {
		return nil, fmt.Errorf("--target is MIN-MAX, two whole numbers from 1 to 200 with MIN not above MAX, as in 20-35")
	}
	return &wikiPlanLength{Min: min, Max: max}, nil
}

func cliWikiPlanRun(verb string, args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki plan " + verb)
	space := fs.String("space", "", "the space whose plan the job drafts")
	target := fs.String("target", "", "the document count the draft is held to, MIN-MAX")
	model := fs.String("model", "", "the model to draft with")
	concurrency := fs.Int("concurrency", 4, "model calls in flight at once")
	workDir := fs.String("work-dir", "", "where the run keeps its answers, streams and drafts")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var instructionsFile *string
	if verb == "revise" {
		instructionsFile = fs.String("instructions", "", "the owner's instructions, from a file ('-' for stdin)")
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID := strings.TrimSpace(*space)
	if spaceID == "" {
		return fmt.Errorf("--space is required: the space whose plan the job drafts")
	}
	if err := validatePathSegmentID(spaceID); err != nil {
		return fmt.Errorf("--space %w", err)
	}
	limits, err := wikiPlanTarget(*target)
	if err != nil {
		return err
	}
	if *concurrency < 1 || *concurrency > 16 {
		return fmt.Errorf("--concurrency must be from 1 to 16")
	}
	opts := wikiPlanOptions{kind: verb, target: limits, model: *model, concurrency: *concurrency, workDir: *workDir}
	if instructionsFile != nil && strings.TrimSpace(*instructionsFile) != "" {
		var raw []byte
		if *instructionsFile == "-" {
			raw, err = io.ReadAll(in)
		} else {
			raw, err = os.ReadFile(*instructionsFile)
		}
		if err != nil {
			return fmt.Errorf("--instructions: %w", err)
		}
		if strings.TrimSpace(string(raw)) == "" {
			return fmt.Errorf("--instructions %s is empty: a revision needs the owner's instructions", *instructionsFile)
		}
		opts.instructions = string(raw)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	summary, runErr := runWikiPlan(t, ctx.sessionID, spaceID, opts, progress)
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiPlanSummary(summary))
	}
	return runErr
}

// describeWikiPlanSummary is what the run did, as the job's session reports it: the documents, the gate
// rounds and their errors, the token spend and the time.
func describeWikiPlanSummary(s wikiPlanSummary) string {
	var b strings.Builder
	what := "draft"
	if s.Kind == "revise" {
		what = "revision"
	}
	rep := s.Report
	if s.Outcome == "succeeded" && s.Version != nil {
		fmt.Fprintf(&b, "Plan %s of space %s: stored as version %d — %d categories, %d documents, %d sections; passed the gate on "+
			"round %d of %d.\n", what, s.SpaceID, *s.Version, rep.Categories, rep.Docs, rep.Sections, len(rep.Attempts), wikiPlanAttemptsMax)
	} else {
		fmt.Fprintf(&b, "Plan %s of space %s: failed — %s\n", what, s.SpaceID, s.Error)
		if rep.Docs > 0 {
			fmt.Fprintf(&b, "Its last draft: %d categories, %d documents, %d sections.\n", rep.Categories, rep.Docs, rep.Sections)
		}
	}
	for _, a := range rep.Attempts {
		switch {
		case a.Local > 0:
			fmt.Fprintf(&b, "  round %d: this runner's gate found %s (%s); not sent to the server\n", a.Attempt, wikiCount(a.Local, "error", "errors"), wikiPlanChecksLine(a.Checks))
		case a.Server > 0:
			fmt.Fprintf(&b, "  round %d: the server's gate found %s (%s)\n", a.Attempt, wikiCount(a.Server, "error", "errors"), wikiPlanChecksLine(a.Checks))
		default:
			fmt.Fprintf(&b, "  round %d: passed this runner's gate and the server's\n", a.Attempt)
		}
	}
	if len(s.Errors) > 0 {
		b.WriteString("The last round's errors:\n")
		for i, e := range s.Errors {
			if i == 30 {
				fmt.Fprintf(&b, "  …and %d more\n", len(s.Errors)-30)
				break
			}
			fmt.Fprintf(&b, "  %s\n", wikiPlanErrorLine(e))
		}
	}
	if rep.Repo != nil {
		fmt.Fprintf(&b, "References: %d checked at %s, %d not found.\n", rep.Repo.Checked, shortWikiHash(rep.Repo.Sha), rep.Repo.Missing)
	}
	fmt.Fprintf(&b, "Tokens: %d in, %d out, in %d calls to %s. Time: %s.", rep.Tokens.Input, rep.Tokens.Output, rep.Tokens.Calls,
		firstNonEmpty(rep.Model, "the model"), (time.Duration(rep.Seconds) * time.Second).String())
	if s.WorkDir != "" {
		fmt.Fprintf(&b, "\nWork directory: %s", s.WorkDir)
	}
	return b.String()
}

// wikiPlanCheckRead is `GET …/plan/check`'s answer.
type wikiPlanCheckRead struct {
	SpaceID  string   `json:"spaceId"`
	JobID    string   `json:"jobId"`
	Kind     string   `json:"kind"`
	Outcome  *string  `json:"outcome"`
	Version  *int     `json:"version"`
	OK       bool     `json:"ok"`
	Problems []string `json:"problems"`
}

// cliWikiPlanCheck is a plan job's acceptance command: no session, and non-zero unless the job stored a draft
// — or, a build, wrote the documents of the confirmed version it was made for.
func cliWikiPlanCheck(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit wiki plan check")
	space := fs.String("space", "", "the space the plan job drafts for")
	job := fs.String("job", "", "the plan job the task was made for")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID := strings.TrimSpace(*space)
	if spaceID == "" {
		return fmt.Errorf("--space is required: the space the plan job drafts for")
	}
	if err := validatePathSegmentID(spaceID); err != nil {
		return fmt.Errorf("--space %w", err)
	}
	jobID := strings.TrimSpace(*job)
	if jobID == "" {
		return fmt.Errorf("--job is required: the plan job the task was made for")
	}
	if err := validatePathSegmentID(jobID); err != nil {
		return fmt.Errorf("--job %w", err)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.checkWikiPlanJob(spaceID, jobID)
	if err != nil {
		return wikiPlanCallError("orbit wiki plan check", spaceID, err)
	}
	var check wikiPlanCheckRead
	if err := json.Unmarshal(raw, &check); err != nil {
		return fmt.Errorf("orbit wiki plan check: the server's answer is not the shape this build reads: %w", err)
	}
	if *jsonOut {
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else if check.Kind == "build" && check.OK && check.Version != nil {
		fmt.Fprintf(out, "Space %s: build job %s wrote the documents of confirmed version %d.\n", spaceID, jobID, *check.Version)
	} else if check.Kind == "build" {
		fmt.Fprintf(out, "Space %s: build job %s did not write the documents of the version it was made for.\n", spaceID, jobID)
		for _, problem := range check.Problems {
			fmt.Fprintf(out, "  %s\n", problem)
		}
	} else if check.OK && check.Version != nil {
		fmt.Fprintf(out, "Space %s: plan job %s stored version %d, which passed the plan's gate.\n", spaceID, jobID, *check.Version)
	} else {
		fmt.Fprintf(out, "Space %s: plan job %s did not store a draft that passed the plan's gate.\n", spaceID, jobID)
		for _, problem := range check.Problems {
			fmt.Fprintf(out, "  %s\n", problem)
		}
	}
	if !check.OK {
		return fmt.Errorf("orbit wiki plan check: plan job %s of space %s did not do what its task was made for", jobID, spaceID)
	}
	return nil
}
