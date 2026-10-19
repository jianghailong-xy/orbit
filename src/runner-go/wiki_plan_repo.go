package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// What the snapshot repository operation reads of a checkout's origin/main (wikiRepoOpSnapshot,
// contracts/wiki.contract.json `repoOps`, the sample's prep_repo.py and symbols.py): every path with its
// size, every document's headings and every source file's symbols, which the server's plan job reads in
// place of a checkout (src/apiserver/src/wiki-worker/wiki-plan-repo.ts).
//
// EVERYTHING AT ONE SHA. The checkout is fetched, origin/main is read once — the file list, then every
// document's and source file's blob in one `git cat-file --batch` — and nothing of the working tree is
// looked at, so everything the index says is said of the one commit it names.

// wikiPlanRepo is origin/main of the space's checkout, as the snapshot reads it.
type wikiPlanRepo struct {
	root  string
	sha   string
	date  string
	files []string
	sizes map[string]int64
	// headings of every Markdown file; symbols and text of every source file; the text of every doc.
	headings map[string][]wikiPlanHeading
	symbols  map[string][]string
	blobs    map[string]string
}

type wikiPlanHeading struct {
	Level int
	Text  string
}

// wikiPlanTestFile is a test, a fixture or a snapshot: not what a document explains.
var wikiPlanTestFile = regexp.MustCompile(`(\.spec\.tsx?|\.test\.tsx?|_test\.go|\.fixture\.json|\.snap)$|/Tests/|/test-support/|/__tests__/|/testdata/`)

// wikiPlanExcludedDocs are the docs a plan does not draft from: the mockups and the evidence bundles.
var wikiPlanExcludedDocs = []string{"docs/mocks/", "docs/evidence/"}

func wikiPlanIsSource(file string) bool {
	if wikiPlanTestFile.MatchString(file) || strings.Contains(file, "node_modules/") {
		return false
	}
	switch path.Ext(file) {
	case ".go", ".ts", ".tsx", ".swift":
		return true
	}
	return false
}

func wikiPlanIsDoc(file string) bool {
	if !strings.HasSuffix(strings.ToLower(file), ".md") || strings.Contains(file, "node_modules/") {
		return false
	}
	for _, prefix := range wikiPlanExcludedDocs {
		if strings.HasPrefix(file, prefix) {
			return false
		}
	}
	return true
}

// loadWikiPlanRepo reads ref of the checkout at root: its files, and the blobs of every document,
// source file and contract.
func loadWikiPlanRepo(root, ref string) (*wikiPlanRepo, error) {
	sha, err := wikiImportGit(root, "rev-parse", "--verify", ref+"^{commit}")
	if err != nil || !wikiCommitSha.MatchString(sha) {
		return nil, fmt.Errorf("%s names no commit in %s", ref, root)
	}
	date, _ := wikiImportGit(root, "log", "-1", "--format=%cI", sha)
	listing, err := wikiPlanGitOutput(root, "ls-tree", "-r", "-z", "--long", sha)
	if err != nil {
		return nil, fmt.Errorf("git ls-tree %s in %s: %w", shortWikiHash(sha), root, err)
	}
	repo := &wikiPlanRepo{
		root: root, sha: sha, date: date, sizes: map[string]int64{},
		headings: map[string][]wikiPlanHeading{}, symbols: map[string][]string{}, blobs: map[string]string{},
	}
	var wanted []string
	oids := map[string]string{}
	for _, entry := range bytes.Split(listing, []byte{0}) {
		// <mode> SP <type> SP <object> SP+ <size> TAB <path>
		tab := bytes.IndexByte(entry, '\t')
		if tab < 0 {
			continue
		}
		fields := strings.Fields(string(entry[:tab]))
		if len(fields) != 4 || fields[1] != "blob" {
			continue
		}
		file := string(entry[tab+1:])
		size, _ := strconv.ParseInt(fields[3], 10, 64)
		repo.files = append(repo.files, file)
		repo.sizes[file] = size
		if wikiPlanIsDoc(file) || wikiPlanIsSource(file) || strings.HasPrefix(file, "contracts/") {
			wanted = append(wanted, file)
			oids[file] = fields[2]
		}
	}
	sort.Strings(repo.files)
	blobs, err := wikiPlanCatFiles(root, wanted, oids)
	if err != nil {
		return nil, err
	}
	for file, text := range blobs {
		switch {
		case wikiPlanIsDoc(file):
			repo.blobs[file] = text
			repo.headings[file] = wikiPlanHeadings(text)
		case wikiPlanIsSource(file):
			repo.blobs[file] = text
			if symbols := wikiPlanSymbols(file, text); len(symbols) > 0 {
				repo.symbols[file] = symbols
			}
		default:
			repo.blobs[file] = text
		}
	}
	return repo, nil
}

