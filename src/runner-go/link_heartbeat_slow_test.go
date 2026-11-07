package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// A slow control plane is not a dead connection (link_heartbeat.go, docs/runner-link-design.md §15.13). On 2026-11-06
// the production apiserver, CPU-starved, answered link heartbeats after the runner's 15s deadline, and every runner
// ended its healthy connection at its next beat and reconnected (561 connection_lost closes in 44 minutes), each
// reconnect a link token and a Welcome more for the starved server. These tests hold the runner to keeping its
// connection while answers are slow, and to noticing a dead transport from its pings within their bound.

// fakeLinkPath is a TCP path between the runner and the gateway whose open connections can go dead: after cut, nothing
// passes either way on them and nothing is closed, as with a half-open connection, a frozen gateway or a network that
// went away. A connection opened after the cut is carried as any other.
type fakeLinkPath struct {
	ln     net.Listener
	target string
	mu     sync.Mutex
	pairs  []*fakeLinkPair
}

type fakeLinkPair struct {
	dead      atomic.Bool
	near, far net.Conn
	closeOnce sync.Once
}

func newFakeLinkPath(t *testing.T, target string) *fakeLinkPath {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &fakeLinkPath{ln: ln, target: target}
	go p.serve()
	t.Cleanup(func() {
		_ = ln.Close()
		p.mu.Lock()
		defer p.mu.Unlock()
		for _, pair := range p.pairs {
			pair.close()
		}
	})
	return p
}

func (p *fakeLinkPath) url() string { return "wss://" + p.ln.Addr().String() }

func (p *fakeLinkPath) serve() {
	for {
		near, err := p.ln.Accept()
		if err != nil {
			return
		}
		far, err := net.Dial("tcp", p.target)
		if err != nil {
			_ = near.Close()
			continue
		}
		pair := &fakeLinkPair{near: near, far: far}
		p.mu.Lock()
		p.pairs = append(p.pairs, pair)
		p.mu.Unlock()
		go pair.carry(near, far)
		go pair.carry(far, near)
	}
}

// carry copies from one end to the other while the pair lives, and drops what comes once it is dead. An end that
// closes closes the other only while the pair lives: a dead path carries no FIN either.
func (pair *fakeLinkPair) carry(from, to net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, err := from.Read(buf)
		if n > 0 && !pair.dead.Load() {
			if _, werr := to.Write(buf[:n]); werr != nil {
				err = werr
			}
		}
		if err != nil {
			if !pair.dead.Load() {
				pair.close()
			}
			return
		}
	}
}

func (pair *fakeLinkPair) close() {
	pair.closeOnce.Do(func() {
		_ = pair.near.Close()
		_ = pair.far.Close()
	})
}

// cut kills every connection the path carries now.
func (p *fakeLinkPath) cut() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, pair := range p.pairs {
		pair.dead.Store(true)
	}
}

func (g *fakeWorkGateway) setBeatDelay(d time.Duration) {
	g.mu.Lock()
	g.beatDelay = d
	g.mu.Unlock()
}

func (g *fakeWorkGateway) beatLog() (arrivals, answers []fakeWorkBeatAt, superseded int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]fakeWorkBeatAt{}, g.arrivals...), append([]fakeWorkBeatAt{}, g.answers...), g.superseded
}

func (l *linkTestLog) has(s string) bool { return strings.Contains(l.String(), s) }

func (l *linkTestLog) String() string { return strings.Join(l.all(), "\n") }

func (cp *fakeLinkControlPlane) tokensIssued() int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.tokens
}

// linkBeatCall makes one heartbeat over the link within d, as the daemon's heartbeat makes it, and returns what it
// applied: the reconcile's maxConcurrent, which the tests' gateways number each answer by.
func linkBeatCall(r *linkWorkRig, d time.Duration) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var out HeartbeatResponse
	err := r.m.heartbeat(ctx, linkTestHeartbeat(r.t.leaseOwner), &out)
	return out.MaxConcurrent, err
}

// numberAnswers has the gateway number each reconcile it sends, in maxConcurrent.
func numberAnswers(r *linkWorkRig) {
	var n atomic.Int32
	r.g.reconcile = func(*fakeWorkConn, map[string]json.RawMessage) []byte {
		return []byte(fmt.Sprintf(`{"maxConcurrent":%d}`, n.Add(1)))
	}
}

