package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// `orbit wiki import --from <dir|file> --space <id>`: a CLAUDE.md, an AGENTS.md or an agent's memory
// library into a space's wiki (contracts/wiki.contract.json `import`, criterion 1, design §8.3).
//
// EACH FILE IS ONE NOTE, AND THE MODEL READS WHAT THE SERVER KEPT. A file is registered first
// (`POST /api/runner/wiki/spaces/:id/notes`): the server redacts it — the shared redactor, with the
// owner's workspace.env values — before it keeps anything, and answers with the text it kept. That
// text, never the file as it was read, is what the model is handed, so no credential reaches the
// model and a quote it copies is checked against the very text it read. The same text twice is one
// note, so a file already imported is not proposed from again.
//
// THE ENTRIES ARE THE LOCAL MODEL'S. A clean Claude Code — the launch `orbit wiki verify` makes
// (wikiVerifyClaudeArgs, wikiVerifyEnv): --bare, an empty HOME and CLAUDE_CONFIG_DIR, no tool, no MCP
// server, an allowlisted environment and the token through an apiKeyHelper — with the importer's own
// system prompt and no thinking, is asked for at most six entries a file. What it answers is checked
// here the way the demo's extract.py checked it: the kind and its fields, the quote against the note,
// the anchors against this checkout. A principle is the owner's alone: it is counted, never proposed.
//
// WHAT TAKES EFFECT IS THE SPACE'S REVIEW MODE'S. The ops go to `POST .../imports`, origin import:
// Manual keeps them for Review, Tiered applies them Unreviewed, Automatic holds them for `orbit wiki
// verify`. A dry run goes first, and a run proposes at most thirty; an op refused for want of room —
// the review queue, a session's quota — waits for a later run, so Review is filled a batch at a time.
//
// A RUN PICKS UP WHERE THE LAST ONE STOPPED. What was registered, what the model found and what was
// proposed is kept on this machine ($ORBIT_HOME/wiki-import, or --state): no file goes to the model
// twice, and one whose text changed is imported as the new note it is.

// wikiImportPrecondition is contracts/wiki.contract.json `import.cli.precondition`, word for word, and
// wiki_import_test.go holds the two equal. It leads for the reason verify's does: the one thing a
// reader must not do here — write the entries itself — is the one the mechanics make easy.
const wikiImportPrecondition = "Import only the files the owner asked for, into the space they named, and never write an " +
	"entry yourself: each entry is the local model's, read from a separate clean call over the file's redacted text, " +
	"and it takes effect only as the space's review mode says."

const wikiImportDescription = wikiImportPrecondition + " Each Markdown file under --from (a directory's *.md files, " +
	"its MEMORY.md index left out, or one file) is registered as a note of --space, the server keeping only its " +
	"redacted text, and one clean Claude Code call to the model this session's provider names (ANTHROPIC_MODEL at " +
	"ANTHROPIC_BASE_URL, with the token in ANTHROPIC_AUTH_TOKEN) reads that text and proposes at most six entries from " +
	"it. A principle is never proposed: it is the owner's to write. The run's ops are checked with a dry run and " +
	"proposed with origin import — at most 30 a run — and take effect as the space's review mode says: Manual keeps them " +
	"for Review, Tiered applies them as Unreviewed, Automatic waits for orbit wiki verify. An op refused for want of room " +
	"waits for the next run, and the run remembers where it stopped: run it again to go on. It waits for the endpoint's " +
	"/health before its first call and stops at the first 401."

// wikiImportSystemPrompt is the whole system prompt the clean call carries.
const wikiImportSystemPrompt = "You compile durable engineering knowledge from one note about a code repository into " +
	"wiki entries. You output only a JSON array."

// The contract's numbers (`import.rules`); wiki_import_test.go holds them to it.
const (
	wikiImportEntriesPerNote = 6
	wikiImportOpsPerRun      = 30
	wikiImportNoteMaxChars   = 100_000
	wikiImportMaxConcurrency = 8
	// A model call on a long note is slow; one that takes longer than this counts the file as failed.
	wikiImportCallTimeout = 15 * time.Minute
	// A quote is at most this many characters (limits.quoteMaxChars).
	wikiImportQuoteMaxChars = 300
)

// How long a run waits for the endpoint's /health before its first call, and how often it asks. The
// tunnel the local model sits behind drops and comes back; tests shorten both.
var (
	wikiImportHealthWait = 10 * time.Minute
	wikiImportHealthPoll = 10 * time.Second
)

// wikiImportKinds are the kinds the model may write. A principle is the owner's (contract
// `reviewModes.floors.principleOwnerOnly`), so it is not among them.
var wikiImportKinds = []string{"convention", "decision", "pitfall", "recipe", "concept"}

const wikiImportHelp = `orbit wiki import — have the local model turn CLAUDE.md, AGENTS.md or a memory library into wiki entries

Usage:
  orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--model MODEL]
                    [--state FILE] [--json]

Options:
  --from PATH              A Markdown file, or a directory whose *.md files are imported (its
                           MEMORY.md index left out). Required
  --space ID               The space to import into. Required
  --max-ops N              The ops this run proposes at most, 1 to 30. Default: 30
  --concurrency N          The files the model reads at once, 1 to 8. Default: 4
  --model MODEL            The model to read with. Default: ANTHROPIC_MODEL, the model this
                           session's provider names, at its ANTHROPIC_BASE_URL
  --state FILE             Where this machine remembers the import. Default: a file under
                           $ORBIT_HOME/wiki-import named for the space and --from
  --json                   Print the run's summary as JSON

` + wikiImportPrecondition + `

Each file is registered as a note of the space; the server keeps only its redacted text and hands
that back, and a clean Claude Code (--bare, no tools, no MCP server, an empty HOME and
CLAUDE_CONFIG_DIR, the token from ANTHROPIC_AUTH_TOKEN through an apiKeyHelper, no thinking) reads
it and answers at most six entries citing the note. A directory's files go in the order their
frontmatter gives them — feedback, user, reference, project, then the rest — each group by name. A
file whose text the space already holds is not proposed from again; a principle is counted and
never proposed. The run checks its ops with a dry run and proposes at most --max-ops with origin
import, which take effect as the space's review mode says. An op refused for want of room (the
review queue, a session's quota) waits for the next run: run it again, and it picks up where it
stopped. It waits for the endpoint's /health before its first call, stops at the first 401, and
exits non-zero when it could propose nothing for want of room.
`

// wikiImportCLICapabilities is the import's own family table: `orbit wiki import` has no MCP tool
// beside it (contract `import.cli.tool`), so its description and schema are its own, and it acts for
// the session it runs in like every wiki verb.
var wikiImportCLICapabilities = []cliCapabilitySpec{{
	Tool:  "wiki_import",
	Argv:  []string{"orbit", "wiki", "import"},
	Usage: "orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--model MODEL] [--state FILE] [--json]",
	Arguments: []string{
		"--from <dir|file> (required; a Markdown file, or a directory of them)",
		"--space <id> (required; the space to import into)",
		"--max-ops <n> (1-30; default 30)",
		"--concurrency <n> (1-8; default 4)",
		"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
		"--state <file> (default under $ORBIT_HOME/wiki-import)",
		"--json",
	},
	Description: wikiImportDescription,
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"from":        map[string]interface{}{"type": "string", "description": "A Markdown file, or a directory whose *.md files are imported."},
			"space":       map[string]interface{}{"type": "string", "description": "The space to import into."},
			"max-ops":     map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiImportOpsPerRun, "description": "The ops this run proposes at most."},
			"concurrency": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiImportMaxConcurrency, "description": "The files the model reads at once."},
			"model":       map[string]interface{}{"type": "string", "description": "The model to read with; ANTHROPIC_MODEL, the one this session's provider names, when left out."},
			"state":       map[string]interface{}{"type": "string", "description": "Where this machine remembers the import."},
		},
		"required": []string{"from", "space"},
	},
	Mutates:     true,
	SessionOnly: true,
}}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

type wikiImportOptions struct {
	from        string
	spaceID     string
	maxOps      int
	concurrency int
	statePath   string
	model       wikiVerifyConfig
	// Why there is no model to call, when there is none: said only once a file needs one.
	modelMissing error
}

func cliWikiImport(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki import")
	from := fs.String("from", "", "a Markdown file, or a directory of them")
	space := fs.String("space", "", "the space to import into")
	maxOps := fs.Int("max-ops", wikiImportOpsPerRun, "the ops this run proposes at most")
	concurrency := fs.Int("concurrency", 4, "the files the model reads at once")
	model := fs.String("model", "", "the model to read with")
	state := fs.String("state", "", "where this machine remembers the import")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID := strings.TrimSpace(*space)
	if spaceID == "" {
		return fmt.Errorf("--space is required: the space to import into")
	}
	if err := validatePathSegmentID(spaceID); err != nil {
		return fmt.Errorf("--space %w", err)
	}
	if strings.TrimSpace(*from) == "" {
		return fmt.Errorf("--from is required: a Markdown file, or a directory of them")
	}
	absFrom, err := filepath.Abs(strings.TrimSpace(*from))
	if err != nil {
		return fmt.Errorf("--from: %w", err)
	}
	if *maxOps < 1 || *maxOps > wikiImportOpsPerRun {
		return fmt.Errorf("--max-ops must be a whole number from 1 to %d: a run proposes at most one changeset's worth", wikiImportOpsPerRun)
	}
	if *concurrency < 1 || *concurrency > wikiImportMaxConcurrency {
		return fmt.Errorf("--concurrency must be a whole number from 1 to %d", wikiImportMaxConcurrency)
	}
	opts := wikiImportOptions{from: absFrom, spaceID: spaceID, maxOps: *maxOps, concurrency: *concurrency, statePath: strings.TrimSpace(*state)}
	if opts.statePath == "" {
		opts.statePath = wikiImportDefaultState(spaceID, absFrom)
	}
	opts.model, opts.modelMissing = wikiImportModelFromEnv(*model)
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	summary, runErr := runWikiImport(t, ctx.sessionID, opts, progress)
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(out, describeWikiImportSummary(summary))
	}
	if runErr != nil {
		return runErr
	}
	if summary.Stopped != "" {
		return fmt.Errorf("stopped: %s", summary.Stopped)
	}
	return nil
}

