package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// The runner surfaces local coding-runtime quota so the UI can display per-runner
// plan usage. Claude uses the OAuth usage endpoint Claude Code itself calls; Codex
// uses the app-server account/rateLimits/read protocol method. Both are best-effort:
// failures degrade to "no usage reported" and never disturb the heartbeat.

const (
	planUsageURL = "https://api.anthropic.com/api/oauth/usage"
	// While the runner has ≥1 active session, refresh at most this often. Kept well
	// clear of a per-minute cadence on purpose: several busy runners behind one egress
	// IP have tripped Anthropic's edge rate limit, and a 429 here costs more than a
	// stale percent — it's the same host the engine's own token refresh has to reach.
	planUsageActiveInterval = 5 * time.Minute
	// Idle runners still need occasional refreshes: rolling windows can reset while
	// no session is active, and the UI would otherwise keep showing a stale percent.
	planUsageIdleInterval = 10 * time.Minute
	// After a provider-reported reset timestamp passes, refresh shortly after it so
	// the next heartbeat clears the old utilization without waiting for the idle poll.
	planUsageResetRefreshDelay = 15 * time.Second
	// Local (no-network) cadence for checking busy/idle edges and refresh-due. Cheap:
	// it just reads an in-process counter.
	planUsageCheckInterval = 15 * time.Second
	// anthropic-beta value Claude Code sends on OAuth-authenticated requests. The
	// endpoint accepts the token without it today; we send it to match the CLI in
	// case the header is enforced later. If Anthropic rotates it, the request 4xx's
	// and we degrade gracefully rather than break.
	planUsageBeta = "oauth-2025-04-20"
	// Codex's limit ID for the plan's own bucket — the one Orbit displays. Model and
	// product buckets carry their own IDs (codex_bengalfox for Spark, say).
	codexPlanLimitID = "codex"
)

// PlanUsageWindow is one rate-limit window. Claude reports named windows (rolling
// 5-hour / weekly); Codex reports primary/secondary windows with durations.
// Mirrors @orbit/shared PlanUsageWindow.
type PlanUsageWindow struct {
	Utilization        float64 `json:"utilization"`                  // 0..100 percent consumed
	ResetsAt           string  `json:"resetsAt,omitempty"`           // ISO-8601 reset time, if known
	Label              string  `json:"label,omitempty"`              // UI label for dynamic Codex windows
	WindowDurationMins int64   `json:"windowDurationMins,omitempty"` // Codex-reported rolling window size
}

type CreditsSnapshot struct {
	HasCredits bool   `json:"hasCredits"`
	Unlimited  bool   `json:"unlimited"`
	Balance    string `json:"balance,omitempty"`
}

// PlanUsageRateLimit is the Codex rate-limit bucket Orbit displays: the plan's own
// bucket, which Codex returns as the top-level "rateLimits" value. PlanUsage always
// carries exactly one, mirroring its flat primary/secondary pair for the clients
// that render buckets.
type PlanUsageRateLimit struct {
	LimitID   string           `json:"limitId,omitempty"`
	LimitName string           `json:"limitName,omitempty"`
	Primary   *PlanUsageWindow `json:"primary,omitempty"`
	Secondary *PlanUsageWindow `json:"secondary,omitempty"`
	Credits   *CreditsSnapshot `json:"credits,omitempty"`
}

