package main

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The folder tier (docs/wiki-repo-tiers-design.md §4, contract `repoOps.folder`): a working directory that is not a git
// checkout, read as it stands.
//
// ONLY WHEN THE SERVER SAYS SO. An operation whose input carries `allowFolder` — which the server writes only for a
// runner that declares wikiRepoOpFolderCapabilityV1 — and whose working directory is not a git checkout scans the
// directory instead of failing not_git. A git checkout is never scanned, whatever the input says: its tier is git, and
// a fetch that fails there is a fetch that failed (design §2.1).
//
// WHAT IS READ. The directory from the top down, never through a symbolic link and never out of it. The built-in
// exclusions (wikiRepoFolderExclude) first — secrets and build output — which no .gitignore can take back; then every
// .gitignore on the way down, read as git reads it. A file whose first 8 KB have a NUL is recorded by its path, size and
// hash, and nothing of it is read as text. More than wikiRepoFolderMaxFiles files after the exclusions is no snapshot:
// too_many_files.
//
// THE TREE HASH is the snapshot's sha (§4.2): `path \0 size \0 sha256(content) \n` for every file, sorted by path,
// concatenated and hashed with sha1 — forty hex characters, so the server keeps it where it keeps a commit. The same
// files give the same hash; one byte more is another tree.

// The capability a runner declares when it reads a folder that is not git. Its apiserver twin is
// WIKI_REPO_OP_FOLDER_CAPABILITY in src/shared/src/wikiRepoOps.ts: the server writes allowFolder only for a runner that
// declares it.
const wikiRepoOpFolderCapabilityV1 = "wiki-repo-op-folder/v1"

// The reasons the folder tier adds (contract `repoOps.reasons`).
const (
	wikiRepoReasonTooManyFiles = "too_many_files"
	wikiRepoReasonFolderMoved  = "folder_moved"
)

// wikiRepoFolderMaxFiles is `repoOps.folder.maxFiles`: the most files a folder may have after its exclusions. A
// variable only so a test can reach it without writing a hundred thousand files.
var wikiRepoFolderMaxFiles = 100000

// wikiRepoFolderBinaryProbe is how much of a file is looked at for a NUL, which makes it binary.
const wikiRepoFolderBinaryProbe = 8 << 10

// wikiRepoFolderExclude is `repoOps.folder.exclude`, in .gitignore's spelling: a pattern ending in / names a directory,
// and every one of them is matched against a name at any depth.
var wikiRepoFolderExclude = []string{
	".git/", ".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", ".ssh/", ".aws/", ".npmrc", ".netrc",
	"node_modules/", ".venv/", "venv/", "__pycache__/", "target/", "dist/", "build/", ".next/", ".gradle/", "DerivedData/",
}

// wikiRepoFolderExcluded says whether a name is one of the built-in exclusions.
func wikiRepoFolderExcluded(name string, isDir bool) bool {
	for _, pattern := range wikiRepoFolderExclude {
		dirOnly := strings.HasSuffix(pattern, "/")
		if dirOnly && !isDir {
			continue
		}
		if ok, _ := path.Match(strings.TrimSuffix(pattern, "/"), name); ok {
			return true
		}
	}
	return false
}

// ── .gitignore ──────────────────────────────────────────────────────────────────────────────────

// wikiIgnoreRule is one line of a .gitignore, held to the directory the file is in.
type wikiIgnoreRule struct {
	base    string
	re      *regexp.Regexp
	negate  bool
	dirOnly bool
}

// parseWikiIgnore reads one .gitignore of the directory base (a path relative to the folder, "" for its top).
func parseWikiIgnore(base, text string) []wikiIgnoreRule {
	var rules []wikiIgnoreRule
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasSuffix(line, `\ `) {
			line = strings.TrimRight(line, " \t")
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		rule := wikiIgnoreRule{base: base}
		if strings.HasPrefix(line, "!") {
			rule.negate = true
			line = line[1:]
		} else if strings.HasPrefix(line, `\!`) || strings.HasPrefix(line, `\#`) {
			line = line[1:]
		}
		if strings.HasSuffix(line, "/") {
			rule.dirOnly = true
			line = strings.TrimRight(line, "/")
		}
		if line == "" {
			continue
		}
		anchored := strings.Contains(line, "/")
		line = strings.TrimPrefix(line, "/")
		re, err := regexp.Compile(wikiIgnoreRegexp(line, anchored))
		if err != nil {
			continue
		}
		rule.re = re
		rules = append(rules, rule)
	}
	return rules
}