// wikiImportModelFromEnv reads the endpoint, the token and the model the session's provider injected,
// as `orbit wiki verify` does (contract `import.cli.model`). --model names another model on the same
// endpoint.
func wikiImportModelFromEnv(model string) (wikiVerifyConfig, error) {
	cfg := wikiVerifyConfig{
		baseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("ANTHROPIC_BASE_URL")), "/"),
		token:   strings.TrimSpace(os.Getenv("ANTHROPIC_AUTH_TOKEN")),
		model:   firstNonEmpty(strings.TrimSpace(model), strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))),
	}
	switch {
	case cfg.baseURL == "":
		return cfg, fmt.Errorf("orbit wiki import reads each file with the model this session's provider names, and this " +
			"session's environment names no endpoint (ANTHROPIC_BASE_URL): run it in a session on the local model's provider")
	case cfg.token == "":
		return cfg, fmt.Errorf("orbit wiki import reads the model endpoint's token from ANTHROPIC_AUTH_TOKEN, which is not set " +
			"in this session: run it in a session on the local model's provider")
	case cfg.model == "":
		return cfg, fmt.Errorf("orbit wiki import needs the model to read with: ANTHROPIC_MODEL, which this session's " +
			"provider names, is not set — pass --model")
	}
	return cfg, nil
}

// wikiImportDefaultState is where a machine remembers an import: one file per space and --from.
func wikiImportDefaultState(spaceID, from string) string {
	sum := sha256.Sum256([]byte(from))
	return filepath.Join(machineHome(), "wiki-import", spaceID+"-"+hex.EncodeToString(sum[:])[:12]+".json")
}

// ── What a run did ──────────────────────────────────────────────────────────────────────────────

