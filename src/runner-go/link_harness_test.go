package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link tests' doubles: a control plane that mints link tokens and takes heartbeats and event batches, a
// link gateway over TLS that greets and answers, and a proxy that tunnels, refuses or intercepts.

// ── The control plane ───────────────────────────────────────────────────────────────────────────

// fakeLinkControlPlane answers POST /api/runner/link-token with tokens for linkURL, and every other runner route with
// 200, recording what each request carried.
type fakeLinkControlPlane struct {
	*httptest.Server
	mu       sync.Mutex
	linkURL  string
	lifetime time.Duration
	// tokenStatus, when set, is how link-token requests are refused.
	tokenStatus int
	tokens      int
	// status, when it says so, is how a route answers instead of 200.
	status func(path string) int
	// discardBodies keeps the work path's requests without their bodies.
	discardBodies bool
	received      []fakeLinkRequest
	// delegate, when set, answers every request but the link-token one, in place of 200.
	delegate http.HandlerFunc
}

type fakeLinkRequest struct {
	method, path string
	body         []byte
	leaseOwner   string // a link-token request's
}

func newFakeLinkControlPlane(t *testing.T, linkURL string) *fakeLinkControlPlane {
	t.Helper()
	cp := &fakeLinkControlPlane{linkURL: linkURL, lifetime: time.Hour}
	cp.Server = httptest.NewServer(http.HandlerFunc(cp.serve))
	t.Cleanup(cp.Close)
	return cp
}

