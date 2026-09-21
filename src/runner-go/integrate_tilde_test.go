package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// A workspace's work_dir is stored with a leading ~ — that is the product's own spelling of "this
// runner's home", and `git -C` expands nothing. The integration job was the one path that never
// resolved it, so a project whose work_dir is `~/orbit` died at its very first step, the checkout
// check, with "cannot change to '~/orbit': No such file or directory" (observed 2026-09-21 on job
// 54b9b0ad, LAND_TASK, phase FETCH, error FETCH_FAILED).
//
// HOME is set to the fixture's own directory rather than left alone on purpose: expandTilde resolves
// against it, so a fixture running under the real HOME would pass whether or not the job expanded
// anything. That, and only that, is what makes this test red without the fix.
func TestIntegrationJobTildeWorkDir(t *testing.T) {
	r := newIntegrationRepo(t)
	home := filepath.Dir(r.work)
	t.Setenv("HOME", home)

	r.checkoutNew("task/tilde", "main")
	r.write("tilde.txt", "landed from a tilde work dir\n")
	r.commit("task tilde")
	r.push("task/tilde")
	r.checkout("main")

	cmd := r.command("task/tilde", "project/tilde")
	cmd.WorkDir = "~/" + filepath.Base(r.work)

	resolved := expandTilde(cmd.WorkDir)
	if resolved != r.work || !filepath.IsAbs(resolved) || !strings.HasPrefix(resolved, home+string(filepath.Separator)) {
		t.Fatalf("expandTilde(%q) = %q, want the absolute path %q under HOME %q",
			cmd.WorkDir, resolved, r.work, home)
	}

	result := runIntegrationJob(cmd, silent)
	if result.State == "ERROR" && result.ErrorCode == "FETCH_FAILED" {
		t.Fatalf("the job died at the checkout check with a tilde work dir: %s %v",
			result.Phase, result.ErrorDetail)
	}
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}
	if got := r.originRev("refs/heads/project/tilde"); got != result.LandedSha {
		t.Fatalf("origin holds %s, the result claims %s", got, result.LandedSha)
	}
}
