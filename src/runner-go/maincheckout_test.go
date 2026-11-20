package main

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// Real-Git tests for the main checkout snapshot, fingerprint, diff and change watch
// (docs/main-checkout-git-contract.md §2–§4, §7).

func mcWrite(t *testing.T, repo, name, content string) {
	t.Helper()
	p := filepath.Join(repo, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustScan(t *testing.T, dir string) *mainCheckoutScan {
	t.Helper()
	scan, err := scanMainCheckout(context.Background(), dir)
	if err != nil {
		t.Fatalf("scan %s: %v", dir, err)
	}
	return scan
}

func fileByPath(files []MainCheckoutFile, p string) *MainCheckoutFile {
	for i := range files {
		if files[i].Path == p {
			return &files[i]
		}
	}
	return nil
}

func noticePaths(n *MainCheckoutChangedNotice) []string {
	var out []string
	for _, f := range n.Files {
		out = append(out, f.Path)
	}
	return out
}

func realRepo(t *testing.T) string {
	t.Helper()
	repo := initRepo(t)
	real, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// What was dirty before the session started is somebody else's: no card. The same path changing
// content again during a turn is this turn's doing and must be reported — the old path-set watch
// missed exactly that — and once reported it stays quiet.
func TestMainCheckoutWatchComparesPathAndContent(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, "theirs.txt", "v1\n", "add theirs")
	commitFile(t, repo, "ours.txt", "v1\n", "add ours")
	mcWrite(t, repo, "theirs.txt", "their wip\n")

	w := watchMainCheckout(&Worktree{RepoDir: repo, Branch: "orbit/feat"})
	if n := w.changed(); n != nil {
		t.Fatalf("pre-existing dirt must not produce a card, got %+v", n)
	}

	mcWrite(t, repo, "ours.txt", "stray edit\nsecond\n")
	n := w.changed()
	if n == nil || len(n.Files) != 1 || n.Files[0].Path != "ours.txt" || n.Files[0].Status != "M" {
		t.Fatalf("notice = %+v, want ours.txt M", n)
	}
	if f := n.Files[0]; f.Additions == nil || *f.Additions != 2 || f.Deletions == nil || *f.Deletions != 1 {
		t.Errorf("counts for ours.txt: %+v", f)
	}
	if n.NoticeKind != noticeMainCheckoutChanged || n.Root != repo || n.Branch != "main" || n.FileCount != 1 || n.Truncated {
		t.Errorf("notice header = %+v", n)
	}
	if want := "1 file changed in the main checkout during this turn " + repo +
		" on main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."; n.Notice != want {
		t.Errorf("notice text %q, want %q", n.Notice, want)
	}
	if n.Fingerprint != mustScan(t, repo).Snapshot.Fingerprint {
		t.Errorf("notice fingerprint is not the checkout's")
	}
	p := n.payload()
	if p["noticeKind"] != noticeMainCheckoutChanged || p["files"] == nil || p["truncated"] != false {
		t.Errorf("payload = %v", p)
	}
	if again := w.changed(); again != nil {
		t.Errorf("one batch of changes must produce one card, got %+v", again)
	}

	// The path that was dirty before the session: same path, new content → reported now.
	mcWrite(t, repo, "theirs.txt", "their wip, edited again by this turn\n")
	if n := w.changed(); n == nil || len(n.Files) != 1 || n.Files[0].Path != "theirs.txt" {
		t.Fatalf("content re-change of an already dirty path = %+v, want theirs.txt", n)
	}
	// Cleaned up and dirtied again with the same content: new relative to the last look.
	mustGit(t, repo, "checkout", "--", "ours.txt")
	if n := w.changed(); n != nil {
		t.Errorf("a reverted file is not a new change, got %+v", n)
	}
	mcWrite(t, repo, "ours.txt", "stray edit\nsecond\n")
	if n := w.changed(); n == nil || noticePaths(n)[0] != "ours.txt" {
		t.Errorf("re-dirtied path = %+v, want ours.txt", n)
	}
}

func TestMainCheckoutWatchNilWhenNotIsolated(t *testing.T) {
	if w := watchMainCheckout(nil); w != nil {
		t.Fatal("a non-isolated session must have no watch")
	}
	var none *mainCheckoutWatch
	if n := none.changed(); n != nil {
		t.Fatalf("nil watch must be inert, got %+v", n)
	}
}

// Untracked files are part of the boundary; ignored ones never are.
func TestMainCheckoutUntrackedIncludedIgnoredExcluded(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, ".gitignore", "build/\n*.log\n", "ignore")
	w := watchMainCheckout(&Worktree{RepoDir: repo})

	mcWrite(t, repo, "notes/new.md", "one\ntwo\nthree")
	mcWrite(t, repo, "build/out.bin", "ignored")
	mcWrite(t, repo, "debug.log", "ignored")

	snap := mustScan(t, repo).Snapshot
	if len(snap.Files) != 1 {
		t.Fatalf("files = %+v, want only notes/new.md", snap.Files)
	}
	f := snap.Files[0]
	if f.Path != "notes/new.md" || f.Status != "A" || !f.Untracked || f.Binary ||
		f.Additions == nil || *f.Additions != 3 || *f.Deletions != 0 {
		t.Errorf("untracked file = %+v", f)
	}
	if want := mustGit(t, repo, "hash-object", "notes/new.md"); f.ContentHash != want {
		t.Errorf("content hash %s, git hash-object %s", f.ContentHash, want)
	}
	if snap.State != repoStateDirty {
		t.Errorf("state %q with only an untracked file, want dirty", snap.State)
	}
	n := w.changed()
	if n == nil || len(n.Files) != 1 || n.Files[0].Path != "notes/new.md" || n.Files[0].Status != "A" {
		t.Fatalf("notice = %+v", n)
	}

	d, err := mainCheckoutFileDiff(context.Background(), repo, "notes/new.md")
	if err != nil {
		t.Fatal(err)
	}
	if d.Binary || !strings.Contains(d.Patch, "new file mode") || !strings.Contains(d.Patch, "+three") {
		t.Errorf("untracked diff = %+v", d)
	}
}

// No rename detection: a rename is D + A. A delete hashes as "-". A binary file is marked and
// carries no counts and no patch.
func TestMainCheckoutRenameDeleteBinary(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, "old-name.txt", "keep me\n", "add")
	commitFile(t, repo, "doomed.txt", "bye\nbye\n", "add")
	if err := os.WriteFile(filepath.Join(repo, "logo.png"), []byte("\x89PNG\x00\x01\x02"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "logo.png")
	mustGit(t, repo, "commit", "-m", "logo")

	mustGit(t, repo, "mv", "old-name.txt", "new-name.txt")
	if err := os.Remove(filepath.Join(repo, "doomed.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "logo.png"), []byte("\x89PNG\x00\x03\x04\x05"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "blob.dat"), []byte{0, 1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}

	files := mustScan(t, repo).Snapshot.Files
	var got []string
	for _, f := range files {
		got = append(got, f.Status+" "+f.Path)
	}
	want := []string{"A blob.dat", "D doomed.txt", "M logo.png", "A new-name.txt", "D old-name.txt"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("files = %v, want %v", got, want)
	}
	if f := fileByPath(files, "doomed.txt"); f.ContentHash != "-" || f.Additions == nil || *f.Deletions != 2 {
		t.Errorf("deleted file = %+v", f)
	}
	if f := fileByPath(files, "new-name.txt"); f.Untracked || f.ContentHash != mustGit(t, repo, "rev-parse", "HEAD:old-name.txt") {
		t.Errorf("renamed file (staged A) = %+v", f)
	}
	for _, p := range []string{"logo.png", "blob.dat"} {
		if f := fileByPath(files, p); !f.Binary || f.Additions != nil || f.Deletions != nil {
			t.Errorf("binary %s = %+v", p, f)
		}
	}

	ctx := context.Background()
	if d, err := mainCheckoutFileDiff(ctx, repo, "logo.png"); err != nil || !d.Binary || d.Patch != "" {
		t.Errorf("binary diff = %+v, %v", d, err)
	}
	if d, err := mainCheckoutFileDiff(ctx, repo, "blob.dat"); err != nil || !d.Binary || d.Patch != "" {
		t.Errorf("untracked binary diff = %+v, %v", d, err)
	}
	if d, err := mainCheckoutFileDiff(ctx, repo, "doomed.txt"); err != nil || !strings.Contains(d.Patch, "deleted file mode") {
		t.Errorf("deleted diff = %+v, %v", d, err)
	}
	if d, err := mainCheckoutFileDiff(ctx, repo, "old-name.txt"); err != nil || !strings.Contains(d.Patch, "deleted file mode") {
		t.Errorf("rename source diff = %+v, %v", d, err)
	}
	if d, err := mainCheckoutFileDiff(ctx, repo, "new-name.txt"); err != nil || !strings.Contains(d.Patch, "new file mode") {
		t.Errorf("rename target diff = %+v, %v", d, err)
	}
	for _, bad := range []string{"../etc/passwd", "/etc/passwd", "a/../b", ""} {
		if _, err := mainCheckoutFileDiff(ctx, repo, bad); err == nil {
			t.Errorf("diff accepted %q", bad)
		}
	}
}

// Paths are data, not pathspecs or lines: spaces, a leading space, quotes, glob characters,
// non-ASCII and a line break all survive the scan, hash and diff exactly.
func TestMainCheckoutSpecialCharacterPaths(t *testing.T) {
	repo := realRepo(t)
	tracked := []string{" lead space.txt", "dir with space/quote\"d.txt", "glob*[a].ts", "ünï/çødé — dash.md"}
	for _, p := range tracked {
		mcWrite(t, repo, p, "v1\n")
	}
	// A sibling the glob would match: must not be dragged in by the pathspec.
	mcWrite(t, repo, "globXa.ts", "v1\n")
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "commit", "-m", "add special paths")
	for _, p := range tracked {
		mcWrite(t, repo, p, "v2 of "+p+"\n")
	}
	untracked := []string{"line\nbreak.txt", "tab\there.txt", "中文 名.txt"}
	for _, p := range untracked {
		mcWrite(t, repo, p, "new\n")
	}

	snap := mustScan(t, repo).Snapshot
	var got []string
	for _, f := range snap.Files {
		got = append(got, f.Path)
		want := mustGit(t, repo, "hash-object", "--", f.Path)
		if f.ContentHash != want {
			t.Errorf("%q hash %s, git hash-object %s", f.Path, f.ContentHash, want)
		}
		if f.Additions == nil || *f.Additions != 1 {
			t.Errorf("%q counts = %+v", f.Path, f)
		}
	}
	want := append(append([]string{}, tracked...), untracked...)
	sort.Strings(want) // byte order
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("paths:\n got %q\nwant %q", got, want)
	}
	for _, p := range []string{"glob*[a].ts", "line\nbreak.txt", " lead space.txt"} {
		d, err := mainCheckoutFileDiff(context.Background(), repo, p)
		if err != nil || d.Patch == "" {
			t.Errorf("diff %q = %+v, %v", p, d, err)
		}
		if strings.Contains(d.Patch, "globXa.ts") {
			t.Errorf("literal path %q matched a sibling: %s", p, d.Patch)
		}
	}
}

// Before the first commit there is no HEAD: everything is new, and the fingerprint says "-".
// Detached HEAD has a head and no branch.
func TestMainCheckoutUnbornAndDetachedHead(t *testing.T) {
	repo := t.TempDir()
	mustGit(t, repo, "init", "-b", "main")
	mcWrite(t, repo, "staged.txt", "a\nb\n")
	mustGit(t, repo, "add", "staged.txt")
	mcWrite(t, repo, "loose.txt", "c\n")

	snap := mustScan(t, repo).Snapshot
	if snap.Head != "" || snap.Branch != "main" || snap.Upstream != "" || snap.Ahead != nil {
		t.Errorf("unborn header = %+v", snap)
	}
	if !strings.HasPrefix(snap.Fingerprint, "mc1:-:") {
		t.Errorf("unborn fingerprint %s", snap.Fingerprint)
	}
	if len(snap.Files) != 2 || snap.Files[0].Path != "loose.txt" || !snap.Files[0].Untracked ||
		snap.Files[1].Path != "staged.txt" || snap.Files[1].Untracked {
		t.Fatalf("unborn files = %+v", snap.Files)
	}
	for _, f := range snap.Files {
		if f.Status != "A" || f.Additions == nil {
			t.Errorf("unborn file = %+v", f)
		}
	}
	if snap.State != repoStateDirty {
		t.Errorf("unborn state %q", snap.State)
	}
	if d, err := mainCheckoutFileDiff(context.Background(), repo, "staged.txt"); err != nil || !strings.Contains(d.Patch, "+b") {
		t.Errorf("unborn diff = %+v, %v", d, err)
	}

	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "commit", "-m", "first")
	mustGit(t, repo, "checkout", "--detach")
	snap = mustScan(t, repo).Snapshot
	head := mustGit(t, repo, "rev-parse", "HEAD")
	if snap.Branch != "" || snap.Head != head || len(snap.Files) != 0 || snap.State != repoStateClean {
		t.Errorf("detached = %+v", snap)
	}
	if !strings.HasPrefix(snap.Fingerprint, "mc1:"+head+":") {
		t.Errorf("detached fingerprint %s", snap.Fingerprint)
	}
}

