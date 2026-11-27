package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
)

type toolOutputEvents struct {
	mu   sync.Mutex
	seen []map[string]interface{}
}

func (e *toolOutputEvents) emit(eventType string, payload map[string]interface{}) {
	if eventType != evToolOutput {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seen = append(e.seen, payload)
}

func (e *toolOutputEvents) all() []map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]interface{}(nil), e.seen...)
}

// A drive_get that Claude Code names reaches the runner's session socket and comes out as that call's tool_output,
// counting the bytes as they come down; one the engine does not name reports nothing.
func TestDriveTransferReportsItsBytesAsToolOutput(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := &toolOutputEvents{}
	bg := newBgTailer(ctx, events.emit, nil)
	defer bg.stopAll()
	dir := t.TempDir()
	svc := &bgJobService{bg: bg, token: "test-token", execDir: dir, scratchDir: dir}
	socket := filepath.Join(t.TempDir(), "bg.sock")
	stopService, err := startBgJobService(context.Background(), svc, socket, filepath.Join(dir, "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stopService()
	t.Setenv(envBgSocket, socket)
	t.Setenv(envBgToken, "test-token")

	head, tail := "report ", "text"
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/drive/manifest":
			fmt.Fprintf(w, `{"entryId":"e1","sizeBytes":%d,"chunks":[{"idx":0,"offset":0,"size":%d,"sha256":%q},{"idx":1,"offset":%d,"size":%d,"sha256":%q}]}`,
				len(head+tail), len(head), sha256Hex([]byte(head)), len(head), len(tail), sha256Hex([]byte(tail)))
		case "/api/runner/drive/chunks/" + sha256Hex([]byte(head)):
			fmt.Fprint(w, head)
		case "/api/runner/drive/chunks/" + sha256Hex([]byte(tail)):
			fmt.Fprint(w, tail)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	s := &mcpServer{sessionID: fileTestSession, t: newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)}
	call := func(meta map[string]interface{}) {
		params, _ := json.Marshal(map[string]interface{}{
			"name": "drive_get", "arguments": map[string]interface{}{"path": "/Proj/r.md"}, "_meta": meta,
		})
		resp, _ := s.handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "tools/call", Params: params})
		if result, _ := resp.Result.(map[string]interface{}); result == nil || result["isError"] == true {
			t.Fatalf("drive_get answered %#v", resp)
		}
	}

	call(nil)
	if got := events.all(); len(got) != 0 {
		t.Fatalf("an unnamed call reported %v", got)
	}
	call(map[string]interface{}{"claudecode/toolUseId": "toolu_01Drive"})
	got := events.all()
	if len(got) == 0 {
		t.Fatal("a named drive_get reported no progress")
	}
	last := got[len(got)-1]
	want := driveProgressLine("Downloaded", int64(len(head+tail)), int64(len(head+tail)))
	if last["toolUseId"] != "toolu_01Drive" || last["content"] != want {
		t.Errorf("last progress = %v, want %q", last, want)
	}
	if s.callToolUseID != "" {
		t.Errorf("the call's id outlived it: %q", s.callToolUseID)
	}
	if resp := svc.handle(bgSocketRequest{Op: driveProgressOp, Args: map[string]interface{}{"toolUseId": "toolu_01Drive"}}); resp.OK {
		t.Error("a progress line with no content was emitted")
	}
}
