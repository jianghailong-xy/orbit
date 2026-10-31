package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// What the folder step of a machine's first workspace is told about a path (docs/first-workspace-contract.md §2.4):
// what is there, said of the path the runner looked at, `~` expanded and absolute.

// probeHome makes a temp directory this process's home (HOME is what userHome reads first), holding a git checkout
// on a branch, one on a detached HEAD, one on a branch a tag shares its name with, one with no commit yet, a
// directory that is no checkout, a file and a link back to itself.
func probeHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, name := range []string{"app", "detached", "tagged", "unborn"} {
		repo := filepath.Join(home, "code", name)
		if err := os.MkdirAll(repo, 0o755); err != nil {
			t.Fatal(err)
		}
		mustGit(t, repo, "init", "-b", "feature/first-workspace")
		if name != "unborn" {
			mustGit(t, repo, "-c", "user.email=test@orbit", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "base")
		}
	}
	mustGit(t, filepath.Join(home, "code", "detached"), "checkout", "--detach")
	mustGit(t, filepath.Join(home, "code", "tagged"), "checkout", "-b", "v1")
	mustGit(t, filepath.Join(home, "code", "tagged"), "tag", "v1")
	if err := os.Mkdir(filepath.Join(home, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(home, filepath.Join(home, "me")); err != nil {
		t.Fatal(err)
	}
	return home
}

// dirProbeWant is a DirProbe's expected fields, the branch by value.
type dirProbeWant struct {
	path                                string
	exists, isDir, isGit, isHome, freed bool
	branch                              string
}

func checkDirProbe(t *testing.T, what string, got DirProbe, want dirProbeWant) {
	t.Helper()
	branch := ""
	if got.Branch != nil {
		branch = *got.Branch
		if branch == "" {
			t.Errorf("%s: branch is an empty string, want a name or null", what)
		}
	}
	if got.Path != want.path || got.Exists != want.exists || got.IsDir != want.isDir || got.IsGit != want.isGit ||
		got.IsHome != want.isHome || branch != want.branch || (got.FreeBytes != nil) != want.freed || got.Error != "" {
		t.Errorf("%s: got path=%q exists=%v isDir=%v isGit=%v branch=%q isHome=%v freeBytes=%v error=%q\n"+
			"want path=%q exists=%v isDir=%v isGit=%v branch=%q isHome=%v freeBytes set=%v, no error",
			what, got.Path, got.Exists, got.IsDir, got.IsGit, branch, got.IsHome, got.FreeBytes, got.Error,
			want.path, want.exists, want.isDir, want.isGit, want.branch, want.isHome, want.freed)
	}
}

func TestProbeDirSaysWhatIsAtAPath(t *testing.T) {
	home := probeHome(t)
	app := filepath.Join(home, "code", "app")
	for _, tc := range []struct {
		name, path string
		want       dirProbeWant
	}{
		{"a checkout, by ~", "~/code/app", dirProbeWant{path: app, exists: true, isDir: true, isGit: true, freed: true, branch: "feature/first-workspace"}},
		{"the same checkout, absolute", app, dirProbeWant{path: app, exists: true, isDir: true, isGit: true, freed: true, branch: "feature/first-workspace"}},
		{"a directory that is no checkout", "~/notes", dirProbeWant{path: filepath.Join(home, "notes"), exists: true, isDir: true, freed: true}},
		{"a checkout on a detached HEAD", "~/code/detached", dirProbeWant{path: filepath.Join(home, "code", "detached"), exists: true, isDir: true, isGit: true, freed: true}},
		{"a branch a tag shares its name with", "~/code/tagged", dirProbeWant{path: filepath.Join(home, "code", "tagged"), exists: true, isDir: true, isGit: true, freed: true, branch: "v1"}},
		{"a checkout with no commit yet", "~/code/unborn", dirProbeWant{path: filepath.Join(home, "code", "unborn"), exists: true, isDir: true, isGit: true, freed: true, branch: "feature/first-workspace"}},
		{"a file", "~/notes.txt", dirProbeWant{path: filepath.Join(home, "notes.txt"), exists: true}},
		// Nothing there is an answer, not a failure: exists false and no error.
		{"nothing there", "~/code/new-app", dirProbeWant{path: filepath.Join(home, "code", "new-app")}},
		{"the home directory", "~", dirProbeWant{path: home, exists: true, isDir: true, isHome: true, freed: true}},
		{"the home directory by a trailing slash", home + "/", dirProbeWant{path: home, exists: true, isDir: true, isHome: true, freed: true}},
		{"the home directory through a link", "~/me", dirProbeWant{path: filepath.Join(home, "me"), exists: true, isDir: true, isHome: true, freed: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkDirProbe(t, tc.path, probeDir(tc.path, time.Minute), tc.want)
		})
	}
}

// A look that could not be taken says why, which is not the same answer as nothing being there.
func TestProbeDirSaysWhyItCouldNotLook(t *testing.T) {
	home := probeHome(t)
	got := probeDir("~/notes.txt/inside", time.Minute)
	if got.Error == "" || got.Exists || got.Path != filepath.Join(home, "notes.txt", "inside") {
		t.Fatalf("a path below a file = %+v, want an error and nothing claimed about it", got)
	}
}

// A look that hangs, as a stat on a mount that has gone away does, is answered by the deadline: the heartbeat's
// operation it is counted as must end, or the runner would hold off its updates for as long as the mount is gone.
func TestProbeDirAnswersByItsDeadlineWhenTheLookHangs(t *testing.T) {
	home := probeHome(t)
	release := make(chan struct{})
	look := lookAtDirProbe
	lookAtDirProbe = func(ctx context.Context, out DirProbe) DirProbe {
		<-release
		return look(ctx, out)
	}
	t.Cleanup(func() {
		close(release)
		lookAtDirProbe = look
	})
	answered := make(chan DirProbe, 1)
	go func() { answered <- probeDir("~/code/app", 50*time.Millisecond) }()
	select {
	case got := <-answered:
		if got.Error != "looking at it took longer than 50ms" || got.Exists || got.IsGit || got.Path != filepath.Join(home, "code", "app") {
			t.Fatalf("a look that hung = %+v, want the expanded path, nothing claimed, and why", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("probeDir waited for a look that hangs")
	}
}

// The run loop hands a heartbeat's question to startDirProbe on both transports: the answer of an HTTPS heartbeat
// and a link heartbeat's reconcile are the same HeartbeatResponse, applied by the same beat closure, which this tree
// tests by its source (TestTheRunLoopAppliesAQuietAnswerAsNoChange).
func TestTheRunLoopAnswersADirProbe(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	// Beside the Cursor key checks, in the same block and with nothing but comments between: answered on every beat
	// that is applied, rather than inside another request's branch.
	call := "\n\t\t\tstartDirProbe(resp.DirProbeRequest, &heartbeatOps, t.dirProbeResult)\n"
	next := "\t\t\tstartCursorKeyChecks(resp.CursorKeyChecks, &heartbeatOps, t.cursorKeyCheckResult)\n"
	at := strings.Index(body, call)
	if at < 0 {
		t.Fatal("runLoop no longer answers resp.DirProbeRequest through startDirProbe on the heartbeat's ops")
	}
	after := body[at+len(call):]
	end := strings.Index(after, next)
	if end < 0 {
		t.Fatal("startDirProbe no longer comes before the Cursor key checks")
	}
	for _, line := range strings.Split(strings.TrimSuffix(after[:end], "\n"), "\n") {
		if line != "" && !strings.HasPrefix(line, "\t\t\t//") {
			t.Fatalf("between startDirProbe and the Cursor key checks runLoop now reads %q", line)
		}
	}
}

// dirProbeQuestions are the paths both transports' tests ask about, in order, and what each answer must say.
func dirProbeQuestions(home string) []struct {
	path string
	want dirProbeWant
} {
	return []struct {
		path string
		want dirProbeWant
	}{
		{"~/code/app", dirProbeWant{path: filepath.Join(home, "code", "app"), exists: true, isDir: true, isGit: true, freed: true, branch: "feature/first-workspace"}},
		{"~/notes", dirProbeWant{path: filepath.Join(home, "notes"), exists: true, isDir: true, freed: true}},
		{"~/code/new-app", dirProbeWant{path: filepath.Join(home, "code", "new-app")}},
	}
}

// checkDirProbeAnswer reads one POST /runner/dir-probe-result body: the question's path echoed exactly, then the
// answer, which spells branch and freeBytes out as null rather than leaving them out.
func checkDirProbeAnswer(t *testing.T, raw []byte, asked string, want dirProbeWant) {
	t.Helper()
	var answer RunnerDirProbeResult
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatalf("answer %s: %v", raw, err)
	}
	if answer.Path != asked {
		t.Errorf("answer path = %q, want the question's %q as asked", answer.Path, asked)
	}
	checkDirProbe(t, asked, answer.Result, want)
	var wire struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"path", "exists", "isDir", "isGit", "branch", "isHome", "freeBytes"} {
		if _, ok := wire.Result[key]; !ok {
			t.Errorf("answer about %s leaves out %q: %s", asked, key, raw)
		}
	}
	if _, ok := wire.Result["error"]; ok {
		t.Errorf("answer about %s carries an error key on success: %s", asked, raw)
	}
	if !want.exists && (string(wire.Result["branch"]) != "null" || string(wire.Result["freeBytes"]) != "null") {
		t.Errorf("answer about a missing path: branch=%s freeBytes=%s, want both null", wire.Result["branch"], wire.Result["freeBytes"])
	}
}

// Over HTTPS: each heartbeat hands over one question, and each answer is POSTed to /runner/dir-probe-result.
func TestADirProbeIsAnsweredOverHTTPS(t *testing.T) {
	questions := dirProbeQuestions(probeHome(t))
	var mu sync.Mutex
	beats := 0
	var answers [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "POST /api/runner/heartbeat":
			q := questions[beats].path
			beats++
			_, _ = w.Write([]byte(`{"cancelSessionIds":[],"maxConcurrent":2,"dirProbeRequest":{"path":"` + q + `","requestedAt":"2026-10-31T09:00:00.000Z"}}`))
		case "POST /api/runner/dir-probe-result":
			answers = append(answers, body)
			_, _ = w.Write([]byte(`{"ok":true,"applied":true}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	tr := NewTransport(srv.URL, "runner-token")
	var ops countedOps
	for _, q := range questions {
		resp, err := tr.heartbeat(HeartbeatRequest{Status: "ONLINE"})
		if err != nil {
			t.Fatal(err)
		}
		if resp.DirProbeRequest == nil || resp.DirProbeRequest.Path != q.path {
			t.Fatalf("the heartbeat's question read as %+v, want %q", resp.DirProbeRequest, q.path)
		}
		startDirProbe(resp.DirProbeRequest, &ops, tr.dirProbeResult)
		ops.Wait()
	}
	mu.Lock()
	defer mu.Unlock()
	if len(answers) != len(questions) {
		t.Fatalf("%d answers, want %d", len(answers), len(questions))
	}
	for i, q := range questions {
		checkDirProbeAnswer(t, answers[i], q.path, q.want)
	}
}

// Over the runner link: the question comes in a HeartbeatAck's reconcile, and the answer goes as an Rpc on the
// daemon route POST /runner/dir-probe-result, with nothing sent over HTTPS.
func TestADirProbeIsAnsweredOverTheLink(t *testing.T) {
	questions := dirProbeQuestions(probeHome(t))
	r := newLinkWorkRig(t)
	var mu sync.Mutex
	beats := 0
	r.g.reconcile = func(*fakeWorkConn, map[string]json.RawMessage) []byte {
		mu.Lock()
		defer mu.Unlock()
		q := questions[beats].path
		beats++
		return []byte(`{"cancelSessionIds":[],"maxConcurrent":2,"dirProbeRequest":{"path":"` + q + `"}}`)
	}
	r.useLink(t)
	var ops countedOps
	for _, q := range questions {
		resp, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner))
		if err != nil {
			t.Fatal(err)
		}
		if resp.DirProbeRequest == nil || resp.DirProbeRequest.Path != q.path {
			t.Fatalf("the link reconcile's question read as %+v, want %q", resp.DirProbeRequest, q.path)
		}
		startDirProbe(resp.DirProbeRequest, &ops, r.t.dirProbeResult)
		ops.Wait()
	}
	calls := r.g.rpcsTo("/runner/dir-probe-result")
	if len(calls) != len(questions) {
		t.Fatalf("%d answers over the link, want %d", len(calls), len(questions))
	}
	for i, q := range questions {
		if calls[i].method != http.MethodPost {
			t.Errorf("answer %d went as %s, want POST", i, calls[i].method)
		}
		checkDirProbeAnswer(t, calls[i].body, q.path, q.want)
	}
	if sent := r.cp.requests("/api/runner/dir-probe-result"); len(sent) != 0 {
		t.Errorf("%d answers went over HTTPS while the link was in use", len(sent))
	}
}

// A heartbeat that asks nothing starts nothing.
func TestStartDirProbeWithNoQuestionDoesNothing(t *testing.T) {
	var ops countedOps
	for _, cmd := range []*DirProbeCommand{nil, {Path: ""}} {
		startDirProbe(cmd, &ops, func(RunnerDirProbeResult) error {
			t.Errorf("answered %+v, which asked nothing", cmd)
			return nil
		})
	}
	if ops.inFlight() != 0 {
		t.Fatalf("%d probes in flight", ops.inFlight())
	}
}
