package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// documents_sync / `orbit documents sync`: one directory copied into the owner's drive once, in the background, local to drive
// only (docs/documents-directory-sync-design.md, S1-S4). The tool and the command without --wait start a runner-hosted
// background job that runs `orbit documents sync --wait`, so the copy outlives the engine and the job's wake tells the agent
// when it ends; --wait is the copy itself. While it runs it reports its counts to the server, which shows them in the
// upload tray of the owner's Documents page.

const (
	documentsSyncWorkers       = 4
	documentsSyncReportEvery   = 2 * time.Second
	documentsSyncPrintEvery    = 5 * time.Second
	documentsSyncFailedMax     = 100
	documentsSyncFileAttempts  = 3
	documentsSyncSyncsRoute    = documentsRoute + "/syncs"
	documentsSyncChangedReason = "Changed while uploading. It was being written to."
)

type documentsSyncFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// documentsSyncSummary is the sync's answer, and the last line a background sync prints.
type documentsSyncSummary struct {
	Path        string                 `json:"path"`
	Link        string                 `json:"link,omitempty"`
	Uploaded    int                    `json:"uploaded"`
	Unchanged   int                    `json:"unchanged"`
	Deleted     int                    `json:"deleted"`
	Bytes       int64                  `json:"bytes"`
	Skipped     int                    `json:"skipped,omitempty"`
	Failed      []documentsSyncFailure `json:"failed"`
	FailedCount int                    `json:"failedCount"`
}

type documentsSyncOptions struct {
	sessionID string
	// The local directory, absolute with its links resolved, which documentsSyncSource checked.
	source string
	// The destination's drive path, normalized.
	dest        string
	deleteExtra bool
	// The sync's record, when whoever started the job opened it already (documents_sync does, so that its answer
	// names the sync for the conversation's card); empty, the sync opens its own.
	syncID string
	// Where progress lines go; nil prints none.
	out io.Writer
}

// documentsSyncSource checks the local directory before anything starts, so a bad path is the call's error and not a
// failed job: a directory in this session's checkout or uploads directory, and not in the drive's own mount.
func documentsSyncSource(sessionID, localPath string) (string, error) {
	if strings.TrimSpace(localPath) == "" {
		return "", errors.New("documents_sync requires localPath")
	}
	abs := absPath(localPath)
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("documents_sync: %w", err)
	}
	for _, root := range []string{driveMountPath, driveHomePath} {
		if pathInsideAny(real, realPath(root)) {
			return "", fmt.Errorf("documents_sync: %s is inside Drive itself; sync a directory of this session's checkout or uploads directory", abs)
		}
	}
	if reason := newSessionFileScope(sessionID).refuses(real); reason != "" {
		return "", fileScopeError(abs, reason, sessionID)
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("documents_sync: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("documents_sync: %s is not a directory; use documents_put for one file", abs)
	}
	return real, nil
}

// documentsSyncDest normalizes the destination. --delete into the drive's root is refused: one mistyped path must not send
// the whole drive to Trash.
func documentsSyncDest(p string, deleteExtra bool) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", errors.New("documents_sync requires path")
	}
	dest, err := normalizeDocumentsPath(p)
	if err != nil {
		return "", err
	}
	if deleteExtra && dest == "/" {
		return "", errors.New("documents_sync: --delete into the root of Drive is refused; name the folder to sync into")
	}
	return dest, nil
}

// documentsSyncLocal is one regular file of the directory as the walk saw it.
type documentsSyncLocal struct {
	rel   string
	path  string
	size  int64
	mtime time.Time
}

// documentsSyncProgress is what the tray and the progress lines read, guarded by mu.
type documentsSyncProgress struct {
	mu          sync.Mutex
	status      string
	seen        int
	total       *int
	done        int
	same        int
	deleted     int
	bytesTotal  *int64
	bytesDone   int64
	inFlight    map[string]*documentsProgress
	current     string
	failed      []documentsSyncFailure
	failedCount int
	destEntryID string
	err         string
	version     int
}

func (p *documentsSyncProgress) update(f func(*documentsSyncProgress)) {
	p.mu.Lock()
	f(p)
	p.version++
	p.mu.Unlock()
}

func (p *documentsSyncProgress) fail(rel, reason string) {
	p.update(func(p *documentsSyncProgress) {
		p.failedCount++
		if len(p.failed) < documentsSyncFailedMax {
			p.failed = append(p.failed, documentsSyncFailure{Path: rel, Error: reason})
		}
	})
}

