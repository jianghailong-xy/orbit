package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Main checkout actions on the runner (docs/main-checkout-git-contract.md §5, §6, §10): the
// heartbeat hands out a read or an action once, the runner does it under the checkout's lock
// (main_checkout_lock.go) and posts the answer. This file holds the relay's runner half, Move and
// Save & clean; Commit (main_checkout_commit.go) and Push (main_checkout_push.go) are dispatched
// from runMainCheckoutAction.
//
// Every action starts by recomputing the fingerprint of what the person reviewed. Any difference is
// a refusal that changes nothing. Every step that writes leaves a recovery point first, and every
// step can be redone: the rescue branch is named from its content, Move keeps a journal in the
// repository's git dir until it finishes, and each file is copied or restored only when it is not
// already where it should be.

// mainCheckoutDeps is what an action needs from the running runner. Tests pass their own.
type mainCheckoutDeps struct {
	// owns reports whether a repo root (realpath) is a checkout this runner's agents work in; the
	// control plane names the root, the machine decides what it will rewrite.
	owns func(root string) bool
	// turnRunning reports whether the session (Orbit or public id) has a turn running now.
	turnRunning func(sessionID string) bool
}

// mainCheckoutStep is a test seam: called after each step that wrote something, it returns true to
// stop the action right there, as a crash would.
var mainCheckoutStep = func(step string) bool { return false }

// errMainCheckoutStopped is what an action stopped by a test seam returns: it answers nothing, as a
// crash would.
var errMainCheckoutStopped = errors.New("stopped by the test seam")

// stoppedMainCheckout marks a commit or push test seam's error as a stop.
func stoppedMainCheckout(err error) error { return fmt.Errorf("%w: %w", errMainCheckoutStopped, err) }

// mainCheckoutSeen holds the requests this process has taken, by id, until their deadline: a
// request delivered again while its first copy runs, or after it was answered, is not run again,
// so each id gets one answer from this process. A runner that restarts forgets them; a request
// redelivered then runs again, and every action's redo path (its journal, or a check that finds
// the work already done) makes that a second run with no second change.
var (
	mainCheckoutSeenMu sync.Mutex
	mainCheckoutSeen   = map[string]string{} // request id → its expiresAt
)

// takeMainCheckoutRequest reports whether id is new to this process, and records it.
func takeMainCheckoutRequest(id, expires string) bool {
	mainCheckoutSeenMu.Lock()
	defer mainCheckoutSeenMu.Unlock()
	for k, at := range mainCheckoutSeen {
		if pastDeadline(at) {
			delete(mainCheckoutSeen, k) // past its deadline a copy is never started anyway
		}
	}
	if _, ok := mainCheckoutSeen[id]; ok {
		return false
	}
	if expires == "" {
		expires = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	}
	mainCheckoutSeen[id] = expires
	return true
}

// handleMainCheckoutRequest answers one heartbeat-delivered read or action. It never starts work
// after the request's deadline: the control plane has finished it with TIMEOUT by then.
func handleMainCheckoutRequest(t *Transport, req MainCheckoutRunnerRequest, deps mainCheckoutDeps) {
	expires := req.ExpiresAt
	if req.Op == "action" && req.Command != nil {
		expires = req.Command.ExpiresAt
	}
	if pastDeadline(expires) {
		logln(fmt.Sprintf("main checkout %s %s: past its deadline %s, not started", req.Op, req.ID, expires))
		return
	}
	if !takeMainCheckoutRequest(req.ID, expires) {
		logln(fmt.Sprintf("main checkout %s %s: delivered again, already taken", req.Op, req.ID))
		return
	}
	switch req.Op {
	case "snapshot":
		answer := readMainCheckoutForRelay(req, deps)
		postWithRetry("main checkout snapshot", func() error { return t.mainCheckoutSnapshot(req.ID, answer) })
	case "action":
		if req.Command == nil {
			logln("main checkout action", req.ID, "has no command")
			return
		}
		res, err := runMainCheckoutAction(*req.Command, deps)
		if err != nil {
			logln(fmt.Sprintf("main checkout %s %s: %v", req.Command.Kind, req.ID, err))
			if errors.Is(err, errMainCheckoutExpired) || errors.Is(err, errMainCheckoutStopped) {
				return // past its deadline (the control plane has finished it), or a test's crash
			}
			res = actionFailedResult(*req.Command, res, err)
		}
		syncManagedVolume("a main checkout action", req.Command.Root)
		postWithRetry("main checkout result", func() error { return t.mainCheckoutResult(req.ID, res) })
	default:
		logln("main checkout request", req.ID, "has an unknown op", req.Op)
	}
}

