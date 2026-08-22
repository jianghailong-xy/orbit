package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The end-to-end shape of the thing: a real unix socket, a real client (this process),
// and a target derived only from what the kernel says about that client. Linux-only
// because SO_PEERCRED is — hostd is a systemd facility.
func TestHostdServeDerivesTheTargetFromPeerCredentials(t *testing.T) {
	var (
		called atomic.Int32
		seen   = make(chan hostdPeer, 4)
	)
	verbs := map[string]hostdVerb{
		"whoami": func(peer hostdPeer, _ hostdRequest) hostdResponse {
			called.Add(1)
			seen <- peer
			return hostdOK(map[string]any{"unit": unitForUid(peer.UID)})
		},
	}
	path, stop := startHostd(t, verbs)
	defer stop()

	resp := hostdAsk(t, path, `{"v":1,"verb":"whoami"}`)
	if !resp.OK {
		t.Fatalf("request failed: %s", resp.Error)
	}
	peer := <-seen
	if peer.UID != uint32(os.Getuid()) {
		t.Errorf("peer uid = %d, want %d (this process)", peer.UID, os.Getuid())
	}
	if peer.PID != int32(os.Getpid()) {
		t.Errorf("peer pid = %d, want %d (this process)", peer.PID, os.Getpid())
	}
	if got, _ := resp.Data["unit"].(string); got != unitForUid(uint32(os.Getuid())) {
		t.Errorf("unit = %q, want %q", got, unitForUid(uint32(os.Getuid())))
	}

	// Same connection type, but the caller tries to name someone else's runner.
	resp = hostdAsk(t, path, `{"v":1,"verb":"whoami","uid":0}`)
	if resp.OK {
		t.Fatal("hostd accepted a request that named its own target")
	}
	if got := called.Load(); got != 1 {
		t.Fatalf("verb ran %d times; the second request must never reach it", got)
	}

	// And it is still there for the next caller after refusing that one.
	if resp := hostdAsk(t, path, `{"v":1,"verb":"whoami"}`); !resp.OK {
		t.Fatalf("hostd stopped answering after a refusal: %s", resp.Error)
	}
}

// startHostd serves verbs on a temporary socket and returns its path plus a stop
// function that shuts the listener down and waits for the loop to finish.
func startHostd(t *testing.T, verbs map[string]hostdVerb) (string, func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "host.sock")
	cfg := hostdConfig{socketPath: path, idleTimeout: 30 * time.Second}
	l, err := hostdListen(cfg)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = hostdServe(l, cfg, verbs)
	}()
	return path, func() {
		l.Close()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("hostd did not stop after its listener closed")
		}
	}
}

// hostdAsk performs one exchange the way a client must: connect, write one request,
// read one response, close.
func hostdAsk(t *testing.T, path, request string) hostdResponse {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	var resp hostdResponse
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		t.Fatalf("reading the response to %s: %v", request, err)
	}
	return resp
}