// sent is the bytes of finished files and of those going up now, each counted at most once.
func (p *documentsSyncProgress) sentLocked() int64 {
	sent := p.bytesDone
	for _, counter := range p.inFlight {
		counter.mu.Lock()
		n := counter.sent
		if counter.size > 0 && n > counter.size {
			n = counter.size
		}
		counter.mu.Unlock()
		sent += n
	}
	return sent
}

// report is the body of one PATCH: the counts as they are now, never a delta.
func (p *documentsSyncProgress) report() (map[string]interface{}, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	body := map[string]interface{}{
		"status": p.status, "filesSeen": p.seen, "filesDone": p.done, "filesSame": p.same, "filesDeleted": p.deleted,
		"bytesSent": p.sentLocked(), "failed": append([]documentsSyncFailure{}, p.failed...), "failedCount": p.failedCount,
	}
	if p.total != nil {
		body["filesTotal"] = *p.total
	}
	if p.bytesTotal != nil {
		body["bytesTotal"] = *p.bytesTotal
	}
	if p.current != "" {
		body["currentPath"] = p.current
	}
	if p.destEntryID != "" {
		body["destEntryId"] = p.destEntryID
	}
	if p.err != "" {
		body["error"] = p.err
	}
	return body, p.version
}

func (p *documentsSyncProgress) line() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.total == nil {
		return fmt.Sprintf("Checking files… %d so far", p.seen)
	}
	return fmt.Sprintf("Synced %d of %d files, %s of %s", p.done, *p.total, humanBytes(p.sentLocked()), humanBytes(*p.bytesTotal))
}

// humanBytes is a size in decimal units, as the Documents page shows it (lib/documents.ts formatSize).
func humanBytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value, suffix := float64(n), "KMGTPE"
	i := -1
	for value >= unit && i < len(suffix)-1 {
		value /= unit
		i++
	}
	return fmt.Sprintf("%.1f %cB", value, suffix[i])
}

// documentsSyncReporter sends the progress to the server for the owner's tray. Best effort throughout: a sync whose
// reports fail still syncs, and the next report carries the full counts.
type documentsSyncReporter struct {
	t        *Transport
	id       string
	progress *documentsSyncProgress
	sent     int
}

func openDocumentsSyncReport(ctx context.Context, t *Transport, opts documentsSyncOptions, progress *documentsSyncProgress) *documentsSyncReporter {
	if opts.syncID != "" {
		return &documentsSyncReporter{t: t, id: opts.syncID, progress: progress, sent: -1}
	}
	id, err := openDocumentsSync(ctx, t, opts.sessionID, opts.source, opts.dest)
	if err != nil {
		logln("documents sync: could not open its progress report, the Drive page will not show it:", err)
		return nil
	}
	return &documentsSyncReporter{t: t, id: id, progress: progress, sent: -1}
}

// openDocumentsSync makes the sync's record on the server, which the owner's tray and the conversation's card read.
func openDocumentsSync(ctx context.Context, t *Transport, sessionID, source, dest string) (string, error) {
	body := map[string]interface{}{"sourceName": filepath.Base(source), "destPath": dest}
	if sessionID != "" {
		body["sessionId"] = decodeSessionID(sessionID)
	}
	var opened struct {
		ID string `json:"id"`
	}
	if err := t.do(ctx, http.MethodPost, documentsSyncSyncsRoute, body, &opened, documentsTimeout); err != nil {
		return "", err
	}
	if opened.ID == "" {
		return "", errors.New("the server answered no sync id")
	}
	return opened.ID, nil
}

// endDocumentsSync ends a sync whose job never started, so neither the tray nor the card waits on it.
func endDocumentsSync(t *Transport, id, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), documentsTimeout)
	defer cancel()
	body := map[string]interface{}{"status": "FAILED", "error": reason}
	if err := t.do(ctx, http.MethodPatch, documentsSyncSyncsRoute+"/"+url.PathEscape(id), body, nil, documentsTimeout); err != nil {
		logln("documents sync: could not end the sync whose job did not start:", err)
	}
}

// send reports when anything moved since the last report, or always when final.
func (r *documentsSyncReporter) send(ctx context.Context, final bool) {
	if r == nil {
		return
	}
	body, version := r.progress.report()
	if !final && version == r.sent {
		return
	}
	if err := r.t.do(ctx, http.MethodPatch, documentsSyncSyncsRoute+"/"+url.PathEscape(r.id), body, nil, documentsTimeout); err != nil {
		logln("documents sync: a progress report failed:", err)
		return
	}
	r.sent = version
}

