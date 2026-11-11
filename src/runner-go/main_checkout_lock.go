package main

import (
	"context"
	"path/filepath"
	"sync"
)

// One lock per main checkout, keyed by its real path (docs/main-checkout-git-contract.md §5): move,
// commit, push and Save & clean on one checkout, the session Merge (mergeToMain, merge recovery),
// Clean up checkout and the integration ref writes all take it, so no two of them rewrite the same
// checkout at once. Two workspaces whose directories reach the same checkout through different
// paths (a symlink, a subdirectory) share it, because the key is the resolved repo root.
//
// Lock order: mergeLock (when taken at all) before this one. The main checkout actions take only
// this one, so an action on one checkout never waits for a merge into another.
var mainCheckoutLocks sync.Map // real root → *sync.Mutex

// mainCheckoutLockKey is the realpath of the repo root dir sits in, or dir itself, cleaned, when it
// is not a git checkout (the caller then fails on its own, and still holds a lock while it does).
func mainCheckoutLockKey(dir string) string {
	if root, err := mainCheckoutRoot(context.Background(), dir); err == nil {
		return root
	}
	path := filepath.Clean(expandTilde(dir))
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return path
}

// lockMainCheckout takes the lock of the checkout dir sits in and returns its release.
func lockMainCheckout(dir string) func() {
	v, _ := mainCheckoutLocks.LoadOrStore(mainCheckoutLockKey(dir), &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
