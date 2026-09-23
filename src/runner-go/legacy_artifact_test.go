package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// A client that runs into a path no one can read — a reply from before the runner uploaded them
// (reply_attachments.go), or a file outside those roots — asks the control plane for it, and the
// control plane asks this runner. What it will read is the session's own files and nothing else.
func TestUploadLegacyArtifactReadsOnlyTheSessionsOwnFiles(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	const sid = "01a0c8ed-3b0b-742c-a7ee-93f0de502852"
	// The same session, spelled the way a claim may carry it (publicId is base62 of the uuid).
	const publicID = "34TDMPhOp85Cs48GNIHg2"

	writeFile := func(path string) string {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("bytes"), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	checkout := writeFile(filepath.Join(worktreesDir(), sid, "docs", "mocks", "card.png"))
	checkoutPublicID := writeFile(filepath.Join(worktreesDir(), publicID, "docs", "mocks", "card.png"))
	scratch := writeFile(filepath.Join(uploadsDir(sid), "note.pdf"))
	outside := writeFile(filepath.Join(t.TempDir(), "elsewhere", "card.png"))

	var mu sync.Mutex
	var uploaded []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err == nil && r.MultipartForm != nil {
			mu.Lock()
			for _, header := range r.MultipartForm.File["file"] {
				uploaded = append(uploaded, header.Filename)
			}
			mu.Unlock()
		}
		fmt.Fprint(w, `{"id":"att-1"}`)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")

	for _, tc := range []struct {
		name       string
		path       string
		wantStatus string
		wantFiles  int
	}{
		{"the session's checkout", checkout, "uploaded", 1},
		// The checkout is named after whatever spelling the claim carried (setupWorktree), so a
		// request that spells the session the other way still finds it.
		{"checkout named by public id", checkoutPublicID, "uploaded", 2},
		{"the session's uploads scratch", scratch, "uploaded", 3},
		{"a file outside every root", outside, "missing", 3},
		{"a path that does not exist", filepath.Join(worktreesDir(), sid, "docs", "gone.png"), "missing", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := uploadLegacyArtifact(context.Background(), transport, ArtifactCommand{
				RequestID: "req-1", SessionID: sid, Path: tc.path,
			})
			if out.Status != tc.wantStatus {
				t.Fatalf("status = %q (%s), want %q", out.Status, out.Message, tc.wantStatus)
			}
			if tc.wantStatus == "uploaded" && out.AttachmentID != "att-1" {
				t.Fatalf("attachment id = %q", out.AttachmentID)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(uploaded) != tc.wantFiles {
				t.Fatalf("uploads so far = %v, want %d", uploaded, tc.wantFiles)
			}
		})
	}
}