// runDocumentsSync is one pass: list the destination, walk the directory, decide each file, upload, delete with --delete.
// The error is for a sync that could not finish at all; a file that failed is in the summary's failed.
func runDocumentsSync(ctx context.Context, t *Transport, opts documentsSyncOptions) (documentsSyncSummary, error) {
	summary := documentsSyncSummary{Path: opts.dest, Failed: []documentsSyncFailure{}}
	progress := &documentsSyncProgress{status: "CHECKING", inFlight: map[string]*documentsProgress{}}
	reporter := openDocumentsSyncReport(ctx, t, opts, progress)
	stop := make(chan struct{})
	ticking := sync.WaitGroup{}
	ticking.Add(1)
	go func() {
		defer ticking.Done()
		report, print := time.NewTicker(documentsSyncReportEvery), time.NewTicker(documentsSyncPrintEvery)
		defer report.Stop()
		defer print.Stop()
		for {
			select {
			case <-stop:
				return
			case <-report.C:
				reporter.send(ctx, false)
			case <-print.C:
				if opts.out != nil {
					fmt.Fprintln(opts.out, progress.line())
				}
			}
		}
	}()
	finish := func(status string, cause error) {
		close(stop)
		ticking.Wait()
		progress.update(func(p *documentsSyncProgress) {
			p.status, p.current = status, ""
			if cause != nil {
				p.err = cause.Error()
			}
		})
		// The last report goes even when the sync's own context ended: a killed sync says it stopped.
		final, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		reporter.send(final, true)
	}

	writer := documentsWriter{SessionID: opts.sessionID}
	summary, err := documentsSyncPass(ctx, t, opts, writer, progress, summary)
	switch {
	case ctx.Err() != nil:
		finish("STOPPED", nil)
		return summary, ctx.Err()
	case err != nil:
		finish("FAILED", err)
		return summary, err
	}
	finish("DONE", nil)
	return summary, nil
}

func documentsSyncPass(ctx context.Context, t *Transport, opts documentsSyncOptions, writer documentsWriter, progress *documentsSyncProgress, summary documentsSyncSummary) (documentsSyncSummary, error) {
	remote, err := listDocumentsTree(ctx, t, opts.dest)
	if err != nil {
		return summary, err
	}
	files, dirs, skipped, err := walkDocumentsSyncSource(opts.source, newSessionFileScope(opts.sessionID), progress)
	if err != nil {
		return summary, err
	}
	summary.Skipped = len(skipped)

	// Decide each file: missing, or another size, uploads; the same size and modification time is the same file; the
	// same size and another time is compared chunk by chunk, so a touched file costs a utimens and not a version.
	var uploads []documentsSyncLocal
	var total int64
	for _, local := range files {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		entry, found := remote[local.rel]
		switch {
		case !found:
		case entry.Kind == "FOLDER":
			progress.fail(local.rel, "Drive has a folder with this name.")
			continue
		case entry.SizeBytes == local.size && sameDocumentsMtime(entry.Mtime, local.mtime):
			progress.update(func(p *documentsSyncProgress) { p.same++ })
			summary.Unchanged++
			continue
		case entry.SizeBytes == local.size:
			if same, err := sameDocumentsContent(ctx, t, path.Join(opts.dest, local.rel), local.path); err == nil && same {
				if err := documentsWrite(ctx, t, "/utimens", map[string]interface{}{"path": path.Join(opts.dest, local.rel), "mtime": local.mtime.UTC().Format(time.RFC3339Nano), "writer": writer}, nil); err != nil {
					logln("documents sync: could not set the modification time of", local.rel, err)
				}
				progress.update(func(p *documentsSyncProgress) { p.same++ })
				summary.Unchanged++
				continue
			}
		}
		uploads = append(uploads, local)
		total += local.size
	}
	for _, rel := range dirs {
		if entry, found := remote[rel]; found && entry.Kind != "FOLDER" {
			progress.fail(rel, "Drive has a file with this folder's name.")
		}
	}

	// The destination and every local folder Documents lacks, so empty folders come across too.
	if err := documentsWrite(ctx, t, "/mkdir", map[string]interface{}{"path": opts.dest, "parents": true, "writer": writer}, nil); err != nil {
		return summary, err
	}
	if folder, err := documentsStat(ctx, t, opts.dest); err == nil {
		summary.Link = documentLink(folder.ID)
		progress.update(func(p *documentsSyncProgress) { p.destEntryID = folder.ID })
	}
	for _, rel := range dirs {
		if _, found := remote[rel]; !found {
			if err := documentsWrite(ctx, t, "/mkdir", map[string]interface{}{"path": path.Join(opts.dest, rel), "parents": true, "writer": writer}, nil); err != nil {
				progress.fail(rel, documentsSyncReason(err))
			}
		}
	}

	count := len(uploads)
	progress.update(func(p *documentsSyncProgress) { p.status, p.total, p.bytesTotal = "UPLOADING", &count, &total })
	queue := make(chan documentsSyncLocal)
	var workers sync.WaitGroup
	var mu sync.Mutex
	for i := 0; i < documentsSyncWorkers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for local := range queue {
				reason := uploadDocumentsSyncFile(ctx, t, opts, writer, progress, local)
				if reason != "" && ctx.Err() != nil {
					// Stopped: a file cut off is not one that failed; the next sync sends it.
					continue
				}
				if reason != "" {
					progress.fail(local.rel, reason)
					continue
				}
				mu.Lock()
				summary.Uploaded++
				summary.Bytes += local.size
				mu.Unlock()
			}
		}()
	}
	for _, local := range uploads {
		if ctx.Err() != nil {
			break
		}
		queue <- local
	}
	close(queue)
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return documentsSyncFinish(summary, progress), err
	}

	if opts.deleteExtra {
		keep := map[string]bool{}
		for _, local := range files {
			keep[local.rel] = true
		}
		for _, rel := range append(dirs, skipped...) {
			keep[rel] = true
		}
		for _, rel := range documentsSyncExtras(remote, keep) {
			if err := documentsWrite(ctx, t, "/delete", map[string]interface{}{"path": path.Join(opts.dest, rel), "writer": writer}, nil); err != nil {
				progress.fail(rel, documentsSyncReason(err))
				continue
			}
			progress.update(func(p *documentsSyncProgress) { p.deleted++ })
			summary.Deleted++
		}
	}
	return documentsSyncFinish(summary, progress), nil
}

