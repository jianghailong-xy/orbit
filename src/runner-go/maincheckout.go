package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The main checkout's snapshot, fingerprint and on-demand diff (docs/main-checkout-git-contract.md
// §2–§4, §7). Everything here only reads: no ref, no object and no index is written — not even the
// stat refresh `git status` would otherwise save into .git/index — so a scan can run beside a
// person's own git in that checkout, every minute, without ever being the one that left a lock.

// mainCheckoutScanTimeout bounds one snapshot. The scan hashes every changed file, so a checkout
// with a huge unignored build directory can take a while; a slow scan reports nothing rather than
// holding up whatever asked for it.
const mainCheckoutScanTimeout = 30 * time.Second

// mainCheckoutScan is a snapshot plus every changed file behind it: the snapshot lists at most
// mainCheckoutFileLimit, while the fingerprint and change detection need all of them.
type mainCheckoutScan struct {
	Snapshot MainCheckoutSnapshot
	// All is every changed file, sorted by path bytes, with Path, Status, ContentHash and
	// Untracked set (no counts).
	All []MainCheckoutFile
}

// mcGit runs read-only git in root and returns its stdout untrimmed: -z output starts with a path,
// and trimming would eat a leading space in it. Pathspecs are literal, so a file named `*.ts` or
// `[a]` means only itself, and no optional lock (the index stat refresh) is ever taken.
func mcGit(ctx context.Context, root string, stdin []byte, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root, "-c", "core.quotePath=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_LITERAL_PATHSPECS=1")
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	return out, gitFailure(err)
}

// splitZ splits NUL-terminated git output.
func splitZ(out []byte) []string {
	var parts []string
	for _, p := range bytes.Split(out, []byte{0}) {
		if len(p) > 0 {
			parts = append(parts, string(p))
		}
	}
	return parts
}

