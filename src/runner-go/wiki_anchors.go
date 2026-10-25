package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// An entry's anchors, checked with git (contracts/wiki.contract.json `anchorRules.verify`, design §4.4): what
// the anchors repository operation answers with (wiki_repo_ops.go), and the fetch every repository operation
// makes first.
//
// GIT RUNS HERE, AND ONLY HERE. An entry's anchors say what in the repository has to stay true for it
// to hold — a path, a symbol, a commit — and the only place that can check them is a checkout: the
// API server runs no git. So the server asks this machine to fetch origin's main into the runner's own
// checkout of the space's repository and to check the anchors it names on one commit, and reports what
// git said. The server does the rest: it keeps each anchor's last check, takes an entry whose anchor moved
// or went out of the push at once, and files a challenge in the owner's Review.
//
// WHAT EACH CHECK IS. A path: `git cat-file -e <ref>:<path>`. A symbol: `git grep -n -w -F -I` finds
// the first line the symbol occurs on as a whole word, and the sha256 of that line and the ones after
// it (wikiAnchorSymbolRegionLines in all) is compared with the hash the symbol is held to — the server
// holds it there too, so a region that moved reads changed whatever this side thought. A commit: `git
// merge-base --is-ancestor <sha> <ref>`, and a sha that is not an ancestor of origin/main — or one this
// repository does not have — is missing, because a sha that is not on main poisons what depends on it.
//
// ONLY WHAT GIT SAID. An anchor git could not check — git failed, not the anchor — is an error rather
// than a state, and the anchor keeps its last check until a run that can check it. A fetch that fails
// checks nothing at all: a check against a stale origin/main would be a claim about a commit nobody asked
// about.

// The contract's numbers this side needs (`anchorRules.verify.rules`).
const (
	// A symbol's region: the line it is found on and the lines after it, this many in all.
	wikiAnchorSymbolRegionLines = 20
	// A fetch of origin's main may cross a slow network; one git command on the checkout may not.
	wikiAnchorFetchTimeout = 5 * time.Minute
	wikiAnchorGitTimeout   = 2 * time.Minute
	// How long a git command's output may stay open after git exited, held by a process it started.
	wikiAnchorGitWaitDelay = 2 * time.Second
)

// wikiAnchorsVerifyRefspec is what the fetch asks for: origin's main, into origin/main, whatever the
// checkout's own configured refspecs are.
const wikiAnchorsVerifyRefspec = "+refs/heads/main:refs/remotes/origin/main"

var wikiCommitSha = regexp.MustCompile(`^[0-9a-f]{40}$`)

// wikiDueAnchor is one git anchor and its place in the entry's list. RegionSha256 is the hash a
// symbol is held to, empty before its first check found one.
type wikiDueAnchor struct {
	Index        int    `json:"index"`
	Type         string `json:"type"`
	Path         string `json:"path"`
	Symbol       string `json:"symbol"`
	Sha          string `json:"sha"`
	RegionSha256 string `json:"regionSha256"`
}

// wikiAnchorCheck is one anchor's check as the anchors operation answers it.
type wikiAnchorCheck struct {
	Index        int    `json:"index"`
	Type         string `json:"type"`
	State        string `json:"state"`
	RegionSha256 string `json:"regionSha256,omitempty"`
}

// The wiki fetch lock (fetchWikiOriginMain): a file in the repository's git directory, and how often a
// fetch waiting for it looks again.
const (
	wikiFetchLockName = "orbit-wiki-fetch.lock"
	wikiFetchLockPoll = 50 * time.Millisecond
)

// wikiFetchLockWait is the longest a fetch waits for another wiki fetch of the same checkout. A fetch
// takes seconds, so a minute is one that is stuck, and the server waits five for the whole operation
// (repoWaitSeconds). A variable only so a test can outwait a held lock in less than a minute.
var wikiFetchLockWait = time.Minute

