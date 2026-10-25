package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// `orbit wiki import` (contract `import`, criterion 1): what the command does on this machine — the files it
// reads, the notes it registers, and its words — before the server's job reads the notes
// (wiki_import_server_test.go holds the command to that job).
//
// The note route is a fake one, which keeps notes one per content and "redacts" one secret, as the server's
// redactor does; fakeImportServer serves it beside the import job's routes.

// fakeImportSecret is the one secret the fake door takes out of a note, as the server's redactor takes
// out the owner's workspace.env values.
const fakeImportSecret = "SECRET-VALUE-123"

// fakeImportDoor is the note route: one note per content, as the server keeps them.
type fakeImportDoor struct {
	mu sync.Mutex
	// Paths the door refuses as a note (WIKI_SCHEMA), as the server refuses a text past its limit.
	refusePaths   map[string]bool
	notes         map[string]map[string]interface{}
	registrations []string
	nextID        int
}

func (d *fakeImportDoor) note(w http.ResponseWriter, raw []byte) {
	var body struct {
		Path string `json:"path"`
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &body)
	d.registrations = append(d.registrations, body.Path)
	if d.refusePaths[body.Path] {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"WIKI_SCHEMA","message":"the note does not have the shape this contract gives it","errors":[{"path":"text","message":"must be at most 100000 characters"}]}`))
		return
	}
	text := strings.ReplaceAll(body.Text, fakeImportSecret, "[redacted]")
	sum := sha256.Sum256([]byte(text))
	key := hex.EncodeToString(sum[:])
	note, known := d.notes[key]
	if !known {
		d.nextID++
		note = map[string]interface{}{"id": fmt.Sprintf("note-%d", d.nextID), "spaceId": "space-1", "path": body.Path,
			"contentSha256": key, "chars": len([]rune(text)), "redacted": text != body.Text, "text": text}
		d.notes[key] = note
	}
	answer := map[string]interface{}{"created": !known}
	for k, v := range note {
		answer[k] = v
	}
	out, _ := json.Marshal(answer)
	_, _ = w.Write(out)
}

func (d *fakeImportDoor) Registrations() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.registrations...)
}

// wikiImportTestRepo is a repository of two files and one commit: the checkout the import runs in.
func wikiImportTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for path, text := range map[string]string{"src/app/main.go": "package main\n", "docs/guide.md": "# Guide\n"} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{
		{"init", "-q"},
		// Named as the repository a note's absolute paths name it: /root/orbit/docs/guide.md.
		{"remote", "add", "origin", "https://github.com/wikova/orbit.git"},
		{"add", "."},
		{"-c", "user.email=spec@orbit.invalid", "-c", "user.name=spec", "commit", "-q", "-m", "the repository"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// memoryLibrary writes a memory directory: each file under its name, with the frontmatter type given.
func memoryLibrary(t *testing.T, files map[string][2]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "memory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, file := range files {
		kind, body := file[0], file[1]
		text := body
		if kind != "" {
			text = "---\nname: " + strings.TrimSuffix(name, ".md") + "\ndescription: a test note\nmetadata:\n  type: " + kind +
				"\n  modified: 2026-09-20T10:00:00.000Z\n---\n\n" + body
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runImport(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	err := cmdWikiCLI(append([]string{"import"}, args...), strings.NewReader(""), &out)
	return out.String(), err
}

func importSummary(t *testing.T, args ...string) (wikiImportSummary, error) {
	t.Helper()
	out, err := runImport(t, append(args, "--json")...)
	var summary wikiImportSummary
	if jsonErr := json.Unmarshal([]byte(strings.TrimSpace(out)), &summary); jsonErr != nil {
		t.Fatalf("the summary is not JSON (%v): %q (run error: %v)", jsonErr, out, err)
	}
	return summary, err
}

// ── The files ───────────────────────────────────────────────────────────────────────────────────

func TestWikiImportLeavesOutWhatIsNotANote(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-ok.md":      {"feedback", "fact"},
		"feedback-empty.md":   {"", "   \n"},
		"feedback-long.md":    {"", strings.Repeat("x", wikiImportNoteMaxChars+1)},
		"notes.txt":           {"", "not Markdown"},
		".hidden.md":          {"", "hidden"},
		"feedback-refused.md": {"feedback", "the server will not take this one"},
	})
	if err := os.WriteFile(filepath.Join(library, "feedback-binary.md"), []byte{0xff, 0xfe, 0x00, 0x41}, 0o644); err != nil {
		t.Fatal(err)
	}
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-ok.md": 1}))
	server.door.refusePaths["memory/feedback-refused.md"] = true
	wikiImportServerSession(t, server)
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	if got := server.door.Registrations(); !reflect.DeepEqual(got, []string{"memory/feedback-ok.md", "memory/feedback-refused.md"}) {
		t.Errorf("registered %v", got)
	}
	if summary.Skipped != 4 || summary.Proposed != 1 || summary.Files != 5 || summary.Remaining != 0 {
		t.Errorf("summary = %+v: the empty, the too long, the binary and the refused file are left out", summary)
	}
	if jobs := server.Jobs(); len(jobs) != 1 || len(jobs[0].Notes) != 1 || jobs[0].Notes[0].File != "memory/feedback-ok.md" {
		t.Errorf("the job was handed %+v, want the one note that was registered", jobs)
	}
	// One file on its own is imported under its own name.
	single := filepath.Join(t.TempDir(), "CLAUDE.md")
	if err := os.WriteFile(single, []byte("Agents read this first."), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := importSummary(t, "--from", single, "--space", "space-1"); err != nil {
		t.Fatal(err)
	}
	if got := server.door.Registrations(); got[len(got)-1] != "CLAUDE.md" {
		t.Errorf("a single file registered as %q", got[len(got)-1])
	}
}

// ── The command, its words, and who may run it ──────────────────────────────────────────────────

func TestWikiImportNeedsASessionTheSwitchAndItsFlags(t *testing.T) {
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envWiki, "on")
	if _, err := runImport(t, "--from", "x", "--space", "s1"); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Errorf("outside a session = %v", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "off")
	if _, err := runImport(t, "--from", "x", "--space", "s1"); err == nil || !strings.Contains(err.Error(), "ORBIT_WIKI=off") {
		t.Errorf("with the wiki off = %v", err)
	}
	t.Setenv(envWiki, "on")
	for _, args := range [][]string{
		{"--space", "s1"},
		{"--from", "x"},
		{"--from", "x", "--space", "s1", "--max-ops", "31"},
		{"--from", "x", "--space", "s1", "--concurrency", "0"},
		{"--from", "x", "--space", "a/b"},
	} {
		if _, err := runImport(t, args...); err == nil {
			t.Errorf("orbit wiki import %v was taken", args)
		}
	}
	var help strings.Builder
	if err := cmdWikiCLI([]string{"import", "--help"}, strings.NewReader(""), &help); err != nil || help.String() != wikiImportHelp {
		t.Errorf("orbit wiki import --help = %v, %q", err, help.String())
	}
	if !strings.Contains(wikiHelp, "orbit wiki import --from <dir|file> --space ID") {
		t.Error("`orbit wiki --help` does not list the import")
	}
}

func TestWikiImportIsTheContractsAndIsPreApproved(t *testing.T) {
	imports := wikiContract(t)["import"].(map[string]interface{})
	cli := imports["cli"].(map[string]interface{})
	if cli["precondition"] != wikiImportPrecondition {
		t.Errorf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiImportPrecondition, cli["precondition"])
	}
	rules := imports["rules"].(map[string]interface{})
	for name, value := range map[string]int{"opsPerRun": wikiImportOpsPerRun, "noteMaxChars": wikiImportNoteMaxChars} {
		if int(rules[name].(float64)) != value {
			t.Errorf("import.rules.%s is %v in the contract and %d here", name, rules[name], value)
		}
	}
	// The one route of the import's own the command calls before the job's (wiki_import_server_test.go).
	routes, _ := wikiSurface(t)["doors"].(map[string]interface{})["runner"].(map[string]interface{})["importRoutes"].([]interface{})
	if !contains(stringsOf(routes), "POST /api/runner/wiki/spaces/:id/notes") {
		t.Errorf("the contract's import routes are %v, and have no note registration", routes)
	}
	if wikiToolNames["wiki_import"] {
		t.Error("the import waits for the server's job, which is a command's wait, and no MCP tool")
	}

	spec := wikiImportCLICapabilities[0]
	if spec.Tool != "wiki_import" || !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "import"}) || !spec.SessionOnly || !spec.Mutates {
		t.Fatalf("the capability is %#v", spec)
	}
	if !strings.HasPrefix(spec.Description, wikiImportPrecondition) || !strings.Contains(wikiImportHelp, wikiImportPrecondition) {
		t.Error("the description or the help does not lead with the precondition")
	}
	if strings.Index(wikiImportHelp, wikiImportPrecondition) > strings.Index(wikiImportHelp, "Each file is registered") {
		t.Error("the help states the mechanics before the precondition")
	}
	for _, phrase := range []string{"never write an entry yourself", "A principle is never proposed", "at most 30 ops a run",
		"no model of this session's is asked", "when the System model refuses the deployment's key"} {
		if !strings.Contains(spec.Description, phrase) {
			t.Errorf("the description does not say %q", phrase)
		}
	}
	// Every flag it advertises is one the parser takes, documented in its help and named in its schema.
	fs := flag.NewFlagSet("orbit wiki import", flag.ContinueOnError)
	for _, name := range []string{"from", "space", "state"} {
		fs.String(name, "", "")
	}
	fs.Int("max-ops", 0, "")
	fs.Int("concurrency", 0, "")
	fs.Bool("json", false, "")
	advertised := []string{}
	for _, argument := range spec.Arguments {
		for _, word := range strings.Fields(argument) {
			if strings.HasPrefix(word, "--") {
				name := strings.TrimPrefix(word, "--")
				advertised = append(advertised, name)
				if fs.Lookup(name) == nil || !strings.Contains(wikiImportHelp, "--"+name) {
					t.Errorf("--%s is advertised and is not parsed and documented", name)
				}
			}
		}
	}
	properties, _ := spec.InputSchema["properties"].(map[string]interface{})
	names := []string{}
	for name := range properties {
		names = append(names, name)
		if fs.Lookup(name) == nil {
			t.Errorf("the schema names --%s, which the parser does not take", name)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"concurrency", "from", "max-ops", "space", "state"}) || !reflect.DeepEqual(spec.InputSchema["required"], []string{"from", "space"}) {
		t.Errorf("the schema = %#v", spec.InputSchema)
	}
	if len(advertised) != 6 {
		t.Errorf("advertised %v", advertised)
	}
	// Pre-approved for the session it runs in, as the other wiki verbs are.
	exe := "/usr/local/bin/orbit"
	if rules := strings.Join(orbitCLIAllowedTools(exe, false), "\n"); !strings.Contains(rules, "Bash("+exe+" wiki import *)") {
		t.Errorf("orbit wiki import is advertised and pre-approved for nobody: %q", rules)
	}
}

// stringsOf is a JSON array of strings as Go strings.
func stringsOf(values []interface{}) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		text, _ := value.(string)
		out = append(out, text)
	}
	return out
}
