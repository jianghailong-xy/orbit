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
	"sync"
	"testing"
)

// The reply an agent sends when it drew something: prose, then a markdown image naming the file it
// wrote. The path means nothing to a client, so it has to leave here as an attachment ref — and the
// same file linked in two replies (or in a retried batch) must be uploaded once.
func TestAttachLocalReplyFilesUploadsAndRewrites(t *testing.T) {
	dir := t.TempDir()
	mock := filepath.Join(dir, "docs", "mocks", "card-surface-desktop-phone.png")
	if err := os.MkdirAll(filepath.Dir(mock), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mock, []byte("\x89PNG\r\n\x1a\n…"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "card.png")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	uploads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/sessions/s1/attachments" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		uploads++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"att-1","publicId":"3kR2"}`)
	}))
	defer srv.Close()

	prose := "画了四格。要点：**聊天区静止时没有卡**。\n\n" +
		"![卡在聊天区怎么出现：桌面 / iPhone](" + mock + ")\n\n" +
		"**桌面（①②）**\n\n- ① 静止：会话的最后一条就是最后一条。\n" +
		"[效果图](" + mock + ")\n" +
		"![这张在会话目录外](" + outside + ")\n"
	events := []RunEvent{
		{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": prose}},
		// A thinking block is the model's own scratch, shown collapsed: nothing to fetch from it.
		{Seq: 2, Type: evThinking, Payload: map[string]interface{}{"text": "![x](" + mock + ")"}},
		// The same file again — a second reply, or this batch posted twice.
		{Seq: 3, Type: evAssistant, Payload: map[string]interface{}{"text": "![again](" + mock + ")"}},
		// Prose with no link at all, which must not touch the network.
		{Seq: 4, Type: evAssistant, Payload: map[string]interface{}{"text": "没有图。"}},
	}
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1",
		events, []string{dir}, newReplyAttachmentIDs())

	// An image keeps its alt text; a file link carries its name as the markdown title; a path
	// outside the session's own directories is left exactly as the agent wrote it.
	want := "画了四格。要点：**聊天区静止时没有卡**。\n\n" +
		"![卡在聊天区怎么出现：桌面 / iPhone](orbit-attachment:att-1)\n\n" +
		"**桌面（①②）**\n\n- ① 静止：会话的最后一条就是最后一条。\n" +
		"[效果图](orbit-attachment:att-1 \"card-surface-desktop-phone.png\")\n" +
		"![这张在会话目录外](" + outside + ")\n"
	if got := events[0].Payload["text"]; got != want {
		t.Fatalf("rewritten reply =\n%q\nwant\n%q", got, want)
	}
	if got := events[1].Payload["text"]; got != "![x]("+mock+")" {
		t.Fatalf("thinking block was rewritten: %q", got)
	}
	if got := events[2].Payload["text"]; got != "![again](orbit-attachment:att-1)" {
		t.Fatalf("second reply = %q", got)
	}
	if got := events[3].Payload["text"]; got != "没有图。" {
		t.Fatalf("linkless reply = %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if uploads != 1 {
		t.Fatalf("uploads = %d, want 1 (one file, three references)", uploads)
	}
}

func cancelledCtx() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

// A reply that names a file this runner does not have — or one the server refuses — keeps the path
// the agent wrote. Rewriting it to an attachment id that does not exist would hide the line
// entirely; the chip it renders as at least says which file it was.
func TestAttachLocalReplyFilesLeavesUnreachablePaths(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "docs", "mocks", "never-written.png")

	var mu sync.Mutex
	requests := 0
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		refuse := fail
		mu.Unlock()
		if refuse {
			http.Error(w, "nope", http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, `{"id":"att-1"}`)
	}))
	defer srv.Close()

	present := filepath.Join(dir, "card.png")
	if err := os.WriteFile(present, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	events := []RunEvent{
		{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": "![gone](" + missing + ")"}},
		{Seq: 2, Type: evAssistant, Payload: map[string]interface{}{"text": "![here](" + present + ")"}},
	}
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1",
		events, []string{dir}, newReplyAttachmentIDs())
	if got := events[0].Payload["text"]; got != "![gone]("+missing+")" {
		t.Fatalf("missing file = %q", got)
	}
	if got := events[1].Payload["text"]; got != "![here](orbit-attachment:att-1)" {
		t.Fatalf("present file = %q", got)
	}

	// A server that refuses the upload, and a budget already spent (the flush bounds this call —
	// see replyAttachmentBudget): same answer either way, the path stays.
	for _, tc := range []struct {
		name string
		ctx  context.Context
	}{
		{"refused", context.Background()},
		{"out-of-budget", cancelledCtx()},
	} {
		fail = tc.name == "refused"
		events = []RunEvent{
			{Seq: 3, Type: evAssistant, Payload: map[string]interface{}{"text": "![here](" + present + ")"}},
		}
		attachLocalReplyFiles(tc.ctx, NewTransport(srv.URL, "token"), "s1",
			events, []string{dir}, newReplyAttachmentIDs())
		if got := events[0].Payload["text"]; got != "![here]("+present+")" {
			t.Fatalf("%s upload = %q", tc.name, got)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 2 {
		t.Fatalf("requests = %d, want 2 (the missing file is never asked for)", requests)
	}
}

// The shape this exists for, driven through the real supervisor with the fake CLI: the reply names
// the mock it just drew, by the path it wrote it to inside the session's own checkout. Nothing
// downstream of the runner can read that path, so what the control plane receives — the transcript
// every client renders — has to be the attachment ref, and the bytes behind it the agent's file.
func TestSupervisedReplyUploadsTheFileItLinks(t *testing.T) {
	execDir := t.TempDir()
	mock := filepath.Join(execDir, "docs", "mocks", "card-surface-desktop-phone.png")
	if err := os.MkdirAll(filepath.Dir(mock), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mock, []byte("\x89PNG\r\n\x1a\n…"), 0o644); err != nil {
		t.Fatal(err)
	}
	reply := "画了四格。要点：**聊天区静止时没有卡**。\n\n" +
		"![卡在聊天区怎么出现：桌面 / iPhone](" + mock + ")\n\n**桌面（①②）**"

	pool := newSessionPool(1)
	s := superviseClaudeSessionIn(t, pool, execDir,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: reply},
		fakeStep{Emit: "result", Text: "画了四格。"},
	)
	s.awaitParked("turn-1")

	s.awaitEvents("the reply", 1, func(e RunEvent) bool {
		return e.Type == evAssistant && strings.Contains(asString(e.Payload["text"]), "orbit-attachment:")
	})
	for _, e := range s.eventsOf(func(e RunEvent) bool { return e.Type == evAssistant }) {
		if text := asString(e.Payload["text"]); strings.Contains(text, mock) {
			t.Fatalf("the transcript still carries a path no client can read: %q", text)
		}
	}
	s.mu.Lock()
	uploads := append([]string(nil), s.uploads...)
	s.mu.Unlock()
	if len(uploads) != 1 || uploads[0] != filepath.Base(mock) {
		t.Fatalf("uploads = %v, want [%s]", uploads, filepath.Base(mock))
	}
}
