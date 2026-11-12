package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Push in the main checkout (docs/main-checkout-git-contract.md §5 "push"): the current branch goes
// to its upstream, or to origin/<branch> with -u when it has none. A plain push — never --force,
// never a +refspec — with the runner machine's own git credentials and no prompt (networkGitArgs,
// networkGitEnv). Nothing local is written in any outcome but the upstream setting -u adds and the
// remote-tracking ref / FETCH_HEAD a rejected push's fetch updates; the branch and its commits are
// never touched.

// mainCheckoutPushTimeout bounds the whole push, inside the apiserver's 300 s action timeout.
const mainCheckoutPushTimeout = 4 * time.Minute

// mainCheckoutPushGit runs one git command that talks to a remote and answers its stdout and
// stderr. Every command push sends to a remote goes through it, so a test can read every argv.
var mainCheckoutPushGit = func(ctx context.Context, root string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, "git", networkGitArgs(root, args)...)
	cmd.Env = append(os.Environ(), networkGitEnv...)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = networkGitWaitDelay
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	return stdout.String(), stderr.String(), err
}

// pushMainCheckout runs one push action. A refusal is a result with status refused; an error is a
// failure of local git the codes don't name.
func pushMainCheckout(ctx context.Context, cmd MainCheckoutActionCommand) (MainCheckoutActionResult, error) {
	res := MainCheckoutActionResult{RequestID: cmd.RequestID, Kind: mainCheckoutPush, Root: cmd.Root}
	ctx, cancel := context.WithTimeout(ctx, mainCheckoutPushTimeout)
	defer cancel()

	root, err := mainCheckoutRoot(ctx, cmd.Root)
	if err != nil {
		return res, err
	}
	res.Root = root
	defer lockMainCheckout(root)()
	if pastDeadline(cmd.ExpiresAt) {
		return res, errMainCheckoutExpired
	}

	finish := func() (MainCheckoutActionResult, error) {
		res.FinishedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		return res, nil
	}
	refuse := func(code string) (MainCheckoutActionResult, error) {
		res.Status, res.Code = mainCheckoutRefused, code
		return finish()
	}

	branch, _ := mcTrim(mcGit(ctx, root, nil, "symbolic-ref", "--quiet", "--short", "HEAD"))
	if branch == "" {
		return refuse(mainCheckoutDetached)
	}
	res.Branch = branch
	head := mainCheckoutHead(ctx, root)
	if head == "" {
		return refuse(mainCheckoutNoHead)
	}
	// Only the HEAD part of the fingerprint is checked: Push sends commits, not the working tree.
	if fingerprintHead(cmd.Fingerprint) != head {
		res.Head = head
		return refuse(mainCheckoutHeadMoved)
	}
	res.Head = head

	remote, _ := mcTrim(mcGit(ctx, root, nil, "config", "--get", "branch."+branch+".remote"))
	merge, _ := mcTrim(mcGit(ctx, root, nil, "config", "--get", "branch."+branch+".merge"))
	setUpstream := false
	if remote == "" || remote == "." || !strings.HasPrefix(merge, "refs/heads/") {
		// No upstream on a remote: origin/<same name>, and -u makes it the upstream.
		if url, _ := mcTrim(mcGit(ctx, root, nil, "config", "--get", "remote.origin.url")); url == "" {
			return refuse(mainCheckoutNoRemote)
		}
		remote, merge, setUpstream = "origin", "refs/heads/"+branch, true
	}
	if strings.HasPrefix(remote, "-") {
		return res, errors.New("push: the upstream remote's name starts with '-'")
	}
	res.Upstream = remote + "/" + strings.TrimPrefix(merge, "refs/heads/")
	secrets := remoteURLSecrets(ctx, root, remote)

	failed := func(stderr string) (MainCheckoutActionResult, error) {
		code := mainCheckoutPushFailed
		if isPushAuthFailure(stderr) {
			code = mainCheckoutPushAuthFailed
		}
		res.GitMessage = redactGitMessage(pushReasonLine(stderr), secrets)
		return refuse(code)
	}

	// Where the remote branch is now: NOTHING_TO_PUSH, and remoteBefore for the result line.
	out, stderr, err := mainCheckoutPushGit(ctx, root, "ls-remote", remote, merge)
	if err != nil {
		return failed(stderr)
	}
	before := lsRemoteSha(out, merge)
	res.RemoteBefore = before
	journalPath := pushJournalPath(ctx, root, cmd.RequestID)
	if before == head {
		// The same request run again after its push went through (a runner restarted before it
		// answered): the push it made is the answer, not NOTHING_TO_PUSH.
		if j := readPushJournal(journalPath, cmd.RequestID); j != nil && j.Branch == branch && j.Head == head && j.Merge == merge {
			if j.SetUpstream {
				_, _ = mcGit(ctx, root, nil, "config", "branch."+branch+".remote", remote)
				_, _ = mcGit(ctx, root, nil, "config", "branch."+branch+".merge", merge)
			}
			res.Status, res.RemoteBefore, res.RemoteAfter = mainCheckoutDone, j.RemoteBefore, head
			return finish()
		}
		return refuse(mainCheckoutNothingToPush)
	}
	if journalPath != "" {
		_ = writeJSONAtomic(journalPath, mainCheckoutPushJournal{RequestID: cmd.RequestID, Branch: branch,
			Head: head, Merge: merge, RemoteBefore: before, SetUpstream: setUpstream})
	}

	args := []string{"push"}
	if setUpstream {
		args = append(args, "-u")
	}
	args = append(args, remote, "refs/heads/"+branch+":"+merge)
	if _, stderr, err := mainCheckoutPushGit(ctx, root, args...); err != nil {
		if !isNonFastForward(stderr) {
			return failed(stderr)
		}
		res.GitMessage = redactGitMessage(pushReasonLine(stderr), secrets)
		// How far apart they are: fetch the remote branch (FETCH_HEAD, and the remote-tracking ref
		// git updates beside it; no local branch) and count both ways. A failed fetch leaves the
		// counts out rather than the refusal.
		if _, _, ferr := mainCheckoutPushGit(ctx, root, "fetch", "--no-tags", "--no-recurse-submodules", remote, merge); ferr == nil {
			if counts, cerr := mcTrim(mcGit(ctx, root, nil, "rev-list", "--left-right", "--count", head+"...FETCH_HEAD")); cerr == nil {
				if f := strings.Fields(counts); len(f) == 2 {
					ahead, aerr := strconv.Atoi(f[0])
					behind, berr := strconv.Atoi(f[1])
					if aerr == nil && berr == nil {
						res.Ahead, res.Behind = &ahead, &behind
					}
				}
			}
		}
		return refuse(mainCheckoutPushRejected)
	}
	if err := mainCheckoutPushStep("pushed"); err != nil {
		return res, err
	}
	res.Status, res.RemoteAfter = mainCheckoutDone, head
	return finish()
}

