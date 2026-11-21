package door

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
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
	var changes []bool
	c.Health().OnChange(func(online bool, _ time.Time) { changes = append(changes, online) })
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
	deadline := time.Now().Add(5 * time.Second)
	for c.Health().Offline() {
		if time.Now().After(deadline) {
			t.Fatal("the probe did not bring it back")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(changes) != 2 || changes[0] || !changes[1] {
		t.Fatalf("health changes %v", changes)
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
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("id") == "slow" {
			close(held)
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
