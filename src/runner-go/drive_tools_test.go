package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fakeDriveMount(t *testing.T, mounted bool) {
	t.Helper()
	oldInfo, oldMount, oldHome, oldParent, oldStatus := mountinfoPath, driveMountPath, driveHomePath, driveParentPath, driveStatusPath
	t.Cleanup(func() {
		mountinfoPath, driveMountPath, driveHomePath, driveParentPath, driveStatusPath = oldInfo, oldMount, oldHome, oldParent, oldStatus
	})
	dir := t.TempDir()
	mountinfoPath, driveMountPath, driveHomePath = filepath.Join(dir, "mountinfo"), filepath.Join(dir, "drive"), filepath.Join(dir, "Files")
	driveParentPath, driveStatusPath = dir, filepath.Join(dir, "status.json")
	if err := os.Mkdir(driveMountPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driveMountPath, driveHomePath); err != nil {
		t.Fatal(err)
	}
	fstype := "ext4"
	if mounted {
		fstype = "fuse.orbit-drive"
	}
	writeTestFile(t, mountinfoPath, fmt.Sprintf("10 9 0:33 / %s rw - %s orbit-drive rw\n", driveMountPath, fstype))
}

// A Pod of an older CSI driver has its drive at /run/orbit-documents (documents.orbit.dev) or /run/orbit-files
// (files.orbit.dev), mounted by a daemon whose FUSE type is still fuse.orbit-documents or fuse.orbit-files: the runner
// takes whichever root it has, and any of the three types as the drive.
func TestDriveRootOfEveryDriver(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "run", "orbit-drive")
	documents, files := filepath.Join(dir, "run", "orbit-documents"), filepath.Join(dir, "run", "orbit-files")
	pick := func() string { return pickDriveRoot(root, documents, files) }
	if got := pick(); got != root {
		t.Fatalf("with no directory: %s", got)
	}
	if err := os.MkdirAll(files, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := pick(); got != files {
		t.Fatalf("in a Pod of files.orbit.dev: %s", got)
	}
	if err := os.MkdirAll(documents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(files); err != nil {
		t.Fatal(err)
	}
	if got := pick(); got != documents {
		t.Fatalf("in a Pod of documents.orbit.dev: %s", got)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := pick(); got != root {
		t.Fatalf("with both: %s", got)
	}
	if err := os.Remove(documents); err != nil {
		t.Fatal(err)
	}
	if got := pick(); got != root {
		t.Fatalf("in a Pod of drive.orbit.dev: %s", got)
	}
	if driveRootPath != "/run/orbit-drive" || strings.Join(driveLegacyRootPaths, " ") != "/run/orbit-documents /run/orbit-files" {
		t.Fatalf("the runner looks for %s, then %v", driveRootPath, driveLegacyRootPaths)
	}

	for fstype, want := range map[string]bool{"fuse.orbit-drive": true, "fuse.orbit-documents": true, "fuse.orbit-files": true, "fuse.sshfs": false} {
		fakeDriveMount(t, false)
		writeTestFile(t, mountinfoPath, fmt.Sprintf("10 9 0:33 / %s rw - %s x rw\n", driveMountPath, fstype))
		if got := driveMounted(); got != want {
			t.Errorf("%s at the drive's path: mounted = %t", fstype, got)
		}
	}
}

// ~/Documents and ~/Files are ordinary local paths now, not the drive.
func TestDriveHomeAliasesNoLongerResolve(t *testing.T) {
	for _, p := range []string{"~/Documents/Proj/r.md", "/home/orbit/Documents/Proj/r.md", "~/Files/Proj/r.md", "/home/orbit/Files/Proj/r.md"} {
		if _, ok := driveMountRelative(p); ok {
			t.Errorf("%q still resolves to the drive", p)
		}
	}
}

func TestDrivePathNormalization(t *testing.T) {
	for _, p := range []string{"/Proj/r.md", "Proj/r.md", "~/Drive/Proj/r.md", "/home/orbit/Drive/Proj/r.md", "/run/orbit-drive/drive/Proj/r.md", "/run/orbit-documents/drive/Proj/r.md", "/run/orbit-files/drive/Proj/r.md"} {
		if got, err := normalizeDrivePath(p); err != nil || got != "/Proj/r.md" {
			t.Errorf("normalize %q = %q, %v", p, got, err)
		}
	}
	for _, p := range []string{"../Proj/r.md", "~/Drive/../Proj/r.md", "/Proj/../r.md"} {
		if _, err := normalizeDrivePath(p); err == nil {
			t.Errorf("accepted traversal %q", p)
		}
	}
}

func newDriveTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer runner-secret" || r.Header.Get(runnerCallerHeader) == "" {
			t.Errorf("%s %s did not carry the runner credential and caller", r.Method, r.URL.Path)
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func driveTestBody(t *testing.T, r *http.Request) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("%s: %v", r.URL.Path, err)
	}
	return body
}