// actionFailedResult is the ACTION_FAILED answer to an action that failed before it changed
// anything, for a reason no other code names: git's one-line reason, redacted as push's are.
func actionFailedResult(cmd MainCheckoutActionCommand, partial MainCheckoutActionResult, err error) MainCheckoutActionResult {
	r := newMainCheckoutResult(cmd)
	r.Branch = partial.Branch
	var secrets []string
	if root, rerr := mainCheckoutRoot(context.Background(), cmd.Root); rerr == nil {
		r.Root = root
		secrets = remoteURLSecrets(context.Background(), root, "origin")
	}
	r.GitMessage = redactGitMessage(pushReasonLine(err.Error()), secrets)
	return refuseMainCheckout(r, mainCheckoutActionFailed)
}

// pastDeadline reports whether an RFC 3339 deadline has passed ("" never does).
func pastDeadline(at string) bool {
	t, err := time.Parse(time.RFC3339Nano, at)
	return err == nil && time.Now().After(t)
}

// errMainCheckoutExpired is an action whose deadline passed while it waited for the checkout's lock
// (a merge holding it): it is not started, and no result is sent.
var errMainCheckoutExpired = errors.New("its deadline passed while it waited for the checkout")

// postWithRetry posts an answer, a few times: the request is handed out once, so an answer lost
// here leaves the person waiting for the timeout.
func postWithRetry(what string, post func() error) {
	var err error
	for i, wait := range []time.Duration{0, 2 * time.Second, 5 * time.Second} {
		time.Sleep(wait)
		if err = post(); err == nil {
			return
		}
		logln(fmt.Sprintf("%s POST failed (attempt %d): %v", what, i+1, err))
	}
}

// readMainCheckoutForRelay is a snapshot op's answer: the snapshot and the patches asked for.
func readMainCheckoutForRelay(req MainCheckoutRunnerRequest, deps mainCheckoutDeps) MainCheckoutSnapshotAnswer {
	ctx := context.Background()
	root, err := mainCheckoutRoot(ctx, req.Root)
	if err != nil {
		return MainCheckoutSnapshotAnswer{Error: "that checkout is not a git repository on this machine"}
	}
	if deps.owns != nil && !deps.owns(root) {
		return MainCheckoutSnapshotAnswer{Error: "that checkout isn't one this runner works in"}
	}
	scan, err := scanMainCheckout(ctx, root)
	if err != nil {
		return MainCheckoutSnapshotAnswer{Error: firstLine(err.Error())}
	}
	answer := MainCheckoutSnapshotAnswer{Snapshot: &scan.Snapshot}
	for _, p := range req.DiffPaths {
		if d, err := mainCheckoutFileDiff(ctx, root, p); err == nil {
			answer.Diffs = append(answer.Diffs, d)
		}
	}
	return answer
}

// runMainCheckoutAction does one action and returns its contract result. An error means no result
// is to be sent (a kind this runner does not do, a git failure no code names, a deadline passed
// while waiting for the lock, or a test seam).
func runMainCheckoutAction(cmd MainCheckoutActionCommand, deps mainCheckoutDeps) (MainCheckoutActionResult, error) {
	switch cmd.Kind {
	case mainCheckoutMove:
		return moveMainCheckoutFiles(cmd, deps)
	case mainCheckoutRescue:
		return saveAndCleanMainCheckout(cmd, deps)
	case mainCheckoutCommit, mainCheckoutPush:
		if root, err := mainCheckoutRoot(context.Background(), cmd.Root); err != nil || (deps.owns != nil && !deps.owns(root)) {
			r := newMainCheckoutResult(cmd)
			r.GitMessage = "that checkout isn't one this runner works in"
			return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
		}
		if cmd.Kind == mainCheckoutCommit {
			return commitMainCheckout(context.Background(), cmd)
		}
		return pushMainCheckout(context.Background(), cmd)
	default:
		return MainCheckoutActionResult{}, fmt.Errorf("this runner does not do %q yet", cmd.Kind)
	}
}

