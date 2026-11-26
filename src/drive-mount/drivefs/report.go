package drivefs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
)

// Reporter writes what an agent reads beside the mount, in the plain parent directory /run/orbit-drive (§5.6, §5.7):
//
//   - errors.log, one line per refusal or failure, saying why (an errno alone does not), the last 1,000 lines;
//   - status.json, whether the drive is connected, since when not, and how many handles hold uncommitted bytes;
//   - unsent/, the bytes of a write whose close failed, at most 1 GiB, each kept 24 h unless its commit did apply.
type Reporter struct {
	opts ReporterOptions

	mu         sync.Mutex
	lines      []string
	written    int // lines in the file now
	last       map[string]time.Time
	connected  bool
	since      time.Time
	fenced     string
	dirty      int
	spoolUsed  int64
	spoolPeak  int64
	feedAt     time.Time
	statusText string
}

// ReporterOptions say where the reporter writes.
type ReporterOptions struct {
	// Dir is the plain parent directory, /run/orbit-drive: errors.log, status.json and unsent/ are in it.
	Dir string
	// ShownDir is how agents know Dir, for the paths errors.log names (defaults to Dir).
	ShownDir string
	// ErrorsFile and StatusFile, when set, are errors.log and status.json opened by the privileged parent: the daemon
	// cannot create files in the root-owned directory itself.
	ErrorsFile *os.File
	StatusFile *os.File
	// UnsentLimit bounds unsent/ (1 GiB per runner); UnsentKeep is how long a file is kept (24 h).
	UnsentLimit int64
	UnsentKeep  time.Duration
	// MaxLines is how many lines errors.log keeps (1,000).
	MaxLines int
	// Echo, when set, also gets every line (the daemon's own log).
	Echo io.Writer
	Now  func() time.Time
}

// UnsentRecord is what the daemon keeps of an unsent file, to tell later whether its commit applied after all.
type UnsentRecord struct {
	File     string    `json:"file"`
	CommitID string    `json:"commitId,omitempty"`
	EntryID  string    `json:"entryId"`
	Path     string    `json:"path"`
	Mode     string    `json:"mode"`
	Size     int64     `json:"size"`
	Missing  int64     `json:"missing,omitempty"`
	SavedAt  time.Time `json:"savedAt"`
}

// NewReporter makes a reporter.
func NewReporter(opts ReporterOptions) *Reporter {
	if opts.UnsentLimit == 0 {
		opts.UnsentLimit = 1 << 30
	}
	if opts.UnsentKeep == 0 {
		opts.UnsentKeep = 24 * time.Hour
	}
	if opts.MaxLines == 0 {
		opts.MaxLines = 1000
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ShownDir == "" {
		opts.ShownDir = opts.Dir
	}
	r := &Reporter{opts: opts, last: map[string]time.Time{}, connected: true}
	if f := r.errorsFile(); f != nil {
		// Keep what an earlier daemon of this mount wrote, the last lines of it.
		if data, err := io.ReadAll(io.NewSectionReader(f, 0, 1<<30)); err == nil {
			for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
				if line != "" {
					r.lines = append(r.lines, line)
				}
			}
			if len(r.lines) > opts.MaxLines {
				r.lines = r.lines[len(r.lines)-opts.MaxLines:]
			}
			r.rewriteLocked()
		}
	}
	return r
}

