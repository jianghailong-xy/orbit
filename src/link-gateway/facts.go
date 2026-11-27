package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Heartbeat facts by runner process (docs/runner-link-design.md §15.17). The facts a runner sent whole are kept for
// its process, the runner and the connection's process (the link token's leaseOwner), not for one connection: every
// connection of that process on this node fills digests from them, and they outlive the connection by
// factKeepAfterClose. Welcome says so (process_facts), and a runner that reads it sends its first beat on a new
// connection by digest alone for every fact it sent whole before.
//
// A digest this node does not hold, because the process's earlier connections were to another node or this node
// restarted, is asked of the other nodes on NATS (lfx.<runnerId>): one that holds that process's fact by the same
// digest answers with its content, which is checked against the digest before it is used and kept. A digest no node
// answers for within factPeerWait is named in want_facts, as always, and the runner sends it whole.

const (
	// factKeepAfterClose is how long a process's facts stay once its last connection on this node has ended: past a
	// weak network's reconnects (seconds to a minute) and a drain's reconnect delay.
	factKeepAfterClose = 15 * time.Minute
	// factSweepEvery is how often the facts of processes gone longer than factKeepAfterClose are let go.
	factSweepEvery = time.Minute
	// factPeerSubjectPrefix is where a node asks the others for a process's facts: lfx.<runnerId>.
	factPeerSubjectPrefix = "lfx."
	// factPeerInboxPrefix is where the answers come back: the gateway's NATS user reads no _INBOX (nats.conf).
	factPeerInboxPrefix = "_LFX"
	// factPeerWait bounds the wait for another node's answer. A node that holds the facts answers in a NATS round
	// trip; none answers when no node holds them, after a restart for one, and the beat then asks the runner.
	factPeerWait = 250 * time.Millisecond
)

// factKey names a runner process.
type factKey struct{ runner, process string }

// processFacts is what this node holds of one runner process's facts.
type processFacts struct {
	mu    sync.Mutex
	cache factCache

	// conns is how many of the process's connections on this node use it, and idleSince when the last one ended.
	// Guarded by factStore.mu.
	conns     int
	idleSince time.Time
}

// factStore is every process's facts on this node.
type factStore struct {
	now func() time.Time

	mu        sync.Mutex
	byProcess map[factKey]*processFacts
	lastSweep time.Time
}

func newFactStore(now func() time.Time) *factStore {
	return &factStore{now: now, byProcess: map[factKey]*processFacts{}, lastSweep: now()}
}

func newFactKey(runner, process string) factKey {
	return factKey{runner: runner, process: strings.ToLower(process)}
}

// acquire is the process's facts for one more of its connections.
func (s *factStore) acquire(runner, process string) *processFacts {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if now.Sub(s.lastSweep) >= factSweepEvery {
		s.sweepLocked(now)
	}
	k := newFactKey(runner, process)
	p := s.byProcess[k]
	if p == nil {
		p = &processFacts{cache: newFactCache()}
		s.byProcess[k] = p
	}
	p.conns++
	return p
}

// release lets go of one connection's use; the facts stay for factKeepAfterClose after the last.
func (s *factStore) release(p *processFacts) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.conns--; p.conns == 0 {
		p.idleSince = s.now()
	}
}

func (s *factStore) sweepLocked(now time.Time) {
	s.lastSweep = now
	for k, p := range s.byProcess {
		if p.conns == 0 && now.Sub(p.idleSince) >= factKeepAfterClose {
			delete(s.byProcess, k)
		}
	}
}

// held is the process's facts on this node, nil for none.
func (s *factStore) held(runner, process string) *processFacts {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byProcess[newFactKey(runner, process)]
}

// processes is how many processes' facts this node holds.
func (s *factStore) processes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byProcess)
}

// resolve fills a beat's facts from the process's (factCache.resolve), under its lock: two connections of one process
// may beat at once while one replaces the other.
func (p *processFacts) resolve(facts []*linkpb.Fact, m *gatewayMetrics) (map[string]json.RawMessage, []*linkpb.Fact, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cache.resolve(facts, m)
}