func wikiPlanGitOutput(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	return cmd.Output()
}

// wikiPlanCatFiles reads blobs by object id in one `git cat-file --batch`.
func wikiPlanCatFiles(root string, files []string, oids map[string]string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", root, "cat-file", "--batch")
	var input bytes.Buffer
	for _, file := range files {
		input.WriteString(oids[file] + "\n")
	}
	cmd.Stdin = &input
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(out, 1<<20)
	blobs := make(map[string]string, len(files))
	for _, file := range files {
		header, err := reader.ReadString('\n')
		if err != nil {
			_ = cmd.Wait()
			return nil, fmt.Errorf("git cat-file stopped at %s: %w", file, err)
		}
		fields := strings.Fields(header)
		if len(fields) < 3 || fields[1] != "blob" {
			continue
		}
		size, _ := strconv.Atoi(fields[2])
		body := make([]byte, size+1)
		if _, err := io.ReadFull(reader, body); err != nil {
			_ = cmd.Wait()
			return nil, fmt.Errorf("git cat-file stopped inside %s: %w", file, err)
		}
		blobs[file] = string(body[:size])
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("git cat-file: %w", err)
	}
	return blobs, nil
}

var (
	wikiPlanFence       = regexp.MustCompile("^\\s*(```+|~~~+)")
	wikiPlanHeadingLine = regexp.MustCompile(`^(#{1,6})\s+(.*?)\s*#*\s*$`)
)

// wikiPlanHeadings are a Markdown file's ATX headings, outside fenced code.
func wikiPlanHeadings(text string) []wikiPlanHeading {
	var out []wikiPlanHeading
	fence := ""
	for _, line := range strings.Split(text, "\n") {
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
			out = append(out, wikiPlanHeading{Level: len(m[1]), Text: strings.TrimSpace(m[2])})
		}
	}
	return out
}

var (
	wikiPlanTSController = regexp.MustCompile(`@Controller\(\s*'([^']*)'`)
	wikiPlanTSClass      = regexp.MustCompile(`^export (?:default )?(?:abstract )?class (\w+)`)
	wikiPlanTSFunction   = regexp.MustCompile(`^export (?:default )?(?:async )?function\*? (\w+)`)
	wikiPlanTSConst      = regexp.MustCompile(`^export (?:const|let) (\w+)`)
	wikiPlanTSType       = regexp.MustCompile(`^export (?:interface|type|enum|declare enum|const enum) (\w+)`)
	wikiPlanTSRoute      = regexp.MustCompile(`^\s{2}@(Get|Post|Put|Patch|Delete)\(\s*'?([^')]*)'?\s*\)`)
	wikiPlanTSMethod     = regexp.MustCompile(`^\s{2}(?:public |protected |static |async |readonly |override )*(\w+)\s*(?:<[^>]*>)?\(`)
	wikiPlanGoType       = regexp.MustCompile(`(?m)^type (\w+) `)
	wikiPlanGoFunc       = regexp.MustCompile(`(?m)^func (?:\(\w+ \*?(\w+)(?:\[[^\]]*\])?\) )?(\w+)\(`)
	wikiPlanGoConst      = regexp.MustCompile(`(?m)^(?:const|var) (\w+) `)
	wikiPlanSwiftType    = regexp.MustCompile(`(?m)^\s*(?:public |internal |final |open |@MainActor )*(struct|class|enum|protocol|actor|extension) (\w+)`)
	wikiPlanSwiftFunc    = regexp.MustCompile(`(?m)^\s{0,4}((?:public |static |private |internal |fileprivate |@MainActor |nonisolated |mutating |override )*)func (\w+)`)
	wikiPlanTSKeywords   = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "return": true,
		"constructor": true, "super": true, "function": true, "await": true, "new": true, "else": true}
)

