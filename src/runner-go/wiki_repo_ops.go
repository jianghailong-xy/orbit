package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// The wiki's repository operations (contracts/wiki.contract.json `repoOps`,
// docs/wiki-server-execution-design.md §7).
//
// THE SERVER RUNS THE PIPELINES AND HOLDS NO REPOSITORY. Git's credentials are here, so a step that has
// to know what the repository says asks this machine: a snapshot to be built once per commit, a bounded
// read of the text it needs, a diff between two commits, or the anchor checks. Nothing here creates an
// agent session, takes a concurrency slot, or touches a model — the operative sentence of the design's G2.
//
// The four questions, and what each answers with:
//
//   snapshot   every path of origin/main with its size, every document's title and headings, every source
//              file's symbols, the contracts' shapes, the commits reachable from origin/main, and the
//              README's first paragraph. Above `wikiRepoOpInlineBytes` it travels in fragments.
//   read       the whole text of given paths at a given commit (owner 2026-10-08), one file up to
//              `wikiRepoOpWholeFileBytes` — a larger one is missing, with `too_large` as the reason — and
//              an answer too large for one request body uploaded in fragments, as a snapshot is. A request
//              that names a limit is answered within it, the way an older control plane asks.
//   diff       `--name-status -M` between two commits, and the design documents the range added.
//   anchors    the maintenance run's own anchor checks (wiki_anchors.go), reused.
//
// EVERY ONE OF THEM CHECKS ITS CHECKOUT FIRST: the repository's origin URL must be the space's
// `repo.urlNorm` and the checkout's root commit must be the space's `rootCommitSha` (design §7, "the
// existing checks"). A checkout that is another repository behind the same URL, or another repository
// entirely, is a failure and not an answer — what would be read is not what the space is about.

// The capability a runner declares before the control plane hands it any repository operation. Its
// apiserver twin is WIKI_REPO_OP_CAPABILITY in src/shared/src/wikiRepoOps.ts: a runner that does not
// declare this is handed nothing rather than handed work it would have to fail.
const wikiRepoOpCapabilityV1 = "wiki-repo-op/v1"

// The capability a runner declares when its `read` answers with whole files (owner 2026-10-08). A runner
// that declares only wikiRepoOpCapabilityV1 still reads, but with the old window (wikiRepoOpBoundedChars);
// the server hands whole-file reads only to a runner that declares this. Its apiserver twin is
// WIKI_REPO_OP_READ_CAPABILITY in src/shared/src/wikiRepoOps.ts.
const wikiRepoOpReadCapabilityV1 = "wiki-repo-op-read/v1"

// The contract's numbers (`repoOps.fragments`, `.read`), mirrored here as the runner applies them.
const (
	wikiRepoOpInlineBytes      = 4 << 20
	wikiRepoOpFragmentBytes    = 2 << 20
	wikiRepoOpWholeFileBytes   = 2 << 20
	wikiRepoOpBoundedChars     = 22000
	wikiRepoOpAfterwardsMarker = "\n… (rest omitted)\n"
)

// One git command's budget: the snapshot reads a whole tree, which is minutes of work on a cold object
// store, while one git command on a warm checkout is not. The fetch's own budget is
// wiki_anchors.go's (wikiAnchorFetchTimeout) — the operation fetches through it, so there is one number
// for how long a fetch may take rather than one per caller.
const (
	wikiRepoOpGitTimeout    = 2 * time.Minute
	wikiRepoOpResultTimeout = 60 * time.Second
)

// ── what the control plane sends ────────────────────────────────────────────────────────────────

// wikiRepoOpInput is one kind's material, all four kinds in one shape: a snapshot's skip sha, a read's
// commit and items, a diff's two commits, an anchors op's anchors.
type wikiRepoOpInput struct {
	// snapshot: the commit the server already holds for this space, skipped when the fetch resolves to it.
	SkipSha string `json:"skipSha,omitempty"`
	// read: the commit to read at, and what to read of it.
	Sha   string               `json:"sha,omitempty"`
	Items []wikiRepoOpReadItem `json:"items,omitempty"`
	// diff: the two commits, oldest first.
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// anchors: what to check, at the commit the snapshot was taken at.
	Anchors []wikiDueAnchor `json:"anchors,omitempty"`
}

// wikiRepoOpReadItem is one thing to read: the whole file at the commit, or — when a limit is named, as an
// older control plane asks — that much of it.
type wikiRepoOpReadItem struct {
	Path    string `json:"path"`
	Section string `json:"section,omitempty"`
	// The most characters to answer with. Absent reads the whole file, up to wikiRepoOpWholeFileBytes;
	// a number asks for a bounded read, never more than one section's material (wikiRepoOpBoundedChars).
	MaxChars int `json:"maxChars,omitempty"`
}

