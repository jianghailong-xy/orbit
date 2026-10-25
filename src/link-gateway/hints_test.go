package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/encoding/protojson"

	"orbit/link-gateway/linkpb"
)

// The runner hints the gateway relays from NATS (hints.go). The NATS server is a stand-in that speaks the client
// protocol to the real nats.go client; TestHintsOverARealNATSServer runs the same relay against a real nats-server
// when LINK_TEST_NATS_URL names one, and scripts/runner-link/staging-check.sh does so in the staging stack.

// A second runner beside gateway_test.go's runnerA.
const runnerB = "0190a0b0-0000-7000-8000-00000000000b"

// natsStandIn is a NATS server as a subscribing client sees it: INFO first, PONG to PING, SUB and UNSUB, and a MSG for
// every PUB on a subject a client subscribed to. Exact subjects only, which is all the gateway subscribes to.
type natsStandIn struct {
	t       testing.TB
	ln      net.Listener
	addr    string
	mu      sync.Mutex
	clients map[*natsClient]struct{}
	// ops is every SUB and UNSUB received, as "SUB <subject>" or "UNSUB <subject>", in order.
	ops []string
	// published is every message a client published, by subject, in order: what the gateway sent on NATS.
	published map[string][][]byte
}

type natsClient struct {
	conn net.Conn
	wmu  sync.Mutex
	subs map[string]string // sid → subject
}

// listenNATS serves on addr; "127.0.0.1:0" picks a port.
func listenNATS(t testing.TB, addr string) *natsStandIn {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	s := &natsStandIn{t: t, ln: ln, addr: ln.Addr().String(), clients: map[*natsClient]struct{}{}, published: map[string][][]byte{}}
	go s.accept()
	t.Cleanup(s.close)
	return s
}

func (s *natsStandIn) url() string { return "nats://" + s.addr }

func (s *natsStandIn) accept() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		c := &natsClient{conn: conn, subs: map[string]string{}}
		s.mu.Lock()
		s.clients[c] = struct{}{}
		s.mu.Unlock()
		go s.serve(c)
	}
}

func (s *natsStandIn) serve(c *natsClient) {
	defer func() {
		s.mu.Lock()
		delete(s.clients, c)
		s.mu.Unlock()
		_ = c.conn.Close()
	}()
	port := s.ln.Addr().(*net.TCPAddr).Port
	info, _ := json.Marshal(map[string]any{
		"server_id": "NATSSTANDIN", "server_name": "hints_test", "version": "2.15.1", "proto": 1, "go": "go1.27.3",
		"host": "127.0.0.1", "port": port, "headers": true, "max_payload": 1 << 20, "client_id": 1,
	})
	c.write("INFO " + string(info) + "\r\n")
	r := bufio.NewReader(c.conn)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		f := strings.Fields(strings.TrimRight(line, "\r\n"))
		if len(f) == 0 {
			continue
		}
		switch strings.ToUpper(f[0]) {
		case "PING":
			c.write("PONG\r\n")
		case "SUB": // SUB <subject> [queue] <sid>
			s.mu.Lock()
			c.subs[f[len(f)-1]] = f[1]
			s.ops = append(s.ops, "SUB "+f[1])
			s.mu.Unlock()
		case "UNSUB": // UNSUB <sid> [max]
			s.mu.Lock()
			s.ops = append(s.ops, "UNSUB "+c.subs[f[1]])
			delete(c.subs, f[1])
			s.mu.Unlock()
		case "PUB": // PUB <subject> [reply] <size>
			size, _ := strconv.Atoi(f[len(f)-1])
			payload := make([]byte, size+2)
			if _, err := io.ReadFull(r, payload); err != nil {
				return
			}
			s.record(f[1], payload[:size])
			s.publish(f[1], payload[:size])
		case "HPUB": // HPUB <subject> [reply] <header size> <total size>
			hdr, _ := strconv.Atoi(f[len(f)-2])
			total, _ := strconv.Atoi(f[len(f)-1])
			payload := make([]byte, total+2)
			if _, err := io.ReadFull(r, payload); err != nil {
				return
			}
			s.record(f[1], payload[hdr:total])
		}
		// CONNECT and PONG need no answer from a server that is not asked for +OK.
	}
}

func (c *natsClient) write(s string) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, _ = c.conn.Write([]byte(s))
}

