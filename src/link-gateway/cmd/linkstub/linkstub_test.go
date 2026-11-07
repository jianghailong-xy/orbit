package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testGatewayToken = "gateway-token-for-the-stub-test"

// newTestStub is a stub on an httptest server, answering after delay, and its key. Its link tokens name linkURL, or
// wss://localhost:62443 when it is empty.
func newTestStub(t *testing.T, delay time.Duration, linkURL string) (*stub, *httptest.Server, ed25519.PrivateKey) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if linkURL == "" {
		linkURL = "wss://localhost:62443"
	}
	s := newStub(key, testGatewayToken, linkURL, "cell-1", delay, time.Hour)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return s, srv, key
}

// call sends a request and returns the status and body.
func call(t *testing.T, srv *httptest.Server, method, path, token, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestEveryGatewayRouteGetsTheSmallestValidAnswer(t *testing.T) {
	s, srv, _ := newTestStub(t, 0, "")
	type answer struct {
		status int
		body   string
	}
	session := "6f1d7a52-3c51-4c2e-9d6f-1f1e2d3c4b5a"
	for _, c := range []struct {
		name, method, path, body string
		want                     answer
	}{
		{"welcome", "POST", "/api/runner/link/welcome", `{"sessionIds":["b","a"]}`,
			answer{200, `{"sessions":[{"sessionId":"b","durableSeq":0,"leaseHeld":true},{"sessionId":"a","durableSeq":0,"leaseHeld":true}]}`}},
		{"heartbeat", "POST", "/api/runner/heartbeat", `{"status":"ONLINE","leaseOwner":"p"}`, answer{200, string(quietBeat)}},
		{"events", "POST", "/api/runner/sessions/" + session + "/events", `{"leaseOwner":"p","events":[{"seq":7,"payload":{"text":"x"}},{"seq":8,"payload":null}]}`,
			answer{202, `{"ok":true,"durableSeq":8,"rejected":[]}`}},
		{"merged", "POST", "/api/runner/link/events",
			`{"connections":[{"linkToken":"t"}],"batches":[{"connection":0,"sessionId":"a","events":[{"seq":1},{"seq":2}]},{"connection":0,"sessionId":"b","events":[{"seq":40}]}]}`,
			answer{200, `{"results":[{"ok":true,"durableSeq":2,"rejected":[]},{"ok":true,"durableSeq":40,"rejected":[]}],"heldMs":0}`}},
		{"a tunnelled request", "POST", "/api/runner/sessions/" + session + "/inbox/ack", `{"ids":["x"]}`, answer{200, `{}`}},
		{"a tunnelled read", "GET", "/api/runner/sessions/" + session + "/events?after=3", "", answer{200, `{}`}},
	} {
		status, body := call(t, srv, c.method, c.path, testGatewayToken, c.body)
		if status != c.want.status || string(body) != c.want.body {
			t.Errorf("%s: %d %s, want %d %s", c.name, status, body, c.want.status, c.want.body)
		}
		// Without the gateway's token, refused as the apiserver refuses it.
		if status, _ := call(t, srv, c.method, c.path, "not-the-token", c.body); status != 401 {
			t.Errorf("%s without the gateway token: %d", c.name, status)
		}
	}
	status, body := call(t, srv, "GET", "/api/runner/link-token/revocations", testGatewayToken, "")
	var list struct {
		Since       string `json:"since"`
		Revocations []any  `json:"revocations"`
	}
	if err := json.Unmarshal(body, &list); status != 200 || err != nil || list.Revocations == nil || len(list.Revocations) != 0 {
		t.Errorf("revocations: %d %s", status, body)
	}
	if since, err := time.Parse(time.RFC3339Nano, list.Since); err != nil || time.Since(since) < 69*time.Minute || time.Since(since) > 71*time.Minute {
		t.Errorf("the revocation list reaches back to %s, want 70 minutes", list.Since)
	}
	if status, _ := call(t, srv, "POST", "/api/runner/link/events", testGatewayToken, `{"batches":`); status != 400 {
		t.Errorf("a merged call that does not read: %d, want 400 so the gateway sends each batch alone", status)
	}
	if status, _ := call(t, srv, "GET", "/api/sessions", testGatewayToken, ""); status != 404 {
		t.Errorf("a route that is not a runner's: %d", status)
	}
	st := s.stats()
	for route, calls := range map[string]int64{routeWelcome: 2, routeHeartbeat: 2, routeEvents: 2, routeEventsMerged: 3,
		routeRPC: 4, routeRevocations: 1, routeUnknown: 1} {
		if got := st.Routes[route].Calls; got != calls {
			t.Errorf("stats: %d calls of %s, want %d", got, route, calls)
		}
	}
	if st.Routes[routeHeartbeat].ByStatus["2xx"] != 1 || st.Routes[routeHeartbeat].ByStatus["4xx"] != 1 {
		t.Errorf("stats by status: %v", st.Routes[routeHeartbeat].ByStatus)
	}
}

func TestAnswersWaitTheDelayFromArrival(t *testing.T) {
	s, srv, _ := newTestStub(t, 30*time.Millisecond, "")
	started := time.Now()
	if status, _ := call(t, srv, "POST", "/api/runner/heartbeat", testGatewayToken, `{}`); status != 200 {
		t.Fatalf("heartbeat: %d", status)
	}
	if took := time.Since(started); took < 30*time.Millisecond {
		t.Errorf("answered in %s, before the 30ms delay", took)
	}
	st := s.stats().Routes[routeHeartbeat]
	if st.Answered.Count != 1 || st.Answered.MaxMs < 30 || st.Work.MaxMs >= 30 || len(st.Answered.Buckets) != 1 {
		t.Errorf("stats: answered %+v, work %+v", st.Answered, st.Work)
	}
	if v := s.stats(); v.DelayMs != 30 || v.CPUSeconds <= 0 || v.MaxRSSBytes <= 0 || v.InFlightMax != 1 || v.InFlight != 0 {
		t.Errorf("stats: delay %v ms, cpu %v s, rss %d, in flight %d (most %d)", v.DelayMs, v.CPUSeconds, v.MaxRSSBytes, v.InFlight, v.InFlightMax)
	}
	// The stats themselves answer at once and are not counted.
	started = time.Now()
	if status, body := call(t, srv, "GET", "/stub/stats", "", ""); status != 200 || !json.Valid(body) || time.Since(started) >= 30*time.Millisecond {
		t.Errorf("GET /stub/stats: %d in %s", status, time.Since(started))
	}
}

func TestALinkTokenIsTheApiserversForTheRunnerItsTokenNames(t *testing.T) {
	_, srv, key := newTestStub(t, 0, "")
	runner, owner := "1c6b1f5e-8a5f-4d1e-9a3f-2b7c8d9e0f1a", "7d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a"
	runnerTok := runnerToken(runner, owner)
	status, body := call(t, srv, "POST", "/api/runner/link-token", runnerTok, `{"leaseOwner":"8e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b"}`)
	var minted struct {
		Token, ExpiresAt, CellID, LinkURL string
	}
	if err := json.Unmarshal(body, &minted); status != 200 || err != nil {
		t.Fatalf("mint: %d %s", status, body)
	}
	parts := strings.Split(minted.Token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a compact JWS: %s", minted.Token)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if !ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(parts[0]+"."+parts[1]), sig) {
		t.Fatal("the signature does not verify with the stub's public key")
	}
	var header map[string]string
	headerJSON, _ := base64.RawURLEncoding.DecodeString(parts[0])
	_ = json.Unmarshal(headerJSON, &header)
	pub := key.Public().(ed25519.PublicKey)
	sum := sha256.Sum256([]byte(fmt.Sprintf(`{"crv":"Ed25519","kty":"OKP","x":"%s"}`, base64.RawURLEncoding.EncodeToString(pub))))
	if header["alg"] != "EdDSA" || header["typ"] != "JWT" || header["kid"] != base64.RawURLEncoding.EncodeToString(sum[:]) {
		t.Errorf("header %v", header)
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	// The apiserver's claims, in its order (signRunnerLinkToken).
	keys := []string{`"aud"`, `"jti"`, `"runnerId"`, `"ownerId"`, `"cellId"`, `"linkUrl"`, `"leaseOwner"`, `"credential"`, `"iat"`, `"exp"`}
	last := -1
	for _, k := range keys {
		i := bytes.Index(payload, []byte(k))
		if i <= last {
			t.Errorf("claim %s missing or out of order in %s", k, payload)
		}
		last = i
	}
	var c linkClaims
	_ = json.Unmarshal(payload, &c)
	if c.Aud != "orbit-runner-link" || c.RunnerID != runner || c.OwnerID != owner || c.CellID != "cell-1" || c.LinkURL != "wss://localhost:62443" ||
		c.LeaseOwner != "8e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b" || len(c.Credential) != 32 || c.EXP-c.IAT != 3600 || !isUUID(c.JTI) {
		t.Errorf("claims %+v", c)
	}
	if exp, err := time.Parse(time.RFC3339Nano, minted.ExpiresAt); err != nil || exp.Unix() != c.EXP || minted.CellID != "cell-1" || minted.LinkURL != c.LinkURL {
		t.Errorf("answer %+v", minted)
	}
	for _, bad := range []struct{ token, body string }{
		{"linkstub.not-a-uuid." + owner, `{"leaseOwner":"p"}`},
		{runner, `{"leaseOwner":"p"}`},
		{"", `{"leaseOwner":"p"}`},
	} {
		if status, _ := call(t, srv, "POST", "/api/runner/link-token", bad.token, bad.body); status != 401 {
			t.Errorf("runner token %q: %d, want 401", bad.token, status)
		}
	}
	if status, _ := call(t, srv, "POST", "/api/runner/link-token", runnerTok, `{}`); status != 400 {
		t.Errorf("no leaseOwner: %d, want 400", status)
	}
}

func TestTheSigningKeyIsReadAsOpensslWritesIt(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "signing.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readSigningKey(path)
	if err != nil || !got.Equal(key) {
		t.Errorf("read %v, %v", got, err)
	}
	if err := os.WriteFile(path, []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSigningKey(path); err == nil {
		t.Error("a file without PEM was read as a key")
	}
}

func TestTheFleetHasTheCellsShapeAndTokensTheStubReads(t *testing.T) {
	fleet := buildFleet(300, 800, 100, 7)
	runners, sessions, owners := map[string]bool{}, map[string]bool{}, map[string]int{}
	var active []int
	for i, r := range fleet {
		runner, owner, ok := parseRunnerToken(r.Token)
		if !ok || runner != r.Runner || !isUUID(r.Process) || runners[r.Runner] {
			t.Fatalf("runner %d: %+v", i, r)
		}
		runners[r.Runner] = true
		owners[owner]++
		if n := len(r.Sessions); n < 2 || n > 3 {
			t.Errorf("runner %d supervises %d sessions, want 2 or 3 (800 over 300)", i, n)
		}
		for _, s := range r.Sessions {
			if !isUUID(s) || sessions[s] {
				t.Fatalf("session %q drawn twice or not a UUID", s)
			}
			sessions[s] = true
		}
		if len(r.Active) > 1 {
			t.Errorf("runner %d has %d running sessions", i, len(r.Active))
		}
		if len(r.Active) == 1 {
			active = append(active, i)
			if a := r.Active[0]; a.Seq != 0 || !contains(r.Sessions, a.ID) {
				t.Errorf("runner %d runs %+v, not one of its sessions from seq 0", i, a)
			}
		}
	}
	if len(sessions) != 800 || len(active) != 100 || len(owners) != 200 {
		t.Errorf("%d sessions, %d running, %d owners; want 800, 100, 200", len(sessions), len(active), len(owners))
	}
	// Spread evenly: every third runner, so any first N runners and any shard of them carry their share.
	for j, i := range active {
		if i != 3*j {
			t.Fatalf("running session %d is on runner %d, want %d", j, i, 3*j)
		}
	}
	again := buildFleet(300, 800, 100, 7)
	other := buildFleet(300, 800, 100, 8)
	if again[0].Runner != fleet[0].Runner || again[299].Sessions[0] != fleet[299].Sessions[0] || other[0].Runner == fleet[0].Runner {
		t.Error("the fleet does not follow its seed")
	}
	var out bytes.Buffer
	if code := run([]string{"fleet", "-runners", "30"}, &out, io.Discard); code != 0 {
		t.Fatalf("linkstub fleet exited %d", code)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	var first fleetRunner
	if len(lines) != 30 || json.Unmarshal([]byte(lines[0]), &first) != nil || len(first.Active) != 1 {
		t.Errorf("linkstub fleet -runners 30: %d lines, first %+v", len(lines), first)
	}
	if code := run([]string{"fleet", "-runners", "3", "-sessions", "2"}, io.Discard, io.Discard); code != 2 {
		t.Errorf("fewer sessions than runners: exit %d", code)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