func newMainCheckoutResult(cmd MainCheckoutActionCommand) MainCheckoutActionResult {
	return MainCheckoutActionResult{RequestID: cmd.RequestID, Kind: cmd.Kind, Root: cmd.Root}
}

func finishMainCheckoutResult(r MainCheckoutActionResult, status, code string) MainCheckoutActionResult {
	r.Status, r.Code = status, code
	r.FinishedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return r
}

func refuseMainCheckout(r MainCheckoutActionResult, code string) MainCheckoutActionResult {
	return finishMainCheckoutResult(r, mainCheckoutRefused, code)
}

// checkMainCheckoutFingerprint refuses when the checkout is no longer what the person reviewed:
// HEAD_MOVED when its HEAD differs, FINGERPRINT_STALE for any other difference. "" when it matches.
func checkMainCheckoutFingerprint(r *MainCheckoutActionResult, want string, scan *mainCheckoutScan) string {
	if want == scan.Snapshot.Fingerprint {
		return ""
	}
	if fingerprintHead(want) != fingerprintHead(scan.Snapshot.Fingerprint) {
		r.Head = scan.Snapshot.Head
		return mainCheckoutHeadMoved
	}
	r.Paths = mainCheckoutChangedSince(want, scan.All)
	return mainCheckoutFingerprintStale
}

// mainCheckoutBlocked reports a checkout in the middle of an operation, or with conflicts: a Move
// would restore paths an operation is holding.
func mainCheckoutBlocked(state string) bool {
	return state != repoStateClean && state != repoStateDirty
}

// ---------------------------------------------------------------------------------------------
// Save & clean

// saveAndCleanMainCheckout is the rescue action: Clean up checkout, widened to a checkout that is
// merely dirty (untracked files included), once its fingerprint matches the review. Nothing is
// cleaned unless the rescue branch exists.
func saveAndCleanMainCheckout(cmd MainCheckoutActionCommand, deps mainCheckoutDeps) (MainCheckoutActionResult, error) {
	r := newMainCheckoutResult(cmd)
	ctx := context.Background()
	root, err := mainCheckoutRoot(ctx, cmd.Root)
	if err != nil || (deps.owns != nil && !deps.owns(root)) {
		r.GitMessage = "that checkout isn't one this runner works in"
		return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
	}
	mergeLock.Lock()
	defer mergeLock.Unlock()
	defer lockMainCheckout(root)()
	if pastDeadline(cmd.ExpiresAt) {
		return r, errMainCheckoutExpired
	}

	scan, err := scanMainCheckout(ctx, root)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
	}
	r.Branch = scan.Snapshot.Branch
	journalPath := rescueJournalPath(root, cmd.RequestID)
	if j := readRescueJournal(journalPath, cmd.RequestID); j != nil && j.Fingerprint == cmd.Fingerprint &&
		scan.Snapshot.Fingerprint != cmd.Fingerprint && scan.Snapshot.Head == j.Head &&
		len(scan.All) == 0 && scan.Snapshot.State == repoStateClean {
		// The same request run again after it cleaned the checkout (a runner restarted before it
		// answered): what it did is the answer.
		n := j.FileCount
		r.FileCount, r.Head, r.RescueBranch = &n, j.Head, j.RescueBranch
		return finishMainCheckoutResult(r, mainCheckoutDone, ""), nil
	}
	if code := checkMainCheckoutFingerprint(&r, cmd.Fingerprint, scan); code != "" {
		return refuseMainCheckout(r, code), nil
	}
	n := len(scan.All)
	r.FileCount = &n
	r.Head = scan.Snapshot.Head
	if scan.Snapshot.Head == "" {
		return refuseMainCheckout(r, mainCheckoutNoHead), nil
	}
	before := inspectRepoRoot(root)
	if n == 0 && before.State == repoStateClean {
		return finishMainCheckoutResult(r, mainCheckoutDone, ""), nil
	}
	if before.State == repoStateClean {
		// inspectRepoRoot does not count untracked files; this action does.
		before.State = repoStateDirty
	}
	if len(before.Paths) == 0 {
		for _, f := range scan.All {
			if len(before.Paths) == repoStatePathCap {
				break
			}
			before.Paths = append(before.Paths, f.Path)
		}
	}
	// The rescue branch is named from the content, so saving here first and again inside the
	// cleanup makes one branch; the journal names it for a redo that finds the checkout cleaned.
	if journalPath != "" {
		if branch, err := rescueWorkingTree(root, before); err == nil {
			_ = writeJSONAtomic(journalPath, rescueJournal{RequestID: cmd.RequestID, Fingerprint: cmd.Fingerprint,
				Head: scan.Snapshot.Head, RescueBranch: branch, FileCount: n})
		}
	}
	out := cleanupRepoRootLocked(root, before)
	r.RescueBranch = out.RescueBranch
	if out.Status != "done" {
		r.GitMessage = clip(firstLine(out.Message), 300)
		r.State = out.State
		return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
	}
	if mainCheckoutStep("rescue-cleaned") {
		return r, errMainCheckoutStopped
	}
	r.Head = headSha(root)
	return finishMainCheckoutResult(r, mainCheckoutDone, ""), nil
}

