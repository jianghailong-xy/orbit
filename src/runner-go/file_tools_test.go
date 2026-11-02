package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const fileTestSession = "session-1"

// fakeFile is one file the fake server keeps.
type fakeFile struct {
	id, name, mimeType, label, sha string
	kind                           string
	data                           []byte
}

// fakeFileServer answers the doors the file tools call, the way the apiserver does: the upload on the machine door,
// with a UUID id and a public id beside it, and the others speaking public ids. A route it is told not to have answers
// what Nest answers for a route it does not have.
type fakeFileServer struct {
	t      *testing.T
	mu     sync.Mutex
	files  map[string]*fakeFile
	next   int
	calls  []string
	fields []map[string]string
	bundle map[string]interface{}
	// refuse is what the server says of a file it finds a credential in, by the file's name.
	refuse map[string]string
	// Names of file parts as busboy would read them: the raw Content-Disposition.
	dispositions []string
	listQueries  []string
	listAnswer   string
	// corrupt turns the bytes the attachment route answers into others, as a store gone wrong would.
	corrupt bool
	// absent is a server from before these doors: every route but the attachments' answers Nest's 404.
	absent bool
	// report is what this server read out of an upload sent with `as`, and note what it says when it read nothing.
	report map[string]interface{}
	note   string
	*httptest.Server
}

func newFakeFileServer(t *testing.T) *fakeFileServer {
	t.Helper()
	f := &fakeFileServer{t: t, files: map[string]*fakeFile{}}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeFileServer) nestNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"message": "Cannot " + r.Method + " " + r.URL.RequestURI(), "error": "Not Found", "statusCode": 404,
	})
}

func (f *fakeFileServer) view(file *fakeFile) map[string]interface{} {
	return map[string]interface{}{
		"id": file.id, "publicId": file.id, "kind": file.kind, "name": file.name, "label": file.label,
		"mimeType": file.mimeType, "sizeBytes": len(file.data), "sha256": file.sha, "createdAt": "2026-11-02T00:00:00.000Z",
	}
}

func (f *fakeFileServer) keep(name, mimeType, label, kind string, data []byte) *fakeFile {
	f.next++
	sum := sha256.Sum256(data)
	file := &fakeFile{
		id: fmt.Sprintf("file%d", f.next), name: name, mimeType: mimeType, label: label, kind: kind,
		sha: hex.EncodeToString(sum[:]), data: data,
	}
	f.files[file.id] = file
	return file
}

var fileRoute = regexp.MustCompile(`^/api/runner/sessions/([^/]+)/(files|file-bundles|attachments)(?:/([^/]+))?$`)

func (f *fakeFileServer) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.Header.Get("authorization") != "Bearer runner-secret" {
		f.t.Errorf("%s %s came without the runner credential", r.Method, r.URL.Path)
	}
	if r.Header.Get(runnerCallerHeader) == "" {
		f.t.Errorf("%s %s does not name its caller, and would be refused 426 on a link-only server", r.Method, r.URL.Path)
	}
	w.Header().Set("content-type", "application/json")
	if r.URL.Path == "/api/runner/files" {
		if f.absent {
			f.nestNotFound(w, r)
			return
		}
		f.listQueries = append(f.listQueries, r.URL.RawQuery)
		_, _ = w.Write([]byte(f.listAnswer))
		return
	}
	m := fileRoute.FindStringSubmatch(r.URL.Path)
	if m == nil {
		f.t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
		return
	}
	door, id := m[2], m[3]
	if f.absent && door != "attachments" {
		f.nestNotFound(w, r)
		return
	}
	switch {
	case r.Method == http.MethodPost && door == "files":
		f.upload(w, r)
	case r.Method == http.MethodPost && door == "file-bundles":
		f.makeBundle(w, r)
	case r.Method == http.MethodGet && door == "files":
		file := f.files[id]
		if file == nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"file not found in this session","error":"Not Found","statusCode":404}`))
			return
		}
		_ = json.NewEncoder(w).Encode(f.view(file))
	case r.Method == http.MethodGet && door == "attachments":
		file := f.files[id]
		if file == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		data := file.data
		if f.corrupt {
			data = append([]byte("not the bytes "), data...)
		}
		_, _ = w.Write(data)
	default:
		f.t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
	}
}

func (f *fakeFileServer) upload(w http.ResponseWriter, r *http.Request) {
	_, params, err := mime.ParseMediaType(r.Header.Get("content-type"))
	if err != nil {
		f.t.Fatalf("content-type: %v", err)
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	fields := map[string]string{}
	var name, mimeType string
	var data []byte
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			f.t.Fatalf("multipart: %v", err)
		}
		body, _ := io.ReadAll(part)
		if part.FormName() != "file" {
			fields[part.FormName()] = string(body)
			continue
		}
		name, mimeType, data = part.FileName(), part.Header.Get("Content-Type"), body
		f.dispositions = append(f.dispositions, part.Header.Get("Content-Disposition"))
	}
	f.fields = append(f.fields, fields)
	if message, refused := f.refuse[name]; refused {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": "FILE_HOLDS_SECRET", "message": message})
		return
	}
	file := f.keep(name, mimeType, fields["label"], "file", data)
	w.WriteHeader(http.StatusCreated)
	view := f.view(file)
	view["id"] = "00000000-0000-7000-8000-" + fmt.Sprintf("%012d", f.next) // the machine door's own spelling
	view["testReport"] = nil
	if fields["as"] != "" {
		view["testReport"] = f.report
		if f.note != "" {
			view["note"] = f.note
		}
	}
	_ = json.NewEncoder(w).Encode(view)
}

func (f *fakeFileServer) makeBundle(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Label string `json:"label"`
		Files []struct {
			Path string `json:"path"`
			ID   string `json:"id"`
		} `json:"files"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		f.t.Fatalf("bundle body: %v", err)
	}
	manifest := fileBundleManifest{Kind: "orbit-file-bundle"}
	f.bundle = map[string]interface{}{"name": body.Name, "label": body.Label, "paths": []string{}}
	for _, entry := range body.Files {
		kept := f.files[entry.ID]
		if kept == nil {
			f.t.Fatalf("bundle names %q, which was not uploaded", entry.ID)
		}
		kept.name = entry.Path
		f.bundle["paths"] = append(f.bundle["paths"].([]string), entry.Path)
		manifest.Files = append(manifest.Files, fileBundleFile{
			Path: entry.Path, ID: entry.ID, SHA256: kept.sha, SizeBytes: int64(len(kept.data)), MimeType: kept.mimeType,
		})
	}
	data, _ := json.Marshal(manifest)
	file := f.keep(body.Name+".json", "application/vnd.orbit.file-bundle+json", body.Label, "bundle", data)
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(f.view(file))
}

func (f *fakeFileServer) mcp(t *testing.T) *mcpServer {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	chdirForTest(t, t.TempDir())
	return &mcpServer{t: newCallerTransport(f.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession}
}

// uploadTestAttachment opens a test's file and sends it, as a door does.
func uploadTestAttachment(t *Transport, sessionID, path, mimeType string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return t.uploadSessionAttachmentFile(context.Background(), sessionID, file, mimeType, filepath.Base(path))
}

// chdirForTest is t.Chdir, which go.mod's Go does not have.
func chdirForTest(t *testing.T, dir string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
}

// inCheckout is a new directory under the working directory, which is the session's checkout.
func inCheckout(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp(".", "fixture-")
	if err != nil {
		t.Fatal(err)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

// fileResult is a tool's answer, decoded; it fails the test on an error result.
func fileResult(t *testing.T, s *mcpServer, tool string, args map[string]interface{}) fileAnswer {
	t.Helper()
	var answer fileAnswer
	if err := json.Unmarshal([]byte(fileToolText(t, s, tool, args, false)), &answer); err != nil {
		t.Fatalf("%s answered what is not JSON: %v", tool, err)
	}
	return answer
}

func fileToolText(t *testing.T, s *mcpServer, tool string, args map[string]interface{}, wantError bool) string {
	t.Helper()
	result := s.callTool(tool, args)
	content, _ := result["content"].([]map[string]interface{})
	if len(content) != 1 {
		t.Fatalf("%s answered %#v", tool, result)
	}
	text, _ := content[0]["text"].(string)
	if result["isError"] != wantError {
		t.Fatalf("%s isError = %v, want %v: %s", tool, result["isError"], wantError, text)
	}
	return text
}

func writeTestFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestFileUploadKeepsOneFileAndSaysWhatItIs(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "report.json"), `{"ok":true}`)

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path, "taskId": "task-1", "label": "the run"})

	if got.ID != "file1" {
		t.Errorf("id = %q: an agent is shown the public id, not the machine door's UUID", got.ID)
	}
	if want := sha256Hex([]byte(`{"ok":true}`)); got.SHA256 != want {
		t.Errorf("sha256 = %q, want %q", got.SHA256, want)
	}
	if got.SizeBytes != 11 || got.Kind != "file" || got.Name != "report.json" || got.Label != "the run" {
		t.Errorf("answer = %+v", got)
	}
	if got.Link != "orbit-attachment:file1" {
		t.Errorf("link = %q", got.Link)
	}
	if want := []string{"POST /api/runner/sessions/session-1/files"}; !equalStrings(api.calls, want) {
		t.Errorf("calls = %v, want %v", api.calls, want)
	}
	if want := (map[string]string{"taskId": "task-1", "label": "the run"}); fmt.Sprint(api.fields[0]) != fmt.Sprint(want) {
		t.Errorf("fields sent = %v, want %v", api.fields[0], want)
	}
	if got.MimeType != "application/json" {
		t.Errorf("mimeType = %q", got.MimeType)
	}
}

