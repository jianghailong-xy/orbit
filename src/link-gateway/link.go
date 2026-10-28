package main

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"orbit/link-gateway/linkpb"
)

// What a connection in MODE_LINK forwards with (docs/runner-link-design.md §5.6–§5.9, §6.4): requests (forward.go),
// heartbeats (heartbeat.go), durable events (events.go), and the live stream and turn prefixes (live.go). The state
// is the connection's and lives as long as it; nothing here decides what the control plane would decide. Every rule a
// route applies stays in the route the call is forwarded to.

// The headers of a forwarded call (src/apiserver/src/runner-api/runner-link-call.ts).
const (
	runnerLinkTokenHeader = "X-Orbit-Runner-Link-Token"
	linkRequestIDHeader   = "X-Orbit-Link-Request-Id"
	linkSessionIDHeader   = "X-Orbit-Link-Session-Id"
	linkAfterSeqHeader    = "X-Orbit-Link-After-Seq"
	// The gateway node holding the connection, which the heartbeat route records in the runner's presence.
	linkGatewayIDHeader = "X-Orbit-Link-Gateway-Id"
	// What Hello declares, under the names today's runner sends on every HTTPS request (src/runner-go/transport.go doVia).
	runnerCapabilitiesHeader       = "X-Orbit-Runner-Capabilities"
	runnerOSHeader                 = "X-Orbit-Runner-Os"
	runnerProvidersHeader          = "X-Orbit-Supported-Providers"
	runnerCapabilityRevisionHeader = "X-Orbit-Runner-Capability-Revision"
	runnerSchemaRevisionHeader     = "X-Orbit-Runner-Schema-Revision"
	runnerContractDigestHeader     = "X-Orbit-Runner-Contract-Digest"
	runnerCLIVersionHeader         = "X-Orbit-CLI-Version"
	managedGenerationHeader        = "X-Orbit-Managed-Runner-Generation"
	managedPodUIDHeader            = "X-Orbit-Managed-Runner-Pod-Uid"
)

type linkState struct {
	c *conn

	// Bounded concurrency: calls in flight, and sessions whose events are being stored at once.
	rpcSlots    chan struct{}
	ingestSlots chan struct{}
	// beats holds the newest heartbeat not yet forwarded; a newer one replaces it (heartbeat.go).
	beats chan *linkpb.Heartbeat
	// facts is the last full value of each fact kind, for beats that send a digest only. Only the heartbeat worker
	// touches it.
	facts factCache

	mu        sync.Mutex
	hello     *linkpb.Hello
	providers []string
	// sessions are the sessions the newest heartbeat says this process supervises: where a turn prefix is asked.
	sessions map[string]bool
	closed   bool
	// Events this connection sent that are not acknowledged yet (events.go), against its credit.
	credit   creditLevel
	unacked  creditLevel
	sessionQ map[string]*sessionIngest
	// prefixes are the turn prefix requests relayed to the runner and not answered yet, by request_id (live.go).
	prefixes map[string]*pendingPrefix

	lastFailureLog atomic.Int64
}

func newLinkState(c *conn) *linkState {
	tune := c.g.cfg.link
	return &linkState{
		c:           c,
		rpcSlots:    make(chan struct{}, tune.MaxRPCsInFlight),
		ingestSlots: make(chan struct{}, tune.MaxIngestPerConn),
		beats:       make(chan *linkpb.Heartbeat, 1),
		facts:       newFactCache(),
		sessions:    map[string]bool{},
		sessionQ:    map[string]*sessionIngest{},
		prefixes:    map[string]*pendingPrefix{},
	}
}

// greeted takes the Hello the connection was opened with.
func (l *linkState) greeted(hello *linkpb.Hello) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hello = hello
	l.providers = hello.GetSupportedProviders()
}

// start runs once Welcome is queued: credit is what Welcome granted.
func (l *linkState) start(credit creditLevel) {
	l.mu.Lock()
	l.credit = credit
	l.mu.Unlock()
	go l.heartbeatLoop()
}

// close lets go of what the connection held: its unacknowledged events no longer count against the gateway's ingest
// queue once their calls end (events.go), its sessions leave the queue's line, and the turn prefix requests nobody
// will answer now are answered empty.
func (l *linkState) close() {
	l.mu.Lock()
	l.closed = true
	prefixes := l.prefixes
	l.prefixes = map[string]*pendingPrefix{}
	l.mu.Unlock()
	l.c.g.credit.leave(l)
	for _, p := range prefixes {
		p.answerEmpty(l.c.g, "closed")
	}
}

// setCreditLocked gives the connection a new credit and tells the runner, in a Credit frame. Under l.mu, so that the
// runner is told each change in the order it is made.
func (l *linkState) setCreditLocked(level creditLevel) {
	l.credit = level
	l.c.send(&linkpb.Frame{Body: &linkpb.Frame_Credit{Credit: &linkpb.Credit{
		MaxUnackedEvents: level.Events, MaxUnackedBytes: level.Bytes,
	}}}, true)
}

// headers are what every call forwarded for this connection carries besides the gateway's own secret: the runner's
// link token, which says which runner and which process the call is for, and what Hello declared, under the names the
// runner sends on every HTTPS request today.
func (l *linkState) headers() http.Header {
	l.mu.Lock()
	hello, providers := l.hello, l.providers
	l.mu.Unlock()
	h := http.Header{}
	h.Set(runnerLinkTokenHeader, l.c.token)
	if caps := hello.GetCapabilities(); len(caps) > 0 {
		h.Set(runnerCapabilitiesHeader, strings.Join(caps, ","))
	}
	if os := hello.GetOs(); os != "" {
		h.Set(runnerOSHeader, os)
	}
	if len(providers) > 0 {
		h.Set(runnerProvidersHeader, strings.Join(providers, ","))
	}
	if wc := hello.GetWriteContract(); wc != nil {
		h.Set(runnerCapabilityRevisionHeader, strconv.FormatUint(uint64(wc.GetCapabilityRevision()), 10))
		h.Set(runnerSchemaRevisionHeader, strconv.FormatUint(uint64(wc.GetSchemaRevision()), 10))
		h.Set(runnerContractDigestHeader, wc.GetContractDigest())
	}
	if v := hello.GetRunnerVersion(); v != "" {
		h.Set(runnerCLIVersionHeader, v)
	}
	if mi := hello.GetManagedInstance(); mi != nil {
		h.Set(managedGenerationHeader, mi.GetGeneration())
		h.Set(managedPodUIDHeader, mi.GetPodUid())
	}
	return h
}

// logFailure logs a call that got no usable answer, at most once every ten seconds per connection: the counts are in
// the metrics, and a backend that is down would otherwise log every heartbeat of every runner.
func (l *linkState) logFailure(msg string, args ...any) {
	now := time.Now().UnixNano()
	last := l.lastFailureLog.Load()
	if now-last < int64(10*time.Second) || !l.lastFailureLog.CompareAndSwap(last, now) {
		return
	}
	l.c.log.Warn(msg, args...)
}

// failure is a Failure frame field set.
func failure(code, message string, retryable bool, retryAfter time.Duration) *linkpb.Failure {
	return &linkpb.Failure{Code: code, Message: message, Retryable: retryable, RetryAfterMs: uint32(retryAfter / time.Millisecond)}
}