func TestDrivePutChunksAndRecoversCommit(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	checkout := t.TempDir()
	chdirForTest(t, checkout)
	data := strings.Repeat("x", driveChunkSize) + "tail"
	local := writeTestFile(t, filepath.Join(checkout, "r.md"), data)
	result := fmt.Sprintf(`{"entryId":"e1","versionId":"v1","newVersion":false,"sizeBytes":%d}`, len(data))
	wants := []driveChunk{
		{Index: 0, Size: driveChunkSize, SHA256: sha256Hex([]byte(data[:driveChunkSize]))},
		{Index: 1, Size: 4, SHA256: sha256Hex([]byte("tail"))},
	}
	var createHandle, commitID string
	var commits, chunks, status, calls int
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.Method + " " + strings.TrimPrefix(r.URL.Path, "/api/runner/drive") {
		case "POST /mkdir":
			body := driveTestBody(t, r)
			if body["path"] != "/Proj" || body["parents"] != true {
				t.Errorf("mkdir body = %v", body)
			}
			checkDriveWriter(t, body, fileTestSession)
			fmt.Fprint(w, `{"id":"folder","kind":"FOLDER","path":"/Proj"}`)
		case "GET /stat":
			if p := r.URL.Query().Get("path"); p != "/Proj/r.md" {
				t.Errorf("stat path = %q", p)
			}
			w.WriteHeader(404)
			fmt.Fprint(w, `{"code":"DRIVE_ENTRY_NOT_FOUND","message":"No such entry."}`)
		case "POST /create":
			body := driveTestBody(t, r)
			createHandle, _ = body["handleId"].(string)
			if body["path"] != "/Proj/r.md" || createHandle == "" {
				t.Errorf("create body = %v", body)
			}
			checkDriveWriter(t, body, fileTestSession)
			fmt.Fprint(w, `{"id":"e1","kind":"FILE","path":"/Proj/r.md","currentVersionId":"v1"}`)
		case "POST /stagings":
			if body := driveTestBody(t, r); !reflect.DeepEqual(body, map[string]interface{}{"entryId": "e1"}) {
				t.Errorf("staging body = %v", body)
			}
			fmt.Fprint(w, `{"id":"s1"}`)
		case "PUT /stagings/s1/chunks/0", "PUT /stagings/s1/chunks/1":
			chunk, err := io.ReadAll(r.Body)
			if chunks >= len(wants) {
				t.Error("received more than two chunks")
				http.Error(w, "too many chunks", 400)
				return
			}
			want := wants[chunks]
			if err != nil || len(chunk) != want.Size || sha256Hex(chunk) != want.SHA256 ||
				r.Header.Get("X-Orbit-Chunk-Sha256") != want.SHA256 || r.Header.Get("Content-Type") != "application/octet-stream" {
				t.Errorf("chunk %d: size=%d headers=%v, error=%v", chunks, len(chunk), r.Header, err)
			}
			chunks++
			fmt.Fprintf(w, `{"sha256":%q,"sizeBytes":%d}`, want.SHA256, want.Size)
		case "POST /commit":
			body := driveTestBody(t, r)
			checkDriveWriter(t, body, fileTestSession)
			if body["mode"] != "CONTINUE" || body["handleId"] != createHandle || body["baseVersionId"] != "v1" ||
				body["entryId"] != "e1" || body["stagingId"] != "s1" {
				t.Errorf("commit body = %v", body)
			}
			wantChunks, _ := json.Marshal(wants)
			gotChunks, _ := json.Marshal(body["chunks"])
			var got []driveChunk
			if err := json.Unmarshal(gotChunks, &got); err != nil || !reflect.DeepEqual(got, wants) {
				t.Errorf("commit chunks = %s, want %s", gotChunks, wantChunks)
			}
			if commits == 0 {
				commitID, _ = body["commitId"].(string)
			}
			if commitID == "" || body["commitId"] != commitID {
				t.Errorf("commit id = %v, want %q", body["commitId"], commitID)
			}
			commits++
			if commits == 1 {
				panic(http.ErrAbortHandler)
			}
			w.WriteHeader(503)
			fmt.Fprint(w, `{"code":"UNAVAILABLE","message":"Commit response unavailable."}`)
		default:
			if r.Method == "GET" && commitID != "" && r.URL.Path == "/api/runner/drive/commits/"+commitID {
				status++
				fmt.Fprint(w, `{"applied":true,"result":`+result+"}")
				return
			}
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	s := &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)}
	reply := fileToolText(t, s, "drive_put", map[string]interface{}{"localPath": local, "path": "~/Drive/Proj/r.md"}, false)
	var answer struct {
		ID, Path, Link, VersionID string
		SizeBytes                 int
		NewVersion                bool
	}
	if err := json.Unmarshal([]byte(reply), &answer); err != nil || answer.ID != "e1" || answer.Path != "/Proj/r.md" ||
		answer.Link != "orbit-drive:e1" || answer.VersionID != "v1" || answer.SizeBytes != len(data) || answer.NewVersion {
		t.Fatalf("drive_put answer = %s, %v", reply, err)
	}
	if chunks != 2 || commits != 4 || status != 1 {
		t.Errorf("chunks=%d, commit attempts=%d, status lookups=%d", chunks, commits, status)
	}

	fakeDriveMount(t, true)
	outside := writeTestFile(t, filepath.Join(driveMountPath, "outside.md"), "outside")
	previousCalls := calls
	reply = fileToolText(t, s, "drive_put", map[string]interface{}{"localPath": outside, "path": "/outside.md"}, true)
	if !strings.Contains(reply, "outside this session") || calls != previousCalls {
		t.Errorf("drive_put sent an out-of-scope path: %s", reply)
	}
}

