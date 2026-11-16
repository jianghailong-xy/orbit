package main

// Filling a cloned checkout's index with stat data it already knows
// (docs/session-checkout-storage-design.md §10). `git worktree add --no-checkout` and `read-tree` leave every index
// entry's stat fields zero, so `git update-index --refresh` reads every cloned file to hash it: on a checkout of the
// workspace's size, that is the largest cost of making a session checkout on a slow volume. A file cloned from the
// template whose content is the commit's needs no hashing: its size, mode, mtime, inode and so on are a cheap
// `lstat`, and the entry's blob SHA is already the commit's. This file writes those stat fields into the index so
// git finds the files clean without reading them. Anything the fast path cannot prove (a template edit, a different
// base, an index it does not understand) is left to git, which hashes it as before.

import (
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	gitIndexHeaderSize   = 12
	gitIndexChecksumSize = 20 // SHA-1; a SHA-256 index is refused before this parser runs
	gitIndexVersion2     = 2
	gitIndexVersion3     = 3

	// The on-disk entry's fixed part, without a path: ctime, mtime, dev, ino, mode, uid, gid, size (10 × 4),
	// the object name (20) and the flags (2).
	gitIndexEntryFixed = 62

	ceStageMask = 0x3000
	ceExtended  = 0x4000
	ceValid     = 0x8000

	// In the 16-bit extended-flags field of a version 3 entry.
	ceSkipWorktree = 0x4000
)

var (
	errGitIndexSplit     = errors.New("git index is split (link extension)")
	errGitIndexSparse    = errors.New("git index is a sparse index (sdir extension)")
	errGitIndexFSMonitor = errors.New("git index carries a filesystem monitor (FSMN extension)")
)

// gitIndexEntry is one path's on-disk index record, with its stat fields as Git keeps them: 32-bit seconds,
// nanoseconds and inode numbers. Git itself truncates st_dev, st_ino and the sizes to 32 bits.
type gitIndexEntry struct {
	ctimeSec  uint32
	ctimeNsec uint32
	mtimeSec  uint32
	mtimeNsec uint32
	dev       uint32
	ino       uint32
	mode      uint32
	uid       uint32
	gid       uint32
	size      uint32
	sha       [20]byte
	flags     uint16
	extFlags  uint16
	extended  bool
	path      string
}

type gitIndex struct {
	version    uint32
	entries    []*gitIndexEntry
	byPath     map[string]*gitIndexEntry // stage 0 only; nil where a path has more than one
	extensions []byte                    // each extension's signature, size and data, ready to write back
}

// unmarkedRegular is a file the checkout keeps with no index mark that could hide a change: stage 0, not
// assume-unchanged, not skip-worktree, and a regular file's mode.
func (e *gitIndexEntry) unmarkedRegular() bool {
	if e == nil {
		return false
	}
	if e.flags&ceStageMask != 0 || e.flags&ceValid != 0 {
		return false
	}
	if e.extended && e.extFlags&ceSkipWorktree != 0 {
		return false
	}
	return e.mode == 0o100644 || e.mode == 0o100755
}

func (e *gitIndexEntry) setStat(stat indexStatData) {
	e.ctimeSec, e.ctimeNsec = stat.ctimeSec, stat.ctimeNsec
	e.mtimeSec, e.mtimeNsec = stat.mtimeSec, stat.mtimeNsec
	e.dev, e.ino = stat.dev, stat.ino
	e.uid, e.gid, e.size = stat.uid, stat.gid, stat.size
}

// indexStatData is the part of lstat a git index stores. The platform files fill it in; a platform without a known
// syscall.Stat_t answers no and the fast path leaves every entry to git.
type indexStatData struct {
	ctimeSec  uint32
	ctimeNsec uint32
	mtimeSec  uint32
	mtimeNsec uint32
	dev       uint32
	ino       uint32
	uid       uint32
	gid       uint32
	size      uint32
}