// wikiIgnoreRegexp is a .gitignore pattern as a regular expression over a path relative to its directory: a pattern
// with no slash but a trailing one matches a name at any depth, one with a slash only from the directory itself.
func wikiIgnoreRegexp(pattern string, anchored bool) string {
	var out strings.Builder
	out.WriteString("^")
	if !anchored {
		out.WriteString("(?:.*/)?")
	}
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case strings.HasPrefix(pattern[i:], "**/") && (i == 0 || pattern[i-1] == '/'):
			out.WriteString("(?:.*/)?")
			i += 2
		case strings.HasPrefix(pattern[i:], "**") && i+2 == len(pattern) && (i == 0 || pattern[i-1] == '/'):
			out.WriteString(".*")
			i++
		case c == '*':
			out.WriteString("[^/]*")
		case c == '?':
			out.WriteString("[^/]")
		case c == '[':
			end := strings.IndexByte(pattern[i+1:], ']')
			if end < 0 {
				out.WriteString(`\[`)
				continue
			}
			class := pattern[i+1 : i+1+end]
			if strings.HasPrefix(class, "!") {
				class = "^" + class[1:]
			}
			out.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
			i += end + 1
		case c == '\\' && i+1 < len(pattern):
			i++
			out.WriteString(regexp.QuoteMeta(string(pattern[i])))
		default:
			out.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	out.WriteString("$")
	return out.String()
}