// wikiImportSummary is what a run did, and what `--json` prints.
type wikiImportSummary struct {
	SpaceID string `json:"spaceId"`
	From    string `json:"from"`
	Model   string `json:"model"`
	State   string `json:"state"`
	// The files --from covers, and of them the ones not done yet after this run.
	Files     int `json:"files"`
	Remaining int `json:"remaining"`
	// This run's files: registered as a new note, found to hold a text the space already had, and
	// left out (too long, not text, empty, refused by the server).
	NewNotes   int `json:"newNotes"`
	KnownNotes int `json:"knownNotes"`
	Skipped    int `json:"skipped"`
	// What the model gave this run: entries kept, principles not proposed, entries that did not
	// hold up, and files it gave nothing readable for.
	Entries    int `json:"entries"`
	Principles int `json:"principles"`
	Dropped    int `json:"dropped"`
	Failed     int `json:"failed"`
	// This run's proposal: recorded (as each took effect), refused for what they say, and left for a
	// later run for want of room.
	Proposed  int `json:"proposed"`
	Applied   int `json:"applied"`
	Pending   int `json:"pending"`
	Verifying int `json:"verifying"`
	Refused   int `json:"refused"`
	Deferred  int `json:"deferred"`
	// The model's cost this run.
	Calls        int     `json:"calls"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	Seconds      float64 `json:"seconds"`
	// Every op refused this run, and why; and, when the run could propose nothing for want of room,
	// what stopped it.
	Refusals []wikiImportRefusal `json:"refusals"`
	Stopped  string              `json:"stopped,omitempty"`
}

type wikiImportRefusal struct {
	File  string `json:"file"`
	Title string `json:"title"`
	Code  string `json:"code"`
	Why   string `json:"why"`
}

func describeWikiImportSummary(s wikiImportSummary) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Imported from %s into space %s: %s registered as new notes, %s already in the space, %s left out.",
		s.From, s.SpaceID, wikiCount(s.NewNotes, "file", "files"), wikiCount(s.KnownNotes, "file", "files"), wikiCount(s.Skipped, "file", "files"))
	fmt.Fprintf(&b, "\nThe model found %s", wikiCount(s.Entries, "entry", "entries"))
	if s.Principles > 0 {
		fmt.Fprintf(&b, " (%s not proposed: a principle is the owner's to write)", wikiCount(s.Principles, "principle", "principles"))
	}
	if s.Dropped > 0 {
		fmt.Fprintf(&b, "; %s did not hold up", wikiCount(s.Dropped, "entry", "entries"))
	}
	if s.Failed > 0 {
		fmt.Fprintf(&b, "; for %s it gave nothing this import could read", wikiCount(s.Failed, "file", "files"))
	}
	b.WriteString(".")
	fmt.Fprintf(&b, "\nProposed %s: %d applied, %d wait for the owner's review, %d wait for their verification (orbit wiki verify --space %s)",
		wikiCount(s.Proposed, "op", "ops"), s.Applied, s.Pending, s.Verifying, s.SpaceID)
	if s.Refused > 0 {
		fmt.Fprintf(&b, "; %d refused", s.Refused)
	}
	if s.Deferred > 0 {
		fmt.Fprintf(&b, "; %d left for the next run for want of room", s.Deferred)
	}
	b.WriteString(".")
	if s.Calls > 0 {
		fmt.Fprintf(&b, "\nModel %s: %s, %d tokens in and %d out, in %.0fs.", s.Model, wikiCount(s.Calls, "call", "calls"), s.InputTokens, s.OutputTokens, s.Seconds)
	}
	if s.Stopped != "" {
		fmt.Fprintf(&b, "\nStopped: %s.", s.Stopped)
	}
	if s.Remaining > 0 {
		fmt.Fprintf(&b, "\n%s still to import: run it again to go on.", wikiCount(s.Remaining, "file", "files"))
	} else {
		fmt.Fprintf(&b, "\nEvery file under %s is imported.", s.From)
	}
	return b.String()
}

// ── What this machine remembers ─────────────────────────────────────────────────────────────────

// wikiImportState is one import's memory on this machine (contract `import.cli.resume`), keyed by the
// note path of each file.
type wikiImportState struct {
	Version int                        `json:"version"`
	Space   string                     `json:"space"`
	From    string                     `json:"from"`
	Files   map[string]*wikiImportFile `json:"files"`
	// What every run of this import has cost so far.
	Calls        int `json:"calls"`
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	path         string
}

// wikiImportFile is one file, and how far the import has taken it.
type wikiImportFile struct {
	// The file as it was read: a different one is a new import of it.
	SHA256   string `json:"sha256"`
	NoteID   string `json:"noteId,omitempty"`
	NotePath string `json:"notePath,omitempty"`
	// registered → extracted → done; or skipped, or failed.
	Status     string         `json:"status"`
	Why        string         `json:"why,omitempty"`
	Ops        []wikiImportOp `json:"ops,omitempty"`
	Principles int            `json:"principles,omitempty"`
	Dropped    int            `json:"dropped,omitempty"`
}

// wikiImportOp is one op the model's answer became, and what became of it. An op with no outcome has
// not been proposed yet.
type wikiImportOp struct {
	Body    map[string]interface{} `json:"body"`
	Outcome string                 `json:"outcome,omitempty"`
	Why     string                 `json:"why,omitempty"`
	OpID    string                 `json:"opId,omitempty"`
	EntryID string                 `json:"entryId,omitempty"`
}

const (
	wikiImportRegistered = "registered"
	wikiImportExtracted  = "extracted"
	wikiImportDone       = "done"
	wikiImportSkipped    = "skipped"
	wikiImportFailed     = "failed"
)

func loadWikiImportState(path, spaceID, from string) (*wikiImportState, error) {
	state := &wikiImportState{Version: 1, Space: spaceID, From: from, Files: map[string]*wikiImportFile{}, path: path}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return nil, fmt.Errorf("orbit wiki import: reading what this machine remembers of the import (%s): %w", path, err)
	}
	var stored wikiImportState
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("orbit wiki import: %s is not an import's memory this build reads: %w", path, err)
	}
	if stored.Space != spaceID || stored.From != from {
		return nil, fmt.Errorf("orbit wiki import: %s remembers the import of %s into space %s, not of %s into %s: name another --state",
			path, stored.From, stored.Space, from, spaceID)
	}
	stored.path = path
	if stored.Files == nil {
		stored.Files = map[string]*wikiImportFile{}
	}
	return &stored, nil
}

// save writes the state whole and renames it into place, so a run killed half way leaves the last
// complete state behind rather than half of the next one.
func (s *wikiImportState) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ── The files ───────────────────────────────────────────────────────────────────────────────────

// wikiImportSource is one file --from covers.
type wikiImportSource struct {
	// The note's path: relative to the directory --from's directory sits in, so a memory library's file
	// reads `memory/<name>.md` and a single file its own name.
	rel  string
	abs  string
	rank int
	date string
}

// wikiImportTypeRank orders a memory library by what its frontmatter says a file is: the owner's own
// guidance first (contract `import.cli.files`).
var wikiImportTypeRank = map[string]int{"feedback": 0, "user": 1, "reference": 2, "project": 3}

// wikiImportIndexFile is a memory library's index: one line per other file, which would only repeat
// them.
const wikiImportIndexFile = "MEMORY.md"

func wikiImportSources(from string) ([]wikiImportSource, error) {
	info, err := os.Stat(from)
	if err != nil {
		return nil, fmt.Errorf("--from %s: %w", from, err)
	}
	if !info.IsDir() {
		source := wikiImportSource{rel: filepath.Base(from), abs: from}
		source.rank, source.date = wikiImportFrontmatter(from, info.ModTime())
		return []wikiImportSource{source}, nil
	}
	entries, err := os.ReadDir(from)
	if err != nil {
		return nil, fmt.Errorf("--from %s: %w", from, err)
	}
	base := filepath.Base(from)
	var sources []wikiImportSource
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == wikiImportIndexFile || !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		abs := filepath.Join(from, name)
		stat, err := os.Stat(abs)
		if err != nil || !stat.Mode().IsRegular() {
			continue
		}
		source := wikiImportSource{rel: base + "/" + name, abs: abs}
		source.rank, source.date = wikiImportFrontmatter(abs, stat.ModTime())
		sources = append(sources, source)
	}
	sort.SliceStable(sources, func(i, j int) bool {
		if sources[i].rank != sources[j].rank {
			return sources[i].rank < sources[j].rank
		}
		return sources[i].rel < sources[j].rel
	})
	return sources, nil
}

var (
	wikiImportTypeLine     = regexp.MustCompile(`^\s*type:\s*["']?([A-Za-z]+)`)
	wikiImportModifiedLine = regexp.MustCompile(`^\s*modified:\s*["']?(\d{4}-\d{2}-\d{2})`)
)

// wikiImportFrontmatter reads what a memory file's frontmatter says of it: its type's rank, and the
// date it was last modified (the file's own time, when it names none).
func wikiImportFrontmatter(path string, modTime time.Time) (int, string) {
	rank, date := len(wikiImportTypeRank), modTime.UTC().Format("2006-01-02")
	raw, err := os.ReadFile(path)
	if err != nil {
		return rank, date
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return rank, date
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		if m := wikiImportTypeLine.FindStringSubmatch(line); m != nil {
			if r, ok := wikiImportTypeRank[strings.ToLower(m[1])]; ok {
				rank = r
			}
		}
		if m := wikiImportModifiedLine.FindStringSubmatch(line); m != nil {
			date = m[1]
		}
	}
	return rank, date
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

// wikiImporter is one run: the files, the state, and the ops queued for this run's proposal.
type wikiImporter struct {
	t         *Transport
	sessionID string
	opts      wikiImportOptions
	state     *wikiImportState
	summary   *wikiImportSummary
	progress  io.Writer
	repo      *wikiImportRepo
	claude    string
	// The note's text as the server kept it, by file, for the files registered this run.
	texts map[string]string
	// The ops this run proposes, in file order.
	queue []wikiImportRef
	// The endpoint answered /health this run.
	endpointUp bool
}

type wikiImportRef struct {
	rel   string
	index int
}

// runWikiImport runs one import: registers and reads files until the run's ops are found, proposes
// them, and saves what it did. Progress lines go to progress as each file is read.
func runWikiImport(t *Transport, sessionID string, opts wikiImportOptions, progress io.Writer) (wikiImportSummary, error) {
	started := time.Now()
	summary := wikiImportSummary{SpaceID: opts.spaceID, From: opts.from, Model: opts.model.model, State: opts.statePath, Refusals: []wikiImportRefusal{}}
	sources, err := wikiImportSources(opts.from)
	if err != nil {
		return summary, err
	}
	state, err := loadWikiImportState(opts.statePath, opts.spaceID, opts.from)
	if err != nil {
		return summary, err
	}
	im := &wikiImporter{
		t: t, sessionID: sessionID, opts: opts, state: state, summary: &summary, progress: progress,
		repo: openWikiImportRepo(), texts: map[string]string{},
	}
	runErr := im.collect(sources)
	if runErr == nil {
		runErr = im.propose()
	}
	state.Calls += summary.Calls
	state.InputTokens += summary.InputTokens
	state.OutputTokens += summary.OutputTokens
	if err := state.save(); err != nil && runErr == nil {
		runErr = fmt.Errorf("orbit wiki import: remembering where this run stopped (%s): %w", state.path, err)
	}
	summary.Files = len(sources)
	for _, source := range sources {
		file := state.Files[source.rel]
		if file == nil || (file.Status != wikiImportDone && file.Status != wikiImportSkipped && file.Status != wikiImportFailed) {
			summary.Remaining++
		}
	}
	summary.Seconds = time.Since(started).Seconds()
	return summary, runErr
}

// collect walks the files in order until this run's ops are found: a file the model already read has
// its ops queued as they are, and the files it has not read are registered and read a wave at a time.
func (im *wikiImporter) collect(sources []wikiImportSource) error {
	var wave []wikiImportSource
	for _, source := range sources {
		if len(im.queue) >= im.opts.maxOps {
			break
		}
		file, err := im.reconcile(source)
		if err != nil {
			return err
		}
		switch file.Status {
		case wikiImportDone, wikiImportSkipped, wikiImportFailed:
			continue
		case wikiImportExtracted:
			// Read before, proposed in part: its ops go in their place, after the files before it.
			if err := im.flush(&wave); err != nil {
				return err
			}
			im.enqueue(source.rel)
			continue
		}
		wave = append(wave, source)
		if len(wave) >= im.opts.concurrency {
			if err := im.flush(&wave); err != nil {
				return err
			}
		}
	}
	return im.flush(&wave)
}

// reconcile is the file as the state knows it, begun again when its text is not the one remembered.
func (im *wikiImporter) reconcile(source wikiImportSource) (*wikiImportFile, error) {
	raw, err := os.ReadFile(source.abs)
	if err != nil {
		return nil, fmt.Errorf("orbit wiki import: reading %s: %w", source.abs, err)
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	file := im.state.Files[source.rel]
	if file == nil || file.SHA256 != digest {
		file = &wikiImportFile{SHA256: digest}
		im.state.Files[source.rel] = file
	}
	if file.Status != "" {
		return file, nil
	}
	text := string(raw)
	switch {
	case !utf8.ValidString(text):
		im.skip(source.rel, file, "it is not UTF-8 text")
	case strings.TrimSpace(text) == "":
		im.skip(source.rel, file, "it is empty")
	case utf8.RuneCountInString(text) > wikiImportNoteMaxChars:
		im.skip(source.rel, file, fmt.Sprintf("it is longer than a note may be (%d characters)", wikiImportNoteMaxChars))
	}
	return file, nil
}

func (im *wikiImporter) skip(rel string, file *wikiImportFile, why string) {
	file.Status, file.Why = wikiImportSkipped, why
	im.summary.Skipped++
	fmt.Fprintf(im.progress, "%s: left out — %s\n", rel, why)
}

// enqueue queues a file's ops that have not been proposed yet, up to what the run has room for.
func (im *wikiImporter) enqueue(rel string) {
	for index, op := range im.state.Files[rel].Ops {
		if len(im.queue) >= im.opts.maxOps {
			return
		}
		if op.Outcome == "" {
			im.queue = append(im.queue, wikiImportRef{rel: rel, index: index})
		}
	}
}

// flush registers a wave of files, has the model read the ones that are new notes at once, and
// queues what it found, in file order.
func (im *wikiImporter) flush(wave *[]wikiImportSource) error {
	sources := *wave
	*wave = nil
	if len(sources) == 0 {
		return nil
	}
	var reading []wikiImportSource
	for _, source := range sources {
		ok, err := im.register(source)
		if err != nil {
			return err
		}
		if ok {
			reading = append(reading, source)
		}
	}
	if len(reading) == 0 {
		return im.state.save()
	}
	if err := im.ready(); err != nil {
		return err
	}
	results := make([]wikiImportExtraction, len(reading))
	var wg sync.WaitGroup
	for i, source := range reading {
		wg.Add(1)
		go func(i int, source wikiImportSource) {
			defer wg.Done()
			results[i] = im.extract(source)
		}(i, source)
	}
	wg.Wait()
	var stop error
	for i, source := range reading {
		result := results[i]
		im.summary.Calls += result.calls
		im.summary.InputTokens += result.usage.input
		im.summary.OutputTokens += result.usage.output
		file := im.state.Files[source.rel]
		switch {
		case result.err != nil:
			// The endpoint refused or went away: the file stays registered, for the next run to read.
			if stop == nil {
				stop = result.err
			}
			continue
		case result.failed != "":
			file.Status, file.Why = wikiImportFailed, result.failed
			im.summary.Failed++
			fmt.Fprintf(im.progress, "%s: nothing read — %s\n", source.rel, result.failed)
			continue
		}
		file.Ops = result.ops
		file.Principles, file.Dropped = result.principles, result.dropped
		im.summary.Entries += len(result.ops)
		im.summary.Principles += result.principles
		im.summary.Dropped += result.dropped
		file.Status = wikiImportExtracted
		if len(result.ops) == 0 {
			file.Status = wikiImportDone
		}
		fmt.Fprintf(im.progress, "%s: %s\n", source.rel, describeWikiImportFile(file))
		if stop == nil {
			im.enqueue(source.rel)
		}
	}
	if err := im.state.save(); err != nil {
		return err
	}
	return stop
}

func describeWikiImportFile(file *wikiImportFile) string {
	if len(file.Ops) == 0 && file.Principles == 0 {
		return "nothing worth an entry"
	}
	line := wikiCount(len(file.Ops), "entry", "entries")
	if file.Principles > 0 {
		line += fmt.Sprintf(", %s not proposed (the owner's to write)", wikiCount(file.Principles, "principle", "principles"))
	}
	if file.Dropped > 0 {
		line += fmt.Sprintf(", %s that did not hold up", wikiCount(file.Dropped, "entry", "entries"))
	}
	return line
}

// wikiNoteAnswer is `POST .../notes`' answer (contract `import.note.answer`).
type wikiNoteAnswer struct {
	ID            string `json:"id"`
	Path          string `json:"path"`
	ContentSHA256 string `json:"contentSha256"`
	Redacted      bool   `json:"redacted"`
	Created       bool   `json:"created"`
	Text          string `json:"text"`
}

// register makes the file a note of the space and keeps the text the server kept. It answers false
// for a file not to be read: one whose text the space already holds under a note this import did not
// make, or one the server would not take.
func (im *wikiImporter) register(source wikiImportSource) (bool, error) {
	file := im.state.Files[source.rel]
	raw, err := os.ReadFile(source.abs)
	if err != nil {
		return false, fmt.Errorf("orbit wiki import: reading %s: %w", source.abs, err)
	}
	body := map[string]interface{}{"path": source.rel, "text": string(raw)}
	out, err := im.t.registerWikiNote(im.sessionID, im.opts.spaceID, body)
	if err != nil {
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusBadRequest && httpErr.code() == "WIKI_SCHEMA" {
			im.skip(source.rel, file, "the server would not take it as a note: "+refusalMessageOf(err))
			return false, nil
		}
		return false, wikiCallError("orbit wiki import", err)
	}
	var note wikiNoteAnswer
	if err := json.Unmarshal(out, &note); err != nil || note.ID == "" {
		return false, fmt.Errorf("orbit wiki import: the server's answer for a note is not the shape this build reads: %s", out)
	}
	if !note.Created && file.NoteID != note.ID {
		// The same text is a note of the space already: imported before, or the same text under another
		// name. Proposing from it again would only repeat what is there.
		file.NoteID, file.NotePath = note.ID, note.Path
		file.Status, file.Why = wikiImportSkipped, "the space already holds this text as the note "+note.Path
		im.summary.KnownNotes++
		fmt.Fprintf(im.progress, "%s: already in the space as the note %s — not read again\n", source.rel, note.Path)
		return false, nil
	}
	if note.Created {
		im.summary.NewNotes++
	}
	file.NoteID, file.NotePath, file.Status = note.ID, note.Path, wikiImportRegistered
	im.texts[source.rel] = note.Text
	return true, nil
}

// ready is the model, the first time this run needs one: an endpoint that answers /health, and a
// Claude Code to call it with.
func (im *wikiImporter) ready() error {
	if im.endpointUp {
		return nil
	}
	if im.opts.modelMissing != nil {
		return im.opts.modelMissing
	}
	claude, err := wikiVerifyClaudePath()
	if err != nil {
		return fmt.Errorf("orbit wiki import runs a clean Claude Code, and there is no claude binary on this machine's " +
			"engine path: install Claude Code, or run it in a session that runs on one")
	}
	if err := wikiImportWaitForEndpoint(im.opts.model.baseURL); err != nil {
		return err
	}
	im.claude, im.endpointUp = claude, true
	return nil
}

// ── Proposing ───────────────────────────────────────────────────────────────────────────────────

// wikiImportRoomCodes are the refusals that say nothing about an op but that there is no room for it
// now: it waits for a later run (contract `import.cli.batches`).
var wikiImportRoomCodes = map[string]bool{"WIKI_QUOTA": true, "WIKI_REVIEW_QUEUE_FULL": true}

// propose checks the run's ops with a dry run and proposes the ones that passed, up to the first that
// has no room; the rest wait for a later run.
func (im *wikiImporter) propose() error {
	defer im.settle()
	refs := im.queue
	if len(refs) > im.opts.maxOps {
		refs = refs[:im.opts.maxOps]
	}
	if len(refs) == 0 {
		return nil
	}
	dry, err := im.send(refs, true)
	if err != nil {
		return err
	}
	var sendable []wikiImportRef
	var room string
	for i, ref := range refs {
		outcome := wikiImportOutcomeAt(dry.Ops, i)
		if status, _ := outcome["status"].(string); status == "refused" || status == "conflict" {
			code, why := wikiImportReason(outcome)
			if wikiImportRoomCodes[code] {
				room = code + ": " + why
				im.summary.Deferred += len(refs) - i
				break
			}
			im.refuse(ref, code, why)
			continue
		}
		sendable = append(sendable, ref)
	}
	if len(sendable) == 0 {
		if room != "" {
			im.summary.Stopped = "no room to propose anything now (" + room + "): the owner decides what waits in Review, " +
				"or another session carries on, before the import can go on"
		}
		return nil
	}
	answer, err := im.send(sendable, false)
	if err != nil {
		return err
	}
	for i, ref := range sendable {
		outcome := wikiImportOutcomeAt(answer.Ops, i)
		op := &im.state.Files[ref.rel].Ops[ref.index]
		status, _ := outcome["status"].(string)
		switch status {
		case "applied":
			op.Outcome = "applied"
			im.summary.Applied++
		case "pending":
			op.Outcome = "pending"
			if waits, _ := outcome["waitsFor"].(string); waits == "verification" {
				op.Outcome = "verifying"
				im.summary.Verifying++
			} else {
				im.summary.Pending++
			}
		default:
			code, why := wikiImportReason(outcome)
			if wikiImportRoomCodes[code] {
				// Room the dry run saw was taken since: the op waits for a later run.
				im.summary.Deferred++
				continue
			}
			im.refuse(ref, code, why)
			continue
		}
		op.OpID, _ = outcome["opId"].(string)
		op.EntryID, _ = outcome["entryId"].(string)
		im.summary.Proposed++
	}
	return nil
}

// settle marks done every file whose ops all have an answer — recorded or refused.
func (im *wikiImporter) settle() {
	for _, file := range im.state.Files {
		if file.Status != wikiImportExtracted {
			continue
		}
		done := true
		for _, op := range file.Ops {
			if op.Outcome == "" {
				done = false
			}
		}
		if done {
			file.Status = wikiImportDone
		}
	}
}

func (im *wikiImporter) refuse(ref wikiImportRef, code, why string) {
	file := im.state.Files[ref.rel]
	op := &file.Ops[ref.index]
	op.Outcome, op.Why = "refused", strings.TrimSpace(code+": "+why)
	im.summary.Refused++
	title := ""
	if entry, ok := op.Body["entry"].(map[string]interface{}); ok {
		title, _ = entry["title"].(string)
	}
	im.summary.Refusals = append(im.summary.Refusals, wikiImportRefusal{File: ref.rel, Title: title, Code: code, Why: why})
}

// send proposes the ops (or checks them, dryRun): one changeset, under a key made of the space and the
// ops, so the same batch sent again after a lost answer is recorded once.
func (im *wikiImporter) send(refs []wikiImportRef, dryRun bool) (wikiProposeAnswer, error) {
	ops := make([]interface{}, 0, len(refs))
	files := []string{}
	seen := map[string]bool{}
	for _, ref := range refs {
		ops = append(ops, im.state.Files[ref.rel].Ops[ref.index].Body)
		if !seen[ref.rel] {
			seen[ref.rel] = true
			files = append(files, ref.rel)
		}
	}
	body := map[string]interface{}{"ops": ops, "rationale": wikiImportRationale(im.opts.model.model, files, len(ops))}
	if dryRun {
		body["dryRun"] = true
	} else {
		canonical, _ := json.Marshal(ops)
		sum := sha256.Sum256(append([]byte(im.opts.spaceID+"\n"), canonical...))
		body["idempotencyKey"] = "wiki-import:" + hex.EncodeToString(sum[:])[:40]
	}
	raw, err := im.t.importWikiChangeset(im.sessionID, im.opts.spaceID, body)
	var answer wikiProposeAnswer
	if err != nil {
		// A batch none of whose ops was recorded is answered with its first refusal's status and every
		// op's outcome: an answer, not a failure.
		refused, ok := wikiProposeAnswerIn(err)
		if !ok {
			return answer, wikiCallError("orbit wiki import", err)
		}
		return refused, nil
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return answer, fmt.Errorf("orbit wiki import: the server's answer is not the shape this build reads: %w", err)
	}
	return answer, nil
}

func wikiImportRationale(model string, files []string, ops int) string {
	names := files
	if len(names) > 5 {
		names = append(append([]string{}, names[:5]...), fmt.Sprintf("and %d more", len(files)-5))
	}
	return cutRunes(fmt.Sprintf("orbit wiki import: %s the local model (%s) read in %s: %s",
		wikiCount(ops, "entry", "entries"), model, wikiCount(len(files), "note", "notes"), strings.Join(names, ", ")), 1000)
}

// wikiImportOutcomeAt is the outcome of the op at seq, whichever order the answer lists them in.
func wikiImportOutcomeAt(ops []map[string]interface{}, seq int) map[string]interface{} {
	for _, op := range ops {
		if n, ok := op["seq"].(float64); ok && int(n) == seq {
			return op
		}
	}
	return map[string]interface{}{"status": "refused", "reasons": []interface{}{map[string]interface{}{"code": "", "message": "the server answered nothing for it"}}}
}

func wikiImportReason(outcome map[string]interface{}) (string, string) {
	if status, _ := outcome["status"].(string); status == "conflict" {
		return "WIKI_REVISION_CONFLICT", "the entry moved since"
	}
	for _, reason := range wikiMapSlice(outcome["reasons"]) {
		code, _ := reason["code"].(string)
		message, _ := reason["message"].(string)
		return code, message
	}
	return "", "refused"
}

// ── The server's two routes ─────────────────────────────────────────────────────────────────────

// registerWikiNote is `POST /api/runner/wiki/spaces/:id/notes` (contract `import.note`).
func (t *Transport) registerWikiNote(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/notes"
	err := t.doHeaders(nil, http.MethodPost, path, body, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// importWikiChangeset is `POST /api/runner/wiki/spaces/:id/imports` (contract `import.propose`): a
// proposal's body, recorded with origin import. A batch none of whose ops was recorded comes back as
// a 4xx carrying every outcome, which wikiProposeAnswerIn reads.
func (t *Transport) importWikiChangeset(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/imports"
	err := t.doHeaders(nil, http.MethodPost, path, body, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// ── The model ───────────────────────────────────────────────────────────────────────────────────

// wikiImportUsage is what one call cost, as Claude Code's result reports it.
type wikiImportUsage struct {
	input, output int
}

// wikiImportAuthError is the endpoint refusing the token: every file after it would be refused the
// same way, and Claude Code spends three minutes retrying each, so the run stops here.
type wikiImportAuthError struct{ detail string }

func (e *wikiImportAuthError) Error() string {
	return "the model endpoint refused the token (401): check the ANTHROPIC_AUTH_TOKEN this session's provider injected; " +
		"nothing more was read, and the next run starts where this one stopped. " + e.detail
}

// wikiImportCallError is a call that did not come back with an answer: the endpoint's own status when
// it gave one, or a timeout.
type wikiImportCallError struct {
	status  int
	timeout bool
	detail  string
}

func (e *wikiImportCallError) Error() string { return e.detail }

// aboutTheFile reports a failure that is the file's, not the endpoint's: a request the endpoint
// refused for what it held (too long for the model's window, say), or a call that ran out of time.
func (e *wikiImportCallError) aboutTheFile() bool {
	return e.timeout || (e.status >= 400 && e.status < 500 && e.status != http.StatusTooManyRequests)
}

// wikiImportExtraction is what reading one file came to.
type wikiImportExtraction struct {
	ops        []wikiImportOp
	principles int
	dropped    int
	calls      int
	usage      wikiImportUsage
	// The model answered, and nothing it said could be read: the file is not read again.
	failed string
	// The endpoint refused the token or went away: the run stops, and the file is read next time.
	err error
}

// extract has the model read one note and turns its answer into ops, asking once more — with what was
// wrong — when the answer does not hold up.
func (im *wikiImporter) extract(source wikiImportSource) wikiImportExtraction {
	file := im.state.Files[source.rel]
	note := wikiImportNote{id: file.NoteID, path: file.NotePath, date: source.date, text: im.texts[source.rel]}
	note.lang = wikiImportNoteLanguage(note.text)
	prompt := wikiImportPrompt(note)
	var result wikiImportExtraction
	answer, err := im.ask(prompt, &result)
	if err != nil {
		return wikiImportFailure(result, err)
	}
	entries, parsed := parseWikiImportAnswer(answer)
	built := im.build(entries, note)
	if !parsed || len(built.problems) > 0 {
		again, err := im.ask(prompt+wikiImportRetrySuffix(answer, parsed, built), &result)
		if err != nil {
			return wikiImportFailure(result, err)
		}
		if more, ok := parseWikiImportAnswer(again); ok {
			if parsed {
				built.merge(im.build(more, note))
			} else {
				// The first answer held nothing to read: the second is the whole answer.
				built, parsed = im.build(more, note), true
			}
		}
	}
	if !parsed {
		result.failed = "the model's answer held no JSON array of entries"
		return result
	}
	result.ops, result.principles, result.dropped = built.ops, built.principles, built.dropped
	if len(result.ops) > wikiImportEntriesPerNote {
		result.dropped += len(result.ops) - wikiImportEntriesPerNote
		result.ops = result.ops[:wikiImportEntriesPerNote]
	}
	return result
}

func wikiImportFailure(result wikiImportExtraction, err error) wikiImportExtraction {
	var call *wikiImportCallError
	if errors.As(err, &call) && call.aboutTheFile() {
		result.failed = "the model gave no answer for it: " + call.detail
		return result
	}
	result.err = err
	return result
}

// ask makes one clean call; an endpoint that went away is waited for once, and asked once more.
func (im *wikiImporter) ask(prompt string, result *wikiImportExtraction) (string, error) {
	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), wikiImportCallTimeout)
		answer, usage, err := askWikiImportModel(ctx, im.claude, im.opts.model, prompt)
		cancel()
		result.calls++
		result.usage.input += usage.input
		result.usage.output += usage.output
		var auth *wikiImportAuthError
		var call *wikiImportCallError
		switch {
		case err == nil:
			return answer, nil
		case errors.As(err, &auth), errors.As(err, &call) && call.aboutTheFile(), attempt > 0:
			return "", err
		}
		if waitErr := wikiImportWaitForEndpoint(im.opts.model.baseURL); waitErr != nil {
			return "", waitErr
		}
	}
}

// wikiImportWaitForEndpoint waits for the endpoint's GET /health to answer 200 (or 404, an endpoint
// that has no health route), for up to wikiImportHealthWait: the tunnel the local model sits behind
// drops and comes back, and a run started against a dead one would read nothing.
func wikiImportWaitForEndpoint(baseURL string) error {
	client := &http.Client{Timeout: 10 * time.Second}
	deadline := time.Now().Add(wikiImportHealthWait)
	for {
		resp, err := client.Get(baseURL + "/health")
		last := ""
		if err != nil {
			last = err.Error()
		} else {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNotFound {
				return nil
			}
			last = fmt.Sprintf("/health answered %d", resp.StatusCode)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("the model endpoint %s was not ready within %s (%s): nothing more was read, and the next run "+
				"starts where this one stopped — if it is the local model's tunnel, run it again once it is back", baseURL, wikiImportHealthWait, last)
		}
		time.Sleep(wikiImportHealthPoll)
	}
}

// wikiImportClaudeArgs is `orbit wiki verify`'s clean launch, flag for flag, with the importer's own
// system prompt in place of the verifier's.
func wikiImportClaudeArgs(model, settings string) []string {
	args := append([]string{}, wikiVerifyClaudeArgs(model, settings)...)
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--system-prompt" {
			args[i+1] = wikiImportSystemPrompt
		}
	}
	return args
}

// wikiImportEnv is the verifier's allowlisted environment with thinking off: CLAUDE_CODE_EFFORT_LEVEL=unset
// keeps the effort out of the request, and MAX_THINKING_TOKENS=0 the thinking block Claude Code adds of
// its own accord for a model it does not know — the local model reasons for a minute where it would
// answer in seconds, and reasoning did not find more (the demo's finding).
func wikiImportEnv(home, config string, cfg wikiVerifyConfig) []string {
	env := []string{}
	for _, pair := range wikiVerifyEnv(home, config, cfg) {
		key, _, _ := strings.Cut(pair, "=")
		if key == "CLAUDE_CODE_EFFORT_LEVEL" || key == "MAX_THINKING_TOKENS" {
			continue
		}
		env = append(env, pair)
	}
	return append(env, "CLAUDE_CODE_EFFORT_LEVEL=unset", "MAX_THINKING_TOKENS=0")
}

// askWikiImportModel runs one clean Claude Code over prompt and returns the model's answer and what it
// cost.
func askWikiImportModel(ctx context.Context, claude string, cfg wikiVerifyConfig, prompt string) (string, wikiImportUsage, error) {
	var usage wikiImportUsage
	scratch, err := os.MkdirTemp("", "orbit-wiki-import-")
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
		// Onboarding done, and nothing else: no login, memory or setting of this machine reaches the call.
		if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
			return "", usage, err
		}
	}
	settings := filepath.Join(scratch, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"apiKeyHelper":"printenv ANTHROPIC_AUTH_TOKEN"}`), 0o600); err != nil {
		return "", usage, err
	}
	cmd := exec.CommandContext(ctx, claude, wikiImportClaudeArgs(cfg.model, settings)...)
	cmd.Dir = scratch
	cmd.Env = wikiImportEnv(home, config, cfg)
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	var result struct {
		IsError        bool   `json:"is_error"`
		Result         string `json:"result"`
		APIErrorStatus *int   `json:"api_error_status"`
		Usage          struct {
			InputTokens              int `json:"input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			OutputTokens             int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(lastJSONLine(stdout.Bytes()), &result); err != nil {
		if ctx.Err() != nil {
			return "", usage, &wikiImportCallError{timeout: true, detail: fmt.Sprintf("Claude Code gave no answer within %s", wikiImportCallTimeout)}
		}
		return "", usage, &wikiImportCallError{detail: fmt.Sprintf("Claude Code gave no result (%v): %s", runErr, lastLines(stderr.String(), 3))}
	}
	usage.input = result.Usage.InputTokens + result.Usage.CacheCreationInputTokens + result.Usage.CacheReadInputTokens
	usage.output = result.Usage.OutputTokens
	status := 0
	if result.APIErrorStatus != nil {
		status = *result.APIErrorStatus
	}
	if status == http.StatusUnauthorized || (result.IsError && wikiVerify401.MatchString(result.Result)) {
		return "", usage, &wikiImportAuthError{detail: result.Result}
	}
	if result.IsError {
		return "", usage, &wikiImportCallError{status: status, detail: "Claude Code reported an error: " + result.Result}
	}
	return result.Result, usage, nil
}

