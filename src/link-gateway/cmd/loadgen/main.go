// Command loadgen is the runner link's cell-scale load test (task C2, docs/runner-link-design.md §9). It plays a
// fleet of runners against a link gateway in MODE_LINK, each runner on a connection of its own as a runner in link
// mode keeps one: it trades its runner token for a link token, says Hello, heartbeats every Welcome interval with the
// parts of a runner's heartbeat (whole on a connection's first beat, by digest after), replaces its connection make
// before break before the token expires, and streams the durable events of its active sessions in batches, sending a
// batch 1–3 s after its first event or at once on a boundary event (§5.8), until an EventAck covers it.
//
// It measures what the runners see: every refused, failed or missing acknowledgement and every connection that ended
// unasked, and how long each event batch took from its first send to the EventAck covering it. The stack's own view
// (the gateway's metrics, the apiserver's logs, the database's CPU) is collected beside it by
// scripts/runner-link/loadgen-run.sh; scripts/runner-link/loadgen-seed.sh writes the fleet it plays.
//
//	loadgen -fleet fleet.jsonl -api http://127.0.0.1:61086 -link-url wss://link-gateway:8443 -connect 172.19.0.6:8443 \
//	  -ca ca.pem -duration 1h -event-rate 2000 -out results/
//
// It writes series.jsonl (one line per interval), summary.json and errors.log to -out.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type options struct {
	fleet, api, linkURL, connect, caFile, out string
	runners                                   int
	rampRate                                  float64
	duration, settle, drainTimeout, interval  time.Duration
	eventRate                                 float64
	flushMin, flushMax                        time.Duration
	maxBatch                                  int
	renewBefore                               time.Duration
	spreadRenewals                            bool
	seed                                      uint64
	// volatile moves the reports that move in production (volatile.go); volatileEdits is the share of a running
	// session's beats on which its worktree snapshot moved.
	volatile      bool
	volatileEdits float64
}

// fleetRunner is one line of the fleet file (loadgen-seed.sh): a runner, the credential and process it connects with,
// the sessions its heartbeats name, and those of them that stream events, each with the last seq already stored.
type fleetRunner struct {
	Runner   string          `json:"runner"`
	Token    string          `json:"token"`
	Process  string          `json:"process"`
	Sessions []string        `json:"sessions"`
	Active   []activeSession `json:"active"`
}

type activeSession struct {
	ID  string `json:"id"`
	Seq uint64 `json:"seq"`
}