func (cp *fakeLinkControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	cp.mu.Lock()
	defer cp.mu.Unlock()
	rec := fakeLinkRequest{method: r.Method, path: r.URL.Path, body: body}
	if r.URL.Path == "/api/runner/link-token" {
		var req struct {
			LeaseOwner string `json:"leaseOwner"`
		}
		_ = json.Unmarshal(body, &req)
		rec.leaseOwner = req.LeaseOwner
		cp.received = append(cp.received, rec)
		if cp.tokenStatus != 0 {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(cp.tokenStatus)
			_, _ = w.Write([]byte(`{"code":"RUNNER_LINK_NOT_CONFIGURED","message":"The runner link is not configured on this server."}`))
			return
		}
		cp.tokens++
		now := time.Now()
		tok := fakeLinkToken(now, cp.lifetime, req.LeaseOwner, cp.tokens)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token": tok, "expiresAt": now.Add(cp.lifetime).UTC().Format(time.RFC3339Nano), "cellId": "cell-1", "linkUrl": cp.linkURL,
		})
		return
	}
	if cp.discardBodies {
		rec.body = nil
	}
	cp.received = append(cp.received, rec)
	if cp.delegate != nil {
		r.Body = io.NopCloser(bytes.NewReader(body))
		cp.mu.Unlock()
		cp.delegate(w, r)
		cp.mu.Lock()
		return
	}
	if cp.status != nil {
		if code := cp.status(r.URL.Path); code != 0 {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"code":"REFUSED_FOR_THE_TEST"}`))
			return
		}
	}
	_, _ = w.Write([]byte(`{}`))
}

// everything is what reached the control plane, in order.
func (cp *fakeLinkControlPlane) everything() []fakeLinkRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]fakeLinkRequest{}, cp.received...)
}

// requests is what reached path, in order.
func (cp *fakeLinkControlPlane) requests(path string) []fakeLinkRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	var out []fakeLinkRequest
	for _, r := range cp.received {
		if r.path == path {
			out = append(out, r)
		}
	}
	return out
}

// fakeLinkToken is a compact JWS with the claims the runner reads (iat, exp) and the gateway checks; its signature
// is no signature, which the fake gateway does not check.
func fakeLinkToken(now time.Time, lifetime time.Duration, leaseOwner string, n int) string {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": "orbit-runner-link", "iat": now.Unix(), "exp": now.Add(lifetime).Unix(), "leaseOwner": leaseOwner,
		"jti": strconv.Itoa(n),
	})
	return header + "." + enc.EncodeToString(claims) + "." + enc.EncodeToString([]byte("unsigned"))
}

// ── The gateway ─────────────────────────────────────────────────────────────────────────────────

// fakeLinkGateway is a link gateway over TLS for the tests of the connection itself: it checks the token names the
// Hello's process, greets with Welcome in MODE_HTTP, and answers every Heartbeat and Rpc.
type fakeLinkGateway struct {
	*httptest.Server
	t *testing.T

	mu       sync.Mutex
	conns    []*fakeLinkConn
	upgrades []time.Time
	// refuse, when it says so, refuses an upgrade with that status, body and Retry-After.
	refuse func(r *http.Request) (status int, body, retryAfter string)
	// stall, when set, stops reading a connection once it is welcomed: a gateway that takes no more.
	stall bool
}

type fakeLinkConn struct {
	g        *fakeLinkGateway
	id       string
	ws       *websocket.Conn
	hello    *linkpb.Hello
	writeMu  sync.Mutex
	outID    uint64
	welcomed time.Time
	// ended is when reading it stopped, and status the client's close status (-1: none).
	ended  time.Time
	status websocket.StatusCode
	done   chan struct{}
}

func newFakeLinkGateway(t *testing.T) *fakeLinkGateway {
	t.Helper()
	g := &fakeLinkGateway{t: t}
	g.Server = httptest.NewUnstartedServer(http.HandlerFunc(g.serve))
	g.StartTLS()
	t.Cleanup(func() {
		g.mu.Lock()
		conns := append([]*fakeLinkConn{}, g.conns...)
		g.mu.Unlock()
		for _, c := range conns {
			_ = c.ws.CloseNow()
		}
		g.Close()
	})
	return g
}

// linkURL is the gateway's wss:// address.
func (g *fakeLinkGateway) linkURL() string { return "wss://" + strings.TrimPrefix(g.URL, "https://") }

// roots trusts the gateway's certificate.
func (g *fakeLinkGateway) roots() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(g.Certificate())
	return pool
}

func (g *fakeLinkGateway) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.upgrades = append(g.upgrades, time.Now())
	refuse := g.refuse
	g.mu.Unlock()
	if refuse != nil {
		if status, body, retryAfter := refuse(r); status != 0 {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.Header().Set("Connection", "close")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
			return
		}
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 20)
	g.mu.Lock()
	c := &fakeLinkConn{g: g, id: fmt.Sprintf("c-%016x", len(g.conns)+1), ws: ws, status: -1, done: make(chan struct{})}
	g.conns = append(g.conns, c)
	stall := g.stall
	g.mu.Unlock()
	defer close(c.done)
	var chunks linkReassembler
	read := func() (*linkpb.Frame, error) {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return nil, err
			}
			var f linkpb.Frame
			if err := proto.Unmarshal(data, &f); err != nil {
				return nil, err
			}
			if piece := f.GetChunk(); piece != nil {
				joined, err := chunks.add(piece)
				if err != nil {
					return nil, err
				}
				if joined == nil {
					continue
				}
				return joined, nil
			}
			return &f, nil
		}
	}
	first, err := read()
	if err != nil || first.GetHello() == nil {
		_ = ws.Close(websocket.StatusProtocolError, "Hello first")
		return
	}
	if lease := fakeLinkTokenLease(r.Header.Get("Authorization")); !strings.EqualFold(lease, first.GetHello().GetProcessId()) {
		c.send(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{Code: linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED,
			Message: "Hello.process_id is not the process the link token was issued to"}}})
		_ = ws.Close(websocket.StatusPolicyViolation, "unauthenticated")
		return
	}
	g.mu.Lock()
	c.hello, c.welcomed = first.GetHello(), time.Now()
	g.mu.Unlock()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{ProtocolVersion: 1, Mode: linkpb.Mode_MODE_HTTP,
		HeartbeatIntervalMs: 30000, Limits: &linkpb.Limits{MaxFrameBytes: linkMaxFrameBytes}, ConnectionId: c.id}}})
	if stall {
		<-r.Context().Done()
		return
	}
	for {
		f, err := read()
		if err != nil {
			g.mu.Lock()
			c.ended, c.status = time.Now(), websocket.CloseStatus(err)
			g.mu.Unlock()
			return
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_Heartbeat:
			c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_HTTP}}})
		case *linkpb.Frame_Rpc:
			c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: body.Rpc.GetRequestId(),
				Outcome: &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{Code: "LINK_MODE_HTTP"}}}}})
		}
	}
}

// fakeLinkTokenLease is the leaseOwner claim of the bearer token in authorization.
func fakeLinkTokenLease(authorization string) string {
	parts := strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		LeaseOwner string `json:"leaseOwner"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.LeaseOwner
}

