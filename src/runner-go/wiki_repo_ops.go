package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The wiki's repository operations (contracts/wiki.contract.json `repoOps`,
// docs/wiki-server-execution-design.md §7).
//
// THE SERVER RUNS THE PIPELINES AND HOLDS NO REPOSITORY. Git's credentials are here, so a step that has
// to know what the repository says asks this machine: a snapshot to be built once per commit, a bounded
// read of the text it needs, a diff between two commits, the anchor checks, or what changed under an entry's
// paths. Nothing here creates an agent session, takes a concurrency slot, or touches a model — the operative
// sentence of the design's G2.
//
// The five questions, and what each answers with:
//
//   snapshot   every path of origin/main with its size, every document's title and headings, every source
//              file's symbols, the contracts' shapes, the commits reachable from origin/main, and the
//              README's first paragraph. Above `wikiRepoOpInlineBytes` it travels in fragments.
//   read       the whole text of given paths at a given commit (owner 2026-10-08), one file up to
//              `wikiRepoOpWholeFileBytes` — a larger one is missing, with `too_large` as the reason — and
//              an answer too large for one request body uploaded in fragments, as a snapshot is. A request
//              that names a limit is answered within it, the way an older control plane asks.
//   diff       `--name-status -M` between two commits, and the design documents the range added.
//   anchors    each path, symbol and commit anchor checked with git (wiki_anchors.go).
//   history    for each entry of the claim recheck (docs/wiki-claim-recheck-design.md §3.1), between its base
//              and a given commit: how many lines of its paths hold each of its terms, which of the paths
//              themselves moved, and whether they changed — and for an entry the model is asked about, the
//              commits, the lines and the diff it reads.
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

