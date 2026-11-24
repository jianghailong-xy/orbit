package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSyncDocuments is an in-memory drive door, enough for one directory sync: entries by path, stagings, commits,
// utimens, delete, and the sync's progress reports.
type fakeSyncDocuments struct {
	t  *testing.T
	mu sync.Mutex

	entries  map[string]*fakeSyncEntry
	stagings map[string]map[int]string
	nextID   int

	commits, utimens int
	deleted          []string
	reports          []map[string]interface{}
	opened           map[string]interface{}
	// failChunk answers 503 to the chunk PUTs of a file whose path holds it, this many times (-1: always).
	failChunk      string
	failChunkTimes int
	// onChunk runs at each chunk PUT, before it is answered.
	onChunk func()
}

type fakeSyncEntry struct {
	id, kind, path string
	size           int64
	mtime          *string
	chunks         []documentsChunk
}

func newFakeSyncDocuments(t *testing.T) (*fakeSyncDocuments, *Transport) {
	d := &fakeSyncDocuments{t: t, entries: map[string]*fakeSyncEntry{"/": {id: "root", kind: "FOLDER", path: "/"}}, stagings: map[string]map[int]string{}}
	srv := newDriveTestServer(t, d.serve)
	return d, newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)
}

func (d *fakeSyncDocuments) id() string {
	d.nextID++
	return fmt.Sprintf("e%d", d.nextID)
}

func (d *fakeSyncDocuments) json(w http.ResponseWriter, v interface{}) {
	_ = json.NewEncoder(w).Encode(v)
}

func (e *fakeSyncEntry) view() map[string]interface{} {
	return map[string]interface{}{"id": e.id, "kind": e.kind, "name": path.Base(e.path), "path": e.path, "sizeBytes": e.size, "mtime": e.mtime}
}

func (d *fakeSyncDocuments) mkdir(p string) {
	for p != "/" {
		if _, ok := d.entries[p]; !ok {
			d.entries[p] = &fakeSyncEntry{id: d.id(), kind: "FOLDER", path: p}
		}
		p = path.Dir(p)
	}
}