// ── The prompt, and what may come back ──────────────────────────────────────────────────────────

// wikiImportNote is one note as the model is shown it: the text the server kept, and where it came from.
// lang is the language its prose is written in when that is one an entry's title is held to
// (wikiImportNoteLanguage), and "" otherwise.
type wikiImportNote struct {
	id, path, date, text, lang string
}

// wikiImportChinese is the one language a note's entries are held to: the owner's memory is written in
// it, and the model, shown an English example, titled its entries in English all the same (the trial
// of 2026-09-28).
const wikiImportChinese = "Chinese"

var (
	wikiImportFrontmatterBlock = regexp.MustCompile(`(?s)\A---\n.*?\n---\n`)
	wikiImportCodeBlock        = regexp.MustCompile("(?s)```.*?```")
	wikiImportCodeSpan         = regexp.MustCompile("`[^`\n]*`")
	wikiImportURL              = regexp.MustCompile(`https?://\S+`)
)

// wikiImportNoteLanguage is "Chinese" when the note's prose — its text without frontmatter, code and
// URLs — is mostly Han characters, counting a Latin word as five letters, and "" otherwise. Of the
// owner's 1,135 memory files, 1,103 come out at 0.5 or more and 27 below 0.2: 0.3 splits them.
func wikiImportNoteLanguage(text string) string {
	prose := wikiImportFrontmatterBlock.ReplaceAllString(text, "")
	for _, code := range []*regexp.Regexp{wikiImportCodeBlock, wikiImportCodeSpan, wikiImportURL} {
		prose = code.ReplaceAllString(prose, " ")
	}
	han, latin := 0, 0
	for _, r := range prose {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
		case r < utf8.RuneSelf && unicode.IsLetter(r):
			latin++
		}
	}
	if han > 0 && float64(han)/(float64(han)+float64(latin)/5) >= 0.3 {
		return wikiImportChinese
	}
	return ""
}

