package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// TestTheGatewayRunsAgainstTheStub builds the link gateway from this checkout and runs it against the stub as
// gateway-limit.sh does, in MODE_LINK and in MODE_HTTP with the stub's switch on, minus TLS and NATS: a runner with a
// link token the stub minted is welcomed with the sessions it names, and its heartbeat, its event batch and a tunnelled
// request are each answered through the gateway, which read the revocation list (and the switch) from the stub.
func TestTheGatewayRunsAgainstTheStub(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the gateway")
	}
	bin := filepath.Join(t.TempDir(), "link-gateway")
	build := exec.Command("go", "build", "-o", bin, "orbit/link-gateway")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the gateway: %v\n%s", err, out)
	}
	for _, mode := range []string{"link", "http"} {
		t.Run("LINK_MODE="+mode, func(t *testing.T) { runGatewayAgainstStub(t, bin, mode) })
	}
}

func runGatewayAgainstStub(t *testing.T, bin, mode string) {
	listen, metrics := freeAddr(t), freeAddr(t)
	s, srv, key := newTestStub(t, time.Millisecond, "ws://"+listen)
	der, err := x509.MarshalPKIXPublicKey(key.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	gw := exec.Command(bin, "serve")
	gw.Env = append(os.Environ(),
		"LINK_LISTEN_ADDR="+listen, "LINK_METRICS_ADDR="+metrics, "LINK_TLS_MODE=off",
		"LINK_PUBLIC_KEYS="+string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
		"LINK_API_URL="+srv.URL, "LINK_GATEWAY_TOKEN="+testGatewayToken, "LINK_MODE="+mode,
		"LINK_INTERNAL_API_URLS="+srv.URL, "LINK_FRAME_LOG=off", "LINK_NATS_URL=")
	gw.Stdout, gw.Stderr = logs, logs
	if err := gw.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = gw.Process.Kill()
		_ = gw.Wait()
		if t.Failed() {
			t.Logf("gateway log:\n%s", logs.String())
		}
	}()
	deadline := time.Now().Add(15 * time.Second)
	for {
		resp, err := http.Get("http://" + metrics + "/healthz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the gateway did not answer /healthz within 15s: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}

	runner, owner := "1c6b1f5e-8a5f-4d1e-9a3f-2b7c8d9e0f1a", "7d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a"
	process, session := "8e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b", "6f1d7a52-3c51-4c2e-9d6f-1f1e2d3c4b5a"
	status, body := call(t, srv, "POST", "/api/runner/link-token", runnerToken(runner, owner), fmt.Sprintf(`{"leaseOwner":%q}`, process))
	var minted struct{ Token, LinkURL string }
	if err := json.Unmarshal(body, &minted); status != 200 || err != nil {
		t.Fatalf("mint: %d %s", status, body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, minted.LinkURL, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + minted.Token}}})
	if err != nil {
		t.Fatalf("dial %s: %v", minted.LinkURL, err)
	}
	defer ws.CloseNow()
	var id uint64
	send := func(f *linkpb.Frame) {
		id++
		f.Id = id
		b, _ := proto.Marshal(f)
		if err := ws.Write(ctx, websocket.MessageBinary, b); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	await := func(match func(*linkpb.Frame) bool) *linkpb.Frame {
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			f := &linkpb.Frame{}
			if err := proto.Unmarshal(data, f); err != nil {
				t.Fatal(err)
			}
			if match(f) {
				return f
			}
		}
	}
	send(&linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: &linkpb.Hello{ProcessId: process, RunnerVersion: "linkstub-test", Os: "linux",
		MinProtocolVersion: 1, MaxProtocolVersion: 1, Sessions: []*linkpb.SessionResume{{SessionId: session}}}}})
	w := await(func(f *linkpb.Frame) bool { return f.GetWelcome() != nil }).GetWelcome()
	if w.GetMode() != linkpb.Mode_MODE_LINK || len(w.GetSessions()) != 1 || w.GetSessions()[0].GetSessionId() != session ||
		!w.GetSessions()[0].GetLeaseHeld() || w.GetSessions()[0].GetDurableSeq() != 0 {
		t.Fatalf("Welcome: %v", w)
	}
	send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: process, SessionIds: []string{session},
		SupportedProviders: []string{"claude"}}}})
	ack := await(func(f *linkpb.Frame) bool { return f.GetHeartbeatAck() != nil }).GetHeartbeatAck()
	var reconcile map[string]json.RawMessage
	if err := json.Unmarshal(ack.GetReconcileJson(), &reconcile); err != nil || reconcile["cancelSessionIds"] == nil ||
		reconcile["linkHints"] != nil || ack.GetHints() == nil || ack.GetMode() != linkpb.Mode_MODE_LINK {
		t.Errorf("HeartbeatAck: %v (%s)", ack, ack.GetReconcileJson())
	}
	now := time.Now().UnixMilli()
	send(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{SessionId: session, Events: []*linkpb.Event{
		{Seq: 1, Type: "assistant", TsUnixMs: now, PayloadJson: []byte(`{"text":"one"}`)},
		{Seq: 2, Type: "assistant", TsUnixMs: now, PayloadJson: []byte(`{"text":"two"}`)},
	}}}})
	eventAck := await(func(f *linkpb.Frame) bool { return f.GetEventAck() != nil }).GetEventAck()
	if eventAck.GetSessionId() != session || eventAck.GetDurableSeq() != 2 || eventAck.GetFailure() != nil || len(eventAck.GetRejected()) != 0 {
		t.Errorf("EventAck: %v", eventAck)
	}
	send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "r-1",
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/me"}}}}})
	result := await(func(f *linkpb.Frame) bool { return f.GetRpcResult() != nil }).GetRpcResult()
	if result.GetRequestId() != "r-1" || result.GetTunnel().GetStatus() != 200 || string(result.GetTunnel().GetJsonBody()) != "{}" {
		t.Errorf("RpcResult: %v", result)
	}
	_ = ws.Close(websocket.StatusNormalClosure, "")

	st := s.stats()
	want := map[string]bool{routeRevocations: true, routeWelcome: true, routeHeartbeat: true, routeEventsMerged: true, routeRPC: true,
		routeLinkToken: true, routeMode: mode == "http"}
	for route, called := range want {
		if (st.Routes[route].Calls > 0) != called {
			t.Errorf("the stub answered %s %d times: want it called %v", route, st.Routes[route].Calls, called)
		}
	}
	for route, v := range st.Routes {
		if v.ByStatus["2xx"] != v.Calls {
			t.Errorf("%s: %v of %d calls", route, v.ByStatus, v.Calls)
		}
	}
	if strings.Contains(logs.String(), "level=ERROR") {
		t.Errorf("the gateway logged an error")
	}
}

// lockedBuffer is the gateway's log, written by exec's copying goroutine while the test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}
