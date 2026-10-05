package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// `orbit wiki anchors verify`: a Wiki maintenance run's anchor re-verification
// (contracts/wiki.contract.json `anchorRules.verify`, design §4.4, criterion 4).
//
// GIT RUNS HERE, AND ONLY HERE. An entry's anchors say what in the repository has to stay true for it
// to hold — a path, a symbol, a commit — and the only place that can check them is a checkout: the
// API server runs no git. So this command fetches origin's main into the runner's own checkout of the
// space's repository, checks every git anchor of the space's live entries on the commit
// refs/remotes/origin/main then names, and reports what git said, a page at a time. The server does
// the rest: it keeps each anchor's last check, takes an entry whose anchor moved or went out of the
// push at once, and files a challenge in the owner's Review.
//
// WHAT EACH CHECK IS. A path: `git cat-file -e <ref>:<path>`. A symbol: `git grep -n -w -F -I` finds
// the first line the symbol occurs on as a whole word, and the sha256 of that line and the ones after
// it (wikiAnchorSymbolRegionLines in all) is compared with the hash the symbol is held to — the server
// holds it there too, so a region that moved reads changed whatever this side thought. A commit: `git
// merge-base --is-ancestor <sha> <ref>`, and a sha that is not an ancestor of origin/main — or one this
// repository does not have — is missing, because a sha that is not on main poisons what depends on it.
//
// ONLY WHAT GIT SAID. An anchor git could not check — git failed, not the anchor — is reported as
// nothing and counted as a failure; the command exits non-zero, and the anchor keeps its last check
// until a run that can check it. A fetch that fails checks nothing at all: a check against a stale
// origin/main would be a claim about a commit nobody asked about.

// wikiAnchorsVerifyPrecondition is contracts/wiki.contract.json `anchorRules.verify.precondition`, word
// for word, and wiki_anchors_test.go holds the two equal. It leads the description for the reason the
// dossier's does: what a reader must not do is what the mechanics make easy — say an anchor holds
// without having asked git.
const wikiAnchorsVerifyPrecondition = "Re-verify anchors only as a Wiki maintenance run of the space, in a " +
	"checkout of its repository, and report only what git said: every state is read from origin/main just after " +
	"a fetch, and an anchor git could not check is reported as nothing."

const wikiAnchorsVerifyDescription = wikiAnchorsVerifyPrecondition + " This is how an entry whose code moved " +
	"stops being handed to agents: in the checkout --repo names — by default the work directory of the space's " +
	"workspace on this runner — it fetches origin's main, then checks every path, symbol and commit anchor of the " +
	"space's live entries on the commit origin/main names (a path exists, a symbol's region hashes as it is held " +
	"to, a commit is an ancestor of origin/main), and reports each entry as it goes. The server keeps each anchor's " +
	"last check; an entry an anchor of which is changed or missing is out of the push at once, with one system " +
	"challenge in the owner's Review, where the owner re-confirms, amends or retires it. It exits non-zero when the " +
	"fetch failed, when git could not check an anchor, or when the server refused an entry. Any session but a " +
	"maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION."

// The contract's numbers this side needs (`anchorRules.verify.rules`).
const (
	// A symbol's region: the line it is found on and the lines after it, this many in all.
	wikiAnchorSymbolRegionLines = 20
	// Entries a page of the list carries, which is also the most one report carries: a page is
	// checked and then reported whole.
	wikiAnchorPageEntries = 50
	// A fetch of origin's main may cross a slow network; one git command on the checkout may not.
	wikiAnchorFetchTimeout = 5 * time.Minute
	wikiAnchorGitTimeout   = 2 * time.Minute
	// How long a git command's output may stay open after git exited, held by a process it started.
	wikiAnchorGitWaitDelay = 2 * time.Second
	// A report writes one transaction per entry, fifty of them at most.
	wikiAnchorReportTimeout = 2 * time.Minute
)

// wikiAnchorsVerifyRefspec is what the fetch asks for: origin's main, into origin/main, whatever the
// checkout's own configured refspecs are.
const wikiAnchorsVerifyRefspec = "+refs/heads/main:refs/remotes/origin/main"

var wikiCommitSha = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ── The server's two routes ─────────────────────────────────────────────────────────────────────