// fetchWikiOriginMain fetches origin's main into refs/remotes/origin/main — the one fetch the wiki makes
// of a checkout: the runner's repository operations (wikiRepoOpCheckout). An error is git's own words; the
// caller says what it means.
//
// THE FAILURE THIS EXISTS FOR (2026-10-09, the canary's docs build 79620f23). A fetch updates
// refs/remotes/origin/main only from the value it read when it began. Two fetches of one checkout that
// both began before main moved both read the old value, the first writes the new one, and the second is
// refused —
//
//	error: cannot lock ref 'refs/remotes/origin/main': is at 6c9cebd4d… but expected 8fcd5b3c7…
//
// — a read lost over a race that says nothing about the repository. Two answers, one for each kind of
// fetch that can be in the way:
//
//   - The wiki's own fetches of a checkout take turns: an flock on wikiFetchLockName in the repository's
//     git directory, which every repository operation the runner runs takes. It is waited for at most
//     wikiFetchLockWait; past that this fetch goes ahead without it, because a fetch stuck on the network
//     holds it until its own timeout, and every operation queued behind it would spend the server's whole
//     wait there.
//   - Every other fetch of the checkout — a session starting, an integration job, the person at the
//     keyboard — takes no such lock, and is waited out the way integrationFetch waits it out: git refused
//     the ref's lock, so the same fetch is tried again.
//
// --no-auto-maintenance: the fetch starts no maintenance in a checkout it only reads. Git's own after a
// fetch is a detached process that holds the fetch's output for a moment after the fetch has exited —
// a moment as long as a loaded machine makes it (wikiAnchorGit).
func fetchWikiOriginMain(repo string) error {
	if common := gitCommonDir(repo); common != "" {
		if release, held := acquireWikiFetchLock(filepath.Join(common, wikiFetchLockName), wikiFetchLockWait); held {
			defer release()
		}
	}
	for attempt := 1; ; attempt++ {
		_, code, stderr, err := wikiAnchorGit(repo, wikiAnchorFetchTimeout, "fetch", "--quiet", "--no-tags", "--no-auto-maintenance", "origin", wikiAnchorsVerifyRefspec)
		if err == nil && code == 0 {
			return nil
		}
		if err != nil || !strings.Contains(stderr, "cannot lock ref") || attempt == integrationFetchLockAttempts {
			return errors.New(firstNonEmpty(strings.TrimSpace(stderr), errString(err), fmt.Sprintf("git fetch exited %d", code)))
		}
		integrationFetchLockPause(integrationFetchLockWait << (attempt - 1))
	}
}

// ── The three checks ────────────────────────────────────────────────────────────────────────────

// checkWikiAnchor checks one anchor on ref. An error is git failing, never the anchor failing: an
// anchor that is not there is `missing`, and that is an answer.
func checkWikiAnchor(repo, ref string, anchor wikiDueAnchor) (wikiAnchorCheck, error) {
	check := wikiAnchorCheck{Index: anchor.Index, Type: anchor.Type}
	var err error
	switch anchor.Type {
	case "path":
		check.State, err = checkWikiPathAnchor(repo, ref, anchor.Path)
	case "symbol":
		check.State, check.RegionSha256, err = checkWikiSymbolAnchor(repo, ref, anchor.Path, anchor.Symbol, anchor.RegionSha256)
	case "commit":
		check.State, err = checkWikiCommitAnchor(repo, ref, anchor.Sha)
	default:
		err = fmt.Errorf("a %s anchor is not one git checks", anchor.Type)
	}
	return check, err
}

// checkWikiPathAnchor: `git cat-file -e <ref>:<path>`.
func checkWikiPathAnchor(repo, ref, path string) (string, error) {
	_, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "cat-file", "-e", ref+":"+wikiAnchorPath(path))
	switch {
	case err != nil:
		return "", err
	case code == 0:
		return "verified", nil
	case wikiGitSaysAbsent(code, stderr):
		return "missing", nil
	}
	return "", fmt.Errorf("git cat-file -e exited %d: %s", code, strings.TrimSpace(stderr))
}

// checkWikiSymbolAnchor: `git grep -n -w -F -I` finds the first line the symbol occurs on as a whole
// word, and the region from it is hashed and compared with the hash the symbol is held to. With no
// baseline yet, a symbol found is verified, and its hash becomes the baseline on the server.
func checkWikiSymbolAnchor(repo, ref, path, symbol, baseline string) (string, string, error) {
	if strings.TrimSpace(symbol) == "" || strings.ContainsAny(symbol, "\n\x00") {
		return "missing", "", nil
	}
	out, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "--literal-pathspecs", "grep", "-n", "-z", "-w", "-F", "-I",
		"--no-color", "-e", symbol, ref, "--", wikiAnchorPath(path))
	switch {
	case err != nil:
		return "", "", err
	case code == 1 || wikiGitSaysAbsent(code, stderr):
		return "missing", "", nil
	case code != 0:
		return "", "", fmt.Errorf("git grep exited %d: %s", code, strings.TrimSpace(stderr))
	}
	file, line, err := firstWikiGrepHit(out, ref)
	if err != nil {
		return "", "", err
	}
	blob, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "cat-file", "blob", ref+":"+file)
	if err != nil {
		return "", "", err
	}
	if code != 0 {
		return "", "", fmt.Errorf("git cat-file blob %s exited %d: %s", file, code, strings.TrimSpace(stderr))
	}
	region, ok := wikiSymbolRegionSha256(blob, line)
	if !ok {
		return "", "", fmt.Errorf("git grep found %s at line %d of %s, which has fewer lines", symbol, line, file)
	}
	if baseline == "" || region == baseline {
		return "verified", region, nil
	}
	return "changed", region, nil
}

