package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// Heartbeat parts across reconnects (link_heartbeat.go, docs/runner-link-design.md §15.17): a gateway whose Welcome
// says process_facts keeps what a process sent whole across its connections, so the first beat on a new connection
// sends unchanged parts by digest alone; a gateway that does not say so keeps them per connection, and gets them all
// whole on each.

// linkMeasuredBeat is a heartbeat body the size of one a runner sent on 2026-11-24 (orbit-link-wk24's frame log,
// beat 82): each part a JSON string as long as that part was, and 14 supervised sessions.
func linkMeasuredBeat(leaseOwner string) map[string]any {
	sizes := map[string]int{
		"agentDirProbes": 203, "commands": 2008, "engines": 2047, "executing": 346, "executingAt": 13,
		"modelCatalog": 4152, "planUsage": 397, "repos": 323, "reposRoot": 32, "resources": 164, "runsAsRoot": 4,
		"runtimeDefaultModels": 2, "selfUpdate": 108, "skills": 4704,
	}
	body := map[string]any{"status": "ONLINE", "version": version, "leaseOwner": leaseOwner, "idleCapacity": 24}
	for kind, n := range sizes {
		// A JSON string of n bytes, quotes included.
		body[kind] = json.RawMessage(`"` + strings.Repeat("x", max(n-2, 0)) + `"`)
	}
	var sessions []string
	for i := 0; i < 14; i++ {
		sessions = append(sessions, fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", i+1))
	}
	body["supervisedSessionIds"] = sessions
	return body
}

// linkBeatSizes records the size of every Heartbeat frame message the gateway reads, by connection.
type linkBeatSizes struct {
	mu    sync.Mutex
	sizes map[string][]int
}

func (s *linkBeatSizes) watch(g *fakeWorkGateway) {
	s.sizes = map[string][]int{}
	g.onMessage = func(c *fakeWorkConn, data []byte) {
		var f linkpb.Frame
		if proto.Unmarshal(data, &f) != nil || f.GetHeartbeat() == nil {
			return
		}
		s.mu.Lock()
		s.sizes[c.id] = append(s.sizes[c.id], len(data))
		s.mu.Unlock()
	}
}

func (s *linkBeatSizes) of(conn string) []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.sizes[conn]...)
}

// beatOn sends one heartbeat and returns the beats the gateway received for it on conn.
func linkBeatOn(t *testing.T, r *linkWorkRig, body map[string]any, conn string) []fakeWorkBeat {
	t.Helper()
	_, _, before := r.g.snapshot()
	if err := r.m.heartbeat(context.Background(), body, nil); err != nil {
		t.Fatal(err)
	}
	_, _, after := r.g.snapshot()
	var out []fakeWorkBeat
	for _, b := range after[len(before):] {
		if b.conn != conn {
			t.Fatalf("a beat went on %s, not %s", b.conn, conn)
		}
		out = append(out, b)
	}
	return out
}

// reconnect drops the current connection and waits for the next to be adopted.
func linkReconnect(t *testing.T, r *linkWorkRig, cur *fakeWorkConn) *fakeWorkConn {
	t.Helper()
	n := len(r.g.welcomed())
	cur.drop()
	next := r.g.waitWelcomed(t, n+1)
	linkWaitFor(t, 5*time.Second, "the next connection to be adopted", func() bool {
		c := r.m.work.current()
		return c != nil && c.id == next.id
	})
	return next
}

func linkWholeKinds(hb *linkpb.Heartbeat) []string {
	var whole []string
	for _, f := range hb.GetFacts() {
		if len(f.GetJson()) != 0 {
			whole = append(whole, f.GetKind())
		}
	}
	return whole
}