func wikiImportHasHan(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// wikiImportNoteGives is whether the note gives the command as it is written: a recipe's verify
// command is run as it stands, and a description of a check («full-api on main») is not one.
func wikiImportNoteGives(note, command string) bool {
	collapse := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	command = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), "$ "))
	return command != "" && strings.Contains(collapse(note), collapse(command))
}

// wikiImportPrompt is the demo's extraction prompt (prompts.py) for one note instead of a case file:
// what is worth an entry and what is not, the one shape the answer may take, and a fictional example.
func wikiImportPrompt(note wikiImportNote) string {
	return `Below is a NOTE: one Markdown file kept beside a code repository. It is an instruction file for coding agents (a CLAUDE.md or an AGENTS.md), or one file of an agent's memory library, whose frontmatter gives the memory a name, a one-line description and a type (user: about the owner; feedback: how the owner wants work done; project: ongoing work; reference: facts and pointers). Agents wrote most of these notes while working for the repository's owner: "the user" in a note is the owner.

TASK: extract the knowledge in this note that would change how a future agent works in this repository and that it could NOT learn by reading the code for one minute:
- rules and corrections — how the owner wants things done, a practice the note says to follow -> convention
- decisions, with the alternatives and why they were rejected -> decision
- traps and surprises: something behaves differently than expected, with the cause and the fix -> pitfall
- a multi-step procedure, with a command that shows it worked -> recipe
- the meaning of a project-specific term or mechanism that is easy to get wrong -> concept
Never write a principle: principles are the owner's alone. Write a general rule with its reason as a convention.
Do NOT extract: status or progress reports, what was built, one-off facts about a single task, generic programming advice, or anything the code states plainly. A note that only lists or links other notes -> []. Prefer fewer, stronger entries. If there is nothing worth keeping, output [].

OUTPUT: a JSON array (at most ` + fmt.Sprint(wikiImportEntriesPerNote) + ` objects), nothing else — no prose, no code fence. Each object is FLAT:
{"kind": "convention|decision|pitfall|recipe|concept",
 "title": "<= 60 characters, states the knowledge itself",
 "summary": "one or two short sentences a future agent can act on",
 ...the kind's own fields at the top level (below)...,
 "anchors": {"paths": [repository file paths the note names], "commits": [commit shas the note names]},
 "quote": "a span of the note, copied character for character, that shows it (<= 150 characters)"}
The kind's own fields (all required; be terse: each text field one short sentence):
- convention: "rule", "scope": ["where it applies"], "exceptions" ("" if none)
- decision: "context", "decision", "alternatives": [{"option": "...", "whyRejected": "..."}], "consequences", "decidedAt": "YYYY-MM-DD"
- pitfall: "trigger": {"paths": [...], "commands": [...], "errorSignature": "..."} (at least one non-empty; [] for an empty list), "symptom", "cause", "fix"
- recipe: "steps": ["..."], "verify": {"command": "<a command the note gives, copied as it is written>", "expectedExit": 0}
- concept: "definition", "boundaries"
RULES:
- quote: copied exactly from the note, backticks and punctuation included — no "…", no paraphrase, no translation. Prefer a span without double quotes; if one is unavoidable, escape it as \".
- Write titles and text fields in the language the note is written in; keep code, paths and commands verbatim.
- verify.command is a shell command copied exactly as the note writes it, one that shows the procedure worked — never a description of a check. A procedure the note gives no such command for is not a recipe: write it as a convention, or leave it out.
- Only put a path or a sha in anchors if it appears in the note; never invent one. decidedAt is the date the note gives the decision, or else the note's date.

EXAMPLE (a fictional repository, for format only):
NOTE (memory/upload-fixture-port.md, 2025-03-02):
---
name: upload-fixture-port
description: STORAGE_PORT is read at import time, so fixtures must hand out the URL
metadata:
  type: feedback
---
Upload tests failed with ` + "`Error: connect ECONNREFUSED 127.0.0.1:9000`" + ` on CI.
STORAGE_PORT is read when src/api/storage.ts is imported, before the fixture sets it.
The user said: never hard-code ports in a fixture; always take them from what the fixture returns.
OUTPUT:
[{"kind":"pitfall","title":"STORAGE_PORT is read at import, so a fixture sets it too late","summary":"Set STORAGE_PORT before src/api/storage.ts is imported, or tests connect to the default 9000.","trigger":{"paths":["src/api/storage.ts"],"commands":[],"errorSignature":"connect ECONNREFUSED 127.0.0.1:9000"},"symptom":"Upload tests fail with ECONNREFUSED 127.0.0.1:9000","cause":"STORAGE_PORT is read when the module is imported, before the fixture sets it","fix":"Have the fixture return the URL and read the port from there","anchors":{"paths":["src/api/storage.ts"],"commits":[]},"quote":"STORAGE_PORT is read when src/api/storage.ts is imported, before the fixture sets it."},
 {"kind":"convention","title":"Tests take ports from the fixture, never hard-code them","summary":"Take every port from what the fixture returns.","rule":"Never hard-code a port in a fixture; take it from what the fixture returns","scope":["test fixtures"],"exceptions":"","anchors":{"paths":[],"commits":[]},"quote":"never hard-code ports in a fixture; always take them from what the fixture returns."}]

==== NOTE (` + note.path + `, ` + note.date + `) ====
` + note.text + `
==== END OF NOTE ====
` + wikiImportLanguageLine(note) + `Output the JSON array now.`
}

