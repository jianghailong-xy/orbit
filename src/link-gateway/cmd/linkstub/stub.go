package main

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// What each route is, in the stats: the routes the gateway calls (backend.go, revocations.go, welcome.go, heartbeat.go,
// events.go, events_merge.go, forward.go) and the loadgen's link token.
const (
	routeLinkToken    = "link_token"
	routeRevocations  = "revocations"
	routeWelcome      = "welcome"
	routeHeartbeat    = "heartbeat"
	routeEvents       = "events"
	routeEventsMerged = "events_merged"
	routeRPC          = "rpc"
	routeUnknown      = "unknown"
)

var routeNames = []string{routeLinkToken, routeRevocations, routeWelcome, routeHeartbeat, routeEvents,
	routeEventsMerged, routeRPC, routeUnknown}

// maxBody bounds a call's body: a merged call carries at most 2 MiB of events (LINK_EVENT_MERGE_MAX_BYTES) and its
// connections' headers.
const maxBody = 16 << 20

// The answers that never vary. quietBeat is what the heartbeat route answers a beat that reconciled nothing
// (quietHeartbeatAnswer, src/apiserver/src/runner-api/link-heartbeat.ts), with the link hints a link call gets: nothing
// waits for the runner. A runner applies it and changes nothing.
var (
	quietBeat = []byte(`{"cancelSessionIds":[],"leaseLostSessionIds":[],"maxConcurrent":2,"minFreeDiskMb":0,` +
		`"mergeRequests":[],"commitRequests":[],"artifactRequests":[],` +
		`"linkHints":{"inboxSessionIds":[],"claim":false,"approvals":[]}}`)
	emptyObject = []byte(`{}`)
)

// revocationWindow is how far back the revocation list reaches (RUNNER_LINK_REVOCATION_WINDOW_MS): a token's hour and
// ten minutes for the clocks.
const revocationWindow = 70 * time.Minute

type stub struct {
	key             ed25519.PrivateKey
	kid             string
	gatewayToken    string
	linkURL, cell   string
	delay, tokenTTL time.Duration
	now             func() time.Time
	started         time.Time
	// inFlight is how many calls the stub holds now, inFlightMax the most it held at once.
	inFlight, inFlightMax atomic.Int64
	routes                map[string]*routeStats
}

// routeStats is what one route answered.
type routeStats struct {
	mu                sync.Mutex
	calls             int64
	byStatus          map[string]int64
	bytesIn, bytesOut int64
	// work is from a call's arrival to its answer being ready, the stub's own work; answered is to its answer written,
	// what the gateway waits for, the delay included.
	work, answered *hist
}

func newRouteTable() map[string]*routeStats {
	t := make(map[string]*routeStats, len(routeNames))
	for _, name := range routeNames {
		t[name] = &routeStats{byStatus: map[string]int64{}, work: newHist(), answered: newHist()}
	}
	return t
}

func (s *stub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/stub/stats" && r.Method == http.MethodGet {
		b, _ := json.Marshal(s.stats())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
		return
	}
	arrived := s.now()
	held := s.inFlight.Add(1)
	defer s.inFlight.Add(-1)
	for most := s.inFlightMax.Load(); held > most && !s.inFlightMax.CompareAndSwap(most, held); most = s.inFlightMax.Load() {
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	route, status, answer := s.answer(r, body, err)
	ready := s.now()
	// The delay counts from the call's arrival, so the stub's own work is inside it: a call answered later than the
	// delay is a stub that is not keeping up, which its stats show.
	if wait := s.delay - ready.Sub(arrived); wait > 0 {
		time.Sleep(wait)
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(answer)))
	w.WriteHeader(status)
	_, _ = w.Write(answer)
	done := s.now()
	st := s.routes[route]
	st.mu.Lock()
	st.calls++
	st.byStatus[strconv.Itoa(status/100)+"xx"]++
	st.bytesIn += int64(len(body))
	st.bytesOut += int64(len(answer))
	st.work.add(ready.Sub(arrived))
	st.answered.add(done.Sub(arrived))
	st.mu.Unlock()
}