// PlanUsage is a provider usage snapshot. For compatibility, a single-provider
// heartbeat can still be flat; when the runner has multiple providers active, Claude
// and Codex snapshots are nested under claude/codex.
type PlanUsage struct {
	Provider string `json:"provider,omitempty"`

	// Claude windows.
	FiveHour       *PlanUsageWindow `json:"fiveHour,omitempty"`
	SevenDay       *PlanUsageWindow `json:"sevenDay,omitempty"`
	SevenDayOpus   *PlanUsageWindow `json:"sevenDayOpus,omitempty"`
	SevenDaySonnet *PlanUsageWindow `json:"sevenDaySonnet,omitempty"`

	// Codex windows, from app-server account/rateLimits/read.
	Primary              *PlanUsageWindow     `json:"primary,omitempty"`
	Secondary            *PlanUsageWindow     `json:"secondary,omitempty"`
	LimitID              string               `json:"limitId,omitempty"`
	LimitName            string               `json:"limitName,omitempty"`
	PlanType             string               `json:"planType,omitempty"`
	RateLimitReachedType string               `json:"rateLimitReachedType,omitempty"`
	Credits              *CreditsSnapshot     `json:"credits,omitempty"`
	RateLimits           []PlanUsageRateLimit `json:"rateLimits,omitempty"`

	// Nested snapshots when more than one provider is available.
	Claude *PlanUsage `json:"claude,omitempty"`
	Codex  *PlanUsage `json:"codex,omitempty"`

	FetchedAt string `json:"fetchedAt,omitempty"`
}

type planUsageFetchFunc func(context.Context, *http.Client) (*PlanUsage, error)

// planUsageProbe keeps the most recent usage snapshot fresh in the background so the
// heartbeat reads it instantly (lock-free) and is never delayed by the external call.
type planUsageProbe struct {
	client *http.Client
	name   string
	fetch  planUsageFetchFunc
	mu     sync.Mutex
	val    atomic.Value // *PlanUsage; unset until the first successful fetch
}

func newClaudePlanUsageProbe() *planUsageProbe {
	return &planUsageProbe{client: &http.Client{}, name: "claude plan-usage", fetch: fetchClaudePlanUsage}
}

func newCodexPlanUsageProbe() *planUsageProbe {
	return &planUsageProbe{client: &http.Client{}, name: "codex plan-usage", fetch: fetchCodexPlanUsage}
}

// snapshot returns the latest usage, or nil if none has been fetched / it's
// unavailable. Safe to call from the heartbeat goroutine.
func (p *planUsageProbe) snapshot() *PlanUsage {
	v, _ := p.val.Load().(*PlanUsage)
	return v
}

func (p *planUsageProbe) store(u *PlanUsage) {
	p.mu.Lock()
	current, _ := p.val.Load().(*PlanUsage)
	if current != nil && current.Provider == providerCodex && u != nil && u.Provider == providerCodex {
		u = mergeCodexPlanUsage(current, u)
	}
	p.val.Store(u)
	p.mu.Unlock()
}

// mergeCodexRateLimits accepts the sparse rolling snapshot emitted by an active
// app-server session, so a running session keeps the displayed windows fresh
// between reads. Notifications for another bucket (a model/product limit rather
// than the plan's own) are ignored: Orbit displays the plan bucket only.
func (p *planUsageProbe) mergeCodexRateLimits(raw map[string]interface{}) {
	update := codexPlanUsageFromSnapshot(raw)
	p.mu.Lock()
	defer p.mu.Unlock()
	current, _ := p.val.Load().(*PlanUsage)
	// Which bucket counts as the plan's own: whatever the last read reported, or
	// the default id before any read has landed — a session running a model with
	// its own bucket must not become the displayed one just because it spoke first.
	plan := codexPlanLimitID
	if current != nil && current.LimitID != "" {
		plan = current.LimitID
	}
	if update.LimitID != plan {
		return
	}
	p.val.Store(mergeCodexPlanUsage(current, update))
}

// run keeps the usage snapshot fresh without blocking heartbeats: it refreshes on
// the idle→busy edge (fresh when work starts), periodically while sessions run, once
// more on the busy→idle edge (capture just-finished usage), and at a slower idle
// cadence when this runner has an agent for the provider. activeCount reports how
// many sessions are currently running for that provider; idleEnabled reports whether
// it is worth polling the provider while no sessions are active. Failures are soft:
// the last good value is kept and a repeated error is logged only once.
func (p *planUsageProbe) run(ctx context.Context, activeCount func() int, idleEnabled func() bool) {
	p.runWithIntervals(ctx, activeCount, idleEnabled, planUsageCheckInterval, planUsageActiveInterval, planUsageIdleInterval)
}