// ── what this side answers with ─────────────────────────────────────────────────────────────────

// wikiRepoOpOutcome is what one operation came to. `payload` is the part too large to travel inside the
// result: the caller uploads it in fragments and reports their count instead of the text, under `payloadKey`
// when the kind nests its shape (a read's answer under `read`) and flat when it does not (a snapshot's index).
type wikiRepoOpOutcome struct {
	state      string
	result     map[string]interface{}
	payload    string
	payloadKey string
	sha        string
	err        string
}

type wikiRepoOpReadAnswer struct {
	Sha   string                `json:"sha"`
	Items []wikiRepoOpReadPiece `json:"items"`
	Chars int                   `json:"chars"`
}

type wikiRepoOpReadPiece struct {
	Path    string `json:"path"`
	Section string `json:"section,omitempty"`
	Found   bool   `json:"found"`
	// Why it is not there: "too_large" for a file over wikiRepoOpWholeFileBytes. Absent otherwise.
	Reason string `json:"reason,omitempty"`
	// The file's size in bytes at the commit; 0 when the commit has no such path.
	Size int64 `json:"size,omitempty"`
	Text string `json:"text,omitempty"`
	// The answer was cut at the limit the request named, so its end is not the file's.
	Truncated bool `json:"truncated,omitempty"`
	Chars     int  `json:"chars"`
}

// wikiRepoOpDiffAnswer is the diff's answer: every changed path with the status git gave it, and the
// design documents the range added or copied — what a maintenance run looks for.
type wikiRepoOpDiffAnswer struct {
	From  string                `json:"from"`
	To    string                `json:"to"`
	Files []wikiRepoOpDiffEntry `json:"files"`
	Docs  []string              `json:"docs"`
}

type wikiRepoOpDiffEntry struct {
	Status string `json:"status"`
	Path   string `json:"path"`
	// The path it came from, for a rename or a copy; empty otherwise.
	From string `json:"from,omitempty"`
}

// wikiRepoOpAnchorsAnswer is the anchors' answer: one check per anchor, in the order they were asked.
type wikiRepoOpAnchorsAnswer struct {
	Sha     string            `json:"sha"`
	Anchors []wikiAnchorCheck `json:"anchors"`
}

// ── the snapshot index ──────────────────────────────────────────────────────────────────────────

// wikiRepoOpIndex is what a snapshot is: everything the server's gates ask of a commit, built from one
// `ls-tree` and one `cat-file --batch` over origin/main (wiki_plan_repo.go), the reachable commits, and
// the README's first paragraph. The pipelines read it instead of the repository, so that a gate check is
// a lookup rather than a round trip per reference.
type wikiRepoOpIndex struct {
	Sha  string `json:"sha"`
	Date string `json:"date"`
	// Every blob of the tree, with its size: `hasPath` answers from this, directories included.
	Files []wikiRepoOpIndexFile `json:"files"`
	// Every document: its path, its title and its headings, which `hasDocSection` answers from.
	Docs []wikiRepoOpIndexDoc `json:"docs"`
	// Every source file's symbols, which `hasSymbol` answers from first.
	Symbols map[string][]string `json:"symbols"`
	// The contracts/ inventory: each file's size and its top-level keys.
	Contracts []wikiRepoOpIndexContract `json:"contracts"`
	// Every commit reachable from origin/main, which a commit anchor's reachability answers from.
	Commits []string `json:"commits"`
	// The README's first paragraph of prose, for a prompt that has to say what the repository is.
	Readme string `json:"readme"`
}

type wikiRepoOpIndexFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type wikiRepoOpIndexDoc struct {
	Path     string                `json:"path"`
	Title    string                `json:"title"`
	Headings []wikiPlanHeadingJSON `json:"headings"`
}

// wikiPlanHeadingJSON is one heading as the snapshot carries it: the level and the text, which is what
// `hasDocSection` compares against.
type wikiPlanHeadingJSON struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

type wikiRepoOpIndexContract struct {
	Path string   `json:"path"`
	Size int64    `json:"size"`
	Keys []string `json:"keys,omitempty"`
}

// ── the operation ───────────────────────────────────────────────────────────────────────────────