// answer is a call's route, status and body.
func (s *stub) answer(r *http.Request, body []byte, readErr error) (string, int, []byte) {
	p := r.URL.Path
	if p == "/api/runner/link-token" && r.Method == http.MethodPost {
		if readErr != nil || len(body) > maxBody {
			return routeLinkToken, http.StatusBadRequest, refusal("STUB_BAD_BODY", "the body could not be read")
		}
		status, answer := s.mint(r, body)
		return routeLinkToken, status, answer
	}
	if !strings.HasPrefix(p, "/api/runner/") {
		return routeUnknown, http.StatusNotFound, refusal("NOT_FOUND", "the stub answers runner routes only")
	}
	route := routeOf(r.Method, p)
	// Everything else is the gateway's, which names its token in every call (backend.go), as the apiserver requires.
	if bearer(r) != s.gatewayToken {
		return route, http.StatusUnauthorized, refusal("UNAUTHENTICATED", "the call does not carry the gateway token")
	}
	if readErr != nil || len(body) > maxBody {
		return route, http.StatusBadRequest, refusal("STUB_BAD_BODY", "the body could not be read")
	}
	switch route {
	case routeRevocations:
		b, _ := json.Marshal(map[string]any{"since": iso(s.now().Add(-revocationWindow)), "revocations": []any{}})
		return route, http.StatusOK, b
	case routeWelcome:
		status, answer := welcome(body)
		return route, status, answer
	case routeHeartbeat:
		return route, http.StatusOK, quietBeat
	case routeEvents:
		status, answer := storeBatch(body)
		return route, status, answer
	case routeEventsMerged:
		status, answer := storeMerged(body)
		return route, status, answer
	default:
		// A tunnelled request to any other runner route: answered, with nothing in it.
		return route, http.StatusOK, emptyObject
	}
}

// routeOf names the gateway's call by its method and path.
func routeOf(method, p string) string {
	switch {
	case method == http.MethodGet && p == "/api/runner/link-token/revocations":
		return routeRevocations
	case method == http.MethodPost && p == "/api/runner/link/welcome":
		return routeWelcome
	case method == http.MethodPost && p == "/api/runner/heartbeat":
		return routeHeartbeat
	case method == http.MethodPost && p == "/api/runner/link/events":
		return routeEventsMerged
	case method == http.MethodPost && strings.HasPrefix(p, "/api/runner/sessions/") && strings.HasSuffix(p, "/events") &&
		!strings.Contains(strings.TrimSuffix(strings.TrimPrefix(p, "/api/runner/sessions/"), "/events"), "/"):
		return routeEvents
	}
	return routeRPC
}

// welcome answers the welcome route (runner-link-welcome.ts) for a process that holds every session it names, none of
// whose events are stored yet, with no release assigned: each session asked about, in the order asked.
func welcome(body []byte) (int, []byte) {
	var asked struct {
		SessionIDs []string `json:"sessionIds"`
	}
	if err := json.Unmarshal(body, &asked); err != nil {
		return http.StatusBadRequest, refusal("STUB_BAD_BODY", "the body is not the welcome route's")
	}
	type state struct {
		SessionID  string `json:"sessionId"`
		DurableSeq uint64 `json:"durableSeq"`
		LeaseHeld  bool   `json:"leaseHeld"`
	}
	sessions := make([]state, len(asked.SessionIDs))
	for i, id := range asked.SessionIDs {
		sessions[i] = state{SessionID: id, LeaseHeld: true}
	}
	b, _ := json.Marshal(map[string]any{"sessions": sessions})
	return http.StatusOK, b
}

// batchSeqs is what the stub reads of an event batch: each event's seq.
type batchSeqs struct {
	Events []struct {
		Seq uint64 `json:"seq"`
	} `json:"events"`
}

func (b *batchSeqs) last() uint64 {
	if len(b.Events) == 0 {
		return 0
	}
	return b.Events[len(b.Events)-1].Seq
}