// Past 200 files the list stops and says so; the fingerprint still covers every file, and so
// does the notice's count of what changed.
func TestMainCheckoutTruncationReported(t *testing.T) {
	repo := realRepo(t)
	w := watchMainCheckout(&Worktree{RepoDir: repo})
	total := mainCheckoutFileLimit + 5
	for i := 0; i < total; i++ {
		mcWrite(t, repo, fmt.Sprintf("gen/f%03d.txt", i), fmt.Sprintf("%d\n", i))
	}
	scan := mustScan(t, repo)
	snap := scan.Snapshot
	if len(snap.Files) != mainCheckoutFileLimit || snap.FileCount != mainCheckoutFileLimit || !snap.Truncated {
		t.Fatalf("truncated snapshot: %d files, fileCount %d, truncated %v", len(snap.Files), snap.FileCount, snap.Truncated)
	}
	if len(scan.All) != total || snap.Fingerprint != mainCheckoutFingerprint(snap.Head, scan.All) {
		t.Errorf("fingerprint must cover all %d files (scan has %d)", total, len(scan.All))
	}
	if snap.Fingerprint == mainCheckoutFingerprint(snap.Head, snap.Files) {
		t.Errorf("fingerprint covers only the listed files")
	}
	// A change past the limit still changes the fingerprint.
	mcWrite(t, repo, fmt.Sprintf("gen/f%03d.txt", total-1), "changed\n")
	if mustScan(t, repo).Snapshot.Fingerprint == snap.Fingerprint {
		t.Errorf("a change in file %d (past the limit) did not change the fingerprint", total)
	}

	n := w.changed()
	if n == nil || len(n.Files) != mainCheckoutFileLimit || n.FileCount != mainCheckoutFileLimit || !n.Truncated {
		t.Fatalf("truncated notice: %+v", n)
	}
	if !strings.HasPrefix(n.Notice, "At least 200 files changed in the main checkout during this turn ") {
		t.Errorf("truncated notice text %q", n.Notice)
	}
	if hb := mainCheckoutHeartbeat(repo); hb == nil || *hb.FileCount != mainCheckoutFileLimit || !*hb.Truncated {
		t.Errorf("heartbeat = %+v", hb)
	}
}

