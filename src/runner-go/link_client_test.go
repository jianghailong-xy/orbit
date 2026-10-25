package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// A frame larger than one message travels in Chunks no larger than the limit, and joins back into the same frame.
func TestLinkFrameTravelsInChunksAndJoinsBack(t *testing.T) {
	payload := bytes.Repeat([]byte(`{"text":"é<&>"}`), 50_000) // ~700 KiB
	f := &linkpb.Frame{Id: 7, Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{SessionId: "s",
		Events: []*linkpb.Event{{Seq: 1, Type: "assistant", PayloadJson: payload}}}}}
	next := uint64(7)
	msgs, err := encodeLinkFrame(f, linkMaxFrameBytes, func() uint64 { next++; return next })
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) < 3 {
		t.Fatalf("a %d-byte frame went in %d messages", proto.Size(f), len(msgs))
	}
	var r linkReassembler
	var joined *linkpb.Frame
	for i, m := range msgs {
		if len(m) > linkMaxFrameBytes {
			t.Fatalf("message %d is %d bytes, over the %d a message may carry", i, len(m), linkMaxFrameBytes)
		}
		var piece linkpb.Frame
		if err := proto.Unmarshal(m, &piece); err != nil || piece.GetChunk() == nil {
			t.Fatalf("message %d is not a Chunk: %v", i, err)
		}
		if piece.GetId() != uint64(8+i) || piece.GetChunk().GetFrameId() != 7 {
			t.Fatalf("piece %d is frame %d of frame %d", i, piece.GetId(), piece.GetChunk().GetFrameId())
		}
		got, err := r.add(piece.GetChunk())
		if err != nil {
			t.Fatal(err)
		}
		if (got != nil) != (i == len(msgs)-1) {
			t.Fatalf("piece %d of %d joined a frame: %v", i, len(msgs), got != nil)
		}
		joined = got
	}
	if !proto.Equal(joined, f) {
		t.Fatal("the joined frame is not the frame that was cut")
	}
	if r.held != 0 || len(r.partials) != 0 {
		t.Fatalf("the reassembler still holds %d bytes in %d frames", r.held, len(r.partials))
	}

	small, _ := encodeLinkFrame(&linkpb.Frame{Id: 1, Body: &linkpb.Frame_Hello{Hello: &linkpb.Hello{ProcessId: "p"}}}, linkMaxFrameBytes, nil)
	if len(small) != 1 {
		t.Fatalf("a small frame went in %d messages", len(small))
	}
}