func (d *fakeSyncDocuments) serve(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	route := strings.TrimPrefix(r.URL.Path, "/api/runner/documents")
	q := r.URL.Query()
	notFound := func() {
		w.WriteHeader(404)
		fmt.Fprint(w, `{"code":"DRIVE_ENTRY_NOT_FOUND","message":"No such entry."}`)
	}
	switch {
	case r.Method == "GET" && route == "/stat":
		if e, ok := d.entries[q.Get("path")]; ok {
			d.json(w, e.view())
			return
		}
		notFound()
	case r.Method == "GET" && route == "/list":
		var names []string
		for p := range d.entries {
			if p != "/" && path.Dir(p) == q.Get("path") {
				names = append(names, p)
			}
		}
		sort.Strings(names)
		// Two a page, so the sync has to follow the cursor.
		start := 0
		fmt.Sscanf(q.Get("cursor"), "%d", &start)
		page := map[string]interface{}{"entries": []interface{}{}, "nextCursor": nil}
		var entries []interface{}
		for i := start; i < len(names) && i < start+2; i++ {
			entries = append(entries, d.entries[names[i]].view())
		}
		if entries != nil {
			page["entries"] = entries
		}
		if start+2 < len(names) {
			page["nextCursor"] = fmt.Sprint(start + 2)
		}
		d.json(w, page)
	case r.Method == "GET" && route == "/manifest":
		e, ok := d.entries[q.Get("path")]
		if !ok {
			notFound()
			return
		}
		d.json(w, map[string]interface{}{"entryId": e.id, "sizeBytes": e.size, "chunks": e.chunks})
	case r.Method == "POST" && route == "/mkdir":
		body := driveTestBody(d.t, r)
		d.mkdir(body["path"].(string))
		d.json(w, d.entries[body["path"].(string)].view())
	case r.Method == "POST" && route == "/create":
		body := driveTestBody(d.t, r)
		p := body["path"].(string)
		e := &fakeSyncEntry{id: d.id(), kind: "FILE", path: p}
		d.entries[p] = e
		d.json(w, e.view())
	case r.Method == "POST" && route == "/stagings":
		body := driveTestBody(d.t, r)
		id := "s-" + body["entryId"].(string) + "-" + d.id()
		d.stagings[id] = map[int]string{}
		d.json(w, map[string]string{"id": id})
	case r.Method == "PUT" && strings.HasPrefix(route, "/stagings/"):
		data, _ := io.ReadAll(r.Body)
		if d.onChunk != nil {
			d.onChunk()
		}
		if d.failChunk != "" && d.failChunkTimes != 0 {
			for p, e := range d.entries {
				if strings.Contains(route, "-"+e.id+"-") && strings.Contains(p, d.failChunk) {
					d.failChunkTimes--
					w.WriteHeader(503)
					fmt.Fprint(w, `{"code":"UNAVAILABLE","message":"The store is busy."}`)
					return
				}
			}
		}
		parts := strings.Split(route, "/")
		var idx int
		fmt.Sscanf(parts[4], "%d", &idx)
		d.stagings[parts[2]][idx] = string(data)
		fmt.Fprint(w, `{}`)
	case r.Method == "POST" && route == "/commit":
		body := driveTestBody(d.t, r)
		d.commits++
		for _, e := range d.entries {
			if e.id == body["entryId"] {
				raw, _ := json.Marshal(body["chunks"])
				e.chunks = nil
				_ = json.Unmarshal(raw, &e.chunks)
				e.size = 0
				for _, c := range e.chunks {
					e.size += int64(c.Size)
				}
				e.mtime = nil
				d.json(w, map[string]interface{}{"entryId": e.id, "versionId": d.id(), "newVersion": true, "sizeBytes": e.size})
				return
			}
		}
		notFound()
	case r.Method == "POST" && route == "/utimens":
		body := driveTestBody(d.t, r)
		e, ok := d.entries[body["path"].(string)]
		if !ok {
			notFound()
			return
		}
		at, _ := time.Parse(time.RFC3339Nano, body["mtime"].(string))
		mtime := at.UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
		e.mtime = &mtime
		d.utimens++
		d.json(w, e.view())
	case r.Method == "POST" && route == "/delete":
		body := driveTestBody(d.t, r)
		p := body["path"].(string)
		d.deleted = append(d.deleted, p)
		for q := range d.entries {
			if q == p || strings.HasPrefix(q, p+"/") {
				delete(d.entries, q)
			}
		}
		fmt.Fprint(w, `{}`)
	case r.Method == "POST" && route == "/syncs":
		d.opened = driveTestBody(d.t, r)
		fmt.Fprint(w, `{"id":"sync-1"}`)
	case r.Method == "PATCH" && route == "/syncs/sync-1":
		d.reports = append(d.reports, driveTestBody(d.t, r))
		fmt.Fprint(w, `{"ok":true}`)
	default:
		d.t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}
}