// Same state → same fingerprint; any content or HEAD change → a different one; putting the
// content back restores it.
func TestMainCheckoutFingerprintStability(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, "a.txt", "one\n", "a")
	mcWrite(t, repo, "a.txt", "two\n")
	mcWrite(t, repo, "u.txt", "untracked\n")

	first := mustScan(t, repo).Snapshot
	if again := mustScan(t, repo).Snapshot; again.Fingerprint != first.Fingerprint {
		t.Fatalf("identical state, fingerprints differ: %s vs %s", first.Fingerprint, again.Fingerprint)
	}
	// Staging changes only the index, which the fingerprint leaves out.
	mustGit(t, repo, "add", "a.txt")
	if fp := mustScan(t, repo).Snapshot.Fingerprint; fp != first.Fingerprint {
		t.Errorf("staging changed the fingerprint")
	}
	mustGit(t, repo, "reset", "-q")

	mcWrite(t, repo, "a.txt", "three\n")
	changed := mustScan(t, repo).Snapshot.Fingerprint
	if changed == first.Fingerprint {
		t.Errorf("content change kept the fingerprint")
	}
	mcWrite(t, repo, "u.txt", "untracked, edited\n")
	if fp := mustScan(t, repo).Snapshot.Fingerprint; fp == changed {
		t.Errorf("untracked content change kept the fingerprint")
	}
	mcWrite(t, repo, "a.txt", "two\n")
	mcWrite(t, repo, "u.txt", "untracked\n")
	if fp := mustScan(t, repo).Snapshot.Fingerprint; fp != first.Fingerprint {
		t.Errorf("restored content, fingerprint %s, want %s", fp, first.Fingerprint)
	}

	commitFile(t, repo, "other.txt", "x\n", "move HEAD")
	moved := mustScan(t, repo).Snapshot
	if moved.Fingerprint == first.Fingerprint || moved.Head == first.Head {
		t.Errorf("HEAD change kept the fingerprint")
	}
	if !strings.HasPrefix(moved.Fingerprint, "mc1:"+moved.Head+":") {
		t.Errorf("HEAD not readable from %s", moved.Fingerprint)
	}
}

