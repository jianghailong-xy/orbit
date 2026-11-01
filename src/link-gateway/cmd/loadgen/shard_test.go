package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Shards and source addresses (-shard, -source; scripts/runner-link/gateway-limit.sh): several processes play one fleet
// between them, each runner in exactly one of them, and each process opens its connections from several local
// addresses, each runner from one of them in turn.

// writeShardFleet writes a fleet of n runners, runner k with token tok-k and one session, which streams for k mod 4 < 2:
// half the fleet, and half of each shard of two.
func writeShardFleet(t *testing.T, n int) string {
	t.Helper()
	var lines []string
	for k := 0; k < n; k++ {
		fr := fleetRunner{Runner: fmt.Sprintf("runner-%d", k), Token: fmt.Sprintf("tok-%d", k), Process: fmt.Sprintf("proc-%d", k),
			Sessions: []string{fmt.Sprintf("session-%d", k)}}
		if k%4 < 2 {
			fr.Active = []activeSession{{ID: fr.Sessions[0]}}
		}
		b, _ := json.Marshal(fr)
		lines = append(lines, string(b))
	}
	path := filepath.Join(t.TempDir(), "fleet.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestShardsSplitTheFleetAndShareItsRates(t *testing.T) {
	fleet := writeShardFleet(t, 10)
	seen := map[string]int{}
	for i := 0; i < 3; i++ {
		g, err := newLoadgen(options{fleet: fleet, api: "http://127.0.0.1:1", out: t.TempDir(), rampRate: 90, eventRate: 60,
			liveRate: 30, shard: fmt.Sprintf("%d/3", i)})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range g.runners {
			seen[r.id]++
			// A runner keeps its place in the fleet, which seeds what it draws: it is the same runner in any shard.
			if want := fmt.Sprintf("runner-%d", r.n); r.id != want || r.n%3 != i {
				t.Errorf("shard %d/3 plays %s as runner %d", i, r.id, r.n)
			}
		}
		if g.fleetRunners != 10 || g.fleetActive != 6 || g.perSessionRate != 10 || g.rampRate != 30 || g.liveRate != 10 {
			t.Errorf("shard %d/3: fleet %d runners, %d active; %.1f events/s a session, ramp %.1f/s, live %.1f/s",
				i, g.fleetRunners, g.fleetActive, g.perSessionRate, g.rampRate, g.liveRate)
		}
	}
	if len(seen) != 10 {
		t.Errorf("the shards played %d of the 10 runners", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s was played by %d shards", id, n)
		}
	}
	// Without -shard a process plays the whole fleet at the flags' rates, as before shards existed.
	g, err := newLoadgen(options{fleet: fleet, api: "http://127.0.0.1:1", out: t.TempDir(), rampRate: 90, eventRate: 60, liveRate: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.runners) != 10 || g.rampRate != 90 || g.liveRate != 30 || g.perSessionRate != 10 || len(g.dialClients) != 1 {
		t.Errorf("unsharded: %d runners, ramp %.1f, live %.1f, %.1f events/s a session, %d dial clients",
			len(g.runners), g.rampRate, g.liveRate, g.perSessionRate, len(g.dialClients))
	}
	for _, bad := range []string{"3/3", "-1/2", "1", "a/b", "1/2x", "01/2", "0/0"} {
		if _, err := newLoadgen(options{fleet: fleet, api: "x", out: t.TempDir(), rampRate: 1, shard: bad}); err == nil {
			t.Errorf("-shard %q was taken", bad)
		}
	}
	if _, err := newLoadgen(options{fleet: fleet, api: "x", out: t.TempDir(), rampRate: 1, shard: "0/11"}); err != nil {
		t.Errorf("a shard of a fleet larger than it: %v", err)
	}
	if _, err := newLoadgen(options{fleet: fleet, api: "x", out: t.TempDir(), rampRate: 1, shard: "10/11"}); err == nil {
		t.Errorf("shard 10 of 11 of a fleet of 10 plays no runner, and was taken")
	}
	if _, err := newLoadgen(options{fleet: fleet, api: "x", out: t.TempDir(), rampRate: 1, sources: "192.0.2.1"}); err == nil {
		t.Errorf("-source 192.0.2.1, no address of this host, was taken")
	}
}

// TestConnectionsLeaveFromEachSourceAndShardsPlayDisjointRunners plays a fleet of 8 runners in two shards, each opening
// its connections from 127.0.0.2 and 127.0.0.3, against a gateway that records where each connection came from and for
// whom: every connection leaves from one of the two, each shard uses both, each runner always the same one, and the
// shards' runners are disjoint and together the whole fleet. Link tokens last 1.5 s, so renewals open more connections.
func TestConnectionsLeaveFromEachSourceAndShardsPlayDisjointRunners(t *testing.T) {
	sources := []string{"127.0.0.2", "127.0.0.3"}
	for _, s := range sources {
		ln, err := net.Listen("tcp", s+":0")
		if err != nil {
			t.Skipf("%s is not an address of this host (only Linux routes all of 127.0.0.0/8 to loopback): %v", s, err)
		}
		_ = ln.Close()
	}
	fg := &fakeGateway{t: t, beat: 200 * time.Millisecond, stored: map[string][]uint64{}, byProc: map[string]*websocket.Conn{}}
	type conn struct{ shard, runner, from string }
	var mu sync.Mutex
	var conns []conn
	link := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The token names the shard whose API minted it and the runner token it was minted for.
		shard, runner, _ := strings.Cut(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "|")
		from, _, _ := net.SplitHostPort(r.RemoteAddr)
		mu.Lock()
		conns = append(conns, conn{shard, strings.TrimPrefix(runner, "tok-"), from})
		mu.Unlock()
		fg.serveHTTP(w, r)
	}))
	defer link.Close()
	linkURL := "ws" + strings.TrimPrefix(link.URL, "http")
	fleet := writeShardFleet(t, 8)

	var wg sync.WaitGroup
	sums := make([]*summary, 2)
	outs := make([]string, 2)
	for i := range 2 {
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"linkUrl": linkURL,
				"token":     strconv.Itoa(i) + "|" + strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "),
				"expiresAt": time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339Nano)})
		}))
		defer api.Close()
		outs[i] = t.TempDir()
		g, err := newLoadgen(options{fleet: fleet, api: api.URL, out: outs[i], rampRate: 100, duration: 2 * time.Second,
			drainTimeout: 5 * time.Second, interval: time.Second, eventRate: 40, flushMin: 30 * time.Millisecond,
			flushMax: 120 * time.Millisecond, maxBatch: 10, renewBefore: 500 * time.Millisecond, settle: 200 * time.Millisecond,
			seed: 3, shard: fmt.Sprintf("%d/2", i), sources: strings.Join(sources, ","), histograms: true})
		if err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			sums[i], _ = g.run(ctx)
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	byShard := map[string]map[string]bool{}   // shard → its runners
	fromOf := map[string]map[string]bool{}    // runner → the addresses it connected from
	sourcesOf := map[string]map[string]bool{} // shard → the addresses its runners connected from
	add := func(m map[string]map[string]bool, key, value string) {
		if m[key] == nil {
			m[key] = map[string]bool{}
		}
		m[key][value] = true
	}
	for _, c := range conns {
		if c.from != sources[0] && c.from != sources[1] {
			t.Errorf("runner %s connected from %s, not a -source address", c.runner, c.from)
		}
		add(byShard, c.shard, c.runner)
		add(fromOf, c.runner, c.from)
		add(sourcesOf, c.shard, c.from)
	}
	t.Logf("%d connections; by shard %v; by source %v", len(conns), byShard, sourcesOf)
	for shard, from := range sourcesOf {
		if len(from) != 2 {
			t.Errorf("shard %s connected from %v, not from both sources", shard, from)
		}
	}
	all := map[string]bool{}
	for shard, runners := range byShard {
		for runner := range runners {
			k, _ := strconv.Atoi(runner)
			if strconv.Itoa(k%2) != shard {
				t.Errorf("runner %s was played by shard %s", runner, shard)
			}
			if all[runner] {
				t.Errorf("runner %s was played by both shards", runner)
			}
			all[runner] = true
			// A runner's place in its shard picks its source: k/2 here, in turn over the two.
			if want := sources[(k/2)%2]; len(fromOf[runner]) != 1 || !fromOf[runner][want] {
				t.Errorf("runner %s connected from %v, want %s alone", runner, fromOf[runner], want)
			}
		}
	}
	if len(all) != 8 {
		t.Errorf("the shards connected %d of the fleet's 8 runners", len(all))
	}
	renewals := int64(0)
	for i, sum := range sums {
		if sum == nil || sum.Steady == nil {
			t.Fatalf("shard %d: no steady window", i)
		}
		renewals += sum.Whole.Counters.Renewals
		sh := sum.Config.Shard
		if sh == nil || sh.Index != i || sh.Count != 2 || sh.FleetRunners != 8 || sh.FleetActiveSessions != 4 || sh.RampRate != 50 ||
			sum.Config.Runners != 4 || sum.Config.ActiveSessions != 2 || sum.Config.PerSessionRate != 10 || len(sum.Config.Sources) != 2 {
			t.Errorf("shard %d's summary: %+v, shard %+v", i, sum.Config, sh)
		}
		if sum.Whole.ErrorTotal != 0 || sum.Unacknowledged != 0 || sum.Whole.Counters.HeartbeatAcks == 0 || sum.Whole.Counters.EventsAcked == 0 {
			t.Errorf("shard %d: errors %v, unacknowledged %d, %+v", i, sum.Whole.Errors, sum.Unacknowledged, sum.Whole.Counters)
		}
		var h histograms
		b, err := os.ReadFile(filepath.Join(outs[i], "histograms.json"))
		if err != nil || json.Unmarshal(b, &h) != nil || h.Steady == nil {
			t.Fatalf("shard %d: histograms.json: %v", i, err)
		}
		var inBuckets uint64
		for _, bucket := range h.Whole.BeatAck.Buckets {
			inBuckets += bucket[1]
		}
		if h.Whole.BeatAck.Count != sum.Whole.BeatAck.Count || inBuckets != h.Whole.BeatAck.Count || h.Whole.AckEvent.Count != sum.Whole.AckEvent.Count ||
			h.Steady.AckBatch.Count != sum.Steady.AckBatch.Count || h.Whole.BeatAck.Base != histBase {
			t.Errorf("shard %d: histograms.json does not hold summary.json's histograms: %+v", i, h.Whole.BeatAck)
		}
	}
	if renewals == 0 {
		t.Errorf("no connection was renewed: the test shows nothing of a renewal's source")
	}
}

// Without the new flags a run writes what it wrote before: no shard or sources in summary.json, no histograms.json.
func TestTodaysFlagsWriteNoShardSourcesOrHistograms(t *testing.T) {
	fg := &fakeGateway{t: t, beat: 200 * time.Millisecond, stored: map[string][]uint64{}, byProc: map[string]*websocket.Conn{}}
	sum, _ := runFleet(t, fg, func(o *options) { o.duration = time.Second })
	b, err := json.Marshal(sum)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"shard", "sources"} {
		if _, ok := doc.Config[key]; ok {
			t.Errorf("summary.json's config has %q without the flag", key)
		}
	}
	out := t.TempDir()
	g, err := newLoadgen(options{fleet: writeShardFleet(t, 1), api: "http://127.0.0.1:1", out: out, rampRate: 1, interval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _ = g.run(ctx)
	if _, err := os.Stat(filepath.Join(out, "histograms.json")); !os.IsNotExist(err) {
		t.Errorf("histograms.json was written without -histograms: %v", err)
	}
	if _, err := os.Stat(filepath.Join(out, "summary.json")); err != nil {
		t.Errorf("no summary.json: %v", err)
	}
}