func documentsSyncFinish(summary documentsSyncSummary, progress *documentsSyncProgress) documentsSyncSummary {
	progress.mu.Lock()
	defer progress.mu.Unlock()
	summary.Failed = append([]documentsSyncFailure{}, progress.failed...)
	summary.FailedCount = progress.failedCount
	return summary
}

// documentsSyncExtras is what the destination holds that the directory does not, topmost first: a folder the directory
// lacks goes to Trash whole, as one group, and nothing under it is named on its own.
func documentsSyncExtras(remote map[string]documentsEntry, keep map[string]bool) []string {
	var rels []string
	for rel := range remote {
		if !keep[rel] {
			rels = append(rels, rel)
		}
	}
	sort.Strings(rels)
	var extras []string
	for _, rel := range rels {
		covered := false
		for _, top := range extras {
			if strings.HasPrefix(rel, top+"/") {
				covered = true
				break
			}
		}
		if !covered {
			extras = append(extras, rel)
		}
	}
	return extras
}

// uploadDocumentsSyncFile sends one file, and answers "" or why it did not go up. A transient failure is tried again, and a
// file that changes while it is read is read once more.
func uploadDocumentsSyncFile(ctx context.Context, t *Transport, opts documentsSyncOptions, writer documentsWriter, progress *documentsSyncProgress, local documentsSyncLocal) string {
	target := path.Join(opts.dest, local.rel)
	scope := newSessionFileScope(opts.sessionID)
	changedOnce := false
	for attempt := 1; ; attempt++ {
		counter := &documentsProgress{size: local.size}
		progress.update(func(p *documentsSyncProgress) { p.inFlight[local.rel], p.current = counter, local.rel })
		reason, transient, changed := func() (string, bool, bool) {
			file, info, err := scope.openRegular(local.path, false)
			if err != nil {
				return documentsSyncReason(err), false, false
			}
			defer file.Close()
			if _, _, err := sendDocumentsFile(ctx, t, file, target, writer, counter); err != nil {
				return documentsSyncReason(err), documentsSyncTransient(err), false
			}
			after, err := os.Stat(local.path)
			if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
				return documentsSyncChangedReason, false, true
			}
			mtime := info.ModTime().UTC().Format(time.RFC3339Nano)
			if err := documentsWrite(ctx, t, "/utimens", map[string]interface{}{"path": target, "mtime": mtime, "writer": writer}, nil); err != nil {
				logln("documents sync: could not set the modification time of", local.rel, err)
			}
			local.size = info.Size()
			return "", false, false
		}()
		progress.update(func(p *documentsSyncProgress) {
			delete(p.inFlight, local.rel)
			if reason == "" {
				p.done++
				p.bytesDone += local.size
			}
		})
		switch {
		case reason == "":
			return ""
		case ctx.Err() != nil:
			return "Stopped before it finished."
		case changed && !changedOnce:
			changedOnce = true
			continue
		case transient && attempt < documentsSyncFileAttempts:
			select {
			case <-ctx.Done():
				return "Stopped before it finished."
			case <-time.After(time.Duration(attempt) * time.Second):
			}
			continue
		}
		if transient {
			return fmt.Sprintf("Couldn't reach Orbit after %d tries: %s", documentsSyncFileAttempts, reason)
		}
		return reason
	}
}

