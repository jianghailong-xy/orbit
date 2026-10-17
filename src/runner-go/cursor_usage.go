package main

// Cursor CLI plan usage, one snapshot per account (cursor_account_slot.go): Default's and every added
// account's own, each read with that account's own saved sign-in (docs/cursor-runtime-contract.md §11).
//
// The read is the one Cursor CLI's own /usage makes: Cursor's dashboard service over Connect's JSON
// protocol, GetCurrentPeriodUsage for the account's included usage this period and GetPlanInfo for its
// plan. The token is the access token the account's sign-in saved, the one a session on the account
// borrows (cursorAccountLogin), and nothing refreshes it: Cursor CLI renews only a token it traded an
// API key for, never a sign-in's (§8.4), and the runner does not either. A sign-in past its token's
// expiry — or within the five minutes the CLI already counts as expired — is not read: its account
// needs signing in again, and its usage is unavailable until then.
//
// What the dashboard reports is mapped as @orbit/shared PlanUsageIncludedUsage says. What it does not
// report is the one thing that decides whether an account can run: Cursor answers 0% for the Free
// plan's requests and for Auto alike, and still did once the Free plan's limit was met (§11). So the
// runner keeps that itself, per account: when a turn on the account met Cursor's usage limit — the
// turns P5b settles in cursorUsageLimitText's words — kept on disk so a restart forgets no spent
// account, and reported until the period it was met in is over or a later turn on the account ends
// well. The control plane takes the account to be spent from then until its included usage resets.
//
// The container is kimiAccountUsage's, for its reasons: a login per directory, nothing naming the
// account inside it, and no rolling snapshot a session pushes. The heartbeat carries Default's snapshot
// as planUsage.cursor's own and every other account's under its accounts, by slot id, each naming its
// account (PlanUsage.Account). A read that fails leaves the account's last reading in place with the
// fetchedAt it was read at, and is logged once, not every pass.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// cursorDashboardURL is Cursor's dashboard service, each method a POST beneath it (§11). A var so a test
// can point it at a server of its own.
var cursorDashboardURL = "https://api2.cursor.sh/aiserver.v1.DashboardService/"

// cursorTimeLayout is how the runner writes a Cursor time: UTC to the millisecond, as Cursor sends it.
const cursorTimeLayout = "2006-01-02T15:04:05.000Z07:00"

// cursorUsagePeriods is the period Cursor names an account's included usage by, as Orbit names it.
var cursorUsagePeriods = map[string]string{
	"INCLUDED_USAGE_PERIOD_WEEKLY":  "weekly",
	"INCLUDED_USAGE_PERIOD_MONTHLY": "monthly",
}

var (
	errCursorNotSignedIn  = errors.New("not signed in to Cursor CLI")
	errCursorLoginExpired = errors.New("the saved sign-in has expired, and Cursor CLI does not renew it — sign the account in again")
	errCursorTokenRefused = errors.New("Cursor's dashboard -> 401; this token is not sent again")
)

// cursorUsageRead is one Cursor CLI account's usage read, and what it keeps between passes: the hash —
// never the token — of a token Cursor's dashboard refused. That token is not sent again: the answer would
// not change, and only signing in again replaces it.
type cursorUsageRead struct {
	refused [sha256.Size]byte
}

// fetch reads the usage of the account kept at dir: its plan and its included usage this period, both
// asked with the token its sign-in saved. Either one failing fails the read, so the account's last full
// reading stays.
func (r *cursorUsageRead) fetch(ctx context.Context, client *http.Client, dir string) (*PlanUsage, error) {
	token, err := cursorStoredLogin(dir)
	switch {
	case err != nil:
		return nil, err
	case token == "":
		return nil, errCursorNotSignedIn
	case cursorTokenExpired(token, time.Now()):
		return nil, errCursorLoginExpired
	}
	sum := sha256.Sum256([]byte(token))
	if sum == r.refused {
		return nil, errCursorTokenRefused
	}
	period, err := r.call(ctx, client, token, "GetCurrentPeriodUsage")
	if err != nil {
		return nil, err
	}
	plan, err := r.call(ctx, client, token, "GetPlanInfo")
	if err != nil {
		return nil, err
	}
	return parseCursorPlanUsage(period, plan)
}

// call asks Cursor's dashboard one method, with the empty request and the headers the CLI's /usage sends
// (§11, measured with them).
func (r *cursorUsageRead) call(ctx context.Context, client *http.Client, token, method string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, cursorDashboardURL+method, strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("X-Cursor-Client-Type", "cli")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "orbit-runner/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		r.refused = sha256.Sum256([]byte(token))
		return nil, errCursorTokenRefused
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Cursor's dashboard %s -> %d", method, resp.StatusCode)
	}
	return body, nil
}