// A snapshot reads; it never writes. Not the index (git status would save refreshed stat data
// into it), not an index.lock, not a single object (hashing untracked content stores nothing).
func TestMainCheckoutSnapshotWritesNothing(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, "a.txt", "one\n", "a")
	mcWrite(t, repo, "a.txt", "two\n")
	mcWrite(t, repo, "new.txt", "brand new content\n")
	// Touch a clean tracked file so its stat differs from the index: exactly what makes git
	// refresh — and rewrite — the index on a read when it is allowed to.
	if err := os.Chtimes(filepath.Join(repo, "base.txt"), mustModTime(t, repo, "base.txt").Add(5*time.Second), mustModTime(t, repo, "base.txt").Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(repo, ".git", "index")
	before, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, _ := os.Stat(indexPath)
	beforeObjects := listObjects(t, repo)

	for i := 0; i < 3; i++ {
		mustScan(t, repo)
		if _, err := mainCheckoutFileDiff(context.Background(), repo, "new.txt"); err != nil {
			t.Fatal(err)
		}
		if _, err := mainCheckoutFileDiff(context.Background(), repo, "a.txt"); err != nil {
			t.Fatal(err)
		}
		mainCheckoutHeartbeat(repo)
	}

	after, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, _ := os.Stat(indexPath)
	if !bytes.Equal(before, after) || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Errorf(".git/index was written during a snapshot")
	}
	if _, err := os.Stat(indexPath + ".lock"); err == nil {
		t.Errorf("an index.lock was left behind")
	}
	if afterObjects := listObjects(t, repo); strings.Join(afterObjects, ",") != strings.Join(beforeObjects, ",") {
		t.Errorf("objects were written: %d before, %d after", len(beforeObjects), len(afterObjects))
	}
}

