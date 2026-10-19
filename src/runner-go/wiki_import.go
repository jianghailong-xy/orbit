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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// `orbit wiki import --from <dir|file> --space <id>`: a CLAUDE.md, an AGENTS.md or an agent's memory
// library into a space's wiki (contracts/wiki.contract.json `import`, criterion 1, design §8.3).
//
// EACH FILE IS ONE NOTE. A file is registered first (`POST /api/runner/wiki/spaces/:id/notes`): the
// server redacts it — the shared redactor, with the owner's workspace.env values — before it keeps
// anything. The same text twice is one note, so a file already imported is not proposed from again.
//
// THE ENTRIES ARE THE SERVER'S MODEL'S. The command hands the notes to one import job of the space, and
// the server's wiki worker reads each with the deployment's System model, checks what it answers, and
// proposes it with origin import (wiki_import_server.go). Nothing here asks a model: no ANTHROPIC_*
// variable is read, and no Claude Code is started.
//
// WHAT TAKES EFFECT IS THE SPACE'S REVIEW MODE'S. The job proposes with origin import: Manual keeps the
// ops for Review, Tiered applies them Unreviewed, Automatic holds them for their verification. A job
// proposes at most thirty; an op refused for want of room — the review queue, a session's quota — waits
// for a later run, so Review is filled a batch at a time.
//
// A RUN PICKS UP WHERE THE LAST ONE STOPPED. What was registered, what the job found and what it proposed
// is kept on this machine ($ORBIT_HOME/wiki-import, or --state): no file is handed to a job twice, and one
// whose text changed is imported as the new note it is.

// wikiImportPrecondition is contracts/wiki.contract.json `import.cli.precondition`, word for word, and
// wiki_import_test.go holds the two equal. It leads for the reason verify's does: the one thing a
// reader must not do here — write the entries itself — is the one the mechanics make easy.
const wikiImportPrecondition = "Import only the files the owner asked for, into the space they named, and never write an " +
	"entry yourself: each entry is the System model's, read on the Orbit server from the file's redacted text, and it " +
	"takes effect only as the space's review mode says."

const wikiImportDescription = wikiImportPrecondition + " Each Markdown file under --from (a directory's *.md files, " +
	"its MEMORY.md index left out, or one file) is registered as a note of --space, the server keeping only its " +
	"redacted text, and the notes are handed to one import job of the Orbit server, whose worker reads each with the " +
	"deployment's System model and proposes at most six entries from it; no model of this session's is asked. A " +
	"principle is never proposed: it is the owner's to write. The job proposes with origin import — at most 30 ops a " +
	"run — and what it proposes takes effect as the space's review mode says: Manual keeps it for Review, Tiered " +
	"applies it as Unreviewed, Automatic waits for its verification. An op refused for want of room waits for the next " +
	"run, and the run remembers where it stopped: run it again to go on. It waits for the job, and stops waiting — the " +
	"job goes on, and the next run collects it — when the System model refuses the deployment's key or stays away."

// The contract's numbers (`import.rules`); wiki_import_test.go holds them to it.
const (
	wikiImportOpsPerRun      = 30
	wikiImportNoteMaxChars   = 100_000
	wikiImportMaxConcurrency = 8
)

// How long a run waits for the server's System model to be up, or — with the model up — for the server to
// start its import job, before it stops waiting and leaves the job to the server. Tests shorten it.
var wikiImportHealthWait = 10 * time.Minute

const wikiImportHelp = `orbit wiki import — have the Orbit server turn CLAUDE.md, AGENTS.md or a memory library into wiki entries

Usage:
  orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--state FILE] [--json]

Options:
  --from PATH              A Markdown file, or a directory whose *.md files are imported (its
                           MEMORY.md index left out). Required
  --space ID               The space to import into. Required
  --max-ops N              The ops this run proposes at most, 1 to 30. Default: 30
  --concurrency N          The files the server's model reads at once, 1 to 8. Default: 4
  --state FILE             Where this machine remembers the import. Default: a file under
                           $ORBIT_HOME/wiki-import named for the space and --from
  --json                   Print the run's summary as JSON

` + wikiImportPrecondition + `

Each file is registered as a note of the space; the server keeps only its redacted text. A directory's
files go in the order their frontmatter gives them — feedback, user, reference, project, then the
rest — each group by name. A file whose text the space already holds is not proposed from again. The
notes are handed to one import job of the Orbit server: its worker reads each with the deployment's
System model, which answers at most six entries citing the note, checks them, and proposes at most
--max-ops with origin import, which take effect as the space's review mode says; a principle is
counted and never proposed. No model of this session's is asked. An op refused for want of room (the
review queue, a session's quota) waits for the next run: run it again, and it picks up where it
stopped. The command waits for the job and prints its report. It stops waiting — the job goes on on
the server, and the next run collects what it did — when the System model refuses the deployment's
key, is not configured or stays away, and exits non-zero then, and when the job could propose
nothing for want of room. A server that does not read the files itself is too old for this command,
which says so and registers nothing.
`