func (p *planUsageProbe) runWithIntervals(ctx context.Context, activeCount func() int, idleEnabled func() bool, checkInterval, activeInterval, idleInterval time.Duration) {
	var lastErr string
	var lastFetch time.Time
	var lastUsage *PlanUsage
	refresh := func() {
		lastFetch = time.Now()
		u, err := p.fetch(ctx, p.client)
		if err != nil {
			if msg := err.Error(); msg != lastErr {
				logln(p.name+" unavailable:", msg)
				lastErr = msg
			}
			return
		}
		if lastErr != "" {
			logln(p.name + " recovered")
			lastErr = ""
		}
		p.store(u)
		lastUsage = p.snapshot()
	}
	wasActive := activeCount() > 0
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			active := activeCount() > 0
			due := activeInterval
			if !active {
				due = idleInterval
			}
			// Refresh on busy/idle transitions, when a busy runner is due for its
			// periodic poll, or when an idle-but-configured provider needs a slow
			// refresh so rolling reset windows do not go stale.
			dueNow := planUsageRefreshDue(lastFetch, lastUsage, time.Now(), due)
			if active != wasActive ||
				(active && dueNow) ||
				(!active && idleEnabled() && dueNow) {
				refresh()
			}
			wasActive = active
		}
	}
}

func planUsageRefreshDue(lastFetch time.Time, lastUsage *PlanUsage, now time.Time, interval time.Duration) bool {
	if lastFetch.IsZero() {
		return true
	}
	dueAt := lastFetch.Add(interval)
	if resetAt, ok := nextPlanUsageResetAfter(lastUsage, lastFetch); ok {
		resetDueAt := resetAt.Add(planUsageResetRefreshDelay)
		if resetDueAt.Before(dueAt) {
			dueAt = resetDueAt
		}
	}
	return !now.Before(dueAt)
}

