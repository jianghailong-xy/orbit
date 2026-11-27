package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Heartbeat facts kept for the runner process across its connections and gateway nodes (facts.go).

func lastBody(t *testing.T, b *fakeBackend) map[string]json.RawMessage {
	t.Helper()
	calls := b.requestsTo("/api/runner/heartbeat")
	if len(calls) == 0 {
		t.Fatal("no heartbeat was forwarded")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(calls[len(calls)-1].Body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// beatLines is the frame log's heartbeat lines, as an operator reads them: each fact with +<bytes> when it came whole.
func beatLines(h *harness) []string {
	var out []string
	for _, line := range strings.Split(h.logs.String(), "\n") {
		if strings.Contains(line, "dir=in") && strings.Contains(line, " heartbeat ") {
			out = append(out, line[strings.Index(line, "conn="):])
		}
	}
	return out
}

// A process that reconnects to the same node sends its facts by digest alone, and the node fills them in from what the
// process sent on its earlier connection, which is gone. Another process of the same runner holds nothing of them; a
// runner older than Welcome.process_facts, which sends everything whole on each connection, is forwarded as before.
func TestAProcessFactsOutliveItsConnection(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	catalog := fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5"}]}`)
	engines := fact("engines", `[{"engine":"claude","installed":true,"auth":"yes"}]`)

	first, welcome := h.connectLink(runnerA, processA)
	if !welcome.GetProcessFacts() {
		t.Fatal("the Welcome does not say the gateway keeps the process's facts")
	}
	first.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 1, Facts: []*linkpb.Fact{catalog, engines}}))
	first.await("heartbeat_ack", 5*time.Second, nil)
	_ = first.ws.CloseNow()
	eventually(t, 5*time.Second, "the first connection gone", func() bool { return h.g.reg.count() == 0 })

	second, _ := h.connectLink(runnerA, processA)
	second.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 2, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(engines)}}))
	if ack := second.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 || len(ack.GetWantFacts()) != 0 {
		t.Fatalf("the reconnected process's digest-only beat: %v", ack)
	}
	body := lastBody(t, backend)
	if !jsonEqual(body["modelCatalog"], catalog.GetJson()) || !jsonEqual(body["engines"], engines.GetJson()) {
		t.Fatalf("the digest-only beat was forwarded with %s and %s", body["modelCatalog"], body["engines"])
	}
	if got := h.g.metrics.heartbeatFacts.get("cached"); got != 2 {
		t.Errorf("cached %v, want 2", got)
	}

	// Another process of the runner: a fact is the process's, not the runner's.
	other, _ := h.connectLink(runnerA, processC)
	other.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processC, BeatId: 1, Facts: []*linkpb.Fact{digestOnly(catalog)}}))
	if ack := other.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); strings.Join(ack.GetWantFacts(), ",") != "modelCatalog" {
		t.Fatalf("another process's digest-only beat: %v", ack)
	}

	// An older runner sends everything whole on its new connection, as it always has.
	_ = second.ws.CloseNow()
	eventually(t, 5*time.Second, "the second connection gone", func() bool { return h.g.reg.count() == 1 })
	third, _ := h.connectLink(runnerA, processA)
	third.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, Facts: []*linkpb.Fact{catalog, engines}}))
	if ack := third.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 || len(ack.GetWantFacts()) != 0 {
		t.Fatalf("an older runner's whole beat: %v", ack)
	}
	for _, line := range beatLines(h) {
		t.Log(line)
	}
}

// natsNodes are gateway nodes on one NATS, each forwarding to its own backend.
func natsNodes(t *testing.T, n int) (*natsStandIn, []*harness, []*fakeBackend) {
	t.Helper()
	ns := listenNATS(t, "127.0.0.1:0")
	var nodes []*harness
	var backends []*fakeBackend
	for i := 0; i < n; i++ {
		b := newFakeBackend(t, heartbeatAnswer)
		h := newLinkHarness(t, []*fakeBackend{b}, nil)
		relayTo(t, h, ns.url())
		nodes, backends = append(nodes, h), append(backends, b)
	}
	eventually(t, 5*time.Second, "every node subscribed to the others' asks", func() bool {
		return ns.subscribers(factPeerSubjectPrefix+"*") == n
	})
	return ns, nodes, backends
}