// storeBatch answers the events route for one batch as the link's ingest answers a batch it stored whole
// (LinkEventsAnswer, link-events.ts): 202, every event up to its last seq stored, none refused.
func storeBatch(body []byte) (int, []byte) {
	var b batchSeqs
	if err := json.Unmarshal(body, &b); err != nil {
		return http.StatusBadRequest, refusal("EVENT_BATCH_MALFORMED", "the body is not an event batch")
	}
	return http.StatusAccepted, stored(nil, b.last())
}

// storeMerged answers a merged call (LinkEventCallAnswer, link-events.ts): each batch stored whole, in the order asked,
// and no session held, so heldMs is 0.
func storeMerged(body []byte) (int, []byte) {
	var call struct {
		Batches []batchSeqs `json:"batches"`
	}
	if err := json.Unmarshal(body, &call); err != nil {
		return http.StatusBadRequest, refusal("LINK_EVENT_CALL_MALFORMED", "the body is not a merged call")
	}
	out := make([]byte, 0, 16+48*len(call.Batches))
	out = append(out, `{"results":[`...)
	for i := range call.Batches {
		if i > 0 {
			out = append(out, ',')
		}
		out = stored(out, call.Batches[i].last())
	}
	return http.StatusOK, append(out, `],"heldMs":0}`...)
}

func stored(out []byte, durable uint64) []byte {
	out = append(out, `{"ok":true,"durableSeq":`...)
	out = strconv.AppendUint(out, durable, 10)
	return append(out, `,"rejected":[]}`...)
}

// refusal is an error answer in the link's shape (common/runner-link-error.filter.ts): its code and that sending it
// again will not help.
func refusal(code, message string) []byte {
	b, _ := json.Marshal(map[string]any{"code": code, "message": message, "retryable": false})
	return b
}

func bearer(r *http.Request) string {
	if v, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// iso is a time as the apiserver writes one (Date.toISOString): UTC, to the millisecond.
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// statsView is GET /stub/stats: what the stub did since it started.
type statsView struct {
	T             int64   `json:"t"` // Unix milliseconds
	StartedAt     string  `json:"startedAt"`
	UptimeSeconds float64 `json:"uptimeSeconds"`
	DelayMs       float64 `json:"delayMs"`
	// CPUSeconds is the process's CPU time, user and system; MaxRSSBytes the most memory it held.
	CPUSeconds  float64              `json:"cpuSeconds"`
	MaxRSSBytes int64                `json:"maxRssBytes"`
	Goroutines  int                  `json:"goroutines"`
	InFlight    int64                `json:"inFlight"`
	InFlightMax int64                `json:"inFlightMax"`
	Routes      map[string]routeView `json:"routes"`
}

type routeView struct {
	Calls    int64            `json:"calls"`
	ByStatus map[string]int64 `json:"byStatus"`
	BytesIn  int64            `json:"bytesIn"`
	BytesOut int64            `json:"bytesOut"`
	Work     histView         `json:"work"`
	Answered histView         `json:"answered"`
}

func (s *stub) stats() statsView {
	now := s.now()
	v := statsView{T: now.UnixMilli(), StartedAt: iso(s.started), UptimeSeconds: now.Sub(s.started).Seconds(),
		DelayMs: float64(s.delay) / float64(time.Millisecond), Goroutines: runtime.NumGoroutine(),
		InFlight: s.inFlight.Load(), InFlightMax: s.inFlightMax.Load(), Routes: map[string]routeView{}}
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) == nil {
		v.CPUSeconds = float64(ru.Utime.Sec+ru.Stime.Sec) + float64(ru.Utime.Usec+ru.Stime.Usec)/1e6
		v.MaxRSSBytes = int64(ru.Maxrss) * 1024 // kilobytes on Linux
	}
	for name, st := range s.routes {
		st.mu.Lock()
		if st.calls > 0 {
			by := make(map[string]int64, len(st.byStatus))
			for k, n := range st.byStatus {
				by[k] = n
			}
			v.Routes[name] = routeView{Calls: st.calls, ByStatus: by, BytesIn: st.bytesIn, BytesOut: st.bytesOut,
				Work: st.work.view(), Answered: st.answered.view()}
		}
		st.mu.Unlock()
	}
	return v
}

func writeStats(path string, v statsView) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		return errors.New("the stats could not be written: " + err.Error())
	}
	return nil
}
