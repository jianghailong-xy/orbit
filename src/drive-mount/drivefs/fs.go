// Package drivefs is the mount daemon's file system (docs/drive-technical-design.md §5): the account's
// drive, served over FUSE (go-fuse's raw protocol) from the runner drive door.
//
//   - Inode numbers come from a per-mount table from entry id to inode, never reused while the mount lives (§5.4).
//   - Every file shows uid/gid 10001, files 0644 and folders 0755 (§5.1); a mode change to what is shown is a no-op and
//     any other is refused (§5.6).
//   - Entries and attributes are cached for 60 s in the kernel and a missing name for 10 s, both invalidated by the
//     change feed (feed.go); listings answer READDIRPLUS page by page.
//   - A handle open for writing is bound to its entry id (wfile.go): a rename or unlink of an open file does not move
//     its bytes elsewhere, and every close commits before it returns (§5.2).
//   - Offline, reads of what is cached work and everything else fails EIO at once (§5.7).
package drivefs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

const (
	// ChunkMax is the largest chunk the store takes (DRIVE_CHUNK_MAX).
	ChunkMax = 8 << 20
	// tailMerge is the size under which an append's last chunk is sent again merged with the appended bytes (§3.2).
	tailMerge = 64 << 10

	entryTTL    = 60 * time.Second
	attrTTL     = 60 * time.Second
	negativeTTL = 10 * time.Second
	// cacheFresh is how long the daemon's own metadata is used without asking again while the feed follows changes;
	// offlineFresh is how old it may be and still answer while offline (§5.7).
	cacheFresh   = 5 * time.Minute
	offlineFresh = 10 * time.Minute

	nameMax  = 255
	pageSize = 1000
)

// Options configure a file system.
type Options struct {
	// UID and GID are what every entry shows (10001, the runner's user).
	UID, GID uint32
	// DisplayRoot is the path agents know the drive by, for errors.log (/home/orbit/Drive).
	DisplayRoot string
	// SpoolDir holds the chunks of open writes and the chunk cache.
	SpoolDir string
	// SpoolLimit bounds the spool's bytes (4 GiB per runner); CacheLimit the chunk cache's (1 GiB per runner).
	SpoolLimit int64
	CacheLimit int64
	// MaxDirtyChunks is how many chunks one write may hold that are not uploaded yet (64, 512 MiB).
	MaxDirtyChunks int
	// IdleCommit and MaxCommitInterval are when a dirty handle commits without a close (30 s, 5 min).
	IdleCommit        time.Duration
	MaxCommitInterval time.Duration
	// CloseWait is how long a close waits for an unreachable server before it fails and keeps the bytes (30 s).
	CloseWait time.Duration
	// Reporter writes errors.log, status.json and unsent/.
	Reporter *Reporter
	// Attributor tells which session a caller's pid belongs to (§5.8); nil attributes nothing.
	Attributor Attributor
	// FeedWait is the change feed's long-poll wait (at most 25 s).
	FeedWait time.Duration
	// OnFenced runs once when the instance is superseded or fenced (§8.2), after every operation started failing.
	OnFenced func(reason string)
	Debug    bool
}

func (o *Options) defaults() {
	if o.UID == 0 {
		o.UID = 10001
	}
	if o.GID == 0 {
		o.GID = 10001
	}
	if o.DisplayRoot == "" {
		o.DisplayRoot = "/home/orbit/Drive"
	}
	if o.SpoolLimit == 0 {
		o.SpoolLimit = 4 << 30
	}
	if o.CacheLimit == 0 {
		o.CacheLimit = 1 << 30
	}
	if o.MaxDirtyChunks == 0 {
		o.MaxDirtyChunks = 64
	}
	if o.IdleCommit == 0 {
		o.IdleCommit = 30 * time.Second
	}
	if o.MaxCommitInterval == 0 {
		o.MaxCommitInterval = 5 * time.Minute
	}
	if o.CloseWait == 0 {
		o.CloseWait = 30 * time.Second
	}
	if o.FeedWait == 0 {
		o.FeedWait = 15 * time.Second
	}
	if o.Reporter == nil {
		o.Reporter = NewReporter(ReporterOptions{})
	}
	if o.Attributor == nil {
		o.Attributor = noAttribution{}
	}
}

