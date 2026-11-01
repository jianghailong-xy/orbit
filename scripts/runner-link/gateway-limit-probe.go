// The gateway-only load test's runtime probe (gateway-limit.sh). It is not part of the link gateway: gateway-limit.sh
// adds it to the gateway's package for the binary under test alone, at build time (go build -overlay). It lives outside
// every Go module, so no other build, test or vet ever compiles it, and the product's Dockerfile never sees it. The
// binary under test is the product source at the commit run.json names, plus this file, whose sha256 run.json gives.
//
// With ORBIT_GATEWAY_LIMIT_PROBE_ADDR set to a loopback address, it answers there with the Go runtime's own figures,
// as JSON: the goroutines, GOMAXPROCS, the GC cycles and their stop-the-world pauses (a histogram), the heap's live
// bytes and goal, and the memory the runtime holds. They are read from runtime/metrics alone, and only when asked,
// every 15 s: no runtime.ReadMemStats and no goroutine profile, which stop the world, so the probe adds nothing to the
// pauses it reports. Unset, it does nothing at all.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"runtime/metrics"
	"sync"
	"time"
)

var gatewayLimitProbeMetrics = []string{
	"/sched/goroutines:goroutines",
	"/sched/gomaxprocs:threads",
	"/gc/cycles/total:gc-cycles",
	"/sched/pauses/total/gc:seconds",
	"/gc/heap/live:bytes",
	"/gc/heap/goal:bytes",
	"/memory/classes/total:bytes",
	"/memory/classes/heap/objects:bytes",
	"/memory/classes/heap/stacks:bytes",
	"/cpu/classes/gc/total:cpu-seconds",
	"/cpu/classes/total:cpu-seconds",
}

func init() {
	addr := os.Getenv("ORBIT_GATEWAY_LIMIT_PROBE_ADDR")
	if addr == "" {
		return
	}
	host, _, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		fmt.Fprintf(os.Stderr, "gateway-limit probe: ORBIT_GATEWAY_LIMIT_PROBE_ADDR=%q is not a loopback address and port\n", addr)
		os.Exit(2)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gateway-limit probe: %v\n", err)
		os.Exit(2)
	}
	samples := make([]metrics.Sample, len(gatewayLimitProbeMetrics))
	for i, name := range gatewayLimitProbeMetrics {
		samples[i].Name = name
	}
	var mu sync.Mutex
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		metrics.Read(samples)
		out := map[string]any{"t": time.Now().UnixMilli()}
		for _, s := range samples {
			switch s.Value.Kind() {
			case metrics.KindUint64:
				out[s.Name] = s.Value.Uint64()
			case metrics.KindFloat64:
				out[s.Name] = s.Value.Float64()
			case metrics.KindFloat64Histogram:
				// The non-empty buckets, each [lower bound, upper bound, count]; an infinite bound is null.
				h := s.Value.Float64Histogram()
				buckets := [][3]any{}
				for i, n := range h.Counts {
					if n > 0 {
						buckets = append(buckets, [3]any{finite(h.Buckets[i]), finite(h.Buckets[i+1]), n})
					}
				}
				out[s.Name] = buckets
			}
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})}
	go func() { _ = srv.Serve(ln) }()
}

func finite(v float64) any {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return nil
	}
	return v
}
