package main

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseCodexPlanUsage(t *testing.T) {
	got, err := parseCodexPlanUsage(map[string]interface{}{
		"rateLimitsByLimitId": map[string]interface{}{
			"codex": map[string]interface{}{
				"limitId":   "codex",
				"limitName": "Codex",
				"planType":  "plus",
				"primary": map[string]interface{}{
					"usedPercent":        float64(6),
					"windowDurationMins": float64(300),
					"resetsAt":           float64(1783000000),
				},
				"secondary": map[string]interface{}{
					"usedPercent":        float64(30),
					"windowDurationMins": float64(10080),
				},
				"credits": map[string]interface{}{
					"hasCredits": true,
					"unlimited":  false,
					"balance":    "10",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("parseCodexPlanUsage error: %v", err)
	}
	if got.Provider != providerCodex || got.LimitID != "codex" || got.PlanType != "plus" {
		t.Fatalf("unexpected metadata: %#v", got)
	}
	if got.Primary == nil || got.Primary.Utilization != 6 || got.Primary.Label != "5h limit" || got.Primary.ResetsAt == "" {
		t.Fatalf("unexpected primary: %#v", got.Primary)
	}
	if got.Secondary == nil || got.Secondary.Utilization != 30 || got.Secondary.Label != "Weekly limit" {
		t.Fatalf("unexpected secondary: %#v", got.Secondary)
	}
	if got.Credits == nil || !got.Credits.HasCredits || got.Credits.Unlimited || got.Credits.Balance != "10" {
		t.Fatalf("unexpected credits: %#v", got.Credits)
	}
}

func TestParseCodexPlanUsageCombinesWindowsAcrossLimitIDs(t *testing.T) {
	weekly := map[string]interface{}{
		"limitId": "codex",
		"primary": map[string]interface{}{
			"usedPercent":        float64(18),
			"windowDurationMins": float64(10080),
			"resetsAt":           float64(1785336445),
		},
		"planType": "plus",
	}
	fiveHour := map[string]interface{}{
		"limitId": "codex-other",
		"primary": map[string]interface{}{
			"usedPercent":        float64(7),
			"windowDurationMins": float64(300),
			"resetsAt":           float64(1784761200),
		},
	}

	got, err := parseCodexPlanUsage(map[string]interface{}{
		"rateLimits": weekly,
		"rateLimitsByLimitId": map[string]interface{}{
			"codex":       weekly,
			"codex-other": fiveHour,
		},
	})
	if err != nil {
		t.Fatalf("parseCodexPlanUsage error: %v", err)
	}
	if got.Primary == nil || got.Primary.WindowDurationMins != 300 || got.Primary.Utilization != 7 || got.Primary.Label != "5h limit" {
		t.Fatalf("unexpected primary: %#v", got.Primary)
	}
	if got.Secondary == nil || got.Secondary.WindowDurationMins != 10080 || got.Secondary.Utilization != 18 || got.Secondary.Label != "Weekly limit" {
		t.Fatalf("unexpected secondary: %#v", got.Secondary)
	}
	if len(got.RateLimits) != 2 || got.RateLimits[0].LimitID != "codex" || got.RateLimits[1].LimitID != "codex-other" {
		t.Fatalf("rate-limit buckets = %#v", got.RateLimits)
	}
}

func TestCodexRateLimitSnapshotsPreferTopLevelLikeTUI(t *testing.T) {
	top := map[string]interface{}{"limitId": "codex-other"}
	canonical := map[string]interface{}{"limitId": "codex"}
	got := codexRateLimitSnapshots(map[string]interface{}{
		"rateLimits": top,
		"rateLimitsByLimitId": map[string]interface{}{
			"codex":       canonical,
			"codex-other": top,
		},
	})
	if len(got) != 2 || firstString(got[0], "limitId") != "codex-other" || firstString(got[1], "limitId") != "codex" {
		t.Fatalf("snapshot order = %#v", got)
	}
}

func TestPlanUsageProbeMergesRollingCodexWindow(t *testing.T) {
	p := newCodexPlanUsageProbe()
	p.store(&PlanUsage{
		Provider: providerCodex,
		Primary: &PlanUsageWindow{
			Utilization:        18,
			WindowDurationMins: 10080,
			Label:              "Weekly limit",
		},
		PlanType: "plus",
	})

	p.mergeCodexRateLimits(map[string]interface{}{
		"limitId": "codex-other",
		"primary": map[string]interface{}{
			"usedPercent":        float64(7),
			"windowDurationMins": float64(300),
		},
	})

	got := p.snapshot()
	if got.Primary == nil || got.Primary.WindowDurationMins != 300 || got.Primary.Utilization != 7 {
		t.Fatalf("unexpected primary after merge: %#v", got.Primary)
	}
	if got.Secondary == nil || got.Secondary.WindowDurationMins != 10080 || got.Secondary.Utilization != 18 {
		t.Fatalf("unexpected secondary after merge: %#v", got.Secondary)
	}
	if got.PlanType != "plus" {
		t.Fatalf("plan type = %q, want preserved plus", got.PlanType)
	}
	if len(got.RateLimits) != 2 || got.RateLimits[0].LimitID != "codex" || got.RateLimits[1].LimitID != "codex-other" {
		t.Fatalf("rate-limit buckets after merge = %#v", got.RateLimits)
	}
}

func TestPlanUsageProbeFullReadKeepsRollingOnlyBucketLikeTUI(t *testing.T) {
	p := newCodexPlanUsageProbe()
	p.store(codexPlanUsageFromSnapshots([]map[string]interface{}{
		{
			"limitId": "codex",
			"primary": map[string]interface{}{"usedPercent": float64(18), "windowDurationMins": float64(10080)},
		},
	}))
	p.mergeCodexRateLimits(map[string]interface{}{
		"limitId": "codex-other",
		"primary": map[string]interface{}{"usedPercent": float64(7), "windowDurationMins": float64(300)},
	})
	p.store(codexPlanUsageFromSnapshots([]map[string]interface{}{
		{
			"limitId": "codex",
			"primary": map[string]interface{}{"usedPercent": float64(20), "windowDurationMins": float64(10080)},
		},
	}))

	got := p.snapshot()
	if len(got.RateLimits) != 2 || got.RateLimits[1].LimitID != "codex-other" {
		t.Fatalf("rate-limit buckets after full read = %#v", got.RateLimits)
	}
	if got.Secondary == nil || got.Secondary.Utilization != 20 {
		t.Fatalf("weekly compatibility window = %#v", got.Secondary)
	}
}

func TestCodexWindowLabelMatchesTUI(t *testing.T) {
	tests := []struct {
		name      string
		secondary bool
		minutes   int64
		want      string
	}{
		{"five-hour", false, 300, "5h limit"},
		{"approximate five-hour", false, 288, "5h limit"},
		{"daily", false, 1440, "Daily limit"},
		{"weekly", true, 10080, "Weekly limit"},
		{"monthly", false, 43200, "Monthly limit"},
		{"annual", false, 525600, "Annual limit"},
		{"primary fallback", false, 60, "Usage limit"},
		{"secondary fallback", true, 120, "Secondary usage limit"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := codexWindowLabel(tt.secondary, tt.minutes); got != tt.want {
				t.Fatalf("codexWindowLabel(%v, %d) = %q, want %q", tt.secondary, tt.minutes, got, tt.want)
			}
		})
	}
}

func TestCombinePlanUsageNestsMultipleProviders(t *testing.T) {
	claude := &PlanUsage{Provider: providerClaude, FetchedAt: "2026-07-01T10:00:00Z"}
	codex := &PlanUsage{Provider: providerCodex, FetchedAt: "2026-07-01T11:00:00Z"}
	got := combinePlanUsage(claude, codex)
	if got.Claude != claude || got.Codex != codex {
		t.Fatalf("combinePlanUsage = %#v", got)
	}
	if got.FetchedAt != codex.FetchedAt {
		t.Fatalf("FetchedAt = %q, want %q", got.FetchedAt, codex.FetchedAt)
	}
}

func TestPlanUsageProbeRefreshesWhileIdleWhenEnabled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int64
	p := &planUsageProbe{
		name: "test plan-usage",
		fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
			calls.Add(1)
			return &PlanUsage{Provider: providerCodex}, nil
		},
	}
	go p.runWithIntervals(
		ctx,
		func() int { return 0 },
		func() bool { return true },
		5*time.Millisecond,
		time.Hour,
		20*time.Millisecond,
	)
	waitForPlanUsageCalls(t, &calls, 2)
}

func TestPlanUsageProbeSkipsIdleRefreshWhenDisabled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int64
	p := &planUsageProbe{
		name: "test plan-usage",
		fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
			calls.Add(1)
			return &PlanUsage{Provider: providerCodex}, nil
		},
	}
	go p.runWithIntervals(
		ctx,
		func() int { return 0 },
		func() bool { return false },
		5*time.Millisecond,
		20*time.Millisecond,
		20*time.Millisecond,
	)
	time.Sleep(50 * time.Millisecond)
	if got := calls.Load(); got != 0 {
		t.Fatalf("fetch calls = %d, want 0", got)
	}
}