// documentsSyncTransient is a failure worth trying again: no answer, or the server's own error.
func documentsSyncTransient(err error) bool {
	var refusal *transportHTTPError
	return !errors.As(err, &refusal) || refusal.statusCode >= http.StatusInternalServerError || refusal.statusCode == http.StatusTooManyRequests
}

// documentsSyncReason is a failure in the words the owner reads: the drive's own message when it gave one.
func documentsSyncReason(err error) string {
	var refused *localFileRefused
	if errors.As(err, &refused) {
		return "The file is " + refused.reason + "."
	}
	if failure := documentsDoorFailure(err); failure.Message != "" {
		return failure.Message
	}
	reason := err.Error()
	if len(reason) > 400 {
		reason = reason[:400]
	}
	return reason
}

// sameDocumentsMtime compares at the millisecond the drive keeps.
func sameDocumentsMtime(remote *string, local time.Time) bool {
	if remote == nil {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, *remote)
	return err == nil && at.UnixMilli() == local.UnixMilli()
}

// sameDocumentsContent compares a local file's 8 MiB chunks with the drive file's manifest, reading the file once.
func sameDocumentsContent(ctx context.Context, t *Transport, drivePath, localPath string) (bool, error) {
	var manifest struct {
		Chunks []documentsChunk `json:"chunks"`
	}
	if err := t.do(ctx, http.MethodGet, documentsPathQuery("/manifest", drivePath), nil, &manifest, documentsTimeout); err != nil {
		return false, err
	}
	file, err := os.Open(localPath)
	if err != nil {
		return false, err
	}
	defer file.Close()
	buf := make([]byte, documentsChunkSize)
	for i := 0; ; i++ {
		n, err := io.ReadFull(file, buf)
		if err == io.EOF {
			return i == len(manifest.Chunks), nil
		}
		if err != nil && err != io.ErrUnexpectedEOF {
			return false, err
		}
		if i >= len(manifest.Chunks) {
			return false, nil
		}
		digest := sha256.Sum256(buf[:n])
		want, _ := hex.DecodeString(manifest.Chunks[i].SHA256)
		if !bytes.Equal(digest[:], want) {
			return false, nil
		}
	}
}