// syncTestTree is a checkout with a small tree, the session's scope.
func syncTestTree(t *testing.T) string {
	t.Setenv("ORBIT_HOME", t.TempDir())
	checkout := t.TempDir()
	chdirForTest(t, checkout)
	out := filepath.Join(checkout, "out")
	writeTestFile(t, filepath.Join(out, "report.md"), "# Report\n")
	writeTestFile(t, filepath.Join(out, "charts", "q3.png"), strings.Repeat("p", documentsChunkSize+10))
	writeTestFile(t, filepath.Join(out, "data", "a.csv"), "a,b\n1,2\n")
	if err := os.MkdirAll(filepath.Join(out, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	return out
}

func runSyncForTest(t *testing.T, tr *Transport, source, dest string, deleteExtra bool) documentsSyncSummary {
	t.Helper()
	real, err := documentsSyncSource(fileTestSession, source)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := runDocumentsSync(context.Background(), tr, documentsSyncOptions{sessionID: fileTestSession, source: real, dest: dest, deleteExtra: deleteExtra})
	if err != nil {
		t.Fatal(err)
	}
	return summary
}

func TestDocumentsSyncCopiesOnceThenOnlyWhatChanged(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)

	first := runSyncForTest(t, tr, out, "/Reports/out", false)
	if first.Uploaded != 3 || first.Unchanged != 0 || first.FailedCount != 0 || first.Link == "" {
		t.Fatalf("first sync = %+v", first)
	}
	if d.commits != 3 || d.utimens != 3 {
		t.Fatalf("first sync: %d commits, %d utimens", d.commits, d.utimens)
	}
	for _, p := range []string{"/Reports/out/report.md", "/Reports/out/charts/q3.png", "/Reports/out/data/a.csv", "/Reports/out/empty"} {
		if _, ok := d.entries[p]; !ok {
			t.Errorf("%s was not made", p)
		}
	}
	if len(d.entries["/Reports/out/charts/q3.png"].chunks) != 2 {
		t.Errorf("a file over 8 MiB went up as %d chunks", len(d.entries["/Reports/out/charts/q3.png"].chunks))
	}
	// The tray was told: opened with the folder's name only, and ended DONE with the counts.
	if d.opened["sourceName"] != "out" || d.opened["destPath"] != "/Reports/out" {
		t.Errorf("opened = %v", d.opened)
	}
	last := d.reports[len(d.reports)-1]
	if last["status"] != "DONE" || last["filesDone"] != float64(3) || last["filesTotal"] != float64(3) || last["destEntryId"] == nil {
		t.Errorf("last report = %v", last)
	}

	// Nothing changed: nothing goes up.
	d.commits, d.utimens = 0, 0
	second := runSyncForTest(t, tr, out, "/Reports/out", false)
	if second.Uploaded != 0 || second.Unchanged != 3 || d.commits != 0 || d.utimens != 0 {
		t.Fatalf("second sync = %+v, %d commits, %d utimens", second, d.commits, d.utimens)
	}

	// Touched, same content: a utimens and no new version.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(out, "report.md"), later, later); err != nil {
		t.Fatal(err)
	}
	touched := runSyncForTest(t, tr, out, "/Reports/out", false)
	if touched.Uploaded != 0 || d.commits != 0 || d.utimens != 1 {
		t.Fatalf("touched sync = %+v, %d commits, %d utimens", touched, d.commits, d.utimens)
	}

	// One file edited: exactly one upload.
	writeTestFile(t, filepath.Join(out, "data", "a.csv"), "a,b\n1,3\n")
	edited := runSyncForTest(t, tr, out, "/Reports/out", false)
	if edited.Uploaded != 1 || d.commits != 1 {
		t.Fatalf("edited sync = %+v, %d commits", edited, d.commits)
	}
}

func TestDocumentsSyncDeleteSendsOnlyWhatTheDirectoryLacksToTrash(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)
	runSyncForTest(t, tr, out, "/Site/build", false)
	d.mkdir("/Site/other")
	if err := os.RemoveAll(filepath.Join(out, "data")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(out, "report.md")); err != nil {
		t.Fatal(err)
	}

	kept := runSyncForTest(t, tr, out, "/Site/build", false)
	if kept.Deleted != 0 || len(d.deleted) != 0 {
		t.Fatalf("without --delete: %+v, deleted %v", kept, d.deleted)
	}
	summary := runSyncForTest(t, tr, out, "/Site/build", true)
	sort.Strings(d.deleted)
	if summary.Deleted != 2 || !equalStrings(d.deleted, []string{"/Site/build/data", "/Site/build/report.md"}) {
		t.Fatalf("--delete: %+v, deleted %v", summary, d.deleted)
	}
	if _, ok := d.entries["/Site/other"]; !ok {
		t.Error("a folder outside the destination was touched")
	}
	if _, err := documentsSyncDest("/", true); err == nil {
		t.Error("--delete into the root was accepted")
	}
	if dest, err := documentsSyncDest("~/Files/Site", true); err != nil || dest != "/Site" {
		t.Errorf("documentsSyncDest = %q, %v", dest, err)
	}
}

