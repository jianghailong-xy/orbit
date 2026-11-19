package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link, as little of it as the runners in the container need (docs/runner-link-design.md §5): a runner sends
// its heartbeat only over the link, and its daemon calls too. The stub is its own gateway. POST /api/runner/link-token
// trades the runner credential for a connection token naming this server's /link; the connection says Hello, is
// welcomed in MODE_LINK, and from then on:
//   - a Heartbeat is turned back into the POST /runner/heartbeat body it was made from (link_heartbeat.go in runner-go:
//     the typed fields, every Fact's JSON, and the version the Hello carried) and answered by the heartbeat route, its
//     answer the HeartbeatAck's reconcile_json;
//   - an Rpc's TunnelRequest is answered by the route it names, under /api, as the runner's credential.
//
// It holds no session, sends no hint, renews no token and redirects nowhere. The protocol is runner-go's own (linkpb).

const (
	linkTokenLifetime = 24 * time.Hour
	linkMaxFrame      = 256 << 10 // a frame the runner sends whole; a larger one comes in Chunks, which the stub never needs
	// viaLinkHeader marks a call the link forwards to the stub's routes. It is the stub's own, set only by serve: the
	// HTTP listener drops it from what comes in, so only a beat over the link counts as one.
	viaLinkHeader = "X-Orbit-E2e-Via-Link"
)

// linkToken answers POST /api/runner/link-token: an opaque token for the credential's runner, and where to dial.
func (s *stub) linkToken(w http.ResponseWriter, r *http.Request, rn *runner) {
	tok := "link-" + randomHex(24)
	s.mu.Lock()
	s.linkTokens[tok] = rn
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{
		"token":     tok,
		"expiresAt": time.Now().Add(linkTokenLifetime).UTC().Format(time.RFC3339Nano),
		"linkUrl":   "ws://" + r.Host + "/link",
	})
}

// linkConn is one connection's state: whose it is, what its Hello said, and the heartbeat parts it sent whole, which
// its later beats name by digest only.
type linkConn struct {
	s     *stub
	rn    *runner
	id    string
	ws    *websocket.Conn
	hello *linkpb.Hello
	facts map[string]*linkpb.Fact // by kind: the last one sent whole

	outID uint64
	out   chan *linkpb.Frame
}

func (s *stub) link(w http.ResponseWriter, r *http.Request) {
	tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	rn := s.linkTokens[tok]
	s.seq++
	id := fmt.Sprintf("link-%d", s.seq)
	s.mu.Unlock()
	if rn == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "UNAUTHENTICATED", "reason": "unknown link token"})
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		log.Printf("link: %s (%s): upgrade failed: %v", rn.id, rn.name, err)
		return
	}
	ws.SetReadLimit(linkMaxFrame)
	c := &linkConn{s: s, rn: rn, id: id, ws: ws, facts: map[string]*linkpb.Fact{}, out: make(chan *linkpb.Frame, 64)}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go c.writeLoop(ctx)
	err = c.readLoop(ctx)
	log.Printf("link: %s of %s (%s) ended: %v", c.id, rn.id, rn.name, err)
	_ = ws.CloseNow()
}