// fill keeps what another node answered and fills members with it: a missing fact it answered goes in, and the kinds
// it did not answer for are returned.
func (p *processFacts) fill(members map[string]json.RawMessage, missing []*linkpb.Fact, answered map[string]json.RawMessage, m *gatewayMetrics) (want []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, f := range missing {
		raw, ok := answered[f.GetKind()]
		if !ok {
			want = append(want, f.GetKind())
			m.heartbeatFacts.inc("unknown_digest")
			continue
		}
		members[f.GetKind()] = raw
		p.cache.keep(f.GetKind(), newCachedFact(strings.ToLower(f.GetSha256()), raw))
		m.heartbeatFacts.inc("peer")
	}
	return want
}

// askPeers asks the other gateway nodes for the process's facts that this node lacks, and returns those answered, by
// kind, each checked against its digest. Nothing without NATS, or when no node answers within factPeerWait.
func (g *gateway) askPeers(runner, process string, missing []*linkpb.Fact) map[string]json.RawMessage {
	if g.hints == nil || len(missing) == 0 {
		return nil
	}
	m := g.metrics
	ask := &linkpb.Heartbeat{ProcessId: strings.ToLower(process)}
	wanted := make(map[string]string, len(missing))
	for _, f := range missing {
		ask.Facts = append(ask.Facts, &linkpb.Fact{Kind: f.GetKind(), Sha256: strings.ToLower(f.GetSha256())})
		wanted[f.GetKind()] = strings.ToLower(f.GetSha256())
	}
	data, err := proto.Marshal(ask)
	if err != nil {
		return nil
	}
	msg, err := g.hints.nc.Request(factPeerSubjectPrefix+runner, data, factPeerWait)
	if err != nil {
		// No node holds them (nats.ErrNoResponders, nats.ErrTimeout), or NATS is down: the runner is asked.
		m.factPeerAsks.inc("no_answer")
		return nil
	}
	var answer linkpb.Heartbeat
	if err := proto.Unmarshal(msg.Data, &answer); err != nil {
		m.factPeerAsks.inc("malformed")
		return nil
	}
	found := map[string]json.RawMessage{}
	for _, f := range answer.GetFacts() {
		sha, ok := wanted[f.GetKind()]
		raw := f.GetJson()
		if !ok || len(raw) == 0 || !json.Valid(raw) {
			continue
		}
		if sum := sha256.Sum256(raw); hex.EncodeToString(sum[:]) != sha {
			continue
		}
		found[f.GetKind()] = json.RawMessage(raw)
	}
	switch {
	case len(found) == len(wanted):
		m.factPeerAsks.inc("answered")
	case len(found) > 0:
		m.factPeerAsks.inc("partial")
	default:
		m.factPeerAsks.inc("malformed")
	}
	return found
}

// answerPeer answers another node's ask for a process's facts with those this node holds by the digests asked, and
// does not answer when it holds none of them: the node that holds them answers, or none does and the asker's wait
// ends.
func (g *gateway) answerPeer(msg *nats.Msg) {
	runner := strings.TrimPrefix(msg.Subject, factPeerSubjectPrefix)
	var ask linkpb.Heartbeat
	if msg.Reply == "" || proto.Unmarshal(msg.Data, &ask) != nil {
		return
	}
	p := g.facts.held(runner, ask.GetProcessId())
	if p == nil {
		return
	}
	answer := &linkpb.Heartbeat{ProcessId: ask.GetProcessId()}
	p.mu.Lock()
	for _, f := range ask.GetFacts() {
		if cached, ok := p.cache.byKind[f.GetKind()]; ok && cached.sha.Value() == strings.ToLower(f.GetSha256()) {
			answer.Facts = append(answer.Facts, &linkpb.Fact{Kind: f.GetKind(), Sha256: cached.sha.Value(), Json: cached.content()})
		}
	}
	p.mu.Unlock()
	if len(answer.Facts) == 0 {
		return
	}
	data, err := proto.Marshal(answer)
	if err != nil {
		return
	}
	if msg.Respond(data) == nil {
		g.metrics.factPeerAnswers.inc()
	}
}
