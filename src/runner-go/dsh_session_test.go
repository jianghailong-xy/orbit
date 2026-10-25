package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func dshRunMockSession(t *testing.T, mode string, multiTurn bool) (string, bool, bool, []TurnCompleteRequest, []dshProcessEvent, []map[string]interface{}) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	inbox := make(chan RunInboxResponse, 4)
	first := RunInboxResponse{TurnID: "runner-turn-1", Kind: "message", Content: "first runner prompt"}
	inbox <- first
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/dsh-runner-session/inbox" {
			t.Errorf("unexpected control-plane request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		select {
		case message := <-inbox:
			_ = json.NewEncoder(w).Encode(message)
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	spec, record := dshMockLaunchSpec(t, mode)
	scratch := t.TempDir()
	job := &ClaimedSession{
		SessionID: "dsh-runner-session", Provider: providerDsh,
		Agent: AgentExecConfig{Provider: providerDsh, Model: "model/with opaque value", Effort: "low"},
	}
	var events dshProcessEvents
	var completions []TurnCompleteRequest
	complete := func(request TurnCompleteRequest, _ ...context.Context) error {
		completions = append(completions, request)
		events.emit(request.TurnID, "completion", map[string]interface{}{"status": request.Status})
		if multiTurn {
			if len(completions) == 1 {
				// The duplicate is delivered after the first settlement, then a new turn.
				inbox <- first
				inbox <- RunInboxResponse{TurnID: "runner-turn-2", Kind: "message", Content: "second runner prompt"}
			} else if len(completions) == 2 {
				inbox <- RunInboxResponse{TurnID: "end-session", Kind: "end"}
			}
		}
		return nil
	}
	status, ended, replay := providerRuntimeFor(runtimeProvider(job)).run(sessionProcessArgs{
		ctx: ctx, shutdownCtx: context.Background(), t: NewTransport(server.URL, "synthetic-runner-token"),
		job: job, execDir: spec.Cwd, scratchDir: scratch, dshLaunchSpec: &spec,
		emit:    func(typ string, payload map[string]interface{}) { events.emit("", typ, payload) },
		emitFor: events.emit, setTurn: func(string) {}, completeTurn: complete,
		waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost:    func(err error) { t.Errorf("mock session lost lease: %v", err) },
	})
	if ctx.Err() != nil {
		t.Fatalf("runner session did not finish on its own: %v", ctx.Err())
	}
	if job.RuntimeSessionID != dshMockSessionID {
		t.Fatalf("runner did not retain ACP session id: %q", job.RuntimeSessionID)
	}
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || meta.Provider != providerDsh || meta.RuntimeSessionID != dshMockSessionID || meta.WorkDir != spec.Cwd {
		t.Fatalf("runtime session id was not persisted: %+v", meta)
	}
	return status, ended, replay, completions, events.snapshot(), dshProcessRequests(t, record)
}

func TestDshACPRunnerProcessFailure(t *testing.T) {
	status, ended, replay, completions, events, requests := dshRunMockSession(t, "eof-zero", false)
	if status != stFailed || !ended || replay {
		t.Fatalf("exit 0 without response must fail and end without replay: %s, %v, %v", status, ended, replay)
	}
	if len(completions) != 1 || completions[0].TurnID != "runner-turn-1" || completions[0].Status != stFailed || completions[0].Error == "" || completions[0].RuntimeSessionID != dshMockSessionID {
		t.Fatalf("EOF must produce exactly one FAILED completion: %+v", completions)
	}
	toolResult, turnEnd, complete := -1, -1, -1
	for i, event := range events {
		if event.turn != "runner-turn-1" {
			continue
		}
		switch event.typ {
		case evToolResult:
			if toolResult >= 0 || event.payload["isError"] != true || event.payload["toolCallId"] != "same-tool-id" {
				t.Fatalf("pending tool did not fail once: %+v", events)
			}
			toolResult = i
		case evTurnEnd:
			if turnEnd >= 0 {
				t.Fatal("runner emitted duplicate turn_end")
			}
			turnEnd = i
		case "completion":
			complete = i
		}
	}
	if toolResult < 0 || turnEnd <= toolResult || complete <= turnEnd {
		t.Fatalf("orphan tool terminal result and turn_end must precede completion: %+v", events)
	}
	prompts := 0
	for _, request := range requests {
		if request["method"] == "session/prompt" {
			prompts++
		}
	}
	if prompts != 1 {
		t.Fatalf("EOF prompt was automatically replayed: %d requests", prompts)
	}
}