// readLoop reads frames until the connection ends. Hello comes first; Heartbeats and Rpcs after it. Any other body is
// one the stub has no use for, and is ignored, as the protocol asks of a receiver.
func (c *linkConn) readLoop(ctx context.Context) error {
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return err
		}
		var f linkpb.Frame
		if typ != websocket.MessageBinary || proto.Unmarshal(data, &f) != nil {
			return fmt.Errorf("a message that is not a link frame")
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_Hello:
			c.hello = body.Hello
			log.Printf("link: %s of %s (%s) welcomed: process %s, orbit %s", c.id, c.rn.id, c.rn.name,
				body.Hello.GetProcessId(), body.Hello.GetRunnerVersion())
			c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{
				ProtocolVersion: 1, Mode: linkpb.Mode_MODE_LINK, HeartbeatIntervalMs: 30000,
				Limits: &linkpb.Limits{MaxFrameBytes: linkMaxFrame}, ConnectionId: c.id,
			}}})
		case *linkpb.Frame_Heartbeat:
			if c.hello == nil {
				return fmt.Errorf("a Heartbeat before Hello")
			}
			if !c.beat(body.Heartbeat) {
				c.send(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{
					Code: linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, Message: "the runner credential is no longer valid"}}})
				return fmt.Errorf("the runner was deleted")
			}
		case *linkpb.Frame_Rpc:
			if c.hello == nil {
				return fmt.Errorf("an Rpc before Hello")
			}
			// Each call on its own: a long poll must not hold up the beats behind it.
			go c.rpc(body.Rpc)
		case *linkpb.Frame_Chunk:
			log.Printf("link: %s of %s (%s) sent a frame in pieces, which the stub does not join; ignored", c.id, c.rn.id, c.rn.name)
		}
	}
}

// beat answers one Heartbeat with the heartbeat route's own answer. It reports false when that route refused the runner
// credential: the runner was deleted.
func (c *linkConn) beat(hb *linkpb.Heartbeat) bool {
	body := map[string]any{
		"leaseOwner": hb.GetProcessId(), "draining": hb.GetDraining(), "idleCapacity": hb.GetIdleCapacity(),
		"supervisedSessionIds": hb.GetSessionIds(), "version": c.hello.GetRunnerVersion(),
	}
	var want []string
	for _, f := range hb.GetFacts() {
		if f.GetJson() != nil {
			c.facts[f.GetKind()] = f
		}
		held := c.facts[f.GetKind()]
		if held == nil || held.GetSha256() != f.GetSha256() {
			want = append(want, f.GetKind())
			continue
		}
		body[f.GetKind()] = json.RawMessage(held.GetJson())
	}
	ack := &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_LINK, BeatId: hb.GetBeatId(), WantFacts: want}
	if len(want) == 0 {
		raw, _ := json.Marshal(body)
		status, answer := c.serve(http.MethodPost, "/runner/heartbeat", raw)
		if status == http.StatusUnauthorized {
			return false
		}
		ack.ReconcileJson = answer
	}
	c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}})
	return true
}

// rpc answers a TunnelRequest with what the route it names answers.
func (c *linkConn) rpc(rpc *linkpb.Rpc) {
	result := &linkpb.RpcResult{RequestId: rpc.GetRequestId()}
	if t := rpc.GetTunnel(); t != nil {
		status, answer := c.serve(t.GetMethod(), t.GetPath(), t.GetJsonBody())
		result.Outcome = &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{Status: uint32(status), JsonBody: answer}}
	} else {
		result.Outcome = &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{Code: "RPC_BAD_REQUEST", Message: "the e2e stub carries only tunnelled calls"}}
	}
	c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: result}})
}

// serve is method and path (a /runner/... route, with its query) asked of the stub's own routes as the connection's
// runner, the way the gateway forwards a call to the control plane.
func (c *linkConn) serve(method, path string, body []byte) (int, []byte) {
	req := httptest.NewRequest(method, "/api"+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+c.rn.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(viaLinkHeader, "1")
	rec := httptest.NewRecorder()
	c.s.handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// send queues f for the connection's writer; a connection too far behind to take it has ended.
func (c *linkConn) send(f *linkpb.Frame) {
	select {
	case c.out <- f:
	default:
		_ = c.ws.CloseNow()
	}
}

func (c *linkConn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case f := <-c.out:
			c.outID++
			f.Id = c.outID
			b, err := proto.Marshal(f)
			if err != nil {
				log.Printf("link: %s: cannot encode a frame: %v", c.id, err)
				continue
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = c.ws.Write(wctx, websocket.MessageBinary, b)
			cancel()
			if err != nil {
				_ = c.ws.CloseNow()
				return
			}
		}
	}
}