// A process that reconnects to a gateway keeping its facts sends its first beat on the new connection by digest
// alone, about the size of a steady beat; the gateway fills it in. One whose new node holds nothing (another node, or
// one that restarted) is asked for every part, and gets them whole at once, in the same heartbeat call.
func TestLinkReconnectSendsUnchangedPartsByDigest(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.processFacts = true
	var sizes linkBeatSizes
	sizes.watch(r.g)
	first := r.useLink(t)
	body := linkMeasuredBeat(r.t.leaseOwner)

	initial := linkBeatOn(t, r, body, first.id)
	if len(initial) != 1 || len(linkWholeKinds(initial[0].frame)) != 14 || initial[0].forwarded == nil {
		t.Fatalf("the first beat of the process: %+v", initial)
	}
	steady := linkBeatOn(t, r, body, first.id)
	if len(steady) != 1 || len(linkWholeKinds(steady[0].frame)) != 0 {
		t.Fatalf("the steady beat sent %v whole", linkWholeKinds(steady[0].frame))
	}

	// The same node, after the connection was lost: by digest alone, filled in from what the process sent before.
	second := linkReconnect(t, r, first)
	again := linkBeatOn(t, r, body, second.id)
	if len(again) != 1 || len(again[0].want) != 0 || again[0].forwarded == nil {
		t.Fatalf("the first beat after the reconnect: %+v", again)
	}
	if whole := linkWholeKinds(again[0].frame); len(whole) != 0 {
		t.Errorf("the first beat on the new connection sent %v whole", whole)
	}
	for kind, raw := range initial[0].forwarded {
		if !jsonEqual(t, again[0].forwarded[kind], raw) {
			t.Errorf("the reconnect's forwarded %s is %s, not %s", kind, again[0].forwarded[kind], raw)
		}
	}

	// A part that changed goes whole, the rest still by digest.
	body["executingAt"] = json.RawMessage(`"2026-11-27"`)
	changed := linkBeatOn(t, r, body, second.id)
	if whole := linkWholeKinds(changed[0].frame); len(whole) != 1 || whole[0] != "executingAt" {
		t.Errorf("a changed part: %v whole", whole)
	}

	// Another node, or this one after a restart: it holds none of the process's parts, asks for them all, and gets
	// them whole in the same call.
	r.g.mu.Lock()
	r.g.processHeld = nil
	r.g.mu.Unlock()
	third := linkReconnect(t, r, second)
	recovered := linkBeatOn(t, r, body, third.id)
	if len(recovered) != 2 {
		t.Fatalf("a node holding nothing: %d beats, want the one it asked about and the one that answered", len(recovered))
	}
	if len(recovered[0].want) != 14 || recovered[0].forwarded != nil || len(linkWholeKinds(recovered[0].frame)) != 0 {
		t.Errorf("the beat the empty node asked about: want %v whole %v", recovered[0].want, linkWholeKinds(recovered[0].frame))
	}
	if len(linkWholeKinds(recovered[1].frame)) != 14 || recovered[1].forwarded == nil {
		t.Errorf("the answer to want_facts sent %v whole", linkWholeKinds(recovered[1].frame))
	}

	full, steadySize, reconnectSize := sizes.of(first.id)[0], sizes.of(first.id)[1], sizes.of(second.id)[0]
	t.Logf("heartbeat frame on the wire: first beat of the process %d B, steady beat %d B, first beat after a reconnect %d B (was %d B before process_facts), digest-only beat to an empty node %d B then %d B whole",
		full, steadySize, reconnectSize, full, sizes.of(third.id)[0], sizes.of(third.id)[1])
	if full < 15000 || reconnectSize > 2500 || reconnectSize != steadySize {
		t.Errorf("sizes: first %d, steady %d, reconnect %d; want the reconnect's first beat the steady beat's size, about 2 KB", full, steadySize, reconnectSize)
	}
}

// A gateway older than Welcome.process_facts keeps a connection's parts for that connection alone: the first beat on
// each new connection sends them all whole, as before, and is forwarded without a question.
func TestLinkReconnectToAnOlderGatewaySendsEveryPartWhole(t *testing.T) {
	r := newLinkWorkRig(t)
	first := r.useLink(t)
	body := linkMeasuredBeat(r.t.leaseOwner)
	linkBeatOn(t, r, body, first.id)
	linkBeatOn(t, r, body, first.id)

	second := linkReconnect(t, r, first)
	again := linkBeatOn(t, r, body, second.id)
	if len(again) != 1 || len(again[0].want) != 0 || again[0].forwarded == nil {
		t.Fatalf("the first beat on the older gateway's new connection: %+v", again)
	}
	if whole := linkWholeKinds(again[0].frame); len(whole) != 14 {
		t.Errorf("the first beat on the new connection sent %d parts whole, want all 14", len(whole))
	}
}