func checkDriveWriter(t *testing.T, body map[string]interface{}, sessionID string) {
	t.Helper()
	writer := map[string]interface{}{}
	if sessionID != "" {
		writer["sessionId"] = sessionID
	}
	if !reflect.DeepEqual(body["writer"], writer) {
		t.Errorf("writer = %v, want %v", body["writer"], writer)
	}
}

func TestDriveGetVerifiesEachChunk(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	head, tail := "report ", "text"
	corrupt := false
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/drive/manifest":
			switch p := r.URL.Query().Get("path"); p {
			case "/Proj":
				w.WriteHeader(409)
				fmt.Fprint(w, `{"code":"DRIVE_NOT_A_FILE","message":"A folder has no content."}`)
			case "/Proj/r.md":
				fmt.Fprintf(w, `{"entryId":"e1","sizeBytes":%d,"chunks":[{"idx":0,"offset":0,"size":%d,"sha256":%q},{"idx":1,"offset":%d,"size":%d,"sha256":%q}]}`,
					len(head+tail), len(head), sha256Hex([]byte(head)), len(head), len(tail), sha256Hex([]byte(tail)))
			default:
				t.Errorf("unexpected manifest path %s", p)
			}
		case "/api/runner/drive/chunks/" + sha256Hex([]byte(head)):
			fmt.Fprint(w, head)
		case "/api/runner/drive/chunks/" + sha256Hex([]byte(tail)):
			if corrupt {
				fmt.Fprint(w, "fail")
			} else {
				fmt.Fprint(w, tail)
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	s := &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)}
	args := map[string]interface{}{"path": "/run/orbit-drive/drive/Proj/r.md"}
	expected := filepath.Join(uploadsDir(fileTestSession), "drive", "e1", "r.md")
	corrupt = true
	if reply := fileToolText(t, s, "drive_get", args, true); !strings.Contains(reply, "sha256") {
		t.Errorf("corrupt chunk answer = %s", reply)
	}
	if _, err := os.Stat(expected); !os.IsNotExist(err) {
		t.Fatalf("corrupt download left %s: %v", expected, err)
	}
	corrupt = false
	reply := fileToolText(t, s, "drive_get", args, false)
	var answer struct {
		Path      string
		SizeBytes int
	}
	if err := json.Unmarshal([]byte(reply), &answer); err != nil || answer.Path != expected || answer.SizeBytes != len(head+tail) {
		t.Fatalf("drive_get answer = %s, %v", reply, err)
	}
	if got, err := os.ReadFile(answer.Path); err != nil || string(got) != head+tail {
		t.Errorf("downloaded %q, %v", got, err)
	}
	if reply := fileToolText(t, s, "drive_get", map[string]interface{}{"path": "/Proj"}, true); !strings.Contains(reply, "drive_list") {
		t.Errorf("folder answer = %s", reply)
	}
}