func (r *Reporter) errorsFile() *os.File {
	if r.opts.ErrorsFile != nil {
		return r.opts.ErrorsFile
	}
	if r.opts.Dir == "" {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(r.opts.Dir, "errors.log"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil
	}
	r.opts.ErrorsFile = f
	return f
}

func (r *Reporter) statusFile() *os.File {
	if r.opts.StatusFile != nil {
		return r.opts.StatusFile
	}
	if r.opts.Dir == "" {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(r.opts.Dir, "status.json"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil
	}
	r.opts.StatusFile = f
	return f
}

var errnoNames = map[fuse.Status]string{
	fuse.EIO: "EIO", fuse.EPERM: "EPERM", fuse.ENOENT: "ENOENT", fuse.EINVAL: "EINVAL", fuse.ENOTDIR: "ENOTDIR",
	fuse.EACCES: "EACCES", fuse.EBUSY: "EBUSY", fuse.Status(syscall.EEXIST): "EEXIST",
	fuse.Status(syscall.EISDIR): "EISDIR", fuse.Status(syscall.ENOSPC): "ENOSPC",
	fuse.Status(syscall.ENOTEMPTY): "ENOTEMPTY", fuse.Status(syscall.EOPNOTSUPP): "EOPNOTSUPP",
	fuse.Status(syscall.ENOLCK): "ENOLCK", fuse.Status(syscall.ENAMETOOLONG): "ENAMETOOLONG",
	fuse.Status(syscall.ENODEV): "ENODEV",
}

func errnoName(st fuse.Status, op string) string {
	if st == fuse.OK {
		// Not a failure: something the daemon did that an agent should know of (an unsent file removed).
		return "INFO"
	}
	if op == "setxattr" && st == fuse.Status(syscall.ENOTSUP) {
		return "ENOTSUP"
	}
	if name, ok := errnoNames[st]; ok {
		return name
	}
	return fmt.Sprintf("errno %d", int(st))
}

// Refusal logs an operation the drive does not support (§5.6).
func (r *Reporter) Refusal(st fuse.Status, op, shownPath, detail, reason string) {
	r.Log(st, op, shownPath, detail, reason)
}

// Log appends one line to errors.log:
//
//	2026-11-20T10:00:00Z EOPNOTSUPP write /home/orbit/Drive/Proj/app.db at offset 4096: the drive does not change a file in place; ...
//
// The same line again within a second is not repeated.
func (r *Reporter) Log(st fuse.Status, op, shownPath, detail, reason string) {
	now := r.opts.Now().UTC()
	what := fmt.Sprintf("%s %s %s", errnoName(st, op), op, shownPath)
	if detail != "" {
		what += " " + detail
	}
	line := fmt.Sprintf("%s %s: %s", now.Format(time.RFC3339), what, reason)
	r.mu.Lock()
	defer r.mu.Unlock()
	if at, ok := r.last[what]; ok && now.Sub(at) < time.Second {
		return
	}
	r.last[what] = now
	if len(r.last) > 4096 {
		r.last = map[string]time.Time{}
	}
	if r.opts.Echo != nil {
		fmt.Fprintln(r.opts.Echo, line)
	}
	r.lines = append(r.lines, line)
	f := r.errorsFile()
	if f == nil {
		if len(r.lines) > r.opts.MaxLines {
			r.lines = r.lines[len(r.lines)-r.opts.MaxLines:]
		}
		return
	}
	if len(r.lines) > r.opts.MaxLines+r.opts.MaxLines/5 {
		r.lines = r.lines[len(r.lines)-r.opts.MaxLines:]
		r.rewriteLocked()
		return
	}
	if info, err := f.Stat(); err == nil {
		_, _ = f.WriteAt([]byte(line+"\n"), info.Size())
		r.written++
	}
}

// Lines is what errors.log holds, for tests.
func (r *Reporter) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.lines...)
}

func (r *Reporter) rewriteLocked() {
	f := r.errorsFile()
	if f == nil {
		return
	}
	data := strings.Join(r.lines, "\n")
	if data != "" {
		data += "\n"
	}
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(data), 0)
	r.written = len(r.lines)
}

// ── status.json ──────────────────────────────────────────────────────────────────────────────────

// SetConnected records the server going away or coming back.
func (r *Reporter) SetConnected(online bool, since time.Time) {
	r.mu.Lock()
	r.connected = online
	if online {
		r.since = time.Time{}
	} else {
		r.since = since
	}
	r.mu.Unlock()
	r.WriteStatus()
}

// SetFenced records that the instance may no longer use the drive.
func (r *Reporter) SetFenced(code string) {
	r.mu.Lock()
	r.fenced = code
	r.mu.Unlock()
	r.WriteStatus()
}

// SetUncommitted records how many handles hold bytes no commit has taken.
func (r *Reporter) SetUncommitted(n int) {
	r.mu.Lock()
	r.dirty = n
	r.mu.Unlock()
}

// SetSpool records the spool's bytes now and at most since the daemon started (§5.3).
func (r *Reporter) SetSpool(used, peak int64) {
	r.mu.Lock()
	r.spoolUsed, r.spoolPeak = used, peak
	r.mu.Unlock()
}

// FeedSeen records that the change feed answered.
func (r *Reporter) FeedSeen() {
	r.mu.Lock()
	r.feedAt = r.opts.Now()
	r.mu.Unlock()
}