// runWikiRepoOp performs one claimed operation. `progress` is called at each step it reaches, best effort:
// a report that does not go out costs the control plane a phase, never the answer.
func runWikiRepoOp(cmd WikiRepoOpCommand, progress func()) wikiRepoOpOutcome {
	var input wikiRepoOpInput
	if raw, marshalErr := json.Marshal(cmd.Input); marshalErr == nil && len(raw) > 0 && string(raw) != "null" {
		if unmarshalErr := json.Unmarshal(raw, &input); unmarshalErr != nil {
			return wikiRepoOpFailed(fmt.Sprintf("the operation's input could not be read: %v", unmarshalErr))
		}
	}
	root, ref, err := wikiRepoOpCheckout(cmd, input)
	if err != nil {
		return wikiRepoOpFailed(err.Error())
	}
	switch cmd.Kind {
	case "snapshot":
		return wikiRepoOpSnapshot(cmd, root, ref, input)
	case "read":
		return wikiRepoOpRead(root, input)
	case "diff":
		return wikiRepoOpDiff(root, input)
	case "anchors":
		return wikiRepoOpAnchors(root, ref, input)
	default:
		return wikiRepoOpFailed(fmt.Sprintf("%s is not a repository operation this runner knows", cmd.Kind))
	}
}

func wikiRepoOpFailed(reason string) wikiRepoOpOutcome {
	return wikiRepoOpOutcome{state: "failed", err: reason}
}

func wikiRepoOpSucceeded(result map[string]interface{}) wikiRepoOpOutcome {
	return wikiRepoOpOutcome{state: "succeeded", result: result}
}

// wikiRepoOpCheckout is the checkout an operation reads, held to the space's repository before anything
// is read of it (design §7): the work directory is a git checkout, its origin is the space's repository,
// and it starts from the space's first commit. The fetch is part of it: a read of a stale origin/main
// would be an answer about a commit nobody asked about.
//
// Except where the operation names its commits. A read or a diff answers about the commits it was given,
// and a commit is the same text whichever fetch brought it: when the checkout already has every one of
// them, no fetch could change the answer and none is run — so the reads a job keeps in flight neither
// queue for the fetch lock nor race another fetch (fetchWikiOriginMain). The first commit is then asked
// of those commits themselves rather than of origin/main: each must start from it, or it is another
// repository's and nothing is read. The ref answered is "" — neither kind reads origin/main.
func wikiRepoOpCheckout(cmd WikiRepoOpCommand, input wikiRepoOpInput) (string, string, error) {
	workDir := expandTilde(strings.TrimSpace(cmd.WorkDir))
	if workDir == "" {
		return "", "", fmt.Errorf("the operation names no working directory to read the repository in")
	}
	root, err := wikiImportGit(workDir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return "", "", fmt.Errorf("%s is not a git checkout: %v", workDir, err)
	}
	if want := strings.TrimSpace(cmd.RepoURLNorm); want != "" {
		origin, _ := wikiImportGit(root, "remote", "get-url", "origin")
		if got := normalizeWikiRepoURL(origin); got != want {
			return "", "", fmt.Errorf("the checkout %s is a clone of %s, not of the space's repository %s: "+
				"nothing was read", root, firstNonEmpty(got, "no origin"), want)
		}
	}
	first := strings.ToLower(strings.TrimSpace(cmd.RootCommitSha))
	if local := wikiRepoOpLocalCommits(root, cmd.Kind, input); len(local) > 0 {
		for _, sha := range local {
			if first != "" && !wikiRepoOpStartsFrom(root, sha, first) {
				return "", "", fmt.Errorf("the commit %s in the checkout %s does not start from the space's first commit %s: "+
					"it is another repository's, so nothing was read", sha, root, first)
			}
		}
		return root, "", nil
	}
	// A failure here is read in the job's error: it says which operation, in which checkout, and what git said.
	if err := fetchWikiOriginMain(root); err != nil {
		return "", "", fmt.Errorf("the %s operation could not fetch origin main into the checkout %s, so nothing was read: %v",
			cmd.Kind, root, err)
	}
	out, code, stderr, err := wikiAnchorGit(root, wikiAnchorGitTimeout, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}")
	ref := strings.TrimSpace(string(out))
	if err != nil || code != 0 || !wikiCommitSha.MatchString(ref) {
		return "", "", fmt.Errorf("the %s operation found no commit at origin/main in the checkout %s after the fetch, so "+
			"nothing was read: %s", cmd.Kind, root, firstNonEmpty(strings.TrimSpace(stderr), errString(err), ref))
	}
	if first != "" && !wikiRepoOpStartsFrom(root, ref, first) {
		return "", "", fmt.Errorf("the checkout %s does not start from the space's first commit %s: "+
			"it is another repository behind the same URL, so nothing was read", root, first)
	}
	return root, ref, nil
}