// wikiImportCLICapabilities is the import's own family table: `orbit wiki import` has no MCP tool
// beside it (contract `import.cli.tool`), so its description and schema are its own, and it acts for
// the session it runs in like every wiki verb.
var wikiImportCLICapabilities = []cliCapabilitySpec{{
	Tool:  "wiki_import",
	Argv:  []string{"orbit", "wiki", "import"},
	Usage: "orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--state FILE] [--json]",
	Arguments: []string{
		"--from <dir|file> (required; a Markdown file, or a directory of them)",
		"--space <id> (required; the space to import into)",
		"--max-ops <n> (1-30; default 30)",
		"--concurrency <n> (1-8; default 4)",
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
			"concurrency": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiImportMaxConcurrency, "description": "The files the server's model reads at once."},
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
}

func cliWikiImport(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki import")
	from := fs.String("from", "", "a Markdown file, or a directory of them")
	space := fs.String("space", "", "the space to import into")
	maxOps := fs.Int("max-ops", wikiImportOpsPerRun, "the ops this run proposes at most")
	concurrency := fs.Int("concurrency", 4, "the files the server's model reads at once")
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
	t, err := cliTransport()
	if err != nil {
		return err
	}
	progress := out
	if *jsonOut {
		progress = io.Discard
	}
	// The server reads the files, with its own import job (wiki_import_server.go): one that says it does not
	// is too old for this command, which has no model of its own to read them with.
	executor, err := wikiImportOnServer(t, ctx.sessionID, spaceID)
	if err != nil {
		return err
	}
	summary, runErr := runWikiImportOnServer(t, ctx.sessionID, opts, executor, progress)
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
	// The server's import job that read the notes: these numbers are its report's.
	Job string `json:"job,omitempty"`
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
	if s.Job != "" {
		fmt.Fprintf(&b, "\nRead on the Orbit server: import job %s.", s.Job)
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
	// The server's import job a run handed its notes to and has not collected yet (wiki_import_server.go).
	Job  string `json:"job,omitempty"`
	path string
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

// wikiImportOp is one op the server's job found in a file, and what became of it. An op with no outcome
// has not been proposed yet.
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

// wikiImporter is one run: the files, the state, and the summary of what the server's job did with them.
type wikiImporter struct {
	t         *Transport
	sessionID string
	opts      wikiImportOptions
	state     *wikiImportState
	summary   *wikiImportSummary
	progress  io.Writer
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
}

// register makes the file a note of the space, for the server's model to read: the registration says so
// (readBy server), and the server keeps the redacted text for its job rather than handing it back. It
// answers false for a file not to be read: one whose text the space already holds under a note this
// import did not make, or one the server would not take.
func (im *wikiImporter) register(source wikiImportSource) (bool, error) {
	file := im.state.Files[source.rel]
	raw, err := os.ReadFile(source.abs)
	if err != nil {
		return false, fmt.Errorf("orbit wiki import: reading %s: %w", source.abs, err)
	}
	body := map[string]interface{}{"path": source.rel, "text": string(raw), "readBy": "server"}
	out, sends, err := im.t.registerWikiNote(im.sessionID, im.opts.spaceID, body)
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
	// A note the server already held, when the registration had to be sent more than once under this very
	// path, is most likely this registration's own: its first send landed and the answer was lost. It is read
	// as this import's, rather than left out as imported before.
	landedEarlier := sends > 1 && note.Path == source.rel
	if !note.Created && file.NoteID != note.ID && !landedEarlier {
		// The same text is a note of the space already: imported before, or the same text under another
		// name. Proposing from it again would only repeat what is there.
		file.NoteID, file.NotePath = note.ID, note.Path
		file.Status, file.Why = wikiImportSkipped, "the space already holds this text as the note "+note.Path
		im.summary.KnownNotes++
		fmt.Fprintf(im.progress, "%s: already in the space as the note %s — not read again\n", source.rel, note.Path)
		return false, nil
	}
	if note.Created || landedEarlier {
		im.summary.NewNotes++
	}
	file.NoteID, file.NotePath, file.Status = note.ID, note.Path, wikiImportRegistered
	return true, nil
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

// ── The server's route ──────────────────────────────────────────────────────────────────────────

// registerWikiNote is `POST /api/runner/wiki/spaces/:id/notes` (contract `import.note`), and how many
// times it was sent. It is sent again through a transient failure: one text is one note of a space (UNIQUE
// (space_id, content_sha256)), so a second landing is answered with the note the first one made.
func (t *Transport) registerWikiNote(sessionID, spaceID string, body interface{}) (json.RawMessage, int, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, 0, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/notes"
	sends, err := t.doWiki(http.MethodPost, path, body, &out, taskOpTimeout, sessionHeader(sessionID), true)
	return out, sends, err
}

// ── The checkout ────────────────────────────────────────────────────────────────────────────────

// wikiImportRepoDir is where the checkout the import runs in is looked for, whose root the server's job is
// told (wiki_import_server.go): "" is the directory the command runs in, the session's checkout. A test
// points it at a repository of its own.
var wikiImportRepoDir = ""

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
