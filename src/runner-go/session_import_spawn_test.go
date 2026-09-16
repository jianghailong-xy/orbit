//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `orbit session import` produces everything it produces before an engine exists: the transcript
// is located, checked against the workspace, copied where `--resume` will read it, replayed as run
// events and settled with the control plane. Warming an engine is a different job — it only
// matters once somebody speaks — and doing it here costs a resident process and a runner slot per
// imported conversation, which a directory's history (hundreds of transcripts) pays all at once
// and keeps paying until each engine's warm TTL expires.
//
// So the claim that carries an import settles the import and goes cold, and the first message is
// what spawns. These drive the real supervisor through both halves: the fake claude would be
// spawned by anything that spawned one, and the verdict is read off what the control plane was
// actually sent.

// importClaimJob is the claim the control plane hands a runner for an import: the marker naming
// where to find the transcript, and the two fields that say what to do with this claim.
func importClaimJob(t *testing.T, sessionID, uuid, workDir string) *ClaimedSession {
	t.Helper()
	job := runnerStopJob(t, sessionID)
	job.SessionUUID = uuid
	job.WorkDir = workDir
	marker := workDir
	job.ImportSourceCwd = &marker
	// What the control plane says: this claim ends with the import (/import-result parks the
	// session), and the spawn --resumes the conversation already on disk (importedAt).
	job.ImportOnly = true
	job.Resume = true
	return job
}

// writeImportTranscript puts a two-message Claude transcript where this machine's ~/.claude would
// hold one for workDir, and returns its session id.
func writeImportTranscript(t *testing.T, home, workDir, uuid string) string {
	t.Helper()
	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "Imported talk", "timestamp": "2026-09-15T10:00:00Z"})
	tr.add(importMsgRow("user", workDir, "2026-09-15T10:00:01Z", map[string]interface{}{"type": "text", "text": "why does the page not open"}))
	tr.add(importMsgRow("assistant", workDir, "2026-09-15T10:00:02Z", map[string]interface{}{"type": "text", "text": "the gateway is down"}))
	projects := filepath.Join(home, ".claude", "projects", claudeProjectSlug(workDir))
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	tr.write(t, filepath.Join(projects, uuid+".jsonl"))
	return uuid
}

func TestImportClaimSettlesWithoutSpawningAndTheFirstMessageSpawns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	work := t.TempDir()
	uuid := writeImportTranscript(t, home, work, "4e453ab7-f37c-494d-8017-bb4e9beffeef")

	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "yes — the gateway is back"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	job := importClaimJob(t, "sess-import", uuid, work)
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, true, api)

	// The import is the claim's whole work: the transcript is replayed onto the control plane and
	// settled, with the title it records.
	awaitCondition(t, 30*time.Second, "the import was never settled with the control plane", func() bool {
		return len(api.importResults()) > 0
	})
	posted := api.importResults()
	if !posted[0].Ok || posted[0].Title != "Imported talk" {
		t.Errorf("import-result = %+v, want ok with the transcript's title", posted[0])
	}
	if !api.delivered(func(e RunEvent) bool {
		return e.Type == evAssistant && asString(e.Payload["text"]) == "the gateway is down"
	}) {
		t.Errorf("the replayed transcript never reached the control plane: %v", api.deliveredEvents())
	}

	// …and nothing else is: no engine was spawned for it, and the run did not end — the session is
	// parked, which is the state its first message claims it from.
	awaitCondition(t, 30*time.Second, "the session never parked after its import", func() bool {
		return !sup.pool.isActive(sup.live)
	})
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Errorf("importing spawned %d engine(s), want none: %v", len(spawns), spawns)
	}
	if statuses := api.finalizeStatuses(); len(statuses) != 0 {
		t.Errorf("the import ended the run as %v, want it left resumable for the first message", statuses)
	}
	if sup.pool.engineResident(sup.live) {
		t.Error("the import left an engine resident, holding a runner slot for a conversation nobody has spoken to")
	}

	// The first message: the same session claimed again, with the transcript already on disk. This
	// is the claim that spawns, and the one that has to --resume rather than open a new session.
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "carry on"})
	claim := *job
	claim.Resume = true
	if _, ok := sup.pool.activate(&claim); !ok {
		t.Fatal("the first message could not activate the parked session")
	}
	awaitCondition(t, time.Minute, "the engine the first message should have started never answered it", func() bool {
		return api.settled("turn-1")
	})
	spawns := fake.Spawns()
	if len(spawns) != 1 {
		t.Fatalf("claude was spawned %d times for the first message, want 1: %v", len(spawns), spawns)
	}
	argv := strings.Join(spawns[0].Argv, " ")
	if !strings.Contains(argv, "--resume "+uuid) {
		t.Errorf("the first message spawned `claude %s`, want it resuming %s: the imported conversation is on disk and a fresh --session-id would not carry it", argv, uuid)
	}
}

// A directory somebody has worked in for months holds hundreds of conversations, and taking them
// all is one action ("All N" on the new-workspace form). Under the old shape that action was N
// claims that each warmed an engine and kept it: N resident processes holding N of the runner's
// slots until their warm TTLs expired, for conversations most of which nobody was about to speak
// to. Importing N must cost N imports — the transcripts are replayed either way — and nothing on
// the runner that scales with N.
func TestImportingManyConversationsLeavesTheRunnerAccountIntact(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	work := t.TempDir()

	api := newRunnerStopControlPlane()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)
	pool := newSessionPool(4)
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	// Safety net only; the test body stops the runner itself, after everything it asserts.
	t.Cleanup(stopRunner)

	uuids := []string{
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333",
	}
	finished := make(chan struct{}, len(uuids))
	var cancels []context.CancelFunc
	for i, uuid := range uuids {
		writeImportTranscript(t, home, work, uuid)
		job := importClaimJob(t, fmt.Sprintf("sess-import-%d", i), uuid, work)
		// One context per session, as a real claim gives each supervisor its own; the runner's
		// stop is the shared one, so teardown is still the runner's.
		sessionCtx, cancelSession := context.WithCancel(context.Background())
		cancels = append(cancels, cancelSession)
		live, added := pool.register(job, cancelSession, true)
		if !added {
			t.Fatalf("session %d was not registered", i)
		}
		go func(job *ClaimedSession, live *liveSession) {
			defer func() { finished <- struct{}{} }()
			runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
				t.TempDir(), nil, pool, live)
			pool.finish(live)
		}(job, live)
	}

	// Every import settles on its own: there is no turn to wait for, and the claim ends when the
	// transcript has been replayed and the control plane has it.
	awaitCondition(t, time.Minute, "not every import settled", func() bool {
		return len(api.importResults()) == len(uuids)
	})
	awaitCondition(t, time.Minute, "the runner's own capacity never came back", func() bool {
		return pool.admissionIdleCapacity() == 4
	})
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Errorf("importing %d conversations spawned %d engine(s), want none: %v", len(uuids), len(spawns), spawns)
	}
	if n := pool.residentCount(); n != 0 {
		t.Errorf("%d engines are resident after importing %d conversations, want none", n, len(uuids))
	}

	// Teardown asserted rather than registered: the supervisors have to be stopped (their runner and
	// their sessions) and joined before this test is done, or a goroutine outliving it is itself the
	// leak the case is about.
	stopRunner()
	for _, cancel := range cancels {
		cancel()
	}
	for range uuids {
		select {
		case <-finished:
		case <-time.After(2 * time.Minute):
			t.Error("a supervisor never returned after the runner stopped")
		}
	}
}
