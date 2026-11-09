// Command stubserver is the control plane scripts/hostd-e2e.sh runs inside its systemd
// container. It answers the least of the runner API that `orbit register`, `orbit unregister` and
// a registered `orbit run` need — register waits until /runner/me reports a heartbeat from the
// service it started — and serves the /dl release directory hostd's update installs from. A runner
// beats, and makes its daemon calls, only over the runner link, so the stub is its link gateway too
// (link.go).
//
// It models nothing beyond that: every answer is the smallest one the runner accepts, there is
// never a session to claim, and nothing survives a restart. What it does keep is what the
// end-to-end run asserts on — which runners exist, and what each one's heartbeats last said.
//
//	stubserver serve -addr 127.0.0.1:18080 -dl /srv/orbit-dl
//	stubserver get http://127.0.0.1:18080/stub/runners
//	stubserver execwatch -prefix /usr/local/bin/orbit.new- -out /var/log/execwatch.log
//
// Releases are published by writing into the -dl directory: the orbit-<platform>.gz assets and
// the version.json cmd/release-manifest writes for them, manifest last. The first heartbeat a
// runner sends while it reports a version other than the published one is answered with
// checkSelfUpdate, which is what the owner's "Update Runner Now" sends.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// claimHold is how long an empty claim long-poll is held before answering "nothing", as the real
// control plane holds it (25 s there), so an idle runner does not spin on its claim loop.
const claimHold = 20 * time.Second

type runner struct {
	id, token, name string
	deleted         bool
	beats           int
	linkBeats       int    // of beats, those that came over the runner link (link.go)
	version         string // as the newest heartbeat reported it
	selfUpdate      string // the self-update state and reason the newest heartbeat reported
	lastBeat        time.Time
	offered         string // the release this runner was last asked to check for
}

type stub struct {
	dl string

	mu      sync.Mutex
	seq     int
	runners []*runner          // in registration order
	byToken map[string]*runner // credential -> runner
	// linkTokens are the connection tokens POST /api/runner/link-token issued, each to its runner.
	linkTokens map[string]*runner
	// handler is routes(), which the link's tunnelled calls are answered by too.
	handler http.Handler
	devices map[string]*device // deviceCode -> pending or approved device registration
}

type device struct {
	name   string
	runner *runner // set once the first poll approved it
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: stubserver serve -addr HOST:PORT -dl DIR | get URL | execwatch -prefix PATH -out FILE")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		addr := fs.String("addr", "127.0.0.1:18080", "listen address")
		dl := fs.String("dl", "", "directory served under /dl/ (version.json and orbit-<platform>.gz)")
		_ = fs.Parse(os.Args[2:])
		if *dl == "" {
			log.Fatal("serve needs -dl")
		}
		s := &stub{dl: *dl, byToken: map[string]*runner{}, devices: map[string]*device{}, linkTokens: map[string]*runner{}}
		s.handler = s.routes()
		log.Printf("stub control plane on http://%s, its runner link on ws://%s/link, releases from %s", *addr, *addr, *dl)
		log.Fatal(http.ListenAndServe(*addr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Del(viaLinkHeader) // set only by the link's own forwarding (link.go serve)
			s.handler.ServeHTTP(w, r)
		})))
	case "get":
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "usage: stubserver get URL")
			os.Exit(2)
		}
		os.Exit(get(os.Args[2]))
	case "execwatch":
		fs := flag.NewFlagSet("execwatch", flag.ExitOnError)
		prefix := fs.String("prefix", "", "record processes whose argv[0] starts with this")
		out := fs.String("out", "", "file the records are appended to")
		_ = fs.Parse(os.Args[2:])
		if *prefix == "" || *out == "" {
			log.Fatal("execwatch needs -prefix and -out")
		}
		log.Fatal(execwatch(*prefix, *out))
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