// wikiAnchorList is `GET /api/runner/wiki/spaces/:id/anchors` (contract `anchorRules.verify.list`).
type wikiAnchorList struct {
	SpaceID string              `json:"spaceId"`
	Repo    *wikiAnchorRepo     `json:"repo"`
	Entries []wikiAnchorDueItem `json:"entries"`
	Next    string              `json:"next"`
}

// wikiAnchorRepo is the checkout the space's workspace names on this runner, as the workspace stores
// it: `~/orbit` is expanded here, where the home it means is.
type wikiAnchorRepo struct {
	WorkspaceID string `json:"workspaceId"`
	WorkDir     string `json:"workDir"`
}

// wikiAnchorDueItem is one live entry with git anchors, at the revision its report must name.
type wikiAnchorDueItem struct {
	EntryID  string          `json:"entryId"`
	Revision int             `json:"revision"`
	Anchors  []wikiDueAnchor `json:"anchors"`
}

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

// wikiAnchorCheck is one anchor's check as the report carries it.
type wikiAnchorCheck struct {
	Index        int    `json:"index"`
	Type         string `json:"type"`
	State        string `json:"state"`
	RegionSha256 string `json:"regionSha256,omitempty"`
}

// wikiAnchorReportItem is one entry of a report.
type wikiAnchorReportItem struct {
	EntryID  string            `json:"entryId"`
	Revision int               `json:"revision"`
	Checks   []wikiAnchorCheck `json:"checks"`
}

// wikiAnchorOutcome is what the server made of one entry's report.
type wikiAnchorOutcome struct {
	EntryID       string `json:"entryId"`
	Status        string `json:"status"`
	AnchorState   string `json:"anchorState,omitempty"`
	Trust         string `json:"trust,omitempty"`
	Challenged    bool   `json:"challenged,omitempty"`
	ChallengeOpID string `json:"challengeOpId,omitempty"`
	HTTPStatus    int    `json:"httpStatus,omitempty"`
	Code          string `json:"code,omitempty"`
	Message       string `json:"message,omitempty"`
}

// wikiAnchorReportAnswer is `POST /api/runner/wiki/spaces/:id/anchor-checks`'s answer.
type wikiAnchorReportAnswer struct {
	SpaceID  string              `json:"spaceId"`
	Ref      string              `json:"ref"`
	Outcomes []wikiAnchorOutcome `json:"outcomes"`
}