// Pieces out of order, too many frames in pieces, and a frame past the bound are refused.
func TestLinkReassemblerRefusesWhatTheProtocolDoesNot(t *testing.T) {
	var r linkReassembler
	if _, err := r.add(&linkpb.Chunk{FrameId: 1, Index: 1, Data: []byte("x")}); !errors.Is(err, errLinkChunk) {
		t.Errorf("a frame starting at piece 1 = %v", err)
	}
	for id := uint64(10); id < 10+linkMaxPartialFrames; id++ {
		if _, err := r.add(&linkpb.Chunk{FrameId: id, Data: []byte("x")}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.add(&linkpb.Chunk{FrameId: 99, Data: []byte("x")}); !errors.Is(err, errLinkChunk) {
		t.Errorf("one frame in pieces too many = %v", err)
	}
	if _, err := r.add(&linkpb.Chunk{FrameId: 10, Index: 2, Data: []byte("x")}); !errors.Is(err, errLinkChunk) {
		t.Errorf("a piece skipped = %v", err)
	}
	var big linkReassembler
	chunk := bytes.Repeat([]byte("x"), 1<<20)
	var err error
	for i := 0; err == nil && i < 20; i++ {
		_, err = big.add(&linkpb.Chunk{FrameId: 1, Index: uint32(i), Data: chunk})
	}
	if !errors.Is(err, errLinkChunk) {
		t.Errorf("a frame past %d bytes = %v", linkMaxJoinedFrameBytes, err)
	}
}

// The backoff is exponential from 1s to 60s with full jitter: every wait is within its attempt's ceiling, and the
// waits of one attempt spread across it.
func TestLinkBackoffIsFullJitterFromOneSecondToAMinute(t *testing.T) {
	for n := 0; n < 12; n++ {
		ceiling := min(time.Second<<n, time.Minute)
		lo, hi := time.Hour, time.Duration(0)
		for range 2000 {
			d := linkBackoff(n)
			if d <= 0 || d > ceiling+time.Millisecond {
				t.Fatalf("attempt %d waited %s, outside (0, %s]", n, d, ceiling)
			}
			lo, hi = min(lo, d), max(hi, d)
		}
		if lo > ceiling/10 || hi < ceiling*9/10 {
			t.Errorf("attempt %d's waits span %s to %s of (0, %s]: not full jitter", n, lo, hi, ceiling)
		}
	}
}

// Retry-After and retry_after_ms are never undercut; a server without the link and a gateway too new are asked
// again only after about linkLongWait.
func TestLinkRetryWaitHonoursWhatTheServerSaid(t *testing.T) {
	refusal := &linkHTTPError{op: "upgrade", status: 503, code: "DRAINING", retryAfter: 45 * time.Second}
	closed := &linkCloseError{code: linkpb.CloseCode_CLOSE_CODE_RATE_LIMITED, retryAfter: 50 * time.Second}
	notConfigured := &linkHTTPError{op: linkTokenRoute, status: 404, code: "RUNNER_LINK_NOT_CONFIGURED"}
	tooNew := &linkCloseError{code: linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED}
	for range 200 {
		if d := linkRetryWait(refusal, 0); d < 45*time.Second {
			t.Fatalf("a refusal's Retry-After of 45s waited %s", d)
		}
		if d := linkRetryWait(closed, 0); d < 50*time.Second {
			t.Fatalf("a Close's retry_after_ms of 50s waited %s", d)
		}
		for _, err := range []error{notConfigured, tooNew} {
			if d := linkRetryWait(err, 0); d < linkLongWait*3/4 || d > linkLongWait*5/4 {
				t.Fatalf("%v waited %s, want about %s", err, d, linkLongWait)
			}
		}
		if d := linkRetryWait(errors.New("dial tcp: connection refused"), 3); d > 8*time.Second+time.Millisecond {
			t.Fatalf("attempt 3 after a dial error waited %s", d)
		}
	}
	if !linkNotConfigured(notConfigured) || linkNotConfigured(refusal) {
		t.Error("linkNotConfigured does not tell a server without the link from a refusal")
	}
}

// A connection is replaced five minutes before an hour's token expires, by the server's clock: the lifetime comes
// from the claims, so a machine whose clock is off renews on time all the same. A short token renews halfway.
func TestLinkTokenRenewsFiveMinutesAheadOrHalfway(t *testing.T) {
	minted := time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC)
	lifetime, ok := linkTokenLifetime(fakeLinkToken(minted.Add(-48*time.Hour), time.Hour, "p", 1))
	if !ok || lifetime != time.Hour {
		t.Fatalf("lifetime from the claims = %s, %v", lifetime, ok)
	}
	if got := (&linkToken{mintedAt: minted, lifetime: lifetime}).renewAt(); !got.Equal(minted.Add(55 * time.Minute)) {
		t.Errorf("an hour's token renews at %s, want 55 minutes in", got.Sub(minted))
	}
	if got := (&linkToken{mintedAt: minted, lifetime: 4 * time.Minute}).renewAt(); !got.Equal(minted.Add(2 * time.Minute)) {
		t.Errorf("a 4-minute token renews at %s, want halfway", got.Sub(minted))
	}
	if _, ok := linkTokenLifetime("not.a-token"); ok {
		t.Error("a token without claims has a lifetime")
	}
}

// The client trades the runner token for a link token naming its process, reuses it until it is due for renewal,
// and dials the link over TLS: Hello says who the process is, and Welcome names the connection.
func TestLinkClientConnectsOverTLSWithATokenForItsProcess(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	c := newLinkTestClient(cp, "11111111-2222-4333-8444-555555555555", g.roots(), nil)
	conn, err := c.connect(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.ws.CloseNow()
	if conn.id == "" || conn.welcome.GetMode() != linkpb.Mode_MODE_HTTP || conn.token == nil {
		t.Fatalf("welcomed as %q in %s", conn.id, conn.welcome.GetMode())
	}
	conns, _, _, _ := g.snapshot()
	if len(conns) != 1 || conns[0].hello.GetProcessId() != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("the gateway saw %d connections", len(conns))
	}
	tokens := cp.requests("/api/runner/link-token")
	if len(tokens) != 1 || tokens[0].leaseOwner != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("link-token requests: %+v", tokens)
	}
	again, err := c.connect(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer again.ws.CloseNow()
	if n := len(cp.requests("/api/runner/link-token")); n != 1 {
		t.Errorf("a second connection asked for %d tokens in all, want the first one reused", n)
	}
	rtt, err := conn.ping(5 * time.Second)
	if err != nil || rtt <= 0 {
		t.Errorf("ping = %s, %v", rtt, err)
	}
}

// Through a proxy, the client asks it for a tunnel to the link (CONNECT) and speaks TLS to the gateway inside it.
func TestLinkClientDialsThroughTheProxy(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	proxy := newFakeLinkProxy(t)
	host := strings.TrimPrefix(g.URL, "https://")
	c := newLinkTestClient(cp, "11111111-2222-4333-8444-555555555555", g.roots(), proxy.proxyFor(host))
	conn, err := c.connect(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.ws.CloseNow()
	if got := proxy.connected(); len(got) != 1 || got[0] != host {
		t.Fatalf("the proxy was asked for %v, want one tunnel to %s", got, host)
	}
}

// The runner's own client takes its proxy from HTTPS_PROXY, HTTP_PROXY and NO_PROXY, as net/http reads them, and
// trusts the system's roots: HTTP/1.1 only, since a WebSocket upgrade is an HTTP/1.1 request.
func TestLinkClientProxiesAsTheEnvironmentSays(t *testing.T) {
	c := newLinkClient("https://orbit.example/", "token", "p", nil)
	for name, client := range map[string]*http.Client{"api": c.api, "dial": c.dial} {
		tr, ok := client.Transport.(*http.Transport)
		if !ok {
			t.Fatalf("%s client's transport is %T", name, client.Transport)
		}
		if reflect.ValueOf(tr.Proxy).Pointer() != reflect.ValueOf(http.ProxyFromEnvironment).Pointer() {
			t.Errorf("%s client does not proxy by http.ProxyFromEnvironment", name)
		}
		if tr.ForceAttemptHTTP2 || tr.TLSClientConfig == nil || tr.TLSClientConfig.RootCAs != nil {
			t.Errorf("%s client: HTTP/2 %v, TLS config %+v", name, tr.ForceAttemptHTTP2, tr.TLSClientConfig)
		}
	}
	if c.serverURL != "https://orbit.example" {
		t.Errorf("server URL kept as %q", c.serverURL)
	}
}

// A refused upgrade carries its status, code and the longer of Retry-After and retryAfterMs; a 401 drops the token.
func TestLinkClientReadsARefusal(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	status := http.StatusServiceUnavailable
	g.refuse = func(*http.Request) (int, string, string) {
		if status == http.StatusUnauthorized {
			return status, `{"code":"UNAUTHENTICATED","reason":"EXPIRED","message":"the link token expired"}`, ""
		}
		return status, `{"code":"DRAINING","message":"the gateway is draining","retryAfterMs":7000}`, "5"
	}
	c := newLinkTestClient(cp, "11111111-2222-4333-8444-555555555555", g.roots(), nil)
	_, err := c.connect(context.Background(), nil)
	var refused *linkHTTPError
	if !errors.As(err, &refused) || refused.status != 503 || refused.code != "DRAINING" || refused.retryAfter != 7*time.Second {
		t.Fatalf("503 DRAINING = %#v", err)
	}
	status = http.StatusUnauthorized
	_, err = c.connect(context.Background(), nil)
	if !errors.As(err, &refused) || refused.reason != "EXPIRED" || !strings.Contains(err.Error(), "401 UNAUTHENTICATED (EXPIRED)") {
		t.Fatalf("401 = %v", err)
	}
	g.refuse = nil
	conn, err := c.connect(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	conn.ws.CloseNow()
	if n := len(cp.requests("/api/runner/link-token")); n != 2 {
		t.Errorf("%d link tokens asked for: want a new one after the 401", n)
	}
}

// A Close in place of Welcome is a *linkCloseError; for UNAUTHENTICATED the token is dropped.
func TestLinkClientTakesACloseInPlaceOfWelcome(t *testing.T) {
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	c := newLinkTestClient(cp, "11111111-2222-4333-8444-555555555555", g.roots(), nil)
	// A Hello naming another process than the token's.
	c.hello = func() *linkpb.Hello { return linkHello("99999999-2222-4333-8444-555555555555") }
	_, err := c.connect(context.Background(), nil)
	var closed *linkCloseError
	if !errors.As(err, &closed) || closed.code != linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED {
		t.Fatalf("connect = %v", err)
	}
	c.mu.Lock()
	tok := c.tok
	c.mu.Unlock()
	if tok != nil {
		t.Error("the token the gateway refused is kept")
	}
}

// A server without the runner link says so with 404; the client reads it as no link, not as a failure to retry soon.
func TestLinkClientKnowsAServerWithoutTheLink(t *testing.T) {
	cp := newFakeLinkControlPlane(t, "wss://127.0.0.1:1")
	cp.tokenStatus = http.StatusNotFound
	c := newLinkTestClient(cp, "11111111-2222-4333-8444-555555555555", nil, nil)
	_, err := c.connect(context.Background(), nil)
	if !linkNotConfigured(err) || !strings.Contains(err.Error(), "404 RUNNER_LINK_NOT_CONFIGURED") {
		t.Fatalf("connect = %v", err)
	}
}

// Hello says what every HTTPS request's headers say today: the process, the version, the OS, the capabilities, the
// engines and the write contract, and link protocol 1.
func TestLinkHelloSaysWhatTheRequestHeadersSay(t *testing.T) {
	h := linkHello("11111111-2222-4333-8444-555555555555")
	if h.GetProcessId() != "11111111-2222-4333-8444-555555555555" || h.GetRunnerVersion() != version ||
		h.GetMinProtocolVersion() != 1 || h.GetMaxProtocolVersion() != 1 || h.GetOs() == "" {
		t.Fatalf("Hello = %v", h)
	}
	if got := strings.Join(h.GetCapabilities(), ","); got != runnerCapabilitiesV1 {
		t.Errorf("capabilities %q, want the header's %q", got, runnerCapabilitiesV1)
	}
	if got := strings.Join(h.GetSupportedProviders(), ","); got != supportedProvidersHeader() {
		t.Errorf("providers %q, want the header's %q", got, supportedProvidersHeader())
	}
	wc := h.GetWriteContract()
	if wc.GetCapabilityRevision() != runnerWriteCapabilityRevision || wc.GetSchemaRevision() != runnerWriteSchemaRevision ||
		wc.GetContractDigest() != runnerWriteContractDigest {
		t.Errorf("write contract %v", wc)
	}
}
