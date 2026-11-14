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
	"strings"
	"time"
)

// Commit in the main checkout (docs/main-checkout-git-contract.md §5 "commit"): the chosen files'
// reviewed working-tree content, and nothing else, becomes one commit on the checkout's branch.
//
//	check state and fingerprint → temporary index = HEAD + the chosen files' blobs → commit-tree
//	→ update-ref with the expected old HEAD → align the real index's chosen paths to the new HEAD.
//
// Unchosen staged, unstaged and untracked content is never read into the commit and never touched.
// Every refusal happens before anything is written that a person could see.
//
// Crash safety: a journal under the git dir, keyed by requestId, holds the old HEAD and the commit
// date. A redo with HEAD still at the old HEAD rebuilds byte-for-byte the same commit (same tree,
// parent, message, identity and date), so git already has it and the branch gets one commit; a
// redo that finds the branch already at the journal's commit skips straight to aligning the index.

// mainCheckoutCommitStep is called after each step that writes; a test returns an error to stop
// there, as a crash would.
var mainCheckoutCommitStep = func(step string) error { return nil }

// mainCheckoutCommitJournal is what a redo of the same request needs.
type mainCheckoutCommitJournal struct {
	RequestID string `json:"requestId"`
	Branch    string `json:"branch"`
	OldHead   string `json:"oldHead"`
	Date      string `json:"date"`
	Commit    string `json:"commit,omitempty"`
}

const zeroOID = "0000000000000000000000000000000000000000"

// mcGitEnv is mcGit with extra environment (a temporary GIT_INDEX_FILE, fixed commit dates).
func mcGitEnv(ctx context.Context, root string, env []string, stdin []byte, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root, "-c", "core.quotePath=false"}, args...)...)
	cmd.Env = append(append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_LITERAL_PATHSPECS=1"), env...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	return out, gitFailure(err)
}

func mcTrim(out []byte, err error) (string, error) {
	return strings.TrimSpace(string(out)), err
}

