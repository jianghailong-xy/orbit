package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// captureStderr points os.Stderr at a file for the rest of the test, and returns what has been written to it.
func captureStderr(t *testing.T) func() string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = f
	t.Cleanup(func() {
		os.Stderr = orig
		_ = f.Close()
	})
	return func() string {
		written, err := os.ReadFile(f.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(written)
	}
}

// unrecordedWatchCases are the two ways QA saw the server not record a wait's watch: the account's live-watch quota
// refused it, and the create failed with a 500.
var unrecordedWatchCases = []struct {
	name      string
	watchCode int
	watchBody string
	// The refusal code the output carries: the server's own, when it named one.
	code string
	// What the reason names, so the caller knows why.
	names []string
}{
	{
		name:      "quota refused",
		watchCode: http.StatusBadRequest,
		watchBody: `{"code":"WATCH_QUOTA_EXCEEDED","kind":"REFUSAL","message":"this account already holds 500 live watches, and it may hold 500: cancel one it no longer needs"}`,
		code:      "WATCH_QUOTA_EXCEEDED",
		names:     []string{"WATCH_QUOTA_EXCEEDED", "cancel one it no longer needs"},
	},
	{
		name:      "server error",
		watchCode: http.StatusInternalServerError,
		watchBody: `{"statusCode":500,"message":"Internal server error"}`,
		names:     []string{"500", "Internal server error"},
	},
}

// A wait no watch backs, ending before the session settled, leaves nothing to wake the caller when it does. At its
// quota QA's account got exit 0, the RUNNING session alone and an empty stderr from the CLI, and was never woken.
func TestSessionCreateWaitTellsTheCLICallerNoWatchBacksTheWaitAndWhy(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envSpawnDepth, "10")
	for _, tc := range unrecordedWatchCases {
		t.Run(tc.name, func(t *testing.T) {
			server := &sessionWaitServer{t: t, statuses: []string{"RUNNING"}, watchCode: tc.watchCode, watchBody: tc.watchBody}
			stderr := captureStderr(t)
			out, err := runSessionCreateWait(t, server)
			// Exit 0, as session_create(wait) answers without isError: the session exists, and a failed exit reads
			// as a create to try again.
			if err != nil {
				t.Fatalf("the session was created, so the command must not fail: %v", err)
			}
			said := stderr()
			if strings.Count(said, "\n") != 1 || !strings.HasSuffix(said, "\n") {
				t.Errorf("stderr = %q, want one line", said)
			}
			for _, phrase := range append([]string{"no server-held watch backs this wait", "orbit session await --session-id child-session"}, tc.names...) {
				if !strings.Contains(said, phrase) {
					t.Errorf("stderr does not say %q", phrase)
				}
			}
			var got struct {
				ID    string `json:"id"`
				Watch *struct {
					ID    string `json:"id"`
					Code  string `json:"code"`
					Error string `json:"error"`
				} `json:"watch"`
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("wait output is not JSON: %v\n%s", err, out)
			}
			if got.ID != "child-session" || got.Watch == nil || got.Watch.ID != "" {
				t.Fatalf("output = %s, want the session beside a watch with no id: none was recorded", out)
			}
			if got.Watch.Code != tc.code {
				t.Errorf("watch.code = %q, want %q", got.Watch.Code, tc.code)
			}
			for _, name := range tc.names {
				if !strings.Contains(got.Watch.Error, name) {
					t.Errorf("watch.error %q does not name %q", got.Watch.Error, name)
				}
			}
			if !strings.Contains(said, "("+got.Watch.Error+")") {
				t.Errorf("stderr does not give the reason the output gives, %q", got.Watch.Error)
			}
		})
	}
}

// The CLI caller is told what session_create(wait) tells the model, in the CLI's own commands.
func TestSessionCreateWaitTellsTheCLICallerWhatMCPTellsTheModelWhenNoWatchBacksTheWait(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envSpawnDepth, "10")
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, tc := range unrecordedWatchCases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(&sessionWaitServer{t: t, statuses: []string{"RUNNING"}, watchCode: tc.watchCode, watchBody: tc.watchBody})
			defer srv.Close()
			mcp := &mcpServer{
				t:                  NewTransport(srv.URL, "runner-token"),
				sessionID:          "caller-session",
				orchestrationToken: "session-token",
				allowOrchestration: true,
			}
			result := mcp.callTool("session_create", map[string]interface{}{"prompt": "work", "wait": true})
			text := watchToolText(t, result)
			paragraphs := strings.Split(text, "\n\n")
			modelTold := paragraphs[len(paragraphs)-1]
			if result["isError"] == true || !strings.Contains(modelTold, "no server-held watch backs this wait") {
				t.Fatalf("session_create(wait) does not end by saying no watch backs the wait:\n%s", text)
			}

			server := &sessionWaitServer{t: t, statuses: []string{"RUNNING"}, watchCode: tc.watchCode, watchBody: tc.watchBody}
			stderr := captureStderr(t)
			if _, err := runSessionCreateWait(t, server); err != nil {
				t.Fatal(err)
			}
			want := "orbit session create: " + strings.NewReplacer(
				"session_get", "`orbit session get child-session`",
				"session_await", "`orbit session await --session-id child-session`",
			).Replace(modelTold) + "\n"
			if said := stderr(); said != want {
				t.Fatalf("stderr = %q\nwant what session_create(wait) tells the model, in CLI commands: %q", said, want)
			}
		})
	}
}
