package main

import (
	"math"
	"time"
)

// hist is a histogram of durations in buckets 1% wider each than the one before, from 1 µs to past two minutes, as the
// loadgen's: a percentile read from it is within 1% of the true value. Bucket i counts durations below histBase^(i+1)
// microseconds; its non-empty buckets go out with the stats, so that two reads of them give the percentiles of what
// came between.
const (
	histBase    = 1.01
	histBuckets = 1900
)

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
	return min(max(int(math.Log(us)/math.Log(histBase)), 0), histBuckets-1)
}

func (h *hist) add(d time.Duration) {
	h.counts[histIndex(d)]++
	h.total++
	h.sum += d.Seconds()
	h.max = max(h.max, d)
}

// quantile is the upper bound of the bucket holding the q-th value, never more than the largest value seen.
func (h *hist) quantile(q float64) time.Duration {
	if h.total == 0 {
		return 0
	}
	target := max(uint64(math.Ceil(q*float64(h.total))), 1)
	var cum uint64
	for i, c := range h.counts {
		if cum += c; cum >= target {
			return min(time.Duration(math.Pow(histBase, float64(i+1))*float64(time.Microsecond)), h.max)
		}
	}
	return h.max
}

// histView is a histogram as the stats state it, in milliseconds, with its non-empty buckets as [index, count].
type histView struct {
	Count   uint64      `json:"count"`
	MeanMs  float64     `json:"meanMs"`
	P50Ms   float64     `json:"p50Ms"`
	P99Ms   float64     `json:"p99Ms"`
	P999Ms  float64     `json:"p999Ms"`
	MaxMs   float64     `json:"maxMs"`
	Buckets [][2]uint64 `json:"buckets"`
}

func ms(d time.Duration) float64 { return math.Round(float64(d)/float64(time.Microsecond)) / 1000 }

func (h *hist) view() histView {
	v := histView{Count: h.total, P50Ms: ms(h.quantile(0.5)), P99Ms: ms(h.quantile(0.99)), P999Ms: ms(h.quantile(0.999)),
		MaxMs: ms(h.max), Buckets: [][2]uint64{}}
	if h.total > 0 {
		v.MeanMs = math.Round(h.sum/float64(h.total)*1e6) / 1000
	}
	for i, c := range h.counts {
		if c > 0 {
			v.Buckets = append(v.Buckets, [2]uint64{uint64(i), c})
		}
	}
	return v
}
