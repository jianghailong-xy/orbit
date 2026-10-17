//go:build go1.24

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
	"syscall"
	"testing"
)

const artifactTestSessionID = "01a0c8ed-3b0b-742c-a7ee-93f0de502852"
const artifactTestPublicID = "34TDMPhOp85Cs48GNIHg2"

func writeArtifactTestFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestUploadWorktreeArtifactPreservesPathsAndFindsIDSpellings(t *testing.T) {
	for _, tc := range []struct{ name, requestID, directoryID string }{
		{"uuid", artifactTestSessionID, artifactTestSessionID},
		{"uuid finds public checkout", artifactTestSessionID, artifactTestPublicID},
		{"public finds uuid checkout", artifactTestPublicID, artifactTestSessionID},
		{"public", artifactTestPublicID, artifactTestPublicID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			root := filepath.Join(worktreesDir(), tc.directoryID)
			paths := []string{"one/card.png", "two/card.png", "设计图/screen #1 ? 100% \"ok\".png", "%2e%2e/literal%2Fname.png", "1:2.png"}
			for i, path := range paths {
				writeArtifactTestFile(t, filepath.Join(root, path), fmt.Sprintf("content-%d", i))
			}
			// An internal alias keeps the requested filename, not its target's name.
			if err := os.Symlink(filepath.Join(root, paths[0]), filepath.Join(root, "alias.png")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(root, "one"), filepath.Join(root, "alias-dir")); err != nil {
				t.Fatal(err)
			}
			paths = append(paths, "alias-dir/card.png", "alias.png")
			var mu sync.Mutex
			count := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				file, header, err := r.FormFile("file")
				if err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				defer file.Close()
				defer r.MultipartForm.RemoveAll()
				data, err := io.ReadAll(file)
				if err != nil {
					t.Error(err)
				}
				mu.Lock()
				defer mu.Unlock()
				index := count
				if index >= len(paths) {
					t.Error("unexpected extra upload")
					return
				}
				wantContent := fmt.Sprintf("content-%d", index)
				if index >= len(paths)-2 {
					wantContent = "content-0"
				}
				if header.Filename != filepath.Base(paths[index]) || string(data) != wantContent {
					t.Errorf("upload = %q, %q; want %q, %q", header.Filename, data, filepath.Base(paths[index]), wantContent)
				}
				if header.Header.Get("Content-Type") != "image/png" {
					t.Errorf("content type = %q", header.Header.Get("Content-Type"))
				}
				count++
				fmt.Fprintf(w, `{"id":"att-%d"}`, count)
			}))
			defer srv.Close()
			transport := NewTransport(srv.URL, "token")
			for i, path := range paths {
				out := uploadLegacyArtifact(context.Background(), transport, ArtifactCommand{
					RequestID: "req", SessionID: tc.requestID, Path: path, Source: "worktree",
				})
				if out.Status != "uploaded" || out.RequestID != "req" || out.AttachmentID != fmt.Sprintf("att-%d", i+1) {
					t.Fatalf("upload %q = %+v", path, out)
				}
			}
		})
	}
}

func TestUploadWorktreeArtifactRejectsUnsafeAndUnavailableFiles(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	root := filepath.Join(worktreesDir(), artifactTestSessionID)
	writeArtifactTestFile(t, filepath.Join(root, "present.png"), "image")
	writeArtifactTestFile(t, filepath.Join(root, ".git", "config"), "private")
	writeArtifactTestFile(t, filepath.Join(root, "empty.png"), "")
	outside := filepath.Join(t.TempDir(), "private.png")
	writeArtifactTestFile(t, outside, "private")
	writeArtifactTestFile(t, filepath.Join(uploadsDir(artifactTestSessionID), "scratch.png"), "scratch")
	for name, target := range map[string]string{
		"outside.png": outside,
		"scratch.png": filepath.Join(uploadsDir(artifactTestSessionID), "scratch.png"),
		"git-alias":   filepath.Join(root, ".git", "config"),
	} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	large, err := os.Create(filepath.Join(root, "large.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := large.Truncate(maxSessionAttachmentBytes + 1); err != nil {
		t.Fatal(err)
	}
	large.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("rejected file was uploaded")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	for _, tc := range []struct{ name, path, status, code string }{
		{"absolute", filepath.Join(root, "present.png"), "error", ""},
		{"parent traversal", "../present.png", "error", ""},
		{"normalized traversal", "docs/../present.png", "error", ""},
		{"backslash traversal", `..\present.png`, "error", ""},
		{"dot component", "./present.png", "error", ""},
		{"empty component", "docs//present.png", "error", ""},
		{"drive prefix", "C:present.png", "error", ""},
		{"control character", "present\n.png", "error", ""},
		{"git", ".git/config", "error", ""},
		{"git alias", "git-alias", "error", ""},
		{"external alias", "outside.png", "error", ""},
		{"uploads alias", "scratch.png", "error", ""},
		{"directory", ".", "error", ""},
		{"nonregular", "pipe", "error", ""},
		{"empty", "empty.png", "error", ""},
		{"large", "large.png", "error", "too_large"},
		{"missing", "missing.png", "missing", ""},
		{"literal encoded traversal", "%2e%2e/private.png", "missing", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := uploadLegacyArtifact(context.Background(), NewTransport(srv.URL, "token"), ArtifactCommand{
				RequestID: "req", SessionID: artifactTestSessionID, Path: tc.path, Source: "worktree",
			})
			if out.Status != tc.status || out.ErrorCode != tc.code || out.AttachmentID != "" || out.Message == "" {
				t.Fatalf("result = %+v; want %s/%s", out, tc.status, tc.code)
			}
			if strings.Contains(out.Message, root) || strings.Contains(out.Message, outside) {
				t.Fatalf("error exposes an absolute path: %q", out.Message)
			}
		})
	}
}