// wikiImportLanguageLine names the note's language last, where the model reads it after the English
// example: "" for a note whose language no title is held to.
func wikiImportLanguageLine(note wikiImportNote) string {
	if note.lang == "" {
		return ""
	}
	return "This note is written in " + note.lang + ": write every title, summary and text field in " + note.lang +
		", although the example above is in English; keep code, paths and commands verbatim.\n"
}

// wikiImportRetrySuffix asks once more, naming what did not hold up (prompts.py's retry_suffix).
func wikiImportRetrySuffix(answer string, parsed bool, built wikiImportBuilt) string {
	if !parsed {
		return "\n\nYOUR ANSWER WAS NOT A JSON ARRAY OF FLAT ENTRY OBJECTS:\n" + lastRunes(answer, 3000) +
			"\n\nOutput the JSON array only, as specified."
	}
	rejected, _ := json.Marshal(built.rejected)
	problems := built.problems
	if len(problems) > 12 {
		problems = problems[:12]
	}
	return "\n\nSOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n" + cutRunes(string(rejected), 6000) + "\n\nPROBLEMS:\n- " +
		strings.Join(problems, "\n- ") + "\nOutput a JSON array with corrected versions of ONLY these rejected entries (flat " +
		"objects as specified; fill every required field). Drop an entry you cannot support. Output the JSON array only."
}

func lastRunes(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[len(runes)-max:])
}

