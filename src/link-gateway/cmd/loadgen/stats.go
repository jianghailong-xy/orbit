package main

import (
	"encoding/json"
	"math"
	"os"
	"sort"
	"sync"
	"time"
)

// What the runners saw, counted under one lock: a few thousand updates a second never contend.

// histBase is the histogram's resolution: each bucket is 1% wider than the one before, so a percentile read from it is
// within 1% of the true value. Buckets count microseconds, from 1 µs to past two minutes.
const (
	histBase    = 1.01
	histBuckets = 1900
)

// hist is a log-linear histogram of durations.
type hist struct {
	counts []uint64
	total  uint64
	sum    float64 // seconds
	max    time.Duration
}

func newHist() *hist { return &hist{counts: make([]uint64, histBuckets)} }

func histIndex(d time.Duration) int {
	us := float64(d) / float64(time.Microsecond)
	if us < 1 {
		return 0
	}
	i := int(math.Log(us) / math.Log(histBase))
	return min(max(i, 0), histBuckets-1)
}

func (h *hist) add(d time.Duration, n uint64) {
	if n == 0 {
		return
	}
	h.counts[histIndex(d)] += n
	h.total += n
	h.sum += d.Seconds() * float64(n)
	if d > h.max {
		h.max = d
	}
}

func (h *hist) merge(o *hist) {
	for i, c := range o.counts {
		h.counts[i] += c
	}
	h.total += o.total
	h.sum += o.sum
	if o.max > h.max {
		h.max = o.max
	}
}

// quantile is the upper bound of the bucket holding the q-th value, never more than the largest value seen.
func (h *hist) quantile(q float64) time.Duration {
	if h.total == 0 {
		return 0
	}
	target := uint64(math.Ceil(q * float64(h.total)))
	if target == 0 {
		target = 1
	}
	var cum uint64
	for i, c := range h.counts {
		cum += c
		if cum >= target {
			upper := time.Duration(math.Pow(histBase, float64(i+1)) * float64(time.Microsecond))
			return min(upper, h.max)
		}
	}
	return h.max
}

// summary is a histogram as the report states it, in milliseconds.
type histSummary struct {
	Count  uint64  `json:"count"`
	MeanMs float64 `json:"meanMs"`
	P50Ms  float64 `json:"p50Ms"`
	P90Ms  float64 `json:"p90Ms"`
	P99Ms  float64 `json:"p99Ms"`
	P999Ms float64 `json:"p999Ms"`
	MaxMs  float64 `json:"maxMs"`
}

func ms(d time.Duration) float64 { return math.Round(float64(d)/float64(time.Microsecond)) / 1000 }

func (h *hist) summary() histSummary {
	s := histSummary{Count: h.total, P50Ms: ms(h.quantile(0.5)), P90Ms: ms(h.quantile(0.9)), P99Ms: ms(h.quantile(0.99)),
		P999Ms: ms(h.quantile(0.999)), MaxMs: ms(h.max)}
	if h.total > 0 {
		s.MeanMs = math.Round(h.sum/float64(h.total)*1e6) / 1000
	}
	return s
}

// counters are what one interval, the steady window or the whole run counts.
type counters struct {
	Connects       int64 `json:"connects"`
	Renewals       int64 `json:"renewals"`
	Reconnects     int64 `json:"reconnects"`
	TokensMinted   int64 `json:"tokensMinted"`
	HeartbeatsSent int64 `json:"heartbeatsSent"`
	HeartbeatAcks  int64 `json:"heartbeatAcks"`
	// HeartbeatsReconciled are the acknowledged beats whose answer was a full reconcile: it names the directories to
	// scan (agentDirs), which an answer from runner_presence alone never does (task O1).
	HeartbeatsReconciled int64 `json:"heartbeatsReconciled"`
	BatchesSent          int64 `json:"batchesSent"`
	BatchesAcked         int64 `json:"batchesAcked"`
	EventsProduced       int64 `json:"eventsProduced"`
	EventsSent           int64 `json:"eventsSent"`
	EventsResent         int64 `json:"eventsResent"`
	EventsAcked          int64 `json:"eventsAcked"`
	PayloadBytes         int64 `json:"payloadBytes"`
	Hints                int64 `json:"hints"`
}