// get is the container's curl: it has none, and the script asks the stub what it saw.
func get(url string) int {
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(os.Stdout, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "HTTP %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

func (s *stub) routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /dl/", http.StripPrefix("/dl/", http.FileServer(http.Dir(s.dl))))
	mux.HandleFunc("POST /api/runner/register", s.register)
	mux.HandleFunc("POST /api/runner/device/start", s.deviceStart)
	mux.HandleFunc("POST /api/runner/device/poll", s.devicePoll)
	mux.HandleFunc("POST /api/runner/heartbeat", s.authed(s.heartbeat))
	mux.HandleFunc("GET /api/runner/me", s.authed(s.me))
	mux.HandleFunc("GET /api/runner/sessions/claim", s.authed(s.claim))
	mux.HandleFunc("GET /api/runner/sessions/reclaim", s.authed(s.reclaim))
	mux.HandleFunc("POST /api/runner/deregister", s.authed(s.deregister))
	mux.HandleFunc("POST /api/runner/link-token", s.authed(s.linkToken))
	mux.HandleFunc("GET /link", s.link)
	mux.HandleFunc("GET /stub/runners", s.listRunners)
	// Everything else the runner may ask — the wake long-poll, the release assignment, its
	// workspaces — it does without, as it does against a control plane that has no such route.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not served by the e2e stub"})
	})
	return logRequests(mux)
}

// register is the --token path: an enrollment token, any non-empty one, mints a runner.
func (s *stub) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		EnrollmentToken string `json:"enrollmentToken"`
		Name            string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.EnrollmentToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "an enrollment token is required"})
		return
	}
	rn := s.mint(req.Name)
	writeJSON(w, http.StatusOK, map[string]string{"runnerId": rn.id, "runnerToken": rn.token, "name": rn.name})
}

// deviceStart and devicePoll are the browser-approval path, approved at the first poll: nobody
// opens a browser inside the container.
func (s *stub) deviceStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	code := "device-" + randomHex(8)
	s.mu.Lock()
	s.devices[code] = &device{name: req.Name}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"deviceCode": code, "userCode": "E2E00-E2E00", "interval": 1, "expiresIn": 600,
	})
}

func (s *stub) devicePoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceCode string `json:"deviceCode"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	s.mu.Lock()
	d := s.devices[req.DeviceCode]
	if d != nil && d.runner == nil {
		d.runner = s.mintLocked(d.name)
	}
	s.mu.Unlock()
	if d == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "expired"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "approved", "runnerId": d.runner.id, "runnerToken": d.runner.token, "name": d.runner.name,
	})
}

func (s *stub) mint(name string) *runner {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mintLocked(name)
}

func (s *stub) mintLocked(name string) *runner {
	s.seq++
	rn := &runner{id: fmt.Sprintf("runner-%d", s.seq), token: randomHex(24), name: name}
	if rn.name == "" {
		rn.name = rn.id
	}
	s.runners = append(s.runners, rn)
	s.byToken[rn.token] = rn
	log.Printf("registered %s (%s)", rn.id, rn.name)
	return rn
}

// authed resolves the bearer credential to a live runner, or answers 401 as the control plane
// does for a credential it never issued or has deleted.
func (s *stub) authed(next func(http.ResponseWriter, *http.Request, *runner)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		s.mu.Lock()
		rn := s.byToken[token]
		s.mu.Unlock()
		if token == "" || rn == nil || rn.deleted {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown runner credential"})
			return
		}
		next(w, r, rn)
	}
}

func (s *stub) heartbeat(w http.ResponseWriter, r *http.Request, rn *runner) {
	var req struct {
		Version    string `json:"version"`
		SelfUpdate *struct {
			State  string `json:"state"`
			Reason string `json:"reason"`
		} `json:"selfUpdate"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req)
	published := s.published()
	selfUpdate := ""
	if req.SelfUpdate != nil {
		selfUpdate = strings.TrimSuffix(req.SelfUpdate.State+": "+req.SelfUpdate.Reason, ": ")
	}
	s.mu.Lock()
	rn.beats++
	if r.Header.Get(viaLinkHeader) != "" {
		rn.linkBeats++
	}
	rn.version = req.Version
	rn.lastBeat = time.Now()
	reported := selfUpdate != "" && selfUpdate != rn.selfUpdate
	rn.selfUpdate = selfUpdate
	// Update Runner Now, pressed once per published release: the control plane marks the runner
	// and the next beat claims the mark (drainSelfUpdateRequest in runner-api.controller.ts).
	// Answering every beat instead would loop, because the runner beats again the moment its
	// check has run.
	checkUpdate := published != "" && req.Version != "" && published != req.Version && rn.offered != published
	if checkUpdate {
		rn.offered = published
	}
	s.mu.Unlock()
	if reported {
		log.Printf("%s (%s) on orbit %s reports self-update %s", rn.id, rn.name, req.Version, selfUpdate)
	}
	if checkUpdate {
		log.Printf("%s (%s) reports orbit %s, %s is published: asking it to check for an update", rn.id, rn.name, req.Version, published)
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancelSessionIds": []string{}, "checkSelfUpdate": checkUpdate})
}