func TestDocumentsSyncSkipsLinksAndGitAndRefusesPathsOutsideTheSession(t *testing.T) {
	out := syncTestTree(t)
	writeTestFile(t, filepath.Join(out, ".git", "HEAD"), "ref: main\n")
	outside := writeTestFile(t, filepath.Join(t.TempDir(), "secret.txt"), "secret")
	if err := os.Symlink(outside, filepath.Join(out, "link.txt")); err != nil {
		t.Fatal(err)
	}
	d, tr := newFakeSyncDocuments(t)
	summary := runSyncForTest(t, tr, out, "/R", true)
	if summary.Uploaded != 3 || summary.Skipped != 2 {
		t.Fatalf("summary = %+v", summary)
	}
	for p := range d.entries {
		if strings.Contains(p, ".git") || strings.Contains(p, "link.txt") {
			t.Errorf("%s was synced", p)
		}
	}

	if _, err := documentsSyncSource(fileTestSession, filepath.Dir(outside)); err == nil {
		t.Error("a directory outside the session was accepted")
	}
	if _, err := documentsSyncSource(fileTestSession, filepath.Join(out, "report.md")); err == nil || !strings.Contains(err.Error(), "documents_put") {
		t.Errorf("a file was accepted as a directory: %v", err)
	}
	fakeDriveMount(t, true)
	if _, err := documentsSyncSource(fileTestSession, driveHomePath); err == nil || !strings.Contains(err.Error(), "inside Documents") {
		t.Errorf("the drive's own mount was accepted: %v", err)
	}
}

func TestDocumentsSyncRetriesTransientFailuresAndGoesOnPastAFileThatFails(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)
	d.failChunk, d.failChunkTimes = "a.csv", 2
	summary := runSyncForTest(t, tr, out, "/R", false)
	if summary.Uploaded != 3 || summary.FailedCount != 0 {
		t.Fatalf("two transient failures were not retried: %+v", summary)
	}

	d2, tr2 := newFakeSyncDocuments(t)
	d2.failChunk, d2.failChunkTimes = "a.csv", -1
	summary = runSyncForTest(t, tr2, out, "/R", false)
	if summary.Uploaded != 2 || summary.FailedCount != 1 || summary.Failed[0].Path != "data/a.csv" ||
		!strings.Contains(summary.Failed[0].Error, "after 3 tries") {
		t.Fatalf("a failing file: %+v", summary)
	}
	last := d2.reports[len(d2.reports)-1]
	if last["status"] != "DONE" || last["failedCount"] != float64(1) {
		t.Errorf("last report = %v", last)
	}
}

func TestDocumentsSyncWithoutABackgroundServiceSaysHowToRunItInTheForeground(t *testing.T) {
	out := syncTestTree(t)
	t.Setenv(envBgSocket, "")
	t.Setenv(envBgToken, "")
	_, err := startDocumentsSyncJob(nil, fileTestSession, out, "/R", false)
	if err == nil || !strings.Contains(err.Error(), bgTransportUnavailable) || !strings.Contains(err.Error(), "--wait") {
		t.Fatalf("err = %v", err)
	}
	if _, err := startDocumentsSyncJob(nil, fileTestSession, out, "/", true); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("--delete into the root was not refused before the job: %v", err)
	}
}

func TestDocumentsSyncStoppedMidwayListsNoFailuresAndReportsStopped(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)
	ctx, cancel := context.WithCancel(context.Background())
	d.onChunk = cancel
	real, err := documentsSyncSource(fileTestSession, out)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := runDocumentsSync(ctx, tr, documentsSyncOptions{sessionID: fileTestSession, source: real, dest: "/R"})
	if err == nil {
		t.Fatal("a stopped sync answered no error")
	}
	if summary.FailedCount != 0 {
		t.Errorf("a stop listed files cut off as failures: %+v", summary.Failed)
	}
	last := d.reports[len(d.reports)-1]
	if last["status"] != "STOPPED" || last["failedCount"] != float64(0) {
		t.Errorf("last report = %v", last)
	}
}