func TestFileUploadAsATestReportAnswersWhatTheServerRead(t *testing.T) {
	api := newFakeFileServer(t)
	api.report = map[string]interface{}{"format": "playwright", "total": 3, "passed": 1, "failed": 1, "skipped": 1, "failedNames": []string{"a"}}
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "report.json"), `{"suites":[]}`)

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path, "as": "test-report"})

	if sent := api.fields[0]["as"]; sent != "test-report" {
		t.Errorf("as sent = %q", sent)
	}
	if got.TestReport["format"] != "playwright" || got.TestReport["failed"] != float64(1) {
		t.Errorf("testReport = %v", got.TestReport)
	}
	if got.Note != "" {
		t.Errorf("note = %q: a summary needs no explaining", got.Note)
	}
}

func TestFileUploadAsATestReportPassesOnWhyThereIsNoSummary(t *testing.T) {
	api := newFakeFileServer(t)
	api.note = "Not a Playwright JSON or JUnit XML report, so this was kept as a plain file, with no test summary."
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "notes.txt"), "all passed")

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path, "as": "test-report"})

	if got.Note != api.note || got.TestReport != nil || got.ID == "" {
		t.Errorf("answer = %+v", got)
	}
}

// A server from before `as` drops the field and answers as it always did. The file is kept, and an answer that said
// nothing would read as a summary that went missing.
func TestFileUploadAsATestReportOnAnOlderServerSaysSo(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "report.json"), `{"suites":[]}`)

	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path, "as": "test-report"}); got.Note != fileReportOldServerNote {
		t.Errorf("note = %q", got.Note)
	}
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path}); got.Note != "" {
		t.Errorf("an upload that asked for nothing owes no note: %q", got.Note)
	}
}

func TestFileUploadOfAFolderAsATestReportKeepsAPlainBundleAndSaysSo(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := filepath.Join(inCheckout(t), "results")
	writeTestFile(t, filepath.Join(root, "TEST-a.xml"), "<testsuite/>")

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": root, "as": "test-report"})

	if got.Kind != "bundle" || got.Note != fileReportFolderNote {
		t.Errorf("answer = %+v", got)
	}
	for _, sent := range api.fields {
		if sent["as"] != "" {
			t.Errorf("a file of the folder went as a report: %v", sent)
		}
	}
}

func TestFileUploadRefusesAnyOtherAsBeforeSendingAnything(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "report.json"), "{}")

	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": path, "as": "coverage"}, true)

	if !strings.Contains(text, `as can only be "test-report"`) {
		t.Errorf("refusal = %q", text)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

func TestFileListShowsAReportsSummaryAndNoEmptyOne(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	api.listAnswer = `{"files":[{"id":"file1","publicId":"file1","kind":"file","sha256":"aa","testReport":{"format":"junit","total":1}},{"id":"file2","publicId":"file2","kind":"file","sha256":"bb","testReport":null}],"truncated":false}`

	text := fileToolText(t, s, "file_list", map[string]interface{}{"sessionId": fileTestSession}, false)

	var got struct {
		Files []map[string]interface{} `json:"files"`
	}
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatalf("%v in %s", err, text)
	}
	if report, _ := got.Files[0]["testReport"].(map[string]interface{}); report["format"] != "junit" {
		t.Errorf("first row = %v", got.Files[0])
	}
	if _, present := got.Files[1]["testReport"]; present {
		t.Errorf("a file with no summary shows a null one: %v", got.Files[1])
	}
}

// busboy reads a plain filename as Latin-1, so a name in any other script goes out as RFC 5987 filename*.
func TestFileUploadSendsANameInAnyScriptAsFilenameStar(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "报告.txt"), "x")
	fileResult(t, s, "file_upload", map[string]interface{}{"path": path})
	if got := api.dispositions[0]; !strings.Contains(got, "filename*=utf-8''%E6%8A%A5%E5%91%8A.txt") || strings.Contains(got, `filename="`) {
		t.Errorf("Content-Disposition = %q", got)
	}
}

func TestFileUploadOfAFolderMakesOneBundle(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	outside := t.TempDir()
	secret := writeTestFile(t, filepath.Join(outside, "secret.env"), "TOKEN=hunter2")
	root := filepath.Join(inCheckout(t), "shots")
	writeTestFile(t, filepath.Join(root, "top.txt"), "top")
	writeTestFile(t, filepath.Join(root, "phone", "dark", "a.txt"), "dark a")
	writeTestFile(t, filepath.Join(root, "phone", "light", "a.txt"), "light a")
	writeTestFile(t, filepath.Join(root, "empty.log"), "")
	if err := os.Symlink(secret, filepath.Join(root, "link-to-secret")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link-to-dir")); err != nil {
		t.Fatal(err)
	}

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": root, "label": "viewports"})

	if got.Kind != "bundle" || got.ID == "" || got.SHA256 == "" || got.SizeBytes == 0 || got.Link != "orbit-attachment:"+got.ID {
		t.Errorf("the bundle = %+v", got)
	}
	wantPaths := []string{"phone/dark/a.txt", "phone/light/a.txt", "top.txt"}
	var paths []string
	for _, file := range got.Files {
		paths = append(paths, file.Path)
		if file.ID == "" || file.SHA256 == "" || file.SizeBytes == 0 || file.Link != "orbit-attachment:"+file.ID {
			t.Errorf("file %+v does not say what it is", file)
		}
	}
	if !equalStrings(paths, wantPaths) {
		t.Errorf("files = %v, want %v", paths, wantPaths)
	}
	if !equalStrings(api.bundle["paths"].([]string), wantPaths) {
		t.Errorf("the manifest was asked for %v", api.bundle["paths"])
	}
	if api.bundle["name"] != "shots" || api.bundle["label"] != "viewports" {
		t.Errorf("the bundle was asked to be %v", api.bundle)
	}
	for _, fields := range api.fields {
		if fields["label"] != "" {
			t.Errorf("the label is the bundle's, and went out with a file too: %v", fields)
		}
	}
	reasons := map[string]string{}
	for _, entry := range got.Skipped {
		reasons[entry.Path] = entry.Reason
	}
	if want := []string{"empty.log", "link-to-dir", "link-to-secret"}; !equalStrings(sortedSkipped(got.Skipped), want) {
		t.Errorf("skipped = %v, want %v", got.Skipped, want)
	}
	if !strings.Contains(reasons["link-to-secret"], "symbolic link") || !strings.Contains(reasons["empty.log"], "empty") {
		t.Errorf("skipped does not say why: %v", reasons)
	}
	for _, kept := range api.files {
		if bytes.Contains(kept.data, []byte("hunter2")) {
			t.Fatalf("a file outside the folder was uploaded through a link in it: %s", kept.name)
		}
	}
}

func sortedSkipped(skipped []skippedFile) []string {
	paths := []string{}
	for _, entry := range skipped {
		paths = append(paths, entry.Path)
	}
	sort.Strings(paths)
	return paths
}

