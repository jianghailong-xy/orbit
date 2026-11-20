package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Discard: the chosen files of the main checkout go back to HEAD (deleted when HEAD does not have
// them), after the whole checkout is saved to orbit/rescue-*. It is Move without a target:
//
//  1. check the fingerprint (or, redoing a Discard that stopped part way, its journal);
//  2. save the whole checkout to orbit/rescue-* and write the journal;
//  3. re-read the chosen paths: any that changed since the save is somebody's newer write, and the
//     Discard stops there with FINGERPRINT_STALE, having restored nothing;
//  4. restore only those paths: `checkout HEAD --` for those HEAD has, delete the others.

// discardMainCheckoutFiles is the discard action.
func discardMainCheckoutFiles(cmd MainCheckoutActionCommand, deps mainCheckoutDeps) (MainCheckoutActionResult, error) {
	r := newMainCheckoutResult(cmd)
	ctx := context.Background()
	root, err := mainCheckoutRoot(ctx, cmd.Root)
	if err != nil || (deps.owns != nil && !deps.owns(root)) {
		r.GitMessage = "that checkout isn't one this runner works in"
		return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
	}
	defer lockMainCheckout(root)()
	if pastDeadline(cmd.ExpiresAt) {
		return r, errMainCheckoutExpired
	}

	scan, err := scanMainCheckout(ctx, root)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
	}
	r.Branch = scan.Snapshot.Branch
	if mainCheckoutBlocked(scan.Snapshot.State) {
		r.State = scan.Snapshot.State
		return refuseMainCheckout(r, mainCheckoutCheckoutBlocked), nil
	}
	if scan.Snapshot.Head == "" {
		return refuseMainCheckout(r, mainCheckoutNoHead), nil
	}
	journalPath, err := discardJournalPath(root, cmd.RequestID)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
	}
	files := append([]string(nil), cmd.Files...)
	sort.Strings(files)

	var rescueCommit string
	journal := readMoveJournal(journalPath)
	redo := journal != nil && journal.Fingerprint == cmd.Fingerprint
	if redo {
		// The same Discard, stopped part way: the files it already restored changed the
		// fingerprint. Each path is checked against the saved content in step 3 instead.
		if journal.Head != scan.Snapshot.Head {
			_ = os.Remove(journalPath)
			r.Head = scan.Snapshot.Head
			return refuseMainCheckout(r, mainCheckoutHeadMoved), nil
		}
		rescueCommit, r.RescueBranch, files = journal.RescueCommit, journal.RescueBranch, journal.Files
		_, _ = git(root, "update-ref", "refs/heads/"+r.RescueBranch, rescueCommit, "")
	} else {
		if code := checkMainCheckoutFingerprint(&r, cmd.Fingerprint, scan); code != "" {
			return refuseMainCheckout(r, code), nil
		}
		changed := map[string]bool{}
		for _, f := range scan.All {
			changed[f.Path] = true
		}
		var missing []string
		for _, p := range files {
			if !changed[p] {
				missing = append(missing, p)
			}
		}
		if len(files) == 0 || len(missing) > 0 {
			r.Paths = missing
			return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
		}
		branch, err := rescueWorkingTree(root, repoRootState{State: scan.Snapshot.State, Paths: files})
		if err != nil || branch == "" {
			if err != nil {
				r.GitMessage = firstLine(err.Error())
			}
			return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
		}
		r.RescueBranch = branch
		rescueCommit, _ = git(root, "rev-parse", "refs/heads/"+branch)
		if err := writeMoveJournal(journalPath, moveJournal{RequestID: cmd.RequestID, Fingerprint: cmd.Fingerprint,
			Head: scan.Snapshot.Head, RescueCommit: rescueCommit, RescueBranch: branch, Files: files}); err != nil {
			r.GitMessage = firstLine(err.Error())
			return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
		}
		if mainCheckoutStep("discard-journaled") {
			return r, errMainCheckoutStopped
		}
	}
	n := len(files)
	r.FileCount = &n
	// Every answer from here on ends the Discard: its journal goes, the rescue branch stays.
	refuse := func(code string) (MainCheckoutActionResult, error) {
		_ = os.Remove(journalPath)
		return refuseMainCheckout(r, code), nil
	}
	fail := func(err error) (MainCheckoutActionResult, error) {
		_ = os.Remove(journalPath)
		return r, err
	}

	// Step 3: each path must hold what was saved or, on a redo, HEAD's content (restored before
	// the stop). Anything else was written after the save, and is not ours to throw away.
	head := scan.Snapshot.Head
	base, err := lsTree(root, head, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutRescueFailed)
	}
	saved, err := lsTree(root, rescueCommit, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutRescueFailed)
	}
	now, err := mainCheckoutHashes(ctx, root, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutFingerprintStale)
	}
	var drift, restoreTracked, restoreNew []string
	for _, p := range files {
		cur, onDisk := now[p]
		s, inSaved := saved[p]
		h, inHead := base[p]
		switch {
		case onDisk == inSaved && (!onDisk || cur == s.blob):
			if inHead {
				restoreTracked = append(restoreTracked, p)
			} else {
				restoreNew = append(restoreNew, p)
			}
		case redo && onDisk == inHead && (!onDisk || cur == h.blob):
			// restored before the stop
		default:
			drift = append(drift, p)
		}
	}
	if len(drift) > 0 {
		r.Paths = drift
		return refuse(mainCheckoutFingerprintStale)
	}

	// Step 4: only these paths, nothing else in the checkout. A failure part way is ACTION_FAILED
	// naming the rescue branch, which holds every chosen file as it was.
	env := append(os.Environ(), "GIT_LITERAL_PATHSPECS=1")
	for len(restoreTracked) > 0 {
		chunk := restoreTracked[:min(len(restoreTracked), 200)]
		restoreTracked = restoreTracked[len(chunk):]
		if _, err := gitEnv(root, env, append([]string{"checkout", "HEAD", "--"}, chunk...)...); err != nil {
			return fail(fmt.Errorf("git checkout: %s", gitStderr(err)))
		}
	}
	if mainCheckoutStep("discard-restored-tracked") {
		return r, errMainCheckoutStopped
	}
	for _, p := range restoreNew {
		_, _ = gitEnv(root, env, "rm", "--cached", "--quiet", "--ignore-unmatch", "--", p)
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return fail(err)
		}
		removeEmptyParents(root, filepath.Dir(abs))
	}
	_ = os.Remove(journalPath)
	if after, err := scanMainCheckout(ctx, root); err == nil {
		left := len(after.All)
		r.Remaining = &left
	}
	logln(fmt.Sprintf("main checkout %s: discarded %d file(s); rescue branch %s", root, n, r.RescueBranch))
	return finishMainCheckoutResult(r, mainCheckoutDone, ""), nil
}

// discardJournalPath is where a Discard keeps its journal (a moveJournal) until it ends.
func discardJournalPath(root, requestID string) (string, error) {
	dir, err := git(root, "rev-parse", "--git-common-dir")
	if err != nil || dir == "" {
		return "", fmt.Errorf("git dir: %s", gitStderr(err))
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	sum := sha256.Sum256([]byte(requestID))
	return filepath.Join(dir, "orbit-main-checkout", "discard-"+hex.EncodeToString(sum[:])[:24]+".json"), nil
}