// rescueJournal is what Save & clean writes before it cleans: a redo of the same request that
// finds the checkout already clean at the same HEAD answers with it instead of FINGERPRINT_STALE.
type rescueJournal struct {
	RequestID    string `json:"requestId"`
	Fingerprint  string `json:"fingerprint"`
	Head         string `json:"head"`
	RescueBranch string `json:"rescueBranch"`
	FileCount    int    `json:"fileCount"`
}

// rescueJournalPath is "" when the git dir can't be read (the action then runs without a journal).
func rescueJournalPath(root, requestID string) string {
	gitDir, err := git(root, "rev-parse", "--absolute-git-dir")
	if err != nil || gitDir == "" || requestID == "" {
		return ""
	}
	return filepath.Join(gitDir, "orbit-main-checkout", "rescue-"+shortHash(requestID)+".json")
}

func readRescueJournal(path, requestID string) *rescueJournal {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var j rescueJournal
	if json.Unmarshal(data, &j) != nil || j.RequestID != requestID {
		return nil
	}
	return &j
}

// ---------------------------------------------------------------------------------------------
// Move

// moveJournal is what a Move writes once its rescue branch exists, and removes when it ends. A
// Move redone with the same requestId while it is there picks up where the first one stopped:
// some files may already be in the target, some already restored in the checkout.
type moveJournal struct {
	RequestID    string   `json:"requestId"`
	Fingerprint  string   `json:"fingerprint"`
	Head         string   `json:"head"`
	RescueCommit string   `json:"rescueCommit"`
	RescueBranch string   `json:"rescueBranch"`
	Files        []string `json:"files"`
}

