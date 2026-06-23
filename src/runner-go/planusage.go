package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// The runner surfaces the Claude subscription's live quota — the same numbers
// Claude Code's `/usage` popover shows — so the UI can display per-runner plan
// usage. Source is the OAuth usage endpoint the CLI itself calls; it's undocumented,
// so every step here is best-effort: any failure degrades to "no usage reported"
// and never disturbs the heartbeat.

const (
	planUsageURL = "https://api.anthropic.com/api/oauth/usage"
	// While the runner has ≥1 active session, refresh at most this often. Quota only
	// moves while claude is running, so a fully idle runner isn't polled at all.
	planUsageInterval = 2 * time.Minute
	// Local (no-network) cadence for checking busy/idle edges and refresh-due. Cheap:
	// it just reads an in-process counter.
	planUsageCheckInterval = 15 * time.Second
	// anthropic-beta value Claude Code sends on OAuth-authenticated requests. The
	// endpoint accepts the token without it today; we send it to match the CLI in
	// case the header is enforced later. If Anthropic rotates it, the request 4xx's
	// and we degrade gracefully rather than break.
	planUsageBeta = "oauth-2025-04-20"
)

// PlanUsageWindow is one rate-limit window (the rolling 5-hour session limit or a
// 7-day window). Mirrors @orbit/shared PlanUsageWindow.
type PlanUsageWindow struct {
	Utilization float64 `json:"utilization"`        // 0..100 percent consumed
	ResetsAt    string  `json:"resetsAt,omitempty"` // ISO-8601 reset time, if known
}

// PlanUsage is the account-wide Claude subscription quota for whichever login this
// runner's claude uses. Mirrors @orbit/shared PlanUsage.
type PlanUsage struct {
	FiveHour       *PlanUsageWindow `json:"fiveHour,omitempty"`
	SevenDay       *PlanUsageWindow `json:"sevenDay,omitempty"`
	SevenDayOpus   *PlanUsageWindow `json:"sevenDayOpus,omitempty"`
	SevenDaySonnet *PlanUsageWindow `json:"sevenDaySonnet,omitempty"`
	FetchedAt      string           `json:"fetchedAt"`
}

// planUsageProbe keeps the most recent usage snapshot fresh in the background so the
// heartbeat reads it instantly (lock-free) and is never delayed by the external call.
type planUsageProbe struct {
	client *http.Client
	val    atomic.Value // *PlanUsage; unset until the first successful fetch
}

func newPlanUsageProbe() *planUsageProbe {
	return &planUsageProbe{client: &http.Client{}}
}

// snapshot returns the latest usage, or nil if none has been fetched / it's
// unavailable. Safe to call from the heartbeat goroutine.
func (p *planUsageProbe) snapshot() *PlanUsage {
	v, _ := p.val.Load().(*PlanUsage)
	return v
}

// run polls the usage endpoint only while the runner is busy: it refreshes on the
// idle→busy edge (so the gauge is fresh when work starts), every planUsageInterval
// while sessions run, and once more on the busy→idle edge (to capture the just-
// finished turn's usage). A fully idle runner makes no request — quota only moves
// while claude runs. activeCount reports how many sessions are currently running.
// Failures are soft (see fetchPlanUsage): the last good value is kept and a repeated
// error is logged only once.
func (p *planUsageProbe) run(ctx context.Context, activeCount func() int) {
	var lastErr string
	var lastFetch time.Time
	refresh := func() {
		lastFetch = time.Now()
		u, err := fetchPlanUsage(ctx, p.client)
		if err != nil {
			if msg := err.Error(); msg != lastErr {
				logln("plan-usage unavailable:", msg)
				lastErr = msg
			}
			return
		}
		if lastErr != "" {
			logln("plan-usage recovered")
			lastErr = ""
		}
		p.val.Store(u)
	}
	wasActive := false
	ticker := time.NewTicker(planUsageCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			active := activeCount() > 0
			// Refresh on a busy/idle transition (fresh on start, final capture on
			// finish), or when a busy runner is due for its periodic poll.
			if active != wasActive || (active && time.Since(lastFetch) >= planUsageInterval) {
				refresh()
			}
			wasActive = active
		}
	}
}

// claudeCredentialsPath resolves where Claude Code stores OAuth creds, honoring
// CLAUDE_CONFIG_DIR (which the CLI itself respects) and otherwise ~/.claude — the
// same HOME the runner spawns claude under, so the token always matches.
func claudeCredentialsPath() string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(userHome(), ".claude")
	}
	return filepath.Join(dir, ".credentials.json")
}

func claudeOAuthToken() (string, error) {
	b, err := os.ReadFile(claudeCredentialsPath())
	if err != nil {
		return "", err
	}
	var c struct {
		ClaudeAiOauth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return "", err
	}
	if c.ClaudeAiOauth.AccessToken == "" {
		return "", fmt.Errorf("no oauth token (api-key auth?)")
	}
	return c.ClaudeAiOauth.AccessToken, nil
}

func fetchPlanUsage(ctx context.Context, client *http.Client) (*PlanUsage, error) {
	// Read the token fresh every cycle: Claude Code rotates it in place, so a cached
	// token would go stale. A 401 here just means we'll pick up the refreshed one next.
	token, err := claudeOAuthToken()
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, planUsageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", planUsageBeta)
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", "orbit-runner/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("usage endpoint -> %d", resp.StatusCode)
	}
	return parsePlanUsage(body)
}

// parsePlanUsage maps the endpoint's snake_case windows to our compact shape. Each
// window is a pointer so a JSON null (e.g. seven_day_opus on plans without it) or a
// missing utilization collapses to an omitted field rather than a bogus 0%.
func parsePlanUsage(body []byte) (*PlanUsage, error) {
	type rawWindow struct {
		Utilization *float64 `json:"utilization"`
		ResetsAt    *string  `json:"resets_at"`
	}
	norm := func(r *rawWindow) *PlanUsageWindow {
		if r == nil || r.Utilization == nil {
			return nil
		}
		w := &PlanUsageWindow{Utilization: *r.Utilization}
		if r.ResetsAt != nil {
			w.ResetsAt = *r.ResetsAt
		}
		return w
	}
	var raw struct {
		FiveHour       *rawWindow `json:"five_hour"`
		SevenDay       *rawWindow `json:"seven_day"`
		SevenDayOpus   *rawWindow `json:"seven_day_opus"`
		SevenDaySonnet *rawWindow `json:"seven_day_sonnet"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	return &PlanUsage{
		FiveHour:       norm(raw.FiveHour),
		SevenDay:       norm(raw.SevenDay),
		SevenDayOpus:   norm(raw.SevenDayOpus),
		SevenDaySonnet: norm(raw.SevenDaySonnet),
		FetchedAt:      time.Now().UTC().Format(time.RFC3339),
	}, nil
}
