package main

// lockMainCheckout serializes the main checkout actions (move, commit, push, rescue) on root with
// each other and with the session Merge (docs/main-checkout-git-contract.md §5: "move, commit,
// push and rescue on one realpath share a single lock with the session Merge"). mergeToMain holds
// the process-wide mergeLock, so that is the lock: two workspaces on the same real path, or a
// Merge into it, wait for one another. Callers pass the realpath (mainCheckoutRoot) so a per-path
// lock can replace this without changing them. Returns the unlock.
func lockMainCheckout(root string) func() {
	_ = root
	mergeLock.Lock()
	return mergeLock.Unlock
}