func moveJournalPath(root, requestID string) (string, error) {
	dir, err := git(root, "rev-parse", "--git-common-dir")
	if err != nil || dir == "" {
		return "", fmt.Errorf("git dir: %s", gitStderr(err))
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	sum := sha256.Sum256([]byte(requestID))
	return filepath.Join(dir, "orbit-main-checkout", "move-"+hex.EncodeToString(sum[:])[:24]+".json"), nil
}

func readMoveJournal(path string) *moveJournal {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var j moveJournal
	if json.Unmarshal(data, &j) != nil || j.RescueCommit == "" {
		return nil
	}
	return &j
}

func writeMoveJournal(path string, j moveJournal) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// treeEntry is one path of a tree: its mode and blob.
type treeEntry struct{ mode, blob string }

// lsTree lists paths of rev, keyed by path; absent paths are not in the map.
func lsTree(dir, rev string, paths []string) (map[string]treeEntry, error) {
	out := map[string]treeEntry{}
	for len(paths) > 0 {
		chunk := paths[:min(len(paths), 500)]
		paths = paths[len(chunk):]
		raw, err := mcGit(context.Background(), dir, nil, append([]string{"ls-tree", "-z", "--full-tree", rev, "--"}, chunk...)...)
		if err != nil {
			return nil, fmt.Errorf("git ls-tree %s: %w", shortSha(rev), err)
		}
		for _, rec := range splitZ(raw) {
			meta, p, ok := strings.Cut(rec, "\t")
			if f := strings.Fields(meta); ok && len(f) == 3 {
				out[p] = treeEntry{mode: f[0], blob: f[2]}
			}
		}
	}
	return out, nil
}

// movePlanItem is what the target gets for one path.
type movePlanItem struct {
	path   string
	skip   bool   // the target already holds the source's content
	remove bool   // the source deleted it
	mode   string // 100644, 100755 or 120000 when written
	data   []byte // the content written
}

// moveMainCheckoutFiles is the Move action:
//
//  1. check the fingerprint (or, redoing a Move that stopped part way, its journal);
//  2. save the whole checkout to orbit/rescue-* (rescueWorkingTree) and write the journal;
//  3. work out every file's 3-way result against the target worktree — base: the checkout's
//     HEAD, ours: the target's file, theirs: the saved content — and refuse with MOVE_CONFLICT,
//     before writing anything, if any one of them does not merge cleanly;
//  4. write the results into the target worktree;
//  5. re-read the moved paths in the checkout: any that changed since the save keep the source
//     untouched, and the result is the partial MOVE_SOURCE_CHANGED (copied, not cleared);
//  6. restore only those paths in the checkout: `checkout HEAD --` for those HEAD has, delete the
//     ones it does not (untracked or newly added).
//
// Step 3 does the 3-way per file with `git merge-file` rather than `git apply --3way --check`:
// in git 2.47 that check passes a patch whose hunks conflict ("Applied patch … with conflicts",
// exit 0), so it cannot keep the "a conflict touches neither side" promise, and --3way implies
// --index, which refuses every path the target has uncommitted changes in.
func moveMainCheckoutFiles(cmd MainCheckoutActionCommand, deps mainCheckoutDeps) (MainCheckoutActionResult, error) {
	r := newMainCheckoutResult(cmd)
	r.TargetSessionID, r.TargetBranch = cmd.TargetSessionID, cmd.TargetBranch
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

	busy := func() bool { return deps.turnRunning != nil && deps.turnRunning(cmd.TargetSessionID) }
	if busy() {
		return refuseMainCheckout(r, mainCheckoutTargetBusy), nil
	}
	target, err := worktreeOfBranch(root, cmd.TargetBranch)
	if err != nil {
		// The session's checkout is not on this machine (reclaimed while it was idle): nothing
		// can receive the files until its next turn brings it back.
		r.GitMessage = firstLine(err.Error())
		return refuseMainCheckout(r, mainCheckoutTargetBusy), nil
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
	journalPath, err := moveJournalPath(root, cmd.RequestID)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
	}
	files := append([]string(nil), cmd.Files...)
	sort.Strings(files)
	n := len(files)
	r.FileCount = &n

	changed := map[string]MainCheckoutFile{}
	for _, f := range scan.All {
		changed[f.Path] = f
	}
	var rescueCommit string
	journal := readMoveJournal(journalPath)
	redo := journal != nil && journal.Fingerprint == cmd.Fingerprint
	if redo {
		// The same Move, stopped part way. Not the fingerprint: the files it already restored
		// changed it. Each path is checked against the saved content in step 5 instead.
		if journal.Head != scan.Snapshot.Head {
			_ = os.Remove(journalPath)
			r.Head = scan.Snapshot.Head
			return refuseMainCheckout(r, mainCheckoutHeadMoved), nil
		}
		rescueCommit, r.RescueBranch = journal.RescueCommit, journal.RescueBranch
		files = journal.Files
		n = len(files)
		// A rescue branch deleted since is put back: it is the copy the result line names.
		_, _ = git(root, "update-ref", "refs/heads/"+r.RescueBranch, rescueCommit, "")
	} else {
		if code := checkMainCheckoutFingerprint(&r, cmd.Fingerprint, scan); code != "" {
			return refuseMainCheckout(r, code), nil
		}
		var missing []string
		for _, p := range files {
			if _, ok := changed[p]; !ok {
				missing = append(missing, p)
			}
		}
		if len(files) == 0 || len(missing) > 0 {
			r.Paths = missing
			return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
		}
		state := repoRootState{State: scan.Snapshot.State, Paths: files}
		branch, err := rescueWorkingTree(root, state)
		if err != nil || branch == "" {
			if err != nil {
				r.GitMessage = firstLine(err.Error())
			}
			return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
		}
		r.RescueBranch = branch
		rescueCommit, _ = git(root, "rev-parse", "refs/heads/"+branch)
		if mainCheckoutStep("rescued") {
			return r, errMainCheckoutStopped
		}
		// What was saved must be what was reviewed: a file written between the scan and the save
		// is drift before anything was copied, so nothing is.
		saved, err := lsTree(root, rescueCommit, files)
		if err != nil {
			r.GitMessage = firstLine(err.Error())
			return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
		}
		var drift []string
		for _, p := range files {
			want := changed[p].ContentHash
			if e, ok := saved[p]; (ok && e.blob != want) || (!ok && want != "-") {
				drift = append(drift, p)
			}
		}
		if len(drift) > 0 {
			r.Paths = drift
			return refuseMainCheckout(r, mainCheckoutFingerprintStale), nil
		}
		if err := writeMoveJournal(journalPath, moveJournal{RequestID: cmd.RequestID, Fingerprint: cmd.Fingerprint,
			Head: scan.Snapshot.Head, RescueCommit: rescueCommit, RescueBranch: branch, Files: files}); err != nil {
			r.GitMessage = firstLine(err.Error())
			return refuseMainCheckout(r, mainCheckoutRescueFailed), nil
		}
		if mainCheckoutStep("journaled") {
			return r, errMainCheckoutStopped
		}
	}
	// Every refusal from here on ends the Move: its journal goes, the rescue branch stays.
	refuse := func(code string) (MainCheckoutActionResult, error) {
		_ = os.Remove(journalPath)
		return refuseMainCheckout(r, code), nil
	}

	head := scan.Snapshot.Head
	base, err := lsTree(root, head, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutRescueFailed)
	}
	theirs, err := lsTree(root, rescueCommit, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutRescueFailed)
	}
	plan, conflicts, err := planMove(ctx, root, target, files, base, theirs)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutMoveConflict)
	}
	if len(conflicts) > 0 {
		r.Paths = conflicts
		return refuse(mainCheckoutMoveConflict)
	}
	if busy() {
		return refuse(mainCheckoutTargetBusy)
	}
	for i, item := range plan {
		if err := applyMoveItem(target, item); err != nil {
			// Files already written stay: they are the source's content, the source is untouched,
			// and a redo finds them in place. The person sees the reason and can try again.
			r.GitMessage = firstLine(err.Error())
			r.Paths = []string{item.path}
			return refuse(mainCheckoutMoveConflict)
		}
		if i == 0 && mainCheckoutStep("target-partial") {
			return r, errMainCheckoutStopped
		}
	}
	if mainCheckoutStep("copied") {
		return r, errMainCheckoutStopped
	}

	// Step 5: every moved path must still hold what was saved (not yet restored) or, on a redo,
	// HEAD's content (restored before the stop). Anything else is somebody's newer write.
	now, err := mainCheckoutHashes(ctx, root, files)
	if err != nil {
		r.GitMessage = firstLine(err.Error())
		return refuse(mainCheckoutMoveSourceChanged)
	}
	var drift, restoreTracked, restoreNew []string
	for _, p := range files {
		cur, onDisk := now[p]
		saved, inSaved := theirs[p]
		headEntry, inHead := base[p]
		switch {
		case onDisk == inSaved && (!onDisk || cur == saved.blob):
			if inHead {
				restoreTracked = append(restoreTracked, p)
			} else {
				restoreNew = append(restoreNew, p)
			}
		case redo && onDisk == inHead && (!onDisk || cur == headEntry.blob):
			// restored before the stop
		default:
			drift = append(drift, p)
		}
	}
	if len(drift) > 0 {
		r.Paths = drift
		_ = os.Remove(journalPath)
		return finishMainCheckoutResult(r, mainCheckoutPartial, mainCheckoutMoveSourceChanged), nil
	}

	// Step 6: only these paths, nothing else in the checkout.
	for len(restoreTracked) > 0 {
		chunk := restoreTracked[:min(len(restoreTracked), 200)]
		restoreTracked = restoreTracked[len(chunk):]
		if _, err := gitEnv(root, append(os.Environ(), "GIT_LITERAL_PATHSPECS=1"),
			append([]string{"checkout", "HEAD", "--"}, chunk...)...); err != nil {
			r.GitMessage = firstLine(gitStderr(err))
			r.Paths = chunk
			_ = os.Remove(journalPath)
			return finishMainCheckoutResult(r, mainCheckoutPartial, mainCheckoutMoveSourceChanged), nil
		}
	}
	if mainCheckoutStep("restored-tracked") {
		return r, errMainCheckoutStopped
	}
	for _, p := range restoreNew {
		_, _ = gitEnv(root, append(os.Environ(), "GIT_LITERAL_PATHSPECS=1"), "rm", "--cached", "--quiet", "--ignore-unmatch", "--", p)
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			r.GitMessage = firstLine(err.Error())
			r.Paths = []string{p}
			_ = os.Remove(journalPath)
			return finishMainCheckoutResult(r, mainCheckoutPartial, mainCheckoutMoveSourceChanged), nil
		}
		removeEmptyParents(root, filepath.Dir(abs))
	}
	_ = os.Remove(journalPath)
	if after, err := scanMainCheckout(ctx, root); err == nil {
		left := len(after.All)
		r.Remaining = &left
	}
	logln(fmt.Sprintf("main checkout %s: moved %d file(s) into %s; rescue branch %s", root, n, target, r.RescueBranch))
	return finishMainCheckoutResult(r, mainCheckoutDone, ""), nil
}