// A heartbeat whose answer comes after its call gave up leaves the connection as it was: the next beat waits for that
// answer, which is not applied, and then goes on the same connection, with no new token and no Welcome. It holds with a
// gateway that names the beat it answers and with one older than beat_id, whose answers are taken in their order.
func TestALateHeartbeatAnswerKeepsTheConnection(t *testing.T) {
	for _, old := range []bool{false, true} {
		name := "the gateway names the beat it answers"
		if old {
			name = "a gateway older than beat_id"
		}
		t.Run(name, func(t *testing.T) {
			r := newLinkWorkRig(t)
			r.g.oldAcks = old
			numberAnswers(r)
			c := r.useLink(t)
			r.g.setBeatDelay(1500 * time.Millisecond)

			if _, err := linkBeatCall(r, 400*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("a beat answered after its call gave up: %v", err)
			}
			if cur := r.m.work.current(); cur == nil || cur.id != c.id || cur.ended() {
				t.Fatalf("the connection after a late answer: %v", cur)
			}
			applied, err := linkBeatCall(r, 10*time.Second)
			if err != nil {
				t.Fatalf("the beat after a late answer: %v", err)
			}
			if applied != 2 {
				t.Fatalf("the beat applied answer %d, want the second: the late one is not applied", applied)
			}
			arrivals, answers, superseded := r.g.beatLog()
			if len(arrivals) != 2 || len(answers) != 2 || superseded != 0 {
				t.Fatalf("beats came %v and were answered %v (%d superseded): want two, one at a time", arrivals, answers, superseded)
			}
			if arrivals[1].at.Before(answers[0].at) {
				t.Fatalf("the second beat came %s before the first was answered: the runner piled it on", answers[0].at.Sub(arrivals[1].at))
			}
			if arrivals[0].id == 0 || arrivals[1].id <= arrivals[0].id {
				t.Fatalf("the beats were named %d and %d", arrivals[0].id, arrivals[1].id)
			}
			if arrivals[0].conn != c.id || arrivals[1].conn != c.id || len(r.g.welcomed()) != 1 || r.cp.tokensIssued() != 1 {
				t.Fatalf("beats on %s and %s, %d connections, %d link tokens: want one connection, one token",
					arrivals[0].conn, arrivals[1].conn, len(r.g.welcomed()), r.cp.tokensIssued())
			}
			if !r.logs.has(fmt.Sprintf("answered heartbeat %d", arrivals[0].id)) {
				t.Errorf("the log does not say the late answer came:\n%s", r.logs.String())
			}
		})
	}
}

// A heartbeat answered later than the 15s a heartbeat had (and still has over HTTPS) is applied: over the link the
// daemon's heartbeat waits as long as the gateway may take to answer one, on the same connection.
func TestAHeartbeatAnsweredAfterFifteenSecondsIsApplied(t *testing.T) {
	if testing.Short() {
		t.Skip("waits 16s")
	}
	r := newLinkWorkRig(t)
	numberAnswers(r)
	c := r.useLink(t)
	r.g.setBeatDelay(16 * time.Second)
	resp, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner))
	if err != nil {
		t.Fatalf("a heartbeat answered after 16s: %v", err)
	}
	if resp.MaxConcurrent != 1 || len(r.g.welcomed()) != 1 || r.m.work.current().id != c.id {
		t.Fatalf("applied %d, %d connections", resp.MaxConcurrent, len(r.g.welcomed()))
	}
}

// An answer naming another beat is not this beat's: the beat waits for its own.
func TestAHeartbeatAckNamingAnotherBeatIsNotItsAnswer(t *testing.T) {
	r := newLinkWorkRig(t)
	numberAnswers(r)
	r.g.beforeAck = func(c *fakeWorkConn, hb *linkpb.Heartbeat) {
		c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{
			Mode: linkpb.Mode_MODE_LINK, BeatId: hb.GetBeatId() + 1000, ReconcileJson: []byte(`{"maxConcurrent":999}`),
		}}})
	}
	r.useLink(t)
	applied, err := linkBeatCall(r, 5*time.Second)
	if err != nil || applied != 1 {
		t.Fatalf("applied %d (%v), want the beat's own answer", applied, err)
	}
}