// parseWikiImportAnswer finds the array of entries in the model's answer: bare, in a code fence, as
// {"entries": [...]}, or after some reasoning. False when there is none — which `[]` is not.
func parseWikiImportAnswer(text string) ([]map[string]interface{}, bool) {
	trimmed := strings.TrimSpace(text)
	candidates := []string{}
	for _, m := range wikiImportFence.FindAllStringSubmatch(trimmed, -1) {
		candidates = append(candidates, strings.TrimSpace(m[1]))
	}
	candidates = append(candidates, trimmed)
	for _, candidate := range candidates {
		for _, body := range []string{candidate, wikiImportRepair(candidate)} {
			if entries, ok := wikiImportEntries(body); ok {
				return entries, true
			}
		}
	}
	// The longest array of entries anywhere in it, for an answer that reasons before it answers.
	for _, body := range []string{trimmed, wikiImportRepair(trimmed)} {
		var best []map[string]interface{}
		bestSpan := -1
		for start := strings.Index(body, "["); start >= 0; {
			decoder := json.NewDecoder(strings.NewReader(body[start:]))
			var value []map[string]interface{}
			if decoder.Decode(&value) == nil && wikiImportEntryLike(value) && len(value) > 0 {
				if span := int(decoder.InputOffset()); span > bestSpan {
					best, bestSpan = value, span
				}
			}
			next := strings.Index(body[start+1:], "[")
			if next < 0 {
				break
			}
			start += next + 1
		}
		if best != nil {
			return best, true
		}
	}
	if strings.HasSuffix(trimmed, "[]") {
		return []map[string]interface{}{}, true
	}
	return nil, false
}

var (
	wikiImportFence         = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)```")
	wikiImportTrailingComma = regexp.MustCompile(`,\s*([\]}])`)
	wikiImportQuoteValue    = regexp.MustCompile(`(?s)("quote"\s*:\s*")(.*?)("\s*\}\s*[,\]])`)
	wikiImportBareQuote     = regexp.MustCompile(`([^\\])"`)
)