// worktreeOfBranch is the worktree of root's repository that has branch checked out.
func worktreeOfBranch(root, branch string) (string, error) {
	if branch == "" {
		return "", errors.New("the target session has no branch")
	}
	out, err := git(root, "worktree", "list", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("git worktree list: %s", gitStderr(err))
	}
	path := ""
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			path = strings.TrimPrefix(line, "worktree ")
		case line == "branch refs/heads/"+branch && path != "":
			if real, err := filepath.EvalSymlinks(path); err == nil {
				path = real
			}
			if path == root {
				return "", fmt.Errorf("%s is the main checkout's own branch", branch)
			}
			if _, err := os.Stat(path); err != nil {
				return "", fmt.Errorf("the worktree of %s is not on this machine", branch)
			}
			return path, nil
		}
	}
	return "", fmt.Errorf("no worktree has %s checked out on this machine", branch)
}

// planMove works out what the target gets for each path, or which paths conflict, writing nothing.
func planMove(ctx context.Context, root, target string, files []string, base, theirs map[string]treeEntry) ([]movePlanItem, []string, error) {
	ours, err := mainCheckoutHashes(ctx, target, files)
	if err != nil {
		return nil, nil, err
	}
	var plan []movePlanItem
	var conflicts []string
	for _, p := range files {
		b, inBase := base[p]
		t, inTheirs := theirs[p]
		o, inOurs := ours[p]
		abs := filepath.Join(target, filepath.FromSlash(p))
		if info, err := os.Lstat(abs); err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			conflicts = append(conflicts, p) // a directory stands where the file goes
			continue
		}
		if inTheirs && t.mode == "160000" {
			conflicts = append(conflicts, p) // a nested repository is not a file to copy
			continue
		}
		oursMode := ""
		if inOurs {
			oursMode = fileMode(abs)
		}
		switch {
		case inOurs == inTheirs && (!inOurs || (o == t.blob && oursMode == t.mode)):
			plan = append(plan, movePlanItem{path: p, skip: true})
		case inOurs == inBase && (!inOurs || o == b.blob):
			// The target has HEAD's version (or neither has it): take the source's as it is.
			if !inTheirs {
				plan = append(plan, movePlanItem{path: p, remove: true})
				continue
			}
			data, err := catBlob(root, t.blob, p)
			if err != nil {
				return nil, nil, err
			}
			plan = append(plan, movePlanItem{path: p, mode: t.mode, data: data})
		case inOurs && inTheirs && o == t.blob:
			// Same content, only the mode differs: the source's mode.
			data, err := os.ReadFile(abs)
			if err != nil {
				return nil, nil, err
			}
			plan = append(plan, movePlanItem{path: p, mode: t.mode, data: data})
		case !inOurs || !inTheirs || t.mode == "120000" || oursMode == "120000":
			conflicts = append(conflicts, p) // deleted on one side, changed on the other; or a link
		default:
			merged, ok, err := mergeFile3(root, abs, p, b, inBase, t)
			if err != nil {
				return nil, nil, err
			}
			if !ok {
				conflicts = append(conflicts, p)
				continue
			}
			plan = append(plan, movePlanItem{path: p, mode: t.mode, data: merged})
		}
	}
	return plan, conflicts, nil
}

