package main

// `--resume` reads the project directory for the process's OWN cwd and nothing else, so a
// conversation filed under another cwd's slug is not one this spawn can continue. The rebuild's
// first question — does this machine have the transcript? — was asked of a glob over every
// project directory, and a stale copy answered it: the rebuild skipped itself, claude was handed
// a --resume naming a conversation that is not where it looks, and the turn died as
// error_during_execution with a replayable history in Orbit's event log the whole time.
//
// That is a worktree that moved or a workspace directory that was renamed — the failure the
// rebuild exists for, in the one disguise that talked it out of running.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// writeConversationAt files a conversation holding one real turn at dir/<uuid>.jsonl, the way
// claude files its own, and returns the path written.
func writeConversationAt(t *testing.T, dir, sessionUUID, turnType string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, sessionUUID+".jsonl")
	body := `{"type":"` + turnType + `","message":{"role":"` + turnType + `","content":[{"type":"text","text":"hi"}]}}` + "\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// resumeRun is what one continuation spawn was observed to do.
type resumeRun struct {
	argv         []string                 // the argv the session's CLI was spawned with
	emitted      []map[string]interface{} // everything emitted before the CLI was taken down
	eventFetches int                      // reads of the stored-event log, which only a rebuild makes
}

// runResumeSpawn drives one runClaudeSessionProcess told this is a continuation (firstSpawn=false,
// what a reclaim with stored history or a revived session passes) against a control plane holding
// `stored`, and reports what it did. CLAUDE_CONFIG_DIR is the caller's to set, so the disk's
// premise can be stated before the spawn gets a chance to change it.
//
// The CLI is taken down as soon as it is up: every decision under test here is made before it
// starts, and nothing the fake does afterwards can change them.
func runResumeSpawn(t *testing.T, job *ClaimedSession, stored []StoredEvent, execDir string) resumeRun {
	t.Helper()
	fake := newFakeClaude(t, fakeStep{Emit: "system_init"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())

	var fetches atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			fetches.Add(1)
			_ = json.NewEncoder(w).Encode(StoredEventsResponse{Events: stored})
			return
		}
		_, _ = w.Write([]byte(`{}`)) // the inbox: nothing to hand over
	}))
	t.Cleanup(api.Close)

	var mu sync.Mutex
	var emitted []map[string]interface{}
	ctx, cancel := context.WithTimeout(context.Background(), fakeClaudeTimeout)
	defer cancel()
	dir := t.TempDir()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runClaudeSessionProcess(ctx, context.Background(),
			NewTransport(api.URL, "runner-token"),
			job, "11111111-1111-4111-8111-111111111111", execDir, dir,
			func(eventType string, payload map[string]interface{}) {
				mu.Lock()
				defer mu.Unlock()
				emitted = append(emitted, map[string]interface{}{"type": eventType, "payload": payload})
			},
			func(string, string, map[string]interface{}) {},
			func(string) {}, false, nil,
			func(TurnCompleteRequest, ...context.Context) error { return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	// The session's own spawn, not the first thing this fake is ever asked: a version probe runs
	// against it too, and which of the two lands first is a race.
	sessionArgv := func() []string {
		for _, s := range fake.Spawns() {
			if containsArgs(s.Argv, []string{"--input-format", "stream-json"}) {
				return s.Argv
			}
		}
		return nil
	}
	waitUntil(t, func() bool { return sessionArgv() != nil }, "the CLI was never spawned for the session")
	argv := sessionArgv()
	cancel()
	select {
	case <-done:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the session never finished after its CLI was taken down")
	}
	mu.Lock()
	defer mu.Unlock()
	return resumeRun{argv: argv, emitted: emitted, eventFetches: int(fetches.Load())}
}

func transcriptWasRebuilt(emitted []map[string]interface{}) bool {
	for _, e := range emitted {
		if e["type"] != evSystem {
			continue
		}
		if p, _ := e["payload"].(map[string]interface{}); p != nil && p["subtype"] == "transcript_rebuilt" {
			return true
		}
	}
	return false
}

// The failure: this machine still has the conversation, but under the project directory of a cwd
// the session no longer runs in. Nothing is where the CLI reads, so this --resume can only be
// answered "No conversation found with session ID" — the glob finding the stale copy is the
// reason to rebuild, not a reason to skip it. Orbit has the history to rebuild from.
func TestResumeRebuildsWhenTheOnlyCopyIsUnderAnotherCwd(t *testing.T) {
	job := claudeSpawnJob(t)
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	execDir := t.TempDir()

	writeConversationAt(t, filepath.Join(configDir, "projects", "-root-orbit-worktrees-moved"),
		job.SessionUUID, "user")
	want, err := claudeTranscriptPath(execDir, job.SessionUUID)
	if err != nil {
		t.Fatal(err)
	}
	// The premise, asserted rather than assumed, so the test cannot pass by some setup accident
	// of its own: the glob finds a conversation and the path claude reads is not it.
	if findClaudeTranscript(job.SessionUUID) == "" {
		t.Fatal("premise: the conversation must be on this machine, under another cwd's slug")
	}
	if isRegularFile(want) {
		t.Fatal("premise: the path claude reads must start empty:", want)
	}

	run := runResumeSpawn(t, job, []StoredEvent{
		ev(1, evUser, map[string]interface{}{"text": "rename the widget"}),
		ev(2, evAssistant, map[string]interface{}{"text": "done"}),
	}, execDir)

	if containsArgs(run.argv, []string{"--session-id", job.SessionUUID}) {
		t.Errorf("argv %v opens a new conversation instead of continuing the one on disk", run.argv)
	}
	if !claudeTranscriptHasConversation(want) {
		t.Fatalf("nothing at %s after the spawn: --resume can only answer \"No conversation found with session ID\","+
			" while the transcript it needed sits at %s", want, findClaudeTranscript(job.SessionUUID))
	}
}

// And the reverse, which is the cost of the common path: a machine that already holds the
// conversation where claude reads it must not rebuild, or even fetch the event log to find out
// whether it should. The file it holds is not one a render would produce, so a rebuild would show
// both in the bytes and in the emitted event.
func TestResumeLeavesTheConversationItAlreadyHasAlone(t *testing.T) {
	job := claudeSpawnJob(t)
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	execDir := t.TempDir()

	want, err := claudeTranscriptPath(execDir, job.SessionUUID)
	if err != nil {
		t.Fatal(err)
	}
	if got := writeConversationAt(t, filepath.Dir(want), job.SessionUUID, "user"); got != want {
		t.Fatalf("wrote the conversation to %s, but claude reads %s", got, want)
	}
	before, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}

	run := runResumeSpawn(t, job, []StoredEvent{
		ev(1, evUser, map[string]interface{}{"text": "rename the widget"}),
		ev(2, evAssistant, map[string]interface{}{"text": "done"}),
	}, execDir)

	if !containsArgs(run.argv, []string{"--resume", job.SessionUUID}) {
		t.Errorf("argv %v does not resume the conversation this machine already has", run.argv)
	}
	if run.eventFetches != 0 {
		t.Errorf("the event log was read %d times to decide a question the disk already answered", run.eventFetches)
	}
	if transcriptWasRebuilt(run.emitted) {
		t.Error("the transcript was rebuilt although claude already had this conversation")
	}
	after, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Errorf("the transcript was re-rendered:\nbefore: %s\nafter:  %s", before, after)
	}
}
