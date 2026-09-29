package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
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

// What the drafting job reads of the repository, and how it checks what the plan says of it
// (contracts/wiki.contract.json `plan.jobs.run`, the sample's prep_repo.py and symbols.py).
//
// EVERYTHING AT ONE SHA. The checkout is fetched, origin/main is read once — the file list, then every
// document's and source file's blob in one `git cat-file --batch` — and nothing of the working tree is
// looked at. The materials the model drafts from and the references the gate checks are the same tree,
// and the sha goes into the draft's repoCheck.
//
// A REFERENCE IS FOUND OR IT IS NOT. A file is a path of the tree (or a directory, or a glob that
// matches one); a docs section is one of that document's headings, read outside its code fences; a symbol
// is one of that file's indexed declarations — or, since the index is regex-level, an identifier every
// part of which that file spells as a word. Anything else is missing, and the gate says where.

// wikiPlanRepo is origin/main of the maintenance workspace's checkout, as the drafting job reads it.
type wikiPlanRepo struct {
	root    string
	sha     string
	date    string
	files   []string
	fileSet map[string]bool
	dirs    map[string]bool
	sizes   map[string]int64
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
		root: root, sha: sha, date: date,
		fileSet: map[string]bool{}, dirs: map[string]bool{}, sizes: map[string]int64{},
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
		repo.fileSet[file] = true
		repo.sizes[file] = size
		for dir := path.Dir(file); dir != "." && dir != "/"; dir = path.Dir(dir) {
			repo.dirs[dir] = true
		}
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
	wikiPlanFence   = regexp.MustCompile("^\\s*(```+|~~~+)")
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

// ── The materials ───────────────────────────────────────────────────────────────────────────────

// wikiPlanPackage is a directory under src/ (or the root) whose files make one program.
func wikiPlanPackageOf(file string) string {
	parts := strings.Split(file, "/")
	if len(parts) >= 3 && parts[0] == "src" {
		return parts[0] + "/" + parts[1]
	}
	if len(parts) >= 2 {
		return parts[0]
	}
	return "."
}

var wikiPlanEntryNames = map[string]bool{
	"main.go": true, "main.ts": true, "main.tsx": true, "App.tsx": true, "app.module.ts": true, "index.ts": true,
	"package.json": true, "Package.swift": true, "project.yml": true, "schema.prisma": true, "go.mod": true,
}

// layoutText is the repository's structure: its top level, each package with its entry points, and each
// directory with its source files — tests and fixtures left out (the sample's repo.md, for any repository).
func (r *wikiPlanRepo) layoutText(maxChars int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 仓库结构（origin/main %s，提交时间 %s）\n\n只列源文件（去掉测试与夹具），路径相对仓库根。\n\n## 顶层\n\n", shortWikiHash(r.sha), r.date)
	top := map[string]int{}
	var topFiles []string
	for _, file := range r.files {
		if i := strings.IndexByte(file, '/'); i > 0 {
			top[file[:i]]++
		} else {
			topFiles = append(topFiles, file)
		}
	}
	names := make([]string, 0, len(top))
	for name := range top {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(&b, "- `%s/`（%d 个文件）\n", name, top[name])
	}
	if len(topFiles) > 0 {
		fmt.Fprintf(&b, "- 顶层文件：%s\n", strings.Join(topFiles, ", "))
	}
	packages := map[string][]string{}
	entries := map[string][]string{}
	for _, file := range r.files {
		pkg := wikiPlanPackageOf(file)
		if wikiPlanEntryNames[path.Base(file)] && !strings.Contains(file, "node_modules/") && strings.Count(strings.TrimPrefix(file, pkg+"/"), "/") <= 2 {
			entries[pkg] = append(entries[pkg], file)
		}
		if wikiPlanIsSource(file) {
			packages[pkg] = append(packages[pkg], file)
		}
	}
	pkgs := make([]string, 0, len(packages))
	for pkg := range packages {
		pkgs = append(pkgs, pkg)
	}
	sort.Strings(pkgs)
	b.WriteString("\n## 各包与入口\n\n")
	for _, pkg := range pkgs {
		line := fmt.Sprintf("- `%s`（%d 个源文件）", pkg, len(packages[pkg]))
		if len(entries[pkg]) > 0 {
			line += "；入口与装配：" + strings.Join(entries[pkg], "、")
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n## 各目录的源文件\n")
	for _, pkg := range pkgs {
		fmt.Fprintf(&b, "\n### %s\n", pkg)
		byDir := map[string][]string{}
		for _, file := range packages[pkg] {
			byDir[path.Dir(file)] = append(byDir[path.Dir(file)], path.Base(file))
		}
		dirs := make([]string, 0, len(byDir))
		for dir := range byDir {
			dirs = append(dirs, dir)
		}
		sort.Strings(dirs)
		for _, dir := range dirs {
			files := byDir[dir]
			if len(files) <= 40 {
				fmt.Fprintf(&b, "- %s/（%d）: %s\n", dir, len(files), strings.Join(files, ", "))
				continue
			}
			// A flat directory of many files, as a Go package is: grouped by the prefix of their names.
			groups := map[string][]string{}
			for _, file := range files {
				key := strings.FieldsFunc(strings.TrimSuffix(file, path.Ext(file)), func(c rune) bool { return c == '_' || c == '-' || c == '.' })
				prefix := file
				if len(key) > 0 {
					prefix = key[0]
				}
				groups[prefix] = append(groups[prefix], file)
			}
			prefixes := make([]string, 0, len(groups))
			for prefix := range groups {
				prefixes = append(prefixes, prefix)
			}
			sort.Slice(prefixes, func(i, j int) bool {
				if len(groups[prefixes[i]]) != len(groups[prefixes[j]]) {
					return len(groups[prefixes[i]]) > len(groups[prefixes[j]])
				}
				return prefixes[i] < prefixes[j]
			})
			fmt.Fprintf(&b, "- %s/（%d，按文件名前缀）:\n", dir, len(files))
			for _, prefix := range prefixes {
				fmt.Fprintf(&b, "  - %s: %s\n", prefix, strings.Join(groups[prefix], ", "))
			}
		}
	}
	for _, file := range r.files {
		if path.Base(file) != "schema.prisma" {
			continue
		}
		schema := r.blobOf(file)
		models := regexp.MustCompile(`(?m)^model (\w+) \{`).FindAllStringSubmatch(schema, -1)
		var names []string
		for _, m := range models {
			names = append(names, m[1])
		}
		if len(names) > 0 {
			fmt.Fprintf(&b, "\n## 数据模型（%s）\n\n模型 %d 个：%s\n", file, len(names), strings.Join(names, ", "))
		}
	}
	return wikiPlanCut(b.String(), maxChars)
}

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

// docsTreeText is every document with its title and its second- and third-level headings (docs-tree.md).
func (r *wikiPlanRepo) docsTreeText(maxChars int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 文档标题树（origin/main %s）\n\n范围：docs/ 下的设计、契约与运维文档（不含 docs/mocks、docs/evidence），以及仓库里其他说明文件。"+
		"每篇列出 H1 标题与二、三级标题；[大小] 是字节数。\n\n", shortWikiHash(r.sha))
	for _, file := range r.docFiles() {
		b.WriteString(r.docBlock(file, 3))
	}
	return wikiPlanCut(b.String(), maxChars)
}

// docBlock is one document's heading tree, to depth.
func (r *wikiPlanRepo) docBlock(file string, depth int) string {
	var b strings.Builder
	headings := r.headings[file]
	h1 := ""
	for _, h := range headings {
		if h.Level == 1 {
			h1 = h.Text
			break
		}
	}
	title := ""
	if h1 != "" {
		title = " — " + h1
	}
	fmt.Fprintf(&b, "### %s [%d]%s\n", file, r.sizes[file], title)
	for _, h := range headings {
		if h.Level == 1 && h.Text == h1 {
			continue
		}
		if h.Level >= 2 && h.Level <= depth {
			fmt.Fprintf(&b, "%s- %s\n", strings.Repeat("  ", h.Level-2), h.Text)
		}
	}
	b.WriteString("\n")
	return b.String()
}

// docIndexText is one line a document: its path, size and title.
func (r *wikiPlanRepo) docIndexText() string {
	var b strings.Builder
	for _, file := range r.docFiles() {
		title := ""
		for _, h := range r.headings[file] {
			if h.Level == 1 {
				title = " — " + h.Text
				break
			}
		}
		fmt.Fprintf(&b, "- %s [%d]%s\n", file, r.sizes[file], title)
	}
	return b.String()
}

// contractsText is the contracts/ inventory: each file with its top-level keys (contracts.md).
func (r *wikiPlanRepo) contractsText() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# contracts/ 清单（origin/main %s）\n\n", shortWikiHash(r.sha))
	n := 0
	for _, file := range r.files {
		if !strings.HasPrefix(file, "contracts/") {
			continue
		}
		n++
		desc := "（非 JSON）"
		var value interface{}
		if json.Unmarshal([]byte(r.blobOf(file)), &value) == nil {
			switch v := value.(type) {
			case map[string]interface{}:
				keys := make([]string, 0, len(v))
				for key := range v {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				if len(keys) > 14 {
					keys = append(keys[:14], "…")
				}
				desc = "顶层键：" + strings.Join(keys, ", ")
			case []interface{}:
				desc = fmt.Sprintf("数组，%d 项", len(v))
			}
		}
		fmt.Fprintf(&b, "- `%s` [%d] %s\n", file, r.sizes[file], desc)
	}
	if n == 0 {
		b.WriteString("（这个仓库没有 contracts/）\n")
	}
	return b.String()
}

// overviewText is what tells the model what the repository is: docs/README.md and docs/architecture.md
// when it has them, else its README.
func (r *wikiPlanRepo) overviewText(maxChars int) string {
	var parts []string
	for _, file := range []string{"docs/README.md", "docs/architecture.md"} {
		if r.fileSet[file] {
			parts = append(parts, fmt.Sprintf("<%s 全文>\n%s\n</%s>", file, strings.TrimSpace(r.blobOf(file)), file))
		}
	}
	if len(parts) == 0 && r.fileSet["README.md"] {
		parts = append(parts, fmt.Sprintf("<README.md 全文>\n%s\n</README.md>", strings.TrimSpace(r.blobOf("README.md"))))
	}
	return wikiPlanCut(strings.Join(parts, "\n\n"), maxChars)
}

// codeFiles are the source files a list of paths, directories or globs names.
func (r *wikiPlanRepo) codeFiles(patterns []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range patterns {
		pattern := strings.Trim(strings.TrimSpace(raw), "`")
		if pattern == "" {
			continue
		}
		for _, file := range r.files {
			if seen[file] || r.symbols[file] == nil {
				continue
			}
			if wikiPlanPathMatches(pattern, file) {
				seen[file] = true
				out = append(out, file)
			}
		}
	}
	sort.Strings(out)
	return out
}

// codeExcerpt is the symbols of the files the patterns name, one file a line, within maxChars.
func (r *wikiPlanRepo) codeExcerpt(patterns []string, maxChars int) string {
	files := r.codeFiles(patterns)
	var b strings.Builder
	for i, file := range files {
		symbols := r.symbols[file]
		if len(symbols) > 36 {
			symbols = symbols[:36]
		}
		line := file + ": " + strings.Join(symbols, ", ") + "\n"
		if b.Len()+len(line) > maxChars {
			fmt.Fprintf(&b, "…（另有 %d 个文件略去）\n", len(files)-i)
			break
		}
		b.WriteString(line)
	}
	if b.Len() == 0 {
		return "（没有匹配到带符号的源文件）\n"
	}
	return b.String()
}

func wikiPlanCut(text string, maxChars int) string {
	if maxChars <= 0 || len([]rune(text)) <= maxChars {
		return text
	}
	return string([]rune(text)[:maxChars]) + "\n…（后略）\n"
}

// ── The references ──────────────────────────────────────────────────────────────────────────────

// wikiPlanPathMatches is a file named by a path, a directory (with or without its slash) or a glob.
func wikiPlanPathMatches(pattern, file string) bool {
	pattern = strings.TrimPrefix(pattern, "./")
	if strings.ContainsAny(pattern, "*?[") {
		if ok, _ := path.Match(pattern, file); ok {
			return true
		}
		// `dir/**/x.ts` and `dir/**`: any depth.
		if i := strings.Index(pattern, "**"); i >= 0 {
			prefix := pattern[:i]
			rest := strings.TrimPrefix(pattern[i+2:], "/")
			if !strings.HasPrefix(file, prefix) {
				return false
			}
			if rest == "" {
				return true
			}
			tail := strings.TrimPrefix(file, prefix)
			for {
				if ok, _ := path.Match(rest, tail); ok {
					return true
				}
				j := strings.IndexByte(tail, '/')
				if j < 0 {
					return false
				}
				tail = tail[j+1:]
			}
		}
		return false
	}
	return file == pattern || strings.HasPrefix(file, strings.TrimSuffix(pattern, "/")+"/")
}

// hasPath reports whether a path names anything at the sha: a file, a directory, or what a glob matches.
func (r *wikiPlanRepo) hasPath(raw string) bool {
	pattern := strings.TrimPrefix(strings.Trim(strings.TrimSpace(raw), "`"), "./")
	if pattern == "" {
		return false
	}
	if r.fileSet[pattern] || r.dirs[strings.TrimSuffix(pattern, "/")] {
		return true
	}
	if !strings.ContainsAny(pattern, "*?[") {
		return false
	}
	for _, file := range r.files {
		if wikiPlanPathMatches(pattern, file) {
			return true
		}
	}
	return false
}

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

// hasDocSection reports whether a document of the sha has a heading that reads as section.
func (r *wikiPlanRepo) hasDocSection(file, section string) bool {
	want := wikiPlanHeadingKey(section)
	if want == "" {
		return false
	}
	for _, h := range r.headings[strings.TrimPrefix(strings.TrimSpace(file), "./")] {
		if wikiPlanHeadingKey(h.Text) == want {
			return true
		}
	}
	return false
}

var (
	wikiPlanSymbolSuffix = regexp.MustCompile(`\s*(\[.*\]|（.*）|\(.*\))\s*$`)
	wikiPlanIdentifier   = regexp.MustCompile(`[A-Za-z_$][A-Za-z0-9_$]*`)
)

// wikiPlanSymbolKey is a symbol as the index and the model both spell it: no route, no parentheses.
func wikiPlanSymbolKey(symbol string) string {
	symbol = strings.Trim(strings.TrimSpace(symbol), "`")
	symbol = strings.TrimPrefix(symbol, "ext ")
	for {
		next := wikiPlanSymbolSuffix.ReplaceAllString(symbol, "")
		if next == symbol {
			break
		}
		symbol = strings.TrimSpace(next)
	}
	return strings.TrimSuffix(symbol, "()")
}

// hasSymbol reports whether a file — or a file under a directory, or one a glob matches — declares the
// symbol at the sha: in the index, or failing that, with every part of its name a word of that file.
func (r *wikiPlanRepo) hasSymbol(where, symbol string) bool {
	key := wikiPlanSymbolKey(symbol)
	if key == "" {
		return false
	}
	parts := wikiPlanIdentifier.FindAllString(key, -1)
	if len(parts) == 0 {
		return false
	}
	for _, file := range r.filesUnder(where) {
		for _, indexed := range r.symbols[file] {
			if wikiPlanSymbolKey(indexed) == key {
				return true
			}
		}
		text := r.blobs[file]
		if text == "" {
			continue
		}
		all := true
		for _, part := range parts {
			if !regexp.MustCompile(`(^|[^A-Za-z0-9_$])` + regexp.QuoteMeta(part) + `($|[^A-Za-z0-9_$])`).MatchString(text) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

// filesUnder are the source files a path, a directory or a glob names.
func (r *wikiPlanRepo) filesUnder(where string) []string {
	pattern := strings.TrimPrefix(strings.Trim(strings.TrimSpace(where), "`"), "./")
	if r.fileSet[pattern] {
		return []string{pattern}
	}
	var out []string
	for _, file := range r.files {
		if _, ok := r.blobs[file]; ok && wikiPlanIsSource(file) && wikiPlanPathMatches(pattern, file) {
			out = append(out, file)
		}
	}
	return out
}

// symbolsOf is what a file declares, as the gate offers it to a model that named one it does not have.
func (r *wikiPlanRepo) symbolsOf(where string, max int) []string {
	var out []string
	for _, file := range r.filesUnder(where) {
		for _, symbol := range r.symbols[file] {
			out = append(out, symbol)
			if len(out) >= max {
				return out
			}
		}
	}
	return out
}

// headingsOf is a document's headings, as the gate offers them to a model that named one it does not have.
func (r *wikiPlanRepo) headingsOf(file string, max int) []string {
	var out []string
	for _, h := range r.headings[strings.TrimPrefix(strings.TrimSpace(file), "./")] {
		if h.Level >= 2 {
			out = append(out, h.Text)
		}
		if len(out) >= max {
			break
		}
	}
	return out
}