// TestDshACPRunnerAttachments: the composition takes text only, so a turn with attachments, an image
// included, runs with each one saved beside the session and named in the prompt instead of failing.
func TestDshACPRunnerAttachments(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blobs := map[string]string{"att-text": "synthetic notes", "att-image": "\x89PNG synthetic"}
	inbox := make(chan RunInboxResponse, 2)
	inbox <- RunInboxResponse{TurnID: "runner-turn-1", Kind: "message", Content: "what is in these?", Attachments: []TurnAttachment{
		{ID: "att-text", MimeType: "text/plain", FileName: "notes.txt"},
		{ID: "att-image", MimeType: "image/png", FileName: "shot.png"},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id, ok := strings.CutPrefix(r.URL.Path, "/api/runner/sessions/dsh-runner-session/attachments/"); ok && r.Method == http.MethodGet {
			_, _ = w.Write([]byte(blobs[id]))
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/dsh-runner-session/inbox" {
			t.Errorf("unexpected control-plane request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		select {
		case message := <-inbox:
			_ = json.NewEncoder(w).Encode(message)
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	spec, record := dshMockLaunchSpec(t, "attachments")
	job := &ClaimedSession{SessionID: "dsh-runner-session", Provider: providerDsh, Agent: AgentExecConfig{Provider: providerDsh}}
	var events dshProcessEvents
	var completions []TurnCompleteRequest
	complete := func(request TurnCompleteRequest, _ ...context.Context) error {
		completions = append(completions, request)
		inbox <- RunInboxResponse{TurnID: "end-session", Kind: "end"}
		return nil
	}
	status, ended, _ := providerRuntimeFor(runtimeProvider(job)).run(sessionProcessArgs{
		ctx: ctx, shutdownCtx: context.Background(), t: NewTransport(server.URL, "synthetic-runner-token"),
		job: job, execDir: spec.Cwd, scratchDir: t.TempDir(), dshLaunchSpec: &spec,
		emit:    func(typ string, payload map[string]interface{}) { events.emit("", typ, payload) },
		emitFor: events.emit, setTurn: func(string) {}, completeTurn: complete,
		waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost:    func(err error) { t.Errorf("mock session lost lease: %v", err) },
	})
	if ctx.Err() != nil {
		t.Fatalf("runner session did not finish on its own: %v", ctx.Err())
	}
	if status != stSucceeded || !ended || len(completions) != 1 || completions[0].Status != stSucceeded || completions[0].Result != "reply-1" {
		t.Fatalf("a turn with attachments must run like any other: %s, %v, %+v", status, ended, completions)
	}
	textPath := filepath.Join(uploadsDir(job.SessionID), "notes.txt")
	imagePath := filepath.Join(uploadsDir(job.SessionID), "shot.png")
	for path, want := range map[string]string{textPath: blobs["att-text"], imagePath: blobs["att-image"]} {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Fatalf("attachment %s = %q, %v; want %q", path, got, err, want)
		}
	}
	wantPrompt := []interface{}{map[string]interface{}{"type": "text", "text": "[The user uploaded 2 file(s), saved at: " +
		textPath + ", " + imagePath + " - read or process them with your tools as needed.]\n\nwhat is in these?"}}
	var prompts []interface{}
	for _, request := range dshProcessRequests(t, record) {
		if request["method"] == "session/prompt" {
			prompts = append(prompts, mapValue(request["params"])["prompt"])
		}
	}
	if len(prompts) != 1 || !reflect.DeepEqual(prompts[0], wantPrompt) {
		t.Fatalf("session/prompt = %#v; want one text block naming both files: %#v", prompts, wantPrompt)
	}
	wantRefs := []map[string]interface{}{
		{"id": "att-text", "mime": "text/plain", "name": "notes.txt"},
		{"id": "att-image", "mime": "image/png", "name": "shot.png"},
	}
	users := 0
	for _, event := range events.snapshot() {
		if event.turn == "runner-turn-1" && event.typ == evUser {
			users++
			if event.payload["text"] != "what is in these?" || !reflect.DeepEqual(event.payload["attachments"], wantRefs) {
				t.Fatalf("user event must show the message and its attachments: %+v", event.payload)
			}
		}
	}
	if users != 1 {
		t.Fatalf("user events for the turn = %d, want 1", users)
	}
}

func TestDshACPRunnerMultiTurn(t *testing.T) {
	status, ended, replay, completions, events, requests := dshRunMockSession(t, "multiturn", true)
	if status != stSucceeded || !ended || replay {
		t.Fatalf("explicit session end = %s, %v, %v", status, ended, replay)
	}
	if len(completions) != 2 {
		t.Fatalf("duplicate inbox message must not add a completion: %+v", completions)
	}
	for i, complete := range completions {
		wantTurn, wantReply := "runner-turn-1", "reply-1"
		if i == 1 {
			wantTurn, wantReply = "runner-turn-2", "reply-2"
		}
		if complete.TurnID != wantTurn || complete.Status != stSucceeded || complete.Result != wantReply || complete.RuntimeSessionID != dshMockSessionID {
			t.Fatalf("completion %d: %+v", i+1, complete)
		}
		counts, endIndex, completeIndex := map[string]int{}, -1, -1
		for j, event := range events {
			if event.turn == wantTurn {
				counts[event.typ]++
				if event.typ == evTurnEnd {
					endIndex = j
				} else if event.typ == "completion" {
					completeIndex = j
				}
			}
		}
		for _, kind := range []string{evUser, evAssistant, evThinking, evToolUse, evToolResult, evTurnEnd, "completion"} {
			if counts[kind] != 1 {
				t.Fatalf("%s %s must occur once: %+v", wantTurn, kind, counts)
			}
		}
		if completeIndex <= endIndex {
			t.Fatalf("turn_end must precede runner completion: %+v", events)
		}
	}
	prompts, closes := 0, 0
	for _, request := range requests {
		switch request["method"] {
		case "session/prompt":
			prompts++
		case "session/close":
			closes++
		}
	}
	if prompts != 2 || closes != 1 {
		t.Fatalf("resident dsh must receive two distinct prompts and close once: prompts=%d closes=%d", prompts, closes)
	}
}
