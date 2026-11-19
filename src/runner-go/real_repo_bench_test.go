//go:build linux

package main

// A benchmark against a real repository on a real filesystem, for the volume measurements that a synthetic fixture
// cannot give: how many bytes the clones take (statfs) and how long making each checkout takes with the index fast
// path. It is skipped unless ORBIT_BENCH_REPO names a checkout; ORBIT_BENCH_WORKTREES sets how many to make (32).
// Run it with TMPDIR on the volume under test:
//
//	ORBIT_BENCH_REPO=/data/orbit ORBIT_BENCH_WORKTREES=32 TMPDIR=/data/tmp \
//	  go test -run '^TestRealRepositoryCheckoutBenchmark$' -v .

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func statfsUsedBytes(t *testing.T, path string) uint64 {
	t.Helper()
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		t.Fatal(err)
	}
	return (st.Blocks - st.Bfree) * uint64(st.Bsize)
}

func TestRealRepositoryCheckoutBenchmark(t *testing.T) {
	repo := os.Getenv("ORBIT_BENCH_REPO")
	if repo == "" {
		t.Skip("set ORBIT_BENCH_REPO to a checkout to run")
	}
	count := 32
	if value := os.Getenv("ORBIT_BENCH_WORKTREES"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 {
			t.Fatalf("ORBIT_BENCH_WORKTREES=%q is not a positive number", value)
		}
		count = parsed
	}
	t.Setenv("ORBIT_HOME", filepath.Join(t.TempDir(), "home"))
	base := mustGit(t, repo, "rev-parse", "HEAD")
	t.Logf("repository %s at %s, %d checkouts, ORBIT_HOME %s", realPath(repo), base, count, os.Getenv("ORBIT_HOME"))

	before := statfsUsedBytes(t, repo)
	start := time.Now()
	cloned := 0
	for i := 0; i < count; i++ {
		wt := filepath.Join(t.TempDir(), fmt.Sprintf("wt-%02d", i))
		begin := time.Now()
		made, err := addSessionCheckout(fmt.Sprintf("bench-%02d", i), repo, wt, base, "--detach", wt, base)
		if err != nil {
			t.Fatalf("checkout %d: %v", i, err)
		}
		if !made {
			t.Fatalf("checkout %d was not cloned", i)
		}
		cloned++
		t.Logf("checkout %02d: %s", i, time.Since(begin))
	}
	elapsed := time.Since(start)
	after := statfsUsedBytes(t, repo)
	t.Logf("%d cloned checkouts in %s (%s each); statfs used +%d bytes (%d per checkout)",
		cloned, elapsed, elapsed/time.Duration(cloned), after-before, (after-before)/uint64(cloned))
}