// wikiRepoOpInput is one kind's material, all five kinds in one shape: a snapshot's skip sha, a read's
// commit and items, a diff's two commits, an anchors op's anchors, a history's commit and entries.
type wikiRepoOpInput struct {
	// snapshot: the commit the server already holds for this space, skipped when the fetch resolves to it.
	SkipSha string `json:"skipSha,omitempty"`
	// read: the commit to read at, and what to read of it.
	Sha   string               `json:"sha,omitempty"`
	Items []wikiRepoOpReadItem `json:"items,omitempty"`
	// diff: the two commits, oldest first. A history's `to` is the commit it looks at.
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// anchors: what to check, at the commit the snapshot was taken at.
	Anchors []wikiDueAnchor `json:"anchors,omitempty"`
	// history: the entries to answer about, in the order they are answered.
	Entries []wikiRepoOpHistoryItem `json:"entries,omitempty"`
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
	Size int64  `json:"size,omitempty"`
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
	case "history":
		return wikiRepoOpHistory(root, input)
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
// Except where the operation names its commits. A read, a diff or a history answers about the commits it
// was given, and a commit is the same text whichever fetch brought it: when the checkout already has every
// one of them, no fetch could change the answer and none is run — so the reads a job keeps in flight neither
// queue for the fetch lock nor race another fetch (fetchWikiOriginMain). The first commit is then asked
// of those commits themselves rather than of origin/main: each must start from it, or it is another
// repository's and nothing is read. The ref answered is "" — none of these kinds reads origin/main.
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

// wikiRepoOpLocalCommits is the commits a read, a diff or a history names, when the checkout already has
// every one of them; nil otherwise, and always for a snapshot or anchors, which ask about origin/main as it
// is now.
func wikiRepoOpLocalCommits(root, kind string, input wikiRepoOpInput) []string {
	var named []string
	switch kind {
	case "read":
		named = []string{input.Sha}
	case "diff":
		named = []string{input.From, input.To}
	case "history":
		// The commit looked at, and every commit an entry looks back from, each once: many entries share the
		// commit they were screened at last. An entry that names a time looks back along `to`'s own first
		// parents, which a checkout that has `to` has.
		named = []string{strings.ToLower(strings.TrimSpace(input.To))}
		for _, entry := range input.Entries {
			if from := strings.ToLower(strings.TrimSpace(entry.From)); from != "" && !contains(named, from) {
				named = append(named, from)
			}
		}
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

var (
	wikiRepoSCP    = regexp.MustCompile(`^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]\S*)$`)
	wikiRepoScheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	wikiRepoRemote = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*)://(?:[^@/]*@)?([^/]*)(.*)$`)
)

// normalizeWikiRepoURL is the server's normalizeRepoUrl (canonicalRepoUrl, then no scheme, no trailing / or
// .git): `git@github.com:a/b.git` and `https://github.com/a/b` both read `github.com/a/b`.
func normalizeWikiRepoURL(raw string) string {
	u := strings.TrimSpace(raw)
	if m := wikiRepoSCP.FindStringSubmatch(u); m != nil && !wikiRepoScheme.MatchString(u) {
		u = "ssh://" + m[1] + "/" + m[2]
	}
	if m := wikiRepoRemote.FindStringSubmatch(u); m != nil {
		u = strings.ToLower(m[1]) + "://" + strings.ToLower(m[2]) + m[3]
	}
	trim := func(s string) string {
		for {
			next := strings.TrimSuffix(strings.TrimRight(s, "/"), ".git")
			if next == s {
				return s
			}
			s = next
		}
	}
	return trim(wikiRepoScheme.ReplaceAllString(trim(u), ""))
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

// How much of a repository's README tells the model what the repository is.
const wikiMaintainAboutMaxChars = 300

var (
	wikiMaintainTag      = regexp.MustCompile(`<[^>]*>`)
	wikiMaintainMdLink   = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	wikiMaintainEmphasis = regexp.MustCompile("[*_`]{1,3}")
)

// wikiMaintainAbout is a sentence or two of what the repository is: the first paragraph of its README on
// origin/main that says something, markup taken out. Empty when there is none.
func wikiMaintainAbout(root, ref string) string {
	readme, err := wikiImportGit(root, "show", ref+":README.md")
	if err != nil {
		return ""
	}
	for _, paragraph := range strings.Split(readme, "\n\n") {
		text := wikiMaintainTag.ReplaceAllString(paragraph, " ")
		text = wikiMaintainMdLink.ReplaceAllString(text, "$1")
		text = wikiMaintainEmphasis.ReplaceAllString(html.UnescapeString(text), "")
		text = strings.Join(strings.Fields(text), " ")
		if strings.HasPrefix(text, "#") || len([]rune(text)) < 40 {
			continue
		}
		return cutRunes(text, wikiMaintainAboutMaxChars)
	}
	return ""
}

func cutRunes(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max])
}

// shortWikiHash is enough of a commit's hash to tell two apart at a glance.
func shortWikiHash(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
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
// server's plan gate does (wiki-plan-repo.ts wikiPlanFindSection), applied to the text instead of to the
// headings alone.
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

// wikiRepoOpAnchors runs the anchor checks of wiki_anchors.go: one state per anchor, and
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

// ── history ─────────────────────────────────────────────────────────────────────────────────────

// The history's limits (contract `repoOps.kindRuns.history`, docs/wiki-claim-recheck-design.md §3.1): how many
// entries one operation answers and how many of them in detail, and how much of one entry its answer carries.
const (
	wikiRepoOpHistoryMaxEntries  = 500
	wikiRepoOpHistoryMaxDetailed = 40
	wikiRepoOpHistoryMaxTerms    = 8
	wikiRepoOpHistoryTermBytes   = 200
	wikiRepoOpHistoryMaxCommits  = 20
	wikiRepoOpHistoryMaxLines    = 40
	wikiRepoOpHistoryTextRunes   = 200
	wikiRepoOpHistoryDiffBytes   = 6000
)

// wikiRepoOpHistoryItem is one entry a history asks about: where it looks back from — a commit (`from`), or a
// time (`since`), whose first-parent commit of `to` is then the base — the paths it names, the terms it talks
// about, and whether the model is asked about it (`detail`), which adds what the model reads to the screen.
type wikiRepoOpHistoryItem struct {
	ID     string   `json:"id"`
	From   string   `json:"from,omitempty"`
	Since  string   `json:"since,omitempty"`
	Paths  []string `json:"paths,omitempty"`
	Terms  []string `json:"terms,omitempty"`
	Detail bool     `json:"detail,omitempty"`
}

// wikiRepoOpHistoryAnswer is the history's answer: the commit looked at, its date, and one answer per entry in
// the order they were asked — a wikiRepoOpHistoryScreen, a wikiRepoOpHistoryDetail for an entry asked in detail,
// or a wikiRepoOpHistoryRefusal for one that could not be answered.
type wikiRepoOpHistoryAnswer struct {
	Sha     string        `json:"sha"`
	Date    string        `json:"date"`
	Entries []interface{} `json:"entries"`
}

// wikiRepoOpHistoryRefusal is an entry that could not be answered, and why.
type wikiRepoOpHistoryRefusal struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// wikiRepoOpHistoryScreen is what every answered entry gets, the screen (design §2.3): its base and the base's
// date, how many lines of its paths hold each term at the base and at `to`, which of its paths themselves were
// added, deleted or renamed, and whether its paths changed at all.
type wikiRepoOpHistoryScreen struct {
	ID       string                    `json:"id"`
	Base     string                    `json:"base"`
	BaseDate string                    `json:"baseDate"`
	Census   []wikiRepoOpHistoryCensus `json:"census"`
	Moved    []string                  `json:"moved"`
	Changed  bool                      `json:"changed"`
}

type wikiRepoOpHistoryCensus struct {
	Term string `json:"term"`
	Base int    `json:"base"`
	Head int    `json:"head"`
}

// wikiRepoOpHistoryDetail is an asked entry's answer: the screen, and the material the model judges from.
type wikiRepoOpHistoryDetail struct {
	wikiRepoOpHistoryScreen
	Commits       []wikiRepoOpHistoryCommit `json:"commits"`
	CommitsTotal  int                       `json:"commitsTotal"`
	Lines         []wikiRepoOpHistoryLine   `json:"lines"`
	LinesTotal    int                       `json:"linesTotal"`
	Diff          string                    `json:"diff"`
	DiffTruncated bool                      `json:"diffTruncated"`
}

type wikiRepoOpHistoryCommit struct {
	Sha     string `json:"sha"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
	// git log -S found that it changed how many times one of the terms occurs.
	Matched bool `json:"matched"`
}

type wikiRepoOpHistoryLine struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// wikiRepoOpHistory answers what the claim recheck asks of entries' paths (docs/wiki-claim-recheck-design.md
// §2.3 and §3.1). For every entry, between its base and `to`: how many lines of its paths hold each of its terms,
// which of the paths themselves were added, deleted or renamed, and whether the paths changed at all — the
// screen, which no model reads. For an entry the model is asked about (`detail`), also the commits that touched
// its paths, each marked when it changed how often a term occurs, the lines at `to` that hold a term, and the
// diff, the hunks that mention a term first — what the model judges from.
//
// AN ENTRY'S PROBLEM IS ITS OWN. No base to be found, no path to look at, git failing on one entry's paths:
// that entry answers with its error, and the others are answered. Only what every entry stands on fails the
// operation — the commit looked at, the limits, and git failing outside any entry.
//
// THE SAME QUESTION IS THE SAME ANSWER. Every list keeps git's order or the order it was asked in, and nothing
// in it depends on the clock or the machine: a recheck that asks again reads what it read before.
func wikiRepoOpHistory(root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	to := strings.ToLower(strings.TrimSpace(input.To))
	if !wikiCommitSha.MatchString(to) {
		return wikiRepoOpFailed("a history names the commit to look at")
	}
	if _, err := wikiImportGit(root, "cat-file", "-e", to+"^{commit}"); err != nil {
		return wikiRepoOpFailed(fmt.Sprintf("the checkout has no commit %s to look at", to))
	}
	if len(input.Entries) > wikiRepoOpHistoryMaxEntries {
		return wikiRepoOpFailed(fmt.Sprintf("a history asks about %d entries, more than the %d one operation answers",
			len(input.Entries), wikiRepoOpHistoryMaxEntries))
	}
	detailed := 0
	for _, entry := range input.Entries {
		if entry.Detail {
			detailed++
		}
	}
	if detailed > wikiRepoOpHistoryMaxDetailed {
		return wikiRepoOpFailed(fmt.Sprintf("a history asks about %d entries in detail, more than the %d one operation "+
			"answers in detail", detailed, wikiRepoOpHistoryMaxDetailed))
	}
	date, err := wikiRepoOpCommitDate(root, to)
	if err != nil {
		return wikiRepoOpFailed(err.Error())
	}
	answer := wikiRepoOpHistoryAnswer{Sha: to, Date: date, Entries: []interface{}{}}
	for _, entry := range input.Entries {
		answer.Entries = append(answer.Entries, wikiRepoOpHistoryOne(root, to, entry))
	}
	return wikiRepoOpSucceeded(map[string]interface{}{"history": answer})
}

// wikiRepoOpHistoryOne answers one entry, or says why it cannot be answered.
func wikiRepoOpHistoryOne(root, to string, item wikiRepoOpHistoryItem) interface{} {
	refuse := func(reason string) interface{} { return wikiRepoOpHistoryRefusal{ID: item.ID, Error: reason} }
	if strings.TrimSpace(item.ID) == "" {
		return refuse("the entry names no id")
	}
	paths := wikiRepoOpHistoryPaths(item.Paths)
	if len(paths) == 0 {
		return refuse(`the entry names no path to look at: an empty path, or one with a "." or ".." part, names none`)
	}
	terms := wikiRepoOpHistoryTerms(item.Terms)
	base, err := wikiRepoOpHistoryBase(root, to, item)
	if err != nil {
		return refuse(err.Error())
	}
	screen := wikiRepoOpHistoryScreen{ID: item.ID, Base: base, Census: []wikiRepoOpHistoryCensus{}}
	if screen.BaseDate, err = wikiRepoOpCommitDate(root, base); err != nil {
		return refuse(err.Error())
	}
	for _, term := range terms {
		count := wikiRepoOpHistoryCensus{Term: term}
		if count.Base, err = wikiRepoOpHistoryCount(root, base, term, paths); err != nil {
			return refuse(err.Error())
		}
		if count.Head, err = wikiRepoOpHistoryCount(root, to, term, paths); err != nil {
			return refuse(err.Error())
		}
		screen.Census = append(screen.Census, count)
	}
	if screen.Moved, err = wikiRepoOpHistoryMoved(root, base, to, paths); err != nil {
		return refuse(err.Error())
	}
	// `git diff --quiet` says whether the paths differ at all: 1 when they do, 0 when they do not.
	_, code, err := wikiRepoOpHistoryGit(root, paths, 1, "diff", "--quiet", base, to)
	if err != nil {
		return refuse(err.Error())
	}
	screen.Changed = code == 1
	if !item.Detail {
		return screen
	}
	detail := wikiRepoOpHistoryDetail{wikiRepoOpHistoryScreen: screen}
	if detail.Commits, detail.CommitsTotal, err = wikiRepoOpHistoryCommits(root, base, to, terms, paths); err != nil {
		return refuse(err.Error())
	}
	if detail.Lines, detail.LinesTotal, err = wikiRepoOpHistoryLines(root, to, terms, paths); err != nil {
		return refuse(err.Error())
	}
	if detail.Diff, detail.DiffTruncated, err = wikiRepoOpHistoryDiff(root, base, to, terms, paths); err != nil {
		return refuse(err.Error())
	}
	return detail
}

// wikiRepoOpHistoryPaths is an entry's paths as git names them inside a tree (wikiAnchorPath), in the order given
// and each once. A path with a "." or ".." part names nothing in a tree, and an empty one names the whole of it:
// both are left out, as is one git cannot be handed at all (a NUL in it).
func wikiRepoOpHistoryPaths(raw []string) []string {
	paths := []string{}
	for _, path := range raw {
		path = wikiAnchorPath(path)
		if path == "" || strings.ContainsRune(path, 0) || contains(paths, path) {
			continue
		}
		named := true
		for _, part := range strings.Split(path, "/") {
			if part == "." || part == ".." {
				named = false
			}
		}
		if named {
			paths = append(paths, path)
		}
	}
	return paths
}

// wikiRepoOpHistoryTerms is an entry's terms as git looks for them: trimmed, the empty ones and the ones over
// wikiRepoOpHistoryTermBytes left out, and the first wikiRepoOpHistoryMaxTerms of the rest. A term with a line
// break in it is left out too: no line can hold it, and git grep would read each of its lines as a term of its
// own — as is one with a NUL, which git cannot be handed.
func wikiRepoOpHistoryTerms(raw []string) []string {
	terms := []string{}
	for _, term := range raw {
		term = strings.TrimSpace(term)
		if term == "" || len(term) > wikiRepoOpHistoryTermBytes || strings.ContainsAny(term, "\n\x00") {
			continue
		}
		terms = append(terms, term)
		if len(terms) == wikiRepoOpHistoryMaxTerms {
			break
		}
	}
	return terms
}

// wikiRepoOpHistoryBase is the commit an entry looks back from: `from` when it names one, which the checkout must
// have; else the first-parent commit of `to` before `since`, the history of main as it was at that time — or, when
// `since` is older than all of it, the first commit of that line.
//
// The time is read here, as RFC 3339, and handed to git as seconds: git reads any word as a date, one it does not
// know as "now", and an entry that looked back to now would be screened against nothing.
func wikiRepoOpHistoryBase(root, to string, item wikiRepoOpHistoryItem) (string, error) {
	if from := strings.ToLower(strings.TrimSpace(item.From)); from != "" {
		if !wikiCommitSha.MatchString(from) {
			return "", errors.New("the entry's from is not a commit's full sha")
		}
		if _, err := wikiImportGit(root, "cat-file", "-e", from+"^{commit}"); err != nil {
			return "", fmt.Errorf("the checkout has no commit %s to look back from", from)
		}
		return from, nil
	}
	since := strings.TrimSpace(item.Since)
	if since == "" {
		return "", errors.New("the entry names neither a commit to look back from nor a time to look back to")
	}
	at, err := time.Parse(time.RFC3339, since)
	if err != nil {
		return "", errors.New("the entry's since is not an RFC 3339 time")
	}
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "rev-list", "-1", "--first-parent",
		fmt.Sprintf("--before=@%d +0000", at.Unix()), to)
	if err != nil || code != 0 {
		return "", fmt.Errorf("git rev-list --before %s failed: %s", since, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	if base := strings.TrimSpace(string(out)); base != "" {
		return base, nil
	}
	out, code, stderr, err = wikiAnchorGit(root, wikiRepoOpGitTimeout, "rev-list", "--first-parent", "--max-parents=0", to)
	if err != nil || code != 0 {
		return "", fmt.Errorf("git rev-list --max-parents=0 %s failed: %s", shortWikiHash(to),
			firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	roots := strings.Fields(string(out))
	if len(roots) == 0 {
		return "", fmt.Errorf("git rev-list --max-parents=0 %s found no first commit", shortWikiHash(to))
	}
	return roots[0], nil
}

// wikiRepoOpCommitDate is a commit's committer date, as git writes it in strict ISO 8601.
func wikiRepoOpCommitDate(root, sha string) (string, error) {
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, "log", "-1", "--format=%cI", sha)
	date := strings.TrimSpace(string(out))
	if err != nil || code != 0 || date == "" {
		return "", fmt.Errorf("git log -1 %s failed: %s", shortWikiHash(sha), firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	return date, nil
}

// wikiRepoOpHistoryGit runs one git command over an entry's paths, spelled so that a glob or a leading dash is a
// path (--literal-pathspecs, and after --), and answers its output and its exit code. `answer` is the one exit
// besides 0 that is an answer rather than a failure — 1, from a grep that found nothing or a diff --quiet that
// found a difference — or 0 for none. Any other exit is git failing, in git's own words.
func wikiRepoOpHistoryGit(root string, paths []string, answer int, args ...string) ([]byte, int, error) {
	full := append(append(append([]string{"--literal-pathspecs"}, args...), "--"), paths...)
	out, code, stderr, err := wikiAnchorGit(root, wikiRepoOpGitTimeout, full...)
	if err != nil {
		return nil, 0, fmt.Errorf("git %s failed: %v", args[0], err)
	}
	if code != 0 && code != answer {
		return nil, 0, fmt.Errorf("git %s exited %d: %s", args[0], code, strings.TrimSpace(stderr))
	}
	return out, code, nil
}

// wikiRepoOpHistoryCount is how many lines of the paths hold the term at a commit: `git grep -c`, a fixed string
// and case as written, binary files left out. Its answer is a count per file, `<rev>:<path>\0<count>\n`; a path
// the commit does not have holds nothing, and a grep that finds nothing anywhere exits 1.
func wikiRepoOpHistoryCount(root, rev, term string, paths []string) (int, error) {
	out, _, err := wikiRepoOpHistoryGit(root, paths, 1, "grep", "-z", "-c", "-I", "-F", "--no-color", "-e", term, rev)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, record := range bytes.Split(out, []byte{0})[1:] {
		if end := bytes.IndexByte(record, '\n'); end >= 0 {
			record = record[:end]
		}
		count, err := strconv.Atoi(string(record))
		if err != nil {
			return 0, errors.New("git grep -c answered in a shape this build does not read")
		}
		total += count
	}
	return total, nil
}

// wikiRepoOpHistoryMoved is which of the entry's paths are themselves added, deleted or renamed between the base
// and `to`: a path is moved when it is exactly — not a directory above — the path of an A, D or T row of
// `git diff --name-status -M`, either side of an R row, or the new side of a C row. Sorted.
func wikiRepoOpHistoryMoved(root, base, to string, paths []string) ([]string, error) {
	out, _, err := wikiRepoOpHistoryGit(root, paths, 0, "diff", "--name-status", "-M", "-z", base, to)
	if err != nil {
		return nil, err
	}
	touched := map[string]bool{}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		status := fields[i]
		if status == "" {
			continue
		}
		switch {
		case (status[0] == 'R' || status[0] == 'C') && i+2 < len(fields):
			// A rename moves both its sides; a copy leaves where it came from where it was.
			touched[fields[i+2]] = true
			if status[0] == 'R' {
				touched[fields[i+1]] = true
			}
			i += 2
		case status[0] == 'A' || status[0] == 'D' || status[0] == 'T':
			if i+1 < len(fields) {
				touched[fields[i+1]] = true
			}
			i++
		default:
			i++
		}
	}
	moved := []string{}
	for _, path := range paths {
		if touched[path] {
			moved = append(moved, path)
		}
	}
	sort.Strings(moved)
	return moved, nil
}

// wikiRepoOpHistoryCommits is the commits from the base to `to` that touched the entry's paths, newest first as
// git log lists them, and how many there are. A commit is matched when git log -S finds that it changed how many
// times one of the terms occurs in the paths. At most wikiRepoOpHistoryMaxCommits are kept: every matched one
// first, newest first, then the newest of the rest — in git log's order still.
func wikiRepoOpHistoryCommits(root, base, to string, terms, paths []string) ([]wikiRepoOpHistoryCommit, int, error) {
	out, _, err := wikiRepoOpHistoryGit(root, paths, 0, "log", "--format=%H%x09%cI%x09%s", base+".."+to)
	if err != nil {
		return nil, 0, err
	}
	matched := map[string]bool{}
	for _, term := range terms {
		hits, _, err := wikiRepoOpHistoryGit(root, paths, 0, "log", "--format=%H", "-S"+term, base+".."+to)
		if err != nil {
			return nil, 0, err
		}
		for _, sha := range strings.Fields(string(hits)) {
			matched[sha] = true
		}
	}
	var all []wikiRepoOpHistoryCommit
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) != 3 || !wikiCommitSha.MatchString(fields[0]) {
			return nil, 0, errors.New("git log answered in a shape this build does not read")
		}
		all = append(all, wikiRepoOpHistoryCommit{Sha: fields[0], Date: fields[1],
			Subject: cutRunes(fields[2], wikiRepoOpHistoryTextRunes), Matched: matched[fields[0]]})
	}
	keep := make([]bool, len(all))
	kept := 0
	for _, wanted := range []bool{true, false} {
		for i := range all {
			if all[i].Matched == wanted && kept < wikiRepoOpHistoryMaxCommits {
				keep[i] = true
				kept++
			}
		}
	}
	commits := []wikiRepoOpHistoryCommit{}
	for i := range all {
		if keep[i] {
			commits = append(commits, all[i])
		}
	}
	return commits, len(all), nil
}

// wikiRepoOpHistoryLines is the lines of the entry's paths at `to` that hold a term — `git grep -n`, one line once
// whichever terms it holds, as `<rev>:<path>\0<line>\0<text>\n` — the first wikiRepoOpHistoryMaxLines of them, and
// how many there are. No terms, no lines.
func wikiRepoOpHistoryLines(root, to string, terms, paths []string) ([]wikiRepoOpHistoryLine, int, error) {
	lines := []wikiRepoOpHistoryLine{}
	if len(terms) == 0 {
		return lines, 0, nil
	}
	args := []string{"grep", "-z", "-n", "-I", "-F", "--no-color"}
	for _, term := range terms {
		args = append(args, "-e", term)
	}
	out, _, err := wikiRepoOpHistoryGit(root, paths, 1, append(args, to)...)
	if err != nil {
		return nil, 0, err
	}
	total := 0
	for len(out) > 0 {
		// The path ends at the first NUL and the number at the next; the text runs to the end of the line, so a
		// NUL in it — a file git did not take for binary — stays in it.
		name := bytes.IndexByte(out, 0)
		number := -1
		if name >= 0 {
			number = bytes.IndexByte(out[name+1:], 0)
		}
		if number < 0 {
			return nil, 0, errors.New("git grep -n answered in a shape this build does not read")
		}
		number += name + 1
		line, err := strconv.Atoi(string(out[name+1 : number]))
		if err != nil {
			return nil, 0, errors.New("git grep -n answered in a shape this build does not read")
		}
		text := out[number+1:]
		rest := []byte(nil)
		if end := bytes.IndexByte(text, '\n'); end >= 0 {
			text, rest = text[:end], text[end+1:]
		}
		total++
		if len(lines) < wikiRepoOpHistoryMaxLines {
			lines = append(lines, wikiRepoOpHistoryLine{
				Path: strings.TrimPrefix(string(out[:name]), to+":"),
				Line: line,
				Text: cutRunes(string(text), wikiRepoOpHistoryTextRunes),
			})
		}
		out = rest
	}
	return lines, total, nil
}

// wikiRepoOpHistoryHunk is one hunk of a diff: the file it is of (an index into the files' headings), where its
// text is in git's output, and whether one of its + or - lines holds a term.
type wikiRepoOpHistoryHunk struct {
	file       int
	start, end int
	relevant   bool
}

// wikiRepoOpHistoryDiff is the diff of the entry's paths from the base to `to`, cut to what the model reads: the
// hunks that mention a term — one of their + or - lines holds it — first, in the order of their files, then the
// rest, until the next would pass wikiRepoOpHistoryDiffBytes in all. A hunk follows its file's heading, the ---
// and +++ pair (or git's "Binary files … differ", all a binary file has to show), whenever the hunk before it is
// another file's, so that no hunk reads as another file's. A first hunk that passes the limit on its own is cut
// on a line boundary. A file with no hunk — a rename or a mode change and nothing else — shows nothing here: the
// entry's moved paths and its commits say it. `truncated` says something was left out.
func wikiRepoOpHistoryDiff(root, base, to string, terms, paths []string) (string, bool, error) {
	out, _, err := wikiRepoOpHistoryGit(root, paths, 0, "diff", "--no-color", "--no-ext-diff", "-U2", base, to)
	if err != nil {
		return "", false, err
	}
	text := string(out)
	var headings []string
	var hunks []wikiRepoOpHistoryHunk
	inHunk := false
	for start := 0; start < len(text); {
		end := strings.IndexByte(text[start:], '\n') + start + 1
		if end <= start {
			end = len(text)
		}
		line := text[start:end]
		switch {
		case strings.HasPrefix(line, "diff --git "):
			headings = append(headings, "")
			inHunk = false
		case len(headings) == 0:
			// Nothing comes before the first file's line, and what would is no file's.
		case strings.HasPrefix(line, "@@"):
			hunks = append(hunks, wikiRepoOpHistoryHunk{file: len(headings) - 1, start: start, end: end})
			inHunk = true
		case inHunk:
			hunk := &hunks[len(hunks)-1]
			hunk.end = end
			if (line[0] == '+' || line[0] == '-') && wikiRepoOpHistoryHolds(strings.TrimSuffix(line[1:], "\n"), terms) {
				hunk.relevant = true
			}
		case strings.HasPrefix(line, "--- "):
			headings[len(headings)-1] = line
		case strings.HasPrefix(line, "+++ "):
			headings[len(headings)-1] += line
		case strings.HasPrefix(line, "Binary files "):
			headings[len(headings)-1] = line
			hunks = append(hunks, wikiRepoOpHistoryHunk{file: len(headings) - 1, start: end, end: end})
		}
		start = end
	}
	order := make([]wikiRepoOpHistoryHunk, 0, len(hunks))
	for _, relevant := range []bool{true, false} {
		for _, hunk := range hunks {
			if hunk.relevant == relevant {
				order = append(order, hunk)
			}
		}
	}
	var diff strings.Builder
	last := -1
	for _, hunk := range order {
		piece := text[hunk.start:hunk.end]
		if hunk.file != last {
			piece = headings[hunk.file] + piece
		}
		if diff.Len()+len(piece) > wikiRepoOpHistoryDiffBytes {
			if diff.Len() == 0 {
				// It passes the limit on its own: as much of it as fits, up to the end of a line.
				piece = piece[:wikiRepoOpHistoryDiffBytes]
				diff.WriteString(piece[:strings.LastIndexByte(piece, '\n')+1])
			}
			return diff.String(), true, nil
		}
		diff.WriteString(piece)
		last = hunk.file
	}
	return diff.String(), false, nil
}

// wikiRepoOpHistoryHolds says whether the text holds one of the terms.
func wikiRepoOpHistoryHolds(text string, terms []string) bool {
	for _, term := range terms {
		if strings.Contains(text, term) {
			return true
		}
	}
	return false
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