// wikiRepoOpLocalCommits is the commits a read or a diff names, when the checkout already has every one of
// them; nil otherwise, and always for a snapshot or anchors, which ask about origin/main as it is now.
func wikiRepoOpLocalCommits(root, kind string, input wikiRepoOpInput) []string {
	var named []string
	switch kind {
	case "read":
		named = []string{input.Sha}
	case "diff":
		named = []string{input.From, input.To}
	}
	for i, sha := range named {
		named[i] = strings.ToLower(strings.TrimSpace(sha))
		if !wikiCommitSha.MatchString(named[i]) {
			return nil
		}
		if _, err := wikiImportGit(root, "cat-file", "-e", named[i]+"^{commit}"); err != nil {
			return nil
		}
	}
	return named
}

// wikiRepoOpStartsFrom says whether the history of commit starts from the space's first commit.
func wikiRepoOpStartsFrom(root, commit, first string) bool {
	roots, _ := wikiImportGit(root, "rev-list", "--max-parents=0", commit)
	return contains(strings.Fields(roots), first)
}

// ── snapshot ────────────────────────────────────────────────────────────────────────────────────

func wikiRepoOpSnapshot(cmd WikiRepoOpCommand, root, ref string, input wikiRepoOpInput) wikiRepoOpOutcome {
	if skip := strings.ToLower(strings.TrimSpace(input.SkipSha)); skip != "" && skip == ref {
		// The server already holds this commit: nothing is built and nothing is sent, and the answer says
		// which commit that is so the pipeline can go straight on.
		return wikiRepoOpSucceeded(map[string]interface{}{"sha": ref, "skipped": true})
	}
	repo, err := loadWikiPlanRepo(root, ref)
	if err != nil {
		return wikiRepoOpFailed(fmt.Sprintf("the tree at %s could not be read: %v", shortWikiHash(ref), err))
	}
	commits, err := wikiRepoOpReachable(root, ref)
	if err != nil {
		return wikiRepoOpFailed(err.Error())
	}
	index := wikiRepoOpIndex{Sha: ref, Date: repo.date, Commits: commits, Readme: wikiMaintainAbout(root, ref)}
	for _, file := range repo.files {
		index.Files = append(index.Files, wikiRepoOpIndexFile{Path: file, Size: repo.sizes[file]})
	}
	for _, file := range repo.docFiles() {
		title := ""
		headings := make([]wikiPlanHeadingJSON, 0, len(repo.headings[file]))
		for _, heading := range repo.headings[file] {
			if heading.Level == 1 && title == "" {
				title = heading.Text
			}
			headings = append(headings, wikiPlanHeadingJSON{Level: heading.Level, Text: heading.Text})
		}
		index.Docs = append(index.Docs, wikiRepoOpIndexDoc{Path: file, Title: title, Headings: headings})
	}
	index.Symbols = map[string][]string{}
	for file, symbols := range repo.symbols {
		index.Symbols[file] = symbols
	}
	for _, file := range repo.files {
		if !strings.HasPrefix(file, "contracts/") {
			continue
		}
		entry := wikiRepoOpIndexContract{Path: file, Size: repo.sizes[file]}
		var value interface{}
		if json.Unmarshal([]byte(repo.blobOf(file)), &value) == nil {
			if object, ok := value.(map[string]interface{}); ok {
				for key := range object {
					entry.Keys = append(entry.Keys, key)
				}
				sort.Strings(entry.Keys)
			}
		}
		index.Contracts = append(index.Contracts, entry)
	}
	payload, err := json.Marshal(index)
	if err != nil {
		return wikiRepoOpFailed(fmt.Sprintf("the snapshot could not be written: %v", err))
	}
	digest := sha256.Sum256(payload)
	outcome := wikiRepoOpOutcome{state: "succeeded", sha: ref}
	if len(payload) > wikiRepoOpInlineBytes {
		// Too large for one request body: the caller uploads it in fragments and the result names how many.
		outcome.payload = string(payload)
		return outcome
	}
	outcome.result = map[string]interface{}{
		"sha":       ref,
		"bytes":     len(payload),
		"digest":    hex.EncodeToString(digest[:]),
		"fragments": 1,
		"index":     string(payload),
	}
	return outcome
}