// me is what the control plane last heard from the runner: `orbit register` asks it until the
// service it started has beaten, and `orbit status` prints it. A runner that never beat has no
// lastHeartbeatAt, as on the real control plane.
func (s *stub) me(w http.ResponseWriter, _ *http.Request, rn *runner) {
	s.mu.Lock()
	var last any
	if !rn.lastBeat.IsZero() {
		last = rn.lastBeat.UTC().Format(time.RFC3339Nano)
	}
	resp := map[string]any{
		"id": rn.id, "name": rn.name, "status": "ONLINE", "lastHeartbeatAt": last,
		"online": !rn.lastBeat.IsZero() && time.Since(rn.lastBeat) < 90*time.Second, "workspaces": []any{},
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, resp)
}

// published is the version /dl/version.json names right now, or "" when there is none.
func (s *stub) published() string {
	data, err := os.ReadFile(filepath.Join(s.dl, "version.json"))
	if err != nil {
		return ""
	}
	var m struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &m) != nil {
		return ""
	}
	return m.Version
}

// claim holds the long poll and then hands out nothing: no session is ever queued here.
func (s *stub) claim(w http.ResponseWriter, r *http.Request, _ *runner) {
	select {
	case <-r.Context().Done():
		return
	case <-time.After(claimHold):
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *stub) reclaim(w http.ResponseWriter, _ *http.Request, _ *runner) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{}})
}

func (s *stub) deregister(w http.ResponseWriter, _ *http.Request, rn *runner) {
	s.mu.Lock()
	rn.deleted = true
	s.mu.Unlock()
	log.Printf("deregistered %s (%s)", rn.id, rn.name)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// listRunners is for the script, one runner per line:
//
//	<name> <id> <live|deleted> <heartbeats> <last reported version or -> <seconds since the last beat or -> <heartbeats over the runner link>
func (s *stub) listRunners(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	for _, rn := range s.runners {
		state, version, age := "live", "-", "-"
		if rn.deleted {
			state = "deleted"
		}
		if rn.version != "" {
			version = rn.version
		}
		if !rn.lastBeat.IsZero() {
			age = fmt.Sprintf("%d", int(time.Since(rn.lastBeat).Seconds()))
		}
		fmt.Fprintf(w, "%s %s %s %d %s %s %d\n", rn.name, rn.id, state, rn.beats, version, age, rn.linkBeats)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap lets the link's upgrade reach the connection underneath (http.Hijacker).
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// logRequests writes one journal line per request, so a failed run shows what the runners and
// hostd actually asked for. The script's own polling of /stub/ is left out.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		if !strings.HasPrefix(r.URL.Path, "/stub/") {
			log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}