func (c *counters) add(o *counters) {
	c.Connects += o.Connects
	c.Renewals += o.Renewals
	c.Reconnects += o.Reconnects
	c.TokensMinted += o.TokensMinted
	c.HeartbeatsSent += o.HeartbeatsSent
	c.HeartbeatAcks += o.HeartbeatAcks
	c.HeartbeatsReconciled += o.HeartbeatsReconciled
	c.BatchesSent += o.BatchesSent
	c.BatchesAcked += o.BatchesAcked
	c.EventsProduced += o.EventsProduced
	c.EventsSent += o.EventsSent
	c.EventsResent += o.EventsResent
	c.EventsAcked += o.EventsAcked
	c.PayloadBytes += o.PayloadBytes
	c.Hints += o.Hints
}

// window is what one span of the run saw: an interval of the series, the steady window, or all of it.
type window struct {
	counters
	errors   map[string]int64
	ackBatch *hist // from a batch's first send to the EventAck covering it
	ackEvent *hist // the same, once per event
	beatAck  *hist // from a Heartbeat to its HeartbeatAck
	tokenMs  *hist // POST /api/runner/link-token
	dialMs   *hist // from dialing to Welcome
}

func newWindow() *window {
	return &window{errors: map[string]int64{}, ackBatch: newHist(), ackEvent: newHist(), beatAck: newHist(), tokenMs: newHist(), dialMs: newHist()}
}

func (w *window) merge(o *window) {
	w.counters.add(&o.counters)
	for k, v := range o.errors {
		w.errors[k] += v
	}
	w.ackBatch.merge(o.ackBatch)
	w.ackEvent.merge(o.ackEvent)
	w.beatAck.merge(o.beatAck)
	w.tokenMs.merge(o.tokenMs)
	w.dialMs.merge(o.dialMs)
}

func (w *window) errorTotal() int64 {
	var n int64
	for _, v := range w.errors {
		n += v
	}
	return n
}

// stats is the loadgen's one record of what happened. The current interval is folded into the run (and the steady
// window, while it is open) each time the series writes a line.
type stats struct {
	mu        sync.Mutex
	cur       *window
	all       *window
	steady    *window
	steadyOn  bool
	connected int64
	samples   map[string][]string // the first few details of each error kind
	errLog    *os.File
}

const errorSamples = 20

func newStats(errLog *os.File) *stats {
	return &stats{cur: newWindow(), all: newWindow(), steady: newWindow(), samples: map[string][]string{}, errLog: errLog}
}

func (s *stats) with(fn func(w *window)) {
	s.mu.Lock()
	fn(s.cur)
	s.mu.Unlock()
}

// fail counts one error of a kind, keeping the first details of each kind for the report and logging every one.
func (s *stats) fail(kind, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur.errors[kind]++
	if len(s.samples[kind]) < errorSamples {
		s.samples[kind] = append(s.samples[kind], time.Now().UTC().Format(time.RFC3339Nano)+" "+detail)
	}
	if s.errLog != nil {
		_, _ = s.errLog.WriteString(time.Now().UTC().Format(time.RFC3339Nano) + " " + kind + " " + detail + "\n")
	}
}

func (s *stats) setConnected(delta int64) {
	s.mu.Lock()
	s.connected += delta
	s.mu.Unlock()
}

// fold closes the current interval: it is added to the run and to the steady window, and returned.
func (s *stats) fold() (*window, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.cur
	s.cur = newWindow()
	s.all.merge(w)
	if s.steadyOn {
		s.steady.merge(w)
	}
	return w, s.connected
}

// seriesLine is one line of series.jsonl: what one interval saw.
type seriesLine struct {
	At        string  `json:"at"`
	ElapsedS  float64 `json:"elapsedS"`
	Phase     string  `json:"phase"`
	Connected int64   `json:"connected"`
	counters
	EventRate float64          `json:"eventRate"`
	BeatRate  float64          `json:"beatRate"`
	AckBatch  histSummary      `json:"ackBatch"`
	AckEvent  histSummary      `json:"ackEvent"`
	BeatAck   histSummary      `json:"beatAck"`
	Errors    map[string]int64 `json:"errors,omitempty"`
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