// wikiRepoOpReachable is every commit origin/main reaches, newest first: what a commit anchor's
// reachability is a membership test in, without asking git again per anchor.
func wikiRepoOpReachable(root, ref string) ([]string, error) {
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "rev-list", ref)
	if err != nil || code != 0 {
		return nil, fmt.Errorf("git rev-list %s failed in %s: %s", shortWikiHash(ref), root,
			firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	lines := strings.Fields(string(out))
	commits := make([]string, 0, len(lines))
	for _, line := range lines {
		if wikiCommitSha.MatchString(line) {
			commits = append(commits, line)
		}
	}
	return commits, nil
}

// ── read ────────────────────────────────────────────────────────────────────────────────────────

// wikiRepoOpRead answers with the whole text of what was asked — one file per item, at the commit named, up
// to wikiRepoOpWholeFileBytes each (owner 2026-10-08). A file over that limit is missing with `too_large` as
// the reason rather than cut: what a caller does with it is the same as with a path the commit does not
// have, and the reason says which of the two it is.
//
// A request that names a limit is answered within it, the way an older control plane asks (its window is one
// section's material, wikiRepoOpBoundedChars) — a new control plane names none and gets the file. The answer
// travels inside the result while it fits; above wikiRepoOpInlineBytes the caller uploads it in fragments,
// exactly as a snapshot's index is uploaded (wikiRepoOpFragments).
func wikiRepoOpRead(root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	sha := strings.ToLower(strings.TrimSpace(input.Sha))
	if !wikiCommitSha.MatchString(sha) {
		return wikiRepoOpFailed("a read names the commit to read at")
	}
	if _, err := wikiImportGit(root, "cat-file", "-e", sha+"^{commit}"); err != nil {
		return wikiRepoOpFailed(fmt.Sprintf("the checkout has no commit %s to read from", sha))
	}
	if len(input.Items) == 0 {
		return wikiRepoOpFailed("a read names what to read")
	}
	answer := wikiRepoOpReadAnswer{Sha: sha, Items: []wikiRepoOpReadPiece{}}
	for _, item := range input.Items {
		piece, err := wikiRepoOpReadOne(root, sha, item)
		if err != nil {
			return wikiRepoOpFailed(err.Error())
		}
		answer.Chars += piece.Chars
		answer.Items = append(answer.Items, piece)
	}
	payload, err := json.Marshal(answer)
	if err != nil {
		return wikiRepoOpFailed(fmt.Sprintf("the read could not be written: %v", err))
	}
	outcome := wikiRepoOpOutcome{state: "succeeded", sha: sha}
	if len(payload) > wikiRepoOpInlineBytes {
		// Too large for one request body: the caller uploads it in fragments and the result names how many,
		// under `read` — the answer's own key — so the server reassembles what it asked for.
		outcome.payload = string(payload)
		outcome.payloadKey = "read"
		return outcome
	}
	outcome.result = map[string]interface{}{"read": answer}
	return outcome
}

func wikiRepoOpReadOne(root, sha string, item wikiRepoOpReadItem) (wikiRepoOpReadPiece, error) {
	path := wikiAnchorPath(item.Path)
	piece := wikiRepoOpReadPiece{Path: item.Path, Section: item.Section}
	if path == "" {
		return piece, fmt.Errorf("a read item names no path")
	}
	text, exists, err := wikiRepoOpBlob(root, sha, path)
	if err != nil {
		return piece, err
	}
	if !exists {
		return piece, nil
	}
	piece.Size = int64(len(text))
	if piece.Size > wikiRepoOpWholeFileBytes {
		piece.Reason = "too_large"
		return piece, nil
	}
	piece.Found = true
	if section := strings.TrimSpace(item.Section); section != "" {
		text = wikiRepoOpSectionText(text, section)
	}
	if max := item.MaxChars; max > 0 {
		// A limit is what an older control plane asks by; it is honoured rather than ignored, and it is
		// never more than the window such a caller reads in.
		if max > wikiRepoOpBoundedChars {
			max = wikiRepoOpBoundedChars
		}
		text, piece.Truncated = wikiRepoOpCut(text, max)
	}
	piece.Text = text
	piece.Chars = len([]rune(text))
	return piece, nil
}

// wikiRepoOpCut is a text cut to at most max characters, saying so when it was. The marker is counted
// inside the limit rather than added to it, so what an item answers with is what it asked for: a caller
// reads the number the limit is about.
func wikiRepoOpCut(text string, max int) (string, bool) {
	runes := []rune(text)
	if len(runes) <= max {
		return text, false
	}
	marker := []rune(wikiRepoOpAfterwardsMarker)
	if len(marker) >= max {
		return string(runes[:max]), true
	}
	return string(runes[:max-len(marker)]) + wikiRepoOpAfterwardsMarker, true
}

// wikiRepoOpSectionText is one section of a Markdown document: the heading that reads as the named one and
// the lines under it, up to the next heading of its level or above — the same reading of a section the
// plan's gate does (wikiPlanFindSection), applied to the text instead of to the headings alone.
func wikiRepoOpSectionText(text, section string) string {
	lines := strings.Split(text, "\n")
	type heading struct {
		line  int
		level int
		text  string
	}
	fence := ""
	var headings []heading
	for index, line := range lines {
		if m := wikiPlanFence.FindStringSubmatch(line); m != nil {
			token := m[1][:3]
			if fence == "" {
				fence = token
			} else if token == fence {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		if m := wikiPlanHeadingLine.FindStringSubmatch(line); m != nil && strings.TrimSpace(m[2]) != "" {
			headings = append(headings, heading{line: index, level: len(m[1]), text: strings.TrimSpace(m[2])})
		}
	}
	want := wikiPlanHeadingKey(section)
	for i, h := range headings {
		if want == "" || wikiPlanHeadingKey(h.text) != want {
			continue
		}
		end := len(lines)
		for _, next := range headings[i+1:] {
			if next.level <= h.level {
				end = next.line
				break
			}
		}
		return strings.TrimRight(strings.Join(lines[h.line:end], "\n"), "\n")
	}
	// A section named by the heading it sits under, «parent - child», as the gate also accepts.
	for i, h := range headings {
		for _, cut := range wikiPlanHeadingPath.FindAllStringIndex(section, -1) {
			if wikiPlanHeadingKey(section[:cut[0]]) != wikiPlanHeadingKey(h.text) {
				continue
			}
			end := len(lines)
			for _, next := range headings[i+1:] {
				if next.level <= h.level {
					end = next.line
					break
				}
			}
			if inner := wikiRepoOpSectionText(strings.Join(lines[h.line:end], "\n"), section[cut[1]:]); inner != "" {
				return inner
			}
		}
	}
	return ""
}

// wikiRepoOpBlob is one file's text at a commit: `git show <sha>:<path>`, with the path spelled so a
// leading dash or a glob is a path and not an option. `exists` says whether the commit has the path at all,
// which an empty file and a missing one would otherwise answer alike.
func wikiRepoOpBlob(root, sha, path string) (string, bool, error) {
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "--literal-pathspecs", "show", sha+":"+path)
	switch {
	case err != nil:
		return "", false, fmt.Errorf("git show %s:%s: %v", sha, path, err)
	case code == 0:
		return string(out), true, nil
	case wikiGitSaysAbsent(code, stderr):
		return "", false, nil
	}
	return "", false, fmt.Errorf("git show %s:%s exited %d: %s", sha, path, code, strings.TrimSpace(stderr))
}

// ── diff ────────────────────────────────────────────────────────────────────────────────────────

func wikiRepoOpDiff(root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	from := strings.ToLower(strings.TrimSpace(input.From))
	to := strings.ToLower(strings.TrimSpace(input.To))
	if !wikiCommitSha.MatchString(from) || !wikiCommitSha.MatchString(to) {
		return wikiRepoOpFailed("a diff names the two commits to compare")
	}
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "diff", "--name-status", "-M", "-z", from, to)
	if err != nil || code != 0 {
		return wikiRepoOpFailed(fmt.Sprintf("git diff %s..%s failed: %s", shortWikiHash(from), shortWikiHash(to),
			firstNonEmpty(strings.TrimSpace(stderr), errString(err))))
	}
	answer := wikiRepoOpDiffAnswer{From: from, To: to, Files: []wikiRepoOpDiffEntry{}}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		status := strings.TrimSpace(fields[i])
		if status == "" {
			continue
		}
		entry := wikiRepoOpDiffEntry{Status: status}
		next := func() string {
			for i+1 < len(fields) {
				i++
				if fields[i] != "" {
					return fields[i]
				}
			}
			return ""
		}
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			// A rename or a copy names where it came from and where it went.
			entry.From = next()
			entry.Path = next()
		} else {
			entry.Path = next()
		}
		if entry.Path == "" {
			continue
		}
		answer.Files = append(answer.Files, entry)
	}
	docs, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "diff", "--diff-filter=AR", "--name-only", "-z", from, to, "--", "docs/")
	if err != nil || code != 0 {
		return wikiRepoOpFailed(fmt.Sprintf("git diff --diff-filter=AR -- docs/ failed: %s",
			firstNonEmpty(strings.TrimSpace(stderr), errString(err))))
	}
	answer.Docs = []string{}
	for _, path := range strings.Split(string(docs), "\x00") {
		if path != "" {
			answer.Docs = append(answer.Docs, path)
		}
	}
	return wikiRepoOpSucceeded(map[string]interface{}{"diff": answer})
}