func TestPlanUsageProbeRefreshesOnBusyIdleTransition(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active atomic.Int64
	active.Store(1)
	var calls atomic.Int64
	p := &planUsageProbe{
		name: "test plan-usage",
		fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
			calls.Add(1)
			return &PlanUsage{Provider: providerCodex}, nil
		},
	}
	go p.runWithIntervals(
		ctx,
		func() int { return int(active.Load()) },
		func() bool { return false },
		5*time.Millisecond,
		time.Hour,
		time.Hour,
	)
	waitForPlanUsageCalls(t, &calls, 1)
	active.Store(0)
	waitForPlanUsageCalls(t, &calls, 2)
}

func TestPlanUsageRefreshDueUsesResetBeforeInterval(t *testing.T) {
	now := time.Date(2026, 7, 2, 14, 0, 0, 0, time.UTC)
	lastFetch := now.Add(-time.Minute)
	resetAt := now.Add(-time.Second)
	usage := &PlanUsage{
		Provider: providerCodex,
		Primary:  &PlanUsageWindow{Utilization: 12, ResetsAt: resetAt.Format(time.RFC3339)},
	}
	if !planUsageRefreshDue(lastFetch, usage, now.Add(planUsageResetRefreshDelay), time.Hour) {
		t.Fatalf("expected reset timestamp to make refresh due before idle interval")
	}
}

func TestPlanUsageRefreshDueIgnoresAlreadyAttemptedReset(t *testing.T) {
	now := time.Date(2026, 7, 2, 14, 0, 0, 0, time.UTC)
	lastFetch := now
	resetAt := now.Add(-time.Minute)
	usage := &PlanUsage{
		Provider: providerCodex,
		Primary:  &PlanUsageWindow{Utilization: 12, ResetsAt: resetAt.Format(time.RFC3339)},
	}
	if planUsageRefreshDue(lastFetch, usage, now.Add(time.Minute), time.Hour) {
		t.Fatalf("reset before last fetch should not force immediate retry")
	}
}

func waitForPlanUsageCalls(t *testing.T, calls *atomic.Int64, want int64) {
	t.Helper()
	deadline := time.After(500 * time.Millisecond)
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if calls.Load() >= want {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("fetch calls = %d, want at least %d", calls.Load(), want)
		case <-tick.C:
		}
	}
}