// wikiIgnored says whether the rules that apply to rel ignore it: the last one that matches decides, and the rules of
// a deeper .gitignore come after its parents'.
func wikiIgnored(rules []wikiIgnoreRule, rel string, isDir bool) bool {
	ignored := false
	for _, rule := range rules {
		if rule.dirOnly && !isDir {
			continue
		}
		sub := rel
		if rule.base != "" {
			if !strings.HasPrefix(rel, rule.base+"/") {
				continue
			}
			sub = rel[len(rule.base)+1:]
		}
		if rule.re.MatchString(sub) {
			ignored = !rule.negate
		}
	}
	return ignored
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────────

type wikiFolderFile struct {
	path   string
	size   int64
	hash   string
	binary bool
}

// wikiFolderScan is a folder as one scan read it: every file kept, its tree hash, and the text of the files asked for.
type wikiFolderScan struct {
	root   string
	files  []wikiFolderFile
	byPath map[string]int
	tree   string
	texts  map[string]string
}

// scanWikiFolder reads the folder at root: which files there are, and of each its size and hash. wantText names the
// files whose text is kept as well, when it is text and within wikiRepoOpWholeFileBytes.
func scanWikiFolder(root string, wantText func(string) bool) (*wikiFolderScan, error) {
	rulesOf := map[string][]wikiIgnoreRule{}
	var paths []string
	walkErr := filepath.WalkDir(root, func(full string, entry fs.DirEntry, err error) error {
		if err != nil {
			if full == root {
				return err
			}
			// A directory that cannot be listed is left out, as one git could not read.
			return nil
		}
		rel, relErr := filepath.Rel(root, full)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		isDir := entry.IsDir()
		if rel == "." {
			rulesOf[""] = parseWikiIgnore("", readWikiIgnoreFile(full))
			return nil
		}
		// A symbolic link — to a file or a directory, in the folder or out of it — is neither followed nor recorded,
		// and nor is anything but a file or a directory.
		if entry.Type()&fs.ModeSymlink != 0 || (!isDir && !entry.Type().IsRegular()) {
			return nil
		}
		parent := path.Dir(rel)
		if parent == "." {
			parent = ""
		}
		if wikiRepoFolderExcluded(entry.Name(), isDir) || wikiIgnored(rulesOf[parent], rel, isDir) {
			if isDir {
				return filepath.SkipDir
			}
			return nil
		}
		if isDir {
			own := parseWikiIgnore(rel, readWikiIgnoreFile(full))
			rulesOf[rel] = append(append([]wikiIgnoreRule{}, rulesOf[parent]...), own...)
			return nil
		}
		paths = append(paths, rel)
		if len(paths) > wikiRepoFolderMaxFiles {
			return errWikiFolderTooManyFiles
		}
		return nil
	})
	if errors.Is(walkErr, errWikiFolderTooManyFiles) {
		return nil, wikiRepoOpReasonf(wikiRepoReasonTooManyFiles, "%s has more than %d files after its exclusions: no snapshot of it was built",
			root, wikiRepoFolderMaxFiles)
	}
	if walkErr != nil {
		return nil, wikiRepoOpReasonf(wikiRepoReasonNotFound, "%s could not be read: %v", root, walkErr)
	}
	sort.Strings(paths)
	scan := &wikiFolderScan{root: root, byPath: map[string]int{}, texts: map[string]string{}}
	var tree bytes.Buffer
	for _, rel := range paths {
		file, text, err := readWikiFolderFile(root, rel, wantText != nil && wantText(rel))
		if err != nil {
			// A file that went between the listing and the read is not in this tree.
			continue
		}
		scan.byPath[rel] = len(scan.files)
		scan.files = append(scan.files, file)
		if text != nil {
			scan.texts[rel] = *text
		}
		fmt.Fprintf(&tree, "%s\x00%d\x00%s\n", file.path, file.size, file.hash)
	}
	sum := sha1.Sum(tree.Bytes())
	scan.tree = hex.EncodeToString(sum[:])
	return scan, nil
}

var errWikiFolderTooManyFiles = errors.New("too many files")

func readWikiIgnoreFile(dir string) string {
	full := filepath.Join(dir, ".gitignore")
	if info, err := os.Lstat(full); err != nil || !info.Mode().IsRegular() {
		return ""
	}
	content, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(content)
}

// readWikiFolderFile hashes one file, and keeps its text when it is wanted, text, and within the whole-file limit.
func readWikiFolderFile(root, rel string, wantText bool) (wikiFolderFile, *string, error) {
	handle, err := os.Open(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return wikiFolderFile{}, nil, err
	}
	defer handle.Close()
	hasher := sha256.New()
	head := make([]byte, wikiRepoFolderBinaryProbe)
	n, err := io.ReadFull(handle, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return wikiFolderFile{}, nil, err
	}
	head = head[:n]
	hasher.Write(head)
	file := wikiFolderFile{path: rel, binary: bytes.IndexByte(head, 0) >= 0}
	var body bytes.Buffer
	keep := wantText && !file.binary
	if keep {
		body.Write(head)
	}
	var rest io.Writer = hasher
	if keep {
		rest = io.MultiWriter(hasher, &limitedWikiBuffer{buf: &body, max: wikiRepoOpWholeFileBytes + 1})
	}
	copied, err := io.Copy(rest, handle)
	if err != nil {
		return wikiFolderFile{}, nil, err
	}
	file.size = int64(n) + copied
	file.hash = hex.EncodeToString(hasher.Sum(nil))
	if keep && file.size <= wikiRepoOpWholeFileBytes {
		text := body.String()
		return file, &text, nil
	}
	return file, nil, nil
}

// limitedWikiBuffer keeps at most max bytes and swallows the rest, so a large file is hashed without being held.
type limitedWikiBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedWikiBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) <= room {
			l.buf.Write(p)
		} else {
			l.buf.Write(p[:room])
		}
	}
	return len(p), nil
}