func TestDocumentsSyncIsUnlistedAndRefusedWhileDocumentsIsOff(t *testing.T) {
	kept := withoutDriveTools([]map[string]interface{}{{"name": "documents_sync"}, {"name": "bg_run"}})
	if len(kept) != 1 || kept[0]["name"] != "bg_run" {
		t.Errorf("documents_sync was listed with Documents off: %v", kept)
	}
	s := &mcpServer{sessionID: fileTestSession, documentsOff: true}
	result, handled := s.callDocumentsTool("documents_sync", map[string]interface{}{"localPath": "out", "path": "/R"})
	if !handled || result["isError"] != true {
		t.Fatalf("documents_sync ran with Documents off: %v", result)
	}
}

// fakeBgRun answers the session socket's "run" with refuse, or with a job, recording the command it was asked to run.
func fakeBgRun(t *testing.T, refuse string) (commands *[]string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "bgsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	seen := &[]string{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			var req bgSocketRequest
			_ = json.NewDecoder(conn).Decode(&req)
			*seen = append(*seen, getString(req.Args, "command"))
			if refuse != "" {
				_ = json.NewEncoder(conn).Encode(map[string]interface{}{"ok": false, "error": refuse})
			} else {
				_ = json.NewEncoder(conn).Encode(map[string]interface{}{"ok": true, "result": map[string]string{"jobId": "bgj_1", "status": "running"}})
			}
			conn.Close()
		}
	}()
	t.Setenv(envBgSocket, path)
	t.Setenv(envBgToken, "tok")
	return seen
}

func TestDocumentsSyncCallOpensTheRecordFirstAndNamesIt(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)
	commands := fakeBgRun(t, "")
	raw, err := startDocumentsSyncJob(tr, fileTestSession, out, "/R", false)
	if err != nil {
		t.Fatal(err)
	}
	var answer map[string]interface{}
	if err := json.Unmarshal(raw, &answer); err != nil || answer["syncId"] != "sync-1" || answer["jobId"] != "bgj_1" {
		t.Fatalf("answer = %s, %v", raw, err)
	}
	if d.opened["destPath"] != "/R" || d.opened["sourceName"] != "out" {
		t.Errorf("opened = %v", d.opened)
	}
	if len(*commands) != 1 || !strings.Contains((*commands)[0], "--sync-id 'sync-1'") {
		t.Errorf("job command = %v", *commands)
	}

	// The job reports into the record it was handed, and opens no second one.
	d.opened = nil
	real, _ := documentsSyncSource(fileTestSession, out)
	if _, err := runDocumentsSync(context.Background(), tr, documentsSyncOptions{sessionID: fileTestSession, source: real, dest: "/R", syncID: "sync-1"}); err != nil {
		t.Fatal(err)
	}
	if d.opened != nil {
		t.Errorf("the job opened a second record: %v", d.opened)
	}
	if last := d.reports[len(d.reports)-1]; last["status"] != "DONE" {
		t.Errorf("last report = %v", last)
	}
}

func TestDocumentsSyncCallEndsTheRecordWhenTheJobDoesNotStart(t *testing.T) {
	out := syncTestTree(t)
	d, tr := newFakeSyncDocuments(t)
	fakeBgRun(t, "Not started. Plan mode.")
	if _, err := startDocumentsSyncJob(tr, fileTestSession, out, "/R", false); err == nil {
		t.Fatal("a refused job answered no error")
	}
	if len(d.reports) != 1 || d.reports[0]["status"] != "FAILED" || !strings.Contains(d.reports[0]["error"].(string), "Plan mode") {
		t.Errorf("reports = %v", d.reports)
	}
}
