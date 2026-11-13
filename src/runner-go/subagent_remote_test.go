//go:build linux || darwin

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The target's half of a cross-workspace SubAgent (docs/subagent-design.md §10.2, §10.3), against a stub control
// plane and a scripted `claude`: the claim, the temporary detached worktree outside the workspace's workDir, the
// relayed events, the discarded-changes line, the worktree's removal, a stop, and a restart's INTERRUPTED report.

// remoteChildScript is the child engine: it records where it ran and its prompt, writes one file through a Write
// call and one through the shell, waits for $REMOTE_MARKS/finish when REMOTE_WAIT is set, and ends.
const remoteChildScript = `#!/bin/sh
read -r frame
printf '%s' "$frame" > "$REMOTE_MARKS/frame"
pwd > "$REMOTE_MARKS/cwd"
printf '%s\n' "$@" > "$REMOTE_MARKS/argv"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"child"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w","name":"Write","input":{"file_path":"src/new.swift","content":"x"}}]}}'
mkdir -p src && printf 'x' > src/new.swift
printf 'changed\n' >> README.md
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"written"}]}}'
touch "$REMOTE_MARKS/started"
if [ -n "$REMOTE_WAIT" ]; then
  trap 'exit 130' INT
  while [ ! -f "$REMOTE_MARKS/finish" ]; do sleep 0.05; done
fi
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"swift build passed","total_cost_usd":0.02}'
`

// remoteStub is the control plane's side: it hands out one claim and records what the runner sends.
type remoteStub struct {
	*httptest.Server
	mu      sync.Mutex
	claim   map[string]interface{}
	claims  int
	events  []map[string]interface{}
	ends    []map[string]interface{}
	ended   chan map[string]interface{}
	pathLog []string
}