// node is one entry the kernel knows, or knew.
type node struct {
	ino uint64
	id  string
	dir bool

	// Guarded by FS.mu.
	parentID string
	name     string
	size     int64
	mtime    time.Time
	seq      int64
	version  string
	sha      string // a one-chunk file's chunk, from a listing; "" when not known to be one chunk
	fetched  time.Time
	stale    bool // the feed said it changed
	gone     bool // in Trash or gone: no path reaches it, but open handles still do
	lookups  uint64
	handles  int
	manifest *door.Manifest // the chunk list of version at seq manifest.Seq
	wf       *wfile
}

// dirCache is what the daemon knows of a folder's live children.
type dirCache struct {
	children map[string]door.Entry // name → entry
	complete bool                  // children holds every live child
	fetched  time.Time
}

// FS is the drive as one FUSE file system.
type FS struct {
	fuse.RawFileSystem

	door   *door.Client
	opts   Options
	server *fuse.Server
	spool  *spool
	cache  *chunkCache
	rep    *Reporter

	mu       sync.Mutex
	nextIno  uint64
	inoByID  map[string]uint64 // never shrinks: an entry keeps its inode for the mount's life
	byIno    map[uint64]*node
	byID     map[string]*node
	dirs     map[string]*dirCache
	handles  map[uint64]*handle
	nextFh   uint64
	wfiles   map[*wfile]struct{}
	rootID   string
	rootSeen time.Time
	mounted  time.Time
	usage    door.Usage
	usageAt  time.Time

	// uploadSlots bounds the chunks travelling at once, and so the memory their bytes take.
	uploadSlots chan struct{}
	reconnected chan struct{}

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

const rootIno = fuse.FUSE_ROOT_ID

// New makes the file system over a door. Serve it with fuse.NewServer, then call Start.
func New(client *door.Client, opts Options) (*FS, error) {
	opts.defaults()
	sp, err := newSpool(opts.SpoolDir, opts.SpoolLimit)
	if err != nil {
		return nil, err
	}
	cc, err := newChunkCache(path.Join(opts.SpoolDir, "cache"), opts.CacheLimit, client)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	fs := &FS{
		RawFileSystem: fuse.NewDefaultRawFileSystem(),
		door:          client,
		opts:          opts,
		spool:         sp,
		cache:         cc,
		rep:           opts.Reporter,
		nextIno:       rootIno + 1,
		inoByID:       map[string]uint64{},
		byIno:         map[uint64]*node{},
		byID:          map[string]*node{},
		dirs:          map[string]*dirCache{},
		handles:       map[uint64]*handle{},
		wfiles:        map[*wfile]struct{}{},
		nextFh:        1,
		mounted:       time.Now(),
		uploadSlots:   make(chan struct{}, 8),
		reconnected:   make(chan struct{}, 1),
		ctx:           ctx,
		cancel:        cancel,
	}
	root := &node{ino: rootIno, dir: true, lookups: 1, mtime: fs.mounted, fetched: fs.mounted}
	fs.byIno[rootIno] = root
	client.OnFence(func(f *door.FencedError) { fs.fenced(f) })
	client.Health().OnChange(func(online bool, since time.Time) { fs.healthChanged(online, since) })
	return fs, nil
}

// MountOptions are the kernel options the drive is served with (§5.1): no writeback cache, 1 MiB writes,
// READDIRPLUS, POSIX and flock locks negotiated so they can be refused, O_TRUNC sent with the open.
func MountOptions(debug bool) *fuse.MountOptions {
	return &fuse.MountOptions{
		AllowOther:           true,
		MaxWrite:             1 << 20,
		EnableLocks:          true,
		IgnoreSecurityLabels: true,
		FsName:               "orbit-drive",
		Name:                 "orbit-drive",
		ExtraCapabilities:    fuse.CAP_ATOMIC_O_TRUNC,
		Debug:                debug,
		Options:              []string{"default_permissions"},
	}
}

func (fs *FS) String() string { return "orbit-drive" }

// Init is the kernel's first request: from here on the file system can notify the kernel.
func (fs *FS) Init(server *fuse.Server) { fs.server = server }

// Start begins the background work: the change feed, periodic commits, keepalives, the probe and status.json.
func (fs *FS) Start() {
	fs.go_(func() { fs.door.RunProbe(fs.ctx) })
	fs.go_(fs.runFeed)
	fs.go_(fs.runCommitter)
	fs.go_(fs.runKeepalive)
	fs.go_(fs.runStatus)
	fs.go_(fs.runUnsentCheck)
}

// Stop ends the background work. Open writes are not committed here: Shutdown does that.
func (fs *FS) Stop() {
	fs.cancel()
	fs.wg.Wait()
}

func (fs *FS) go_(fn func()) {
	fs.wg.Add(1)
	go func() {
		defer fs.wg.Done()
		fn()
	}()
}

func (fs *FS) debugf(format string, args ...interface{}) {
	if fs.opts.Debug {
		log.Printf(format, args...)
	}
}

// ctxOf is a context the kernel's interrupt of the request cancels.
func (fs *FS) ctxOf(cancel <-chan struct{}) (context.Context, context.CancelFunc) {
	ctx, stop := context.WithCancel(fs.ctx)
	if cancel != nil {
		go func() {
			select {
			case <-cancel:
				stop()
			case <-ctx.Done():
			}
		}()
	}
	return ctx, stop
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────────

// errno is the status a door error answers the kernel with.
func errno(err error) fuse.Status {
	if err == nil {
		return fuse.OK
	}
	var st statusError
	if errors.As(err, &st) {
		return st.status
	}
	var fenced *door.FencedError
	if errors.As(err, &fenced) {
		return fuse.EIO
	}
	switch door.CodeOf(err) {
	case door.CodeEntryNotFound, door.CodeParentGone:
		return fuse.ENOENT
	case door.CodeNameTaken:
		return fuse.Status(syscall.EEXIST)
	case door.CodeNotAFolder:
		return fuse.ENOTDIR
	case door.CodeNotAFile:
		return fuse.Status(syscall.EISDIR)
	case door.CodeNameInvalid, door.CodeMoveIntoItself:
		return fuse.EINVAL
	case door.CodeRoot:
		return fuse.EPERM
	case door.CodeStorageFull:
		return fuse.Status(syscall.ENOSPC)
	case door.CodeDriveChatNoOverwrite:
		// A Drive chat never replaces a file: the name is taken, and the owner is asked (§5.8).
		return fuse.Status(syscall.EEXIST)
	case door.CodeDriveChatHeld, door.CodeDriveChatTurnFull:
		// The turn's limit: nothing was changed, and the owner's Apply makes what is held.
		return fuse.Status(syscall.EDQUOT)
	}
	if s := door.StatusOf(err); s == 404 {
		return fuse.ENOENT
	} else if s == 400 {
		return fuse.EINVAL
	}
	return fuse.EIO
}

// isDriveChatRefusal is a Drive chat's write the door refused by the chat's rules rather than the drive's: the agent
// reads why in errors.log, since the errno alone cannot say it.
func isDriveChatRefusal(err error) bool {
	switch door.CodeOf(err) {
	case door.CodeDriveChatNoOverwrite, door.CodeDriveChatHeld, door.CodeDriveChatTurnFull:
		return true
	}
	return false
}

// statusError carries a status of the daemon's own choosing through a Go error.
type statusError struct {
	status fuse.Status
	msg    string
}

func (e statusError) Error() string { return e.msg }

func fail(status fuse.Status, format string, args ...interface{}) error {
	return statusError{status: status, msg: fmt.Sprintf(format, args...)}
}

// refuse logs a refusal to errors.log and answers its status (§5.6).
func (fs *FS) refuse(status fuse.Status, op, drivePath, detail, reason string) fuse.Status {
	fs.rep.Refusal(status, op, fs.display(drivePath), detail, reason)
	return status
}

func (fs *FS) display(drivePath string) string {
	if drivePath == "" || drivePath == "/" {
		return fs.opts.DisplayRoot
	}
	return strings.TrimRight(fs.opts.DisplayRoot, "/") + drivePath
}

// checkName refuses a name the drive cannot keep (§5.6): over 255 bytes, or not UTF-8.
func checkName(name string) fuse.Status {
	if len(name) > nameMax {
		return fuse.Status(syscall.ENAMETOOLONG)
	}
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return fuse.EINVAL
	}
	return fuse.OK
}

func (fs *FS) badName(status fuse.Status, op, parentPath, name string) fuse.Status {
	shown := strings.ToValidUTF8(name, "�")
	if len(shown) > 64 {
		shown = shown[:64] + "…"
	}
	if status == fuse.EINVAL {
		return fs.refuse(status, op, joinPath(parentPath, shown), "", "a name in the drive must be valid UTF-8")
	}
	return fs.refuse(status, op, joinPath(parentPath, shown), "", "a name in the drive is at most 255 bytes")
}

// ── nodes and attributes ─────────────────────────────────────────────────────────────────────────

func joinPath(parent, name string) string {
	if parent == "/" || parent == "" {
		return "/" + name
	}
	return parent + "/" + name
}

// upsertLocked records what the door answered for an entry, and answers its node. FS.mu is held.
func (fs *FS) upsertLocked(e door.Entry) *node {
	if e.Parent() == "" {
		// The root.
		root := fs.byIno[rootIno]
		fs.rootID = e.ID
		root.id = e.ID
		root.mtime, root.seq, root.fetched, root.stale = e.Mtime, e.Seq, time.Now(), false
		fs.byID[e.ID] = root
		return root
	}
	if fs.rootID == "" && e.Parent() != "" && strings.Count(e.Path, "/") == 1 {
		// An entry at the top names the root as its folder: paths can be told without asking for the root.
		root := fs.byIno[rootIno]
		fs.rootID, root.id = e.Parent(), e.Parent()
		fs.byID[e.Parent()] = root
	}
	n := fs.byID[e.ID]
	if n == nil {
		ino, ok := fs.inoByID[e.ID]
		if !ok {
			ino = fs.nextIno
			fs.nextIno++
			fs.inoByID[e.ID] = ino
		}
		n = &node{ino: ino, id: e.ID, dir: e.IsFolder()}
		fs.byIno[ino] = n
		fs.byID[e.ID] = n
	}
	if e.Seq < n.seq && !n.stale {
		// An answer older than one already applied.
		return n
	}
	if e.Seq != n.seq {
		// The content may have changed with it: the chunk list is asked for again.
		n.manifest, n.sha = nil, ""
	}
	if e.SHA256 != nil {
		// Only a listing says it, for a file of one chunk.
		n.sha = *e.SHA256
	}
	n.parentID, n.name = e.Parent(), e.Name
	if n.wf == nil {
		n.size = e.SizeBytes
		n.mtime = e.Mtime
	}
	n.seq = e.Seq
	n.version = e.VersionID()
	n.fetched, n.stale, n.gone = time.Now(), false, false
	return n
}

// attrLocked fills a's attributes of n.
func (fs *FS) attrLocked(n *node, a *fuse.Attr) {
	a.Ino = n.ino
	a.Uid, a.Gid = fs.opts.UID, fs.opts.GID
	size, mtime := n.size, n.mtime
	if n.wf != nil {
		size, mtime = n.wf.attr()
	}
	if n.dir {
		a.Mode = syscall.S_IFDIR | 0o755
		a.Nlink = 2
		size = 0
	} else {
		a.Mode = syscall.S_IFREG | 0o644
		a.Nlink = 1
	}
	if n.gone {
		a.Nlink = 0
	}
	a.Size = uint64(size)
	a.Blocks = (uint64(size) + 511) / 512
	a.Blksize = 1 << 20
	if mtime.IsZero() {
		mtime = fs.mounted
	}
	a.SetTimes(&mtime, &mtime, &mtime)
}

func (fs *FS) entryOutLocked(n *node, out *fuse.EntryOut) {
	n.lookups++
	out.NodeId = n.ino
	out.Generation = 1
	out.SetEntryTimeout(entryTTL)
	out.SetAttrTimeout(attrTTL)
	fs.attrLocked(n, &out.Attr)
}

func (fs *FS) node(ino uint64) *node {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.byIno[ino]
}

// fresh reports whether metadata fetched at t may still answer.
func (fs *FS) fresh(t time.Time) bool {
	limit := cacheFresh
	if fs.door.Health().Offline() {
		limit = offlineFresh
	}
	return time.Since(t) < limit
}

// pathLocked is n's drive path, from the names the daemon knows; ok is false when an ancestor is not known.
func (fs *FS) pathLocked(n *node) (string, bool) {
	if n.ino == rootIno {
		return "/", true
	}
	parts := []string{}
	for cur := n; cur.ino != rootIno; {
		parts = append(parts, cur.name)
		if cur.parentID == "" || len(parts) > 4096 {
			return "", false
		}
		parent := fs.byID[cur.parentID]
		if parent == nil {
			return "", false
		}
		cur = parent
	}
	var b strings.Builder
	for i := len(parts) - 1; i >= 0; i-- {
		b.WriteByte('/')
		b.WriteString(parts[i])
	}
	return b.String(), true
}

// pathOf is n's drive path, asking the door for what it does not know.
func (fs *FS) pathOf(ctx context.Context, n *node) (string, error) {
	for attempt := 0; attempt < 3; attempt++ {
		fs.mu.Lock()
		p, ok := fs.pathLocked(n)
		var missing string
		if !ok {
			for cur := n; cur != nil && cur.ino != rootIno; cur = fs.byID[cur.parentID] {
				if fs.byID[cur.parentID] == nil {
					missing = cur.id
					break
				}
			}
		}
		fs.mu.Unlock()
		if ok {
			return p, nil
		}
		if missing == "" {
			break
		}
		e, err := fs.door.StatID(ctx, missing)
		if err != nil {
			return "", err
		}
		fs.mu.Lock()
		fs.upsertLocked(e)
		fs.mu.Unlock()
		if e.Path != "" {
			// The door answers the path itself: good enough for this entry.
			if missing == n.id {
				return e.Path, nil
			}
		}
	}
	return "", fail(fuse.EIO, "the path of %s is not known", n.id)
}

// root is the root's entry id, asked of the door the first time.
func (fs *FS) root(ctx context.Context) (string, error) {
	fs.mu.Lock()
	id := fs.rootID
	fs.mu.Unlock()
	if id != "" {
		return id, nil
	}
	e, err := fs.door.StatPath(ctx, "/")
	if err != nil {
		return "", err
	}
	fs.mu.Lock()
	fs.upsertLocked(e)
	fs.mu.Unlock()
	return e.ID, nil
}

// folderID is the entry id of folder node n.
func (fs *FS) folderID(ctx context.Context, n *node) (string, error) {
	if n.ino == rootIno {
		return fs.root(ctx)
	}
	return n.id, nil
}

// refresh asks the door again for n's attributes when the feed said they changed or they are old. Offline, what is
// at most 10 minutes old answers (§5.7). An entry in Trash, and one this mount is writing, keep what they have.
func (fs *FS) refresh(ctx context.Context, n *node) error {
	fs.mu.Lock()
	if n.ino == rootIno || n.gone || n.wf != nil {
		fs.mu.Unlock()
		return nil
	}
	age, stale, id := time.Since(n.fetched), n.stale, n.id
	fs.mu.Unlock()
	if fs.door.Health().Offline() {
		if age < offlineFresh {
			return nil
		}
		return door.ErrOffline
	}
	if !stale && age < cacheFresh {
		return nil
	}
	e, err := fs.door.StatID(ctx, id)
	if err != nil {
		if errno(err) == fuse.ENOENT {
			fs.mu.Lock()
			fs.forgetEntryLocked(n)
			fs.mu.Unlock()
		}
		return err
	}
	fs.mu.Lock()
	fs.upsertLocked(e)
	fs.mu.Unlock()
	return nil
}

// forgetEntryLocked marks n as no longer reached by any path: deleted, in Trash, or replaced.
func (fs *FS) forgetEntryLocked(n *node) {
	if n.ino == rootIno {
		return
	}
	if d := fs.dirs[n.parentID]; d != nil {
		if e, ok := d.children[n.name]; ok && e.ID == n.id {
			delete(d.children, n.name)
		}
	}
	n.gone = true
	delete(fs.dirs, n.id)
	fs.dropIfUnusedLocked(n)
}

// dropIfUnusedLocked frees a node nobody holds; its inode number stays reserved for its entry.
func (fs *FS) dropIfUnusedLocked(n *node) {
	if n.ino == rootIno || n.lookups > 0 || n.handles > 0 || n.wf != nil {
		return
	}
	delete(fs.byIno, n.ino)
	if fs.byID[n.id] == n {
		delete(fs.byID, n.id)
	}
}

// ── lookup ───────────────────────────────────────────────────────────────────────────────────────

// child answers the live entry name in folder parent: from the folder's listing when the daemon holds all of it,
// otherwise from the door. A missing name answers ENOENT.
func (fs *FS) child(ctx context.Context, parent *node, name string) (*node, error) {
	fs.mu.Lock()
	pid := parent.id
	if parent.ino == rootIno {
		pid = fs.rootID
	}
	if d := fs.dirs[pid]; d != nil && pid != "" && fs.fresh(d.fetched) {
		if e, ok := d.children[name]; ok {
			n := fs.byID[e.ID]
			if n == nil || !n.stale {
				n = fs.upsertLocked(e)
				fs.mu.Unlock()
				return n, nil
			}
		} else if d.complete {
			fs.mu.Unlock()
			return nil, fail(fuse.ENOENT, "no %s", name)
		}
	}
	fs.mu.Unlock()
	if fs.door.Health().Offline() {
		return nil, door.ErrOffline
	}
	dir, err := fs.pathOf(ctx, parent)
	if err != nil {
		return nil, err
	}
	e, err := fs.door.StatPath(ctx, joinPath(dir, name))
	if err != nil {
		return nil, err
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	n := fs.upsertLocked(e)
	fs.rememberChildLocked(e)
	return n, nil
}

// rememberChildLocked adds e to its folder's listing, if the daemon keeps one.
func (fs *FS) rememberChildLocked(e door.Entry) {
	d := fs.dirs[e.Parent()]
	if d == nil {
		d = &dirCache{children: map[string]door.Entry{}, fetched: time.Now()}
		fs.dirs[e.Parent()] = d
	}
	d.children[e.Name] = e
}

// forgetChildLocked removes name from folder parentID's listing.
func (fs *FS) forgetChildLocked(parentID, name string) {
	if d := fs.dirs[parentID]; d != nil {
		delete(d.children, name)
	}
}

func (fs *FS) Lookup(cancel <-chan struct{}, header *fuse.InHeader, name string, out *fuse.EntryOut) fuse.Status {
	if st := checkName(name); st != fuse.OK {
		if st == fuse.EINVAL {
			// It cannot exist; a create of it is refused with the reason.
			return fuse.ENOENT
		}
		fs.mu.Lock()
		p, _ := fs.pathLocked(fs.byIno[header.NodeId])
		fs.mu.Unlock()
		return fs.badName(st, "lookup", p, name)
	}
	parent := fs.node(header.NodeId)
	if parent == nil {
		return fuse.ENOENT
	}
	if !parent.dir {
		return fuse.ENOTDIR
	}
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	n, err := fs.child(ctx, parent, name)
	if err != nil {
		if errno(err) == fuse.ENOENT {
			// A negative entry, kept 10 s (§5.1).
			out.NodeId = 0
			out.SetEntryTimeout(negativeTTL)
			return fuse.OK
		}
		return fs.failed("lookup", fs.pathForLog(header.NodeId, name), err)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.entryOutLocked(n, out)
	return fuse.OK
}

func (fs *FS) Forget(nodeid, nlookup uint64) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	n := fs.byIno[nodeid]
	if n == nil || n.ino == rootIno {
		return
	}
	if nlookup >= n.lookups {
		n.lookups = 0
	} else {
		n.lookups -= nlookup
	}
	fs.dropIfUnusedLocked(n)
}

func (fs *FS) GetAttr(cancel <-chan struct{}, input *fuse.GetAttrIn, out *fuse.AttrOut) fuse.Status {
	n := fs.node(input.NodeId)
	if n == nil {
		return fuse.ENOENT
	}
	if n.ino != rootIno {
		// The root answers from memory, never the server: the watchdog's forced stat of it tells a frozen daemon from
		// an outage (§5.7).
		ctx, stop := fs.ctxOf(cancel)
		err := fs.refresh(ctx, n)
		stop()
		if err != nil {
			fs.mu.Lock()
			held := n.handles > 0 || n.wf != nil
			fs.mu.Unlock()
			if !(held && errno(err) == fuse.ENOENT) {
				return errno(err)
			}
		}
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	out.SetTimeout(attrTTL)
	fs.attrLocked(n, &out.Attr)
	return fuse.OK
}

func (fs *FS) Access(cancel <-chan struct{}, input *fuse.AccessIn) fuse.Status {
	// default_permissions: the kernel checks modes itself.
	return fuse.OK
}

func (fs *FS) StatFs(cancel <-chan struct{}, input *fuse.InHeader, out *fuse.StatfsOut) fuse.Status {
	const bsize = 4096
	const free = 1 << 50 // 1 PiB
	fs.mu.Lock()
	usage, at := fs.usage, fs.usageAt
	fs.mu.Unlock()
	if time.Since(at) > 30*time.Second && !fs.door.Health().Offline() {
		ctx, stop := fs.ctxOf(cancel)
		if u, err := fs.door.Usage(ctx); err == nil {
			usage = u
			fs.mu.Lock()
			fs.usage, fs.usageAt = u, time.Now()
			fs.mu.Unlock()
		} else {
			fs.mu.Lock()
			fs.usageAt = time.Now()
			fs.mu.Unlock()
		}
		stop()
	}
	used := uint64(usage.DriveBytes+bsize-1) / bsize
	out.Bsize = bsize
	out.Frsize = bsize
	out.Blocks = used + free/bsize
	out.Bfree = free / bsize
	out.Bavail = free / bsize
	out.Files = 1 << 40
	out.Ffree = 1 << 40
	out.NameLen = nameMax
	return fuse.OK
}

// ── refusals (§5.6) ──────────────────────────────────────────────────────────────────────────────

func (fs *FS) pathForLog(ino uint64, name string) string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	n := fs.byIno[ino]
	if n == nil {
		return "/" + name
	}
	p, _ := fs.pathLocked(n)
	if name != "" {
		return joinPath(p, name)
	}
	return p
}

func (fs *FS) Link(cancel <-chan struct{}, input *fuse.LinkIn, name string, out *fuse.EntryOut) fuse.Status {
	return fs.refuse(fuse.EPERM, "link", fs.pathForLog(input.NodeId, name), "",
		"the drive has no hard links; copy the file instead")
}

func (fs *FS) Symlink(cancel <-chan struct{}, header *fuse.InHeader, target string, name string, out *fuse.EntryOut) fuse.Status {
	return fs.refuse(fuse.EPERM, "symlink", fs.pathForLog(header.NodeId, name), "",
		"the drive has no symbolic links; copy the file, or keep the link outside the drive")
}

func (fs *FS) Readlink(cancel <-chan struct{}, header *fuse.InHeader) ([]byte, fuse.Status) {
	return nil, fuse.EINVAL
}

func (fs *FS) GetXAttr(cancel <-chan struct{}, header *fuse.InHeader, attr string, dest []byte) (uint32, fuse.Status) {
	return 0, fuse.ENOATTR
}

func (fs *FS) ListXAttr(cancel <-chan struct{}, header *fuse.InHeader, dest []byte) (uint32, fuse.Status) {
	return 0, fuse.OK
}

func (fs *FS) SetXAttr(cancel <-chan struct{}, input *fuse.SetXAttrIn, attr string, data []byte) fuse.Status {
	if strings.HasPrefix(attr, "system.posix_acl_") {
		// cp, sed -i, vim and install copy a file's ACL when they can and carry on when they cannot, as on any file
		// system without ACLs: refused, but not worth a line an agent would read as its own failure.
		return fuse.Status(syscall.ENOTSUP)
	}
	return fs.refuse(fuse.Status(syscall.ENOTSUP), "setxattr", fs.pathForLog(input.NodeId, ""), attr,
		"the drive keeps no extended attributes")
}

func (fs *FS) RemoveXAttr(cancel <-chan struct{}, header *fuse.InHeader, attr string) fuse.Status {
	return fuse.ENOATTR
}

func (fs *FS) GetLk(cancel <-chan struct{}, input *fuse.LkIn, out *fuse.LkOut) fuse.Status {
	return fs.refuseLock(input)
}

func (fs *FS) SetLk(cancel <-chan struct{}, input *fuse.LkIn) fuse.Status {
	if input.Lk.Typ == syscall.F_UNLCK {
		return fuse.OK
	}
	return fs.refuseLock(input)
}

func (fs *FS) SetLkw(cancel <-chan struct{}, input *fuse.LkIn) fuse.Status {
	if input.Lk.Typ == syscall.F_UNLCK {
		return fuse.OK
	}
	return fs.refuseLock(input)
}

func (fs *FS) refuseLock(input *fuse.LkIn) fuse.Status {
	kind := "fcntl lock"
	if input.LkFlags&fuse.LK_FLOCK != 0 {
		kind = "flock"
	}
	return fs.refuse(fuse.Status(syscall.ENOLCK), kind, fs.pathForLog(input.NodeId, ""), "",
		"the drive has no file locks, so a program that needs them (sqlite, a git index) should keep its files outside the drive")
}

func (fs *FS) Fallocate(cancel <-chan struct{}, input *fuse.FallocateIn) fuse.Status {
	return fs.refuse(fuse.Status(syscall.EOPNOTSUPP), "fallocate", fs.pathForLog(input.NodeId, ""),
		fmt.Sprintf("at offset %d length %d", input.Offset, input.Length), "the drive does not preallocate or punch holes; write the bytes instead")
}

func (fs *FS) CopyFileRange(cancel <-chan struct{}, input *fuse.CopyFileRangeIn) (uint32, fuse.Status) {
	// The kernel falls back to reads and writes, which keep every rule of a write.
	return 0, fuse.ENOSYS
}

func (fs *FS) Lseek(cancel <-chan struct{}, in *fuse.LseekIn, out *fuse.LseekOut) fuse.Status {
	return fuse.ENOSYS
}

func (fs *FS) Ioctl(cancel <-chan struct{}, input *fuse.IoctlIn, inbuf []byte, output *fuse.IoctlOut, outbuf []byte) fuse.Status {
	return fuse.Status(syscall.ENOTTY)
}

func (fs *FS) Tmpfile(cancel <-chan struct{}, input *fuse.CreateIn, out *fuse.CreateOut) fuse.Status {
	return fuse.Status(syscall.EOPNOTSUPP)
}

func (fs *FS) Statx(cancel <-chan struct{}, input *fuse.StatxIn, out *fuse.StatxOut) fuse.Status {
	return fuse.ENOSYS
}

// ── fencing and health ───────────────────────────────────────────────────────────────────────────

// fenced stops the daemon accepting work (§8.2): every write and close fails EIO with the reason in errors.log, and
// OnFenced (which aborts the connection and exits) runs after a moment, so the call that met it reads EIO first.
func (fs *FS) fenced(f *door.FencedError) {
	reason := "this runner instance was replaced by a newer one, or its drive access was ended; its drive writes are refused and nothing more is committed"
	if f.Code == door.CodeInstanceFenced {
		reason = "this runner instance was fenced; its drive writes are refused and nothing more is committed"
	}
	fs.rep.Log(fuse.EIO, "fence", fs.opts.DisplayRoot, f.Code, reason)
	fs.rep.SetFenced(f.Code)
	if fs.opts.OnFenced != nil {
		go func() {
			time.Sleep(2 * time.Second)
			fs.opts.OnFenced(f.Code)
		}()
	}
}

// healthChanged follows the server going away and coming back: back, the metadata cache is dropped (§5.4).
func (fs *FS) healthChanged(online bool, since time.Time) {
	fs.rep.SetConnected(online, since)
	if online {
		fs.dropMetadata("reconnected")
		select {
		case fs.reconnected <- struct{}{}:
		default:
		}
	}
}

// runStatus keeps status.json current: connected or not, and how many handles hold uncommitted bytes.
func (fs *FS) runStatus() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		dirty := 0
		for _, wf := range fs.writeStates() {
			if wf.isDirty() {
				dirty++
			}
		}
		fs.rep.SetUncommitted(dirty)
		fs.rep.SetSpool(fs.spool.usage())
		fs.rep.WriteStatus()
		select {
		case <-fs.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// runUnsentCheck asks, once the server answers again and every minute, whether each unsent file's commit applied
// after all, and removes those that did, and those older than 24 h (§5.7).
func (fs *FS) runUnsentCheck() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if !fs.door.Health().Offline() && fs.door.Fenced() == nil {
			fs.rep.CheckUnsent(fs.ctx, func(ctx context.Context, commitID string) (bool, error) {
				ok, _, err := fs.door.CommitStatus(ctx, commitID)
				return ok, err
			})
		}
		select {
		case <-fs.ctx.Done():
			return
		case <-ticker.C:
		case <-fs.reconnected:
		}
	}
}