// mainCheckoutPushStep is called once the push went through; a test returns an error to stop
// there, as a crash before the answer would.
var mainCheckoutPushStep = func(step string) error { return nil }

// mainCheckoutPushJournal is written just before a push goes out, under the git dir and keyed by
// requestId, so the same request run again after the push went through answers done with the
// range it pushed. It is a few hundred bytes per push and stays, like the commit journal.
type mainCheckoutPushJournal struct {
	RequestID    string `json:"requestId"`
	Branch       string `json:"branch"`
	Head         string `json:"head"`
	Merge        string `json:"merge"`
	RemoteBefore string `json:"remoteBefore"`
	SetUpstream  bool   `json:"setUpstream,omitempty"`
}

// pushJournalPath is "" when the git dir can't be read (the push then runs without a journal).
func pushJournalPath(ctx context.Context, root, requestID string) string {
	gitDir, err := mcTrim(mcGit(ctx, root, nil, "rev-parse", "--absolute-git-dir"))
	if err != nil || gitDir == "" || requestID == "" {
		return ""
	}
	return filepath.Join(gitDir, "orbit-main-checkout", "push-"+shortHash(requestID)+".json")
}

func readPushJournal(path, requestID string) *mainCheckoutPushJournal {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var j mainCheckoutPushJournal
	if json.Unmarshal(data, &j) != nil || j.RequestID != requestID {
		return nil
	}
	return &j
}