// mainCheckoutRoot resolves dir to its repo root with symlinks resolved (contract §2 `root`).
func mainCheckoutRoot(ctx context.Context, dir string) (string, error) {
	out, err := mcGit(ctx, expandTilde(dir), nil, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	root := strings.TrimRight(string(out), "\r\n")
	if root == "" {
		return "", errors.New("not a git repository")
	}
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	return root, nil
}

// mainCheckoutHead is HEAD's full sha, or "" before the first commit.
func mainCheckoutHead(ctx context.Context, root string) string {
	out, err := mcGit(ctx, root, nil, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// scanMainCheckout snapshots the main checkout dir sits in. Read-only; see the file comment.
func scanMainCheckout(ctx context.Context, dir string) (*mainCheckoutScan, error) {
	ctx, cancel := context.WithTimeout(ctx, mainCheckoutScanTimeout)
	defer cancel()
	root, err := mainCheckoutRoot(ctx, dir)
	if err != nil {
		return nil, err
	}
	head := mainCheckoutHead(ctx, root)
	all, err := mainCheckoutChangedFiles(ctx, root, head)
	if err != nil {
		return nil, err
	}
	snap := MainCheckoutSnapshot{
		Root:        root,
		Head:        head,
		Fingerprint: mainCheckoutFingerprint(head, all),
		CheckedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if out, err := mcGit(ctx, root, nil, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		snap.Branch = strings.TrimSpace(string(out))
	}
	snap.State = mainCheckoutState(ctx, root, len(all) > 0)
	if head != "" && snap.Branch != "" {
		if out, err := mcGit(ctx, root, nil, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
			if up := strings.TrimSpace(string(out)); up != "" {
				snap.Upstream = up
				if out, err := mcGit(ctx, root, nil, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"); err == nil {
					if f := strings.Fields(string(out)); len(f) == 2 {
						a, errA := strconv.Atoi(f[0])
						b, errB := strconv.Atoi(f[1])
						if errA == nil && errB == nil {
							snap.Ahead, snap.Behind = &a, &b
						}
					}
				}
			}
		}
	}
	listed, truncated := capMainCheckoutFiles(all)
	snap.Files = mainCheckoutCounts(ctx, root, head, listed)
	snap.FileCount = len(snap.Files)
	snap.Truncated = truncated
	return &mainCheckoutScan{Snapshot: snap, All: all}, nil
}

// mainCheckoutState is inspectRepoRoot's classification without its porcelain `git diff`, which
// saves refreshed stat data into .git/index: an operation in flight first, then unresolved
// conflicts, then any changed file (untracked included).
func mainCheckoutState(ctx context.Context, root string, changed bool) string {
	switch {
	case gitPathExists(root, "rebase-merge"), gitPathExists(root, "rebase-apply"):
		return repoStateRebase
	case gitPathExists(root, "MERGE_HEAD"):
		return repoStateMerge
	case gitPathExists(root, "CHERRY_PICK_HEAD"):
		return repoStateCherryPick
	case gitPathExists(root, "REVERT_HEAD"):
		return repoStateRevert
	}
	if out, err := mcGit(ctx, root, nil, "ls-files", "-z", "--unmerged"); err == nil && len(splitZ(out)) > 0 {
		return repoStateUnmerged
	}
	if changed {
		return repoStateDirty
	}
	return repoStateClean
}

// capMainCheckoutFiles keeps the first mainCheckoutFileLimit files (already in byte order).
func capMainCheckoutFiles(files []MainCheckoutFile) ([]MainCheckoutFile, bool) {
	if len(files) > mainCheckoutFileLimit {
		return append([]MainCheckoutFile(nil), files[:mainCheckoutFileLimit]...), true
	}
	return append([]MainCheckoutFile{}, files...), false
}

// mainCheckoutFingerprint is contract §3: HEAD plus every changed file's status, content hash and
// path, in path byte order.
func mainCheckoutFingerprint(head string, files []MainCheckoutFile) string {
	sorted := append([]MainCheckoutFile(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	if head == "" {
		head = "-"
	}
	h := sha256.New()
	h.Write([]byte("mc1\nhead " + head + "\n"))
	for _, f := range sorted {
		h.Write([]byte(f.Status + " " + f.ContentHash + " " + f.Path + "\x00"))
	}
	return "mc1:" + head + ":" + hex.EncodeToString(h.Sum(nil))
}

// mainCheckoutChangedFiles lists every path whose working-tree content differs from HEAD:
// modified, added (staged or untracked) and deleted, ignored files excluded, no rename detection.
//
// Only plumbing is used: porcelain `git diff` saves refreshed stat data into .git/index whenever a
// clean file's stat changed, GIT_OPTIONAL_LOCKS or not. diff-index never refreshes, so a file
// whose stat changed but whose content didn't is a candidate here and drops out on its hash.
//
// Status is decided by content, not by the index: a path counts as M only when its working-tree
// blob differs from HEAD's, so a file staged and then edited back, or `git rm --cached` with the
// file still on disk, is not reported as changed.
func mainCheckoutChangedFiles(ctx context.Context, root, head string) ([]MainCheckoutFile, error) {
	headBlob := map[string]string{} // path → HEAD blob, for candidates that exist in HEAD
	candidates := map[string]bool{}
	if head != "" {
		out, err := mcGit(ctx, root, nil, "diff-index", "--raw", "-z", "--no-renames", "HEAD")
		if err != nil {
			return nil, fmt.Errorf("git diff-index: %w", err)
		}
		parts := splitZ(out)
		for i := 0; i+1 < len(parts); i++ {
			if !strings.HasPrefix(parts[i], ":") {
				continue
			}
			meta, p := strings.Fields(parts[i]), parts[i+1]
			i++
			candidates[p] = true
			// :<old mode> <new mode> <old sha> <new sha> <status>
			if len(meta) >= 3 && strings.TrimPrefix(meta[0], ":") != "000000" {
				headBlob[p] = meta[2]
			}
		}
	} else {
		// Before the first commit there is no HEAD to diff against: everything in the index is new.
		out, err := mcGit(ctx, root, nil, "ls-files", "-z", "--cached")
		if err != nil {
			return nil, fmt.Errorf("git ls-files: %w", err)
		}
		for _, p := range splitZ(out) {
			candidates[p] = true
		}
	}
	out, err := mcGit(ctx, root, nil, "ls-files", "-z", "--others", "--exclude-standard")
	if err != nil {
		return nil, fmt.Errorf("git ls-files --others: %w", err)
	}
	untracked := map[string]bool{}
	for _, p := range splitZ(out) {
		p = strings.TrimSuffix(p, "/") // a nested repository is listed as its directory
		untracked[p] = true
		candidates[p] = true
	}

	paths := make([]string, 0, len(candidates))
	for p := range candidates {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	// A conflicted path's diff entry carries zero ids, so ask HEAD directly for tracked candidates
	// the diff gave no blob for.
	var unknown []string
	for _, p := range paths {
		if _, ok := headBlob[p]; !ok && head != "" && !untracked[p] {
			unknown = append(unknown, p)
		}
	}
	for len(unknown) > 0 {
		chunk := unknown[:min(len(unknown), 500)]
		unknown = unknown[len(chunk):]
		out, err := mcGit(ctx, root, nil, append([]string{"ls-tree", "-z", "HEAD", "--"}, chunk...)...)
		if err != nil {
			return nil, fmt.Errorf("git ls-tree: %w", err)
		}
		for _, rec := range splitZ(out) {
			// <mode> SP <type> SP <object> TAB <path>
			meta, p, ok := strings.Cut(rec, "\t")
			if f := strings.Fields(meta); ok && len(f) == 3 {
				headBlob[p] = f[2]
			}
		}
	}
	hashes, err := mainCheckoutHashes(ctx, root, paths)
	if err != nil {
		return nil, err
	}
	var files []MainCheckoutFile
	for _, p := range paths {
		hash, onDisk := hashes[p]
		old, inHead := headBlob[p]
		f := MainCheckoutFile{Path: p, ContentHash: hash, Untracked: untracked[p]}
		switch {
		case !onDisk && inHead:
			f.Status, f.ContentHash, f.Untracked = "D", "-", false
		case !onDisk:
			continue // staged as new, then removed from disk: the same as HEAD
		case inHead && hash == old:
			continue // the working tree matches HEAD; only the index differs
		case inHead:
			f.Status = "M"
		default:
			f.Status = "A"
		}
		files = append(files, f)
	}
	return files, nil
}

// mainCheckoutHashes is each existing path's working-tree blob id, as `git hash-object <path>`
// would print it (filters applied) but without writing the object. Absent paths are left out.
func mainCheckoutHashes(ctx context.Context, root string, paths []string) (map[string]string, error) {
	hashes := map[string]string{}
	var batch []string
	for _, p := range paths {
		abs := filepath.Join(root, filepath.FromSlash(p))
		info, err := os.Lstat(abs)
		if err != nil {
			continue
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			// Git stores a link as its target text; hash-object on the path would follow it.
			target, err := os.Readlink(abs)
			if err != nil {
				continue
			}
			out, err := mcGit(ctx, root, []byte(target), "hash-object", "--stdin")
			if err != nil {
				return nil, fmt.Errorf("git hash-object: %w", err)
			}
			hashes[p] = strings.TrimSpace(string(out))
		case info.IsDir():
			// A submodule or a nested repository: its content is the commit it is on.
			if out, err := mcGit(ctx, abs, nil, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
				hashes[p] = strings.TrimSpace(string(out))
			} else {
				hashes[p] = "-"
			}
		case strings.ContainsAny(p, "\n\r"):
			// --stdin-paths is line-based; a path with a line break goes on its own.
			out, err := mcGit(ctx, root, nil, "hash-object", "--", p)
			if err != nil {
				return nil, fmt.Errorf("git hash-object: %w", err)
			}
			hashes[p] = strings.TrimSpace(string(out))
		default:
			batch = append(batch, p)
		}
	}
	if len(batch) == 0 {
		return hashes, nil
	}
	out, err := mcGit(ctx, root, []byte(strings.Join(batch, "\n")+"\n"), "hash-object", "--stdin-paths")
	if err != nil {
		return nil, fmt.Errorf("git hash-object: %w", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) != len(batch) {
		return nil, fmt.Errorf("git hash-object: %d ids for %d paths", len(lines), len(batch))
	}
	for i, p := range batch {
		hashes[p] = strings.TrimSpace(lines[i])
	}
	return hashes, nil
}

// mainCheckoutCounts fills Binary/Additions/Deletions for files, from git's numstat against HEAD
// and, for files git doesn't track, from the file on disk.
func mainCheckoutCounts(ctx context.Context, root, head string, files []MainCheckoutFile) []MainCheckoutFile {
	type stat struct {
		binary   bool
		add, del int
	}
	stats := map[string]stat{}
	if head != "" && len(files) > 0 {
		args := []string{"diff-index", "--numstat", "-z", "--no-renames", "HEAD", "--"}
		for _, f := range files {
			if !f.Untracked {
				args = append(args, f.Path)
			}
		}
		if out, err := mcGit(ctx, root, nil, args...); err == nil {
			for _, rec := range splitZ(out) {
				fields := strings.SplitN(rec, "\t", 3)
				if len(fields) != 3 {
					continue
				}
				if fields[0] == "-" {
					stats[fields[2]] = stat{binary: true}
					continue
				}
				a, _ := strconv.Atoi(fields[0])
				d, _ := strconv.Atoi(fields[1])
				stats[fields[2]] = stat{add: a, del: d}
			}
		}
	}
	for i := range files {
		f := &files[i]
		st, ok := stats[f.Path]
		if !ok && f.Status == "A" {
			binary, lines, err := countFileLines(filepath.Join(root, filepath.FromSlash(f.Path)))
			if err != nil {
				continue
			}
			st, ok = stat{binary: binary, add: lines}, true
		}
		if !ok {
			continue
		}
		if st.binary {
			f.Binary = true
			continue
		}
		a, d := st.add, st.del
		f.Additions, f.Deletions = &a, &d
	}
	return files
}

// countFileLines reads a file the way git counts a new one: binary when its first 8000 bytes hold a
// NUL, otherwise its line count (a last line without a newline counts).
func countFileLines(name string) (binary bool, lines int, err error) {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return false, 0, errors.New("not a regular file")
	}
	fh, err := os.Open(name)
	if err != nil {
		return false, 0, err
	}
	defer fh.Close()
	r := bufio.NewReader(fh)
	head, _ := r.Peek(8000)
	if bytes.IndexByte(head, 0) >= 0 {
		return true, 0, nil
	}
	buf := make([]byte, 64*1024)
	var last byte = '\n'
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			lines += bytes.Count(buf[:n], []byte{'\n'})
			last = buf[n-1]
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return false, 0, rerr
		}
	}
	if last != '\n' {
		lines++
	}
	return false, lines, nil
}

// validMainCheckoutPath accepts a repo-relative, `/`-separated path that stays inside the checkout.
func validMainCheckoutPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") {
		return false
	}
	return path.Clean(p) == p && p != "." && p != ".." && !strings.HasPrefix(p, "../")
}

// mainCheckoutFileDiff is one changed file's patch against HEAD (contract §2 Diff), read on demand
// and capped at mainCheckoutPatchMaxBytes. A binary file carries no patch; a deleted one reads as
// git's `deleted file mode` patch; a rename is a delete and an add, each read on its own path.
func mainCheckoutFileDiff(ctx context.Context, dir, file string) (MainCheckoutFileDiff, error) {
	ctx, cancel := context.WithTimeout(ctx, mainCheckoutScanTimeout)
	defer cancel()
	if !validMainCheckoutPath(file) {
		return MainCheckoutFileDiff{}, fmt.Errorf("not a path inside the checkout: %q", file)
	}
	root, err := mainCheckoutRoot(ctx, dir)
	if err != nil {
		return MainCheckoutFileDiff{}, err
	}
	head := mainCheckoutHead(ctx, root)
	tracked := false
	if out, err := mcGit(ctx, root, nil, "ls-files", "-z", "--cached", "--", file); err == nil && len(splitZ(out)) > 0 {
		tracked = true
	}
	inHead := false
	if head != "" {
		if out, err := mcGit(ctx, root, nil, "ls-tree", "-z", "--name-only", "HEAD", "--", file); err == nil && len(splitZ(out)) > 0 {
			inHead = true
		}
	}
	d := MainCheckoutFileDiff{Path: file}
	var args []string
	switch {
	case head != "" && (tracked || inHead):
		args = []string{"diff-index", "-p", "--no-renames", "--no-ext-diff", "HEAD", "--", file}
	default:
		// Untracked, or new before the first commit: the whole file against nothing. --no-index
		// takes file paths, not pathspecs, and exits 1 when there is a difference.
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(file))); err != nil {
			return MainCheckoutFileDiff{}, fmt.Errorf("%s is not in the checkout", file)
		}
		args = []string{"diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", file}
	}
	statArgs := []string{args[0], "--numstat"}
	for _, a := range args[1:] {
		if a != "-p" {
			statArgs = append(statArgs, a)
		}
	}
	numstat, err := mcGit(ctx, root, nil, statArgs...)
	if err != nil && !isExitCode(err, 1) {
		return MainCheckoutFileDiff{}, fmt.Errorf("git diff: %w", err)
	}
	if strings.HasPrefix(string(numstat), "-\t-\t") {
		d.Binary = true
		return d, nil
	}
	patch, err := mcGit(ctx, root, nil, args...)
	if err != nil && !isExitCode(err, 1) {
		return MainCheckoutFileDiff{}, fmt.Errorf("git diff: %w", err)
	}
	if len(patch) > mainCheckoutPatchMaxBytes {
		cut := bytes.LastIndexByte(patch[:mainCheckoutPatchMaxBytes], '\n')
		if cut < 0 {
			cut = mainCheckoutPatchMaxBytes - 1
		}
		patch, d.PatchTruncated = patch[:cut+1], true
	}
	d.Patch = string(patch)
	return d, nil
}

// isExitCode reports whether err is a process exit with the given code.
func isExitCode(err error, code int) bool {
	var ee *exec.ExitError
	return errors.As(err, &ee) && ee.ExitCode() == code
}

// mainCheckoutWatch notices when an isolated session's turn changes the main checkout its worktree
// forked from, instead of its own worktree (contract §7 main-checkout-changed).
//
// Nothing prevents that, and the ways in are mundane: the Bash tool's working directory persists
// between calls, so one legitimate `cd <workDir>` silently redirects every later relative-path
// write. The edit then sits in the main checkout — absent from every branch, in the way of other
// sessions' merges, and baked into the next image built from that directory.
//
// Changes are compared by path AND content: a file that was already dirty when the session started
// stays quiet until its content changes again, and then it is reported. The baseline moves to what
// was seen after each turn, so one batch of changes produces one card.
type mainCheckoutWatch struct {
	mu   sync.Mutex
	dir  string
	seen map[string]string // path → status+" "+contentHash; nil until a scan succeeded
}

// watchMainCheckout starts watching the main checkout a worktree forked from. Nil for a session
// that isn't isolated: the main checkout IS its workspace, so writing there is the normal case.
func watchMainCheckout(wt *Worktree) *mainCheckoutWatch {
	if wt == nil || wt.RepoDir == "" {
		return nil
	}
	w := &mainCheckoutWatch{dir: wt.RepoDir}
	if scan, err := scanMainCheckout(context.Background(), w.dir); err == nil {
		w.seen = mainCheckoutStateMap(scan.All)
	}
	return w
}

func mainCheckoutStateMap(files []MainCheckoutFile) map[string]string {
	m := make(map[string]string, len(files))
	for _, f := range files {
		m[f.Path] = f.Status + " " + f.ContentHash
	}
	return m
}

// changed rescans the main checkout and returns the notice for paths that are new or whose content
// changed since the last call, or nil when there are none. A baseline that could not be taken is
// taken now, silently, rather than blaming everything already there on this session.
func (w *mainCheckoutWatch) changed() *MainCheckoutChangedNotice {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	scan, err := scanMainCheckout(context.Background(), w.dir)
	if err != nil {
		return nil
	}
	current := mainCheckoutStateMap(scan.All)
	prev := w.seen
	w.seen = current
	if prev == nil {
		return nil
	}
	var fresh []MainCheckoutFile
	for _, f := range scan.All {
		if prev[f.Path] != current[f.Path] {
			fresh = append(fresh, f)
		}
	}
	if len(fresh) == 0 {
		return nil
	}
	listed, truncated := capMainCheckoutFiles(fresh)
	listed = mainCheckoutCounts(context.Background(), scan.Snapshot.Root, scan.Snapshot.Head, listed)
	n := &MainCheckoutChangedNotice{
		NoticeKind:  noticeMainCheckoutChanged,
		Root:        scan.Snapshot.Root,
		Branch:      scan.Snapshot.Branch,
		Files:       make([]MainCheckoutChangedFile, 0, len(listed)),
		FileCount:   len(listed),
		Truncated:   truncated,
		Fingerprint: scan.Snapshot.Fingerprint,
	}
	for _, f := range listed {
		n.Files = append(n.Files, MainCheckoutChangedFile{
			Path: f.Path, Status: f.Status, Binary: f.Binary, Additions: f.Additions, Deletions: f.Deletions,
		})
	}
	n.Notice = mainCheckoutCardTitle(n.FileCount, n.Truncated) + " " + mainCheckoutCardSubtitle(n.Root, n.Branch)
	return n
}

// payload is the notice as a system event's payload, in exactly its wire shape.
func (n *MainCheckoutChangedNotice) payload() map[string]interface{} {
	raw, _ := json.Marshal(n)
	var m map[string]interface{}
	_ = json.Unmarshal(raw, &m)
	return m
}

// mainCheckoutCardTitle and mainCheckoutCardSubtitle mirror @orbit/shared's builders of the same
// names (board 01 card); main_checkout_types_test.go holds them to the fixture's changedNotice.
func mainCheckoutCardTitle(fileCount int, truncated bool) string {
	if truncated {
		return fmt.Sprintf("At least %s changed in the main checkout during this turn", plural(fileCount, "file"))
	}
	return fmt.Sprintf("%s changed in the main checkout during this turn", plural(fileCount, "file"))
}

func mainCheckoutCardSubtitle(root, branch string) string {
	where := root
	if branch != "" {
		where = root + " on " + branch
	}
	return where + ", outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."
}

// mainCheckoutHeartbeat is the heartbeat's counts and fingerprint for a checkout (contract §4),
// or nil when the scan failed — the entry then carries only what it always did.
func mainCheckoutHeartbeat(root string) *MainCheckoutHeartbeatFields {
	scan, err := scanMainCheckout(context.Background(), root)
	if err != nil {
		return nil
	}
	s := scan.Snapshot
	count, truncated := s.FileCount, s.Truncated
	return &MainCheckoutHeartbeatFields{
		Head: s.Head, Upstream: s.Upstream, Ahead: s.Ahead, Behind: s.Behind,
		FileCount: &count, Truncated: &truncated, Fingerprint: s.Fingerprint,
	}
}
