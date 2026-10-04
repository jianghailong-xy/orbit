package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The runner surfaces local coding-runtime quota so the UI can display per-runner
// plan usage. Claude uses the OAuth usage endpoint Claude Code itself calls; Codex
// uses the app-server account/rateLimits/read protocol method. Both are best-effort:
// failures degrade to "no usage reported" and never disturb the heartbeat.

var (
	// planUsageURL is where one Claude login's quota is read. A var so a test can point it at its
	// own server and prove which login's token went out.
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

// PlanUsageBucket preserves agy's public Google quota values; a fraction is remaining, not used.
type PlanUsageBucket struct {
	ID                string  `json:"id"`
	Window            string  `json:"window"`
	RemainingFraction float64 `json:"remainingFraction"`
	ResetTime         string  `json:"resetTime,omitempty"`
}

// PlanUsage is a provider usage snapshot. For compatibility, a single-provider
// heartbeat can still be flat; when the runner has multiple providers active, Claude
// and Codex snapshots are nested under claude/codex.
type PlanUsage struct {
	Provider string `json:"provider,omitempty"`
	// Antigravity Google account buckets from the independent /usage command.
	Buckets []PlanUsageBucket `json:"buckets,omitempty"`

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
	// Earned rate-limit reset state of the default Codex account
	// (docs/codex-rate-limit-reset-contract.md). Nil until a reader fills it; omitted on the wire.
	RateLimitReset *PlanUsageRateLimitReset `json:"rateLimitReset,omitempty"`
	// Codex only: every other account slot's own snapshot, by slot id (codex_account_usage.go). The
	// windows beside it are Default's. Omitted while no other account has been read.
	Accounts map[string]*PlanUsage `json:"accounts,omitempty"`

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
	// The Codex probe's reset reader, which the reset steps read through too; nil for Claude.
	codexReset *codexResetReader
}

// newClaudePlanUsageProbe reads the usage of the login the runner's own environment selects — the
// machine's Default account.
func newClaudePlanUsageProbe() *planUsageProbe {
	read := &claudeUsageRead{name: "claude plan-usage"}
	fetch := func(ctx context.Context, client *http.Client) (*PlanUsage, error) { return read.fetch(ctx, client, "") }
	return &planUsageProbe{client: &http.Client{}, name: read.name, fetch: fetch}
}


// newCodexPlanUsageProbe reads Codex usage for the runner process whose heartbeat leaseOwner is
// leaseOwner: the generation of every rate-limit reset block the probe reads.
func newCodexPlanUsageProbe(leaseOwner string) *planUsageProbe {
	reader := &codexResetReader{leaseOwner: leaseOwner}
	fetch := func(ctx context.Context, _ *http.Client) (*PlanUsage, error) { return fetchCodexPlanUsage(ctx, reader) }
	return &planUsageProbe{client: &http.Client{}, name: "codex plan-usage", fetch: fetch, codexReset: reader}
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
			if msg := planUsageErrorText(err); msg != lastErr {
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

// claudeCredentialsPathIn is where Claude Code stores one login's OAuth creds, honoring
// CLAUDE_CONFIG_DIR (which the CLI itself respects) and otherwise ~/.claude — the same HOME the
// runner spawns claude under, so the token always matches. configDir names one account's
// directory, and is empty for the login the runner's own environment selects.
func claudeCredentialsPathIn(configDir string) string {
	if configDir == "" {
		configDir = os.Getenv("CLAUDE_CONFIG_DIR")
	}
	if configDir == "" {
		configDir = filepath.Join(userHome(), ".claude")
	}
	return filepath.Join(configDir, ".credentials.json")
}

func claudeCredentialsPath() string { return claudeCredentialsPathIn("") }

// claudeOAuthLogin is what the runner takes from one login's stored credentials: the access token a
// usage read sends, when that token expires (zero when the CLI recorded no time), and whether a
// refresh token is stored beside it — never the refresh token itself, which is the CLI's alone
// (claudeUsageRead).
type claudeOAuthLogin struct {
	accessToken string
	expiresAt   time.Time
	refreshable bool
}

// expiresWithin is a token at most lead from its expiry, or past it — with no lead, one the endpoint
// will refuse. A login with no recorded expiry never is.
func (l claudeOAuthLogin) expiresWithin(lead time.Duration, now time.Time) bool {
	return !l.expiresAt.IsZero() && !now.Add(lead).Before(l.expiresAt)
}

// parseClaudeOAuthLogin reads the {"claudeAiOauth":{...}} blob Claude Code stores, whatever it holds:
// a login the CLI signed out — it empties both tokens when the server refuses a refresh — parses too.
func parseClaudeOAuthLogin(b []byte) (claudeOAuthLogin, error) {
	var c struct {
		ClaudeAiOauth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			// Milliseconds since the epoch, as the CLI writes it. Read loosely: an expiry in a shape
			// this runner does not know reads as none, rather than costing the login its reading.
			ExpiresAt interface{} `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return claudeOAuthLogin{}, err
	}
	login := claudeOAuthLogin{accessToken: c.ClaudeAiOauth.AccessToken, refreshable: c.ClaudeAiOauth.RefreshToken != ""}
	if ms, ok := int64Value(c.ClaudeAiOauth.ExpiresAt); ok && ms > 0 {
		login.expiresAt = time.UnixMilli(ms)
	}
	return login, nil
}

// claudeStoredLoginIn is the login kept in configDir as stored, signed out or not.
func claudeStoredLoginIn(configDir string) (claudeOAuthLogin, error) {
	b, err := claudeCredentialsJSONIn(configDir)
	if err != nil {
		return claudeOAuthLogin{}, err
	}
	return parseClaudeOAuthLogin(b)
}

// claudeOAuthLoginIn is the login kept in configDir, with an access token to send.
func claudeOAuthLoginIn(configDir string) (claudeOAuthLogin, error) {
	login, err := claudeStoredLoginIn(configDir)
	if err == nil && login.accessToken == "" {
		err = fmt.Errorf("no oauth token (api-key auth?)")
	}
	return login, err
}

// claudeCredentialsJSONIn returns the raw {"claudeAiOauth":{...}} blob Claude Code stores. On
// Linux that's the .credentials.json file; on macOS the CLI keeps it in the login Keychain
// instead, leaving no file — so fall back to the Keychain when the file read fails. The original
// file error is preserved when the fallback also fails, so the logged reason stays accurate on
// non-mac hosts.
//
// The Keychain fallback is the machine's own login only: the item is a single one for the whole
// user, with nothing naming an account, so an added account that fell back to it would report the
// machine's quota as its own. A slot with no file has no reading, and says so.
func claudeCredentialsJSONIn(configDir string) ([]byte, error) {
	b, err := os.ReadFile(claudeCredentialsPathIn(configDir))
	if err == nil {
		return b, nil
	}
	if configDir == "" && runtime.GOOS == "darwin" {
		if kb, kerr := keychainCredentials(context.Background(), claudeKeychainService("")); kerr == nil {
			return kb, nil
		}
	}
	return nil, err
}

// claudeKeychainService names the macOS Keychain item Claude Code keeps a login's credentials in:
// "Claude Code-credentials" for a CLI run with no CLAUDE_CONFIG_DIR, and for one run with it, the
// first eight hex digits of that directory's SHA-256 after a dash (2.1.288).
func claudeKeychainService(configDir string) string {
	if configDir == "" {
		return "Claude Code-credentials"
	}
	sum := sha256.Sum256([]byte(configDir))
	return "Claude Code-credentials-" + hex.EncodeToString(sum[:])[:8]
}

// keychainCredentials reads Claude Code's OAuth credentials from the macOS login
// Keychain item service, where the CLI stores them on darwin. The
// first read from the runner triggers a one-time Keychain access prompt; choosing
// "Always Allow" makes subsequent reads silent.
func keychainCredentials(ctx context.Context, service string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "security", "find-generic-password", "-s", service, "-w").Output()
	if err != nil {
		return nil, err
	}
	return out, nil
}

var (
	// claudeCLIRefreshLead is how near its expiry Claude Code takes a token to need refreshing, from
	// any command it runs: five minutes (2.1.288 refreshes once now+300000 >= expiresAt).
	claudeCLIRefreshLead = 5 * time.Minute
	// claudeTokenRefreshRetry is how soon a login whose token Claude Code did not refresh is asked
	// again: the CLI missing, the network down, a refresh token the server no longer takes. Each ask
	// is a CLI process, and a login that would not refresh on one pass will not on the next.
	claudeTokenRefreshRetry = 30 * time.Minute
	// claudeTokenRefreshTimeout stops only a CLI that hangs: a refresh cut off after the server has
	// rotated the token leaves the login holding a spent one (claudeStatusRefreshWindow), so the run
	// is given far longer than it takes. Measured on 2.1.288: about 20s the first time it runs in an
	// account's directory, which syncs that account's plugins and skills; 11–13s against a token
	// endpoint answering in 8s.
	claudeTokenRefreshTimeout = 5 * time.Minute
)

// claudeRefreshing is every config directory a refresh run is under way in ("" for the runner's
// own), so that no directory gets a second before the first has ended — a read whose loop was
// stopped does not stop its refresh (refreshClaudeToken), and the loop that replaces it could
// otherwise start another.
var claudeRefreshing = struct {
	sync.Mutex
	dirs map[string]bool
}{dirs: map[string]bool{}}

var errClaudeRefreshRunning = errors.New("a refresh is already running for this login")

// errClaudeTokenRefused is a login whose token the usage endpoint answered 401. The passes that skip
// that token return the same error the refusal did, so they log nothing new.
var errClaudeTokenRefused = errors.New("usage endpoint -> 401; this token is not sent again")

// claudeUsageRead is one Claude login's usage read, and what it keeps between passes.
//
// The token it sends is the CLI's, read from the login's credentials on every pass, and only Claude
// Code ever refreshes it: a refresh rotates the refresh token too, and the CLI does it under a lock
// in the config directory, re-reading what another process may have written meanwhile. A refresher
// outside that lock could spend a refresh token the CLI is about to use and sign the account out.
//
// The CLI refreshes a token as it starts any command once the token is within claudeCLIRefreshLead
// of expiring, so a login sessions run on keeps itself fresh. A login none run on — an account whose
// quota is spent, the one no session is sent to — sees only the runner's own commands, and the one
// that refreshed it was the engine probe's `claude auth status`, which does not wait for the refresh
// it starts: cut short, it left the login holding a spent refresh token (claudeStatusRefreshWindow,
// which now keeps the probe out of that window). On wikova (2026-10-02) such an account read 401 for
// twelve hours under a page that said Signed in, and the next refresh signed it out. So the read has
// the token refreshed itself once it is due, with a run that waits for the refresh to land
// (refreshClaudeToken): renewed before it expires, an idle login's reading never stops.
type claudeUsageRead struct {
	// name is the probe's, for the line this read logs when it has a token refreshed.
	name string
	// refused is the SHA-256 of the token the endpoint last answered 401 — never the token itself.
	// That token is not sent again: the answer will not change, and each request spent on it counts
	// against the rate limit the next good read has to get past (on wikova the 401s came with 429s).
	// Any other token is read at once, and one that expires is refreshed.
	refused [sha256.Size]byte
	// asked is when Claude Code was last asked to refresh this login's token, and askErr how that
	// ask ended, repeated on every pass until the next ask.
	asked  time.Time
	askErr error
}

// fetch reads the usage of the login kept in configDir ("" for the runner's own).
func (r *claudeUsageRead) fetch(ctx context.Context, client *http.Client, configDir string) (*PlanUsage, error) {
	login, err := r.login(ctx, configDir)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(login.accessToken))
	if sum == r.refused {
		return nil, errClaudeTokenRefused
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, planUsageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+login.accessToken)
	req.Header.Set("anthropic-beta", planUsageBeta)
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", "orbit-runner/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized {
		r.refused = sum
		return nil, errClaudeTokenRefused
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("usage endpoint -> %d", resp.StatusCode)
	}
	return parsePlanUsage(body)
}

// login is the token the read sends: the stored one, or — once that is due for refreshing — whatever
// Claude Code leaves on disk after being asked to refresh it. An expired token is never sent.
//
// A login whose refresh token the server has already spent — one an earlier refresh was cut short
// on — cannot be refreshed: asked, the CLI is refused and empties it. That is a login signed out,
// which is what it was; the engine probe says so from then on, where it used to say Signed in.
func (r *claudeUsageRead) login(ctx context.Context, configDir string) (claudeOAuthLogin, error) {
	login, err := claudeOAuthLoginIn(configDir)
	if err != nil || !login.expiresWithin(claudeCLIRefreshLead, time.Now()) {
		return login, err
	}
	expiry := login.expiresAt.UTC().Format(time.RFC3339)
	if time.Since(r.asked) >= claudeTokenRefreshRetry {
		r.asked = time.Now()
		r.askErr = refreshClaudeToken(ctx, configDir)
		if login, err = claudeStoredLoginIn(configDir); err != nil {
			return login, err
		}
		if login.accessToken == "" {
			return login, errors.New("signed out: Claude Code's refresh was refused, and it cleared the login")
		}
		if !login.expiresWithin(claudeCLIRefreshLead, time.Now()) {
			logln(r.name + ": Claude Code refreshed the access token (expiry " + expiry + ")")
			return login, nil
		}
	}
	// Not refreshed, but not expired either: still a token to read with.
	if !login.expiresWithin(0, time.Now()) {
		return login, nil
	}
	if r.askErr != nil {
		return login, fmt.Errorf("access token expired at %s; Claude Code did not refresh it: %v", expiry, r.askErr)
	}
	return login, fmt.Errorf("access token expired at %s; Claude Code did not refresh it", expiry)
}

// claudeTokenRefreshArgs is a CLI run that bills nothing and has a token that is due refreshed:
// `/help` is answered client-side, with nothing sent to a model (num_turns 0, total_cost_usd 0 —
// the run probeClaudeSlashAssets reads its registry from), yet the CLI gets its OAuth token ready
// as it starts, and — unlike `auth status` — waits for the refresh to land before it exits.
// Measured on 2.1.288: on an idle account whose token had expired, the access and refresh tokens
// rotated and expiresAt moved eight hours on, and with the token still good nothing changed;
// against a fake token endpoint answering in 2.5, 5 and 8 seconds, the rotated pair was written
// every time.
var claudeTokenRefreshArgs = []string{"-p", "/help", "--output-format", "stream-json", "--verbose", "--no-session-persistence"}

// refreshClaudeToken asks Claude Code to refresh the token of the login kept in configDir ("" for
// the runner's own), unless a refresh is already under way there.
func refreshClaudeToken(ctx context.Context, configDir string) error {
	claudeRefreshing.Lock()
	if claudeRefreshing.dirs[configDir] {
		claudeRefreshing.Unlock()
		return errClaudeRefreshRunning
	}
	claudeRefreshing.dirs[configDir] = true
	claudeRefreshing.Unlock()
	defer func() {
		claudeRefreshing.Lock()
		delete(claudeRefreshing.dirs, configDir)
		claudeRefreshing.Unlock()
	}()
	// Not cut off with the read: a refresh stopped once the server has rotated the token leaves the
	// login holding a spent one, so a runner shutting down or an account being removed lets it end.
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), claudeTokenRefreshTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", claudeTokenRefreshArgs...)
	cmd.Env = envWithAgent(nil)
	if configDir != "" {
		cmd.Env = envWithValue(cmd.Env, "CLAUDE_CONFIG_DIR", configDir)
	}
	return cmd.Run()
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

func fetchCodexPlanUsage(ctx context.Context, reader *codexResetReader) (*PlanUsage, error) {
	var usage *PlanUsage
	err := withDefaultCodexAppServer(ctx, 30*time.Second, func(cctx context.Context, app *codexAppServer) error {
		var err error
		usage, err = reader.readCodexPlanUsage(cctx, app)
		return err
	})
	return usage, err
}

// fetchCodexAccountPlanUsage reads the windows of one added account slot: account/rateLimits/read on
// a bare app-server of that slot, and nothing else. No account/read, so no reset block: reset v1 is
// Default's alone (docs/codex-rate-limit-reset-contract.md §3). The account id beside the windows
// comes back with them: that same read is where the slot's account fingerprint comes from, and it is
// turned into one by the caller — never stored, reported or logged, so the provider's own id for the
// account stays on this machine (§3).
func fetchCodexAccountPlanUsage(ctx context.Context, codexHome string) (*PlanUsage, string, error) {
	var usage *PlanUsage
	var accountID string
	err := withCodexAccountAppServer(ctx, codexHome, 30*time.Second, func(cctx context.Context, app *codexAppServer) error {
		rateLimits, err := app.request(cctx, codexRateLimitsReadMethod, nil)
		if err != nil {
			return err
		}
		if usage, err = parseCodexPlanUsage(rateLimits); err != nil {
			return err
		}
		accountID, _ = rateLimits["accountId"].(string)
		return nil
	})
	return usage, strings.TrimSpace(accountID), err
}

// withDefaultCodexAppServer runs use on a bare app-server of the runner's default Codex account — the
// one the runner's own environment selects — once its handshake is done, all within budget, and closes
// the app-server after. The shared state bootstrap before it waits on ctx alone.
func withDefaultCodexAppServer(ctx context.Context, budget time.Duration, use func(context.Context, *codexAppServer) error) error {
	return withCodexAppServer(ctx, os.Environ(), budget, use)
}

// withCodexAccountAppServer is withDefaultCodexAppServer for an added account slot: the runner's own
// environment with that slot's CODEX_HOME, so the app-server opens the slot's own shared state
// partition under that partition's handshake lock — the path a session on the slot takes. Never a
// fresh sqlite_home, and never another account's credentials copied in.
func withCodexAccountAppServer(ctx context.Context, codexHome string, budget time.Duration, use func(context.Context, *codexAppServer) error) error {
	return withCodexAppServer(ctx, envWithValue(os.Environ(), "CODEX_HOME", codexHome), budget, use)
}

func withCodexAppServer(ctx context.Context, env []string, budget time.Duration, use func(context.Context, *codexAppServer) error) error {
	cwd, _ := os.Getwd()
	state, err := codexPlanUsageStateForEnv(env, cwd)
	if err != nil {
		return err
	}
	if err := ensureSharedCodexStateReady(ctx, ctx, state, env); err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	// The usage probe and the reset steps are the other regular starters on the shared partition, so
	// they take the same handshake lock a session start does. Losing the wait costs one read; colliding
	// with a session start can cost the session.
	unlock := lockCodexStateHandshake(cctx, state)
	app, err := startBareCodexAppServer(cctx, state.Dir, env, cwd)
	if err != nil {
		unlock()
		return err
	}
	defer app.close()
	err = app.initialize(cctx)
	unlock()
	if err != nil {
		return err
	}
	return use(cctx, app)
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
	// An authoritative read that started before the cached one must not restore pre-reset
	// windows alongside the newer reset credits. Rolling notifications carry no reset block.
	if update.RateLimitReset != nil && !codexResetBlockSupersedes(update.RateLimitReset, current.RateLimitReset) {
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
	// A reset block comes only from this process's own reads — a rolling notification carries
	// none — and never gives way to the block of a read that started earlier.
	if !codexResetBlockSupersedes(merged.RateLimitReset, current.RateLimitReset) {
		merged.RateLimitReset = current.RateLimitReset
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
