package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

// Opt-in read-only measurement. Run under nice/ionice; no taint records
// are accessed, and git's optional index writes are disabled.
// ORBIT_SECRET_SCAN_BENCH names the worktrees directory; BENCH_BASELINE=1
// uses the old exclusions, and BENCH_WORKERS controls parallelism.
func TestSecretScanBenchmark(t *testing.T) {
	root := os.Getenv("ORBIT_SECRET_SCAN_BENCH")
	if root == "" {
		t.Skip("set ORBIT_SECRET_SCAN_BENCH for read-only host measurement")
	}
	t.Setenv("GIT_OPTIONAL_LOCKS", "0")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	workers := 4
	if n, err := strconv.Atoi(os.Getenv("BENCH_WORKERS")); err == nil && n > 0 {
		workers = n
	}
	type result struct {
		name                 string
		total, history, tree time.Duration
		err                  error
	}
	results := make(chan result, len(entries))
	jobs := make(chan string)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for name := range jobs {
				dir := filepath.Join(root, name)
				if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
					continue
				}
				began := time.Now()
				r := newSecretRedactor([]string{"orbit-benchmark-dummy-never-a-real-secret-651b748a"})
				base, _ := git(dir, "rev-parse", "--verify", "--quiet", baseRefName(name))
				var err error
				if os.Getenv("BENCH_BASELINE") == "1" {
					_, err = secretHistoryObjects(dir, "HEAD", r, base)
				} else {
					var tip string
					tip, err = checkoutSecretHistoryTip(dir, base)
					if err == nil && tip != "" {
						_, err = secretHistoryObjects(dir, tip, r, base, "--remotes=origin")
					}
				}
				history := time.Since(began)
				_, treeErr := uncommittedObjectsHolding(dir, r)
				if err == nil {
					err = treeErr
				}
				results <- result{name, time.Since(began), history, time.Since(began) - history, err}
			}
		}()
	}
	for _, entry := range entries {
		if entry.IsDir() {
			jobs <- entry.Name()
		}
	}
	close(jobs)
	wg.Wait()
	close(results)
	elapsed := time.Since(start)
	var all []result
	var total, history, tree time.Duration
	for r := range results {
		all = append(all, r)
		total += r.total
		history += r.history
		tree += r.tree
		if r.err != nil {
			t.Errorf("%s: %v", r.name, r.err)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].total > all[j].total })
	t.Logf("checkouts=%d workers=%d elapsed=%s summed=%s history=%s tree=%s", len(all), workers, elapsed, total, history, tree)
	for i, r := range all {
		if i == 10 {
			break
		}
		t.Logf("%s total=%s history=%s tree=%s", r.name, r.total, r.history, r.tree)
	}
}