func nextPlanUsageResetAfter(usage *PlanUsage, after time.Time) (time.Time, bool) {
	var best time.Time
	add := func(w *PlanUsageWindow) {
		if w == nil || w.ResetsAt == "" {
			return
		}
		t, err := time.Parse(time.RFC3339, w.ResetsAt)
		if err != nil || !t.After(after) {
			return
		}
		if best.IsZero() || t.Before(best) {
			best = t
		}
	}
	var visit func(*PlanUsage)
	visit = func(u *PlanUsage) {
		if u == nil {
			return
		}
		add(u.FiveHour)
		add(u.SevenDay)
		add(u.SevenDayOpus)
		add(u.SevenDaySonnet)
		add(u.Primary)
		add(u.Secondary)
		for _, limit := range u.RateLimits {
			add(limit.Primary)
			add(limit.Secondary)
		}
		visit(u.Claude)
		visit(u.Codex)
	}
	visit(usage)
	return best, !best.IsZero()
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
	b, err := claudeCredentialsJSON()
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

// claudeCredentialsJSON returns the raw {"claudeAiOauth":{...}} blob Claude Code
// stores. On Linux that's the .credentials.json file; on macOS the CLI keeps it in
// the login Keychain instead, leaving no file — so fall back to the Keychain when the
// file read fails. The original file error is preserved when the fallback also fails,
// so the logged reason stays accurate on non-mac hosts.
func claudeCredentialsJSON() ([]byte, error) {
	b, err := os.ReadFile(claudeCredentialsPath())
	if err == nil {
		return b, nil
	}
	if runtime.GOOS == "darwin" {
		if kb, kerr := keychainCredentials(); kerr == nil {
			return kb, nil
		}
	}
	return nil, err
}

// keychainCredentials reads Claude Code's OAuth credentials from the macOS login
// Keychain (item "Claude Code-credentials"), where the CLI stores them on darwin. The
// first read from the runner triggers a one-time Keychain access prompt; choosing
// "Always Allow" makes subsequent reads silent.
func keychainCredentials() ([]byte, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
	if err != nil {
		return nil, err
	}
	return out, nil
}

func fetchClaudePlanUsage(ctx context.Context, client *http.Client) (*PlanUsage, error) {
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
		Provider:       providerClaude,
		FiveHour:       norm(raw.FiveHour),
		SevenDay:       norm(raw.SevenDay),
		SevenDayOpus:   norm(raw.SevenDayOpus),
		SevenDaySonnet: norm(raw.SevenDaySonnet),
		FetchedAt:      time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func fetchCodexPlanUsage(ctx context.Context, _ *http.Client) (*PlanUsage, error) {
	env := os.Environ()
	cwd, _ := os.Getwd()
	state, err := codexPlanUsageStateForEnv(env, cwd)
	if err != nil {
		return nil, err
	}
	if err := ensureSharedCodexStateReady(ctx, ctx, state, env); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// This probe is the other regular starter on the shared partition, so it takes the same
	// handshake lock a session start does. Losing the wait costs one usage refresh; colliding
	// with a session start can cost the session.
	unlock := lockCodexStateHandshake(cctx, state)
	app, err := startBareCodexAppServer(cctx, state.Dir, env, cwd)
	if err != nil {
		unlock()
		return nil, err
	}
	defer app.close()
	err = app.initialize(cctx)
	unlock()
	if err != nil {
		return nil, err
	}
	result, err := app.request(cctx, "account/rateLimits/read", nil)
	if err != nil {
		return nil, err
	}
	return parseCodexPlanUsage(result)
}

func startBareCodexAppServer(ctx context.Context, stateDir string, env []string, cwd string) (*codexAppServer, error) {
	procCtx, cancel := context.WithCancel(ctx)
	args := []string{"app-server", "--stdio", "-c", fmt.Sprintf("sqlite_home=%q", stateDir)}
	cmd := exec.CommandContext(procCtx, "codex", args...)
	cmd.Env = env
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	app := &codexAppServer{
		cmd:           cmd,
		cancel:        cancel,
		stdin:         stdin,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 16),
		done:          make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	go app.readLoop(stdout)
	go func() {
		_, _ = io.Copy(io.Discard, stderr)
	}()
	return app, nil
}

func parseCodexPlanUsage(result map[string]interface{}) (*PlanUsage, error) {
	snapshot := codexRateLimitSnapshot(result)
	if snapshot == nil {
		return nil, fmt.Errorf("rateLimits response missing codex snapshot")
	}
	return codexPlanUsageFromSnapshot(snapshot), nil
}

// codexRateLimitSnapshot picks the bucket Orbit displays: the top-level rateLimits
// value, which is the plan's own limit. rateLimitsByLimitId can carry extra
// model/product buckets (a Spark bucket, say) that Orbit deliberately ignores; it
// is only consulted when a response omits the top-level value.
func codexRateLimitSnapshot(result map[string]interface{}) map[string]interface{} {
	if snapshot := mapValue(firstPresent(result, "rateLimits", "rate_limits")); snapshot != nil {
		return snapshot
	}
	limits := mapValue(firstPresent(result, "rateLimitsByLimitId", "rate_limits_by_limit_id"))
	return mapValue(limits[codexPlanLimitID])
}

func codexPlanUsageFromSnapshot(snapshot map[string]interface{}) *PlanUsage {
	limitID := firstString(snapshot, "limitId", "limit_id")
	if limitID == "" {
		limitID = codexPlanLimitID
	}
	limitName := firstString(snapshot, "limitName", "limit_name")
	primary := codexRateLimitWindow(false, mapValue(snapshot["primary"]))
	secondary := codexRateLimitWindow(true, mapValue(snapshot["secondary"]))
	credits := codexCreditsSnapshot(mapValue(snapshot["credits"]))
	return &PlanUsage{
		Provider:             providerCodex,
		LimitID:              limitID,
		LimitName:            limitName,
		PlanType:             firstString(snapshot, "planType", "plan_type"),
		RateLimitReachedType: firstString(snapshot, "rateLimitReachedType", "rate_limit_reached_type"),
		Primary:              primary,
		Secondary:            secondary,
		Credits:              credits,
		RateLimits: []PlanUsageRateLimit{{
			LimitID:   limitID,
			LimitName: limitName,
			Primary:   primary,
			Secondary: secondary,
			Credits:   credits,
		}},
		FetchedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// The fresher snapshot replaces the displayed windows, while account metadata the
// sparse rolling notification omits is carried over from the cached one.
func mergeCodexPlanUsage(current, update *PlanUsage) *PlanUsage {
	if current == nil {
		return update
	}
	if update == nil {
		return current
	}
	merged := *update
	merged.Provider = providerCodex
	if merged.LimitName == "" {
		merged.LimitName = current.LimitName
	}
	if merged.PlanType == "" {
		merged.PlanType = current.PlanType
	}
	if merged.RateLimitReachedType == "" {
		merged.RateLimitReachedType = current.RateLimitReachedType
	}
	if merged.Credits == nil {
		merged.Credits = current.Credits
	}
	if merged.FetchedAt == "" {
		merged.FetchedAt = current.FetchedAt
	}
	merged.RateLimits = []PlanUsageRateLimit{{
		LimitID:   merged.LimitID,
		LimitName: merged.LimitName,
		Primary:   merged.Primary,
		Secondary: merged.Secondary,
		Credits:   merged.Credits,
	}}
	return &merged
}

func codexRateLimitWindow(secondary bool, raw map[string]interface{}) *PlanUsageWindow {
	if raw == nil {
		return nil
	}
	used, ok := numberValue(firstPresent(raw, "usedPercent", "used_percent"))
	if !ok {
		return nil
	}
	mins, _ := int64Value(firstPresent(raw, "windowDurationMins", "window_duration_mins"))
	reset, _ := int64Value(firstPresent(raw, "resetsAt", "resets_at"))
	w := &PlanUsageWindow{
		Utilization:        used,
		Label:              codexWindowLabel(secondary, mins),
		WindowDurationMins: mins,
	}
	if reset > 0 {
		w.ResetsAt = time.Unix(reset, 0).UTC().Format(time.RFC3339)
	}
	return w
}

func codexWindowLabel(secondary bool, mins int64) string {
	const (
		fiveHours = int64(5 * 60)
		day       = int64(24 * 60)
		week      = int64(7 * 24 * 60)
		month     = int64(30 * 24 * 60)
		year      = int64(365 * 24 * 60)
	)
	for _, known := range []struct {
		minutes int64
		label   string
	}{
		{fiveHours, "5h limit"},
		{day, "Daily limit"},
		{week, "Weekly limit"},
		{month, "Monthly limit"},
		{year, "Annual limit"},
	} {
		if mins*100 >= known.minutes*95 && mins*100 <= known.minutes*105 {
			return known.label
		}
	}
	if secondary {
		return "Secondary usage limit"
	}
	return "Usage limit"
}

func codexCreditsSnapshot(raw map[string]interface{}) *CreditsSnapshot {
	if raw == nil {
		return nil
	}
	has, okHas := boolValue(raw["hasCredits"])
	unlimited, okUnlimited := boolValue(raw["unlimited"])
	if !okHas && !okUnlimited {
		return nil
	}
	return &CreditsSnapshot{
		HasCredits: has,
		Unlimited:  unlimited,
		Balance:    firstString(raw, "balance"),
	}
}

func combinePlanUsage(claude, codex *PlanUsage) *PlanUsage {
	if claude == nil {
		return codex
	}
	if codex == nil {
		return claude
	}
	fetchedAt := claude.FetchedAt
	if codex.FetchedAt > fetchedAt {
		fetchedAt = codex.FetchedAt
	}
	return &PlanUsage{Claude: claude, Codex: codex, FetchedAt: fetchedAt}
}

func numberValue(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func int64Value(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case float32:
		return int64(n), true
	case int:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		i, err := n.Int64()
		if err == nil {
			return i, true
		}
		f, ferr := n.Float64()
		return int64(f), ferr == nil
	default:
		return 0, false
	}
}

func boolValue(v interface{}) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}