// A beat whose connection ends before its answer may never have reached the gateway: what it sent whole goes whole
// again on the next connection, rather than by a digest the gateway may not hold.
func TestLinkPartsOfABeatLostWithItsConnectionGoWholeAgain(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.processFacts = true
	first := r.useLink(t)
	body := linkMeasuredBeat(r.t.leaseOwner)
	linkBeatOn(t, r, body, first.id)

	// The next beat changes a part, and its connection is lost before the gateway takes it.
	r.g.mu.Lock()
	r.g.loseBeat = func(c *fakeWorkConn, _ *linkpb.Heartbeat) bool {
		if c.id != first.id {
			return false
		}
		c.drop()
		return true
	}
	r.g.mu.Unlock()
	body["repos"] = json.RawMessage(`["/srv/repos/a","/srv/repos/b"]`)
	_, _, before := r.g.snapshot()
	if err := r.m.heartbeat(context.Background(), body, nil); err != nil {
		t.Fatal(err)
	}
	_, _, after := r.g.snapshot()
	beats := after[len(before):]
	last := beats[len(beats)-1]
	if last.conn == first.id || last.forwarded == nil {
		t.Fatalf("the beat was not answered on the next connection: %+v", beats)
	}
	if len(beats) != 1 {
		t.Errorf("%d beats answered for the lost one, want one: the part it sent whole went whole again, without a question", len(beats))
	}
	if whole := linkWholeKinds(last.frame); len(whole) != 1 || whole[0] != "repos" {
		t.Errorf("the beat on the next connection sent %v whole, want [repos]", whole)
	}
}

// The runner offers permessage-deflate without context takeover (link_client.go). A gateway that accepts it gets the
// heartbeat's parts compressed; one from before it, which accepts none, gets them as they are, and the link works the
// same either way.
func TestLinkCompressesWhereTheGatewayAcceptsIt(t *testing.T) {
	for _, c := range []struct {
		name string
		mode websocket.CompressionMode
	}{
		{"a gateway that accepts no compression", websocket.CompressionDisabled},
		{"a gateway that accepts permessage-deflate", websocket.CompressionNoContextTakeover},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := newLinkWorkRig(t)
			r.g.compression = c.mode
			conn := r.useLink(t)
			if !strings.Contains(conn.offered, "permessage-deflate") || !strings.Contains(conn.offered, "client_no_context_takeover") {
				t.Fatalf("the runner offered %q", conn.offered)
			}
			// A first beat of compressible parts, as a runner's are.
			body := linkTestHeartbeat(r.t.leaseOwner)
			for i := 0; i < 40; i++ {
				body.Skills = append(body.Skills, SlashCommandInfo{Name: fmt.Sprintf("skill-%d", i), Description: "Use when the task involves the runner link: conventions, pitfalls and a worked example"})
			}
			raw, _ := json.Marshal(body.Skills)
			before := r.g.wireIn.Load()
			beats := linkBeatOn(t, r, map[string]any{"leaseOwner": r.t.leaseOwner, "skills": json.RawMessage(raw)}, conn.id)
			if len(beats) != 1 || beats[0].forwarded == nil || !jsonEqual(t, beats[0].forwarded["skills"], raw) {
				t.Fatalf("the beat: %+v", beats)
			}
			read := r.g.wireIn.Load() - before
			t.Logf("a %d-byte part came in %d bytes on the wire", len(raw), read)
			if compressed := read < int64(len(raw))/2; compressed != (c.mode != websocket.CompressionDisabled) {
				t.Errorf("%d bytes on the wire for a %d-byte part: compressed %v", read, len(raw), compressed)
			}
		})
	}
}