// readGitIndex reads the index at path. It refuses versions it does not write back byte-for-byte, a checksum that
// does not verify, and index extensions whose meaning depends on the stat fields being untouched.
func readGitIndex(path string) (*gitIndex, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < gitIndexHeaderSize+gitIndexChecksumSize {
		return nil, fmt.Errorf("%s: too short for a git index", path)
	}
	if string(data[0:4]) != "DIRC" {
		return nil, fmt.Errorf("%s: not a git index", path)
	}
	version := binary.BigEndian.Uint32(data[4:8])
	if version != gitIndexVersion2 && version != gitIndexVersion3 {
		return nil, fmt.Errorf("%s: git index version %d is not supported", path, version)
	}
	count := binary.BigEndian.Uint32(data[8:12])
	end := len(data) - gitIndexChecksumSize
	off := gitIndexHeaderSize
	entries := make([]*gitIndexEntry, 0, count)
	for i := uint32(0); i < count; i++ {
		entryStart := off
		if off+gitIndexEntryFixed > end {
			return nil, fmt.Errorf("%s: entry %d is truncated", path, i)
		}
		e := &gitIndexEntry{}
		e.ctimeSec = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.ctimeNsec = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.mtimeSec = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.mtimeNsec = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.dev = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.ino = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.mode = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.uid = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.gid = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		e.size = binary.BigEndian.Uint32(data[off : off+4])
		off += 4
		copy(e.sha[:], data[off:off+20])
		off += 20
		e.flags = binary.BigEndian.Uint16(data[off : off+2])
		off += 2
		if e.flags&ceExtended != 0 {
			if version != gitIndexVersion3 {
				return nil, fmt.Errorf("%s: version 2 entry has extended flags", path)
			}
			if off+2 > end {
				return nil, fmt.Errorf("%s: entry %d is truncated", path, i)
			}
			e.extended = true
			e.extFlags = binary.BigEndian.Uint16(data[off : off+2])
			off += 2
		}
		nul := bytes.IndexByte(data[off:end], 0)
		if nul < 0 {
			return nil, fmt.Errorf("%s: entry %d has no path terminator", path, i)
		}
		e.path = string(data[off : off+nul])
		off += nul + 1
		// The entry is padded with NULs to a multiple of eight bytes, counting from its first stat byte.
		if pad := (8 - (off-entryStart)%8) % 8; pad != 0 {
			if off+pad > end {
				return nil, fmt.Errorf("%s: entry %d is truncated", path, i)
			}
			off += pad
		}
		entries = append(entries, e)
	}
	idx := &gitIndex{version: version, entries: entries, byPath: make(map[string]*gitIndexEntry, len(entries))}
	for off < end {
		if off+8 > end {
			return nil, fmt.Errorf("%s: a truncated index extension", path)
		}
		size := int(binary.BigEndian.Uint32(data[off+4 : off+8]))
		if size < 0 || off+8+size > end {
			return nil, fmt.Errorf("%s: a truncated index extension", path)
		}
		switch string(data[off : off+4]) {
		case "link":
			return nil, errGitIndexSplit
		case "sdir":
			return nil, errGitIndexSparse
		case "FSMN":
			return nil, errGitIndexFSMonitor
		}
		idx.extensions = append(idx.extensions, data[off:off+8+size]...)
		off += 8 + size
	}
	if off != end {
		return nil, fmt.Errorf("%s: %d bytes before the checksum are unread", path, end-off)
	}
	sum := sha1.Sum(data[:end])
	if !bytes.Equal(sum[:], data[end:]) {
		return nil, fmt.Errorf("%s: index checksum mismatch", path)
	}
	for _, e := range entries {
		if (e.flags&ceStageMask)>>12 != 0 {
			continue
		}
		if _, ok := idx.byPath[e.path]; ok {
			// Unmerged entries have the same path at several stages; leave it out rather than guess.
			idx.byPath[e.path] = nil
			continue
		}
		idx.byPath[e.path] = e
	}
	return idx, nil
}

// write puts the index at path, in the version and with the extensions it was read with, through an index.lock and
// a rename so that a failure leaves the index as it was.
func (idx *gitIndex) write(path string) error {
	var buf bytes.Buffer
	buf.Grow(gitIndexHeaderSize + len(idx.extensions) + gitIndexChecksumSize + len(idx.entries)*80)
	buf.WriteString("DIRC")
	appendUint32(&buf, idx.version)
	appendUint32(&buf, uint32(len(idx.entries)))
	for _, e := range idx.entries {
		entryStart := buf.Len()
		appendUint32(&buf, e.ctimeSec)
		appendUint32(&buf, e.ctimeNsec)
		appendUint32(&buf, e.mtimeSec)
		appendUint32(&buf, e.mtimeNsec)
		appendUint32(&buf, e.dev)
		appendUint32(&buf, e.ino)
		appendUint32(&buf, e.mode)
		appendUint32(&buf, e.uid)
		appendUint32(&buf, e.gid)
		appendUint32(&buf, e.size)
		buf.Write(e.sha[:])
		appendUint16(&buf, e.flags)
		if e.extended {
			appendUint16(&buf, e.extFlags)
		}
		buf.WriteString(e.path)
		buf.WriteByte(0)
		if pad := (8 - (buf.Len()-entryStart)%8) % 8; pad != 0 {
			buf.Write(make([]byte, pad))
		}
	}
	buf.Write(idx.extensions)
	sum := sha1.Sum(buf.Bytes())
	buf.Write(sum[:])

	lock := path + ".lock"
	out, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	written := false
	defer func() {
		if !written {
			_ = os.Remove(lock)
		}
	}()
	if _, err := out.Write(buf.Bytes()); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(lock, path); err != nil {
		return err
	}
	written = true
	return nil
}