// parseCursorPlanUsage maps what GetCurrentPeriodUsage and GetPlanInfo answered to one account's snapshot
// (@orbit/shared PlanUsageIncludedUsage says how): the period and its reset, the share used when Cursor
// reports one above 0, and the plan. Read leniently, field by field: a field that is missing or not what
// it should be is left out — unavailable, never 0.
func parseCursorPlanUsage(periodBody, planBody []byte) (*PlanUsage, error) {
	var period struct {
		BillingCycleStart interface{} `json:"billingCycleStart"`
		BillingCycleEnd   interface{} `json:"billingCycleEnd"`
		PlanUsage         struct {
			TotalPercentUsed interface{} `json:"totalPercentUsed"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(periodBody, &period); err != nil {
		return nil, fmt.Errorf("GetCurrentPeriodUsage: %w", err)
	}
	var plan struct {
		PlanInfo struct {
			PlanName              interface{} `json:"planName"`
			IncludedUsagePeriod   interface{} `json:"includedUsagePeriod"`
			IncludedUsageResetsAt interface{} `json:"includedUsageResetsAt"`
		} `json:"planInfo"`
	}
	if err := json.Unmarshal(planBody, &plan); err != nil {
		return nil, fmt.Errorf("GetPlanInfo: %w", err)
	}
	periodName, _ := plan.PlanInfo.IncludedUsagePeriod.(string)
	included := PlanUsageIncludedUsage{
		Period:   cursorUsagePeriods[periodName],
		StartsAt: cursorTime(period.BillingCycleStart),
		// A paid plan's week where Cursor names its reset; else the period the usage is counted over —
		// the Free plan's billing month, whose end is when its requests come back (§11, §12).
		ResetsAt: firstNonEmpty(cursorTime(plan.PlanInfo.IncludedUsageResetsAt), cursorTime(period.BillingCycleEnd)),
	}
	if used, ok := numberValue(period.PlanUsage.TotalPercentUsed); ok && used > 0 {
		included.PercentUsed = used
	}
	planName, _ := plan.PlanInfo.PlanName.(string)
	usage := &PlanUsage{Provider: providerCursor, PlanName: strings.TrimSpace(planName), FetchedAt: time.Now().UTC().Format(time.RFC3339)}
	if included != (PlanUsageIncludedUsage{}) {
		usage.IncludedUsage = &included
	}
	return usage, nil
}

// cursorTime is one of Cursor's times — milliseconds since the epoch, which Connect's JSON writes as a
// string — in cursorTimeLayout, or "" for anything else.
func cursorTime(v interface{}) string {
	var ms int64
	switch n := v.(type) {
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(n), 10, 64)
		if err != nil {
			return ""
		}
		ms = parsed
	case float64:
		ms = int64(n)
	default:
		return ""
	}
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(cursorTimeLayout)
}

// cursorUsageLimitsPath is where the runner keeps, by account id, when a turn on each Cursor CLI account
// last met Cursor's usage limit: under its own Cursor directory, never in an account's.
func cursorUsageLimitsPath() string { return filepath.Join(cursorRoot(), "usage-limits.json") }

// cursorUsageLimitsMu serializes every change to the file: sessions settle turns on their own goroutines.
var cursorUsageLimitsMu sync.Mutex

// readCursorUsageLimits is every account's usage limit met, by id. A file missing or unreadable is none.
func readCursorUsageLimits() map[string]time.Time {
	out := map[string]time.Time{}
	b, err := os.ReadFile(cursorUsageLimitsPath())
	if err != nil {
		return out
	}
	var stored map[string]string
	if json.Unmarshal(b, &stored) != nil {
		return out
	}
	for id, at := range stored {
		if t, err := time.Parse(time.RFC3339, at); err == nil {
			out[id] = t
		}
	}
	return out
}

// changeCursorUsageLimits applies change to the stored usage limits and writes them back when it changed
// something, under cursorUsageLimitsMu.
func changeCursorUsageLimits(change func(map[string]time.Time) bool) {
	cursorUsageLimitsMu.Lock()
	defer cursorUsageLimitsMu.Unlock()
	limits := readCursorUsageLimits()
	if !change(limits) {
		return
	}
	stored := map[string]string{}
	for id, at := range limits {
		stored[id] = at.UTC().Format(cursorTimeLayout)
	}
	b, err := json.Marshal(stored)
	if err == nil {
		if err = ensurePrivateDir(cursorRoot()); err == nil {
			err = writeFileAtomically(cursorUsageLimitsPath(), b, 0o600)
		}
	}
	if err != nil {
		logln("cursor plan-usage: could not keep the accounts' usage limits:", err)
	}
}

// noteCursorUsageLimit keeps that a turn on account met Cursor's usage limit at at.
func noteCursorUsageLimit(account string, at time.Time) {
	changeCursorUsageLimits(func(limits map[string]time.Time) bool {
		limits[account] = at
		return true
	})
}

// forgetCursorUsageLimit drops account's usage limit met, if it had one; with before set, only one met
// before then — a limit met before the period an account's reading describes began is over.
func forgetCursorUsageLimit(account string, before time.Time) {
	changeCursorUsageLimits(func(limits map[string]time.Time) bool {
		at, ok := limits[account]
		if !ok || (!before.IsZero() && !at.Before(before)) {
			return false
		}
		delete(limits, account)
		return true
	})
}

// cursorSessionAccount is the runner account a Cursor CLI session spends, as cursorLaunchCredential picks
// its credential: an added account's id when it borrows that account's login, accountSlotDefaultID when
// it borrows Default's, and "" when it spends none of this runner's — a dispatched Cursor API key, a key or
// token of its workspace's own, or an account the runner refuses it.
func cursorSessionAccount(job *ClaimedSession) string {
	if cursorSessionKey(job) != "" {
		return ""
	}
	dir, err := cursorSessionAccountDir(job.Agent.Env)
	if err != nil {
		return ""
	}
	if def, err := filepath.Abs(cursorDefaultAccountDir()); err != nil || dir != def {
		return filepath.Base(dir)
	}
	if strings.TrimSpace(job.Agent.Env["CURSOR_API_KEY"]) != "" || strings.TrimSpace(job.Agent.Env["CURSOR_AUTH_TOKEN"]) != "" {
		return ""
	}
	return accountSlotDefaultID
}

// noteCursorTurn keeps what a turn that ended on account says of its quota: it met Cursor's usage limit —
// it failed in the words cursorTurnFailure reports that in — or the account ran it, which a turn that ended
// well shows. Nothing for a session that spends no account of this runner's (account ""), nor for a turn
// that ended any other way.
func noteCursorTurn(account string, req TurnCompleteRequest) {
	switch {
	case account == "":
	case req.Status == stFailed && req.Error == cursorUsageLimitText("Upgrade your plan to continue"):
		noteCursorUsageLimit(account, time.Now())
	case req.Status == stSucceeded:
		forgetCursorUsageLimit(account, time.Time{})
	}
}

type cursorAccountUsage struct {
	def   *planUsageProbe
	mu    sync.Mutex
	slots map[string]*cursorSlotUsage
}

type cursorSlotUsage struct {
	probe *planUsageProbe
	stop  context.CancelFunc
}

func newCursorAccountUsage() *cursorAccountUsage {
	return &cursorAccountUsage{def: newCursorPlanUsageProbe(accountSlotDefaultID), slots: map[string]*cursorSlotUsage{}}
}

// newCursorPlanUsageProbe reads account id. Its directory is resolved on every pass, so a slot that moved
// is read where it is now, and one that is gone stops being readable rather than answering from Default.
// A reading also ends a usage limit met before the period it describes began.
func newCursorPlanUsageProbe(id string) *planUsageProbe {
	name := "cursor plan-usage"
	if id != accountSlotDefaultID {
		name += " (account " + id + ")"
	}
	read := &cursorUsageRead{}
	fetch := func(ctx context.Context, client *http.Client) (*PlanUsage, error) {
		dir, err := cursorAccountKind.home(id)
		if err != nil {
			return nil, err
		}
		usage, err := read.fetch(ctx, client, dir)
		if err == nil && usage.IncludedUsage != nil {
			if starts, perr := time.Parse(time.RFC3339, usage.IncludedUsage.StartsAt); perr == nil {
				forgetCursorUsageLimit(id, starts)
			}
		}
		return usage, err
	}
	return &planUsageProbe{client: &http.Client{}, name: name, fetch: fetch}
}

// slot returns added account id's entry, making it on first use. The caller holds u.mu.
func (u *cursorAccountUsage) slot(id string) *cursorSlotUsage {
	s := u.slots[id]
	if s == nil {
		s = &cursorSlotUsage{probe: newCursorPlanUsageProbe(id)}
		u.slots[id] = s
	}
	return s
}

// forget stops added account id's read loop and drops what this runner keeps for it — its reading and its
// usage limit met — so the account leaves the heartbeat's list with its directory.
func (u *cursorAccountUsage) forget(id string) {
	if u != nil {
		u.mu.Lock()
		s := u.slots[id]
		delete(u.slots, id)
		u.mu.Unlock()
		if s != nil && s.stop != nil {
			s.stop()
		}
	}
	forgetCursorUsageLimit(id, time.Time{})
}

// removeCursorAccount carries out one removal of added account id: its directory and record, and the read
// of its quota with them.
func removeCursorAccount(usage *cursorAccountUsage, id string, liveDirs map[string]bool) error {
	if err := cursorAccountKind.remove(id, liveDirs); err != nil {
		return err
	}
	usage.forget(id)
	return nil
}

// snapshot is the Cursor CLI plan usage the heartbeat reports: Default's snapshot, with every other
// account that has one under Accounts. Each is a copy naming its account (cursorAccountSnapshot), as the
// probes share theirs.
func (u *cursorAccountUsage) snapshot() *PlanUsage {
	limits := readCursorUsageLimits()
	def := cursorAccountSnapshot(accountSlotDefaultID, u.def.snapshot(), limits)
	u.mu.Lock()
	var accounts map[string]*PlanUsage
	for id, s := range u.slots {
		if usage := cursorAccountSnapshot(id, s.probe.snapshot(), limits); usage != nil {
			if accounts == nil {
				accounts = map[string]*PlanUsage{}
			}
			accounts[id] = usage
		}
	}
	u.mu.Unlock()
	if accounts == nil {
		return def
	}
	// Before Default has anything to say, the other accounts ride on a snapshot holding nothing of its own.
	out := PlanUsage{Provider: providerCursor}
	if def != nil {
		out = *def
	}
	out.Accounts = accounts
	return &out
}

// cursorAccountSnapshot is account id's snapshot as the heartbeat carries it: its last reading, naming its
// account, with when a turn on it met Cursor's usage limit — unless that was before the period the reading
// describes began. Nil when there is neither a reading nor a limit met.
func cursorAccountSnapshot(id string, read *PlanUsage, limits map[string]time.Time) *PlanUsage {
	reached, met := limits[id]
	if read == nil && !met {
		return nil
	}
	out := PlanUsage{Provider: providerCursor}
	if read != nil {
		out = *read
	}
	out.Account = id
	if met {
		var included PlanUsageIncludedUsage
		if out.IncludedUsage != nil {
			included = *out.IncludedUsage
		}
		if starts, err := time.Parse(time.RFC3339, included.StartsAt); err != nil || !reached.Before(starts) {
			included.LimitReachedAt = reached.UTC().Format(cursorTimeLayout)
			out.IncludedUsage = &included
		}
	}
	return &out
}

// run keeps every account's snapshot fresh on the cadence planUsageProbe.run keeps Claude's and Codex's:
// Default's, and one loop per added account, started once it is listed and stopped once it is gone.
func (u *cursorAccountUsage) run(ctx context.Context, activeCount func() int, idleEnabled func() bool) {
	u.runWithIntervals(ctx, activeCount, idleEnabled, planUsageCheckInterval, planUsageActiveInterval, planUsageIdleInterval)
}

func (u *cursorAccountUsage) runWithIntervals(ctx context.Context, activeCount func() int, idleEnabled func() bool, checkInterval, activeInterval, idleInterval time.Duration) {
	go u.def.runWithIntervals(ctx, activeCount, idleEnabled, checkInterval, activeInterval, idleInterval)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		u.syncSlots(ctx, func(loopCtx context.Context, probe *planUsageProbe) {
			go probe.runWithIntervals(loopCtx, activeCount, idleEnabled, checkInterval, activeInterval, idleInterval)
		})
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// syncSlots starts a read loop for every added account listed that has none, and stops the loop of, and
// forgets, every account no longer listed. A listing that fails changes nothing.
func (u *cursorAccountUsage) syncSlots(ctx context.Context, start func(context.Context, *planUsageProbe)) {
	slots, err := cursorAccountKind.list()
	if err != nil {
		return
	}
	listed := map[string]bool{}
	var gone []string
	u.mu.Lock()
	for _, slot := range slots {
		if slot.ID == accountSlotDefaultID {
			continue
		}
		listed[slot.ID] = true
		if s := u.slot(slot.ID); s.stop == nil {
			loopCtx, stop := context.WithCancel(ctx)
			s.stop = stop
			start(loopCtx, s.probe)
		}
	}
	for id, s := range u.slots {
		if listed[id] {
			continue
		}
		if s.stop != nil {
			s.stop()
		}
		delete(u.slots, id)
		gone = append(gone, id)
	}
	u.mu.Unlock()
	for _, id := range gone {
		forgetCursorUsageLimit(id, time.Time{})
	}
}