// commitMainCheckout runs one commit action. A refusal is a result with status refused and nothing
// changed; an error is a git failure the codes don't name (no identity, a full disk, …).
func commitMainCheckout(ctx context.Context, cmd MainCheckoutActionCommand) (MainCheckoutActionResult, error) {
	res := MainCheckoutActionResult{RequestID: cmd.RequestID, Kind: mainCheckoutCommit, Root: cmd.Root}
	message := strings.TrimSpace(strings.ReplaceAll(cmd.Message, "\r\n", "\n"))
	if message == "" {
		return res, errors.New("commit: the message is blank")
	}
	if len(cmd.Files) == 0 {
		return res, errors.New("commit: no files chosen")
	}
	chosen := map[string]bool{}
	for _, p := range cmd.Files {
		if !validMainCheckoutPath(p) {
			return res, fmt.Errorf("commit: not a path inside the checkout: %q", p)
		}
		chosen[p] = true
	}

	root, err := mainCheckoutRoot(ctx, cmd.Root)
	if err != nil {
		return res, err
	}
	res.Root = root
	defer lockMainCheckout(root)()
	if pastDeadline(cmd.ExpiresAt) {
		return res, errMainCheckoutExpired
	}

	finish := func(r MainCheckoutActionResult) (MainCheckoutActionResult, error) {
		r.FinishedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		return r, nil
	}
	refuse := func(code string) (MainCheckoutActionResult, error) {
		res.Status, res.Code = mainCheckoutRefused, code
		return finish(res)
	}

	gitDir, err := mcTrim(mcGit(ctx, root, nil, "rev-parse", "--absolute-git-dir"))
	if err != nil {
		return res, err
	}
	journalPath := filepath.Join(gitDir, "orbit-main-checkout", "commit-"+shortHash(cmd.RequestID)+".json")
	journal := readCommitJournal(journalPath, cmd.RequestID)

	branch, _ := mcTrim(mcGit(ctx, root, nil, "symbolic-ref", "--quiet", "--short", "HEAD"))
	res.Branch = branch
	head := mainCheckoutHead(ctx, root)

	done := func(commit string) (MainCheckoutActionResult, error) {
		if err := alignMainCheckoutIndex(ctx, root, commit, cmd.Files); err != nil {
			// The commit is on the branch, so the answer is that it was made: ACTION_FAILED would say
			// the checkout was left as it was. The chosen paths' index entries still show the old
			// HEAD; their working-tree content is untouched, and a redo of this request realigns them.
			logln(fmt.Sprintf("main checkout %s: commit %s made; aligning the index failed: %v", root, shortSha(commit), err))
		}
		if err := mainCheckoutCommitStep("index-align"); err != nil {
			return res, stoppedMainCheckout(err)
		}
		res.Status, res.Head, res.Subject = mainCheckoutDone, commit, strings.SplitN(message, "\n", 2)[0]
		n := len(cmd.Files)
		res.FileCount = &n
		return finish(res)
	}

	// A redo after update-ref went through: the branch is already at this request's commit.
	if journal != nil && journal.Commit != "" && branch == journal.Branch && head == journal.Commit {
		return done(journal.Commit)
	}

	if state := mainCheckoutState(ctx, root, false); state != repoStateClean {
		res.State = state
		return refuse(mainCheckoutCheckoutBlocked)
	}
	if branch == "" {
		return refuse(mainCheckoutDetached)
	}
	if head == "" {
		return refuse(mainCheckoutNoHead)
	}

	all, err := mainCheckoutChangedFiles(ctx, root, head)
	if err != nil {
		return res, err
	}
	if fp := mainCheckoutFingerprint(head, all); fp != cmd.Fingerprint {
		if fingerprintHead(cmd.Fingerprint) != head {
			res.Head = head
			return refuse(mainCheckoutHeadMoved)
		}
		res.Paths = mainCheckoutChangedSince(cmd.Fingerprint, all)
		return refuse(mainCheckoutFingerprintStale)
	}
	reviewed := map[string]MainCheckoutFile{}
	for _, f := range all {
		if chosen[f.Path] {
			reviewed[f.Path] = f
		}
	}
	var missing []string
	for _, p := range cmd.Files {
		if _, ok := reviewed[p]; !ok {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		res.Paths = missing
		return refuse(mainCheckoutFingerprintStale)
	}

	// Write each chosen file's blob and check it is still the content that was reviewed.
	entries, stale, err := mainCheckoutCommitEntries(ctx, root, head, cmd.Files, reviewed)
	if err != nil {
		return res, err
	}
	if len(stale) > 0 {
		res.Paths = stale
		return refuse(mainCheckoutFingerprintStale)
	}

	if journal == nil || journal.OldHead != head || journal.Branch != branch {
		journal = &mainCheckoutCommitJournal{
			RequestID: cmd.RequestID, Branch: branch, OldHead: head,
			Date: fmt.Sprintf("%d +0000", time.Now().Unix()),
		}
	}
	journal.Commit = ""
	if err := writeCommitJournal(journalPath, journal); err != nil {
		return res, err
	}

	tree, err := mainCheckoutTree(ctx, root, gitDir, head, entries)
	if err != nil {
		return res, err
	}
	dates := []string{"GIT_AUTHOR_DATE=" + journal.Date, "GIT_COMMITTER_DATE=" + journal.Date}
	commit, err := mcTrim(mcGitEnv(ctx, root, dates, []byte(message+"\n"), "commit-tree", tree, "-p", head, "-F", "-"))
	if err != nil {
		return res, err
	}
	if err := mainCheckoutCommitStep("commit-tree"); err != nil {
		return res, stoppedMainCheckout(err)
	}
	journal.Commit = commit
	if err := writeCommitJournal(journalPath, journal); err != nil {
		return res, err
	}

	if _, err := mcGit(ctx, root, nil, "update-ref", "-m", "orbit: commit in the main checkout",
		"refs/heads/"+branch, commit, head); err != nil {
		now, _ := mcTrim(mcGit(ctx, root, nil, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch))
		if now != head {
			res.Head = now
			return refuse(mainCheckoutHeadMoved)
		}
		return res, err
	}
	if err := mainCheckoutCommitStep("update-ref"); err != nil {
		return res, stoppedMainCheckout(err)
	}
	return done(commit)
}

// fingerprintHead is the HEAD part of an "mc1:<head>:<hash>" fingerprint, "" for "-".
func fingerprintHead(fp string) string {
	parts := strings.SplitN(fp, ":", 3)
	if len(parts) != 3 || parts[1] == "-" {
		return ""
	}
	return parts[1]
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:24]
}

func readCommitJournal(path, requestID string) *mainCheckoutCommitJournal {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var j mainCheckoutCommitJournal
	if json.Unmarshal(data, &j) != nil || j.RequestID != requestID {
		return nil
	}
	return &j
}