// The directory a caller names may be a link; a link inside it is another matter.
func TestFileUploadFollowsALinkNamedAsTheFolderItself(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := filepath.Join(inCheckout(t), "real")
	writeTestFile(t, filepath.Join(root, "a.txt"), "a")
	link := filepath.Join(inCheckout(t), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": link})
	if got.Kind != "bundle" || len(got.Files) != 1 || api.bundle["name"] != "real" {
		t.Errorf("answer = %+v, bundle = %v", got, api.bundle)
	}
}

func TestFileUploadRefusesAFolderOverTheFileLimitBeforeSendingAnything(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	for i := 0; i <= fileBundleMaxFiles; i++ {
		if err := os.WriteFile(filepath.Join(root, strconv.Itoa(i)+".txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, true)
	if !strings.Contains(text, fmt.Sprintf("more than %d files", fileBundleMaxFiles)) {
		t.Errorf("error = %q", text)
	}
	if len(api.calls) != 0 {
		t.Errorf("a refused folder sent %v", api.calls)
	}
}

// The limit is on what the walk meets, so that a directory of links is not listed in full either.
func TestWalkFolderStopsAtTheLimitWithoutReadingTheRest(t *testing.T) {
	root := t.TempDir()
	for i := 0; i <= fileBundleMaxFiles+50; i++ {
		if err := os.Symlink("/nowhere", filepath.Join(root, fmt.Sprintf("%05d", i))); err != nil {
			t.Fatal(err)
		}
	}
	files, skipped, err := walkFolder(root, localFileScope{roots: []string{root}})
	if err == nil || !strings.Contains(err.Error(), "more than") {
		t.Fatalf("err = %v", err)
	}
	if len(files)+len(skipped) != fileBundleMaxFiles+1 {
		t.Errorf("walked %d entries, and should have stopped at %d", len(files)+len(skipped), fileBundleMaxFiles+1)
	}
}

func TestFileUploadRefusesAFolderWithAFileTooLargeBeforeSendingAnything(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "a.txt"), "small")
	big, err := os.Create(filepath.Join(root, "z.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := big.Truncate(maxSessionAttachmentBytes + 1); err != nil {
		t.Fatal(err)
	}
	big.Close()
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, true)
	if !strings.Contains(text, "z.bin") || !strings.Contains(text, "25 MiB") {
		t.Errorf("error = %q", text)
	}
	if len(api.calls) != 0 {
		t.Errorf("a refused folder sent %v", api.calls)
	}
}

func TestFileUploadRefusesWhatCannotBeKept(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	dir := inCheckout(t)
	empty := writeTestFile(t, filepath.Join(dir, "empty.txt"), "")
	for name, args := range map[string]map[string]interface{}{
		"no path":      {},
		"nothing here": {"path": filepath.Join(dir, "missing.txt")},
		"empty file":   {"path": empty},
	} {
		t.Run(name, func(t *testing.T) { fileToolText(t, s, "file_upload", args, true) })
	}
	if text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": writeOnlyEmptyFolder(t)}, true); !strings.Contains(text, "no file that can be kept") {
		t.Errorf("a folder with nothing to keep: %q", text)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

func writeOnlyEmptyFolder(t *testing.T) string {
	t.Helper()
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "empty.txt"), "")
	return root
}

// A file refused part way through a folder names the file, says how far it got, and leaves no bundle.
func TestFileUploadOfAFolderStopsAtTheFirstRefusal(t *testing.T) {
	calls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("content-type", "application/json")
		if calls == 2 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":"taskId has to be the task this session is running","statusCode":400}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"f1","publicId":"f1","kind":"file","sha256":"aa","sizeBytes":1}`))
	}))
	defer api.Close()
	t.Setenv("ORBIT_HOME", t.TempDir())
	s := &mcpServer{t: newCallerTransport(api.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession}
	chdirForTest(t, t.TempDir())
	root := inCheckout(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		writeTestFile(t, filepath.Join(root, name), "x")
	}
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root, "taskId": "other"}, true)
	for _, want := range []string{"b.txt", "1 of 3 files", "no bundle", "taskId has to be the task"} {
		if !strings.Contains(text, want) {
			t.Errorf("error does not say %q: %s", want, text)
		}
	}
	if calls != 2 {
		t.Errorf("%d calls: the folder should have stopped at the refusal", calls)
	}
}

// secretRefusalFor is the sentence the apiserver refuses name with (files/file-secret-scan.ts).
func secretRefusalFor(name string) string {
	return name + " holds what looks like a GitHub token on line 2, so it was not kept. Orbit does not edit a file it " +
		"keeps: take the credential out of the file and upload it again. Do not commit the file instead."
}

// A file refused for a credential is that file's problem: the folder goes on without it, the bundle names the rest, and
// the answer says which file and why, in the server's words.
func TestFileUploadOfAFolderListsAFileRefusedForASecretAndKeepsTheRest(t *testing.T) {
	api := newFakeFileServer(t)
	api.refuse = map[string]string{"run.log": secretRefusalFor("run.log")}
	s := api.mcp(t)
	root := filepath.Join(inCheckout(t), "evidence")
	writeTestFile(t, filepath.Join(root, "a.txt"), "first")
	writeTestFile(t, filepath.Join(root, "logs", "run.log"), "one\nthe key is sensitive-bytes-of-the-file\n")
	writeTestFile(t, filepath.Join(root, "z.txt"), "last")

	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, false)

	var got fileAnswer
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatal(err)
	}
	if got.Kind != "bundle" {
		t.Errorf("the answer = %+v", got)
	}
	want := []string{"a.txt", "z.txt"}
	var paths []string
	for _, file := range got.Files {
		paths = append(paths, file.Path)
	}
	if !equalStrings(paths, want) {
		t.Errorf("files = %v, want %v", paths, want)
	}
	if !equalStrings(api.bundle["paths"].([]string), want) {
		t.Errorf("the manifest was asked for %v", api.bundle["paths"])
	}
	if len(got.Skipped) != 1 || got.Skipped[0].Path != "logs/run.log" || got.Skipped[0].Reason != secretRefusalFor("run.log") {
		t.Errorf("skipped = %+v", got.Skipped)
	}
	for _, kept := range api.files {
		if kept.name == "run.log" || kept.name == "logs/run.log" {
			t.Errorf("the refused file was kept: %+v", kept)
		}
	}
	if strings.Contains(text, "sensitive-bytes-of-the-file") {
		t.Errorf("the answer repeats what the file holds: %s", text)
	}
}

// Nothing left to bundle ends the way any other folder with nothing to keep does, and makes no bundle.
func TestFileUploadOfAFolderOfOnlyRefusedFilesSaysNoFileCouldBeKept(t *testing.T) {
	api := newFakeFileServer(t)
	api.refuse = map[string]string{"a.log": secretRefusalFor("a.log"), "b.log": secretRefusalFor("b.log")}
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "a.log"), "sensitive-bytes-of-the-file")
	writeTestFile(t, filepath.Join(root, "b.log"), "sensitive-bytes-of-the-file")

	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, true)

	for _, want := range []string{"no file of this folder could be kept", "a.log", "b.log", "a GitHub token on line 2"} {
		if !strings.Contains(text, want) {
			t.Errorf("error does not say %q: %s", want, text)
		}
	}
	if strings.Contains(text, "sensitive-bytes-of-the-file") {
		t.Errorf("the error repeats what the file holds: %s", text)
	}
	for _, call := range api.calls {
		if strings.HasSuffix(call, "/file-bundles") {
			t.Errorf("a bundle of nothing was asked for: %v", api.calls)
		}
	}
}

// One file has no folder to go on with: the refusal is the answer.
func TestFileUploadOfOneFileRefusedForASecretSaysWhy(t *testing.T) {
	api := newFakeFileServer(t)
	api.refuse = map[string]string{"run.log": secretRefusalFor("run.log")}
	s := api.mcp(t)
	path := writeTestFile(t, filepath.Join(inCheckout(t), "run.log"), "sensitive-bytes-of-the-file")

	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": path}, true)

	if !strings.Contains(text, "FILE_HOLDS_SECRET") || !strings.Contains(text, secretRefusalFor("run.log")) {
		t.Errorf("error = %s", text)
	}
	if strings.Contains(text, "sensitive-bytes-of-the-file") {
		t.Errorf("the error repeats what the file holds: %s", text)
	}
}

// Only the code says a refusal is about one file. The same status, any other code, or none, stops the folder as it did.
func TestFileUploadOfAFolderStopsAtAnyOtherRefusalWhateverItsStatus(t *testing.T) {
	for _, body := range []string{
		`{"code":"SOMETHING_ELSE","message":"not about one file","statusCode":422}`,
		`{"message":"not about one file","statusCode":422}`,
		`not json at all`,
	} {
		calls := 0
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("content-type", "application/json")
			if calls == 2 {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(body))
				return
			}
			_, _ = w.Write([]byte(`{"id":"f1","publicId":"f1","kind":"file","sha256":"aa","sizeBytes":1}`))
		}))
		t.Setenv("ORBIT_HOME", t.TempDir())
		s := &mcpServer{t: newCallerTransport(api.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession}
		chdirForTest(t, t.TempDir())
		root := inCheckout(t)
		for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
			writeTestFile(t, filepath.Join(root, name), "x")
		}
		text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, true)
		for _, want := range []string{"b.txt", "1 of 3 files", "no bundle"} {
			if !strings.Contains(text, want) {
				t.Errorf("%s: error does not say %q: %s", body, want, text)
			}
		}
		if calls != 2 {
			t.Errorf("%s: %d calls: the folder should have stopped at the refusal", body, calls)
		}
		api.Close()
	}
}