func TestDriveCLIListsMovesDeletesAndOverwrites(t *testing.T) {
	madeFolder := false
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + strings.TrimPrefix(r.URL.Path, "/api/runner/drive") {
		case "GET /list":
			if query := r.URL.Query(); query.Get("path") != "/" || query.Get("cursor") != "next+1" {
				t.Errorf("list query = %v", query)
			}
			fmt.Fprint(w, `{"entries":[{"id":"e1","kind":"FILE","name":"r.md","path":"/r.md","sizeBytes":2,"mtime":"2026-11-20T00:00:00Z"}],"nextCursor":"next+2"}`)
		case "POST /mkdir":
			// A move makes its destination's folder first, as a put does.
			body := driveTestBody(t, r)
			if body["path"] != "/Archive" || body["parents"] != true {
				t.Errorf("mkdir body = %v", body)
			}
			madeFolder = true
			fmt.Fprint(w, `{"id":"f1","kind":"FOLDER","path":"/Archive"}`)
		case "POST /rename":
			body := driveTestBody(t, r)
			checkDriveWriter(t, body, fileTestSession)
			if !madeFolder || body["from"] != "/Proj/r.md" || body["to"] != "/Archive/r.md" || body["noReplace"] != false {
				t.Errorf("move body = %v (folder made first: %v)", body, madeFolder)
			}
			fmt.Fprint(w, `{"id":"e1","kind":"FILE","path":"/Archive/r.md"}`)
		case "POST /delete":
			body := driveTestBody(t, r)
			checkDriveWriter(t, body, "")
			if body["path"] != "/r.md" {
				t.Errorf("delete body = %v", body)
			}
			fmt.Fprint(w, `{"deleted":true,"id":"e1"}`)
		case "GET /stat":
			fmt.Fprint(w, `{"id":"e1","kind":"FILE","path":"/r.md","currentVersionId":"v1"}`)
		case "POST /stagings":
			fmt.Fprint(w, `{"id":"s1"}`)
		case "POST /commit":
			body := driveTestBody(t, r)
			checkDriveWriter(t, body, fileTestSession)
			if body["mode"] != "OVERWRITE" || body["baseVersionId"] != nil ||
				!reflect.DeepEqual(body["chunks"], []interface{}{}) {
				t.Errorf("overwrite body = %v", body)
			}
			fmt.Fprint(w, `{"entryId":"e1","versionId":"v2","newVersion":true,"sizeBytes":0}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", fileTestSession)
	t.Setenv(envBgSocket, "")
	t.Setenv(envRunnerChild, "")
	checkout := t.TempDir()
	chdirForTest(t, checkout)
	writeTestFile(t, filepath.Join(checkout, "empty"), "")
	// `orbit drive`, and `orbit documents`, its name while Drive was called Drive, which still works.
	for _, command := range []string{"drive", "documents"} {
		t.Setenv("ORBIT_SESSION_ID", fileTestSession)
		for _, call := range []struct {
			args []string
			want string
		}{
			{[]string{"ls", "--cursor", "next+1", "--json"}, `"nextCursor":"next+2"`},
			{[]string{"mv", "~/Drive/Proj/r.md", "--json", "Archive/r.md"}, `"path":"/Archive/r.md"`},
			{[]string{"put", "empty", "/r.md", "--json"}, `"newVersion":true`},
			{[]string{"rm", "/r.md", "--json"}, `"deleted":true`},
		} {
			if call.args[0] == "rm" {
				t.Setenv("ORBIT_SESSION_ID", "")
			}
			var out, stderr bytes.Buffer
			if err := runOrbitCLI(append([]string{command}, call.args...), strings.NewReader(""), &out, &stderr); err != nil ||
				!strings.Contains(out.String(), call.want) {
				t.Fatalf("%s %v = %s %s, %v", command, call.args, out.String(), stderr.String(), err)
			}
		}
	}
}

func TestFileUploadDriveRequiresMount(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mounted bool
	}{{"mounted", true}, {"unmounted", false}} {
		t.Run(tc.name, func(t *testing.T) {
			fakeDriveMount(t, tc.mounted)
			api := newFakeFileServer(t)
			s := api.mcp(t)
			content := "Drive evidence"
			writeTestFile(t, filepath.Join(driveMountPath, "Proj", "r.md"), content)
			for _, root := range []string{driveMountPath, driveHomePath} {
				file := filepath.Join(root, "Proj", "r.md")
				if !tc.mounted {
					assertRefused(t, api, s, file, "outside this session")
					continue
				}
				answer := fileResult(t, s, "file_upload", map[string]interface{}{"path": file})
				if answer.Name != "r.md" || answer.SHA256 != sha256Hex([]byte(content)) {
					t.Errorf("file_upload result = %+v", answer)
				}
			}
			if tc.mounted {
				want := []string{"POST /api/runner/sessions/" + fileTestSession + "/files", "POST /api/runner/sessions/" + fileTestSession + "/files"}
				if !reflect.DeepEqual(api.calls, want) {
					t.Errorf("file_upload calls = %v, want %v", api.calls, want)
				}
			}
		})
	}
}

// A drive file goes through file_upload's secret scan as a checkout file does: one holding a value the owner granted
// this runner is refused here, and nothing of it is sent. The server's own credential scan of the upload route
// (apiserver files/file-tools.pg.spec.ts) is the second scan every file_upload passes.
func TestFileUploadOfADriveFileIsSecretScanned(t *testing.T) {
	fakeDriveMount(t, true)
	holdTestSecret(t, testSecretValue)
	api := newFakeFileServer(t)
	s := api.mcp(t)
	for _, root := range []string{driveMountPath, driveHomePath} {
		file := filepath.Join(root, "Proj", "leak.log")
		writeTestFile(t, filepath.Join(driveMountPath, "Proj", "leak.log"), "log "+testSecretValue)
		text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": file}, true)
		if !strings.Contains(text, errFileHoldsOwnerSecret.Error()) {
			t.Errorf("file_upload of %s was not refused for the secret it holds: %s", file, text)
		}
	}
	if len(api.calls) != 0 {
		t.Errorf("a drive file holding a secret was sent: %v", api.calls)
	}
}

// tools/list names the Drive tools drive_* and never their names while Drive was called Documents, documents_*; a call
// by either name is served, as the tool it is now, through the whole tools/call path, and an ORBIT_MCP_TOOLS list that
// names an old name serves the tool too.
func TestDriveToolsAreListedAndTheirDocumentsNamesStillServed(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	checkout := t.TempDir()
	chdirForTest(t, checkout)
	writeTestFile(t, filepath.Join(checkout, "r.md"), "x")
	var routes []string
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		routes = append(routes, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "GET /api/runner/drive/stat":
			w.WriteHeader(404)
			fmt.Fprint(w, `{"code":"DRIVE_ENTRY_NOT_FOUND"}`)
		case "POST /api/runner/drive/create":
			fmt.Fprint(w, `{"id":"e1","kind":"FILE","path":"/r.md","currentVersionId":"v0"}`)
		case "POST /api/runner/drive/stagings":
			fmt.Fprint(w, `{"id":"s1"}`)
		case "PUT /api/runner/drive/stagings/s1/chunks/0":
			w.WriteHeader(200)
		case "POST /api/runner/drive/commit":
			fmt.Fprint(w, `{"entryId":"e1","versionId":"v0","newVersion":false,"sizeBytes":1}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})

	listed := map[string]bool{}
	resp, _ := (&mcpServer{allowPermissionPrompt: true}).handle(&rpcRequest{ID: json.RawMessage("1"), Method: "tools/list"})
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		listed[tool["name"].(string)] = true
	}
	for old, current := range driveToolAliases {
		if !listed[current] || listed[old] {
			t.Errorf("tools/list: %s listed %v, %s listed %v", current, listed[current], old, listed[old])
		}
	}

	t.Setenv(envMCPTools, "documents_put")
	for _, call := range []struct {
		name string
		s    *mcpServer
	}{
		{"drive_put", &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)}},
		{"documents_put", &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)}},
		{"documents_put", &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP), onlyTools: mcpToolsFromEnv()}},
	} {
		s := call.s
		routes = nil
		params, _ := json.Marshal(map[string]interface{}{"name": call.name, "arguments": map[string]interface{}{"localPath": "r.md", "path": "/r.md"}})
		resp, _ := s.handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("2"), Method: "tools/call", Params: params})
		result, _ := resp.Result.(map[string]interface{})
		content, _ := result["content"].([]map[string]interface{})
		if result == nil || result["isError"] == true || len(content) != 1 {
			t.Fatalf("%s answered %#v", call.name, resp)
		}
		var answer struct {
			Operation string
			Entity    struct{ ID, Link string }
		}
		if err := json.Unmarshal([]byte(content[0]["text"].(string)), &answer); err != nil || answer.Operation != "drive_put" ||
			answer.Entity.ID != "e1" || answer.Entity.Link != "orbit-drive:e1" {
			t.Errorf("%s answer = %v, %v", call.name, content[0]["text"], err)
		}
		if len(routes) != 5 {
			t.Errorf("%s sent %v", call.name, routes)
		}
	}
}