// checkWikiCommitAnchor: `git merge-base --is-ancestor <sha> <ref>`. Anything but an ancestor is
// missing, including a sha this repository does not have at all.
func checkWikiCommitAnchor(repo, ref, sha string) (string, error) {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if !wikiCommitSha.MatchString(sha) {
		return "missing", nil
	}
	_, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "merge-base", "--is-ancestor", sha, ref)
	switch {
	case err != nil:
		return "", err
	case code == 0:
		return "verified", nil
	case code == 1:
		return "missing", nil
	}
	// merge-base refuses a sha it cannot resolve: when this repository does not have the commit at all,
	// it is not an ancestor of anything the fetch brought, and that is missing too.
	if _, known, _, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "cat-file", "-e", sha+"^{commit}"); err == nil && known != 0 {
		return "missing", nil
	}
	return "", fmt.Errorf("git merge-base --is-ancestor exited %d: %s", code, strings.TrimSpace(stderr))
}

// firstWikiGrepHit reads `git grep -n -z`'s first line, `<ref>:<file>\0<line>\0<text>`: the file and
// the line number of the first hit.
func firstWikiGrepHit(out []byte, ref string) (string, int, error) {
	fields := bytes.SplitN(out, []byte{0}, 3)
	if len(fields) < 3 {
		return "", 0, fmt.Errorf("git grep answered in a shape this build does not read: %q", string(out))
	}
	file := strings.TrimPrefix(string(fields[0]), ref+":")
	line, err := strconv.Atoi(string(fields[1]))
	if err != nil || line < 1 || file == string(fields[0]) {
		return "", 0, fmt.Errorf("git grep answered in a shape this build does not read: %q", string(out))
	}
	return file, line, nil
}

// wikiSymbolRegionSha256 is the hash of a symbol's region (contract `anchorRules.verify.checks.symbol`):
// the line it was found on and the lines after it, wikiAnchorSymbolRegionLines in all or fewer at the
// end of the file, each ended by a newline. Lines are what git numbers: a final newline ends the last
// line, it does not start another.
func wikiSymbolRegionSha256(content []byte, line int) (string, bool) {
	lines := strings.Split(string(content), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	start := line - 1
	if start < 0 || start >= len(lines) {
		return "", false
	}
	end := start + wikiAnchorSymbolRegionLines
	if end > len(lines) {
		end = len(lines)
	}
	var region strings.Builder
	for _, text := range lines[start:end] {
		region.WriteString(text)
		region.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(region.String()))
	return hex.EncodeToString(sum[:]), true
}

// wikiAnchorPath is a path as git names it inside a tree: no leading ./ or /, no trailing /, and no
// doubled slash, which git reads as a name of its own.
func wikiAnchorPath(path string) string {
	path = strings.TrimSpace(path)
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}
	for strings.HasPrefix(path, "./") || strings.HasPrefix(path, "/") {
		path = strings.TrimPrefix(strings.TrimPrefix(path, "./"), "/")
	}
	return strings.TrimSuffix(path, "/")
}

// wikiGitSaysAbsent is git's way of saying the thing is not in that tree, which is an answer (missing)
// rather than a failure. Read with LC_ALL=C, so the words are git's own.
func wikiGitSaysAbsent(code int, stderr string) bool {
	if code == 1 {
		return true
	}
	if code != 128 {
		return false
	}
	text := strings.ToLower(stderr)
	for _, phrase := range []string{"does not exist in", "exists on disk, but not in", "is outside repository", "not a valid object name", "invalid object name"} {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

// wikiAnchorGit runs `git -C repo <args>` and answers its stdout as it was written (a blob is hashed
// byte for byte), its exit code and its stderr. err is only git not running or running out of time:
// a non-zero exit is an answer the caller reads. No prompt can hold it, and no optional lock is taken.
//
// Nor can a process git started and left running. Wait reads git's stdout and stderr to their end, and
// a child that outlives git — a hook, a configured upload-pack, git's own detached maintenance for the
// moment before it lets go — holds them open: on 10-04 a merge check spent its last minute in this Wait
// on a fetch that had already exited, past any timeout, because the context kills only git. WaitDelay
// bounds that read. What git wrote before it exited is its answer, and is what is returned.
func wikiAnchorGit(repo string, timeout time.Duration, args ...string) ([]byte, int, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", repo}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = wikiAnchorGitWaitDelay
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, -1, stderr.String(), fmt.Errorf("git %s did not finish within %s", args[0], timeout)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return stdout.Bytes(), exit.ExitCode(), stderr.String(), nil
	}
	// ErrWaitDelay is git exiting 0 with its output still held open by a child when WaitDelay ran out.
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return nil, -1, stderr.String(), fmt.Errorf("git %s: %w", args[0], err)
	}
	return stdout.Bytes(), 0, stderr.String(), nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
