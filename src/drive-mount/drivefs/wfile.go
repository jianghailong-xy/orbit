package drivefs

import (
	"bytes"
	"container/list"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

// Locks. FS.mu and wfile.mu never nest: a write state reports to the file system after letting go of its own lock,
// and the file system reads a write state's size and mtime from atomics. wfile.wmu serializes the writes, truncations
// and commits of one entry, so two appenders never interleave inside one write() (§5.9 row 4); wfile.mu guards the
// chunks and is let go while bytes travel, so readers on the same mount are not held up by an upload.

// wmode is how a write state was opened (§5.2), which decides where writes are accepted and what a commit is.
type wmode int

const (
	// modeNew is a file this mount created: writes anywhere, commits CONTINUE its own first version.
	modeNew wmode = iota
	// modeTrunc is an existing file emptied (O_TRUNC, ftruncate to 0): writes anywhere, the first commit is an
	// OVERWRITE making a version, later ones CONTINUE it.
	modeTrunc
	// modeAppend is bytes after a base version: writes only at the end, commits APPEND, no version (§3.2).
	modeAppend
	// modeExisting is an existing file opened without O_TRUNC or O_APPEND: only a write at exactly its end is
	// accepted, and makes it an append.
	modeExisting
)

func (m wmode) String() string {
	return [...]string{"new", "truncated", "append", "existing"}[m]
}

var (
	errInPlace = errors.New("in-place write")
	// errAbandoned is a write whose close failed and whose bytes were kept in unsent/: nothing more of it is
	// committed behind the writer's back (§5.7).
	errAbandoned = errors.New("this write's close failed and its bytes are in unsent/")
)

// wchunk is one chunk of the region a write state holds: at most 8 MiB, on a grid from the region's start.
type wchunk struct {
	off    int64
	length int64

	file      string // the spool file holding the bytes, or ""
	zero      bool   // all zeros, kept nowhere: an all-zero chunk is one shared blob
	dirty     bool   // the bytes changed since they were last sent
	sha       string // the content's sha256 when not dirty
	staged    bool   // a staging row holds sha, until the next commit
	held      bool   // a version of the account names sha
	ver       uint64 // moves with every change
	uploading bool
	dropped   bool
	clean     *list.Element // in the spool's evictable list
}

// wfile is the write state of one entry on this mount, shared by every handle open for writing on it (§5.2): the
// bytes no commit has taken, in the spool, and how they will be committed. It is bound to the entry id, so a rename
// or an unlink of the open file moves nothing of it.
type wfile struct {
	fs       *FS
	n        *node
	key      string
	entryID  string
	handleID string

	refs int // open handles; guarded by FS.mu
	// gaveUp mirrors failed for the file system, which may not take mu.
	gaveUp atomic.Bool
	// periodic is set while a periodic commit of it runs.
	periodic atomic.Bool

	shownSize  atomic.Int64
	shownMtime atomic.Int64 // unix nanoseconds

	wmu sync.Mutex
	mu  sync.Mutex
	// cond is signalled when an upload ends.
	cond *sync.Cond

	mode         wmode
	size         int64
	mtime        time.Time
	pendingMtime *time.Time

	// The region this mount writes: chunks on an 8 MiB grid from regionStart, numbered from firstIdx in a commit.
	regionStart int64
	firstIdx    int
	chunks      []*wchunk

	// modeAppend: the version the bytes go after, and, when it is the base's last chunk under 64 KiB merged into
	// chunks[0], that chunk (§3.2).
	baseVersion string
	baseSize    int64
	baseChunks  []door.Chunk // nil when not known
	replaceTail *door.ReplaceTail

	// modeNew and modeTrunc: the version this handle writes ("" for modeTrunc until its first commit makes one).
	version string

	staging     string
	stagingWait chan struct{} // closed when a staging open in flight ends
	stagedRows  map[int]string
	zeroStaged  map[int64]bool // a staging row holds that many zeros, until the next commit

	dirty      bool
	gen        uint64
	lastWrite  time.Time
	dirtySince time.Time
	lastCommit time.Time
	nextTry    time.Time
	failed     error
	commitID   string
	uploads    int
	session    string
	nextChunk  int
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// newWfile makes a write state from n's attributes captured under FS.mu.
func (fs *FS) newWfile(n *node, mode wmode, handleID string, size int64, mtime time.Time, version string) *wfile {
	if handleID == "" {
		handleID = newUUID()
	}
	wf := &wfile{
		fs: fs, n: n, key: newUUID(), entryID: n.id, handleID: handleID, mode: mode,
		stagedRows: map[int]string{}, zeroStaged: map[int64]bool{}, size: size, mtime: mtime,
	}
	if wf.mtime.IsZero() {
		wf.mtime = time.Now()
	}
	wf.cond = sync.NewCond(&wf.mu)
	switch mode {
	case modeNew:
		wf.size, wf.version = 0, version
	case modeTrunc:
		wf.size = 0
		wf.markDirtyLocked()
	}
	wf.showLocked()
	return wf
}

// showLocked publishes the size and mtime stat shows while the entry is being written here.
func (wf *wfile) showLocked() {
	wf.shownSize.Store(wf.size)
	t := wf.mtime
	if wf.pendingMtime != nil {
		t = *wf.pendingMtime
	}
	wf.shownMtime.Store(t.UnixNano())
}

// attr is the size and mtime stat shows: lock-free, so the file system may ask under its own lock.
func (wf *wfile) attr() (int64, time.Time) {
	return wf.shownSize.Load(), time.Unix(0, wf.shownMtime.Load())
}

func (wf *wfile) markDirtyLocked() {
	if !wf.dirty {
		wf.dirtySince = time.Now()
	}
	wf.dirty = true
	wf.gen++
}

func (wf *wfile) isDirty() bool {
	wf.mu.Lock()
	defer wf.mu.Unlock()
	return wf.dirty && wf.failed == nil
}

// setBaseLocked makes the write an append after manifest m (§3.2): when the last chunk is under 64 KiB, the first
// appended bytes are merged into it and the commit names it in replaceTail.
func (wf *wfile) setBaseLocked(m door.Manifest) {
	for _, c := range wf.chunks {
		wf.dropChunkLocked(c)
	}
	wf.chunks, wf.replaceTail = nil, nil
	wf.mode = modeAppend
	wf.baseVersion, wf.baseSize = m.VersionID, m.SizeBytes
	wf.baseChunks = append([]door.Chunk{}, m.Chunks...)
	wf.size = m.SizeBytes
	wf.regionStart, wf.firstIdx = wf.baseSize, len(wf.baseChunks)
	if n := len(wf.baseChunks); n > 0 && wf.baseChunks[n-1].Size < tailMerge {
		last := wf.baseChunks[n-1]
		wf.regionStart, wf.firstIdx = last.Offset, last.Idx
		wf.replaceTail = &door.ReplaceTail{Idx: last.Idx, OldSHA256: last.SHA256}
		wf.chunks = []*wchunk{{off: last.Offset, length: last.Size, sha: last.SHA256, held: true}}
	}
	wf.showLocked()
}

// toTruncLocked empties the file: what an existing file's O_TRUNC or ftruncate to 0 does.
func (wf *wfile) toTruncLocked(continueVersion bool) {
	for _, c := range wf.chunks {
		wf.dropChunkLocked(c)
	}
	wf.chunks = nil
	wf.regionStart, wf.firstIdx, wf.size = 0, 0, 0
	wf.baseChunks, wf.replaceTail, wf.baseVersion, wf.baseSize = nil, nil, "", 0
	// One handle's truncate-and-rewrite continues its version. A fresh truncate starts an overwrite.
	if !continueVersion || (wf.mode != modeNew && wf.mode != modeTrunc) {
		wf.mode, wf.version = modeTrunc, ""
	}
	wf.mtime = time.Now()
	wf.markDirtyLocked()
	wf.showLocked()
}

// ── spool files ──────────────────────────────────────────────────────────────────────────────────

func (wf *wfile) chunkPath() string {
	wf.nextChunk++
	return filepath.Join(wf.fs.spool.dir, "w", fmt.Sprintf("%s-%d", wf.key, wf.nextChunk))
}

// dropChunkLocked frees a chunk's spool file.
func (wf *wfile) dropChunkLocked(c *wchunk) {
	c.dropped = true
	wf.fs.spool.forgetClean(c)
	if c.file != "" {
		_ = os.Remove(c.file)
		wf.fs.spool.release(c.length)
		c.file = ""
	}
}

// localLocked makes sure c's bytes are in the spool, fetching them back if they were evicted (§5.3), with room for
// it to grow to top bytes. The lock may be let go meanwhile; the caller checks c still stands where it did.
func (wf *wfile) localLocked(ctx context.Context, c *wchunk, idx int, top int64) error {
	wf.fs.spool.forgetClean(c)
	if c.file != "" {
		if top > c.length {
			wf.reserveLocked(top - c.length)
		}
		return nil
	}
	var data []byte
	if !c.zero && c.length > 0 {
		var err error
		data, err = wf.fetchLocked(ctx, c, idx)
		if err != nil {
			return err
		}
		if c.file != "" || c.dropped {
			return nil
		}
	}
	path := wf.chunkPath()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if len(data) > 0 {
		if _, err := f.Write(data); err != nil {
			os.Remove(path)
			return err
		}
	} else if c.length > 0 {
		if err := f.Truncate(c.length); err != nil {
			os.Remove(path)
			return err
		}
	}
	room := c.length
	if top > room {
		room = top
	}
	wf.reserveLocked(room)
	c.file, c.zero = path, false
	return nil
}

// fetchLocked reads an evicted chunk back: from its staging while uncommitted, from the store once a version names
// it. The lock is let go meanwhile.
func (wf *wfile) fetchLocked(ctx context.Context, c *wchunk, idx int) ([]byte, error) {
	sha, size, stagedOnly, staging := c.sha, c.length, c.staged && !c.held, wf.staging
	wf.mu.Unlock()
	defer wf.mu.Lock()
	if stagedOnly && staging != "" {
		data, err := wf.fs.door.StagingChunk(ctx, staging, idx, size)
		if err == nil && int64(len(data)) == size && hexSHA(data) == sha {
			return data, nil
		}
	}
	return wf.fs.cache.bytes(ctx, sha, size)
}

func hexSHA(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// reserveLocked takes room in the spool, making it first when the spool is full: clean chunks are evicted, and failing
// that this write uploads its own oldest dirty chunk. Uploading always makes room, so writers never wait for each
// other and never forever (§5.3); when nothing can be uploaded the room is taken anyway, by one chunk at most.
func (wf *wfile) reserveLocked(need int64) {
	sp := wf.fs.spool
	if need <= 0 || need > sp.limit {
		sp.take(need)
		return
	}
	deadline := time.Now().Add(60 * time.Second)
	for !sp.tryTake(need) {
		if sp.evict(need, wf) || wf.uploadOldestLocked(wf.fs.ctx) {
			continue
		}
		if wf.fs.door.Health().Offline() || time.Now().After(deadline) {
			// Nothing makes room: taken anyway, a chunk at most, rather than a writer waiting forever.
			sp.take(need)
			return
		}
		// Other writers' uploads in flight make room as they end.
		wf.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		wf.mu.Lock()
	}
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────

// chunkAtLocked is the region chunk holding offset off, made (empty, as zeros) if the region does not reach it.
func (wf *wfile) chunkAtLocked(off int64) (int, *wchunk) {
	j := int((off - wf.regionStart) / ChunkMax)
	for len(wf.chunks) <= j {
		start := wf.regionStart + int64(len(wf.chunks))*ChunkMax
		wf.chunks = append(wf.chunks, &wchunk{off: start, zero: true})
	}
	return j, wf.chunks[j]
}

func (wf *wfile) touchChunkLocked(c *wchunk) {
	if !c.zero {
		c.dirty = true
	}
	c.staged, c.held, c.sha = false, false, ""
	c.ver++
	wf.fs.spool.forgetClean(c)
}

// stillAt reports whether c is still chunk j of the region, after the lock was let go.
func (wf *wfile) stillAt(j int, c *wchunk) bool {
	return !c.dropped && j < len(wf.chunks) && wf.chunks[j] == c
}

// growZerosLocked extends the file with zeros to size: a write past the end, or ftruncate to a larger size (§5.2).
func (wf *wfile) growZerosLocked(ctx context.Context, size int64) error {
	for wf.size < size {
		j, c := wf.chunkAtLocked(wf.size)
		end := minI(c.off+ChunkMax, size)
		if !c.zero || c.file != "" {
			if err := wf.localLocked(ctx, c, wf.firstIdx+j, end-c.off); err != nil {
				return err
			}
			if !wf.stillAt(j, c) {
				continue
			}
			if err := os.Truncate(c.file, end-c.off); err != nil {
				return err
			}
		}
		c.length = end - c.off
		wf.touchChunkLocked(c)
		wf.size = end
	}
	return nil
}

// write puts data at off, or at the end when off is negative (O_APPEND). It answers errInPlace for a write the drive
// does not take: inside an existing file, or anywhere but its end (§5.6).
func (wf *wfile) write(ctx context.Context, h *handle, off int64, data []byte) error {
	wf.wmu.Lock()
	defer wf.wmu.Unlock()
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if wf.failed != nil {
		return wf.failed
	}
	atEnd := off < 0
	if atEnd {
		off = wf.size
	}
	// A reopen can share the previous writer's state before FUSE delivers RELEASE. Only a handle
	// that created or emptied the file can use that state's permission to rewrite it.
	if !h.rewrite && off != wf.size {
		return errInPlace
	}
	switch wf.mode {
	case modeExisting:
		if off != wf.size {
			return errInPlace
		}
		if err := wf.becomeAppendLocked(ctx); err != nil {
			return err
		}
		fallthrough
	case modeAppend:
		// An O_APPEND write goes at the end as the server has it now, which another runner's append may have moved.
		if atEnd {
			off = wf.size
		} else if off != wf.size {
			return errInPlace
		}
	}
	if off > wf.size {
		if err := wf.growZerosLocked(ctx, off); err != nil {
			return err
		}
	}
	end := off + int64(len(data))
	for pos := off; pos < end; {
		j, c := wf.chunkAtLocked(pos)
		within := pos - c.off
		n := minI(end-pos, ChunkMax-within)
		if err := wf.localLocked(ctx, c, wf.firstIdx+j, maxI(within+n, c.length)); err != nil {
			return err
		}
		if !wf.stillAt(j, c) {
			continue
		}
		if err := pwrite(c.file, data[pos-off:pos-off+n], within); err != nil {
			return err
		}
		if within+n > c.length {
			c.length = within + n
		}
		c.zero = false
		wf.touchChunkLocked(c)
		pos += n
	}
	if end > wf.size {
		wf.size = end
	}
	wf.mtime = time.Now()
	wf.lastWrite = wf.mtime
	wf.markDirtyLocked()
	wf.showLocked()
	// A full chunk the writer has moved past goes now, so a close waits only for the last one (§5.2).
	for j, c := range wf.chunks {
		if c.dirty && !c.uploading && c.file != "" && c.length == ChunkMax && c.off+ChunkMax <= off {
			wf.uploadAsyncLocked(c, j)
		}
	}
	if wf.dirtyCountLocked() > wf.fs.opts.MaxDirtyChunks {
		wf.uploadOldestLocked(ctx)
	}
	return nil
}

func pwrite(path string, data []byte, off int64) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteAt(data, off)
	return err
}

// pread reads a spool file; a sparse one reads short past its last byte, and the rest is zeros.
func pread(path string, buf []byte, off int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := f.ReadAt(buf, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	clear(buf[n:])
	return nil
}

func (wf *wfile) dirtyCountLocked() int {
	n := 0
	for _, c := range wf.chunks {
		if c.dirty {
			n++
		}
	}
	return n
}

// becomeAppendLocked turns an existing file opened without O_TRUNC or O_APPEND into an append on its current version.
func (wf *wfile) becomeAppendLocked(ctx context.Context) error {
	wf.mu.Unlock()
	m, err := wf.fs.manifest(ctx, wf.n, true)
	wf.mu.Lock()
	if err != nil {
		return err
	}
	if wf.mode == modeExisting {
		wf.setBaseLocked(m)
	}
	return nil
}

// truncate is ftruncate (§5.2): a new or emptied file to any size; an existing one only to 0 (an overwrite to empty)
// or to its size (nothing).
func (wf *wfile) truncate(ctx context.Context, h *handle, size int64) error {
	wf.wmu.Lock()
	defer wf.wmu.Unlock()
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if wf.failed != nil {
		return wf.failed
	}
	if size == wf.size {
		return nil
	}
	rewrite := h != nil && h.rewrite
	switch {
	case size == 0:
		wf.toTruncLocked(rewrite)
		if h != nil {
			h.rewrite = true
		}
		return nil
	case !rewrite || wf.mode == modeExisting || wf.mode == modeAppend:
		return errInPlace
	case size > wf.size:
		if err := wf.growZerosLocked(ctx, size); err != nil {
			return err
		}
	default:
		for j := 0; j < len(wf.chunks); j++ {
			c := wf.chunks[j]
			if c.off >= size || c.off+c.length <= size {
				continue
			}
			if !c.zero {
				if err := wf.localLocked(ctx, c, wf.firstIdx+j, c.length); err != nil {
					return err
				}
				if !wf.stillAt(j, c) {
					j--
					continue
				}
				if err := os.Truncate(c.file, size-c.off); err != nil {
					return err
				}
				wf.fs.spool.release(c.length - (size - c.off))
			}
			c.length = size - c.off
			wf.touchChunkLocked(c)
		}
		keep := wf.chunks[:0]
		for _, c := range wf.chunks {
			if c.off >= size {
				wf.dropChunkLocked(c)
				continue
			}
			keep = append(keep, c)
		}
		wf.chunks = keep
		wf.size = size
	}
	wf.mtime = time.Now()
	wf.markDirtyLocked()
	wf.showLocked()
	return nil
}

// setMtime keeps an mtime set while the write is not committed (`cp -p` sets it before its close): applied after the
// commit, which would otherwise stamp the time of the commit (§5.6). It answers false when the write holds nothing
// uncommitted and the caller should set it now.
func (wf *wfile) setMtime(t *time.Time) bool {
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if !wf.dirty || wf.failed != nil {
		// Nothing to commit: the caller sets it now, and stat shows it meanwhile.
		if t != nil {
			wf.mtime = *t
		} else {
			wf.mtime = time.Now()
		}
		wf.showLocked()
		return false
	}
	if t == nil {
		// UTIME_NOW: the commit stamps now.
		wf.pendingMtime = nil
	} else {
		v := *t
		wf.pendingMtime = &v
	}
	wf.showLocked()
	return true
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────

// readAt is what a reader on this mount sees: the bytes being written, committed or not (§5.3).
func (wf *wfile) readAt(ctx context.Context, off int64, size int) ([]byte, error) {
	wf.mu.Lock()
	if off >= wf.size {
		wf.mu.Unlock()
		return nil, nil
	}
	end := minI(off+int64(size), wf.size)
	buf := make([]byte, end-off)
	type remote struct {
		sha      string
		size     int64
		from, to int64
		at       int64
	}
	var remotes []remote
	for _, c := range wf.chunks {
		lo, hi := maxI(off, c.off), minI(end, c.off+c.length)
		if lo >= hi {
			continue
		}
		switch {
		case c.file != "":
			if err := pread(c.file, buf[lo-off:hi-off], lo-c.off); err != nil {
				wf.mu.Unlock()
				return nil, err
			}
		case c.zero:
			// buf holds zeros already.
		default:
			remotes = append(remotes, remote{sha: c.sha, size: c.length, from: lo - c.off, to: hi - c.off, at: lo - off})
		}
	}
	regionStart := wf.regionStart
	base := wf.baseChunks
	known := base != nil
	mode := wf.mode
	wf.mu.Unlock()

	for _, r := range remotes {
		data, err := wf.fs.cache.bytes(ctx, r.sha, r.size)
		if err != nil {
			return nil, err
		}
		copy(buf[r.at:], data[r.from:r.to])
	}
	if mode == modeAppend || mode == modeExisting {
		limit := minI(end, regionStart)
		if mode == modeExisting {
			limit = end
		}
		if off < limit {
			if !known {
				m, err := wf.fs.manifest(ctx, wf.n, true)
				if err != nil {
					return nil, err
				}
				base = m.Chunks
			}
			if err := wf.fs.readChunks(ctx, base, off, buf[:limit-off]); err != nil {
				return nil, err
			}
		}
	}
	return buf, nil
}

func maxI(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func minI(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// ── uploads ──────────────────────────────────────────────────────────────────────────────────────

// ensureStagingLocked opens the write's staging the first time a chunk goes. The lock is let go meanwhile.
func (wf *wfile) ensureStagingLocked(ctx context.Context) (string, error) {
	for wf.staging == "" && wf.stagingWait != nil {
		wait := wf.stagingWait
		wf.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		wf.mu.Lock()
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	if wf.staging != "" {
		return wf.staging, nil
	}
	wait := make(chan struct{})
	wf.stagingWait = wait
	entry := wf.entryID
	wf.mu.Unlock()
	id, err := wf.fs.door.OpenStaging(ctx, entry)
	wf.mu.Lock()
	close(wait)
	wf.stagingWait = nil
	if err != nil {
		return "", err
	}
	if wf.staging == "" {
		wf.staging = id
	}
	return wf.staging, nil
}

// openStagingSoon opens the staging while the writer is still writing, so a small file's close costs its chunk and
// its commit only (§5.5's budget for create-write-close).
func (wf *wfile) openStagingSoon() {
	go func() {
		wf.mu.Lock()
		defer wf.mu.Unlock()
		if wf.staging == "" && wf.failed == nil && !wf.fs.door.Health().Offline() {
			_, _ = wf.ensureStagingLocked(wf.fs.ctx)
		}
	}()
}

// slotLocked waits for one of the upload slots, which bound the chunks travelling, and the memory their bytes take.
// The lock is let go meanwhile; the caller gives the slot back with <-uploadSlots.
func (wf *wfile) slotLocked() {
	wf.mu.Unlock()
	wf.fs.uploadSlots <- struct{}{}
	wf.mu.Lock()
}

// putLocked sends bytes as staging row idx, letting go of the lock while they travel. The caller holds a slot.
func (wf *wfile) putLocked(ctx context.Context, idx int, sha string, data []byte) error {
	staging, err := wf.ensureStagingLocked(ctx)
	if err != nil {
		return err
	}
	wf.mu.Unlock()
	err = wf.fs.door.PutChunk(ctx, staging, idx, sha, data)
	wf.mu.Lock()
	if err != nil {
		return err
	}
	if old, ok := wf.stagedRows[idx]; ok && old != sha {
		// That row held zeros other chunks may lean on: they are sent again before the commit.
		for length := range wf.zeroStaged {
			if zeroSHA(length) == old {
				delete(wf.zeroStaged, length)
			}
		}
	}
	wf.stagedRows[idx] = sha
	return nil
}

// uploadLocked sends dirty chunk c (position j). A chunk written while its bytes travelled stays dirty.
func (wf *wfile) uploadLocked(ctx context.Context, c *wchunk, j int) error {
	if !c.dirty || c.uploading || c.file == "" || c.dropped {
		return nil
	}
	c.uploading = true
	wf.uploads++
	defer func() {
		c.uploading = false
		wf.uploads--
		wf.cond.Broadcast()
	}()
	// The slot first, then the bytes: a writer far ahead of its uploads holds no more than the slots' worth of them.
	wf.slotLocked()
	defer func() { <-wf.fs.uploadSlots }()
	if !c.dirty || c.file == "" || c.dropped {
		return nil
	}
	j = indexOf(wf.chunks, c)
	if j < 0 {
		return nil
	}
	idx := wf.firstIdx + j
	data := make([]byte, c.length)
	if err := pread(c.file, data, 0); err != nil {
		return err
	}
	sha := hexSHA(data)
	ver := c.ver
	if err := wf.putLocked(ctx, idx, sha, data); err != nil {
		return err
	}
	if c.ver == ver && wf.stillAt(idx-wf.firstIdx, c) {
		c.dirty, c.sha, c.staged = false, sha, true
		wf.fs.spool.addClean(wf, c)
	}
	return nil
}

// uploadAsyncLocked sends a full chunk in the background.
func (wf *wfile) uploadAsyncLocked(c *wchunk, j int) {
	c.uploading = true
	wf.uploads++
	go func() {
		wf.mu.Lock()
		defer wf.mu.Unlock()
		c.uploading = false
		wf.uploads--
		if j := indexOf(wf.chunks, c); j >= 0 && !wf.fs.door.Health().Offline() {
			if err := wf.uploadLocked(wf.fs.ctx, c, j); err != nil {
				wf.fs.debugf("upload of a chunk of %s: %v", wf.entryID, err)
			}
		}
		wf.cond.Broadcast()
	}()
}

func indexOf(chunks []*wchunk, c *wchunk) int {
	for j, x := range chunks {
		if x == c {
			return j
		}
	}
	return -1
}

// uploadOldestLocked sends this write's oldest full dirty chunk, and evicts it: what makes room when the spool is full
// or the write holds too many dirty chunks (§5.3). It answers whether it made room.
func (wf *wfile) uploadOldestLocked(ctx context.Context) bool {
	for j, c := range wf.chunks {
		if !c.dirty || c.uploading || c.file == "" || c.length < ChunkMax {
			continue
		}
		if wf.fs.door.Health().Offline() {
			return false
		}
		if err := wf.uploadLocked(ctx, c, j); err != nil {
			return false
		}
		if !c.dirty {
			wf.evictLocked(c)
		}
		return true
	}
	return false
}

// evictLocked frees a clean chunk's spool file; it is fetched back if it is read or written again.
func (wf *wfile) evictLocked(c *wchunk) {
	if c.dirty || c.uploading || c.file == "" || !(c.staged || c.held) {
		return
	}
	wf.fs.spool.forgetClean(c)
	_ = os.Remove(c.file)
	wf.fs.spool.release(c.length)
	c.file = ""
}

// ── commits ──────────────────────────────────────────────────────────────────────────────────────

var zeroSums sync.Map // length → sha256 of that many zeros

func zeroSHA(n int64) string {
	if v, ok := zeroSums.Load(n); ok {
		return v.(string)
	}
	s := hexSHA(make([]byte, n))
	zeroSums.Store(n, s)
	return s
}

// errUnreachable is a commit that could not reach the server within its wait.
type errUnreachable struct{ err error }

func (e errUnreachable) Error() string {
	return "the drive's server could not be reached: " + e.err.Error()
}

// applied is what a commit changed, for the file system to record once the write state's lock is let go.
type applied struct {
	result   door.CommitResult
	manifest *door.Manifest
	mtime    *time.Time
	session  string
}

// commit uploads what is left and commits (§5.2), waiting up to wait for an unreachable server. Each attempt sequence
// keeps one commitId, so a commit that applied but whose answer was lost is not applied again (§3.1); an append whose
// tail moved is built again and sent with a new one (§3.2).
func (wf *wfile) commit(ctx context.Context, wait time.Duration) error {
	wf.wmu.Lock()
	done, err := wf.commitHeld(ctx, wait)
	wf.wmu.Unlock()
	if done != nil {
		wf.fs.committed(wf.n, done.result, done.manifest)
		if done.mtime != nil {
			wf.fs.applyMtime(wf.n, *done.mtime, done.session)
		}
	}
	return err
}

func (wf *wfile) commitHeld(ctx context.Context, wait time.Duration) (*applied, error) {
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if wf.failed != nil {
		return nil, wf.failed
	}
	if !wf.dirty {
		return nil, nil
	}
	for wf.uploads > 0 {
		wf.cond.Wait()
	}
	deadline := time.Now().Add(wait)
	rebuilt, resent := 0, 0
	for {
		err := wf.sendChunksLocked(ctx)
		var moved *door.TailMoved
		if err == nil {
			body := wf.bodyLocked()
			gen := wf.gen
			wf.mu.Unlock()
			var result door.CommitResult
			result, moved, err = wf.fs.door.Commit(ctx, body)
			wf.mu.Lock()
			if err == nil {
				return wf.appliedLocked(result, gen), nil
			}
		}
		var fenced *door.FencedError
		switch {
		case errors.As(err, &fenced):
			return nil, err
		case moved != nil && wf.mode == modeAppend && rebuilt < 50:
			rebuilt++
			if rerr := wf.rebuildLocked(ctx, *moved); rerr != nil {
				return nil, rerr
			}
			wf.commitID = ""
		case (door.CodeOf(err) == door.CodeChunkNotHeld || door.CodeOf(err) == door.CodeStagingNotFound) && resent < 2:
			// The staging lost what this write had sent (it expired): everything is sent again.
			resent++
			if door.CodeOf(err) == door.CodeStagingNotFound {
				wf.staging = ""
			}
			if rerr := wf.redirtyLocked(ctx); rerr != nil {
				return nil, rerr
			}
		case door.Transient(err):
			if time.Now().After(deadline) || ctx.Err() != nil {
				return nil, errUnreachable{err}
			}
			wf.mu.Unlock()
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
			}
			wf.mu.Lock()
		default:
			return nil, err
		}
	}
}

// sendChunksLocked sends every dirty chunk, and one all-zero chunk of each length the write holds that no staging row
// or version names yet: every all-zero chunk is one blob (§5.2).
func (wf *wfile) sendChunksLocked(ctx context.Context) error {
	for rounds := 0; rounds < 4; rounds++ {
		pending := false
		for j := 0; j < len(wf.chunks); j++ {
			c := wf.chunks[j]
			if !c.dirty {
				continue
			}
			pending = true
			if c.file == "" {
				if err := wf.localLocked(ctx, c, wf.firstIdx+j, c.length); err != nil {
					return err
				}
				if !wf.stillAt(j, c) {
					continue
				}
			}
			if err := wf.uploadLocked(ctx, c, j); err != nil {
				return err
			}
		}
		if !pending {
			break
		}
	}
	for j := 0; j < len(wf.chunks); j++ {
		c := wf.chunks[j]
		if !c.zero || c.held || c.length == 0 {
			continue
		}
		if !wf.zeroStaged[c.length] {
			length := c.length
			wf.slotLocked()
			err := wf.putLocked(ctx, wf.firstIdx+j, zeroSHA(length), make([]byte, length))
			<-wf.fs.uploadSlots
			if err != nil {
				return err
			}
			wf.zeroStaged[length] = true
		}
		c.staged = true
	}
	return nil
}

// redirtyLocked marks every chunk the next commit names, and no version holds, to be sent again.
func (wf *wfile) redirtyLocked(ctx context.Context) error {
	wf.stagedRows, wf.zeroStaged = map[int]string{}, map[int64]bool{}
	for j := 0; j < len(wf.chunks); j++ {
		c := wf.chunks[j]
		if c.held || c.dirty || c.zero {
			c.staged = false
			continue
		}
		if err := wf.localLocked(ctx, c, wf.firstIdx+j, c.length); err != nil {
			return err
		}
		c.dirty, c.staged = true, false
		c.ver++
	}
	return nil
}

// bodyLocked is the commit of everything the write holds now.
func (wf *wfile) bodyLocked() door.Commit {
	if wf.commitID == "" {
		wf.commitID = newUUID()
	}
	body := door.Commit{
		CommitID: wf.commitID, EntryID: wf.entryID, HandleID: wf.handleID, StagingID: wf.staging,
		Chunks: make([]door.CommitChunk, 0, len(wf.chunks)),
	}
	if wf.session != "" {
		body.Writer = &door.Writer{SessionID: wf.session}
	}
	for j, c := range wf.chunks {
		if c.length == 0 {
			continue
		}
		sha := c.sha
		if c.zero {
			sha = zeroSHA(c.length)
		}
		body.Chunks = append(body.Chunks, door.CommitChunk{Idx: wf.firstIdx + j, SHA256: sha, Size: c.length})
	}
	switch wf.mode {
	case modeNew:
		body.Mode, body.BaseVersionID = "CONTINUE", wf.version
	case modeTrunc:
		if wf.version == "" {
			body.Mode = "OVERWRITE"
		} else {
			body.Mode, body.BaseVersionID = "CONTINUE", wf.version
		}
	case modeAppend:
		body.Mode, body.BaseVersionID = "APPEND", wf.baseVersion
		if wf.replaceTail != nil {
			rt := *wf.replaceTail
			body.ReplaceTail = &rt
		} else {
			size := wf.baseSize
			body.BaseSize = &size
		}
	}
	return body
}

// appliedLocked records a commit the door applied, and answers what the file system records of it.
func (wf *wfile) appliedLocked(r door.CommitResult, gen uint64) *applied {
	wf.commitID = ""
	wf.lastCommit = time.Now()
	wf.stagedRows, wf.zeroStaged = map[int]string{}, map[int64]bool{}
	if wf.gen == gen {
		wf.dirty = false
	}
	committed := make([]door.Chunk, 0, len(wf.chunks))
	for j, c := range wf.chunks {
		c.staged = false
		if c.length == 0 {
			continue
		}
		if c.zero {
			c.sha = zeroSHA(c.length)
		}
		c.held = true
		if c.file != "" {
			wf.fs.spool.addClean(wf, c)
		}
		committed = append(committed, door.Chunk{Idx: wf.firstIdx + j, Offset: c.off, Size: c.length, SHA256: c.sha})
	}
	out := &applied{result: r, session: wf.session}
	switch wf.mode {
	case modeNew, modeTrunc:
		wf.version = r.VersionID
		out.manifest = &door.Manifest{EntryID: wf.entryID, VersionID: r.VersionID, SizeBytes: r.SizeBytes, Seq: r.Seq, Chunks: committed}
	case modeAppend:
		var chunks []door.Chunk
		if wf.baseChunks != nil {
			chunks = append(append([]door.Chunk{}, wf.baseChunks[:minInt(wf.firstIdx, len(wf.baseChunks))]...), committed...)
			out.manifest = &door.Manifest{EntryID: wf.entryID, VersionID: r.VersionID, SizeBytes: r.SizeBytes, Seq: r.Seq, Chunks: chunks}
		}
		wf.baseChunks = chunks
		wf.baseVersion, wf.baseSize = r.VersionID, r.SizeBytes
		wf.nextRegionLocked(committed)
	}
	if wf.pendingMtime != nil {
		t := *wf.pendingMtime
		out.mtime = &t
		wf.pendingMtime = nil
		wf.mtime = t
	} else if !wf.dirty && !r.Mtime.IsZero() {
		wf.mtime = r.Mtime
	}
	wf.showLocked()
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// nextRegionLocked starts the next append after one that applied: merged into the last chunk if it is small (§3.2).
func (wf *wfile) nextRegionLocked(committed []door.Chunk) {
	var keep *wchunk
	if n := len(wf.chunks); n > 0 && len(committed) > 0 && committed[len(committed)-1].Size < tailMerge {
		keep = wf.chunks[n-1]
	}
	for _, c := range wf.chunks {
		if c != keep {
			wf.retireChunkLocked(c)
		}
	}
	wf.chunks, wf.replaceTail = nil, nil
	wf.regionStart = wf.size
	if len(committed) > 0 {
		wf.firstIdx = committed[len(committed)-1].Idx + 1
	}
	if keep != nil {
		last := committed[len(committed)-1]
		wf.regionStart, wf.firstIdx = last.Offset, last.Idx
		wf.replaceTail = &door.ReplaceTail{Idx: last.Idx, OldSHA256: last.SHA256}
		keep.dirty, keep.staged, keep.held = false, false, true
		wf.chunks = []*wchunk{keep}
	}
}

// retireChunkLocked hands a committed chunk's spool file to the chunk cache, where reads find it.
func (wf *wfile) retireChunkLocked(c *wchunk) {
	wf.fs.spool.forgetClean(c)
	c.dropped = true
	if c.file == "" {
		return
	}
	if !c.dirty && c.held && c.sha != "" && wf.fs.cache.adopt(c.sha, c.length, c.file) {
		wf.fs.spool.release(c.length)
		c.file = ""
		return
	}
	_ = os.Remove(c.file)
	wf.fs.spool.release(c.length)
	c.file = ""
}

// rebuildLocked builds an append again on the version another appender made first (§3.2): the same bytes, after its
// new end.
func (wf *wfile) rebuildLocked(ctx context.Context, moved door.TailMoved) error {
	appended, err := wf.regionBytesLocked(ctx, wf.baseSize, wf.size)
	if err != nil {
		return err
	}
	for _, c := range wf.chunks {
		wf.dropChunkLocked(c)
	}
	wf.chunks, wf.replaceTail, wf.baseChunks = nil, nil, nil
	wf.stagedRows, wf.zeroStaged = map[int]string{}, map[int64]bool{}
	wf.baseVersion, wf.baseSize, wf.size = moved.VersionID, moved.SizeBytes, moved.SizeBytes
	wf.regionStart, wf.firstIdx = moved.SizeBytes, 0
	if moved.Tail != nil {
		wf.firstIdx = moved.Tail.Idx + 1
		if moved.Tail.Size < tailMerge {
			wf.regionStart, wf.firstIdx = moved.Tail.Offset, moved.Tail.Idx
			wf.replaceTail = &door.ReplaceTail{Idx: moved.Tail.Idx, OldSHA256: moved.Tail.SHA256}
			wf.chunks = []*wchunk{{off: moved.Tail.Offset, length: moved.Tail.Size, sha: moved.Tail.SHA256, held: true}}
		}
	}
	off := wf.size
	end := off + int64(len(appended))
	for pos := off; pos < end; {
		j, c := wf.chunkAtLocked(pos)
		within := pos - c.off
		n := minI(end-pos, ChunkMax-within)
		if err := wf.localLocked(ctx, c, wf.firstIdx+j, maxI(within+n, c.length)); err != nil {
			return err
		}
		if !wf.stillAt(j, c) {
			continue
		}
		if err := pwrite(c.file, appended[pos-off:pos-off+n], within); err != nil {
			return err
		}
		if within+n > c.length {
			c.length = within + n
		}
		c.zero = false
		wf.touchChunkLocked(c)
		pos += n
	}
	wf.size = end
	wf.markDirtyLocked()
	wf.showLocked()
	return nil
}

// regionBytesLocked reads [from, to) of the region.
func (wf *wfile) regionBytesLocked(ctx context.Context, from, to int64) ([]byte, error) {
	out := make([]byte, 0, maxI(to-from, 0))
	for j := 0; j < len(wf.chunks); j++ {
		c := wf.chunks[j]
		lo, hi := maxI(from, c.off), minI(to, c.off+c.length)
		if lo >= hi {
			continue
		}
		piece := make([]byte, hi-lo)
		if !c.zero {
			if c.file == "" {
				if err := wf.localLocked(ctx, c, wf.firstIdx+j, c.length); err != nil {
					return nil, err
				}
			}
			if err := pread(c.file, piece, lo-c.off); err != nil {
				return nil, err
			}
		}
		out = append(out, piece...)
	}
	return out, nil
}

// contentLocked writes what the write would have committed: the whole file for a new or emptied one, the appended
// bytes for an append. Bytes evicted and not cached cannot be had without the server: missing counts them.
func (wf *wfile) contentLocked(w func([]byte) error) (missing int64, err error) {
	from := int64(0)
	if wf.mode == modeAppend {
		from = wf.baseSize
	}
	for _, c := range wf.chunks {
		lo, hi := maxI(from, c.off), c.off+c.length
		if lo >= hi {
			continue
		}
		piece := make([]byte, hi-lo)
		switch {
		case c.file != "":
			if err := pread(c.file, piece, lo-c.off); err != nil {
				return missing, err
			}
		case c.zero:
		default:
			if data, ok := wf.fs.cache.local(c.sha); ok && int64(len(data)) == c.length {
				copy(piece, data[lo-c.off:])
			} else {
				missing += hi - lo
			}
		}
		if err := w(piece); err != nil {
			return missing, err
		}
	}
	return missing, nil
}

// abandon keeps the bytes of a write whose close failed in unsent/ (§5.7) and fails the write from then on. It
// answers the unsent file's name.
func (wf *wfile) abandon(drivePath string) string {
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if wf.failed != nil {
		return ""
	}
	var buf bytes.Buffer
	missing, err := wf.contentLocked(func(p []byte) error { _, e := buf.Write(p); return e })
	saved := ""
	if err == nil {
		saved = wf.fs.rep.SaveUnsent(filepath.Base(drivePath), buf.Bytes(), UnsentRecord{
			CommitID: wf.commitID, EntryID: wf.entryID, Path: wf.fs.display(drivePath), Mode: wf.mode.String(), Missing: missing,
		})
	}
	wf.failed = errAbandoned
	wf.gaveUp.Store(true)
	wf.dirty = false
	return saved
}

// fail fails the write from now on: what fencing does (§8.2).
func (wf *wfile) fail(err error) {
	wf.mu.Lock()
	defer wf.mu.Unlock()
	if wf.failed == nil {
		wf.failed = err
		wf.gaveUp.Store(true)
	}
}

// ── what the file system does with write states ─────────────────────────────────────────────────────

// committed records the door's attributes for this commit, and the chunk list when known.
func (fs *FS) committed(n *node, r door.CommitResult, m *door.Manifest) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if r.Seq < n.seq {
		return
	}
	n.seq, n.size, n.version = r.Seq, r.SizeBytes, r.VersionID
	if !r.Mtime.IsZero() {
		n.mtime = r.Mtime
	}
	n.manifest, n.sha = m, ""
	if m != nil && len(m.Chunks) == 1 {
		n.sha = m.Chunks[0].SHA256
	}
	n.fetched, n.stale = time.Now(), r.Mtime.IsZero()
}

// applyMtime sets an mtime that arrived while a write was not committed yet (`cp -p`, `tar x`), after its commit.
func (fs *FS) applyMtime(n *node, t time.Time, session string) {
	ctx, cancel := context.WithTimeout(fs.ctx, 30*time.Second)
	defer cancel()
	var w *door.Writer
	if session != "" {
		w = &door.Writer{SessionID: session}
	}
	e, err := fs.door.Utimens(ctx, n.id, t, w)
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if err != nil {
		n.stale = true
		return
	}
	if e.Seq >= n.seq {
		n.mtime, n.seq = e.Mtime, e.Seq
	}
}

// writeState is n's write state, made for a handle opening it for writing, or joined when one is open already.
func (fs *FS) writeState(ctx context.Context, n *node, mode wmode, handleID string) (*wfile, error) {
	fs.mu.Lock()
	if wf := n.wf; wf != nil && !wf.gaveUp.Load() {
		wf.refs++
		fs.mu.Unlock()
		if mode == modeTrunc {
			wf.wmu.Lock()
			wf.mu.Lock()
			wf.toTruncLocked(false)
			wf.mu.Unlock()
			wf.wmu.Unlock()
		}
		return wf, nil
	}
	defer fs.mu.Unlock()
	wf := fs.newWfile(n, mode, handleID, n.size, n.mtime, n.version)
	wf.refs = 1
	n.wf = wf
	fs.wfiles[wf] = struct{}{}
	return wf, nil
}

// releaseWriteState is a write handle closing for good: the last one commits what is left (a RELEASE with bytes no
// flush took, as when a writer was killed while its close was in flight, §5.2) and lets go of the write state.
func (fs *FS) releaseWriteState(wf *wfile, drivePath string) {
	fs.mu.Lock()
	wf.refs--
	last := wf.refs == 0
	fs.mu.Unlock()
	if !last {
		return
	}
	if wf.isDirty() {
		if err := wf.commit(fs.ctx, fs.opts.CloseWait); err != nil {
			fs.closeFailed(wf, drivePath, err)
		}
	}
	fs.mu.Lock()
	if wf.refs > 0 {
		// Opened again while the commit ran.
		fs.mu.Unlock()
		return
	}
	if wf.n.wf == wf {
		wf.n.wf = nil
	}
	delete(fs.wfiles, wf)
	fs.mu.Unlock()
	wf.mu.Lock()
	for _, c := range wf.chunks {
		wf.retireChunkLocked(c)
	}
	wf.chunks = nil
	failed := wf.failed != nil
	pending := wf.pendingMtime
	wf.pendingMtime = nil
	wf.mu.Unlock()
	if pending != nil && !failed {
		fs.applyMtime(wf.n, *pending, wf.session)
	}
	fs.mu.Lock()
	if failed {
		wf.n.stale = true
	}
	fs.dropIfUnusedLocked(wf.n)
	fs.mu.Unlock()
}

// closeFailed is a close whose commit failed: when the server could not be reached, the bytes go to unsent/ and
// errors.log names the file (§5.7).
func (fs *FS) closeFailed(wf *wfile, drivePath string, err error) fuse.Status {
	st := statusOfWrite(err)
	var fenced *door.FencedError
	if errors.As(err, &fenced) || errors.Is(err, errAbandoned) {
		wf.fail(errAbandoned)
		return fuse.EIO
	}
	saved := wf.abandon(drivePath)
	reason := "the bytes could not be committed: " + err.Error()
	var unreachable errUnreachable
	if errors.As(err, &unreachable) {
		reason = fmt.Sprintf("the drive's server could not be reached for %s", fs.opts.CloseWait)
	}
	if saved != "" {
		reason += "; the bytes are kept in " + fs.rep.UnsentPath(saved)
	}
	fs.rep.Log(st, "close", fs.display(drivePath), "", reason)
	if st == fuse.OK {
		st = fuse.EIO
	}
	return st
}

// statusOfWrite is the status a failed write or commit answers.
func statusOfWrite(err error) fuse.Status {
	switch {
	case err == nil:
		return fuse.OK
	case errors.Is(err, errInPlace):
		return fuse.Status(syscall.EOPNOTSUPP)
	case errors.Is(err, errAbandoned):
		return fuse.EIO
	}
	var unreachable errUnreachable
	if errors.As(err, &unreachable) {
		return fuse.EIO
	}
	return errno(err)
}