func mustModTime(t *testing.T, repo, name string) time.Time {
	t.Helper()
	info, err := os.Stat(filepath.Join(repo, name))
	if err != nil {
		t.Fatal(err)
	}
	return info.ModTime()
}

func listObjects(t *testing.T, repo string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(filepath.Join(repo, ".git", "objects"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// Ahead/behind come from the upstream as of the last fetch.
func TestMainCheckoutUpstreamAheadBehind(t *testing.T) {
	remote := t.TempDir()
	mustGit(t, remote, "init", "--bare", "-b", "main")
	repo := realRepo(t)
	mustGit(t, repo, "remote", "add", "origin", remote)
	mustGit(t, repo, "push", "-q", "-u", "origin", "main")
	commitFile(t, repo, "local.txt", "x\n", "local 1")
	commitFile(t, repo, "local2.txt", "x\n", "local 2")

	snap := mustScan(t, repo).Snapshot
	if snap.Upstream != "origin/main" || snap.Ahead == nil || *snap.Ahead != 2 || *snap.Behind != 0 {
		t.Fatalf("upstream = %q ahead %v behind %v", snap.Upstream, snap.Ahead, snap.Behind)
	}
	reps := scanRepoHealth([]agentWorkDir{{AgentID: "a1", Dir: repo}})
	if len(reps) != 1 || reps[0].Fingerprint != snap.Fingerprint || reps[0].Ahead == nil || *reps[0].Ahead != 2 ||
		reps[0].Head != snap.Head || reps[0].FileCount == nil || *reps[0].FileCount != 0 {
		t.Errorf("heartbeat entry = %+v", reps)
	}

	mustGit(t, repo, "checkout", "-q", "-b", "topic")
	if snap := mustScan(t, repo).Snapshot; snap.Upstream != "" || snap.Ahead != nil {
		t.Errorf("branch without upstream = %+v", snap)
	}
}

// One file's patch is capped and says so.
func TestMainCheckoutPatchTruncated(t *testing.T) {
	repo := realRepo(t)
	var big strings.Builder
	for big.Len() < mainCheckoutPatchMaxBytes+1024 {
		big.WriteString("a line of text that makes the patch long enough\n")
	}
	mcWrite(t, repo, "big.txt", big.String())
	d, err := mainCheckoutFileDiff(context.Background(), repo, "big.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !d.PatchTruncated || len(d.Patch) > mainCheckoutPatchMaxBytes || !strings.HasSuffix(d.Patch, "\n") {
		t.Errorf("patch: %d bytes, truncated %v", len(d.Patch), d.PatchTruncated)
	}
	mcWrite(t, repo, "small.txt", "x\n")
	if d, _ := mainCheckoutFileDiff(context.Background(), repo, "small.txt"); d.PatchTruncated {
		t.Errorf("small patch marked truncated")
	}
}
