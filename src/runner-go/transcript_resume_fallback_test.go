package main

// A resume is only as good as the conversation it names, and "the session has stored events" is
// not the same question as "this machine can resume it".
//
// `No conversation found with session ID` is what claude answers when --resume names something it
// cannot find locally. The caller decides --resume from the claim alone (a Reclaimed job with
// stored events, or any revived one), and the one thing that could have made the file exist — the
// rebuild from Orbit's own events — is skipped entirely when the stored events hold no replayable
// message: an engine that started, said `init` on stderr, and died leaves MaxSeq > 0 and zero
// messages. On the machine that saw that engine the file is there and resume works; on the next
// runner, a wiped ~/.claude or a moved worktree it is not, and the turn dies as
// error_during_execution with numTurns 0.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// resumeSpawn drives one runClaudeSessionProcess that has been told this is a continuation
// (firstSpawn=false, which is what a reclaim with stored history or a revived session passes),
// against a control plane holding `stored` for the session, and returns the argv the CLI was
// actually spawned with.
//
// The CLI is taken down as soon as it is up: the decision under test is the one made before the
// process starts, and nothing the fake does afterwards can change the argv it was started with.
//
// configDir is this machine's ~/.claude. A case that wants the conversation already present
// writes it in there before calling; every other case starts from a machine that has never seen
// the session.
func resumeSpawn(t *testing.T, job *ClaimedSession, stored []StoredEvent, configDir string) []string {
	t.Helper()
	fake := newFakeClaude(t, fakeStep{Emit: "system_init"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			_ = json.NewEncoder(w).Encode(StoredEventsResponse{Events: stored})
			return
		}
		_, _ = w.Write([]byte(`{}`)) // the inbox: nothing to hand over
	}))
	t.Cleanup(api.Close)

	ctx, cancel := context.WithTimeout(context.Background(), fakeClaudeTimeout)
	defer cancel()
	dir := t.TempDir()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runClaudeSessionProcess(ctx, context.Background(),
			NewTransport(api.URL, "runner-token"),
			job, "11111111-1111-4111-8111-111111111111", dir, dir,
			func(string, map[string]interface{}) {},
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
	return argv
}

// The one failure this must NOT read as "nothing to resume": the event log could not be read at
// all. Answering with a reopen there would trade the recoverable failure for the one that loses
// work — a later attempt can rebuild a history this one merely failed to fetch, while opening a
// fresh conversation drops it for good.
func TestUnreadableEventLogIsNotTreatedAsNoHistory(t *testing.T) {
	job := claudeSpawnJob(t)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusInternalServerError)
	}))
	t.Cleanup(api.Close)
	got := ensureClaudeTranscript(context.Background(),
		NewTransport(api.URL, "runner-token"), job, t.TempDir(),
		func(string, map[string]interface{}) {})
	if !got {
		t.Error("an unreadable event log was reported as nothing to resume; the spawn would reopen and drop the history")
	}
}

// writeLocalConversation puts a transcript holding a real turn where claude keeps one, so the
// machine under test is one that already has this session's conversation.
func writeLocalConversation(t *testing.T, configDir, sessionUUID, turnType string) {
	t.Helper()
	dir := filepath.Join(configDir, "projects", "-root-orbit-worktrees-x")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"` + turnType + `","message":{"role":"` + turnType + `","content":[{"type":"text","text":"hi"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, sessionUUID+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The failure this guards: Orbit has events for the session — an engine started and died — but
// not one of them is a replayable message, and this machine has never held the conversation.
// --resume would find nothing and the turn would end as error_during_execution with no reply.
// Opening the conversation is the only spawn that can produce an answer.
func TestResumeWithNothingReplayableOpensTheConversationInstead(t *testing.T) {
	job := claudeSpawnJob(t)
	job.Reclaimed = true
	job.MaxSeq = 2 // stored, and none of it replayable — see the events below
	argv := resumeSpawn(t, job, []StoredEvent{
		ev(1, evSystem, map[string]interface{}{"subtype": "init"}),
		ev(2, evError, map[string]interface{}{"message": "engine exited during startup"}),
	}, t.TempDir())
	if !containsArgs(argv, []string{"--session-id", job.SessionUUID}) {
		t.Errorf("argv %v resumes a conversation this machine does not have; it must open one", argv)
	}
	if containsArgs(argv, []string{"--resume", job.SessionUUID}) {
		t.Errorf("argv %v passes --resume, which claude answers with \"No conversation found with session ID\"", argv)
	}
}

// The reverse must hold: a reclaim that really does have a conversation to continue is the case
// --resume exists for, and the rebuild puts the file back before it is used.
func TestResumeWithReplayableHistoryStillResumes(t *testing.T) {
	job := claudeSpawnJob(t)
	job.Reclaimed = true
	job.MaxSeq = 2
	argv := resumeSpawn(t, job, []StoredEvent{
		ev(1, evUser, map[string]interface{}{"text": "rename the widget"}),
		ev(2, evAssistant, map[string]interface{}{"text": "done"}),
	}, t.TempDir())
	if !containsArgs(argv, []string{"--resume", job.SessionUUID}) {
		t.Errorf("argv %v does not resume a conversation that was rebuilt from stored history", argv)
	}
	if containsArgs(argv, []string{"--session-id", job.SessionUUID}) {
		t.Errorf("argv %v reopens a conversation that already exists", argv)
	}
}

// And the trap that makes "count the stored events" the wrong question: a transcript import
// writes the conversation to disk with no engine having run, so the session has zero stored
// events and is still the most resumable thing there is. Anything that decided from the event
// count alone would reopen it and lose the imported history.
func TestResumeWithAnImportedConversationStillResumes(t *testing.T) {
	job := claudeSpawnJob(t)
	job.Resume = true
	job.MaxSeq = 0
	configDir := t.TempDir()
	writeLocalConversation(t, configDir, job.SessionUUID, "user")
	argv := resumeSpawn(t, job, nil, configDir)
	if !containsArgs(argv, []string{"--resume", job.SessionUUID}) {
		t.Errorf("argv %v does not resume an imported conversation that is on disk", argv)
	}
	if containsArgs(argv, []string{"--session-id", job.SessionUUID}) {
		t.Errorf("argv %v reopens an imported conversation; claude would refuse the id as in use", argv)
	}
}