// has says whether the tree has rel as a file or as a directory with a file under it.
func (s *wikiFolderScan) has(rel string) bool {
	if rel == "" {
		return false
	}
	if _, ok := s.byPath[rel]; ok {
		return true
	}
	at := sort.Search(len(s.files), func(i int) bool { return s.files[i].path >= rel+"/" })
	return at < len(s.files) && strings.HasPrefix(s.files[at].path, rel+"/")
}

// under is the files at rel or under it, in path order: what `git grep -- <rel>` searches.
func (s *wikiFolderScan) under(rel string) []wikiFolderFile {
	var out []wikiFolderFile
	if at, ok := s.byPath[rel]; ok {
		return append(out, s.files[at])
	}
	for _, file := range s.files {
		if strings.HasPrefix(file.path, rel+"/") {
			out = append(out, file)
		}
	}
	return out
}

// content is one file of the tree as it is on disk now, or not there when the tree has no such file.
func (s *wikiFolderScan) content(rel string) (string, bool, error) {
	if _, ok := s.byPath[rel]; !ok {
		return "", false, nil
	}
	if text, ok := s.texts[rel]; ok {
		return text, true, nil
	}
	data, err := os.ReadFile(filepath.Join(s.root, filepath.FromSlash(rel)))
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("%s could not be read: %v", rel, err)
	}
	return string(data), true, nil
}

// ── The operations on a folder ──────────────────────────────────────────────────────────────────

// runWikiRepoOpFolder answers one operation from the folder at root, which is not a git checkout.
func runWikiRepoOpFolder(cmd WikiRepoOpCommand, root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	switch cmd.Kind {
	case "snapshot":
		return wikiRepoOpFolderSnapshot(root, input)
	case "read":
		scan, err := scanWikiFolder(root, nil)
		if err != nil {
			return wikiRepoOpFailedWith(err)
		}
		sha := strings.ToLower(strings.TrimSpace(input.Sha))
		if sha != scan.tree {
			return wikiRepoOpFailedWith(wikiRepoOpReasonf(wikiRepoReasonFolderMoved,
				"the folder %s is at tree %s now, not %s the read was asked at: it changed since its snapshot", root, shortWikiHash(scan.tree), shortWikiHash(sha)))
		}
		return wikiRepoOpReadAt(sha, input, func(rel string) (string, bool, error) { return scan.content(rel) })
	case "anchors":
		return wikiRepoOpFolderAnchors(root, input)
	case "diff":
		return wikiRepoOpFailed(fmt.Sprintf("the folder %s is not a git checkout: it keeps no history to diff", root))
	default:
		return wikiRepoOpFailed(fmt.Sprintf("%s is not a repository operation this runner knows", cmd.Kind))
	}
}

func wikiRepoOpFolderSnapshot(root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	wanted := func(rel string) bool {
		return wikiPlanIsDoc(rel) || wikiPlanIsSource(rel) || strings.HasPrefix(rel, "contracts/")
	}
	scan, err := scanWikiFolder(root, wanted)
	if err != nil {
		return wikiRepoOpFailedWith(err)
	}
	if skip := strings.ToLower(strings.TrimSpace(input.SkipSha)); skip != "" && skip == scan.tree {
		return wikiRepoOpSucceeded(map[string]interface{}{"sha": scan.tree, "skipped": true})
	}
	repo := &wikiPlanRepo{
		root: root, sha: scan.tree, date: time.Now().UTC().Format(time.RFC3339), folder: true,
		sizes: map[string]int64{}, headings: map[string][]wikiPlanHeading{}, symbols: map[string][]string{}, blobs: map[string]string{},
	}
	hashes := map[string]string{}
	for _, file := range scan.files {
		repo.files = append(repo.files, file.path)
		repo.sizes[file.path] = file.size
		hashes[file.path] = file.hash
	}
	for rel, text := range scan.texts {
		repo.blobs[rel] = text
		switch {
		case wikiPlanIsDoc(rel):
			repo.headings[rel] = wikiPlanHeadings(text)
		case wikiPlanIsSource(rel):
			if symbols := wikiPlanSymbols(rel, text); len(symbols) > 0 {
				repo.symbols[rel] = symbols
			}
		}
	}
	index := wikiRepoOpSnapshotIndex(repo, []string{}, wikiMaintainAboutText(scan.texts["README.md"]))
	index.Source = "folder"
	// A git checkout is read as a folder only when it has no origin remote (wikiRepoOpCheckout).
	if _, err := wikiImportGit(root, "rev-parse", "--show-toplevel"); err == nil {
		index.NoOrigin = true
	}
	for i := range index.Files {
		index.Files[i].Hash = hashes[index.Files[i].Path]
	}
	return wikiRepoOpIndexOutcome(index)
}