func (c *fakeLinkConn) send(f *linkpb.Frame) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.outID++
	f.Id = c.outID
	b, _ := proto.Marshal(f)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageBinary, b)
}

// snapshot is what the gateway has seen so far.
func (g *fakeLinkGateway) snapshot() (conns []*fakeLinkConn, upgrades []time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]*fakeLinkConn{}, g.conns...), append([]time.Time{}, g.upgrades...)
}

// linkWaitFor polls cond until it holds or d passes.
func linkWaitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", d, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ── The comparison, by src/link-gateway/README.md ──────────────────────────────────────────────

// ── The proxy ───────────────────────────────────────────────────────────────────────────────────

// fakeLinkProxy is an HTTP proxy that answers CONNECT. It tunnels by default; refuse makes it refuse with that
// status; mitm makes it end TLS itself, with mitmCert, and hand the requests inside to mitmHandler (nil: forward
// them to the target over TLS, which mitmRoots verifies).
type fakeLinkProxy struct {
	*httptest.Server
	mu          sync.Mutex
	connects    []string
	refuse      int
	mitmCert    *tls.Certificate
	mitmHandler http.Handler
}

func newFakeLinkProxy(t *testing.T) *fakeLinkProxy {
	t.Helper()
	p := &fakeLinkProxy{}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Close)
	return p
}

// proxyFor is a proxy function that sends what goes to host through p, and everything else directly: NO_PROXY for
// the control plane.
func (p *fakeLinkProxy) proxyFor(host string) func(*http.Request) (*url.URL, error) {
	u, _ := url.Parse(p.URL)
	return func(r *http.Request) (*url.URL, error) {
		if r.URL.Host == host {
			return u, nil
		}
		return nil, nil
	}
}

func (p *fakeLinkProxy) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "this proxy only tunnels", http.StatusMethodNotAllowed)
		return
	}
	p.mu.Lock()
	p.connects = append(p.connects, r.Host)
	refuse, cert, handler := p.refuse, p.mitmCert, p.mitmHandler
	p.mu.Unlock()
	if refuse != 0 {
		w.WriteHeader(refuse)
		return
	}
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	if cert != nil {
		tconn := tls.Server(&linkBufferedConn{Conn: conn, r: buf.Reader}, &tls.Config{Certificates: []tls.Certificate{*cert}})
		srv := &http.Server{Handler: handler}
		_ = srv.Serve(&linkOneConnListener{conn: tconn})
		return
	}
	target, err := net.Dial("tcp", r.Host)
	if err != nil {
		return
	}
	defer target.Close()
	go func() { _, _ = io.Copy(target, buf); _ = target.(*net.TCPConn).CloseWrite() }()
	_, _ = io.Copy(conn, target)
}

func (p *fakeLinkProxy) connected() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.connects...)
}

// linkBufferedConn is a hijacked connection read through the buffer that already holds some of it.
type linkBufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *linkBufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// linkOneConnListener serves one connection, then says it is closed once that connection is.
type linkOneConnListener struct {
	conn net.Conn
	once sync.Once
	done chan struct{}
	mu   sync.Mutex
}