// ── anchors ─────────────────────────────────────────────────────────────────────────────────────

// wikiRepoOpAnchors reuses the maintenance run's own checks (wiki_anchors.go): one state per anchor, and
// git failing to check one is the operation failing rather than an anchor coming back `missing`.
func wikiRepoOpAnchors(root, ref string, input wikiRepoOpInput) wikiRepoOpOutcome {
	sha := strings.ToLower(strings.TrimSpace(input.Sha))
	if sha != "" && wikiCommitSha.MatchString(sha) {
		// A named commit is the one to check against, when this checkout has it: the snapshot's commit is
		// what the entry's anchors were written against, and origin/main may have moved since.
		if _, err := wikiImportGit(root, "cat-file", "-e", sha+"^{commit}"); err == nil {
			ref = sha
		}
	}
	answer := wikiRepoOpAnchorsAnswer{Sha: ref, Anchors: []wikiAnchorCheck{}}
	for _, anchor := range input.Anchors {
		check, err := checkWikiAnchor(root, ref, anchor)
		if err != nil {
			return wikiRepoOpFailed(fmt.Sprintf("git could not check anchor %d (%s %s): %v",
				anchor.Index, anchor.Type, anchor.Path+anchor.Symbol+anchor.Sha, err))
		}
		answer.Anchors = append(answer.Anchors, check)
	}
	return wikiRepoOpSucceeded(map[string]interface{}{"anchors": answer})
}

