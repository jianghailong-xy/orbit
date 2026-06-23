package main

import (
	"strings"
	"testing"
)

// A combined `git diff` over three files: a modify, an add (+++ b/…), and a delete (+++ is
// /dev/null, so the path must fall back to the `diff --git` header).
const sampleDiff = `diff --git a/foo.txt b/foo.txt
index e69de29..d95f3ad 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,2 +1,3 @@
 line one
-line two
+line two changed
+line three
diff --git a/sub/new.txt b/sub/new.txt
new file mode 100644
index 0000000..b6fc4c6
--- /dev/null
+++ b/sub/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index b6fc4c6..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-was here`

func TestSplitPatchKeysByNewPath(t *testing.T) {
	got := splitPatch(sampleDiff)
	for _, p := range []string{"foo.txt", "sub/new.txt", "gone.txt"} {
		if got[p] == "" {
			t.Fatalf("splitPatch missing segment for %q (keys: %v)", p, keys(got))
		}
		if !strings.HasPrefix(got[p], "diff --git ") {
			t.Errorf("segment %q should start with the diff header, got:\n%s", p, got[p])
		}
	}
	if len(got) != 3 {
		t.Errorf("expected 3 file segments, got %d (%v)", len(got), keys(got))
	}
	// The modify segment must carry its hunk + both the removed and added lines.
	foo := got["foo.txt"]
	for _, want := range []string{"@@ -1,2 +1,3 @@", "-line two", "+line two changed"} {
		if !strings.Contains(foo, want) {
			t.Errorf("foo.txt segment missing %q:\n%s", want, foo)
		}
	}
	if strings.Contains(got["sub/new.txt"], "gone.txt") {
		t.Error("new.txt segment leaked into the next file")
	}
}

func TestSplitPatchEmpty(t *testing.T) {
	if got := splitPatch(""); len(got) != 0 {
		t.Errorf("empty diff should yield no segments, got %v", got)
	}
}

func TestBuildFilePatches(t *testing.T) {
	byPath := splitPatch(sampleDiff)
	files := []ChangedFile{
		{Path: "foo.txt", Additions: 2, Deletions: 1, Status: "M"},
		{Path: "logo.png", Additions: -1, Deletions: -1, Status: "M"}, // binary → skipped
		{Path: "sub/new.txt", Additions: 1, Deletions: 0, Status: "A"},
		{Path: "untracked-no-patch.txt", Additions: 3, Deletions: 0, Status: "A"}, // no segment → skipped
	}
	out := buildFilePatches(files, byPath)
	if len(out) != 2 {
		t.Fatalf("expected 2 patches (binary + missing-segment dropped), got %d: %+v", len(out), out)
	}
	if out[0].Path != "foo.txt" || out[0].Patch == "" || out[0].Truncated {
		t.Errorf("foo.txt should carry a non-truncated patch, got %+v", out[0])
	}
	if out[1].Path != "sub/new.txt" || out[1].Patch == "" {
		t.Errorf("sub/new.txt should carry a patch, got %+v", out[1])
	}
}

func TestBuildFilePatchesTruncatesOversize(t *testing.T) {
	big := "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1 @@\n" +
		strings.Repeat("+padding line to exceed the per-file cap\n", 2000) // > maxFilePatchBytes
	if len(big) <= maxFilePatchBytes {
		t.Fatalf("test setup: big patch (%d bytes) must exceed cap %d", len(big), maxFilePatchBytes)
	}
	files := []ChangedFile{{Path: "big.txt", Additions: 2000, Deletions: 0, Status: "M"}}
	out := buildFilePatches(files, map[string]string{"big.txt": big})
	if len(out) != 1 || !out[0].Truncated || out[0].Patch != "" {
		t.Fatalf("oversize file should be marked truncated with no patch text, got %+v", out)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