// writeJSONAtomic replaces path with v as JSON.
func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// lsRemoteSha is the sha `ls-remote` lists for exactly ref, "" when the remote has no such ref.
func lsRemoteSha(out, ref string) string {
	for _, line := range strings.Split(out, "\n") {
		if sha, name, ok := strings.Cut(strings.TrimSpace(line), "\t"); ok && name == ref {
			return sha
		}
	}
	return ""
}

// pushAuthPatterns are git's (LC_ALL=C) words for a credential the remote refused, or none to send.
var pushAuthPatterns = []string{
	"Authentication failed",
	"could not read Username",
	"could not read Password",
	"terminal prompts disabled",
	"Permission denied (publickey",
	"Permission denied, please try again",
	"HTTP Basic: Access denied",
	"The requested URL returned error: 401",
	"The requested URL returned error: 403",
	"Invalid username or password",
}

func isPushAuthFailure(stderr string) bool {
	for _, p := range pushAuthPatterns {
		if strings.Contains(stderr, p) {
			return true
		}
	}
	return false
}

// pushReasonLine is git's reason in one line: the line naming the credential problem, else the
// first fatal:/error: line, else the last line; without git's "fatal: "/"error: " prefix.
func pushReasonLine(stderr string) string {
	var lines []string
	for _, l := range strings.Split(stderr, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	pick := ""
	for _, l := range lines {
		if isPushAuthFailure(l) {
			pick = l
			break
		}
	}
	for _, prefix := range []string{"fatal:", "error:"} {
		for _, l := range lines {
			if pick == "" && strings.HasPrefix(l, prefix) {
				pick = l
			}
		}
	}
	if pick == "" {
		pick = lines[len(lines)-1]
	}
	for _, prefix := range []string{"fatal: ", "error: ", "remote: "} {
		pick = strings.TrimPrefix(pick, prefix)
	}
	return clip(pick, 300)
}

var (
	urlUserinfo  = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s'"]+@`)
	tokenPattern = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})`)
	authHeader   = regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}`)
	secretParam  = regexp.MustCompile(`(?i)\b(access_token|private_token|token|password|passwd|pwd)=[^&\s'"]+`)
)

// redactGitMessage removes URL userinfo, well-known token shapes and the remote URL's own userinfo
// parts (secrets) from git's message.
func redactGitMessage(msg string, secrets []string) string {
	for _, s := range secrets {
		msg = strings.ReplaceAll(msg, s, "[redacted]")
	}
	msg = urlUserinfo.ReplaceAllString(msg, "$1")
	msg = tokenPattern.ReplaceAllString(msg, "[redacted]")
	msg = authHeader.ReplaceAllString(msg, "$1 [redacted]")
	return secretParam.ReplaceAllString(msg, "$1=[redacted]")
}

// remoteURLSecrets is the userinfo (user and password, raw and as they'd print) of remote's URLs,
// so the message loses them even where git printed them outside a URL. Parts shorter than 4
// characters are left alone: replacing "git" everywhere would garble the message, not protect it.
func remoteURLSecrets(ctx context.Context, root, remote string) []string {
	var secrets []string
	out, _ := mcGit(ctx, root, nil, "config", "--get-all", "remote."+remote+".url")
	more, _ := mcGit(ctx, root, nil, "config", "--get-all", "remote."+remote+".pushurl")
	for _, url := range strings.Split(string(out)+"\n"+string(more), "\n") {
		m := urlUserinfo.FindStringSubmatch(strings.TrimSpace(url))
		if m == nil {
			continue
		}
		info := strings.TrimSuffix(strings.TrimPrefix(m[0], m[1]), "@")
		for _, part := range strings.SplitN(info, ":", 2) {
			if len(part) >= 4 {
				secrets = append(secrets, part)
			}
		}
	}
	return secrets
}