func newRemoteStub(t *testing.T, workDir string) *remoteStub {
	t.Helper()
	stub := &remoteStub{ended: make(chan map[string]interface{}, 4)}
	stub.claim = map[string]interface{}{
		"runId": "run-1", "sessionId": "11111111-1111-1111-1111-111111111111", "toolUseId": "toolu_delegate",
		"workspaceId": "ws-mac", "workDir": workDir, "type": "general", "definitionSource": "builtin",
		"background": false, "prompt": "run swift build and change one file",
		"exec": map[string]interface{}{"provider": "claude", "model": "claude-sonnet-5-5", "permissionMode": "acceptEdits"},
	}
	stub.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var decoded map[string]interface{}
		_ = json.Unmarshal(body, &decoded)
		stub.mu.Lock()
		stub.pathLog = append(stub.pathLog, r.Method+" "+r.URL.Path)
		stub.mu.Unlock()
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/claim"):
			stub.mu.Lock()
			stub.claims++
			stub.mu.Unlock()
			_ = json.NewEncoder(w).Encode(stub.claim)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/events"):
			events, _ := decoded["events"].([]interface{})
			stub.mu.Lock()
			for _, e := range events {
				stub.events = append(stub.events, e.(map[string]interface{}))
			}
			stub.mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/api/runner/subagent-runs/"):
			decoded["path"] = strings.TrimPrefix(r.URL.Path, "/api")
			stub.mu.Lock()
			stub.ends = append(stub.ends, decoded)
			stub.mu.Unlock()
			stub.ended <- decoded
			_, _ = w.Write([]byte(`{"applied":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(stub.Close)
	return stub
}

func (s *remoteStub) awaitEnd(t *testing.T) map[string]interface{} {
	t.Helper()
	select {
	case end := <-s.ended:
		return end
	case <-time.After(30 * time.Second):
		t.Fatal("the runner never reported the remote SubAgent's end")
		return nil
	}
}

type remoteRig struct {
	workDir, marks string
	stub           *remoteStub
	t              *Transport
}

// newRemoteRig is a workspace checkout with one commit and a clean tree, the scripted child on PATH, and a private
// ORBIT_HOME, where the temporary worktree goes.
func newRemoteRig(t *testing.T) *remoteRig {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	workDir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", workDir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	writeTestFile(t, filepath.Join(workDir, "README.md"), "hello\n")
	run("add", "README.md")
	run("commit", "-q", "-m", "first")
	bin, marks := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(remoteChildScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REMOTE_MARKS", marks)
	stub := newRemoteStub(t, workDir)
	previous := remoteRelayInterval
	remoteRelayInterval = 20 * time.Millisecond
	t.Cleanup(func() { remoteRelayInterval = previous })
	return &remoteRig{workDir: workDir, marks: marks, stub: stub, t: NewTransport(stub.URL, "runner-token")}
}

func gitLines(t *testing.T, dir string, args ...string) []string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func (r *remoteRig) marked(name string) bool {
	_, err := os.Stat(filepath.Join(r.marks, name))
	return err == nil
}

// The whole run: a worktree outside workDir at its HEAD, the child in it, its events relayed in order, its changes
// named and discarded, the worktree and its record gone, and the workspace's checkout as it was.
func TestRemoteSubagentRunsInATemporaryWorktreeAndRemovesIt(t *testing.T) {
	r := newRemoteRig(t)
	t.Setenv("REMOTE_WAIT", "1")
	head := gitLines(t, r.workDir, "rev-parse", "HEAD")[0]

	remoteSubagents.onHeartbeat(r.t, []string{"run-1"}, nil, false)
	waitUntil(t, func() bool { return r.marked("started") }, "the child engine never started")

	// While it runs: a second worktree, detached at the workspace's HEAD, outside its workDir.
	cwdRaw, _ := os.ReadFile(filepath.Join(r.marks, "cwd"))
	cwd := strings.TrimSpace(string(cwdRaw))
	tree, _ := filepath.EvalSymlinks(filepath.Join(remoteSubagentDir("run-1"), "tree"))
	if resolved, _ := filepath.EvalSymlinks(cwd); resolved != tree {
		t.Fatalf("the child ran in %s, want the run's worktree %s", cwd, tree)
	}
	work, _ := filepath.EvalSymlinks(r.workDir)
	if strings.HasPrefix(tree, work+string(filepath.Separator)) {
		t.Fatalf("the worktree %s is inside the workspace's workDir %s", tree, work)
	}
	list := gitLines(t, r.workDir, "worktree", "list", "--porcelain")
	if !strings.Contains(strings.Join(list, "\n"), "detached") || len(gitLines(t, r.workDir, "worktree", "list")) != 2 {
		t.Fatalf("while it runs, the workspace has worktrees %v; want its own and one detached", list)
	}
	if got := gitLines(t, tree, "rev-parse", "HEAD")[0]; got != head {
		t.Fatalf("the worktree is at %s, want the workspace's HEAD %s", got, head)
	}
	if status := gitLines(t, r.workDir, "status", "--porcelain"); len(status) != 0 {
		t.Fatalf("the child's edits reached the workspace's checkout: %v", status)
	}
	frame, _ := os.ReadFile(filepath.Join(r.marks, "frame"))
	if !strings.Contains(string(frame), "run swift build and change one file") {
		t.Fatalf("the child was not given the brief: %s", frame)
	}
	argv, _ := os.ReadFile(filepath.Join(r.marks, "argv"))
	if !strings.Contains(string(argv), "You are a SubAgent") || !strings.Contains(string(argv), "acceptEdits") {
		t.Fatalf("the child was not started in child mode with the preamble and its mode:\n%s", argv)
	}

	if err := os.WriteFile(filepath.Join(r.marks, "finish"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	end := r.stub.awaitEnd(t)
	if end["path"] != "/runner/subagent-runs/run-1" || end["status"] != subagentStatusDone {
		t.Fatalf("the end was reported as %v", end)
	}
	result, _ := end["resultSummary"].(string)
	if !strings.HasPrefix(result, "swift build passed") ||
		!strings.HasSuffix(result, "Discarded changes: 2 files (README.md, src/new.swift)") {
		t.Fatalf("the result is %q", result)
	}
	if files, _ := end["changedFiles"].([]interface{}); len(files) != 0 {
		t.Fatalf("a remote run brought files back: %v", files)
	}

	// The events, numbered from 1 in order, the ones the parent's stream carries.
	r.stub.mu.Lock()
	events := append([]map[string]interface{}(nil), r.stub.events...)
	r.stub.mu.Unlock()
	if len(events) == 0 {
		t.Fatal("no events were relayed")
	}
	sawWrite := false
	for i, e := range events {
		if int(e["seq"].(float64)) != i+1 {
			t.Fatalf("event %d has seq %v", i, e["seq"])
		}
		if e["type"] == evToolUse {
			sawWrite = true
		}
	}
	if !sawWrite {
		t.Fatalf("the Write call was not relayed: %v", events)
	}

	// Afterwards: no worktree but the workspace's own, no record, a clean checkout.
	waitUntil(t, func() bool { _, err := os.Stat(remoteSubagentDir("run-1")); return os.IsNotExist(err) },
		"the run's directory was left behind")
	if list := gitLines(t, r.workDir, "worktree", "list"); len(list) != 1 {
		t.Fatalf("worktrees left behind: %v", list)
	}
	if status := gitLines(t, r.workDir, "status", "--porcelain"); len(status) != 0 {
		t.Fatalf("the workspace's checkout changed: %v", status)
	}
}

// A workDir that is not a git repository is refused, and nothing is made in it.
func TestRemoteSubagentRefusesAWorkDirThatIsNotGit(t *testing.T) {
	r := newRemoteRig(t)
	plain := t.TempDir()
	r.stub.claim["workDir"] = plain
	remoteSubagents.onHeartbeat(r.t, []string{"run-1"}, nil, false)
	end := r.stub.awaitEnd(t)
	result, _ := end["resultSummary"].(string)
	if end["status"] != subagentStatusFailed || !strings.Contains(result, "SUBAGENT_WORKSPACE_NOT_GIT") {
		t.Fatalf("the end was %v", end)
	}
	if entries, _ := os.ReadDir(plain); len(entries) != 0 {
		t.Fatalf("something was written in the workDir: %v", entries)
	}
	if r.marked("started") {
		t.Fatal("the child ran")
	}
}

// A stop from the server (the parent stopped or ended) ends the child within the grace: STOPPED, worktree removed.
func TestRemoteSubagentStopsWhenTheServerSaysSo(t *testing.T) {
	r := newRemoteRig(t)
	t.Setenv("REMOTE_WAIT", "1")
	remoteSubagents.onHeartbeat(r.t, []string{"run-1"}, nil, false)
	waitUntil(t, func() bool { return r.marked("started") }, "the child engine never started")
	remoteSubagents.onHeartbeat(r.t, nil, []string{"run-1"}, false)
	end := r.stub.awaitEnd(t)
	if end["status"] != subagentStatusStopped {
		t.Fatalf("the end was %v", end)
	}
	if result, _ := end["resultSummary"].(string); !strings.Contains(result, "Discarded changes: 2 files") {
		t.Fatalf("a stopped run does not say what it discarded: %q", result)
	}
	if list := gitLines(t, r.workDir, "worktree", "list"); len(list) != 1 {
		t.Fatalf("worktrees left behind: %v", list)
	}
}

// The runner stopping ends a hosted run INTERRUPTED; a run the previous process left unreported is reported
// INTERRUPTED by the next start, which removes its worktree.
func TestRemoteSubagentInterruptedOnRunnerStopAndRestart(t *testing.T) {
	t.Run("stop", func(t *testing.T) {
		r := newRemoteRig(t)
		t.Setenv("REMOTE_WAIT", "1")
		remoteSubagents.onHeartbeat(r.t, []string{"run-1"}, nil, false)
		waitUntil(t, func() bool { return r.marked("started") }, "the child engine never started")
		remoteSubagents.stopAll(subagentStopRunnerStopped)
		end := r.stub.awaitEnd(t)
		if end["status"] != subagentStatusInterrupted {
			t.Fatalf("the end was %v", end)
		}
		if list := gitLines(t, r.workDir, "worktree", "list"); len(list) != 1 {
			t.Fatalf("worktrees left behind: %v", list)
		}
	})
	t.Run("restart", func(t *testing.T) {
		r := newRemoteRig(t)
		// What a process that died mid-run leaves: the record and the worktree.
		tree := filepath.Join(remoteSubagentDir("run-9"), "tree")
		if err := addRemoteSubagentTree("run-9", r.workDir, tree); err != nil {
			t.Fatal(err)
		}
		_ = writeJSONFile(filepath.Join(remoteSubagentDir("run-9"), "run.json"), remoteSubagentRecord{RunID: "run-9", WorkDir: r.workDir, Tree: tree})
		if list := gitLines(t, r.workDir, "worktree", "list"); len(list) != 2 {
			t.Fatalf("the left-behind worktree was not made: %v", list)
		}
		recoverRemoteSubagents(r.t)
		end := r.stub.awaitEnd(t)
		if end["path"] != "/runner/subagent-runs/run-9" || end["status"] != subagentStatusInterrupted {
			t.Fatalf("the end was %v", end)
		}
		if list := gitLines(t, r.workDir, "worktree", "list"); len(list) != 1 {
			t.Fatalf("worktrees left behind: %v", list)
		}
		if _, err := os.Stat(remoteSubagentDir("run-9")); !os.IsNotExist(err) {
			t.Fatal("the record was left behind")
		}
	})
}

// A stop for a run this process never claimed (its parent ended first) is reported STOPPED, once.
func TestRemoteSubagentStopOfAnUnclaimedRun(t *testing.T) {
	r := newRemoteRig(t)
	remoteSubagents.onHeartbeat(r.t, []string{"run-5"}, []string{"run-5"}, false)
	remoteSubagents.onHeartbeat(r.t, nil, []string{"run-5"}, false)
	end := r.stub.awaitEnd(t)
	if end["path"] != "/runner/subagent-runs/run-5" || end["status"] != subagentStatusStopped {
		t.Fatalf("the end was %v", end)
	}
	time.Sleep(200 * time.Millisecond)
	r.stub.mu.Lock()
	defer r.stub.mu.Unlock()
	if r.stub.claims != 0 || len(r.stub.ends) != 1 {
		t.Fatalf("claims %d, ends %d: want none and one", r.stub.claims, len(r.stub.ends))
	}
}

func TestDiscardedChangesLine(t *testing.T) {
	if got := discardedChangesLine(nil); got != "" {
		t.Fatalf("nothing changed: %q", got)
	}
	if got := discardedChangesLine([]string{"a.go"}); got != "Discarded changes: 1 file (a.go)" {
		t.Fatalf("one: %q", got)
	}
	if got := discardedChangesLine([]string{"a.go", "b/c.swift"}); got != "Discarded changes: 2 files (a.go, b/c.swift)" {
		t.Fatalf("two: %q", got)
	}
	many := make([]string, 23)
	for i := range many {
		many[i] = "f" + string(rune('a'+i))
	}
	if got := discardedChangesLine(many); !strings.HasPrefix(got, "Discarded changes: 23 files (fa, fb,") || !strings.HasSuffix(got, ", and 3 more)") {
		t.Fatalf("many: %q", got)
	}
}

func TestParsePorcelainZPaths(t *testing.T) {
	out := " M README.md\x00?? src/new.swift\x00R  to.go\x00from.go\x00 D gone.txt\x00"
	got := parsePorcelainZPaths(out)
	want := []string{"README.md", "gone.txt", "src/new.swift", "to.go"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// The runner reports its operating system on every request and in the link's Hello; the control plane stores it as
// the os:<GOOS> capability that `needs: ["os:darwin"]` matches (withRunnerOs).
func TestRunnerReportsItsOperatingSystem(t *testing.T) {
	if got := linkHello("p").GetOs(); got != runtime.GOOS {
		t.Fatalf("the link's Hello says os %q, want %q", got, runtime.GOOS)
	}
	seen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case seen <- r.Header.Get(runnerOSHeader):
		default:
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	_ = NewTransport(server.URL, "tok").do(nil, "GET", "/runner/ping", nil, nil, 5*time.Second)
	if got := <-seen; got != runtime.GOOS {
		t.Fatalf("the %s header is %q, want %q", runnerOSHeader, got, runtime.GOOS)
	}
}

// The parent's half: a delegate call with workspace is sent with its prompt, answered as a remote run, starts no
// child here, writes the relayed events into the session's stream, and returns the run's text when the server says
// it ended. Nothing is reported from here: the target reports the end. A stop of the session asks the server.
func TestRemoteSubagentParentFollowsTheRelayedEvents(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	s.mu.Lock()
	s.subagentRemote = "orbit-macos"
	s.remoteEvents = []map[string]interface{}{{"seq": 1, "type": evToolUse, "payload": map[string]interface{}{
		"id": "run-1:toolu_b", "name": "Bash", "input": map[string]interface{}{"command": "swift build"},
		"parentToolUseId": "toolu_delegate", "subagentRunId": "run-1",
	}}}
	s.mu.Unlock()

	report := r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "build OrbitKit", "prompt": "run swift build in src/ios/OrbitKit",
		"workspace": "orbit-macos",
	})
	if report.Status != subagentStatusRunning || report.Workspace != "orbit-macos" {
		t.Fatalf("the remote SubAgent started as %+v", report)
	}
	s.mu.Lock()
	opened := s.remoteOpens[0]
	s.mu.Unlock()
	if opened["workspace"] != "orbit-macos" || opened["prompt"] != "run swift build in src/ios/OrbitKit" {
		t.Fatalf("the delegate call was opened with %v", opened)
	}
	r.awaitEvents("the relayed Bash call", 1, func(e RunEvent) bool {
		return e.Type == evToolUse && e.Payload["id"] == "run-1:toolu_b" && e.Payload["parentToolUseId"] == "toolu_delegate"
	})

	s.mu.Lock()
	s.remoteStatus, s.remoteResult = subagentStatusDone, "Build passed.\n\nDiscarded changes: 1 file (Sources/OrbitKit/X.swift)"
	s.mu.Unlock()
	var ended subagentReport
	waitUntil(t, func() bool {
		ended = r.call("subagent_wait", map[string]interface{}{"runId": report.RunID, "waitMs": float64(500)})
		return ended.Status != subagentStatusRunning
	}, "the remote SubAgent never ended")
	if ended.Status != subagentStatusDone || !strings.HasSuffix(ended.Result, "Discarded changes: 1 file (Sources/OrbitKit/X.swift)") {
		t.Fatalf("the remote SubAgent ended as %+v", ended)
	}
	if len(r.reports()) != 0 {
		t.Fatalf("the parent's runner reported a remote run's end: %v", r.reports())
	}
	if _, err := os.Stat(filepath.Join(r.marks, "started")); err == nil {
		t.Fatal("a child engine ran on the parent's machine")
	}
}

// A session's stop asks the server to stop a remote SubAgent, whose target stops the child.
func TestRemoteSubagentParentStopAsksTheServer(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	s.mu.Lock()
	s.subagentRemote = "orbit-macos"
	s.mu.Unlock()
	report := r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "build", "prompt": "build", "needs": []interface{}{"os:darwin"},
		"background": true,
	})
	s.mu.Lock()
	opened := s.remoteOpens[0]
	s.mu.Unlock()
	if needs, _ := opened["needs"].([]interface{}); len(needs) != 1 || needs[0] != "os:darwin" {
		t.Fatalf("needs was sent as %v", opened["needs"])
	}
	previous := subagentStopGrace
	subagentStopGrace = 200 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = previous })
	go func() {
		time.Sleep(100 * time.Millisecond)
		s.mu.Lock()
		s.remoteStatus, s.remoteResult = subagentStatusStopped, "The SubAgent was stopped by its parent session."
		s.mu.Unlock()
	}()
	s.live.cancel() // the session ends
	waitUntil(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.remoteStops > 0 },
		"the server was not asked to stop the remote SubAgent")
	r.awaitEvents("the remote SubAgent's terminal background_task", 1, func(e RunEvent) bool {
		return e.Type == evBackgroundTask && e.Payload["subagentRunId"] == report.RunID && e.Payload["status"] == bgStatusKilled
	})
	if len(r.reports()) != 0 {
		t.Fatalf("the parent's runner reported a remote run's end: %v", r.reports())
	}
}