// wikiPlanSymbols is one source file's declarations, regex-level (symbols.py): a TypeScript file's
// exported classes and their public methods — a Nest route beside its handler — functions, constants
// and types; a Go file's types, functions (a method as Type.name) and top-level names; a Swift file's
// types and functions.
func wikiPlanSymbols(file, text string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(symbol string) {
		if symbol != "" && !seen[symbol] {
			seen[symbol] = true
			out = append(out, symbol)
		}
	}
	switch path.Ext(file) {
	case ".ts", ".tsx":
		prefix := ""
		if m := wikiPlanTSController.FindStringSubmatch(text); m != nil {
			prefix = "/api/" + m[1]
		}
		class, route := "", ""
		for _, line := range strings.Split(text, "\n") {
			if m := wikiPlanTSClass.FindStringSubmatch(line); m != nil {
				class = m[1]
				add(class)
				continue
			}
			if m := wikiPlanTSFunction.FindStringSubmatch(line); m != nil {
				add(m[1] + "()")
				class = ""
				continue
			}
			if m := wikiPlanTSConst.FindStringSubmatch(line); m != nil {
				add(m[1])
				continue
			}
			if m := wikiPlanTSType.FindStringSubmatch(line); m != nil {
				add(m[1])
				continue
			}
			if class == "" {
				continue
			}
			if m := wikiPlanTSRoute.FindStringSubmatch(line); m != nil && prefix != "" {
				route = strings.ToUpper(m[1]) + " " + prefix
				if m[2] != "" {
					route += "/" + m[2]
				}
				continue
			}
			trimmed := strings.TrimSpace(line)
			if m := wikiPlanTSMethod.FindStringSubmatch(line); m != nil && !wikiPlanTSKeywords[m[1]] &&
				!strings.HasPrefix(trimmed, "private") && !strings.HasPrefix(trimmed, "//") && !strings.HasPrefix(trimmed, "*") {
				name := class + "." + m[1]
				if route != "" {
					name += " [" + route + "]"
					route = ""
				}
				add(name)
			}
		}
	case ".go":
		for _, m := range wikiPlanGoType.FindAllStringSubmatch(text, -1) {
			add(m[1])
		}
		for _, m := range wikiPlanGoFunc.FindAllStringSubmatch(text, -1) {
			if m[1] != "" {
				add(m[1] + "." + m[2])
			} else {
				add(m[2] + "()")
			}
		}
		for _, m := range wikiPlanGoConst.FindAllStringSubmatch(text, -1) {
			add(m[1])
		}
	case ".swift":
		for _, m := range wikiPlanSwiftType.FindAllStringSubmatch(text, -1) {
			if m[1] == "extension" {
				add("ext " + m[2])
			} else {
				add(m[2])
			}
		}
		for _, m := range wikiPlanSwiftFunc.FindAllStringSubmatch(text, -1) {
			if !strings.Contains(m[1], "private") {
				add(m[2] + "()")
			}
		}
	}
	return out
}

// ── What the snapshot reads of the tree ─────────────────────────────────────────────────────────

// blobOf is a file's text at the sha, read now if it was not read with the rest.
func (r *wikiPlanRepo) blobOf(file string) string {
	if text, ok := r.blobs[file]; ok {
		return text
	}
	out, err := wikiPlanGitOutput(r.root, "show", r.sha+":"+file)
	if err != nil {
		return ""
	}
	r.blobs[file] = string(out)
	return r.blobs[file]
}

// docFiles are the documents a plan drafts from: docs/ (less the mockups and evidence) first, then every
// other Markdown file.
func (r *wikiPlanRepo) docFiles() []string {
	var docs, others []string
	for _, file := range r.files {
		if !wikiPlanIsDoc(file) {
			continue
		}
		if strings.HasPrefix(file, "docs/") {
			docs = append(docs, file)
		} else {
			others = append(others, file)
		}
	}
	return append(docs, others...)
}

// ── A heading, as two spellings of it compare ───────────────────────────────────────────────────

var (
	wikiPlanHeadingNumber = regexp.MustCompile(`^(?:§\s*)?(?:第\s*\d+\s*[章节部分]\s*|\d+(?:\.\d+)*[.、)]?\s+|[A-Z]\d*[.、)]\s+)`)
	wikiPlanMarkup        = regexp.MustCompile("[*_`]")
	wikiPlanSpaces        = regexp.MustCompile(`\s+`)
)

// wikiPlanHeadingKey is a heading as two spellings of it compare: no markup, no numbering, one case,
// one width of punctuation, one space.
func wikiPlanHeadingKey(text string) string {
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "§"))
	text = wikiPlanMarkup.ReplaceAllString(text, "")
	replacer := strings.NewReplacer("（", "(", "）", ")", "：", ":", "，", ",", "；", ";", "　", " ", "—", "-", "–", "-")
	text = replacer.Replace(text)
	text = wikiPlanHeadingNumber.ReplaceAllString(strings.TrimSpace(text), "")
	return strings.ToLower(strings.TrimSpace(wikiPlanSpaces.ReplaceAllString(text, " ")))
}

// wikiPlanHeadingPath is how a model names a subsection by the heading it sits under: «parent - child».
var wikiPlanHeadingPath = regexp.MustCompile(`\s+(?:-|—|–|>|›|/)\s+`)