// wikiImportRepair mends the two mistakes a model makes most: an unescaped double quote inside a
// quote's value, and a trailing comma.
func wikiImportRepair(text string) string {
	text = wikiImportQuoteValue.ReplaceAllStringFunc(text, func(match string) string {
		parts := wikiImportQuoteValue.FindStringSubmatch(match)
		inner := wikiImportBareQuote.ReplaceAllString(parts[2], `$1\"`)
		if strings.HasPrefix(inner, `"`) {
			inner = `\` + inner
		}
		return parts[1] + inner + parts[3]
	})
	return wikiImportTrailingComma.ReplaceAllString(text, "$1")
}

func wikiImportEntries(body string) ([]map[string]interface{}, bool) {
	var list []map[string]interface{}
	if json.Unmarshal([]byte(body), &list) == nil && wikiImportEntryLike(list) {
		return list, true
	}
	var wrapped struct {
		Entries []map[string]interface{} `json:"entries"`
	}
	if json.Unmarshal([]byte(body), &wrapped) == nil && wrapped.Entries != nil {
		return wrapped.Entries, true
	}
	return nil, false
}

func wikiImportEntryLike(list []map[string]interface{}) bool {
	if list == nil {
		return false
	}
	if len(list) == 0 {
		return true
	}
	for _, entry := range list {
		if _, ok := entry["kind"]; ok {
			return true
		}
		if _, ok := entry["title"]; ok {
			return true
		}
	}
	return false
}

// wikiImportBuilt is what a set of the model's entries became: ops that hold up, what was wrong with
// the ones that did not (for the retry), and the principles set aside.
type wikiImportBuilt struct {
	ops        []wikiImportOp
	rejected   []map[string]interface{}
	problems   []string
	principles int
	dropped    int
	titles     map[string]bool
}

// merge takes the retry's ops in place of the entries it corrected: the ones rejected the first time
// no longer count as dropped when their correction holds up. A principle in the retry is one the first
// answer already had, and was counted there.
func (b *wikiImportBuilt) merge(retry wikiImportBuilt) {
	for _, op := range retry.ops {
		title := wikiImportTitleOf(op)
		if b.titles[title] {
			continue
		}
		b.titles[title] = true
		b.ops = append(b.ops, op)
		if b.dropped > 0 {
			b.dropped--
		}
	}
}

func wikiImportTitleOf(op wikiImportOp) string {
	entry, _ := op.Body["entry"].(map[string]interface{})
	title, _ := entry["title"].(string)
	return strings.ToLower(title)
}

// build checks each entry the way extract.py's validate did and makes an add of the ones that hold up.
func (im *wikiImporter) build(entries []map[string]interface{}, note wikiImportNote) wikiImportBuilt {
	built := wikiImportBuilt{titles: map[string]bool{}}
	for _, entry := range entries {
		kind, _ := entry["kind"].(string)
		kind = strings.ToLower(strings.TrimSpace(kind))
		if kind == "principle" {
			built.principles++
			continue
		}
		op, problems := wikiImportOpFrom(entry, kind, note, im.repo)
		if len(problems) > 0 {
			built.dropped++
			built.rejected = append(built.rejected, entry)
			title, _ := entry["title"].(string)
			for _, problem := range problems {
				built.problems = append(built.problems, fmt.Sprintf("entry %q: %s", cutRunes(title, 40), problem))
			}
			continue
		}
		title := wikiImportTitleOf(op)
		if built.titles[title] {
			built.dropped++
			continue
		}
		built.titles[title] = true
		built.ops = append(built.ops, op)
	}
	return built
}

// wikiImportRequired is each kind's fields a model must fill (contract `kinds.<kind>.fields`); the
// server checks the rest and answers WIKI_SCHEMA for what this lets through.
var wikiImportRequired = map[string][]string{
	"convention": {"rule", "scope"},
	"decision":   {"context", "decision", "alternatives", "consequences", "decidedAt"},
	"pitfall":    {"trigger", "symptom", "cause", "fix"},
	"recipe":     {"steps", "verify"},
	"concept":    {"definition", "boundaries"},
}

// wikiImportOptional are the kinds' optional fields, carried when the model filled them.
var wikiImportOptional = map[string][]string{
	"convention": {"exceptions"},
	"pitfall":    {"detector"},
	"concept":    {"notToConfuseWith"},
}

// wikiImportOpFrom is one entry as an add citing the note, or what is wrong with it.
func wikiImportOpFrom(entry map[string]interface{}, kind string, note wikiImportNote, repo *wikiImportRepo) (wikiImportOp, []string) {
	var problems []string
	if !contains(wikiImportKinds, kind) {
		return wikiImportOp{}, []string{fmt.Sprintf("kind %q is not one of %s", kind, strings.Join(wikiImportKinds, ", "))}
	}
	title := wikiImportText(entry["title"], 120)
	summary := wikiImportText(entry["summary"], 280)
	if title == "" {
		problems = append(problems, "title is missing")
	} else if note.lang == wikiImportChinese && !wikiImportHasHan(title) {
		problems = append(problems, "title is not in the note's language: the note is written in Chinese, so write the title in Chinese")
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
	if len(problems) > 0 {
		return wikiImportOp{}, problems
	}
	draft := map[string]interface{}{"kind": kind, "title": title, "summary": summary, "fields": fields}
	if anchors := repo.anchors(entry["anchors"]); len(anchors) > 0 {
		draft["anchors"] = anchors
	}
	source := map[string]interface{}{"kind": "note", "ref": note.id}
	if quote, ok := wikiImportQuote(note.text, wikiImportText(entry["quote"], 4000)); ok {
		source["quote"] = quote
	}
	return wikiImportOp{Body: map[string]interface{}{"op": "add", "entry": draft, "sources": []interface{}{source}}}, nil
}

// wikiImportField is one required field in the shape the kind's schema gives it, or what is wrong.
func wikiImportField(name string, value interface{}, note wikiImportNote) (interface{}, string) {
	missing := name + " is missing"
	switch {
	case name == "scope" || name == "steps":
		list := wikiImportTextList(value)
		if len(list) == 0 {
			return nil, missing
		}
		return list, ""
	case name == "alternatives":
		var items []interface{}
		switch v := value.(type) {
		case []interface{}:
			items = v
		case map[string]interface{}:
			items = []interface{}{v}
		}
		alternatives := []interface{}{}
		for _, item := range items {
			alt, _ := item.(map[string]interface{})
			option, why := wikiImportText(alt["option"], 4000), wikiImportText(alt["whyRejected"], 4000)
			if option != "" && why != "" {
				alternatives = append(alternatives, map[string]interface{}{"option": option, "whyRejected": why})
			}
		}
		if len(alternatives) == 0 {
			return nil, "alternatives needs at least one {option, whyRejected}"
		}
		return wikiImportCap(alternatives), ""
	case name == "decidedAt":
		// A date that is not one — or none at all — is the note's own date.
		date := wikiImportText(value, 40)
		if len(date) >= 10 {
			if _, err := time.Parse("2006-01-02", date[:10]); err == nil {
				return date[:10], ""
			}
		}
		return note.date, ""
	case name == "trigger":
		trigger, _ := value.(map[string]interface{})
		paths, commands := wikiImportTextList(trigger["paths"]), wikiImportTextList(trigger["commands"])
		out := map[string]interface{}{"paths": paths, "commands": commands}
		if signature := wikiImportText(trigger["errorSignature"], 4000); signature != "" {
			out["errorSignature"] = signature
		}
		if len(paths) == 0 && len(commands) == 0 && out["errorSignature"] == nil {
			return nil, "trigger needs at least one of paths, commands or errorSignature"
		}
		return out, ""
	case name == "verify":
		verify, _ := value.(map[string]interface{})
		command := wikiImportText(verify["command"], 4000)
		if command == "" {
			return nil, "verify needs a command"
		}
		if !wikiImportNoteGives(note.text, command) {
			return nil, fmt.Sprintf("verify.command %q is not a command the note gives: copy one exactly as the note "+
				"writes it, or, when the note gives none, write the procedure as a convention or leave it out", cutRunes(command, 80))
		}
		exit := 0
		switch code := verify["expectedExit"].(type) {
		case float64:
			exit = int(code)
		case string:
			fmt.Sscanf(strings.TrimSpace(code), "%d", &exit)
		}
		if exit < 0 || exit > 255 {
			exit = 0
		}
		return map[string]interface{}{"command": command, "expectedExit": exit}, ""
	default:
		text := wikiImportText(value, 4000)
		if text == "" {
			return nil, missing
		}
		return text, ""
	}
}

// wikiImportText is a text field trimmed and cut to what the contract lets it hold; "" when it is not
// text or is blank.
func wikiImportText(value interface{}, max int) string {
	text, _ := value.(string)
	return cutRunes(strings.TrimSpace(text), max)
}

// wikiImportTextList is a list of texts, blanks left out and cut to the contract's list size; a lone
// text is a list of one.
func wikiImportTextList(value interface{}) []interface{} {
	var items []interface{}
	switch v := value.(type) {
	case []interface{}:
		items = v
	case string:
		items = []interface{}{v}
	}
	out := []interface{}{}
	for _, item := range items {
		if text := wikiImportText(item, 4000); text != "" {
			out = append(out, text)
		}
	}
	return wikiImportCap(out)
}

func wikiImportCap(items []interface{}) []interface{} {
	if len(items) > 20 {
		return items[:20]
	}
	return items
}

// wikiImportQuote is the quote as the note holds it: as the model wrote it when the note has it (the
// server compares with runs of whitespace collapsed, and so does this), else the note's own span when
// the model only dropped backticks, asterisks or curly quotes from it, else nothing — the note stays
// the entry's source with no quote.
func wikiImportQuote(note, quote string) (string, bool) {
	if quote == "" {
		return "", false
	}
	collapse := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	if strings.Contains(collapse(note), collapse(quote)) {
		return cutRunes(quote, wikiImportQuoteMaxChars), true
	}
	plain, offsets := wikiImportPlain(note)
	wanted, _ := wikiImportPlain(quote)
	wanted = strings.TrimSpace(wanted)
	if wanted == "" {
		return "", false
	}
	at := strings.Index(plain, wanted)
	if at < 0 {
		return "", false
	}
	start, last := offsets[at], offsets[at+len(wanted)-1]
	_, size := utf8.DecodeRuneInString(note[last:])
	start, stop := wikiImportWholeMarks(note, start, last+size)
	span := strings.TrimSpace(note[start:stop])
	if span == "" {
		return "", false
	}
	return cutRunes(span, wikiImportQuoteMaxChars), true
}

// wikiImportWholeMarks widens note[start:stop] over a backtick or a `**` it holds one half of, so a
// quote reads `release.sh next` rather than release.sh next`.
func wikiImportWholeMarks(note string, start, stop int) (int, int) {
	for _, mark := range []string{"`", "**"} {
		if strings.Count(note[start:stop], mark)%2 == 0 {
			continue
		}
		switch {
		case start >= len(mark) && note[start-len(mark):start] == mark:
			start -= len(mark)
		case stop+len(mark) <= len(note) && note[stop:stop+len(mark)] == mark:
			stop += len(mark)
		}
	}
	return start, stop
}

// wikiImportPlain is text with the marks a model drops from a quote taken out and every run of
// whitespace one space, with the byte offset in text of each byte kept.
func wikiImportPlain(text string) (string, []int) {
	var b strings.Builder
	var offsets []int
	space := false
	for i, r := range text {
		switch r {
		case '`', '*':
			continue
		case '“', '”', '„':
			r = '"'
		case '‘', '’':
			r = '\''
		}
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if space {
				continue
			}
			space, r = true, ' '
		} else {
			space = false
		}
		before := b.Len()
		b.WriteRune(r)
		for n := before; n < b.Len(); n++ {
			offsets = append(offsets, i)
		}
	}
	return b.String(), offsets
}

// ── Anchors, checked against this checkout ──────────────────────────────────────────────────────

// wikiImportRepo is the repository the import runs in, to hold the model's anchors to: a path that
// exists on its main line, a commit that is an ancestor of it. Outside a repository there are no
// anchors at all rather than unchecked ones — a sha that is not an ancestor poisons whatever trusts it.
type wikiImportRepo struct {
	root string
	ref  string
	// The repository's name, read off its origin (…/orbit.git reads orbit) or its directory: a note
	// that names a file by an absolute path names it inside some checkout called that.
	name  string
	files map[string]bool
	dirs  map[string]bool
	mu    sync.Mutex
	shas  map[string]string
}

// wikiImportRepoDir is where the repository is looked for: "" is the directory the command runs in,
// the session's checkout. A test points it at a repository of its own.
var wikiImportRepoDir = ""

func openWikiImportRepo() *wikiImportRepo {
	return openWikiImportRepoAt(wikiImportRepoDir)
}

// openWikiImportRepoAt is the repository dir is in ("" for the current directory): what a Wiki maintenance
// run holds the model's anchors to in the maintenance workspace's checkout (wiki_maintain.go).
func openWikiImportRepoAt(dir string) *wikiImportRepo {
	root, err := wikiImportGit(dir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return nil
	}
	ref := "origin/main"
	if _, err := wikiImportGit(root, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
		ref = "HEAD"
	}
	listing, err := wikiImportGit(root, "ls-tree", "-r", "--name-only", ref)
	if err != nil {
		return nil
	}
	name := filepath.Base(root)
	if origin, err := wikiImportGit(root, "remote", "get-url", "origin"); err == nil && origin != "" {
		name = strings.TrimSuffix(filepath.Base(strings.TrimRight(origin, "/")), ".git")
	}
	repo := &wikiImportRepo{root: root, ref: ref, name: name, files: map[string]bool{}, dirs: map[string]bool{}, shas: map[string]string{}}
	for _, file := range strings.Split(listing, "\n") {
		if file == "" {
			continue
		}
		repo.files[file] = true
		for dir := filepath.Dir(file); dir != "." && dir != "/"; dir = filepath.Dir(dir) {
			repo.dirs[dir] = true
		}
	}
	return repo
}

func wikiImportGit(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

var (
	wikiImportWorktreePrefix = regexp.MustCompile(`^.*?/\.orbit/worktrees/[^/]+/`)
	wikiImportLineSuffix     = regexp.MustCompile(`:\d+(?:[-:]\d+)?$`)
	wikiImportSHA            = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
)

// anchors is the model's {paths, commits} as the anchors that hold up in this checkout.
func (r *wikiImportRepo) anchors(raw interface{}) []interface{} {
	if r == nil {
		return nil
	}
	given, _ := raw.(map[string]interface{})
	out := []interface{}{}
	seen := map[string]bool{}
	for _, value := range wikiImportTextList(given["paths"]) {
		if path, ok := r.path(value.(string)); ok && !seen["p:"+path] {
			seen["p:"+path] = true
			out = append(out, map[string]interface{}{"type": "path", "path": path})
		}
	}
	for _, value := range wikiImportTextList(given["commits"]) {
		if sha, ok := r.commit(value.(string)); ok && !seen["c:"+sha] {
			seen["c:"+sha] = true
			out = append(out, map[string]interface{}{"type": "commit", "sha": sha})
		}
	}
	return wikiImportCap(out)
}

// path is a path the model named, relative to the repository, when its main line has it. An
// absolute one is read inside this checkout, an Orbit worktree, or any directory named for the
// repository: /root/orbit/src/x reads src/x.
func (r *wikiImportRepo) path(raw string) (string, bool) {
	path := strings.Trim(strings.TrimSpace(raw), "`\"'")
	path = wikiImportLineSuffix.ReplaceAllString(path, "")
	switch {
	case strings.HasPrefix(path, r.root+"/"):
		path = strings.TrimPrefix(path, r.root+"/")
	case wikiImportWorktreePrefix.MatchString(path):
		path = wikiImportWorktreePrefix.ReplaceAllString(path, "")
	case strings.HasPrefix(path, "/") || strings.HasPrefix(path, "~/"):
		if at := strings.Index(path, "/"+r.name+"/"); r.name != "" && at >= 0 {
			path = path[at+len(r.name)+2:]
		}
	}
	path = strings.TrimSuffix(strings.TrimPrefix(path, "./"), "/")
	if path == "" || strings.HasPrefix(path, "/") {
		return "", false
	}
	return path, r.files[path] || r.dirs[path]
}

// commit is a sha the model named, in full, when it is a commit and an ancestor of the main line.
func (r *wikiImportRepo) commit(raw string) (string, bool) {
	sha := strings.ToLower(strings.Trim(strings.TrimSpace(raw), "`\"'"))
	if !wikiImportSHA.MatchString(sha) {
		return "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if full, ok := r.shas[sha]; ok {
		return full, full != ""
	}
	full, err := wikiImportGit(r.root, "rev-parse", "--verify", "--quiet", sha+"^{commit}")
	if err != nil || len(full) != 40 {
		full = ""
	} else if _, err := wikiImportGit(r.root, "merge-base", "--is-ancestor", full, r.ref); err != nil {
		full = ""
	}
	r.shas[sha] = full
	return full, full != ""
}