// A process whose connection is lost and comes back to another node sends its facts by digest alone: that node asks
// the others, the one that holds them answers, and the beat is forwarded whole without asking the runner.
func TestAnotherNodeFillsAProcessFactsFromTheNodeThatHoldsThem(t *testing.T) {
	_, nodes, backends := natsNodes(t, 2)
	a, b := nodes[0], nodes[1]
	catalog := fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5"}]}`)
	skills := fact("skills", `[{"name":"review","description":"Review the change"}]`)

	onA, _ := a.connectLink(runnerA, processA)
	onA.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 1, Facts: []*linkpb.Fact{catalog, skills}}))
	onA.await("heartbeat_ack", 5*time.Second, nil)
	_ = onA.ws.CloseNow()
	eventually(t, 5*time.Second, "the connection to A gone", func() bool { return a.g.reg.count() == 0 })

	onB, _ := b.connectLink(runnerA, processA)
	onB.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 2, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(skills)}}))
	if ack := onB.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 || len(ack.GetWantFacts()) != 0 {
		t.Fatalf("the digest-only beat on another node: %v", ack)
	}
	body := lastBody(t, backends[1])
	if !jsonEqual(body["modelCatalog"], catalog.GetJson()) || !jsonEqual(body["skills"], skills.GetJson()) {
		t.Fatalf("node B forwarded %s and %s", body["modelCatalog"], body["skills"])
	}
	if got := b.g.metrics.heartbeatFacts.get("peer"); got != 2 {
		t.Errorf("B filled %v facts from a peer, want 2", got)
	}
	if got := b.g.metrics.factPeerAsks.get("answered"); got != 1 {
		t.Errorf("B's asks answered: %v", got)
	}
	if got := a.g.metrics.factPeerAnswers.get(); got != 1 {
		t.Errorf("A answered %v asks", got)
	}

	// B keeps what it was answered: the next beat is filled from its own.
	onB.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 3, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(skills)}}))
	onB.await("heartbeat_ack", 5*time.Second, func(f *linkpb.Frame) bool { return f.GetHeartbeatAck().GetBeatId() == 3 })
	if got := b.g.metrics.heartbeatFacts.get("cached"); got != 2 {
		t.Errorf("B's second beat: cached %v, want 2", got)
	}
	for _, line := range append(beatLines(a), beatLines(b)...) {
		t.Log(line)
	}
}

// A node that restarted holds nothing, and neither does any other: its ask goes unanswered, the beat is not forwarded,
// and the runner is asked for its facts whole (want_facts), as it always was.
func TestAFactNoNodeHoldsIsAskedOfTheRunner(t *testing.T) {
	_, nodes, backends := natsNodes(t, 2)
	restarted := nodes[1]
	catalog := fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5"}]}`)
	engines := fact("engines", `[{"engine":"claude","installed":true,"auth":"yes"}]`)

	tc, _ := restarted.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 7, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(engines)}}))
	ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if strings.Join(ack.GetWantFacts(), ",") != "engines,modelCatalog" || len(ack.GetReconcileJson()) != 0 || ack.GetBeatId() != 7 {
		t.Fatalf("a digest no node holds: %v", ack)
	}
	if n := len(backends[1].requestsTo("/api/runner/heartbeat")); n != 0 {
		t.Fatalf("a beat with digests nobody holds was forwarded (%d calls)", n)
	}
	if got := restarted.g.metrics.factPeerAsks.get("no_answer"); got != 1 {
		t.Errorf("unanswered asks: %v", got)
	}
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 8, Facts: []*linkpb.Fact{catalog, engines}}))
	if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 {
		t.Fatalf("the beat with the facts whole: %v", ack)
	}
}

// An answer is used only for the digest it was asked for: content that is not what the digest names is not forwarded,
// and the runner is asked for the fact instead.
func TestAnAnswerNotMatchingItsDigestIsNotUsed(t *testing.T) {
	ns, nodes, backends := natsNodes(t, 1)
	rogue, err := nats.Connect(ns.url(), nats.Name("facts_test rogue node"))
	if err != nil {
		t.Fatal(err)
	}
	defer rogue.Close()
	if _, err := rogue.Subscribe(factPeerSubjectPrefix+"*", func(msg *nats.Msg) {
		var ask linkpb.Heartbeat
		_ = proto.Unmarshal(msg.Data, &ask)
		answer := &linkpb.Heartbeat{ProcessId: ask.GetProcessId()}
		for _, f := range ask.GetFacts() {
			answer.Facts = append(answer.Facts, &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256(), Json: []byte(`{"not":"it"}`)})
		}
		data, _ := proto.Marshal(answer)
		_ = msg.Respond(data)
	}); err != nil {
		t.Fatal(err)
	}
	_ = rogue.Flush()
	eventually(t, 5*time.Second, "the rogue subscribed", func() bool { return ns.subscribers(factPeerSubjectPrefix+"*") == 2 })

	catalog := fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5"}]}`)
	tc, _ := nodes[0].connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 1, Facts: []*linkpb.Fact{digestOnly(catalog)}}))
	if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); strings.Join(ack.GetWantFacts(), ",") != "modelCatalog" {
		t.Fatalf("an answer whose content is not its digest's: %v", ack)
	}
	if n := len(backends[0].requestsTo("/api/runner/heartbeat")); n != 0 {
		t.Fatalf("forwarded with content another node made up (%d calls)", n)
	}
}

// A process's facts stay factKeepAfterClose after its last connection on the node ends, and go at the next sweep after
// that; a process with a connection keeps them however long.
func TestAProcessFactsGoFifteenMinutesAfterItsLastConnection(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s := newFactStore(func() time.Time { return now })
	gone := s.acquire(runnerA, processA)
	live := s.acquire(runnerA, processC)
	if again := s.acquire(runnerA, strings.ToUpper(processA)); again != gone {
		t.Fatal("a second connection of the process got facts of its own")
	}
	s.release(gone)
	s.release(gone)

	now = now.Add(factKeepAfterClose - time.Second)
	s.acquire(runnerB, processB)
	if s.held(runnerA, processA) == nil {
		t.Fatal("the facts went before factKeepAfterClose")
	}
	// The next sweep, factSweepEvery after that one.
	now = now.Add(factSweepEvery)
	s.acquire(runnerB, processB)
	if s.held(runnerA, processA) != nil {
		t.Fatal("the facts outlived factKeepAfterClose")
	}
	if s.held(runnerA, processC) != live || s.processes() != 2 {
		t.Fatalf("a process with a connection lost its facts, or another went: %d held", s.processes())
	}
}