// fileMode is a working-tree file's git mode.
func fileMode(abs string) string {
	info, err := os.Lstat(abs)
	switch {
	case err != nil:
		return ""
	case info.Mode()&os.ModeSymlink != 0:
		return "120000"
	case info.Mode()&0o111 != 0:
		return "100755"
	default:
		return "100644"
	}
}

// catBlob is a blob's content as a checkout of path would write it (smudge filters applied).
func catBlob(root, blob, path string) ([]byte, error) {
	out, err := mcGit(context.Background(), root, nil, "cat-file", "--filters", "--path="+path, blob)
	if err != nil {
		return nil, fmt.Errorf("git cat-file %s: %w", shortSha(blob), err)
	}
	return out, nil
}

// mergeFile3 merges the source's change (base → theirs) into the target's file. ok is false when
// the two touch the same lines, or either side is binary.
func mergeFile3(root, oursPath, path string, base treeEntry, inBase bool, theirs treeEntry) ([]byte, bool, error) {
	dir, err := os.MkdirTemp("", "orbit-move-merge-*")
	if err != nil {
		return nil, false, err
	}
	defer os.RemoveAll(dir)
	var baseData []byte
	if inBase {
		if baseData, err = catBlob(root, base.blob, path); err != nil {
			return nil, false, err
		}
	}
	theirData, err := catBlob(root, theirs.blob, path)
	if err != nil {
		return nil, false, err
	}
	ourData, err := os.ReadFile(oursPath)
	if err != nil {
		return nil, false, err
	}
	for _, d := range [][]byte{baseData, theirData, ourData} {
		if bytes.IndexByte(d[:min(len(d), 8000)], 0) >= 0 {
			return nil, false, nil
		}
	}
	names := []string{filepath.Join(dir, "ours"), filepath.Join(dir, "base"), filepath.Join(dir, "theirs")}
	for i, d := range [][]byte{ourData, baseData, theirData} {
		if err := os.WriteFile(names[i], d, 0o600); err != nil {
			return nil, false, err
		}
	}
	c := exec.Command("git", append([]string{"merge-file", "-p", "--quiet"}, names...)...)
	c.Dir = root
	var out bytes.Buffer
	c.Stdout = &out
	if err := c.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, false, nil // conflicts (or a file git will not merge)
		}
		return nil, false, err
	}
	return out.Bytes(), true, nil
}