func TestFileFetchSavesEachFileInTheUploadsDirectory(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	content := map[string]string{"dark/a.txt": "dark bytes", "light/a.txt": "light bytes", "top.bin": "\x00\x01\xff top"}
	for rel, data := range content {
		writeTestFile(t, filepath.Join(root, rel), data)
	}
	bundle := fileResult(t, s, "file_upload", map[string]interface{}{"path": root})

	seen := map[string]bool{}
	for _, file := range bundle.Files {
		got := fileResult(t, s, "file_fetch", map[string]interface{}{"id": file.ID})
		if !filepath.IsAbs(got.Path) || !strings.HasPrefix(got.Path, uploadsDir(fileTestSession)+string(filepath.Separator)) {
			t.Fatalf("%s was saved at %q, not under this session's uploads directory %q", file.Path, got.Path, uploadsDir(fileTestSession))
		}
		data, err := os.ReadFile(got.Path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != content[file.Path] {
			t.Errorf("%s read back as %q", file.Path, data)
		}
		if got.SHA256 != file.SHA256 || got.SHA256 != sha256Hex(data) {
			t.Errorf("%s: sha256 %s, uploaded as %s, bytes hash to %s", file.Path, got.SHA256, file.SHA256, sha256Hex(data))
		}
		if got.SizeBytes != int64(len(data)) || got.Link != "orbit-attachment:"+file.ID {
			t.Errorf("%s answered %+v", file.Path, got)
		}
		if seen[got.Path] {
			t.Errorf("two files of the folder were saved at %s", got.Path)
		}
		seen[got.Path] = true
	}
	if len(seen) != len(content) {
		t.Errorf("fetched %d files of %d", len(seen), len(content))
	}
}

func TestFileFetchKeepsAHostileNameInsideTheUploadsDirectory(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	for _, name := range []string{"../../../escape.txt", "/etc/passwd", "..", ""} {
		file := api.keep(name, "text/plain", "", "file", []byte("x"))
		got := fileResult(t, s, "file_fetch", map[string]interface{}{"id": file.id})
		if !strings.HasPrefix(got.Path, filepath.Join(uploadsDir(fileTestSession), "files", file.id)+string(filepath.Separator)) {
			t.Errorf("name %q was saved at %q", name, got.Path)
		}
	}
}

func TestFileFetchRefusesAnIDThatIsNotOneSegment(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	for _, id := range []string{"", "..", "a/b"} {
		fileToolText(t, s, "file_fetch", map[string]interface{}{"id": id}, true)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

func TestFileFetchSavesNothingWhenTheBytesAreNotTheOnesOrbitHolds(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	file := api.keep("a.txt", "text/plain", "", "file", []byte("the bytes"))
	api.corrupt = true
	text := fileToolText(t, s, "file_fetch", map[string]interface{}{"id": file.id}, true)
	if !strings.Contains(text, "nothing was saved") {
		t.Errorf("error = %q", text)
	}
	dir := filepath.Join(uploadsDir(fileTestSession), "files", file.id)
	if entries, err := os.ReadDir(dir); err == nil && len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

// A row from before Orbit Files has no sha256 yet: its bytes are still read, and hashed here.
func TestFileFetchHashesARowWithNoSha256(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	file := api.keep("old.txt", "text/plain", "", "file", []byte("old bytes"))
	file.sha = ""
	got := fileResult(t, s, "file_fetch", map[string]interface{}{"id": file.id})
	if got.SHA256 != sha256Hex([]byte("old bytes")) {
		t.Errorf("sha256 = %q", got.SHA256)
	}
}

func TestFileFetchOfABundleSavesItsManifestAndListsItsFiles(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "dir", "a.txt"), "a")
	writeTestFile(t, filepath.Join(root, "b.txt"), "b")
	bundle := fileResult(t, s, "file_upload", map[string]interface{}{"path": root})
	api.calls = nil

	got := fileResult(t, s, "file_fetch", map[string]interface{}{"id": bundle.ID})

	if got.Kind != "bundle" || got.SHA256 != bundle.SHA256 {
		t.Errorf("answer = %+v", got)
	}
	if len(got.Files) != 2 {
		t.Fatalf("files = %+v", got.Files)
	}
	for _, file := range got.Files {
		if file.Link != "orbit-attachment:"+file.ID || file.SHA256 == "" {
			t.Errorf("file = %+v", file)
		}
	}
	if _, err := os.Stat(got.Path); err != nil {
		t.Errorf("the manifest was not saved: %v", err)
	}
	for _, call := range api.calls {
		for _, file := range got.Files {
			if strings.HasSuffix(call, "/"+file.ID) {
				t.Errorf("fetching a bundle read one of its files: %s", call)
			}
		}
	}
}

// A file the door does not find is a file not found: an old server is another answer.
func TestFileFetchOfAMissingFileSaysSoAndNotThatTheServerIsOld(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	text := fileToolText(t, s, "file_fetch", map[string]interface{}{"id": "gone"}, true)
	if !strings.Contains(text, "file not found in this session") || strings.Contains(text, "no file door") {
		t.Errorf("error = %q", text)
	}
}

func TestFileListAsksForOneScopeAndLinksWhatItFinds(t *testing.T) {
	api := newFakeFileServer(t)
	api.listAnswer = `{"files":[
		{"id":"f2","publicId":"f2","kind":"bundle","name":"shots.json","mimeType":"application/vnd.orbit.file-bundle+json","sizeBytes":99,"sha256":"bb"},
		{"id":"f1","publicId":"f1","kind":"file","name":"a.png","mimeType":"image/png","sizeBytes":5,"sha256":"aa"}
	],"truncated":false}`
	s := api.mcp(t)
	text := fileToolText(t, s, "file_list", map[string]interface{}{}, false)
	var got struct {
		Files []fileAnswer `json:"files"`
		Note  string       `json:"note"`
	}
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[0].Kind != "bundle" || got.Files[1].Link != "orbit-attachment:f1" || got.Files[1].SHA256 != "aa" {
		t.Errorf("files = %+v", got.Files)
	}
	if got.Note != "" {
		t.Errorf("note = %q on a whole list", got.Note)
	}
	for args, want := range map[string]map[string]interface{}{
		"taskId=t-1":     {"taskId": "t-1"},
		"sessionId=s-2":  {"sessionId": "s-2"},
		"evidenceId=e-3": {"evidenceId": "e-3"},
	} {
		fileToolText(t, s, "file_list", want, false)
		if last := api.listQueries[len(api.listQueries)-1]; last != args {
			t.Errorf("query = %q, want %q", last, args)
		}
	}
	if api.listQueries[0] != "sessionId="+fileTestSession {
		t.Errorf("with no scope it asked %q, not for this session", api.listQueries[0])
	}
}

func TestFileListSaysWhenItStoppedShort(t *testing.T) {
	api := newFakeFileServer(t)
	api.listAnswer = `{"files":[{"id":"f1","publicId":"f1","kind":"file"}],"truncated":true}`
	s := api.mcp(t)
	if text := fileToolText(t, s, "file_list", map[string]interface{}{"taskId": "t-1"}, false); !strings.Contains(text, "there are more") {
		t.Errorf("answer = %s", text)
	}
}

// A newer binary on an older control plane: each tool says so, in words, rather than crashing, reading like a wrong id,
// or succeeding at nothing.
func TestFileToolsOnAnOlderServerSayItHasNoDoor(t *testing.T) {
	api := newFakeFileServer(t)
	api.absent = true
	s := api.mcp(t)
	file := writeTestFile(t, filepath.Join(inCheckout(t), "a.txt"), "x")
	folder := inCheckout(t)
	writeTestFile(t, filepath.Join(folder, "b.txt"), "x")
	for name, call := range map[string]struct {
		tool string
		args map[string]interface{}
	}{
		"upload a file":   {"file_upload", map[string]interface{}{"path": file}},
		"upload a folder": {"file_upload", map[string]interface{}{"path": folder}},
		"fetch":           {"file_fetch", map[string]interface{}{"id": "file1"}},
		"list":            {"file_list", map[string]interface{}{}},
		"list a task":     {"file_list", map[string]interface{}{"taskId": "t-1"}},
	} {
		t.Run(name, func(t *testing.T) {
			text := fileToolText(t, s, call.tool, call.args, true)
			for _, want := range []string{"this Orbit server has no file door for agents yet", "404", "Upgrade the Orbit server"} {
				if !strings.Contains(text, want) {
					t.Errorf("error does not say %q: %s", want, text)
				}
			}
		})
	}
}

func TestFileUploadAndFetchNeedASession(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	s.sessionID = ""
	path := writeTestFile(t, filepath.Join(t.TempDir(), "a.txt"), "x")
	for tool, args := range map[string]map[string]interface{}{
		"file_upload": {"path": path},
		"file_fetch":  {"id": "file1"},
		"file_list":   {},
	} {
		if text := fileToolText(t, s, tool, args, true); !strings.Contains(text, "ORBIT_SESSION_ID") {
			t.Errorf("%s: %q", tool, text)
		}
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

func TestFileCLIUploadsAsATestReport(t *testing.T) {
	api := newFakeFileServer(t)
	api.report = map[string]interface{}{"format": "junit", "total": 1}
	configureCLITestRunner(t, api.URL)
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	chdirForTest(t, t.TempDir())
	path := writeTestFile(t, filepath.Join(inCheckout(t), "junit.xml"), "<testsuite/>")

	var out bytes.Buffer
	if err := cmdFileCLI([]string{"upload", path, "--as", "test-report", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	var uploaded fileAnswer
	if err := json.Unmarshal(out.Bytes(), &uploaded); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if api.fields[0]["as"] != "test-report" || uploaded.TestReport["format"] != "junit" {
		t.Errorf("sent %v, answered %+v", api.fields[0], uploaded)
	}
}

func TestFileCLIUploadsFetchesAndLists(t *testing.T) {
	api := newFakeFileServer(t)
	api.listAnswer = `{"files":[{"id":"file1","publicId":"file1","kind":"file","sha256":"aa"}],"truncated":false}`
	configureCLITestRunner(t, api.URL)
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	chdirForTest(t, t.TempDir())
	path := writeTestFile(t, filepath.Join(inCheckout(t), "a.txt"), "cli bytes")

	var out bytes.Buffer
	// The path may come before or after the flags.
	if err := cmdFileCLI([]string{"upload", path, "--task-id", "task-1", "--label", "by hand", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	var uploaded fileAnswer
	if err := json.Unmarshal(out.Bytes(), &uploaded); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if uploaded.Link != "orbit-attachment:file1" || uploaded.SHA256 != sha256Hex([]byte("cli bytes")) {
		t.Errorf("upload answered %+v", uploaded)
	}
	if api.fields[0]["taskId"] != "task-1" || api.fields[0]["label"] != "by hand" {
		t.Errorf("fields = %v", api.fields[0])
	}

	out.Reset()
	if err := cmdFileCLI([]string{"fetch", "--json", "file1"}, &out); err != nil {
		t.Fatal(err)
	}
	var fetched fileAnswer
	if err := json.Unmarshal(out.Bytes(), &fetched); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(fetched.Path); err != nil || string(data) != "cli bytes" {
		t.Errorf("fetched %q to %q: %v", data, fetched.Path, err)
	}

	out.Reset()
	if err := cmdFileCLI([]string{"list", "--task-id", "task-1"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "orbit-attachment:file1") || api.listQueries[0] != "taskId=task-1" {
		t.Errorf("list printed %s for %v", out.String(), api.listQueries)
	}
}

func TestFileCLISaysWhatIsWrong(t *testing.T) {
	api := newFakeFileServer(t)
	api.absent = true
	configureCLITestRunner(t, api.URL)
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	var out bytes.Buffer
	if err := cmdFileCLI([]string{"list"}, &out); err == nil || !strings.Contains(err.Error(), "no file door") {
		t.Errorf("list on an older server: %v", err)
	}
	for _, args := range [][]string{{"upload"}, {"fetch"}, {"upload", "a", "b"}, {"list", "extra"}, {"nonsense"}} {
		if err := cmdFileCLI(args, &out); err == nil {
			t.Errorf("orbit file %v went through", args)
		}
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	if err := cmdFileCLI([]string{"fetch", "file1"}, &out); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Errorf("fetch outside a session: %v", err)
	}
}

func TestFileHelpIsReachable(t *testing.T) {
	for _, args := range [][]string{{}, {"--help"}, {"help"}, {"help", "upload"}, {"upload", "--help"}, {"fetch", "-h"}, {"list", "--help"}} {
		var out bytes.Buffer
		if err := cmdFileCLI(args, &out); err != nil {
			t.Fatalf("orbit file %v: %v", args, err)
		}
		if !strings.Contains(out.String(), "orbit file") {
			t.Errorf("orbit file %v printed %q", args, out.String())
		}
	}
	if !ownsLeafHelp("file") {
		t.Error("`orbit file upload --help` would print the overview instead of its own help")
	}
}

func TestCapabilitiesListTheFileCommands(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "")
	has := func(doc cliCapabilitiesDocument) map[string]cliCapability {
		found := map[string]cliCapability{}
		for _, capability := range doc.Capabilities {
			if strings.HasPrefix(capability.ID, "file_") {
				found[capability.ID] = capability
			}
		}
		return found
	}
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	inside := has(buildCLICapabilities("/usr/local/bin/orbit"))
	if len(inside) != 3 {
		t.Fatalf("inside a session: %v", inside)
	}
	for tool, argv := range map[string]string{
		"file_upload": "/usr/local/bin/orbit file upload",
		"file_fetch":  "/usr/local/bin/orbit file fetch",
		"file_list":   "/usr/local/bin/orbit file list",
	} {
		if got := strings.Join(inside[tool].Argv, " "); got != argv {
			t.Errorf("%s argv = %q, want %q", tool, got, argv)
		}
		if inside[tool].Description == "" || inside[tool].MCPInputSchema == nil {
			t.Errorf("%s carries no description or schema: %+v", tool, inside[tool])
		}
	}
	if !inside["file_upload"].Mutates || inside["file_fetch"].Mutates || inside["file_list"].Mutates {
		t.Errorf("only an upload changes anything in Orbit: %+v", inside)
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	outside := has(buildCLICapabilities("/usr/local/bin/orbit"))
	if _, listed := outside["file_list"]; !listed || len(outside) != 1 {
		t.Errorf("outside a session only list has anything to act on: %v", outside)
	}
}

func TestFileToolsAreServedOverMCP(t *testing.T) {
	names := map[string]bool{}
	for _, descriptor := range toolDescriptors(false, false) {
		name, _ := descriptor["name"].(string)
		names[name] = true
		if !fileToolNames[name] {
			continue
		}
		text := fmt.Sprint(descriptor["description"])
		if strings.Contains(strings.ToLower(text), "artifact") {
			t.Errorf("%s says artifact: the name is file_*", name)
		}
		for i := 0; i < len(text); i++ {
			if text[i] > 127 {
				t.Errorf("%s description byte %d is not ASCII", name, i)
				break
			}
		}
	}
	for name := range fileToolNames {
		if !names[name] {
			t.Errorf("%s is not listed", name)
		}
	}
}

func TestLinkModeDoesNotTakeTheFileToolsAgentRoutes(t *testing.T) {
	// The upload is a daemon-listed route like the attachments', which still never passes doVia. The rest are the
	// agent tool API: not the daemon's, so never sent over the link.
	if _, ok := linkDaemonRoute("POST", "/runner/sessions/abc/files"); !ok {
		t.Error("the upload is the controller's, so it is on the list")
	}
	for _, call := range []string{"GET /runner/files?taskId=t", "GET /runner/sessions/abc/files/f", "POST /runner/sessions/abc/file-bundles"} {
		method, path, _ := strings.Cut(call, " ")
		if route, ok := linkDaemonRoute(method, path); ok {
			t.Errorf("%s matched the daemon route %s", call, route)
		}
	}
}

// A host as a session finds it: a home with Orbit's directory and an SSH key in it, and a checkout that is a repository
// of its own, which is where the working directory is.
type fileScopeHost struct {
	home, orbit, config, key, checkout string
}

func newFileScopeHost(t *testing.T) fileScopeHost {
	t.Helper()
	home := realPath(t.TempDir())
	t.Setenv("HOME", home)
	host := fileScopeHost{
		home: home, orbit: filepath.Join(home, ".orbit"), checkout: realPath(t.TempDir()),
		config: filepath.Join(home, ".orbit", "config.json"), key: filepath.Join(home, ".ssh", "id_rsa"),
	}
	t.Setenv("ORBIT_HOME", host.orbit)
	writeTestFile(t, host.config, `{"runnerToken":"the-runner-credential"}`)
	writeTestFile(t, host.key, "the-ssh-key")
	gitInit(t, host.checkout)
	chdirForTest(t, host.checkout)
	return host
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
}

func (f *fakeFileServer) inHost(t *testing.T) *mcpServer {
	t.Helper()
	return &mcpServer{t: newCallerTransport(f.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession}
}

// assertRefused holds a call to the rule, and to having sent nothing at all.
func assertRefused(t *testing.T, api *fakeFileServer, s *mcpServer, path string, want ...string) {
	t.Helper()
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": path}, true)
	for _, phrase := range append(want, uploadsDir(fileTestSession)) {
		if !strings.Contains(text, phrase) {
			t.Errorf("the refusal of %s does not say %q: %s", path, phrase, text)
		}
	}
	if len(api.calls) != 0 {
		t.Errorf("a refused path sent %v", api.calls)
	}
}

func assertNothingSecretKept(t *testing.T, api *fakeFileServer) {
	t.Helper()
	for _, kept := range api.files {
		if bytes.Contains(kept.data, []byte("the-runner-credential")) {
			t.Fatalf("the runner's credential was uploaded as %s", kept.name)
		}
	}
}

func TestFileUploadRefusesOrbitsOwnCredentials(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	assertRefused(t, api, s, host.config, "Orbit's own directory")
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": host.config}, true)
	if strings.Contains(text, "Copy the file there") {
		t.Errorf("a refusal of the machine's credentials asks for a copy of them: %s", text)
	}
	assertRefused(t, api, s, host.orbit, "Orbit's own directory")
}

func TestFileUploadRefusesWhatIsOutsideTheCheckoutAndSaysWhereToCopyIt(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	assertRefused(t, api, s, host.key, "outside this session's checkout", "Copy the file there first")
	assertRefused(t, api, s, filepath.Dir(host.key), "outside this session's checkout")
	if info, err := os.Stat(uploadsDir(fileTestSession)); err != nil || !info.IsDir() {
		t.Errorf("the directory the refusal asks a copy into does not exist: %v", err)
	}
}

func TestFileUploadJudgesALinkByWhereItLeads(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	out := filepath.Join(host.checkout, "evidence.txt")
	if err := os.Symlink(host.key, out); err != nil {
		t.Fatal(err)
	}
	assertRefused(t, api, s, out, "outside this session's checkout")
	folder := filepath.Join(host.checkout, "evidence")
	if err := os.Symlink(filepath.Dir(host.key), folder); err != nil {
		t.Fatal(err)
	}
	assertRefused(t, api, s, folder, "outside this session's checkout")
	credential := filepath.Join(host.checkout, "config.json")
	if err := os.Symlink(host.config, credential); err != nil {
		t.Fatal(err)
	}
	assertRefused(t, api, s, credential, "Orbit's own directory")

	target := writeTestFile(t, filepath.Join(host.checkout, "real.txt"), "mine")
	inside := filepath.Join(host.checkout, "inside.txt")
	if err := os.Symlink(target, inside); err != nil {
		t.Fatal(err)
	}
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": inside}); got.Name != "inside.txt" {
		t.Errorf("a link inside the checkout answered %+v", got)
	}
}

// A caller can `cd` before the CLI: the working directory says which checkout a call means, and never makes Orbit's own
// directory one.
func TestFileUploadFromAWorkingDirectoryInsideOrbitsOwnDirectory(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	chdirForTest(t, host.orbit)
	assertRefused(t, api, s, "config.json", "Orbit's own directory")
	assertRefused(t, api, s, ".", "Orbit's own directory")
	repository := filepath.Join(host.orbit, "worktrees", "another-session")
	writeTestFile(t, filepath.Join(repository, "a.txt"), "x")
	gitInit(t, repository)
	chdirForTest(t, repository)
	assertRefused(t, api, s, "a.txt", "Orbit's own directory")
	assertNothingSecretKept(t, api)

	api2 := newFakeFileServer(t)
	configureCLITestRunner(t, api2.URL)
	writeTestFile(t, host.config, `{"runnerToken":"the-runner-credential"}`)
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	chdirForTest(t, filepath.Dir(configPath()))
	var out bytes.Buffer
	if err := cmdFileCLI([]string{"upload", "config.json"}, &out); err == nil || !strings.Contains(err.Error(), "Orbit's own directory") {
		t.Errorf("the CLI, from inside Orbit's own directory: %v", err)
	}
	if len(api2.calls) != 0 {
		t.Errorf("sent %v", api2.calls)
	}
}

// A home directory is no checkout, repository or not, and neither is a directory above it: the working directory counts
// only when it is narrower than the home it runs in.
func TestFileUploadFromAWorkingDirectoryAsBroadAsTheHomeDirectory(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	gitInit(t, host.home)
	mine := writeTestFile(t, filepath.Join(host.home, "notes.txt"), "mine")

	for _, cwd := range []string{host.home, filepath.Dir(host.home), string(filepath.Separator)} {
		chdirForTest(t, cwd)
		assertRefused(t, api, s, host.key, "outside this session's checkout")
		assertRefused(t, api, s, mine, "outside this session's checkout")
		assertRefused(t, api, s, host.home, "outside this session's checkout")
		assertRefused(t, api, s, host.config, "Orbit's own directory")
	}
}

// The environment's home is the caller's to set, so the account's counts too.
func TestAWorkingDirectoryAtTheAccountsHomeIsNoRootWhateverHomeSays(t *testing.T) {
	account, err := user.Current()
	if err != nil || account.HomeDir == "" {
		t.Skip("no account home here")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORBIT_HOME", t.TempDir())
	if usableAsARoot(account.HomeDir) {
		t.Errorf("%s counts as a root", account.HomeDir)
	}
	if !usableAsARoot(t.TempDir()) {
		t.Error("an ordinary directory counts as no root")
	}
}

// A working directory inside a repository rooted at the home directory is the root, not the repository around it.
func TestFileUploadInARepositoryRootedAtTheHomeDirectory(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	gitInit(t, host.home)
	project := filepath.Join(host.home, "project")
	writeTestFile(t, filepath.Join(project, "a.txt"), "mine")
	chdirForTest(t, project)

	assertRefused(t, api, s, host.config, "Orbit's own directory")
	assertRefused(t, api, s, host.key, "outside this session's checkout")
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": "a.txt"}); got.Name != "a.txt" {
		t.Errorf("a file in the working directory: %+v", got)
	}
}

// What a repository says about itself decides nothing: its configuration is the session's to write.
func TestFileUploadTakesNoRootFromARepositorysConfiguration(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	if out, err := exec.Command("git", "-C", host.checkout, "config", "core.worktree", host.home).CombinedOutput(); err != nil {
		t.Fatalf("git config: %v: %s", err, out)
	}
	assertRefused(t, api, s, host.key, "outside this session's checkout")
	assertRefused(t, api, s, host.config, "Orbit's own directory")
}

func TestFileUploadReadsTheSessionsOwnDirectories(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)

	inUploads := writeTestFile(t, filepath.Join(uploadsDir(fileTestSession), "shot.png"), "from the uploads directory")
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": inUploads}); got.Name != "shot.png" {
		t.Errorf("a file in the uploads directory: %+v", got)
	}
	fetched := fileResult(t, s, "file_fetch", map[string]interface{}{"id": "file1"})
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": fetched.Path}); got.SHA256 != fetched.SHA256 {
		t.Errorf("a fetched file sent back: %+v", got)
	}

	own := filepath.Join(worktreesDir(), decodeSessionID(fileTestSession))
	inOwn := writeTestFile(t, filepath.Join(own, "report.json"), "{}")
	gitInit(t, own)
	chdirForTest(t, own)
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": inOwn}); got.Name != "report.json" {
		t.Errorf("this session's own checkout under Orbit's directory: %+v", got)
	}

	before := len(api.calls)
	other := writeTestFile(t, filepath.Join(worktreesDir(), "another-session", "a.txt"), "x")
	if text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": other}, true); !strings.Contains(text, "Orbit's own directory") {
		t.Errorf("another session's checkout: %s", text)
	}
	otherUpload := writeTestFile(t, filepath.Join(uploadsRootDir(), "another-session", "a.txt"), "x")
	if text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": otherUpload}, true); !strings.Contains(text, "Orbit's own directory") {
		t.Errorf("another session's uploads: %s", text)
	}
	if len(api.calls) != before {
		t.Errorf("another session's files sent %v", api.calls[before:])
	}
	_ = host
}

// With no worktree the root is the working directory itself, and with one it is the worktree, wherever in it a call is made.
func TestFileUploadFromASubdirectory(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)

	writeTestFile(t, filepath.Join(host.checkout, "top.txt"), "top")
	sub := filepath.Join(host.checkout, "deep", "er")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	chdirForTest(t, sub)
	assertRefused(t, api, s, "../../top.txt", "outside this session's checkout")

	own := filepath.Join(worktreesDir(), decodeSessionID(fileTestSession))
	writeTestFile(t, filepath.Join(own, "top.txt"), "top")
	ownSub := filepath.Join(own, "deep", "er")
	if err := os.MkdirAll(ownSub, 0o755); err != nil {
		t.Fatal(err)
	}
	chdirForTest(t, ownSub)
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": "../../top.txt"}); got.Name != "top.txt" {
		t.Errorf("the top of this session's own checkout: %+v", got)
	}
}

func TestFileUploadOfAFolderListsWhatTheServerWouldRefuse(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "good.txt"), "kept")
	writeTestFile(t, filepath.Join(root, `back\slash.txt`), "x")
	writeTestFile(t, filepath.Join(root, "new\nline.txt"), "x")
	long := filepath.Join(root, strings.Repeat("d", 240), strings.Repeat("e", 240), strings.Repeat("f", 240), strings.Repeat("g", 240), strings.Repeat("h", 240))
	writeTestFile(t, filepath.Join(long, "deep.txt"), "x")
	want := []string{`back\slash.txt`, "new\nline.txt", strings.TrimPrefix(filepath.ToSlash(filepath.Join(long, "deep.txt")), filepath.ToSlash(root)+"/")}
	if err := os.WriteFile(filepath.Join(root, "bad\xff.txt"), []byte("x"), 0o644); err == nil {
		// As JSON spells it: those bytes are why the name cannot go in a manifest.
		want = append(want, strings.ToValidUTF8("bad\xff.txt", "\ufffd"))
	}

	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": root})

	if len(got.Files) != 1 || got.Files[0].Path != "good.txt" {
		t.Errorf("files = %+v", got.Files)
	}
	sort.Strings(want)
	if !equalStrings(sortedSkipped(got.Skipped), want) {
		t.Errorf("skipped = %q, want %q", sortedSkipped(got.Skipped), want)
	}
}