func (l *linkOneConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.done == nil {
		l.done = make(chan struct{})
	}
	done := l.done
	l.mu.Unlock()
	var c net.Conn
	l.once.Do(func() { c = &linkNotifyConn{Conn: l.conn, closed: done} })
	if c != nil {
		return c, nil
	}
	<-done
	return nil, net.ErrClosed
}
func (l *linkOneConnListener) Close() error   { return nil }
func (l *linkOneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

type linkNotifyConn struct {
	net.Conn
	closed chan struct{}
	once   sync.Once
}

func (c *linkNotifyConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// linkTestCert is a self-signed certificate for 127.0.0.1 and localhost: one no client trusts unless told to.
func linkTestCert(t *testing.T, name string) (*tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, leaf
}

// linkWebSocketAccept is the Sec-WebSocket-Accept a server answers key with (RFC 6455 §4.2.2).
func linkWebSocketAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// ── The runner side ─────────────────────────────────────────────────────────────────────────────

// linkTestLog collects what the shadow logs.
type linkTestLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *linkTestLog) log(args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.TrimSuffix(fmt.Sprintln(args...), "\n"))
}

func (l *linkTestLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.lines...)
}

// newLinkTestClient is a link client for processID whose dials trust g and go through proxy (nil: none).
func newLinkTestClient(cp *fakeLinkControlPlane, processID string, roots *x509.CertPool, proxy func(*http.Request) (*url.URL, error)) *linkClient {
	c := newLinkClient(cp.URL, "runner-token", processID, func() *linkpb.Hello { return linkHello(processID) })
	c.api = &http.Client{Transport: newLinkHTTPTransport(nil, nil)}
	c.dial = &http.Client{Transport: newLinkHTTPTransport(proxy, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})}
	return c
}

// linkTestHeartbeat is a heartbeat with something in every kind of member.
func linkTestHeartbeat(leaseOwner string) HeartbeatRequest {
	runsAsRoot := false
	free := uint64(1<<62 + 1)
	return HeartbeatRequest{
		Status: "ONLINE", IdleCapacity: 3, Version: version, LeaseOwner: leaseOwner,
		SupervisedSessionIDs: []string{"session-b", "session-a"},
		Commands:             []SlashCommandInfo{{Name: "review", Description: "Review <changes> & report → naïve café 中文"}},
		RuntimeDefaultModels: map[string]string{},
		Engines:              []EngineHealthReport{{Engine: "claude", Installed: true, Version: "2.1.300", Auth: "yes"}},
		AgentDirProbes:       []AgentDirProbe{{AgentID: "a1", WorkDir: "~/w", Exists: true, IsGitRepo: true, FreeBytes: &free}},
		ReposRoot:            "/srv/repos/é",
		RunsAsRoot:           &runsAsRoot,
		SelfUpdate:           &SelfUpdateReport{State: "enabled"},
	}
}

// linkTestEvents is a batch of n events from seq from, with a payload of about payloadBytes in every third.
func linkTestEvents(from, n int, payloadBytes int) RunEventBatch {
	var batch RunEventBatch
	for i := 0; i < n; i++ {
		ev := RunEvent{Seq: from + i, Type: "assistant", TS: nowISO(), TurnID: "turn-1",
			Payload: map[string]interface{}{"text": fmt.Sprintf("<b>step %d</b> & \"quotes\" → 中文 %s", from+i,
				strings.Repeat("x", payloadBytes)), "n": 1.5, "list": []interface{}{1, "two", nil, true}}}
		switch i % 3 {
		case 1:
			ev.Payload, ev.TurnID = nil, "" // payload null, no turn
		case 2:
			ev.Type = "tool_result"
		}
		batch.Events = append(batch.Events, ev)
	}
	return batch
}