// A dead transport is noticed from the pings: once nothing comes back on the connection, a ping unanswered within
// pingTimeout ends it, whether or not a beat is out, and the next connection is opened. No beat is sent here after the
// path dies, so nothing but the pings can tell.
func TestADeadTransportIsNoticedFromItsPings(t *testing.T) {
	r := newLinkWorkRig(t)
	path := newFakeLinkPath(t, r.g.Listener.Addr().String())
	r.cp.mu.Lock()
	r.cp.linkURL = path.url()
	r.cp.mu.Unlock()
	r.m.work.pingEvery, r.m.work.pingTimeout = 200*time.Millisecond, time.Second
	r.useLink(t)
	if _, err := linkBeatCall(r, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	cut := time.Now()
	path.cut()
	linkWaitFor(t, 10*time.Second, "the dead connection to be noticed", func() bool { return r.logs.has("no answer to a ping") })
	noticed := time.Since(cut)
	if bound := r.m.work.pingEvery + r.m.work.pingTimeout; noticed > bound+500*time.Millisecond {
		t.Errorf("noticed %s after the path died, want within pingEvery + pingTimeout = %s", noticed, bound)
	}
	r.g.waitWelcomed(t, 2)
	if _, err := linkBeatCall(r, 5*time.Second); err != nil {
		t.Fatalf("a beat on the next connection: %v", err)
	}
}

// A ping answered late is not a dead transport while frames keep coming from the gateway: the gateway is there and
// writing. Here the gateway stops reading, so it answers no ping, and sends a hint every 100ms meanwhile.
func TestAPingAnsweredLateWhileFramesComeKeepsTheConnection(t *testing.T) {
	r := newLinkWorkRig(t)
	r.m.work.pingEvery, r.m.work.pingTimeout = 200*time.Millisecond, 500*time.Millisecond
	c := r.useLink(t)
	release := make(chan struct{})
	c.stall.Store(&release)
	// The reading loop stalls at its next frame: a beat's.
	if _, err := linkBeatCall(r, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(100 * time.Millisecond):
				c.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}}}})
			}
		}
	}()
	time.Sleep(3 * time.Second) // six pings' worth
	close(stop)
	close(release)
	if cur := r.m.work.current(); cur == nil || cur.id != c.id || cur.ended() || len(r.g.welcomed()) != 1 {
		t.Fatalf("a connection whose gateway kept writing was ended: %s", r.logs.String())
	}
}

// A beat the gateway never answers, on a connection that answers pings, ends that connection once it has gone
// unanswered for beatStuckAfter: the next beat waits for it until then, and is not sent on that connection. The
// connections after it are no better, and the backoff does not start over at their Welcomes: only once a beat is
// reconciled.
func TestAnUnansweredBeatEndsItsConnectionAndTheReconnectsBackOff(t *testing.T) {
	r := newLinkWorkRig(t)
	numberAnswers(r)
	r.m.work.beatStuckAfter = 300 * time.Millisecond
	r.useLink(t)
	r.g.setBeatDelay(time.Hour)
	ended := func() int { return strings.Count(r.logs.String(), "went unanswered for 300ms while it answered pings") }
	linkWaitFor(t, 30*time.Second, "three connections ended for an unanswered beat", func() bool {
		if _, err := linkBeatCall(r, 400*time.Millisecond); err == nil {
			t.Fatal("a beat nobody answers was answered")
		}
		return ended() >= 3
	})
	r.m.work.mu.Lock()
	attempt := r.m.work.attempt
	r.m.work.mu.Unlock()
	if attempt < ended() {
		t.Fatalf("after %d connections ended with no beat reconciled, the backoff is at attempt %d: it started over", ended(), attempt)
	}
	arrivals, _, superseded := r.g.beatLog()
	perConn := map[string]int{}
	for _, a := range arrivals {
		perConn[a.conn]++
	}
	for conn, n := range perConn {
		if n > 1 {
			t.Fatalf("%d beats went on %s with the first unanswered (superseded %d): %v", n, conn, superseded, arrivals)
		}
	}
	if got := r.cp.tokensIssued(); got != 1 {
		t.Errorf("%d link tokens for reconnects within one token's life", got)
	}
	r.g.setBeatDelay(0)
	linkWaitFor(t, 15*time.Second, "a beat answered again", func() bool {
		_, err := linkBeatCall(r, 2*time.Second)
		return err == nil
	})
	r.m.work.mu.Lock()
	attempt = r.m.work.attempt
	r.m.work.mu.Unlock()
	if attempt != 0 {
		t.Fatalf("after a reconciled beat the backoff is at attempt %d, want 0", attempt)
	}
}

// Connections that end before they carry a reconciled beat are each followed by a longer wait; a Welcome alone does
// not start the backoff over, so a runner whose connections keep dropping does not come back in a tight loop.
func TestTheReconnectBackoffStartsOverOnlyOnceABeatIsReconciled(t *testing.T) {
	r := newLinkWorkRig(t)
	r.useLink(t)
	for i := 1; i <= 3; i++ {
		r.g.open()[0].drop()
		r.g.waitWelcomed(t, i+1)
		r.m.work.mu.Lock()
		attempt := r.m.work.attempt
		r.m.work.mu.Unlock()
		if attempt != i {
			t.Fatalf("after %d connections ended with no beat reconciled, the backoff is at attempt %d", i, attempt)
		}
	}
	if _, err := linkBeatCall(r, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	r.m.work.mu.Lock()
	attempt := r.m.work.attempt
	r.m.work.mu.Unlock()
	if attempt != 0 {
		t.Fatalf("a reconciled beat left the backoff at attempt %d", attempt)
	}
}