// Mode 000 reads as a size and an open that fails, for anybody but root, which reads everything.
func TestFileUploadOfAFolderListsAFileItCannotOpen(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root opens a mode 000 file")
	}
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "good.txt"), "kept")
	locked := writeTestFile(t, filepath.Join(root, "locked.txt"), "x")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": root})
	if len(got.Files) != 1 || got.Files[0].Path != "good.txt" {
		t.Errorf("files = %+v", got.Files)
	}
	if len(got.Skipped) != 1 || got.Skipped[0].Path != "locked.txt" || !strings.Contains(got.Skipped[0].Reason, "could not be read") {
		t.Errorf("skipped = %+v", got.Skipped)
	}
}

func TestFileUploadRefusesALabelItCouldNotKeepBeforeSendingAnything(t *testing.T) {
	api := newFakeFileServer(t)
	s := api.mcp(t)
	root := inCheckout(t)
	writeTestFile(t, filepath.Join(root, "a.txt"), "x")
	for _, label := range []string{strings.Repeat("x", fileLabelMaxChars+1), "a\x00b", "two\nlines"} {
		fileToolText(t, s, "file_upload", map[string]interface{}{"path": root, "label": label}, true)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

// An engine that ends a tool call on its own deadline reports it failed while this process carries on, and a retry
// keeps everything twice: the call stops first, and says which files did not go.
func TestFileUploadOfAFolderStopsBeforeTheEnginesDeadlineAndSaysWhatDidNotGo(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n > 1 {
			<-release
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"f1","publicId":"f1","kind":"file","sha256":"aa","sizeBytes":1}`))
	}))
	defer api.Close()
	defer close(release)
	t.Setenv("ORBIT_HOME", t.TempDir())
	chdirForTest(t, t.TempDir())
	root := inCheckout(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		writeTestFile(t, filepath.Join(root, name), "x")
	}
	s := &mcpServer{t: newCallerTransport(api.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession, callTimeout: 200 * time.Millisecond}
	started := time.Now()
	text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": root}, true)
	if elapsed := time.Since(started); elapsed >= 200*time.Millisecond {
		t.Errorf("stopped after %s, past the engine's deadline", elapsed)
	}
	for _, want := range []string{"1 of 3 files were kept", "no bundle was made", "not uploaded: b.txt, c.txt", "stores no byte twice"} {
		if !strings.Contains(text, want) {
			t.Errorf("the error does not say %q: %s", want, text)
		}
	}
}

func TestFolderTimeoutErrorShortensALongList(t *testing.T) {
	files := []folderFile{}
	for i := 0; i < 50; i++ {
		files = append(files, folderFile{rel: fmt.Sprintf("%02d.png", i)})
	}
	text := folderTimeoutError("/x", files[5:], 5, len(files), time.Minute).Error()
	if !strings.Contains(text, "5 of 50 files") || !strings.Contains(text, "05.png") || !strings.Contains(text, "24.png") ||
		strings.Contains(text, "25.png") || !strings.Contains(text, "and 25 more in path order") {
		t.Errorf("error = %s", text)
	}
}

func TestFileFetchStopsBeforeTheEnginesDeadline(t *testing.T) {
	release := make(chan struct{})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/attachments/") {
			<-release
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"f1","publicId":"f1","kind":"file","name":"a.txt","sha256":"aa","sizeBytes":1}`))
	}))
	defer api.Close()
	defer close(release)
	t.Setenv("ORBIT_HOME", t.TempDir())
	s := &mcpServer{t: newCallerTransport(api.URL, "runner-secret", runnerCallerMCP), sessionID: fileTestSession, callTimeout: 200 * time.Millisecond}
	if text := fileToolText(t, s, "file_fetch", map[string]interface{}{"id": "f1"}, true); !strings.Contains(text, "this engine ends a tool call after") {
		t.Errorf("error = %s", text)
	}
}

