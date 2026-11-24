package door

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestsCarryTheCredentialAndTheInstance(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		if r.URL.Path != "/api/runner/drive/stat" || r.URL.Query().Get("path") != "/Proj/r.md" {
			t.Errorf("route %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "e1", "kind": "FILE", "name": "r.md", "sizeBytes": 3, "seq": 7, "parentId": "p1"})
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "orbit_drive_mount_x", Generation: "4", PodUID: "pod-1"})
	e, err := c.StatPath(context.Background(), "/Proj/r.md")
	if err != nil {
		t.Fatal(err)
	}
	if e.ID != "e1" || e.Parent() != "p1" || e.Seq != 7 || e.IsFolder() {
		t.Fatalf("entry %+v", e)
	}
	if seen.Get("Authorization") != "Bearer orbit_drive_mount_x" || seen.Get(generationHeader) != "4" ||
		seen.Get(podUIDHeader) != "pod-1" || seen.Get(instanceCapabilityHeader) != instanceCapability {
		t.Fatalf("headers %v", seen)
	}
}

func TestRefusalsKeepTheirCodeAndAreNotFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"DRIVE_NAME_TAKEN","message":"\"a\" is already taken in that folder."}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "t"})
	for i := 0; i < 5; i++ {
		_, err := c.Create(context.Background(), "/a", "h", nil)
		if CodeOf(err) != CodeNameTaken || StatusOf(err) != 409 || Transient(err) {
			t.Fatalf("err %v", err)
		}
	}
	if c.Health().Offline() {
		t.Fatal("an answered refusal is the server reachable")
	}
}

func TestThreeFailuresWithinTenSecondsAreOffline(t *testing.T) {
	var up atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"changes":[],"cursor":"1:1","more":false,"resync":false}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "t", ProbeInterval: 50 * time.Millisecond})
	changes := make(chan bool, 2)
	c.Health().OnChange(func(online bool, _ time.Time) { changes <- online })
	for i := 0; i < 3; i++ {
		if _, err := c.StatID(context.Background(), "x"); !Transient(err) {
			t.Fatalf("a 502 is transient: %v", err)
		}
	}
	if !c.Health().Offline() || c.Health().Since().IsZero() {
		t.Fatal("three failures in 10 s: offline")
	}
	// Offline, nothing is sent: it fails at once.
	if _, err := c.StatID(context.Background(), "x"); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline: %v", err)
	}
	up.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.RunProbe(ctx)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for _, want := range []bool{false, true} {
		select {
		case online := <-changes:
			if online != want {
				t.Fatalf("health changed to online=%v, want %v", online, want)
			}
		case <-deadline.C:
			t.Fatalf("no health notification for online=%v", want)
		}
	}
	if c.Health().Offline() {
		t.Fatal("the probe did not bring it back")
	}
}

func TestARequestPastItsDeadlineIsOfflineAtOnce(t *testing.T) {
	// Connections held unanswered: one deadline is enough to say the server is out of reach (§5.7).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	c := New(Config{BaseURL: "http://" + ln.Addr().String(), Token: "t", MetaTimeout: 200 * time.Millisecond})
	start := time.Now()
	_, err = c.StatID(context.Background(), "x")
	if !Transient(err) || time.Since(start) > 2*time.Second {
		t.Fatalf("err %v after %s", err, time.Since(start))
	}
	if !c.Health().Offline() {
		t.Fatal("a request past its deadline: offline")
	}
}

func TestARequestPastItsDeadlineWhileOthersAreAnsweredIsOneFailure(t *testing.T) {
	// A loaded server: one request is held past its deadline while the others are answered. It is slow, not gone.
	held := make(chan struct{})
	var once sync.Once
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("id") == "slow" {
			once.Do(func() { close(held) }) // held again when it is sent once more
			<-release
			return
		}
		_, _ = w.Write([]byte(`{"id":"fast","name":"f","kind":"FILE"}`))
	}))
	defer srv.Close()
	defer close(release) // before Close, which waits for the held request
	c := New(Config{BaseURL: srv.URL, Token: "t", MetaTimeout: 500 * time.Millisecond})
	slow := make(chan error, 1)
	go func() {
		_, err := c.StatID(context.Background(), "slow")
		slow <- err
	}()
	<-held
	if _, err := c.StatID(context.Background(), "fast"); err != nil {
		t.Fatalf("answered while the other waits: %v", err)
	}
	if err := <-slow; !Transient(err) {
		t.Fatalf("past its deadline: %v", err)
	}
	if c.Health().Offline() {
		t.Fatal("one request past its deadline while others were answered: still online")
	}
	if _, err := c.StatID(context.Background(), "fast"); err != nil {
		t.Fatalf("still sent: %v", err)
	}
}