type loadgen struct {
	o              options
	seed           uint64
	runners        []*runner
	activeSessions int
	perSessionRate float64
	apiClient      *http.Client
	dialClient     *http.Client
	ramp           chan struct{}
	stats          *stats
	ever           atomic.Int64
	notesMu        sync.Mutex
	notes          map[string]int64
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	fs := flag.NewFlagSet("loadgen", flag.ContinueOnError)
	var o options
	fs.StringVar(&o.fleet, "fleet", "", "the fleet file loadgen-seed.sh wrote (required)")
	fs.StringVar(&o.api, "api", "", "the Orbit server's origin, for link tokens: http://127.0.0.1:61086 (required)")
	fs.StringVar(&o.linkURL, "link-url", "", "dial this link address instead of the one tokens name, e.g. wss://link-gateway:8443")
	fs.StringVar(&o.connect, "connect", "", "open the link's TCP connections to this host:port, whatever the link address names (TLS still checks its name)")
	fs.StringVar(&o.caFile, "ca", "", "also trust this PEM CA for the link's TLS")
	fs.StringVar(&o.out, "out", "", "the directory results are written to (required)")
	fs.IntVar(&o.runners, "runners", 0, "play only the fleet's first N runners (default: all)")
	fs.Float64Var(&o.rampRate, "ramp-rate", 150, "first connections opened per second")
	fs.DurationVar(&o.duration, "duration", time.Hour, "how long the steady window lasts")
	fs.DurationVar(&o.settle, "settle", 30*time.Second, "once every runner is connected, how long before the steady window opens: what the ramp left queued drains first")
	fs.DurationVar(&o.drainTimeout, "drain-timeout", 30*time.Second, "after the steady window, how long runners wait for their last events to be acknowledged")
	fs.DurationVar(&o.interval, "interval", 10*time.Second, "how often series.jsonl gets a line")
	fs.Float64Var(&o.eventRate, "event-rate", 2000, "durable events per second across the fleet, shared evenly by the active sessions")
	fs.DurationVar(&o.flushMin, "flush-min", time.Second, "a batch is sent at least this long after its first event, unless a boundary event sends it")
	fs.DurationVar(&o.flushMax, "flush-max", 3*time.Second, "and at most this long after it")
	fs.IntVar(&o.maxBatch, "max-batch", 100, "the most events one batch carries")
	fs.DurationVar(&o.renewBefore, "renew-before", 5*time.Minute, "a connection is replaced this long before its link token expires (linkRenewBefore)")
	fs.BoolVar(&o.spreadRenewals, "spread-renewals", true, "renew each runner's first connection at a random point of its token's life, as a fleet that has run for a while does")
	fs.BoolVar(&o.volatile, "volatile", false, "move the reports that move in production at the runner's own rates: plan usage, directory probes, running sessions' worktrees, engine checks (volatile.go)")
	fs.Float64Var(&o.volatileEdits, "volatile-edits", 0.5, "with -volatile, the share of a running session's beats on which its worktree snapshot moved")
	fs.Uint64Var(&o.seed, "seed", 1, "the random seed")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if o.fleet == "" || o.api == "" || o.out == "" {
		fmt.Fprintln(os.Stderr, "loadgen needs -fleet, -api and -out")
		return 2
	}
	if o.flushMax < o.flushMin || o.maxBatch < 1 || o.rampRate <= 0 {
		fmt.Fprintln(os.Stderr, "loadgen: -flush-max must be at least -flush-min, -max-batch at least 1, -ramp-rate above 0")
		return 2
	}
	if err := os.MkdirAll(o.out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	g, err := newLoadgen(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadgen:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	sum, code := g.run(ctx)
	if sum != nil {
		b, _ := json.MarshalIndent(sum, "", "  ")
		fmt.Println(string(b))
	}
	return code
}

func newLoadgen(o options) (*loadgen, error) {
	fleet, err := readFleet(o.fleet, o.runners)
	if err != nil {
		return nil, err
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if o.caFile != "" {
		pem, err := os.ReadFile(o.caFile)
		if err != nil {
			return nil, err
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s holds no PEM certificate", o.caFile)
		}
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	linkTransport := &http.Transport{
		Proxy:               nil,
		TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 10 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if o.connect != "" {
				addr = o.connect
			}
			return dialer.DialContext(ctx, network, addr)
		},
	}
	apiTransport := &http.Transport{
		Proxy: nil, DialContext: dialer.DialContext, MaxIdleConns: 256, MaxIdleConnsPerHost: 256,
		IdleConnTimeout: 90 * time.Second, TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	}
	errLog, err := os.Create(filepath.Join(o.out, "errors.log"))
	if err != nil {
		return nil, err
	}
	g := &loadgen{
		o: o, seed: o.seed,
		apiClient:  &http.Client{Timeout: 30 * time.Second, Transport: apiTransport},
		dialClient: &http.Client{Transport: linkTransport},
		ramp:       make(chan struct{}),
		stats:      newStats(errLog),
		notes:      map[string]int64{},
	}
	for i, fr := range fleet {
		r := newRunner(g, i, fr)
		g.activeSessions += len(r.active)
		g.runners = append(g.runners, r)
	}
	if g.activeSessions > 0 {
		g.perSessionRate = o.eventRate / float64(g.activeSessions)
	}
	return g, nil
}

func readFleet(path string, limit int) ([]fleetRunner, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var fleet []fleetRunner
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for line := 1; sc.Scan(); line++ {
		if len(sc.Bytes()) == 0 {
			continue
		}
		var fr fleetRunner
		if err := json.Unmarshal(sc.Bytes(), &fr); err != nil {
			return nil, fmt.Errorf("%s:%d: %w", path, line, err)
		}
		if fr.Runner == "" || fr.Token == "" || fr.Process == "" {
			return nil, fmt.Errorf("%s:%d: a runner needs runner, token and process", path, line)
		}
		fleet = append(fleet, fr)
		if limit > 0 && len(fleet) == limit {
			break
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(fleet) == 0 {
		return nil, fmt.Errorf("%s names no runner", path)
	}
	return fleet, nil
}

func (g *loadgen) note(kind string) { g.noteN(kind, 1) }

func (g *loadgen) noteN(kind string, n int64) {
	g.notesMu.Lock()
	g.notes[kind] += n
	g.notesMu.Unlock()
}

func (g *loadgen) connectedOnce() { g.ever.Add(1) }

// run plays the fleet: the ramp, while every runner opens its first connection at -ramp-rate; the settle, -settle long,
// while what the ramp queued (every runner's first beat at once, its connect) drains; the steady window, -duration long;
// and the drain, while runners send no more beats and wait for their last acknowledgements.
func (g *loadgen) run(ctx context.Context) (*summary, int) {
	o := g.o
	started := time.Now()
	fmt.Fprintf(os.Stderr, "loadgen: %d runners, %d active sessions, %.0f events/s (%.3f per session), ramp %.0f/s, steady window %s\n",
		len(g.runners), g.activeSessions, o.eventRate, g.perSessionRate, o.rampRate, o.duration)

	// The ramp: one first connection per tick.
	rampCtx, rampDone := context.WithCancel(ctx)
	defer rampDone()
	go func() {
		t := time.NewTicker(time.Duration(float64(time.Second) / o.rampRate))
		defer t.Stop()
		for range g.runners {
			select {
			case <-rampCtx.Done():
				return
			case <-t.C:
			}
			select {
			case g.ramp <- struct{}{}:
			case <-rampCtx.Done():
				return
			}
		}
	}()

	series, err := os.Create(filepath.Join(o.out, "series.jsonl"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return nil, 1
	}
	defer series.Close()
	var phaseMu sync.Mutex
	phase := "ramp"
	lastFold := started
	writeLine := func(now time.Time) {
		phaseMu.Lock()
		p := phase
		phaseMu.Unlock()
		w, connected := g.stats.fold()
		span := now.Sub(lastFold).Seconds()
		lastFold = now
		line := seriesLine{At: now.UTC().Format(time.RFC3339), ElapsedS: round1(now.Sub(started).Seconds()), Phase: p,
			Connected: connected, counters: w.counters, AckBatch: w.ackBatch.summary(), AckEvent: w.ackEvent.summary(),
			BeatAck: w.beatAck.summary(), Errors: w.errors}
		if span > 0 {
			line.EventRate = round1(float64(w.EventsAcked) / span)
			line.BeatRate = round1(float64(w.HeartbeatAcks) / span)
		}
		b, _ := json.Marshal(line)
		_, _ = series.Write(append(b, '\n'))
	}
	seriesCtx, seriesDone := context.WithCancel(context.Background())
	var seriesMu sync.Mutex
	go func() {
		t := time.NewTicker(o.interval)
		defer t.Stop()
		for {
			select {
			case <-seriesCtx.Done():
				return
			case now := <-t.C:
				seriesMu.Lock()
				writeLine(now)
				seriesMu.Unlock()
			}
		}
	}()
	setPhase := func(p string) {
		seriesMu.Lock()
		defer seriesMu.Unlock()
		writeLine(time.Now()) // the interval so far belongs to the phase it was in
		phaseMu.Lock()
		phase = p
		phaseMu.Unlock()
		g.stats.mu.Lock()
		g.stats.steadyOn = p == "steady"
		g.stats.mu.Unlock()
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for _, r := range g.runners {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.run(ctx, stop)
		}()
	}

	// The steady window opens once every runner is connected.
	var steadyStart, steadyEnd time.Time
	rampLimit := time.Duration(float64(len(g.runners))/o.rampRate*float64(time.Second))*2 + 2*time.Minute
	poll := time.NewTicker(200 * time.Millisecond)
	for ctx.Err() == nil && g.ever.Load() < int64(len(g.runners)) && time.Since(started) < rampLimit {
		select {
		case <-ctx.Done():
		case <-poll.C:
		}
	}
	poll.Stop()
	rampDone()
	rampSeconds := time.Since(started).Seconds()
	everConnected := g.ever.Load()
	if everConnected < int64(len(g.runners)) {
		g.stats.fail("ramp_incomplete", fmt.Sprintf("%d of %d runners connected within %s", everConnected, len(g.runners), rampLimit))
	}
	if ctx.Err() == nil && o.settle > 0 {
		setPhase("settle")
		select {
		case <-ctx.Done():
		case <-time.After(o.settle):
		}
	}
	if ctx.Err() == nil {
		steadyStart = time.Now()
		setPhase("steady")
		fmt.Fprintf(os.Stderr, "loadgen: %d runners connected in %.1fs; steady window until %s\n", everConnected, rampSeconds,
			steadyStart.Add(o.duration).UTC().Format(time.RFC3339))
		select {
		case <-ctx.Done():
		case <-time.After(o.duration):
		}
		steadyEnd = time.Now()
		setPhase("drain")
	}
	close(stop)
	wg.Wait()
	seriesDone()
	seriesMu.Lock()
	writeLine(time.Now())
	seriesMu.Unlock()
	ended := time.Now()

	g.stats.mu.Lock()
	defer g.stats.mu.Unlock()
	g.notesMu.Lock()
	defer g.notesMu.Unlock()
	sum := summary{
		Config: summaryConfig{
			Runners: len(g.runners), ActiveSessions: g.activeSessions, EventRate: o.eventRate, PerSessionRate: g.perSessionRate,
			RampRate: o.rampRate, Duration: o.duration.String(), Settle: o.settle.String(), FlushMin: o.flushMin.String(), FlushMax: o.flushMax.String(),
			MaxBatch: o.maxBatch, RenewBefore: o.renewBefore.String(), SpreadRenewals: o.spreadRenewals, API: o.api,
			LinkURL: o.linkURL, Connect: o.connect, Seed: o.seed, EventCycle: cycle, BoundaryEvent: "tool_result",
			Volatile: o.volatile, VolatileEdits: o.volatileEdits,
		},
		StartedAt: started.UTC().Format(time.RFC3339Nano), EndedAt: ended.UTC().Format(time.RFC3339Nano),
		RampSeconds: round1(rampSeconds), EverConnected: everConnected,
		Whole: windowSummary(g.stats.all, ended.Sub(started)), Notes: g.notes, ErrorSamples: g.stats.samples,
	}
	if !steadyStart.IsZero() {
		sum.SteadyStartedAt = steadyStart.UTC().Format(time.RFC3339Nano)
		sum.SteadyEndedAt = steadyEnd.UTC().Format(time.RFC3339Nano)
		s := windowSummary(g.stats.steady, steadyEnd.Sub(steadyStart))
		sum.Steady = &s
	}
	sum.Unacknowledged = g.unacknowledged()
	if err := writeJSON(filepath.Join(o.out, "summary.json"), sum); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return &sum, 1
	}
	if g.stats.errLog != nil {
		_ = g.stats.errLog.Close()
	}
	if ctx.Err() != nil || sum.Steady == nil || sum.Whole.ErrorTotal > 0 || sum.Unacknowledged > 0 {
		return &sum, 1
	}
	return &sum, 0
}

// unacknowledged is how many produced events no EventAck covered by the end. Read once every runner has stopped.
func (g *loadgen) unacknowledged() int64 {
	var n int64
	for _, r := range g.runners {
		for _, s := range r.active {
			n += int64(len(s.pending))
			for _, b := range s.inflight {
				n += int64(len(b.events))
			}
		}
	}
	return n
}

type summaryConfig struct {
	Runners        int      `json:"runners"`
	ActiveSessions int      `json:"activeSessions"`
	EventRate      float64  `json:"eventRate"`
	PerSessionRate float64  `json:"perSessionRate"`
	RampRate       float64  `json:"rampRate"`
	Duration       string   `json:"duration"`
	Settle         string   `json:"settle"`
	FlushMin       string   `json:"flushMin"`
	FlushMax       string   `json:"flushMax"`
	MaxBatch       int      `json:"maxBatch"`
	RenewBefore    string   `json:"renewBefore"`
	SpreadRenewals bool     `json:"spreadRenewals"`
	API            string   `json:"api"`
	LinkURL        string   `json:"linkUrl"`
	Connect        string   `json:"connect"`
	Seed           uint64   `json:"seed"`
	EventCycle     []string `json:"eventCycle"`
	BoundaryEvent  string   `json:"boundaryEvent"`
	Volatile       bool     `json:"volatile"`
	VolatileEdits  float64  `json:"volatileEdits"`
}

type summary struct {
	Config          summaryConfig       `json:"config"`
	StartedAt       string              `json:"startedAt"`
	SteadyStartedAt string              `json:"steadyStartedAt,omitempty"`
	SteadyEndedAt   string              `json:"steadyEndedAt,omitempty"`
	EndedAt         string              `json:"endedAt"`
	RampSeconds     float64             `json:"rampSeconds"`
	EverConnected   int64               `json:"everConnected"`
	Steady          *windowReport       `json:"steady,omitempty"`
	Whole           windowReport        `json:"whole"`
	Unacknowledged  int64               `json:"unacknowledgedEvents"`
	Notes           map[string]int64    `json:"notes"`
	ErrorSamples    map[string][]string `json:"errorSamples"`
}

type windowReport struct {
	Seconds    float64          `json:"seconds"`
	Counters   counters         `json:"counters"`
	EventRate  float64          `json:"eventsAckedPerSecond"`
	BatchRate  float64          `json:"batchesAckedPerSecond"`
	BeatRate   float64          `json:"heartbeatAcksPerSecond"`
	AckBatch   histSummary      `json:"ackBatch"`
	AckEvent   histSummary      `json:"ackEvent"`
	BeatAck    histSummary      `json:"heartbeatAck"`
	TokenMint  histSummary      `json:"tokenMint"`
	Dial       histSummary      `json:"dialToWelcome"`
	Errors     map[string]int64 `json:"errors"`
	ErrorTotal int64            `json:"errorTotal"`
}

func windowSummary(w *window, d time.Duration) windowReport {
	s := d.Seconds()
	rep := windowReport{Seconds: round1(s), Counters: w.counters, AckBatch: w.ackBatch.summary(), AckEvent: w.ackEvent.summary(),
		BeatAck: w.beatAck.summary(), TokenMint: w.tokenMs.summary(), Dial: w.dialMs.summary(), Errors: w.errors, ErrorTotal: w.errorTotal()}
	if s > 0 {
		rep.EventRate = round1(float64(w.EventsAcked) / s)
		rep.BatchRate = round1(float64(w.BatchesAcked) / s)
		rep.BeatRate = round1(float64(w.HeartbeatAcks) / s)
	}
	return rep
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