// Saving under the uploads directory goes by handles and a link at any level stops it, the last level included.
func TestSaveLocalFileRefusesALinkAtAnyLevelAndWritesNothingElsewhere(t *testing.T) {
	for _, level := range []string{"session", "files", "file", "name"} {
		t.Run(level, func(t *testing.T) {
			api := newFakeFileServer(t)
			host := newFileScopeHost(t)
			s := api.inHost(t)
			file := api.keep("config.json", "text/plain", "", "file", []byte("bytes from the server"))
			session := uploadsDir(fileTestSession)
			link := map[string]string{
				"session": session,
				"files":   filepath.Join(session, "files"),
				"file":    filepath.Join(session, "files", file.id),
				"name":    filepath.Join(session, "files", file.id, "config.json"),
			}[level]
			target := host.orbit
			if level == "name" {
				target = host.config
			}
			if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}

			text := fileToolText(t, s, "file_fetch", map[string]interface{}{"id": file.id}, true)

			if strings.Contains(text, `"path"`) {
				t.Errorf("a refused fetch reports a path: %s", text)
			}
			if data, _ := os.ReadFile(host.config); string(data) != `{"runnerToken":"the-runner-credential"}` {
				t.Errorf("the file behind the link changed: %q", data)
			}
			entries, err := os.ReadDir(host.orbit)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".saving-") || entry.Name() == "files" {
					t.Errorf("left behind in the link's target: %s", entry.Name())
				}
			}
		})
	}
}