// publish delivers payload on subject to every subscriber, as the apiserver's publish would, and says to how many.
func (s *natsStandIn) publish(subject string, payload []byte) int {
	s.mu.Lock()
	type target struct {
		c   *natsClient
		sid string
	}
	var targets []target
	for c := range s.clients {
		for sid, subj := range c.subs {
			if subj == subject {
				targets = append(targets, target{c, sid})
			}
		}
	}
	s.mu.Unlock()
	for _, t := range targets {
		t.c.write(fmt.Sprintf("MSG %s %s %d\r\n%s\r\n", subject, t.sid, len(payload), payload))
	}
	return len(targets)
}

func (s *natsStandIn) record(subject string, payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.published[subject] = append(s.published[subject], slices.Clone(payload))
}

// publishedOn is what clients published on subject so far.
func (s *natsStandIn) publishedOn(subject string) [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.published[subject])
}

// publishedUnder is every subject clients published on that starts with prefix.
func (s *natsStandIn) publishedUnder(prefix string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for subject := range s.published {
		if strings.HasPrefix(subject, prefix) {
			out = append(out, subject)
		}
	}
	slices.Sort(out)
	return out
}

// deliverMsg delivers payload on subject as the apiserver publishes it with headers and a reply subject: an HMSG when
// there are headers, a MSG with a reply subject otherwise.
func (s *natsStandIn) deliverMsg(subject, reply string, header map[string]string, payload []byte) int {
	s.mu.Lock()
	type target struct {
		c   *natsClient
		sid string
	}
	var targets []target
	for c := range s.clients {
		for sid, subj := range c.subs {
			if subj == subject {
				targets = append(targets, target{c, sid})
			}
		}
	}
	s.mu.Unlock()
	replyField := ""
	if reply != "" {
		replyField = " " + reply
	}
	for _, t := range targets {
		if len(header) == 0 {
			t.c.write(fmt.Sprintf("MSG %s %s%s %d\r\n%s\r\n", subject, t.sid, replyField, len(payload), payload))
			continue
		}
		var h strings.Builder
		h.WriteString("NATS/1.0\r\n")
		for k, v := range header {
			h.WriteString(k + ": " + v + "\r\n")
		}
		h.WriteString("\r\n")
		t.c.write(fmt.Sprintf("HMSG %s %s%s %d %d\r\n%s%s\r\n", subject, t.sid, replyField, h.Len(), h.Len()+len(payload), h.String(), payload))
	}
	return len(targets)
}

// subscribers is how many subscriptions there are on subject.
func (s *natsStandIn) subscribers(subject string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for c := range s.clients {
		for _, subj := range c.subs {
			if subj == subject {
				n++
			}
		}
	}
	return n
}

func (s *natsStandIn) opsLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.ops)
}

// dropClients ends every client connection, as a NATS server that restarts.
func (s *natsStandIn) dropClients() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.clients {
		_ = c.conn.Close()
	}
}

func (s *natsStandIn) close() {
	_ = s.ln.Close()
	s.dropClients()
}

// relayTo starts the gateway's relay on url, before any runner connects, and stops it at the end of the test.
func relayTo(t *testing.T, h *harness, url string) *hintRelay {
	t.Helper()
	relay, err := startHintRelay(h.g, url)
	if err != nil {
		t.Fatal(err)
	}
	h.g.hints = relay
	t.Cleanup(relay.close)
	return relay
}

// The messages the apiserver publishes, as its encoder writes them (testdata/b1-hints.json).
func claimHint() []byte    { return []byte(`{"hint":{"claim":{}}}`) }
func commandsHint() []byte { return []byte(`{"hint":{"commands":{}}}`) }
func inboxHint(sessionID string) []byte {
	return []byte(`{"hint":{"inbox":{"sessionId":"` + sessionID + `"}}}`)
}
func approvalHint(sessionID, approvalID string) []byte {
	return []byte(`{"hint":{"approval":{"sessionId":"` + sessionID + `","approvalId":"` + approvalID + `"}}}`)
}

// quiet checks that the runner was sent nothing for a moment.
func (tc *testConn) quiet(d time.Duration) {
	tc.t.Helper()
	select {
	case f := <-tc.frames:
		tc.t.Fatalf("the runner was sent %s", summarize(f))
	case <-time.After(d):
	}
}