// wikiAnchorsSummary is a run, as the command prints it and as --json writes it.
type wikiAnchorsSummary struct {
	SpaceID  string `json:"spaceId"`
	Repo     string `json:"repo"`
	Ref      string `json:"ref"`
	Entries  int    `json:"entries"`
	Anchors  int    `json:"anchors"`
	Verified int    `json:"verified"`
	Changed  int    `json:"changed"`
	Missing  int    `json:"missing"`
	// Anchors git could not check: reported as nothing, and what makes the command exit non-zero.
	Failed   int      `json:"failed"`
	Failures []string `json:"failures"`
	// What the server made of the entries reported.
	Recorded   int                 `json:"recorded"`
	Stale      int                 `json:"stale"`
	Refused    int                 `json:"refused"`
	Challenges int                 `json:"challenges"`
	Outcomes   []wikiAnchorOutcome `json:"outcomes"`
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func cliWikiAnchorsVerify(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki anchors verify")
	space := fs.String("space", "", "the space this maintenance run maintains")
	repo := fs.String("repo", "", "the checkout to re-verify in")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID, err := wikiMaintenanceSpace(*space)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	summary, runErr := runWikiAnchorsVerify(t, ctx.sessionID, spaceID, *repo)
	// Nothing checked yet — the door refused, the checkout is not one, the fetch failed — is the error
	// alone. A run that ended part way says what it did report before it says why it stopped.
	if runErr != nil && summary.Ref == "" {
		return runErr
	}
	if *jsonOut {
		raw, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		if err := writeCLIRawJSON(out, raw, true); err != nil {
			return err
		}
	} else if _, err := fmt.Fprint(out, describeWikiAnchorsSummary(summary)); err != nil {
		return err
	}
	if runErr != nil {
		return runErr
	}
	switch {
	case summary.Failed > 0 && summary.Refused > 0:
		return fmt.Errorf("git could not check %s, and the server refused %s: see above",
			wikiCount(summary.Failed, "anchor", "anchors"), wikiCount(summary.Refused, "entry", "entries"))
	case summary.Failed > 0:
		return fmt.Errorf("git could not check %s: they keep their last check, and the next run tries them again",
			wikiCount(summary.Failed, "anchor", "anchors"))
	case summary.Refused > 0:
		return fmt.Errorf("the server refused %s: see above", wikiCount(summary.Refused, "entry", "entries"))
	}
	return nil
}

// runWikiAnchorsVerify is the whole run: the first page (which names the checkout), the fetch, then
// every page checked and reported in turn. An error is what ends the run before it reported anything
// more; what went wrong with one anchor or one entry is in the summary instead.
func runWikiAnchorsVerify(t *Transport, sessionID, spaceID, repoFlag string) (wikiAnchorsSummary, error) {
	summary := wikiAnchorsSummary{SpaceID: spaceID, Failures: []string{}, Outcomes: []wikiAnchorOutcome{}}
	page, err := listWikiAnchorPage(t, sessionID, spaceID, "")
	if err != nil {
		return summary, err
	}
	repo, err := wikiAnchorsCheckout(repoFlag, page.Repo)
	if err != nil {
		return summary, err
	}
	summary.Repo = repo
	ref, err := fetchWikiAnchorsRef(repo)
	if err != nil {
		return summary, err
	}
	summary.Ref = ref
	after := ""
	for {
		report := make([]wikiAnchorReportItem, 0, len(page.Entries))
		for _, entry := range page.Entries {
			summary.Entries++
			checks := make([]wikiAnchorCheck, 0, len(entry.Anchors))
			for _, anchor := range entry.Anchors {
				summary.Anchors++
				check, err := checkWikiAnchor(repo, ref, anchor)
				if err != nil {
					summary.Failed++
					summary.Failures = append(summary.Failures, fmt.Sprintf("entry %s, %s: %v", entry.EntryID, describeWikiDueAnchor(anchor), err))
					continue
				}
				switch check.State {
				case "verified":
					summary.Verified++
				case "changed":
					summary.Changed++
				case "missing":
					summary.Missing++
				}
				checks = append(checks, check)
			}
			if len(checks) > 0 {
				report = append(report, wikiAnchorReportItem{EntryID: entry.EntryID, Revision: entry.Revision, Checks: checks})
			}
		}
		for start := 0; start < len(report); start += wikiAnchorPageEntries {
			end := start + wikiAnchorPageEntries
			if end > len(report) {
				end = len(report)
			}
			if err := reportWikiAnchorBatch(t, sessionID, spaceID, ref, report[start:end], &summary); err != nil {
				return summary, err
			}
		}
		if page.Next == "" {
			return summary, nil
		}
		// A list that hands back the page it was just asked past would be read, checked and reported
		// forever: a run stops there rather than spend itself on the same entries.
		if page.Next == after {
			return summary, fmt.Errorf("orbit wiki anchors verify: the server's anchors list did not move past entry %s, "+
				"so the run stopped there; what it checked before is reported", after)
		}
		after = page.Next
		if page, err = listWikiAnchorPage(t, sessionID, spaceID, after); err != nil {
			return summary, err
		}
	}
}

func listWikiAnchorPage(t *Transport, sessionID, spaceID, after string) (wikiAnchorList, error) {
	raw, err := t.listWikiAnchors(sessionID, spaceID, after, wikiAnchorPageEntries)
	if err != nil {
		return wikiAnchorList{}, wikiAnchorsCallError(spaceID, err)
	}
	var page wikiAnchorList
	if err := json.Unmarshal(raw, &page); err != nil {
		return wikiAnchorList{}, fmt.Errorf("orbit wiki anchors verify: the server's anchors list is not the shape this build reads: %w", err)
	}
	return page, nil
}

// reportWikiAnchorBatch sends one report and adds what the server made of it to the summary. A report
// every entry of which was refused comes back as an HTTP error carrying the same outcomes; those are
// counted, not fatal. Anything else the server says ends the run.
func reportWikiAnchorBatch(t *Transport, sessionID, spaceID, ref string, entries []wikiAnchorReportItem, summary *wikiAnchorsSummary) error {
	raw, err := t.reportWikiAnchorChecks(sessionID, spaceID, map[string]interface{}{"ref": ref, "entries": entries})
	var answer wikiAnchorReportAnswer
	if err != nil {
		var httpErr *transportHTTPError
		if !errors.As(err, &httpErr) || json.Unmarshal([]byte(httpErr.body), &answer) != nil || len(answer.Outcomes) == 0 {
			return wikiAnchorsCallError(spaceID, err)
		}
	} else if err := json.Unmarshal(raw, &answer); err != nil {
		return fmt.Errorf("orbit wiki anchors verify: the server's answer is not the shape this build reads: %w", err)
	}
	for _, outcome := range answer.Outcomes {
		switch outcome.Status {
		case "recorded":
			summary.Recorded++
			if outcome.ChallengeOpID != "" {
				summary.Challenges++
			}
		case "stale":
			summary.Stale++
		default:
			summary.Refused++
		}
		summary.Outcomes = append(summary.Outcomes, outcome)
	}
	return nil
}

// ── The checkout and the ref ────────────────────────────────────────────────────────────────────

// wikiAnchorsCheckout is the checkout to re-verify in: --repo, or the work directory of the space's
// workspace on this runner, with a leading ~ expanded to this runner's home — the server stores the
// directory as the owner typed it, and `~/orbit` means nothing there.
func wikiAnchorsCheckout(flagValue string, listed *wikiAnchorRepo) (string, error) {
	dir, from := strings.TrimSpace(flagValue), "--repo"
	if dir == "" && listed != nil {
		dir, from = strings.TrimSpace(listed.WorkDir), "the work directory of the space's workspace"
	}
	if dir == "" {
		return "", fmt.Errorf("orbit wiki anchors verify: there is no checkout to re-verify in: no workspace bound to the " +
			"space lives on this runner with a work directory, so pass --repo <a checkout of the space's repository>")
	}
	abs, err := filepath.Abs(expandTilde(dir))
	if err != nil {
		return "", fmt.Errorf("orbit wiki anchors verify: %s (%s): %w", dir, from, err)
	}
	if _, code, stderr, err := wikiAnchorGit(abs, wikiAnchorGitTimeout, "rev-parse", "--git-dir"); err != nil || code != 0 {
		return "", fmt.Errorf("orbit wiki anchors verify: %s (%s) is not a git checkout, so nothing was checked: %s",
			abs, from, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	return abs, nil
}

// fetchWikiAnchorsRef fetches origin's main and answers the commit origin/main names after it: every
// anchor of the run is checked on that one commit, and the report says which.
//
// --no-auto-maintenance: the run starts no maintenance in a checkout it only reads. Git's own after a
// fetch is a detached process that holds the fetch's output for a moment after the fetch has exited —
// a moment as long as a loaded machine makes it (wikiAnchorGit).
func fetchWikiAnchorsRef(repo string) (string, error) {
	if _, code, stderr, err := wikiAnchorGit(repo, wikiAnchorFetchTimeout, "fetch", "--quiet", "--no-tags", "--no-auto-maintenance", "origin", wikiAnchorsVerifyRefspec); err != nil || code != 0 {
		return "", fmt.Errorf("orbit wiki anchors verify: git fetch origin main failed in %s, so nothing was checked and "+
			"nothing reported — a check against an origin/main that was not just fetched says nothing about main: %s",
			repo, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	out, code, stderr, err := wikiAnchorGit(repo, wikiAnchorGitTimeout, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}")
	ref := strings.TrimSpace(string(out))
	if err != nil || code != 0 || !wikiCommitSha.MatchString(ref) {
		return "", fmt.Errorf("orbit wiki anchors verify: origin/main names no commit in %s after the fetch: %s",
			repo, firstNonEmpty(strings.TrimSpace(stderr), errString(err), ref))
	}
	return ref, nil
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

// ── What the caller reads ───────────────────────────────────────────────────────────────────────

func describeWikiDueAnchor(anchor wikiDueAnchor) string {
	switch anchor.Type {
	case "path":
		return fmt.Sprintf("anchor %d (path %s)", anchor.Index, anchor.Path)
	case "symbol":
		return fmt.Sprintf("anchor %d (symbol %s in %s)", anchor.Index, anchor.Symbol, anchor.Path)
	case "commit":
		return fmt.Sprintf("anchor %d (commit %s)", anchor.Index, anchor.Sha)
	}
	return fmt.Sprintf("anchor %d (%s)", anchor.Index, anchor.Type)
}

// describeWikiAnchorsSummary is the run as a maintenance run reads it: what was checked, on which
// commit, what it found, and what the server made of each entry that came out changed or missing.
func describeWikiAnchorsSummary(s wikiAnchorsSummary) string {
	var b strings.Builder
	short := s.Ref
	if len(short) > 12 {
		short = short[:12]
	}
	if s.Anchors == 0 {
		fmt.Fprintf(&b, "Space %s: no live entry has a path, symbol or commit anchor to re-verify; origin/main is at %s in %s.\n",
			s.SpaceID, short, s.Repo)
		return b.String()
	}
	fmt.Fprintf(&b, "Re-verified the anchors of space %s on origin/main at %s, in %s: %s, %s — %d verified, %d changed, %d missing.\n",
		s.SpaceID, short, s.Repo, wikiCount(s.Entries, "entry", "entries"), wikiCount(s.Anchors, "anchor", "anchors"),
		s.Verified, s.Changed, s.Missing)
	out := 0
	for _, outcome := range s.Outcomes {
		if outcome.Status == "recorded" && (outcome.AnchorState == "changed" || outcome.AnchorState == "missing") {
			out++
		}
	}
	if out > 0 {
		fmt.Fprintf(&b, "%s out of the push until the owner answers in Review; %s filed this run.\n",
			wikiCount(out, "entry is", "entries are"), wikiCount(s.Challenges, "challenge", "challenges"))
	}
	for _, outcome := range s.Outcomes {
		switch {
		case outcome.Status == "recorded" && (outcome.AnchorState == "changed" || outcome.AnchorState == "missing"):
			filed := "already challenged"
			if outcome.ChallengeOpID != "" {
				filed = "challenge filed"
			}
			fmt.Fprintf(&b, "  ✗ entry %s: %s — %s\n", outcome.EntryID, outcome.AnchorState, filed)
		case outcome.Status == "stale":
			fmt.Fprintf(&b, "  ~ entry %s: stale, nothing recorded — %s\n", outcome.EntryID, outcome.Message)
		case outcome.Status != "recorded":
			fmt.Fprintf(&b, "  ! entry %s: refused %s — %s\n", outcome.EntryID, firstNonEmpty(outcome.Code, strconv.Itoa(outcome.HTTPStatus)), outcome.Message)
		}
	}
	for _, failure := range s.Failures {
		fmt.Fprintf(&b, "  ! not checked, not reported: %s\n", failure)
	}
	return b.String()
}

// wikiAnchorsCallError says what failed about a call to the anchors door, each refusal in a sentence
// that says nothing was checked or changed.
func wikiAnchorsCallError(spaceID string, err error) error {
	const command = "orbit wiki anchors verify"
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("%s: %w", command, err)
	}
	code := httpErr.code()
	switch {
	case wikiDisabledByServer(err):
		return wikiCallError(command, err)
	case code == wikiNotMaintenanceSessionCode:
		return fmt.Errorf("%s: only a Wiki maintenance run of space %s re-verifies its anchors — a session whose task is "+
			"in the space's hidden «Wiki maintenance» list — and this session is not one (%s). Nothing was checked or "+
			"changed: maintenance is those tasks' work, not this session's", command, spaceID, code)
	case code != "":
		return fmt.Errorf("%s: %w", command, err)
	case httpErr.statusCode == http.StatusForbidden:
		return fmt.Errorf("%s: the Orbit server does not know this session (ORBIT_SESSION_ID) as one this runner hosts, "+
			"so it answered 403 and nothing was checked. Run it from inside the maintenance session, on the machine that "+
			"runs it", command)
	case wikiMaintenanceDoorMissing(err):
		return fmt.Errorf("%s: this Orbit server has no anchor re-verification door yet (it answered 404 for %s /api%s): "+
			"it predates it, so nothing was checked. Upgrade the Orbit server", command, httpErr.method,
			strings.SplitN(httpErr.path, "?", 2)[0])
	case httpErr.statusCode == http.StatusNotFound:
		return fmt.Errorf("%s: this account has no wiki space %s (the server answered 404, which is its answer for "+
			"another account's space too), so nothing was checked. Check --space", command, spaceID)
	}
	return fmt.Errorf("%s: %w", command, err)
}