// A link that stays inside the directory stops a save too: the rule is that there is no link, not where one leads.
func TestSaveLocalFileRefusesALinkThatStaysInside(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	file := api.keep("a.txt", "text/plain", "", "file", []byte("x"))
	session := uploadsDir(fileTestSession)
	elsewhere := filepath.Join(session, "elsewhere")
	if err := os.MkdirAll(elsewhere, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(session, "files")); err != nil {
		t.Fatal(err)
	}
	fileToolText(t, s, "file_fetch", map[string]interface{}{"id": file.id}, true)
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("wrote %v through a link", entries)
	}
	_ = host
}

func TestSaveLocalFileReplacesItsOwnFileAndLeavesNoTemporary(t *testing.T) {
	api := newFakeFileServer(t)
	newFileScopeHost(t)
	s := api.inHost(t)
	file := api.keep("a.txt", "text/plain", "", "file", []byte("first"))
	first := fileResult(t, s, "file_fetch", map[string]interface{}{"id": file.id})
	file.data = []byte("second")
	file.sha = sha256Hex(file.data)
	second := fileResult(t, s, "file_fetch", map[string]interface{}{"id": file.id})
	if first.Path != second.Path {
		t.Errorf("a second fetch moved the file: %s, %s", first.Path, second.Path)
	}
	if data, _ := os.ReadFile(second.Path); string(data) != "second" {
		t.Errorf("read back %q", data)
	}
	entries, err := os.ReadDir(filepath.Dir(second.Path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("the directory holds %v", entries)
	}
	if info, err := os.Stat(second.Path); err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("mode %v, %v", info.Mode(), err)
	}
}

// A bundle's manifest is read from what was received, not from a path.
func TestFileFetchReadsABundlesManifestFromWhatItReceived(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	root := filepath.Join(host.checkout, "shots")
	writeTestFile(t, filepath.Join(root, "a.txt"), "a")
	bundle := fileResult(t, s, "file_upload", map[string]interface{}{"path": root})
	dir := filepath.Join(uploadsDir(fileTestSession), "files", bundle.ID)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(host.orbit, dir); err != nil {
		t.Fatal(err)
	}
	if text := fileToolText(t, s, "file_fetch", map[string]interface{}{"id": bundle.ID}, true); strings.Contains(text, "runnerToken") {
		t.Errorf("a refused bundle answered %s", text)
	}
}