func TestOneSlowAnswerOnItsOwnIsNotOffline(t *testing.T) {
	// The 5 GiB walk: a sequential rm -rf, one stat answered after 17 s while nothing else was in flight, and the
	// mount went offline for a server that was up. Here one stat answers after 12/9 of its deadline (12 s of 9 s).
	const meta = 300 * time.Millisecond
	var stats, probes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/drive/changes":
			probes.Add(1)
			_, _ = w.Write([]byte(`{"changes":[],"cursor":"1:1","more":false,"resync":false}`))
		case "/api/runner/drive/stat":
			if stats.Add(1) == 1 {
				time.Sleep(meta * 12 / 9)
			}
			_, _ = w.Write([]byte(`{"id":"x","name":"x","kind":"FILE"}`))
		}
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "t", MetaTimeout: meta})
	var changes atomic.Int32 // the probe's goroutine may report them
	c.Health().OnChange(func(bool, time.Time) { changes.Add(1) })
	if _, err := c.StatID(context.Background(), "x"); err != nil {
		t.Fatalf("a slow stat is sent once more on a server that answers: %v", err)
	}
	if stats.Load() != 2 || probes.Load() != 1 {
		t.Fatalf("stats %d, probes %d: one stat past its deadline, the probe it sent while waiting, the stat once more", stats.Load(), probes.Load())
	}
	for i := 0; i < 100; i++ {
		if _, err := c.StatID(context.Background(), "x"); err != nil {
			t.Fatalf("request %d after the slow one: %v", i, err)
		}
	}
	if c.Health().Offline() || changes.Load() != 0 {
		t.Fatalf("offline %v, health changes %d: a slow answer is not an unreachable server", c.Health().Offline(), changes.Load())
	}
}

func TestARefusedConnectionIsStillOffline(t *testing.T) {
	// Nothing listens: three failures within 10 s are offline, and from then on nothing is sent (§5.7).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	c := New(Config{BaseURL: "http://" + addr, Token: "t"})
	start := time.Now()
	for i := 0; i < 3; i++ {
		if _, err := c.StatID(context.Background(), "x"); !Transient(err) || errors.Is(err, ErrOffline) {
			t.Fatalf("refused %d: %v", i, err)
		}
	}
	if !c.Health().Offline() {
		t.Fatal("three refused connections: offline")
	}
	if _, err := c.StatID(context.Background(), "x"); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("a refused connection is not waited for: %s", time.Since(start))
	}
}

func TestASupersededInstanceIsFencedForGood(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"MANAGED_RUNNER_INSTANCE_SUPERSEDED","message":"replaced"}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "t"})
	fenced := 0
	c.OnFence(func(*FencedError) { fenced++ })
	_, err := c.StatID(context.Background(), "x")
	var f *FencedError
	if !errors.As(err, &f) || f.Code != CodeInstanceSuperseded {
		t.Fatalf("err %v", err)
	}
	if _, err := c.StatID(context.Background(), "x"); !errors.As(err, &f) {
		t.Fatalf("still fenced: %v", err)
	}
	if calls.Load() != 1 || fenced != 1 {
		t.Fatalf("calls %d, fence callbacks %d: a fenced client sends nothing more", calls.Load(), fenced)
	}
}

func TestATailMovedAnswerCarriesTheTail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Commit
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Mode != "APPEND" || body.ReplaceTail == nil || body.BaseSize != nil {
			t.Errorf("body %+v", body)
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"DRIVE_TAIL_MOVED","message":"grew","versionId":"v1","sizeBytes":12,"tail":{"idx":0,"sha256":"ab","size":12,"offset":0}}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, Token: "t"})
	_, moved, err := c.Commit(context.Background(), Commit{CommitID: "c", EntryID: "e", Mode: "APPEND", BaseVersionID: "v1", ReplaceTail: &ReplaceTail{Idx: 0, OldSHA256: "aa"}})
	if CodeOf(err) != CodeTailMoved || moved == nil || moved.SizeBytes != 12 || moved.Tail == nil || moved.Tail.SHA256 != "ab" {
		t.Fatalf("moved %+v err %v", moved, err)
	}
}