// Status is what status.json says.
type Status struct {
	Connected          bool       `json:"connected"`
	Since              *time.Time `json:"since"`
	UncommittedHandles int        `json:"uncommittedHandles"`
	UnsentFiles        int        `json:"unsentFiles"`
	SpoolBytes         int64      `json:"spoolBytes"`
	SpoolPeakBytes     int64      `json:"spoolPeakBytes"`
	Fenced             string     `json:"fenced,omitempty"`
	// Locks says how file locks are handled: negotiated with the kernel, so none is granted locally, and refused.
	Locks        string     `json:"locks"`
	ChangeFeedAt *time.Time `json:"changeFeedAt,omitempty"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

// CurrentStatus is what status.json says now.
func (r *Reporter) CurrentStatus() Status {
	unsent := len(r.unsentRecords())
	r.mu.Lock()
	defer r.mu.Unlock()
	s := Status{Connected: r.connected && r.fenced == "", UncommittedHandles: r.dirty, UnsentFiles: unsent, Fenced: r.fenced,
		SpoolBytes: r.spoolUsed, SpoolPeakBytes: r.spoolPeak, UpdatedAt: r.opts.Now().UTC(),
		Locks: "refused: flock and fcntl locks are passed to the drive, which answers ENOLCK (none is granted locally)"}
	if !r.connected && !r.since.IsZero() {
		t := r.since.UTC()
		s.Since = &t
	}
	if !r.feedAt.IsZero() {
		t := r.feedAt.UTC()
		s.ChangeFeedAt = &t
	}
	return s
}

// WriteStatus writes status.json.
func (r *Reporter) WriteStatus() {
	s := r.CurrentStatus()
	data, _ := json.MarshalIndent(s, "", "  ")
	data = append(data, '\n')
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.statusFile()
	if f == nil {
		return
	}
	text := string(data)
	if text == r.statusText {
		return
	}
	r.statusText = text
	_, _ = f.WriteAt(data, 0)
	_ = f.Truncate(int64(len(data)))
}

// ── unsent/ ──────────────────────────────────────────────────────────────────────────────────────

func (r *Reporter) unsentDir() string {
	if r.opts.Dir == "" {
		return ""
	}
	return filepath.Join(r.opts.Dir, "unsent")
}

// UnsentPath is how an agent finds an unsent file.
func (r *Reporter) UnsentPath(file string) string {
	return filepath.Join(r.opts.ShownDir, "unsent", file)
}

// SaveUnsent keeps the bytes of a write whose close failed, and answers the file's name, or "".
func (r *Reporter) SaveUnsent(name string, data []byte, rec UnsentRecord) string {
	dir := r.unsentDir()
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(filepath.Join(dir, ".state"), 0o755); err != nil {
		return ""
	}
	stamp := r.opts.Now().UTC().Format("20060102T150405.000Z")
	name = strings.ReplaceAll(name, "/", "_")
	file := stamp + "-" + name
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(dir, file)); os.IsNotExist(err) {
			break
		}
		file = fmt.Sprintf("%s-%d-%s", stamp, i, name)
	}
	if err := os.WriteFile(filepath.Join(dir, file), data, 0o644); err != nil {
		return ""
	}
	rec.File, rec.Size, rec.SavedAt = file, int64(len(data)), r.opts.Now().UTC()
	if meta, err := json.Marshal(rec); err == nil {
		_ = os.WriteFile(filepath.Join(dir, ".state", file+".json"), meta, 0o644)
	}
	r.trimUnsent(file)
	r.WriteStatus()
	return file
}

func (r *Reporter) unsentRecords() []UnsentRecord {
	dir := r.unsentDir()
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []UnsentRecord
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		rec := UnsentRecord{File: e.Name()}
		if meta, err := os.ReadFile(filepath.Join(dir, ".state", e.Name()+".json")); err == nil {
			_ = json.Unmarshal(meta, &rec)
		}
		if info, err := e.Info(); err == nil {
			rec.Size = info.Size()
			if rec.SavedAt.IsZero() {
				rec.SavedAt = info.ModTime()
			}
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].File < out[j].File })
	return out
}

func (r *Reporter) removeUnsent(rec UnsentRecord, why string) {
	dir := r.unsentDir()
	_ = os.Remove(filepath.Join(dir, rec.File))
	_ = os.Remove(filepath.Join(dir, ".state", rec.File+".json"))
	r.Log(fuse.OK, "unsent", r.UnsentPath(rec.File), "", why)
}

// trimUnsent keeps unsent/ under its limit, the oldest files going first, each removal logged (§5.7).
func (r *Reporter) trimUnsent(keep string) {
	recs := r.unsentRecords()
	var total int64
	for _, rec := range recs {
		total += rec.Size
	}
	for _, rec := range recs {
		if total <= r.opts.UnsentLimit {
			break
		}
		if rec.File == keep && len(recs) > 1 {
			continue
		}
		total -= rec.Size
		r.removeUnsent(rec, fmt.Sprintf("removed (%d bytes) to keep unsent/ under %s; the oldest go first", rec.Size, sizeText(r.opts.UnsentLimit)))
	}
}

func sizeText(n int64) string {
	switch {
	case n >= 1<<30 && n%(1<<30) == 0:
		return fmt.Sprintf("%d GiB", n>>30)
	case n >= 1<<20 && n%(1<<20) == 0:
		return fmt.Sprintf("%d MiB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}

// CheckUnsent removes unsent files older than 24 h, and those whose commit did apply after all (the answer was lost,
// not the commit): applied asks the door.
func (r *Reporter) CheckUnsent(ctx context.Context, applied func(ctx context.Context, commitID string) (bool, error)) {
	for _, rec := range r.unsentRecords() {
		if r.opts.Now().Sub(rec.SavedAt) > r.opts.UnsentKeep {
			r.removeUnsent(rec, fmt.Sprintf("removed after %s, its commit never having applied", r.opts.UnsentKeep))
			continue
		}
		if rec.CommitID == "" || applied == nil {
			continue
		}
		ok, err := applied(ctx, rec.CommitID)
		if err == nil && ok {
			r.removeUnsent(rec, fmt.Sprintf("removed: its commit %s did apply, so %s holds these bytes", rec.CommitID, rec.Path))
		}
	}
	r.WriteStatus()
}