// wikiRepoOpFolderAnchors checks path and symbol anchors on the folder as it is now (design §5.1): a path is there as a
// file or a directory, a symbol is found as `git grep -w -F -I` finds it and its region hashed the same way. The answer
// names the tree it checked. A commit anchor is not checked on a folder, and the server sends none.
func wikiRepoOpFolderAnchors(root string, input wikiRepoOpInput) wikiRepoOpOutcome {
	scan, err := scanWikiFolder(root, nil)
	if err != nil {
		return wikiRepoOpFailedWith(err)
	}
	answer := wikiRepoOpAnchorsAnswer{Sha: scan.tree, Anchors: []wikiAnchorCheck{}}
	for _, anchor := range input.Anchors {
		check := wikiAnchorCheck{Index: anchor.Index, Type: anchor.Type}
		switch anchor.Type {
		case "path":
			check.State = "missing"
			if scan.has(wikiAnchorPath(anchor.Path)) {
				check.State = "verified"
			}
		case "symbol":
			check.State, check.RegionSha256, err = checkWikiFolderSymbol(scan, anchor.Path, anchor.Symbol, anchor.RegionSha256)
			if err != nil {
				return wikiRepoOpFailed(fmt.Sprintf("anchor %d (symbol %s) could not be checked: %v", anchor.Index, anchor.Symbol, err))
			}
		default:
			return wikiRepoOpFailed(fmt.Sprintf("anchor %d is a %s anchor, which is not checked on a folder", anchor.Index, anchor.Type))
		}
		answer.Anchors = append(answer.Anchors, check)
	}
	return wikiRepoOpSucceeded(map[string]interface{}{"anchors": answer})
}

// checkWikiFolderSymbol is checkWikiSymbolAnchor on the folder: the first line, in path order, that has the symbol as a
// whole word, in a text file at the path or under it.
func checkWikiFolderSymbol(scan *wikiFolderScan, anchorPath, symbol, baseline string) (string, string, error) {
	rel := wikiAnchorPath(anchorPath)
	if strings.TrimSpace(symbol) == "" || strings.ContainsAny(symbol, "\n\x00") || rel == "" {
		return "missing", "", nil
	}
	for _, file := range scan.under(rel) {
		if file.binary {
			continue
		}
		text, ok, err := scan.content(file.path)
		if err != nil {
			return "", "", err
		}
		if !ok || strings.IndexByte(text, 0) >= 0 {
			continue
		}
		for number, line := range strings.Split(text, "\n") {
			if !wikiFolderWordHit(line, symbol) {
				continue
			}
			region, found := wikiSymbolRegionSha256([]byte(text), number+1)
			if !found {
				continue
			}
			if baseline == "" || region == baseline {
				return "verified", region, nil
			}
			return "changed", region, nil
		}
	}
	return "missing", "", nil
}

// wikiFolderWordHit is `git grep -w -F`'s match: the text occurs on the line with no word character — a letter, a digit
// or an underscore — right before it or right after it; a hit inside a longer word is skipped for the next one.
func wikiFolderWordHit(line, word string) bool {
	isWord := func(c byte) bool {
		return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
	for from := 0; from <= len(line)-len(word); {
		at := strings.Index(line[from:], word)
		if at < 0 {
			return false
		}
		at += from
		end := at + len(word)
		if (at == 0 || !isWord(line[at-1])) && (end == len(line) || !isWord(line[end])) {
			return true
		}
		from = at + 1
	}
	return false
}
