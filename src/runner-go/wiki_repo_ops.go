package main

import (
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
	wikiRepoOpAfterwardsMarker = "\n…（后略）\n"
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
	root, ref, err := wikiRepoOpCheckout(cmd)
	if err != nil {
		return wikiRepoOpFailed(err.Error())
	}
	var input wikiRepoOpInput
	if raw, marshalErr := json.Marshal(cmd.Input); marshalErr == nil && len(raw) > 0 && string(raw) != "null" {
		if unmarshalErr := json.Unmarshal(raw, &input); unmarshalErr != nil {
			return wikiRepoOpFailed(fmt.Sprintf("the operation's input could not be read: %v", unmarshalErr))
		}
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
func wikiRepoOpCheckout(cmd WikiRepoOpCommand) (string, string, error) {
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
	ref, err := fetchWikiAnchorsRef(root)
	if err != nil {
		return "", "", fmt.Errorf("the checkout %s could not be fetched: %w", root, err)
	}
	if sha := strings.ToLower(strings.TrimSpace(cmd.RootCommitSha)); sha != "" {
		roots, _ := wikiImportGit(root, "rev-list", "--max-parents=0", ref)
		if !contains(strings.Fields(roots), sha) {
			return "", "", fmt.Errorf("the checkout %s does not start from the space's first commit %s: "+
				"it is another repository behind the same URL, so nothing was read", root, sha)
		}
	}
	return root, ref, nil
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

// runWikiRepoOpAndReport performs one claimed operation and reports what it came to, the way an
// integration job does (integrate.go): a payload too large for one request body is uploaded as fragments
// first, and the result that follows names what they reassemble to. A 4xx is final — the claim is no
// longer this process's — and anything else is tried again, because the operation is done either way and
// a result that never arrives is work nobody is credited for.
func runWikiRepoOpAndReport(t *Transport, cmd WikiRepoOpCommand) {
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
		if err := uploadWikiRepoOpFragments(t, cmd, outcome.sha, fragments); err != nil {
			// Not settled with a payload that is not all there: the server would refuse the digest, and the
			// next attempt builds the snapshot (or reads the files) again.
			body.State = "failed"
			body.Result = nil
			body.Error = fmt.Sprintf("the %s payload (%d bytes, %d fragments) could not be uploaded: %v",
				cmd.Kind, len(outcome.payload), len(fragments), err)
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
	for attempt := 0; attempt < 5; attempt++ {
		answer, err := t.wikiRepoOpResult(cmd.ID, body)
		if err == nil {
			logln("wiki repo op", cmd.ID, "reported", outcome.state, fmt.Sprintf("accepted=%v", answer.Accepted))
			return
		}
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode >= 400 && httpErr.statusCode < 500 {
			logln("wiki repo op", cmd.ID, "result refused:", err)
			return
		}
		logln("wiki repo op", cmd.ID, "result not delivered, retrying:", err)
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
	}
}

// uploadWikiRepoOpFragments sends every piece of a payload, each within the contract's fragment size and
// each retried on its own: the route stages a piece by its ordinal, so sending one again is sending the
// same piece.
func uploadWikiRepoOpFragments(t *Transport, cmd WikiRepoOpCommand, sha string, fragments []string) error {
	for index, content := range fragments {
		var last error
		for attempt := 0; attempt < 3; attempt++ {
			_, err := t.wikiRepoOpFragment(cmd.ID, WikiRepoOpFragmentRequest{
				ClaimGeneration: cmd.ClaimGeneration,
				LeaseOwner:      cmd.LeaseOwner,
				Sha:             sha,
				Index:           index,
				Total:           len(fragments),
				Content:         content,
			})
			if err == nil {
				last = nil
				break
			}
			last = err
			var httpErr *transportHTTPError
			if errors.As(err, &httpErr) && httpErr.statusCode >= 400 && httpErr.statusCode < 500 {
				break
			}
			time.Sleep(time.Duration(attempt+1) * time.Second)
		}
		if last != nil {
			return last
		}
	}
	return nil
}