// ── fragments ───────────────────────────────────────────────────────────────────────────────────

// wikiRepoOpFragments cuts a payload into the pieces the result uploads, each within the contract's
// fragment size. The server reassembles them by ordinal and hashes the whole, so this is a plain split of
// bytes and the last piece is whatever is left.
func wikiRepoOpFragments(payload string) []string {
	runes := []rune(payload)
	var out []string
	start, used := 0, 0
	for index, r := range runes {
		width := len(string(r))
		if used+width > wikiRepoOpFragmentBytes && index > start {
			out = append(out, string(runes[start:index]))
			start, used = index, 0
		}
		used += width
	}
	if start < len(runes) {
		out = append(out, string(runes[start:]))
	}
	if len(out) == 0 {
		out = []string{""}
	}
	return out
}

// ── the run and its report ──────────────────────────────────────────────────────────────────────

// errWikiRepoOpPayloadWindowSpent is what an upload that ran out of window before a piece could be
// staged reports. It is not an answer from the control plane — it is this process's own ending — so the
// result that follows says the payload was never uploaded, which is what happened.
var errWikiRepoOpPayloadWindowSpent = errors.New("the payload could not be uploaded before the window a result is worth sending inside was spent")

// runWikiRepoOpAndReport performs one claimed operation and reports what it came to, the way an
// integration job does (integrate.go): a payload too large for one request body is uploaded as fragments
// first, and the result that follows names what they reassemble to. Both the fragments and the result are
// sent again while they can still be used — inside the window the claim opened — and an answer that
// settles the matter, 2xx, 409 STALE_CLAIM, 404, 400 INVALID_RESULT or 422 UNSTORABLE_RESULT among them,
// ends the sending there (wiki_repo_op_retry.go). ctx is the run loop's: it says the runner is draining,
// which ends the retrying but never the operations still owed to the control plane — a stop still sends
// them, once each.
func runWikiRepoOpAndReport(ctx context.Context, t *Transport, cmd WikiRepoOpCommand) {
	// The window runs from the claim: this process was handed the operation by the heartbeat that claimed
	// it, so this is when its life — and the usefulness of anything reported about it — started.
	deadline := wikiRepoOpRetry.deadline(wikiRepoOpRetry.now())
	logln("wiki repo op", cmd.ID, cmd.Kind, "in", cmd.WorkDir)
	renew := func() {
		// Best effort: the renewal matters, what it reports does not, and the work carries on either way.
		if err := t.wikiRepoOpProgress(cmd.ID, WikiRepoOpProgressRequest{
			ClaimGeneration: cmd.ClaimGeneration,
			LeaseOwner:      cmd.LeaseOwner,
		}); err != nil && isLeaseOwnershipError(err) {
			logln("wiki repo op", cmd.ID, "renewal refused:", err)
		}
	}
	outcome := runWikiRepoOp(cmd, renew)
	body := WikiRepoOpResultRequest{
		ClaimGeneration: cmd.ClaimGeneration,
		LeaseOwner:      cmd.LeaseOwner,
		State:           outcome.state,
		Result:          outcome.result,
		Error:           outcome.err,
	}
	if outcome.state == "succeeded" && outcome.payload != "" {
		fragments := wikiRepoOpFragments(outcome.payload)
		uploadErr := uploadWikiRepoOpFragments(ctx, t, cmd, outcome.sha, fragments, deadline)
		if uploadErr != nil && !wikiRepoOpResultWorthSendingAgain(uploadErr) {
			// The control plane answered for good about this operation — each of those answers settles it —
			// so there is nothing left for a result to say. A runner that is stopping is not that case: it
			// still reports the failure below, once.
			return
		}
		if uploadErr != nil {
			// Not settled with a payload that is not all there: the server would refuse the digest, and the
			// next attempt builds the snapshot (or reads the files) again.
			body.State = "failed"
			body.Result = nil
			body.Error = fmt.Sprintf("the %s payload (%d bytes, %d fragments) could not be uploaded: %v",
				cmd.Kind, len(outcome.payload), len(fragments), uploadErr)
		} else {
			digest := sha256.Sum256([]byte(outcome.payload))
			shape := map[string]interface{}{
				"sha":       outcome.sha,
				"bytes":     len(outcome.payload),
				"digest":    hex.EncodeToString(digest[:]),
				"fragments": len(fragments),
			}
			if outcome.payloadKey != "" {
				// The kind nests its answer (a read's under `read`); a snapshot's index is the result itself.
				body.Result = map[string]interface{}{outcome.payloadKey: shape}
			} else {
				body.Result = shape
			}
			logln("wiki repo op", cmd.ID, cmd.Kind, "payload uploaded:",
				fmt.Sprintf("%d bytes in %d fragments", len(outcome.payload), len(fragments)))
		}
	}
	reportWikiRepoOpResult(ctx, t, cmd, body, deadline)
}