func appendUint32(buf *bytes.Buffer, v uint32) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	buf.Write(b[:])
}

func appendUint16(buf *bytes.Buffer, v uint16) {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], v)
	buf.Write(b[:])
}

// fillClonedIndexStats writes the stat fields of the checkout's index entries for paths, the files the checkout just
// cloned from template. It fills an entry only when the clone must hold the commit's blob and no git rule could have
// hidden a template edit: the checkout keeps the path; neither index marks it assume-unchanged or skip-worktree; the
// template has the same mode and blob; the template's working tree has no change at that path; and the new file's
// size and executable bit are the commit's. Entries it cannot prove are left for `git update-index --refresh` to
// hash. Every error is the caller's to log: it then runs the refresh as if this had not been called.
func fillClonedIndexStats(wtPath, templatePath string, cloned []string) (filled, left int, err error) {
	left = len(cloned)
	if len(cloned) == 0 {
		return 0, 0, nil
	}
	format, err := git(wtPath, "rev-parse", "--show-object-format")
	if err != nil {
		return 0, left, err
	}
	if format != "sha1" {
		return 0, left, fmt.Errorf("object format is %q, not sha1", format)
	}
	if split, _ := git(wtPath, "config", "--bool", "core.splitIndex"); split == "true" {
		return 0, left, errGitIndexSplit
	}
	if fsmonitor, _ := git(wtPath, "config", "--get", "core.fsmonitor"); fsmonitor != "" {
		return 0, left, fmt.Errorf("core.fsmonitor is %q", fsmonitor)
	}
	wtIndexPath, err := gitIndexPath(wtPath)
	if err != nil {
		return 0, left, err
	}
	templateIndexPath, err := gitIndexPath(templatePath)
	if err != nil {
		return 0, left, err
	}
	wtIndex, err := readGitIndex(wtIndexPath)
	if err != nil {
		return 0, left, err
	}
	templateIndex, err := readGitIndex(templateIndexPath)
	if err != nil {
		return 0, left, err
	}
	dirty, err := templateDirtyPaths(templatePath)
	if err != nil {
		return 0, left, err
	}
	for _, path := range cloned {
		entry := wtIndex.byPath[path]
		held := templateIndex.byPath[path]
		if !entry.unmarkedRegular() || !held.unmarkedRegular() {
			continue
		}
		if entry.mode != held.mode || entry.sha != held.sha || dirty[path] {
			continue
		}
		info, err := os.Lstat(filepath.Join(wtPath, path))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if (info.Mode().Perm()&0o111 != 0) != (entry.mode == 0o100755) {
			// The template's executable bit is not the commit's; the reset writes the file again.
			continue
		}
		stat, ok := clonedIndexStat(info)
		if !ok || stat.size != held.size {
			continue
		}
		entry.setStat(stat)
		filled++
	}
	left = len(cloned) - filled
	if filled == 0 {
		return 0, left, nil
	}
	if err := wtIndex.write(wtIndexPath); err != nil {
		return 0, len(cloned), err
	}
	return filled, left, nil
}

// templateDirtyPaths is every tracked path whose working tree differs from template's HEAD, as git judges it: a
// staged edit still in the working tree, an unstaged edit, a deletion and a mode change. It is read-only, with
// optional locks off, so a probe cannot leave the template's index changed under the workspace.
func templateDirtyPaths(templatePath string) (map[string]bool, error) {
	out, err := gitNulOutput(templatePath, "--no-optional-locks", "diff-index", "--name-only", "-z", "HEAD", "--")
	if err != nil {
		return nil, err
	}
	dirty := map[string]bool{}
	for _, path := range bytes.Split(out, []byte{0}) {
		if len(path) != 0 {
			dirty[string(path)] = true
		}
	}
	return dirty, nil
}

// gitIndexPath is the absolute path of the index of the working tree at dir, which may be a linked worktree's own
// index under $GIT_DIR/worktrees/<id>/.
func gitIndexPath(dir string) (string, error) {
	out, err := git(dir, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	if out == "" {
		return "", errors.New("git rev-parse gave no index path")
	}
	return out, nil
}

// gitNulOutput is git's stdout untouched: no trimming, for NUL-terminated path lists.
func gitNulOutput(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return nil, fmt.Errorf("%v: %s", gitFailure(err), detail)
		}
		return nil, gitFailure(err)
	}
	return stdout.Bytes(), nil
}