func TestHintFixturesDecodeStrictly(t *testing.T) {
	raw, err := os.ReadFile("testdata/b1-hints.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		GeneratedBy string `json:"generatedBy"`
		Cases       []struct {
			Name     string                     `json:"name"`
			RunnerID string                     `json:"runnerId"`
			Hint     map[string]json.RawMessage `json:"hint"`
			Subject  string                     `json:"subject"`
			Message  string                     `json:"message"`
			Headers  map[string]string          `json:"headers"`
		} `json:"cases"`
		Requests []struct {
			Name, RunnerID, SessionID, RequestID, Subject, Message string
		} `json:"requests"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fixture.GeneratedBy, "runner-hints.ts") {
		t.Fatalf("generatedBy %q: the fixtures must come from the apiserver's encoder", fixture.GeneratedBy)
	}
	var kinds []string
	for _, c := range fixture.Cases {
		// Strict: a field the proto does not have, a renamed one included, is an error rather than ignored.
		var f linkpb.Frame
		if err := protojson.Unmarshal([]byte(c.Message), &f); err != nil {
			t.Fatalf("%s: %s does not decode as a Frame: %v", c.Name, c.Message, err)
		}
		if f.GetId() != 0 || f.GetHint() == nil {
			t.Fatalf("%s: want a Frame with only hint set, got %s", c.Name, summarize(&f))
		}
		if c.Subject != hintSubjectPrefix+c.RunnerID {
			t.Fatalf("%s: subject %q is not %s<runnerId>", c.Name, c.Subject, hintSubjectPrefix)
		}
		if len(c.Hint) != 1 {
			t.Fatalf("%s: the fixture names %d kinds", c.Name, len(c.Hint))
		}
		for kind, body := range c.Hint {
			if got := hintKind(f.GetHint()); got != kind {
				t.Fatalf("%s: decoded as a %s hint, want %s", c.Name, got, kind)
			}
			if kind == "inbox" {
				var inbox struct {
					SessionID string `json:"sessionId"`
				}
				_ = json.Unmarshal(body, &inbox)
				if inbox.SessionID == "" || f.GetHint().GetInbox().GetSessionId() != inbox.SessionID {
					t.Fatalf("%s: session %q, want %q", c.Name, f.GetHint().GetInbox().GetSessionId(), inbox.SessionID)
				}
			}
			if kind == "approval" {
				var a struct {
					SessionID  string `json:"sessionId"`
					ApprovalID string `json:"approvalId"`
				}
				_ = json.Unmarshal(body, &a)
				got := f.GetHint().GetApproval()
				if a.SessionID == "" || a.ApprovalID == "" || got.GetSessionId() != a.SessionID || got.GetApprovalId() != a.ApprovalID {
					t.Fatalf("%s: decoded %v, want %+v", c.Name, got, a)
				}
			}
			if kind == "watchers" {
				var w struct {
					SessionID string `json:"sessionId"`
					Watchers  uint32 `json:"watchers"`
				}
				_ = json.Unmarshal(body, &w)
				got := f.GetHint().GetWatchers()
				if w.SessionID == "" || got.GetSessionId() != w.SessionID || got.GetWatchers() != w.Watchers {
					t.Fatalf("%s: decoded %v, want %+v", c.Name, got, w)
				}
				// The instance it counts for is named in a header, which the gateway sums by.
				if c.Headers[instanceHeader] == "" {
					t.Fatalf("%s: no %s header", c.Name, instanceHeader)
				}
			}
			kinds = append(kinds, kind)
		}
	}
	slices.Sort(kinds)
	if !slices.Equal(kinds, []string{"approval", "claim", "commands", "inbox", "watchers"}) {
		t.Fatalf("fixtures cover %v, want every kind the apiserver publishes: approval, claim, commands, inbox, watchers", kinds)
	}
	if len(fixture.Requests) == 0 {
		t.Fatal("no turn prefix request in the fixture")
	}
	for _, r := range fixture.Requests {
		var f linkpb.Frame
		if err := protojson.Unmarshal([]byte(r.Message), &f); err != nil {
			t.Fatalf("%s: %s does not decode as a Frame: %v", r.Name, r.Message, err)
		}
		req := f.GetTurnPrefixRequest()
		if req == nil || req.GetRequestId() != r.RequestID || req.GetSessionId() != r.SessionID || r.Subject != hintSubjectPrefix+r.RunnerID {
			t.Fatalf("%s: decoded %s", r.Name, summarize(&f))
		}
	}
}

func TestHintsReachTheRunnerTheyNameAndNoOther(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relayTo(t, h, nats.url())
	a, _ := h.connect(runnerA, processA)
	b, _ := h.connect(runnerB, processB)
	eventually(t, 5*time.Second, "both runners' subjects subscribed", func() bool {
		return nats.subscribers("rnr."+runnerA) == 1 && nats.subscribers("rnr."+runnerB) == 1
	})

	if n := nats.publish("rnr."+runnerA, claimHint()); n != 1 {
		t.Fatalf("delivered to %d subscribers", n)
	}
	if got := a.expect("hint", 5*time.Second).GetHint(); got.GetClaim() == nil {
		t.Fatalf("A was sent %v, want a claim hint", got)
	}
	b.quiet(300 * time.Millisecond)

	nats.publish("rnr."+runnerB, inboxHint("0190a0b0-0000-7000-8000-0000000000b1"))
	if got := b.expect("hint", 5*time.Second).GetHint().GetInbox().GetSessionId(); got != "0190a0b0-0000-7000-8000-0000000000b1" {
		t.Fatalf("B's inbox hint names session %q", got)
	}
	nats.publish("rnr."+runnerB, commandsHint())
	if b.expect("hint", 5*time.Second).GetHint().GetCommands() == nil {
		t.Fatal("B was not sent its commands hint")
	}
	a.quiet(300 * time.Millisecond)

	nats.publish("rnr."+runnerA, approvalHint("0190a0b0-0000-7000-8000-0000000000a1", "0190a0b0-0000-7000-8000-0000000000f1"))
	if got := a.expect("hint", 5*time.Second).GetHint().GetApproval(); got.GetSessionId() != "0190a0b0-0000-7000-8000-0000000000a1" ||
		got.GetApprovalId() != "0190a0b0-0000-7000-8000-0000000000f1" {
		t.Fatalf("A's approval hint names %v", got)
	}
	b.quiet(300 * time.Millisecond)

	m := h.g.metrics
	for _, c := range []struct {
		kind string
		want float64
	}{{"claim", 1}, {"inbox", 1}, {"commands", 1}, {"approval", 1}} {
		eventually(t, 5*time.Second, "the "+c.kind+" hint counted", func() bool { return m.hints.get(c.kind, "sent") >= c.want })
		if got := m.hints.get(c.kind, "sent"); got != c.want {
			t.Fatalf("link_hints_total{kind=%q,result=\"sent\"} = %v, want %v", c.kind, got, c.want)
		}
	}
}

func TestEveryConnectionOfTheRunnerIsSentItsHints(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relayTo(t, h, nats.url())
	// Two processes of one runner across a self-update: either may be the one to act, and the runner dedupes. The hint
	// is published the moment the second has its Welcome, on the subscription the first holds: it reaches both.
	oldProcess, _ := h.connect(runnerA, processA)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	newProcess, _ := h.connect(runnerA, processC)
	nats.publish("rnr."+runnerA, claimHint())
	for _, tc := range []*testConn{oldProcess, newProcess} {
		if tc.expect("hint", 5*time.Second).GetHint().GetClaim() == nil {
			t.Fatal("a connection of A was not sent the claim hint")
		}
	}
	// Counted once the relay has offered it to every connection, which can be just after both have it.
	eventually(t, 5*time.Second, "the hint counted", func() bool { return h.g.metrics.hints.get("claim", "sent") >= 1 })
	newProcess.quiet(300 * time.Millisecond)
	if got := h.g.metrics.hints.get("claim", "sent"); got != 1 {
		t.Fatalf("one hint counted %v times", got)
	}
}

func TestTheSubscriptionLastsFromTheFirstConnectionToTheLast(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relay := relayTo(t, h, nats.url())
	eventually(t, 5*time.Second, "the relay connected", func() bool { return h.g.metrics.natsConnected.get() == 1 })
	if got := relay.subscribed(); len(got) != 0 {
		t.Fatalf("subscribed to %v with no runner connected", got)
	}

	first, _ := h.connect(runnerA, processA)
	second, _ := h.connect(runnerA, processC)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	// The gauge moves just after the client has the subscription, which can carry it to the server first.
	eventually(t, 5*time.Second, "link_hint_subscriptions 1", func() bool { return h.g.metrics.hintSubscriptions.get() == 1 })
	second.quiet(100 * time.Millisecond)
	if got := h.g.metrics.hintSubscriptions.get(); got != 1 {
		t.Fatalf("link_hint_subscriptions = %v with one runner connected twice", got)
	}

	_ = first.ws.CloseNow()
	eventually(t, 5*time.Second, "the first connection gone", func() bool { return h.g.reg.count() == 1 })
	nats.publish("rnr."+runnerA, claimHint())
	if second.expect("hint", 5*time.Second).GetHint().GetClaim() == nil {
		t.Fatal("the connection left was not sent the hint")
	}

	_ = second.ws.CloseNow()
	eventually(t, 5*time.Second, "A's subject unsubscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 0 })
	eventually(t, 5*time.Second, "link_hint_subscriptions 0", func() bool { return h.g.metrics.hintSubscriptions.get() == 0 })
	if got, want := nats.opsLog(), []string{"SUB rnr." + runnerA, "UNSUB rnr." + runnerA}; !slices.Equal(got, want) {
		t.Fatalf("NATS saw %v, want %v", got, want)
	}
}

func TestInModeHTTPAHintIsCountedAndNotSent(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, nil) // MODE_HTTP, as every connection is until the gateway forwards
	relayTo(t, h, nats.url())
	a, w := h.connect(runnerA, processA)
	if w.GetMode() != linkpb.Mode_MODE_HTTP {
		t.Fatalf("Welcome says %v", w.GetMode())
	}
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	nats.publish("rnr."+runnerA, claimHint())
	nats.publish("rnr."+runnerA, inboxHint("0190a0b0-0000-7000-8000-0000000000a1"))
	nats.publish("rnr."+runnerA, approvalHint("0190a0b0-0000-7000-8000-0000000000a1", "0190a0b0-0000-7000-8000-0000000000f1"))
	eventually(t, 5*time.Second, "the three hints counted", func() bool {
		return h.g.metrics.hints.get("claim", "mode_http") == 1 && h.g.metrics.hints.get("inbox", "mode_http") == 1 &&
			h.g.metrics.hints.get("approval", "mode_http") == 1
	})
	a.quiet(300 * time.Millisecond)
	// Logged just after it is counted.
	eventually(t, 5*time.Second, "the hint in the frame log", func() bool {
		return strings.Contains(h.logs.String(), "kind=claim result=mode_http")
	})
}

func TestWhatIsNotAHintIsCountedAndTheConnectionStays(t *testing.T) {
	nats := listenNATS(t, "127.0.0.1:0")
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relayTo(t, h, nats.url())
	a, _ := h.connect(runnerA, processA)
	eventually(t, 5*time.Second, "A's subject subscribed", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	for _, message := range []string{
		`not json`,
		`{"hint":{}}`,                       // a hint of no kind, such as a newer apiserver's kind
		`{"close":{"message":"not yours"}}`, // another frame body: nothing but hints is relayed
		`{"hint":{"claim":{}},"unknownField":1}`,
	} {
		nats.publish("rnr."+runnerA, []byte(message))
	}
	eventually(t, 5*time.Second, "three counted as not hints", func() bool {
		return h.g.metrics.hints.get("unknown", "malformed") == 3
	})
	// The last one is a claim hint with a field the gateway does not know, which it ignores (DiscardUnknown).
	if a.expect("hint", 5*time.Second).GetHint().GetClaim() == nil {
		t.Fatal("the claim hint with an unknown field was not sent")
	}
	a.quiet(300 * time.Millisecond)
	if h.g.reg.count() != 1 {
		t.Fatal("the connection was closed")
	}
}

func TestAFullQueueDropsAHintWithoutClosingTheConnection(t *testing.T) {
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	// A connection whose writer never runs, so its queue only fills.
	c := newConn(h.g, nil, &linkClaims{RunnerID: runnerA, LeaseOwner: processA}, "127.0.0.1")
	hint := func() *linkpb.Frame {
		return &linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}}}}
	}
	if c.offer(hint()) {
		t.Fatal("a hint was queued before Welcome")
	}
	c.welcomed = true
	for i := 0; i < normalQueue; i++ {
		if !c.offer(hint()) {
			t.Fatalf("hint %d of %d was not queued", i+1, normalQueue)
		}
	}
	if c.offer(hint()) {
		t.Fatal("a hint was queued past a full queue")
	}
	select {
	case <-c.closing:
		t.Fatal("a full queue closed the connection")
	default:
	}
	if r := c.reason.Load(); r != nil {
		t.Fatalf("the connection was given an end: %s", *r)
	}
}

func TestTheGatewayServesWithoutNATSAndSubscribesOnceItIsBack(t *testing.T) {
	// A port nothing listens on yet.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relayTo(t, h, "nats://"+addr)
	if got := h.g.metrics.natsConnected.get(); got != 0 {
		t.Fatalf("link_nats_connected = %v with no NATS", got)
	}
	// Runners connect and are greeted as ever.
	a, w := h.connect(runnerA, processA)
	if w.GetConnectionId() == "" {
		t.Fatal("no Welcome without NATS")
	}

	nats := listenNATS(t, addr)
	eventually(t, 15*time.Second, "subscribed once NATS answers", func() bool { return nats.subscribers("rnr."+runnerA) == 1 })
	eventually(t, 5*time.Second, "link_nats_connected", func() bool { return h.g.metrics.natsConnected.get() == 1 })
	nats.publish("rnr."+runnerA, claimHint())
	if a.expect("hint", 5*time.Second).GetHint().GetClaim() == nil {
		t.Fatal("no hint after NATS came up")
	}

	// NATS restarts: the client reconnects and subscribes again.
	nats.dropClients()
	eventually(t, 15*time.Second, "subscribed again after the restart", func() bool {
		return h.g.metrics.natsReconnects.get() == 1 && nats.subscribers("rnr."+runnerA) == 1
	})
	nats.publish("rnr."+runnerA, commandsHint())
	if a.expect("hint", 5*time.Second).GetHint().GetCommands() == nil {
		t.Fatal("no hint after NATS restarted")
	}
}

// TestHintsOverARealNATSServer is the relay against a real nats-server, publishing the way the apiserver does:
//
//	docker run -d --rm -p 127.0.0.1:14222:4222 nats:2.15-alpine
//	LINK_TEST_NATS_URL=nats://127.0.0.1:14222 go test -run TestHintsOverARealNATSServer .
func TestHintsOverARealNATSServer(t *testing.T) {
	url := os.Getenv("LINK_TEST_NATS_URL")
	if url == "" {
		t.Skip("LINK_TEST_NATS_URL is not set")
	}
	h := newHarness(t, func(c *config) { c.Mode = linkpb.Mode_MODE_LINK })
	relayTo(t, h, url)
	eventually(t, 10*time.Second, "the relay connected", func() bool { return h.g.metrics.natsConnected.get() == 1 })
	apiserver, err := nats.Connect(url, nats.Name("hints_test apiserver"))
	if err != nil {
		t.Fatal(err)
	}
	defer apiserver.Close()

	a, _ := h.connect(runnerA, processA)
	b, _ := h.connect(runnerB, processB)
	// A subscription is in force once the server has it; the relay's flush says so.
	eventually(t, 5*time.Second, "both subscribed", func() bool { return len(h.g.hints.subscribed()) == 2 })
	if err := h.g.hints.nc.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := apiserver.Publish("rnr."+runnerA, claimHint()); err != nil {
		t.Fatal(err)
	}
	if a.expect("hint", 5*time.Second).GetHint().GetClaim() == nil {
		t.Fatal("A was not sent its claim hint")
	}
	b.quiet(300 * time.Millisecond)
	if err := apiserver.Publish("rnr."+runnerB, inboxHint("0190a0b0-0000-7000-8000-0000000000b1")); err != nil {
		t.Fatal(err)
	}
	if got := b.expect("hint", 5*time.Second).GetHint().GetInbox().GetSessionId(); got != "0190a0b0-0000-7000-8000-0000000000b1" {
		t.Fatalf("B's inbox hint names %q", got)
	}
	a.quiet(300 * time.Millisecond)
	if err := apiserver.Publish("rnr."+runnerB, approvalHint("0190a0b0-0000-7000-8000-0000000000b1", "0190a0b0-0000-7000-8000-0000000000f2")); err != nil {
		t.Fatal(err)
	}
	if got := b.expect("hint", 5*time.Second).GetHint().GetApproval().GetApprovalId(); got != "0190a0b0-0000-7000-8000-0000000000f2" {
		t.Fatalf("B's approval hint names %q", got)
	}
	a.quiet(300 * time.Millisecond)
}