func TestWriteUploadRefusesALinkAndWritesNothingElsewhere(t *testing.T) {
	host := newFileScopeHost(t)
	session := uploadsDir(fileTestSession)
	if err := os.MkdirAll(session, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(host.config, filepath.Join(session, "notes.txt")); err != nil {
		t.Fatal(err)
	}
	if path, err := writeUpload(fileTestSession, "notes.txt", "att-1", []byte("from an attachment")); err == nil {
		t.Errorf("saved through a link at %s", path)
	}
	if data, _ := os.ReadFile(host.config); string(data) != `{"runnerToken":"the-runner-credential"}` {
		t.Errorf("the file behind the link changed: %q", data)
	}

	path, err := writeUpload(fileTestSession, "other.txt", "att-2", []byte("from an attachment"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(session, "other.txt"); path != want {
		t.Errorf("path = %s, want %s", path, want)
	}
	if data, _ := os.ReadFile(path); string(data) != "from an attachment" {
		t.Errorf("read back %q", data)
	}
}

func TestStageCodexGeneratedImageRefusesALinkAtItsDestination(t *testing.T) {
	host := newFileScopeHost(t)
	generated := filepath.Join(host.home, ".codex", "generated_images")
	saved := writeTestFile(t, filepath.Join(generated, "thread", "image.png"), "\x89PNG")
	uploads := uploadsDir(fileTestSession)
	if err := os.MkdirAll(uploads, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(host.config, filepath.Join(uploads, "image.png")); err != nil {
		t.Fatal(err)
	}
	if staged := stageCodexGeneratedImage(saved, generated, uploads); staged != "" {
		t.Errorf("staged through a link at %s", staged)
	}
	if data, _ := os.ReadFile(host.config); string(data) != `{"runnerToken":"the-runner-credential"}` {
		t.Errorf("the file behind the link changed: %q", data)
	}
}

// replaceAfterFirstUpload changes what the file the folder sends next is, in the fake server's handler, so that the
// change is certain to come after the walk and before the send.
func replaceAfterFirstUpload(api *fakeFileServer, replace func()) {
	inner := api.Config.Handler
	var once sync.Once
	api.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner.ServeHTTP(w, r)
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/files") {
			once.Do(replace)
		}
	})
}

func TestFileUploadOfAFolderSendsOnlyWhatItFound(t *testing.T) {
	for name, change := range map[string]func(t *testing.T, host fileScopeHost, next string){
		"a link out of the session": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
			if err := os.Symlink(host.config, next); err != nil {
				t.Fatal(err)
			}
		},
		"a link inside the folder": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
			if err := os.Symlink(filepath.Join(filepath.Dir(next), "a.txt"), next); err != nil {
				t.Fatal(err)
			}
		},
		"another file": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
			writeTestFile(t, next, "other bytes")
		},
		"different contents": func(t *testing.T, host fileScopeHost, next string) {
			if err := os.WriteFile(next, []byte("rewritten and longer"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"a directory": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
			if err := os.Mkdir(next, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"nothing": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
		},
		"a named pipe": func(t *testing.T, host fileScopeHost, next string) {
			mustRemove(t, next)
			if err := syscall.Mkfifo(next, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"a directory link above it": func(t *testing.T, host fileScopeHost, next string) {
			dir := filepath.Dir(next)
			if err := os.Rename(dir, dir+".moved"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Dir(host.key), dir); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			api := newFakeFileServer(t)
			host := newFileScopeHost(t)
			s := api.inHost(t)
			folder := filepath.Join(host.checkout, "shots")
			writeTestFile(t, filepath.Join(folder, "a.txt"), "first")
			next := writeTestFile(t, filepath.Join(folder, "sub", "b.txt"), "second")
			writeTestFile(t, filepath.Join(folder, "z.txt"), "last")
			if name != "a directory link above it" {
				next = filepath.Join(folder, "b.txt")
				mustRemove(t, filepath.Join(folder, "sub", "b.txt"))
				mustRemove(t, filepath.Join(folder, "sub"))
				writeTestFile(t, next, "second")
			}
			replaceAfterFirstUpload(api, func() { change(t, host, next) })

			done := make(chan fileAnswer, 1)
			go func() { done <- fileResult(t, s, "file_upload", map[string]interface{}{"path": folder}) }()
			var got fileAnswer
			select {
			case got = <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("the upload hung")
			}

			rel := strings.TrimPrefix(filepath.ToSlash(strings.TrimPrefix(next, folder)), "/")
			if !equalStrings(sortedSkipped(got.Skipped), []string{rel}) {
				t.Errorf("skipped = %+v, want %s", got.Skipped, rel)
			}
			var paths []string
			for _, file := range got.Files {
				paths = append(paths, file.Path)
			}
			if !equalStrings(paths, []string{"a.txt", "z.txt"}) {
				t.Errorf("the bundle holds %v", paths)
			}
			assertNothingSecretKept(t, api)
			for _, kept := range api.files {
				if kept.kind == "file" && bytes.Contains(kept.data, []byte("second")) || bytes.Contains(kept.data, []byte("other bytes")) || bytes.Contains(kept.data, []byte("the-ssh-key")) {
					t.Errorf("sent %s: %q", kept.name, kept.data)
				}
			}
		})
	}
}

func mustRemove(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}

// One file is opened once, and its type comes from that handle: a name says nothing here, and the bytes are sniffed.
func TestFileUploadSniffsWhatItOpened(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	png := writeTestFile(t, filepath.Join(host.checkout, "shot"), "\x89PNG\r\n\x1a\n image")
	got := fileResult(t, s, "file_upload", map[string]interface{}{"path": png})
	if got.MimeType != "image/png" {
		t.Errorf("mimeType = %q", got.MimeType)
	}
	for _, kept := range api.files {
		if !bytes.HasPrefix(kept.data, []byte("\x89PNG")) {
			t.Errorf("sniffing moved the offset: the server got %q", kept.data)
		}
	}
}

// A single file that is a named pipe is refused at once.
func TestFileUploadOfANamedPipeDoesNotHang(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	pipe := filepath.Join(host.checkout, "pipe")
	if err := syscall.Mkfifo(pipe, 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan string, 1)
	go func() { done <- fileToolText(t, s, "file_upload", map[string]interface{}{"path": pipe}, true) }()
	select {
	case text := <-done:
		if !strings.Contains(text, "regular file") {
			t.Errorf("error = %s", text)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the upload hung")
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

// A reply's link is held to the same rule as file_upload: where it really leads, and what was opened.
func TestRepliesFollowTheSameRuleAsFileUpload(t *testing.T) {
	host := newFileScopeHost(t)
	notes := filepath.Join(host.checkout, "notes.txt")
	shot := filepath.Join(host.checkout, "shot.png")
	folder := filepath.Join(host.checkout, "folder")
	for link, target := range map[string]string{notes: host.config, shot: host.key, folder: filepath.Dir(host.key)} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	for _, text := range []string{
		"see [notes](notes.txt)",
		"see [notes](" + notes + ")",
		"see ![shot](shot.png)",
		"see [key](folder/id_rsa)",
		"see [config](" + host.config + ")",
	} {
		got := rewriteLocalMarkdownImagesWithUploader(context.Background(), text, []string{host.checkout},
			func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
				t.Errorf("%q reached the uploader as %s", text, path)
				return "att", nil
			})
		if got != text {
			t.Errorf("%q was rewritten to %q", text, got)
		}
	}
}

func TestRepliesRefuseOrbitsOwnDirectoryEvenInsideARoot(t *testing.T) {
	host := newFileScopeHost(t)
	text := "see [config](" + host.config + ")"
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), text, []string{host.home},
		func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
			t.Errorf("Orbit's own directory reached the uploader as %s", path)
			return "att", nil
		})
	if got != text {
		t.Errorf("rewritten to %q", got)
	}
}

// What a reply sends is read from the handle the rule opened, and a link that stays in the session still works.
func TestRepliesSendWhatWasOpened(t *testing.T) {
	host := newFileScopeHost(t)
	target := writeTestFile(t, filepath.Join(host.checkout, "real.txt"), "mine")
	if err := os.Symlink(target, filepath.Join(host.checkout, "alias.txt")); err != nil {
		t.Fatal(err)
	}
	var sent []byte
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), "see [notes](alias.txt)", []string{host.checkout},
		func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
			sent, _ = io.ReadAll(file)
			return "att", nil
		})
	if string(sent) != "mine" || !strings.Contains(got, "orbit-attachment:att") {
		t.Errorf("sent %q, rewritten %q", sent, got)
	}
}

// Codex can keep its home under Orbit's directory, and its generated images are this session's.
func TestCodexGeneratedImagesStillTravelFromUnderOrbitsDirectory(t *testing.T) {
	host := newFileScopeHost(t)
	generated := filepath.Join(host.orbit, "codex-home", "generated_images")
	saved := writeTestFile(t, filepath.Join(generated, "thread", "image.png"), "\x89PNG\r\n\x1a\n image")
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), "![generated image]("+saved+")",
		[]string{host.checkout, generated}, func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
			return "att", nil
		})
	if got != "![generated image](orbit-attachment:att)" {
		t.Errorf("rewritten = %q", got)
	}
	staged := stageCodexGeneratedImage(saved, generated, uploadsDir(fileTestSession))
	if staged == "" {
		t.Fatal("the generated image was not staged")
	}
	if data, _ := os.ReadFile(staged); !bytes.HasPrefix(data, []byte("\x89PNG")) {
		t.Errorf("staged %q", data)
	}
	// The roots a reply is given make only themselves readable there.
	other := "![config](" + host.config + ")"
	if text := rewriteLocalMarkdownImagesWithUploader(context.Background(), other, []string{host.checkout, generated},
		func(ctx context.Context, file *os.File, path, mimeType string) (string, error) { return "att", nil }); text != other {
		t.Errorf("rewritten = %q", text)
	}
}

func TestStageCodexGeneratedImageJudgesWhereALinkLeads(t *testing.T) {
	host := newFileScopeHost(t)
	generated := filepath.Join(host.home, ".codex", "generated_images")
	link := filepath.Join(generated, "image.png")
	if err := os.MkdirAll(generated, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := writeTestFile(t, filepath.Join(host.checkout, "elsewhere.png"), "\x89PNG")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if staged := stageCodexGeneratedImage(link, generated, uploadsDir(fileTestSession)); staged != "" {
		t.Errorf("staged %s from outside its root", staged)
	}
}

func TestLegacyArtifactRequestJudgesWhereALinkLeads(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	own := filepath.Join(worktreesDir(), decodeSessionID(fileTestSession))
	if err := os.MkdirAll(own, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(own, "notes.txt")
	if err := os.Symlink(host.config, link); err != nil {
		t.Fatal(err)
	}
	out := uploadLegacyArtifact(context.Background(), NewTransport(api.URL, "runner-secret"), ArtifactCommand{
		RequestID: "r-1", SessionID: fileTestSession, Path: link,
	})
	if out.Status != "missing" {
		t.Errorf("out = %+v", out)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}