// uploadWikiRepoOpFragments sends every piece of a payload, each within the contract's fragment size and
// each sent again on its own — the route stages a piece by its ordinal, so sending one again is sending
// the same piece. The retrying is the result's: the same capped, jittered wait, and the same window, so a
// payload that cannot be staged before the operation stops being this process's to report is given up on.
// An answer that settles the matter ends the upload at once: 409 STALE_CLAIM (the claim moved on), 404,
// 400 INVALID_RESULT or 422 UNSTORABLE_RESULT — each of the last two has already failed the operation at
// the control plane, so no fragment after it is worth sending either.
//
// The caller's context is the runner's state, not the send's (wiki_repo_op_retry.go): every piece still
// unstaged when the runner is stopping is sent once — pieces that succeed go on being sent, since the
// payload is worthless incomplete — and a piece that fails ends the upload there rather than being waited
// out.
func uploadWikiRepoOpFragments(ctx context.Context, t *Transport, cmd WikiRepoOpCommand, sha string, fragments []string, deadline time.Time) error {
	p := wikiRepoOpRetry
	for index, content := range fragments {
		what := fmt.Sprintf("fragment %d/%d", index+1, len(fragments))
		if !p.fits(deadline, 0) {
			// The pieces before this one took the window: nothing staged now could be part of a result
			// anybody still reads.
			logln("wiki repo op", cmd.ID, what, "not staged and the window a result is worth sending inside is spent, so the upload stops")
			return errWikiRepoOpPayloadWindowSpent
		}
		body := WikiRepoOpFragmentRequest{
			ClaimGeneration: cmd.ClaimGeneration,
			LeaseOwner:      cmd.LeaseOwner,
			Sha:             sha,
			Index:           index,
			Total:           len(fragments),
			Content:         content,
		}
		for attempt := 1; ; attempt++ {
			_, err := t.wikiRepoOpFragment(cmd.ID, body) // no context of the caller's: see sendWikiRepoOpResult
			if err == nil {
				break
			}
			if !wikiRepoOpResultWorthSendingAgain(err) {
				logln("wiki repo op", cmd.ID, what, "refused, so the upload stops:", err)
				return err
			}
			if ctx.Err() != nil {
				logln("wiki repo op", cmd.ID, what, "not staged, and this runner is stopping, so it is not sent again:", err)
				return err
			}
			wait := p.wait(attempt)
			if !p.fits(deadline, wait) {
				logln("wiki repo op", cmd.ID, what, fmt.Sprintf("not staged on attempt %d:", attempt), err,
					"and the window it is worth sending inside is spent, so the upload stops")
				return err
			}
			logln("wiki repo op", cmd.ID, what, fmt.Sprintf("not staged on attempt %d:", attempt), err,
				"sending it again in", wait.Round(100*time.Millisecond))
			p.sleep(ctx, wait)
		}
	}
	return nil
}