// applyMoveItem writes one planned path into the target worktree (atomically per file).
func applyMoveItem(target string, item movePlanItem) error {
	if item.skip {
		return nil
	}
	abs := filepath.Join(target, filepath.FromSlash(item.path))
	if item.remove {
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return err
		}
		removeEmptyParents(target, filepath.Dir(abs))
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(abs), ".orbit-move-"+filepath.Base(abs))
	_ = os.Remove(tmp)
	if item.mode == "120000" {
		if err := os.Symlink(string(item.data), tmp); err != nil {
			return err
		}
	} else {
		perm := os.FileMode(0o644)
		if item.mode == "100755" {
			perm = 0o755
		}
		if err := os.WriteFile(tmp, item.data, perm); err != nil {
			return err
		}
		_ = os.Chmod(tmp, perm) // past the umask
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// removeEmptyParents removes dir and its parents while they are empty, stopping at stop.
func removeEmptyParents(stop, dir string) {
	for dir != stop && strings.HasPrefix(dir, stop+string(filepath.Separator)) {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

// runnerOwnsCheckout reports whether root (a realpath) is the checkout of one of dirs.
func runnerOwnsCheckout(dirs []agentWorkDir, root string) bool {
	for _, d := range dirs {
		if d.Dir == "" {
			continue
		}
		if r, err := mainCheckoutRoot(context.Background(), d.Dir); err == nil && r == root {
			return true
		}
	}
	return false
}