// writeCommitJournal replaces the journal atomically.
func writeCommitJournal(path string, j *mainCheckoutCommitJournal) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.Marshal(j)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// mainCheckoutCommitEntries is one `update-index --index-info -z` record per chosen path: its
// working-tree mode and blob (written now), or a removal for a deleted file. A path whose content
// is no longer the reviewed ContentHash is returned in stale instead.
func mainCheckoutCommitEntries(ctx context.Context, root, head string, paths []string, reviewed map[string]MainCheckoutFile) ([]byte, []string, error) {
	fileMode := true
	if out, err := mcTrim(mcGit(ctx, root, nil, "config", "--bool", "core.fileMode")); err == nil && out == "false" {
		fileMode = false
	}
	headModes := map[string]string{}
	if out, err := mcGit(ctx, root, nil, append([]string{"ls-tree", "-z", head, "--"}, paths...)...); err == nil {
		for _, rec := range splitZ(out) {
			if meta, p, ok := strings.Cut(rec, "\t"); ok {
				if f := strings.Fields(meta); len(f) == 3 {
					headModes[p] = f[0]
				}
			}
		}
	}
	var buf bytes.Buffer
	var stale []string
	for _, p := range paths {
		f := reviewed[p]
		abs := filepath.Join(root, filepath.FromSlash(p))
		info, err := os.Lstat(abs)
		if f.Status == "D" {
			if err == nil {
				stale = append(stale, p)
				continue
			}
			fmt.Fprintf(&buf, "0 %s\t%s\x00", zeroOID, p)
			continue
		}
		if err != nil {
			stale = append(stale, p)
			continue
		}
		var mode, oid string
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(abs)
			if err != nil {
				stale = append(stale, p)
				continue
			}
			mode = "120000"
			if oid, err = mcTrim(mcGit(ctx, root, []byte(target), "hash-object", "-w", "--stdin")); err != nil {
				return nil, nil, err
			}
		case info.IsDir():
			// A submodule or nested repository is recorded as the commit it is on.
			mode = "160000"
			if oid, err = mcTrim(mcGit(ctx, abs, nil, "rev-parse", "--verify", "--quiet", "HEAD")); err != nil {
				stale = append(stale, p)
				continue
			}
		default:
			mode = "100644"
			if fileMode && info.Mode()&0o111 != 0 {
				mode = "100755"
			} else if !fileMode && headModes[p] == "100755" {
				mode = "100755"
			}
			if oid, err = mcTrim(mcGit(ctx, root, nil, "hash-object", "-w", "--", p)); err != nil {
				return nil, nil, err
			}
		}
		if oid != f.ContentHash {
			stale = append(stale, p)
			continue
		}
		fmt.Fprintf(&buf, "%s %s\t%s\x00", mode, oid, p)
	}
	return buf.Bytes(), stale, nil
}

// mainCheckoutTree writes the tree of HEAD with entries applied, through a temporary index, so
// the real index is not read or written.
func mainCheckoutTree(ctx context.Context, root, gitDir, head string, entries []byte) (string, error) {
	f, err := os.CreateTemp(gitDir, "orbit-main-checkout-commit-*.index")
	if err != nil {
		return "", err
	}
	index := f.Name()
	f.Close()
	os.Remove(index) // read-tree creates it; an empty file is not a valid index
	defer os.Remove(index)
	defer os.Remove(index + ".lock")
	env := []string{"GIT_INDEX_FILE=" + index}
	if _, err := mcGitEnv(ctx, root, env, nil, "read-tree", head); err != nil {
		return "", err
	}
	if _, err := mcGitEnv(ctx, root, env, entries, "update-index", "-z", "--index-info"); err != nil {
		return "", err
	}
	return mcTrim(mcGitEnv(ctx, root, env, nil, "write-tree"))
}

// alignMainCheckoutIndex sets the real index's entries for paths to commit's, so the committed
// paths read clean; every other entry keeps what it held. A person's git holding index.lock is
// waited for briefly.
func alignMainCheckoutIndex(ctx context.Context, root, commit string, paths []string) error {
	spec := []byte(strings.Join(paths, "\x00") + "\x00")
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 200 * time.Millisecond):
			}
		}
		if _, err = mcGit(ctx, root, spec, "reset", "-q", commit, "--pathspec-from-file=-", "--pathspec-file-nul"); err == nil {
			return nil
		}
	}
	return err
}