// listDocumentsTree is every entry under a drive folder, by its path relative to the folder. A folder that does not exist
// yet holds nothing; a file there is refused.
func listDocumentsTree(ctx context.Context, t *Transport, dest string) (map[string]documentsEntry, error) {
	tree := map[string]documentsEntry{}
	root, err := documentsStat(ctx, t, dest)
	if isTransportHTTPStatus(err, http.StatusNotFound) {
		return tree, nil
	}
	if err != nil {
		return nil, err
	}
	if root.Kind != "FOLDER" {
		return nil, fmt.Errorf("%s is a file in Drive, not a folder", dest)
	}
	folders := []string{dest}
	for len(folders) > 0 {
		folder := folders[0]
		folders = folders[1:]
		cursor := ""
		for {
			query := url.Values{"path": {folder}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			var page struct {
				Entries    []documentsEntry `json:"entries"`
				NextCursor *string          `json:"nextCursor"`
			}
			if err := t.do(ctx, http.MethodGet, documentsRoute+"/list?"+query.Encode(), nil, &page, documentsTimeout); err != nil {
				return nil, err
			}
			for _, entry := range page.Entries {
				p := path.Join(folder, entry.Name)
				rel := strings.TrimPrefix(p, strings.TrimSuffix(dest, "/")+"/")
				tree[rel] = entry
				if entry.Kind == "FOLDER" {
					folders = append(folders, p)
				}
			}
			if page.NextCursor == nil || *page.NextCursor == "" {
				break
			}
			cursor = *page.NextCursor
		}
	}
	return tree, nil
}

// walkDocumentsSyncSource is the directory's regular files and folders, each by its path relative to it with / between
// parts. It follows no link (a link in a directory can name anything on this machine), skips .git, and holds each entry
// to the session's scope by itself. What it leaves out is returned too, so --delete keeps those names in Documents.
func walkDocumentsSyncSource(root string, scope localFileScope, progress *documentsSyncProgress) ([]documentsSyncLocal, []string, []string, error) {
	var files []documentsSyncLocal
	var dirs, skipped []string
	err := filepath.WalkDir(root, func(p string, entry fs.DirEntry, walkErr error) error {
		if p == root {
			return walkErr
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		switch {
		case walkErr != nil:
			progress.fail(rel, "Could not be read: "+walkErr.Error())
			skipped = append(skipped, rel)
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
		case entry.IsDir():
			if entry.Name() == ".git" || scope.refuses(p) != "" {
				skipped = append(skipped, rel)
				return filepath.SkipDir
			}
			dirs = append(dirs, rel)
		case !entry.Type().IsRegular():
			// A symbolic link, a socket or a device: the drive holds none of them.
			skipped = append(skipped, rel)
		default:
			info, err := entry.Info()
			if err != nil {
				progress.fail(rel, "Could not be read: "+err.Error())
				skipped = append(skipped, rel)
				return nil
			}
			if scope.refuses(realPath(p)) != "" {
				skipped = append(skipped, rel)
				return nil
			}
			files = append(files, documentsSyncLocal{rel: rel, path: p, size: info.Size(), mtime: info.ModTime()})
			progress.update(func(s *documentsSyncProgress) { s.seen++ })
		}
		return nil
	})
	return files, dirs, skipped, err
}

// startDocumentsSyncJob starts `orbit documents sync --wait` as this session's runner-hosted background job, which wakes
// the agent when it ends. The checks run first, here, so a bad path is this call's error. The sync's record is opened
// here too, before the job, so the answer names it (syncId) and the conversation draws the call as that sync's card; a
// server that cannot open it leaves the job to open its own, and the call draws as a plain tool call.
func startDocumentsSyncJob(t *Transport, sessionID, localPath, dest string, deleteExtra bool) (json.RawMessage, error) {
	source, err := documentsSyncSource(sessionID, localPath)
	if err != nil {
		return nil, err
	}
	dest, err = documentsSyncDest(dest, deleteExtra)
	if err != nil {
		return nil, err
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return nil, fmt.Errorf("%s: this session has no runner-hosted background job service, so documents_sync cannot run in "+
			"the background. Run `orbit documents sync --wait %s %s` in the foreground instead", bgTransportUnavailable, shellQuote(source), shellQuote(dest))
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	syncID := ""
	if t != nil {
		ctx, cancel := context.WithTimeout(context.Background(), documentsTimeout)
		syncID, err = openDocumentsSync(ctx, t, sessionID, source, dest)
		cancel()
		if err != nil {
			logln("documents sync: could not open its record before the job; the job opens its own:", err)
			syncID = ""
		}
	}
	command := strings.Join([]string{shellQuote(exe), "documents", "sync", "--wait", shellQuote(source), shellQuote(dest)}, " ")
	if deleteExtra {
		command += " --delete"
	}
	if syncID != "" {
		command += " --sync-id " + shellQuote(syncID)
	}
	raw, err := bgSocketCall(socket, token, "run", map[string]interface{}{
		"command": command, "kind": "job", "wakeOnExit": true,
		"description": fmt.Sprintf("Sync %s/ to Drive %s", filepath.Base(source), dest),
	})
	if err != nil {
		if syncID != "" {
			endDocumentsSync(t, syncID, "The background job did not start: "+err.Error())
		}
		return nil, fmt.Errorf("documents_sync: %w", err)
	}
	var job map[string]interface{}
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	if syncID != "" {
		job["syncId"] = syncID
	}
	job["note"] = "The sync runs in the background; the owner sees it in this conversation and in the Drive page's " +
		"upload tray. You are woken when it ends; its last output line is the summary. bg_output shows its progress and " +
		"bg_kill stops it."
	return json.Marshal(job)
}
