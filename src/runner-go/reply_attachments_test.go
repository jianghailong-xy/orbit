//go:build linux || darwin

package main

import (
	"context"
	"fmt"
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
	// outside the session's own directories is left exactly as the agent wrote it, and the reply
	// ends with a line that says why it was not attached.
	want := "画了四格。要点：**聊天区静止时没有卡**。\n\n" +
		"![卡在聊天区怎么出现：桌面 / iPhone](orbit-attachment:att-1)\n\n" +
		"**桌面（①②）**\n\n- ① 静止：会话的最后一条就是最后一条。\n" +
		"[效果图](orbit-attachment:att-1 \"card-surface-desktop-phone.png\")\n" +
		"![这张在会话目录外](" + outside + ")\n" +
		"\n\n_Not attached: `" + outside + "` is outside this session's working directory and uploads directory, so you cannot open it._"
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

// An agent asked to change a mock redraws it under the same name and links it again, in a later turn
// of the same warm run. That reply must carry the new drawing: the memo that spares a retried batch
// a second upload knows the path, but the bytes behind it are not the ones it uploaded.
func TestAttachLocalReplyFilesUploadsAMockRedrawnInPlace(t *testing.T) {
	dir := t.TempDir()
	mock := filepath.Join(dir, "set-as-default-prototype.png")
	if err := os.WriteFile(mock, []byte("\x89PNG\r\n\x1a\nfirst"), 0o644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Errorf("upload without a file part: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		defer file.Close()
		var body strings.Builder
		if _, err := io.Copy(&body, file); err != nil {
			t.Error(err)
		}
		mu.Lock()
		bodies = append(bodies, body.String())
		n := len(bodies)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"att-%d"}`, n)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")
	memo := newReplyAttachmentIDs()
	reply := func() string {
		events := []RunEvent{{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": "![prototype](" + mock + ")"}}}
		attachLocalReplyFiles(context.Background(), transport, "s1", events, []string{dir}, memo)
		return events[0].Payload["text"].(string)
	}

	if got := reply(); got != "![prototype](orbit-attachment:att-1)" {
		t.Fatalf("first reply = %q", got)
	}
	if err := os.WriteFile(mock, []byte("\x89PNG\r\n\x1a\nsecond, redrawn"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := reply(); got != "![prototype](orbit-attachment:att-2)" {
		t.Fatalf("reply after the redraw = %q, want the redrawn file's own attachment", got)
	}
	// Linked again unchanged, it is the same bytes: no third upload.
	if got := reply(); got != "![prototype](orbit-attachment:att-2)" {
		t.Fatalf("reply linking the unchanged redraw = %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 || !strings.HasSuffix(bodies[1], "second, redrawn") {
		t.Fatalf("uploaded bodies = %q, want the first drawing then the redrawn one", bodies)
	}
}

func cancelledCtx() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

// A reply that names a file this runner does not have — or one the server refuses — keeps the path
// the agent wrote (a missing one with a line saying it does not exist). Rewriting it to an attachment id that does not exist would hide the line
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
	gone := "![gone](" + missing + ")\n\n_Not attached: `" + missing + "` does not exist in this session's working directory or uploads directory._"
	if got := events[0].Payload["text"]; got != gone {
		t.Fatalf("missing file = %q", got)
	}
	if got := events[1].Payload["text"]; got != "![here](orbit-attachment:att-1)" {
		t.Fatalf("present file = %q", got)
	}

	// A server that refuses the upload (answered, so not tried again), and a flush already cancelled:
	// same answer either way, the path stays.
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

// What a reply on 2026-11-28 lost: a 700 KB mock whose upload hit its window, after which the next
// file in the reply had no time left at all. Each file gets its own window and one more try, so a
// timed-out picture still arrives, and the file after it is uploaded too.
func TestAttachLocalReplyFilesRetriesATimedOutUpload(t *testing.T) {
	was := replyAttachmentUploadTimeout
	replyAttachmentUploadTimeout = 200 * time.Millisecond
	defer func() { replyAttachmentUploadTimeout = was }()

	dir := t.TempDir()
	png := filepath.Join(dir, "board.png")
	html := filepath.Join(dir, "board.html")
	if err := os.WriteFile(png, []byte("\x89PNG\r\n\x1a\nbytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(html, []byte("<!doctype html><p>board</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, header, err := r.FormFile("file")
		if err != nil {
			t.Errorf("form file: %v", err)
			return
		}
		f, _ := header.Open()
		data, _ := io.ReadAll(f)
		mu.Lock()
		bodies = append(bodies, header.Filename+"="+string(data))
		first := len(bodies) == 1
		mu.Unlock()
		if first {
			time.Sleep(time.Second) // past the window: the first try of board.png times out
		}
		fmt.Fprintf(w, `{"id":"att-%s"}`, header.Filename)
	}))
	defer srv.Close()

	events := []RunEvent{{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{
		"text": "![Board](" + png + ")\n\nThe source is [board.html](" + html + ").",
	}}}
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1",
		events, []string{dir}, newReplyAttachmentIDs())
	want := "![Board](orbit-attachment:att-board.png)\n\nThe source is [board.html](orbit-attachment:att-board.html \"board.html\")."
	if got := events[0].Payload["text"]; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}
	mu.Lock()
	defer mu.Unlock()
	// The retry sends the whole file again, not what was left after the first try read it.
	if len(bodies) != 3 || bodies[1] != bodies[0] || !strings.HasPrefix(bodies[2], "board.html=") {
		t.Fatalf("uploads = %q", bodies)
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

// What sessions kept doing (34wwyaXrkDx9hjaA0EJa5 and others): an image rendered under /mnt/data or
// /tmp, outside the session's checkout and its uploads directory, linked by that path. The runner
// will not attach it, so the reply says so once, naming each such file once; the files the session
// owns are attached as before, and links that are no local file are left alone.
func TestAttachLocalReplyFilesNotesFilesOutsideTheSession(t *testing.T) {
	workDir := t.TempDir()
	uploadsDir := t.TempDir()
	inCheckout := filepath.Join(workDir, "docs", "mocks", "a.png")
	inUploads := filepath.Join(uploadsDir, "b.png")
	outsideDir, err := os.MkdirTemp("/tmp", "reply-outside-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(outsideDir) })
	outside := filepath.Join(outsideDir, "out", "real-03-heads.png")
	outsideFile := filepath.Join(outsideDir, "report.txt")
	for _, f := range []string{inCheckout, inUploads, outside, outsideFile} {
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte("\x89PNG\r\n\x1a\n…"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	var mu sync.Mutex
	var uploaded []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("upload form: %v", err)
		}
		name := ""
		for _, files := range r.MultipartForm.File {
			name = files[0].Filename
		}
		mu.Lock()
		uploaded = append(uploaded, name)
		mu.Unlock()
		fmt.Fprintf(w, `{"id":"att-%s"}`, strings.TrimSuffix(name, ".png"))
	}))
	defer srv.Close()

	reply := "Rendered.\n\n" +
		"![heads](" + outside + ")\n" +
		"![heads again](" + outside + ")\n" +
		"[report](" + outsideFile + ")\n" +
		"![a](" + inCheckout + ")\n" +
		"![b](" + inUploads + ")\n" +
		"[site](https://example.com/x.png) [task](orbit-task:34xGMBOf31IJy137P02PT)"
	events := []RunEvent{
		{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": reply}},
		// Owned files only: attached, no note.
		{Seq: 2, Type: evAssistant, Payload: map[string]interface{}{"text": "![a](" + inCheckout + ") ![b](" + inUploads + ")"}},
		// A delta is live typing, left alone whatever it links.
		{Seq: 3, Type: evTextDelta, Payload: map[string]interface{}{"text": "![heads](" + outside + ")"}},
	}
	memo := newReplyAttachmentIDs()
	roots := []string{workDir, uploadsDir}
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1", events, roots, memo)

	note := "\n\n_Not attached: `" + outside + "`, `" + outsideFile + "` are outside this session's working directory and uploads directory, so you cannot open them._"
	want := "Rendered.\n\n" +
		"![heads](" + outside + ")\n" +
		"![heads again](" + outside + ")\n" +
		"[report](" + outsideFile + ")\n" +
		"![a](orbit-attachment:att-a)\n" +
		"![b](orbit-attachment:att-b)\n" +
		"[site](https://example.com/x.png) [task](orbit-task:34xGMBOf31IJy137P02PT)" + note
	if got := events[0].Payload["text"]; got != want {
		t.Fatalf("reply =\n%q\nwant\n%q", got, want)
	}
	if got := events[1].Payload["text"]; got != "![a](orbit-attachment:att-a) ![b](orbit-attachment:att-b)" {
		t.Fatalf("owned-files reply = %q", got)
	}
	if got := events[2].Payload["text"]; got != "![heads]("+outside+")" {
		t.Fatalf("delta was rewritten: %q", got)
	}

	// A failed flush restores the batch it rewrote and runs it through here again: still one note.
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1", events, roots, memo)
	if got := events[0].Payload["text"]; got != want {
		t.Fatalf("retried reply =\n%q\nwant\n%q", got, want)
	}

	mu.Lock()
	defer mu.Unlock()
	if strings.Join(uploaded, ",") != "a.png,b.png" {
		t.Fatalf("uploaded = %v, want [a.png b.png] (nothing outside the session)", uploaded)
	}
}

// Session 34yKMcwK61DDADUoAXnk5: told it may link a file in its working directory or its uploads
// directory, the agent saved its mock in uploads and linked it by name. A relative link was only
// looked for in the working directory, so the reply carried a dead image and nothing said why.
// Now a relative link is looked for in each directory, the working directory first; a local link
// found in none says so, and a place in code or an Orbit link is no file it misses.
func TestAttachLocalReplyFilesFindsRelativeLinksInUploads(t *testing.T) {
	workDir := t.TempDir()
	uploadsDir := t.TempDir()
	for _, f := range []string{
		filepath.Join(uploadsDir, "secrets-page-mockup.png"),
		filepath.Join(uploadsDir, "secrets-page-mockup.html"),
		filepath.Join(workDir, "both.png"),
		filepath.Join(uploadsDir, "both.png"),
	} {
		if err := os.WriteFile(f, []byte("\x89PNG\r\n\x1a\n…"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(workDir, "both.png"), []byte("\x89PNG\r\n\x1a\nworkdir"), 0o644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("upload form: %v", err)
		}
		name, body := "", ""
		for _, files := range r.MultipartForm.File {
			name = files[0].Filename
			f, _ := files[0].Open()
			buf := make([]byte, 64)
			n, _ := f.Read(buf)
			body = string(buf[:n])
			f.Close()
		}
		mu.Lock()
		bodies = append(bodies, body)
		id := len(bodies)
		mu.Unlock()
		fmt.Fprintf(w, `{"id":"att-%d-%s"}`, id, name)
	}))
	defer srv.Close()

	reply := "![Secrets page mockup](secrets-page-mockup.png)\n" +
		"[secrets-page-mockup.html](secrets-page-mockup.html)\n" +
		"![both](both.png)\n" +
		"![never](never-written.png)\n" +
		"[the lookup](codex_artifacts.go:77) [task](orbit-task:34xGMBOf31IJy137P02PT)"
	events := []RunEvent{{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": reply}}}
	attachLocalReplyFiles(context.Background(), NewTransport(srv.URL, "token"), "s1",
		events, []string{workDir, uploadsDir}, newReplyAttachmentIDs())

	want := "![Secrets page mockup](orbit-attachment:att-1-secrets-page-mockup.png)\n" +
		"[secrets-page-mockup.html](orbit-attachment:att-2-secrets-page-mockup.html \"secrets-page-mockup.html\")\n" +
		"![both](orbit-attachment:att-3-both.png)\n" +
		"![never](never-written.png)\n" +
		"[the lookup](codex_artifacts.go:77) [task](orbit-task:34xGMBOf31IJy137P02PT)" +
		"\n\n_Not attached: `never-written.png` does not exist in this session's working directory or uploads directory._"
	if got := events[0].Payload["text"]; got != want {
		t.Fatalf("reply =\n%q\nwant\n%q", got, want)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 3 || !strings.HasSuffix(bodies[2], "workdir") {
		t.Fatalf("uploads = %q, want 3 with both.png from the working directory", bodies)
	}
}

func TestAttachLocalReplyFilesRewritesDrivePaths(t *testing.T) {
	fakeDriveMount(t, true)
	var stats int
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/drive/stat" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		stats++
		switch p := r.URL.Query().Get("path"); p {
		case "/Proj/r.md":
			fmt.Fprint(w, `{"id":"e1","kind":"FILE","path":"/Proj/r.md"}`)
		case "/absent":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"code":"DRIVE_ENTRY_NOT_FOUND","message":"No such entry."}`)
		default:
			t.Errorf("unexpected drive path %q", p)
			http.NotFound(w, r)
		}
	})
	text := "[home](" + driveHomePath + "/Proj/r.md) [tilde](~/Drive/Proj/r.md) " +
		"[resolved](" + driveMountPath + "/Proj/r.md) [missing](~/Drive/absent)"
	want := "[home](orbit-drive:e1) [tilde](orbit-drive:e1) [resolved](orbit-drive:e1) [missing](~/Drive/absent)"
	out := []RunEvent{{Type: evAssistant, Payload: map[string]interface{}{"text": text}}}
	transport := newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)
	attachLocalReplyFiles(context.Background(), transport, fileTestSession, out, []string{t.TempDir()}, newReplyAttachmentIDs())
	if got := out[0].Payload["text"]; got != want || stats != 2 {
		t.Fatalf("rewrote to %q with %d lookups; want %q with 2 lookups", got, stats, want)
	}
}