func TestUploadWorktreeArtifactDoesNotCreateCheckoutOrUseUploads(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	writeArtifactTestFile(t, filepath.Join(uploadsDir(artifactTestSessionID), "image.png"), "image")
	out := uploadLegacyArtifact(context.Background(), NewTransport("http://unused", "token"), ArtifactCommand{
		RequestID: "req", SessionID: artifactTestSessionID, Path: "image.png", Source: "worktree",
	})
	if out.Status != "missing" {
		t.Fatalf("result = %+v", out)
	}
	if _, err := os.Stat(filepath.Join(machineHome(), "worktrees")); !os.IsNotExist(err) {
		t.Fatalf("request created a checkout: %v", err)
	}
}

func TestUploadSessionAttachmentEnforcesSizeLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image.png")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var mu sync.Mutex
	var uploaded []int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		part, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		defer part.Close()
		defer r.MultipartForm.RemoveAll()
		n, err := io.Copy(io.Discard, part)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		uploaded = append(uploaded, n)
		mu.Unlock()
		fmt.Fprint(w, `{"id":"att"}`)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")
	if err := file.Truncate(maxSessionAttachmentBytes); err != nil {
		t.Fatal(err)
	}
	if id, err := transport.uploadSessionAttachment(context.Background(), artifactTestSessionID, path, "image/png"); err != nil || id != "att" {
		t.Fatalf("exactly 25 MiB = %q, %v", id, err)
	}
	if err := file.Truncate(maxSessionAttachmentBytes + 1); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.uploadSessionAttachment(context.Background(), artifactTestSessionID, path, "image/png"); err != errAttachmentTooLarge {
		t.Fatalf("over 25 MiB = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(uploaded) != 1 || uploaded[0] != maxSessionAttachmentBytes {
		t.Fatalf("uploaded sizes = %v", uploaded)
	}
}

func TestWorktreeArtifactOpenRejectsReplacedDirectoriesAndFiles(t *testing.T) {
	for _, replace := range []string{"checkout", "directory", "file"} {
		t.Run(replace, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			root := filepath.Join(worktreesDir(), artifactTestSessionID)
			writeArtifactTestFile(t, filepath.Join(root, "docs", "image.png"), "allowed")
			outside := filepath.Join(worktreesDir(), "other-session")
			writeArtifactTestFile(t, filepath.Join(outside, "docs", "image.png"), "private")
			rootInfo, err := os.Lstat(root)
			if err != nil {
				t.Fatal(err)
			}
			target, replacement := root, outside
			if replace == "directory" {
				target, replacement = filepath.Join(root, "docs"), filepath.Join(outside, "docs")
			} else if replace == "file" {
				target, replacement = filepath.Join(root, "docs", "image.png"), filepath.Join(outside, "docs", "image.png")
			}
			if err := os.Rename(target, target+"-original"); err != nil {
				t.Fatal(err)
			}
			if replace == "checkout" {
				replacement = "other-session"
			}
			if err := os.Symlink(replacement, target); err != nil {
				t.Fatal(err)
			}
			file, err := openWorktreeArtifactFile(root, "docs/image.png", rootInfo)
			if err == nil {
				file.Close()
				t.Fatal("opened a file through a replaced path")
			}
		})
	}
}
