package main

// Cursor CLI plan usage per account (cursor_usage.go), against a stand-in for Cursor's dashboard: each
// account read with its own saved sign-in and parsed as @orbit/shared says, what Cursor does not report
// left out rather than sent as 0, the heartbeat naming every account's snapshot under planUsage.cursor, and
// the usage limit a session's turn met kept for the account it ran on. scripts/test-cursor-quota.mjs runs
// every one of these by name.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// cursorPlanUsageFixture is Cursor CLI quota from end to end (src/shared/src/cursor-plan-usage.fixture.json):
// @orbit/shared's cursor-plan-usage.spec.ts decides from each case's planUsage what the case says.
const cursorPlanUsageFixture = "../shared/src/cursor-plan-usage.fixture.json"

// cursorTeamAccount is the added account the fixture names.
const cursorTeamAccount = "c41e0b7a"

// fakeCursorDashboard stands in for Cursor's dashboard service: each account's answers by the token it is
// asked with, an answer of 503 for any token it does not know, and every request kept. A request that is
// not the one Cursor CLI's /usage makes (§11) is kept as a violation.
type fakeCursorDashboard struct {
	*httptest.Server
	mu         sync.Mutex
	answers    map[string]map[string]fakeCursorAnswer // token → method → answer
	asked      []string                               // "<method> <token>", in order
	violations []string
}

type fakeCursorAnswer struct {
	status int
	body   string
}

func newFakeCursorDashboard(t *testing.T) *fakeCursorDashboard {
	t.Helper()
	d := &fakeCursorDashboard{answers: map[string]map[string]fakeCursorAnswer{}}
	d.Server = httptest.NewServer(http.HandlerFunc(d.serve))
	t.Cleanup(d.Close)
	previous := cursorDashboardURL
	cursorDashboardURL = d.URL + "/aiserver.v1.DashboardService/"
	t.Cleanup(func() { cursorDashboardURL = previous })
	t.Cleanup(func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		for _, v := range d.violations {
			t.Errorf("fake Cursor dashboard: %s", v)
		}
	})
	return d
}

// answer has token's method answered status with body.
func (d *fakeCursorDashboard) answer(token, method string, status int, body string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.answers[token] == nil {
		d.answers[token] = map[string]fakeCursorAnswer{}
	}
	d.answers[token][method] = fakeCursorAnswer{status: status, body: body}
}

// account has token answered with the two bodies, each 200.
func (d *fakeCursorDashboard) account(token string, period, plan json.RawMessage) {
	d.answer(token, "GetCurrentPeriodUsage", http.StatusOK, string(period))
	d.answer(token, "GetPlanInfo", http.StatusOK, string(plan))
}

func (d *fakeCursorDashboard) requests() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.asked...)
}

func (d *fakeCursorDashboard) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	method := strings.TrimPrefix(r.URL.Path, "/aiserver.v1.DashboardService/")
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	d.mu.Lock()
	d.asked = append(d.asked, method+" "+token)
	for name, want := range map[string]string{"Content-Type": "application/json", "Connect-Protocol-Version": "1", "X-Cursor-Client-Type": "cli"} {
		if got := r.Header.Get(name); got != want {
			d.violations = append(d.violations, fmt.Sprintf("%s %s: %s = %q, want %q", r.Method, r.URL.Path, name, got, want))
		}
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/aiserver.v1.DashboardService/") || string(body) != "{}" || token == "" {
		d.violations = append(d.violations, fmt.Sprintf("%s %s with %q and Authorization %q: not a dashboard read", r.Method, r.URL.Path, body, r.Header.Get("Authorization")))
	}
	answer, ok := d.answers[token][method]
	d.mu.Unlock()
	if !ok {
		answer = fakeCursorAnswer{status: http.StatusServiceUnavailable, body: `{"code":"unavailable"}`}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(answer.status)
	_, _ = w.Write([]byte(answer.body))
}

// cursorUsageRunner is a runner user of the test's own that keeps Cursor CLI accounts, with Default signed
// in on defaultToken and the fixture's added account, cursorTeamAccount, on teamToken.
func cursorUsageRunner(t *testing.T, defaultToken, teamToken string) string {
	t.Helper()
	useCursorRealHome(t)
	useCursorPlatform(t, "linux", "amd64")
	signInCursorDefault(t, defaultToken)
	root, err := accountSlotsDir(cursorAccountKind)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(root); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, cursorTeamAccount)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta, _ := json.Marshal(accountSlotMeta{Name: "Team", CreatedAt: time.Now().UTC()})
	if err := os.WriteFile(accountSlotMetaPath(root, cursorTeamAccount), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	signInCursorAccount(t, dir, teamToken)
	return dir
}

// readCursorProbe makes one pass of probe, storing what it read; the error is the pass's.
func readCursorProbe(probe *planUsageProbe) error {
	usage, err := probe.fetch(context.Background(), probe.client)
	if err == nil {
		probe.store(usage)
	}
	return err
}

// recordedCursorDashboard is what Cursor's dashboard answered the P0 probes (docs/evidence/cursor-cli):
// the Free plan as P0a read it, and the paid plan (Premium) as P0c did.
func recordedCursorDashboard(t *testing.T) (free, premium map[string]json.RawMessage) {
	t.Helper()
	read := func(file string) map[string]json.RawMessage {
		b, err := os.ReadFile(filepath.Join("..", "..", "docs", "evidence", "cursor-cli", "2026.10.14-941492e", file))
		if err != nil {
			t.Fatal(err)
		}
		var scenario struct {
			Detail map[string]map[string]struct {
				Body json.RawMessage `json:"body"`
			} `json:"detail"`
		}
		if err := json.Unmarshal(b, &scenario); err != nil {
			t.Fatal(err)
		}
		rpcs := scenario.Detail["dashboard RPCs (identity fields reduced to their names)"]
		return map[string]json.RawMessage{"GetCurrentPeriodUsage": rpcs["GetCurrentPeriodUsage"].Body, "GetPlanInfo": rpcs["GetPlanInfo"].Body}
	}
	return read("scenarios/usage-api.json"), read("p0c/scenarios/usage-api.json")
}

// Each account is read from Cursor's dashboard with its own sign-in, as the CLI's /usage reads it (§11):
// GetCurrentPeriodUsage and GetPlanInfo, POSTed with an empty body over Connect's JSON protocol. Free as
// P0a recorded it: its plan and billing month, and no share used — Cursor's 0% is no reading. Premium as
// P0c recorded it, with a share used: a weekly period whose reset is the plan's includedUsageResetsAt.
func TestCursorUsageReadsEachAccountFromTheDashboard(t *testing.T) {
	cursorUsageRunner(t, "token-default", "token-team")
	free, premium := recordedCursorDashboard(t)
	d := newFakeCursorDashboard(t)
	d.account("token-default", free["GetCurrentPeriodUsage"], free["GetPlanInfo"])
	var period map[string]any
	if err := json.Unmarshal(premium["GetCurrentPeriodUsage"], &period); err != nil {
		t.Fatal(err)
	}
	planUsage, _ := period["planUsage"].(map[string]any)
	if planUsage == nil || planUsage["totalPercentUsed"] != float64(0) {
		t.Fatalf("the recorded Premium reading = %s", premium["GetCurrentPeriodUsage"])
	}
	planUsage["totalPercentUsed"] = 34
	used, _ := json.Marshal(period)
	d.account("token-team", used, premium["GetPlanInfo"])

	usage := newCursorAccountUsage()
	usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {})
	if err := readCursorProbe(usage.def); err != nil {
		t.Fatal(err)
	}
	if err := readCursorProbe(usage.slot(cursorTeamAccount).probe); err != nil {
		t.Fatal(err)
	}
	if got, want := d.requests(), []string{
		"GetCurrentPeriodUsage token-default", "GetPlanInfo token-default",
		"GetCurrentPeriodUsage token-team", "GetPlanInfo token-team",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %q, want each account's two reads with its own token", got)
	}
	snapshot := usage.snapshot()
	if snapshot == nil || snapshot.FetchedAt == "" || snapshot.Accounts[cursorTeamAccount] == nil || snapshot.Accounts[cursorTeamAccount].FetchedAt == "" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	def, team := *snapshot, *snapshot.Accounts[cursorTeamAccount]
	def.Accounts, def.FetchedAt, team.FetchedAt = nil, "", ""
	wantDefault := PlanUsage{Provider: providerCursor, Account: accountSlotDefaultID, PlanName: "Free", IncludedUsage: &PlanUsageIncludedUsage{
		StartsAt: "2026-09-24T16:32:26.082Z", ResetsAt: "2026-10-24T16:32:26.082Z"}}
	if !reflect.DeepEqual(def, wantDefault) {
		t.Fatalf("Default = %+v / %+v, want %+v / %+v", def, def.IncludedUsage, wantDefault, wantDefault.IncludedUsage)
	}
	wantTeam := PlanUsage{Provider: providerCursor, Account: cursorTeamAccount, PlanName: "Premium", IncludedUsage: &PlanUsageIncludedUsage{
		Period: "weekly", StartsAt: "2026-10-17T01:32:16.338Z", ResetsAt: "2026-10-24T01:32:16.338Z", PercentUsed: 34}}
	if !reflect.DeepEqual(team, wantTeam) {
		t.Fatalf("Team = %+v / %+v, want %+v / %+v", team, team.IncludedUsage, wantTeam, wantTeam.IncludedUsage)
	}
}

// For each case's dashboard answers and usage limits met — Default's and an added account's — the runner
// sends that case's planUsage (a subtest per case, by its id): Cursor CLI's snapshot nested under cursor, each naming its account,
// Default's its own and the account's under its id.
func TestCursorPlanUsageFixture(t *testing.T) {
	b, err := os.ReadFile(cursorPlanUsageFixture)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			ID             string                                `json:"id"`
			Dashboard      map[string]map[string]json.RawMessage `json:"dashboard"`
			LimitReachedAt map[string]string                     `json:"limitReachedAt"`
			PlanUsage      json.RawMessage                       `json:"planUsage"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("no cases")
	}
	tokens := map[string]string{accountSlotDefaultID: "token-default", cursorTeamAccount: "token-team"}
	for _, c := range fixture.Cases {
		t.Run(c.ID, func(t *testing.T) {
			cursorUsageRunner(t, tokens[accountSlotDefaultID], tokens[cursorTeamAccount])
			d := newFakeCursorDashboard(t)
			for id, answers := range c.Dashboard {
				d.account(tokens[id], answers["GetCurrentPeriodUsage"], answers["GetPlanInfo"])
			}
			for id, at := range c.LimitReachedAt {
				reached, err := time.Parse(time.RFC3339, at)
				if err != nil {
					t.Fatal(err)
				}
				noteCursorUsageLimit(id, reached)
			}
			usage := newCursorAccountUsage()
			usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {})
			for id, probe := range map[string]*planUsageProbe{accountSlotDefaultID: usage.def, cursorTeamAccount: usage.slot(cursorTeamAccount).probe} {
				if err := readCursorProbe(probe); (err == nil) != (c.Dashboard[id] != nil) {
					t.Fatalf("%s read: %v", id, err)
				}
			}
			wire, err := json.Marshal(combinePlanUsage(nil, nil, nil, usage.snapshot()))
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(wire, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(c.PlanUsage, &want); err != nil {
				t.Fatal(err)
			}
			if got = withoutFetchedAt(got); !reflect.DeepEqual(got, want) {
				t.Fatalf("planUsage =\n%s\nwant\n%s", wire, c.PlanUsage)
			}
		})
	}
}

// The heartbeat carries Cursor CLI's plan usage under planUsage.cursor — always nested, beside any other
// engine's — with provider cursor and the account on every snapshot: Default's as cursor's own, the added
// account's under its id. A removed account is read no more, and its usage limit met goes with it.
func TestCursorAccountUsageReportsEveryAccountUnderPlanUsageCursor(t *testing.T) {
	cursorUsageRunner(t, "token-default", "token-team")
	free, premium := recordedCursorDashboard(t)
	d := newFakeCursorDashboard(t)
	d.account("token-default", free["GetCurrentPeriodUsage"], free["GetPlanInfo"])
	d.account("token-team", premium["GetCurrentPeriodUsage"], premium["GetPlanInfo"])
	usage := newCursorAccountUsage()
	usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {})
	for _, probe := range []*planUsageProbe{usage.def, usage.slot(cursorTeamAccount).probe} {
		if err := readCursorProbe(probe); err != nil {
			t.Fatal(err)
		}
	}
	noteCursorUsageLimit(cursorTeamAccount, time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC))
	claude := &PlanUsage{Provider: providerClaude, FiveHour: &PlanUsageWindow{Utilization: 5}, FetchedAt: "2026-10-18T10:00:00Z"}

	wire, err := json.Marshal(HeartbeatRequest{PlanUsage: combinePlanUsage(claude, nil, nil, usage.snapshot())})
	if err != nil {
		t.Fatal(err)
	}
	var hb struct {
		PlanUsage struct {
			Provider string     `json:"provider"`
			Claude   *PlanUsage `json:"claude"`
			Cursor   *PlanUsage `json:"cursor"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(wire, &hb); err != nil {
		t.Fatal(err)
	}
	cursor := hb.PlanUsage.Cursor
	if hb.PlanUsage.Provider != "" || hb.PlanUsage.Claude == nil || cursor == nil {
		t.Fatalf("planUsage = %s, want Claude's and Cursor CLI's each nested", wire)
	}
	if cursor.Provider != providerCursor || cursor.Account != accountSlotDefaultID || cursor.PlanName != "Free" || cursor.FetchedAt == "" {
		t.Fatalf("Default's snapshot = %s", wire)
	}
	team := cursor.Accounts[cursorTeamAccount]
	if len(cursor.Accounts) != 1 || team == nil || team.Provider != providerCursor || team.Account != cursorTeamAccount ||
		team.IncludedUsage == nil || team.IncludedUsage.LimitReachedAt != "2026-10-18T09:00:00.000Z" || team.IncludedUsage.ResetsAt != "2026-10-24T01:32:16.338Z" {
		t.Fatalf("accounts = %s, want Team's own snapshot under its id, its usage limit met with it", wire)
	}
	if got := combinePlanUsage(nil, nil, nil, cursor); got.Cursor != cursor || got.Provider != "" {
		t.Fatalf("a lone Cursor CLI snapshot = %#v, want it under cursor", got)
	}

	if err := removeAccount(cursorAccountKind, nil, nil, nil, usage, cursorTeamAccount, nil); err != nil {
		t.Fatal(err)
	}
	if got := usage.snapshot(); got == nil || got.Accounts != nil || got.Account != accountSlotDefaultID {
		t.Fatalf("snapshot after removal = %#v, want Default's alone", got)
	}
	if _, kept := readCursorUsageLimits()[cursorTeamAccount]; kept {
		t.Fatal("the removed account's usage limit met is still kept")
	}
	usage.syncSlots(context.Background(), func(context.Context, *planUsageProbe) {
		t.Fatal("a read loop was started for a removed account")
	})
}

// What cannot be read is unavailable, never 0: an account not signed in, or whose sign-in has expired,
// is not read at all — its token is not refreshed, Cursor CLI never renews a sign-in's (§8.4) — a token
// the dashboard refused is not sent again, a failed read leaves the last full reading in place, and a field
// Cursor did not send is left out of the snapshot.
func TestCursorUsageUnavailableIsNeverZero(t *testing.T) {
	free, premium := recordedCursorDashboard(t)
	t.Run("not-signed-in", func(t *testing.T) {
		useCursorRealHome(t)
		d := newFakeCursorDashboard(t)
		usage := newCursorAccountUsage()
		if err := readCursorProbe(usage.def); err == nil || len(d.requests()) != 0 || usage.snapshot() != nil {
			t.Fatalf("read = %v, requests %q, snapshot %+v: want no read and nothing reported", err, d.requests(), usage.snapshot())
		}
	})
	t.Run("expired-sign-in", func(t *testing.T) {
		useCursorRealHome(t)
		// Within the five minutes Cursor CLI already counts as expired (§9).
		token := cursorTestToken(t, time.Now().Add(4*time.Minute))
		path := signInCursorDefault(t, token)
		before, _ := os.ReadFile(path)
		d := newFakeCursorDashboard(t)
		d.account(token, free["GetCurrentPeriodUsage"], free["GetPlanInfo"])
		usage := newCursorAccountUsage()
		err := readCursorProbe(usage.def)
		after, _ := os.ReadFile(path)
		if err == nil || !strings.Contains(err.Error(), "does not renew") || len(d.requests()) != 0 || usage.snapshot() != nil {
			t.Fatalf("read = %v, requests %q, snapshot %+v: want an expired sign-in left unread", err, d.requests(), usage.snapshot())
		}
		if !bytes.Equal(before, after) {
			t.Fatal("the saved sign-in changed: the runner wrote a token")
		}
	})
	t.Run("token-refused", func(t *testing.T) {
		useCursorRealHome(t)
		signInCursorDefault(t, "token-refused")
		d := newFakeCursorDashboard(t)
		d.answer("token-refused", "GetCurrentPeriodUsage", http.StatusUnauthorized,
			`{"code":"unauthenticated","message":"Error","details":[{"type":"aiserver.v1.ErrorDetails","debug":{"error":"ERROR_NOT_LOGGED_IN"}}]}`)
		usage := newCursorAccountUsage()
		for pass := 0; pass < 2; pass++ {
			if err := readCursorProbe(usage.def); err != errCursorTokenRefused {
				t.Fatalf("pass %d: %v", pass, err)
			}
		}
		if got := d.requests(); !reflect.DeepEqual(got, []string{"GetCurrentPeriodUsage token-refused"}) || usage.snapshot() != nil {
			t.Fatalf("requests = %q, snapshot %+v: want one request, and the refused token not sent again", got, usage.snapshot())
		}
	})
	t.Run("failed-read-keeps-the-last", func(t *testing.T) {
		useCursorRealHome(t)
		signInCursorDefault(t, "token-default")
		d := newFakeCursorDashboard(t)
		d.account("token-default", premium["GetCurrentPeriodUsage"], premium["GetPlanInfo"])
		usage := newCursorAccountUsage()
		if err := readCursorProbe(usage.def); err != nil {
			t.Fatal(err)
		}
		last := usage.snapshot()
		d.answer("token-default", "GetPlanInfo", http.StatusInternalServerError, `{"code":"internal"}`)
		if err := readCursorProbe(usage.def); err == nil || !strings.Contains(err.Error(), "GetPlanInfo -> 500") {
			t.Fatalf("read = %v, want GetPlanInfo's failure", err)
		}
		if got := usage.snapshot(); !reflect.DeepEqual(got, last) || got.PlanName != "Premium" {
			t.Fatalf("snapshot = %+v, want the last full reading, %+v", got, last)
		}
	})
	t.Run("fields-not-sent", func(t *testing.T) {
		useCursorRealHome(t)
		signInCursorDefault(t, "token-default")
		d := newFakeCursorDashboard(t)
		// No planUsage, no period and a plan that names nothing: no share, no reset, no plan — and no 0.
		d.account("token-default", json.RawMessage(`{"displayMessage":"You've used 0% of your included usage"}`), json.RawMessage(`{"planInfo":{}}`))
		usage := newCursorAccountUsage()
		if err := readCursorProbe(usage.def); err != nil {
			t.Fatal(err)
		}
		wire, _ := json.Marshal(usage.snapshot())
		var got map[string]any
		_ = json.Unmarshal(wire, &got)
		delete(got, "fetchedAt")
		if want := map[string]any{"provider": "cursor", "account": "default"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("snapshot = %s, want only its provider and account", wire)
		}
	})
	t.Run("zero-is-no-reading", func(t *testing.T) {
		usage, err := parseCursorPlanUsage(premium["GetCurrentPeriodUsage"], premium["GetPlanInfo"])
		if err != nil {
			t.Fatal(err)
		}
		wire, _ := json.Marshal(usage)
		if usage.IncludedUsage == nil || usage.IncludedUsage.PercentUsed != 0 || strings.Contains(string(wire), "percentUsed") {
			t.Fatalf("snapshot = %s, want Cursor's 0%% left out", wire)
		}
	})
}

// A session's turn that met Cursor's usage limit is kept for the account the session ran on — Default, or
// the added account it names, a key of its workspace's notwithstanding — and for nothing when the session
// runs on a key of its own. What is kept survives a restart of the runner.
func TestCursorSessionKeepsTheUsageLimitItsAccountMet(t *testing.T) {
	run := func(t *testing.T, env func(work string) map[string]string) map[string]time.Time {
		t.Helper()
		var work string
		started := time.Now()
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		// The recorded turn that met P0a's Free plan limit: "Upgrade your plan to continue" (§12).
		out := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then,
			env: map[string]string{}, agent: func(agent *AgentExecConfig) {
				useCursorPlatform(t, "linux", "amd64")
				signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
				slot, err := cursorAccountKind.create("Team")
				if err != nil {
					t.Fatal(err)
				}
				signInCursorAccount(t, slot.Dir, cursorTestToken(t, time.Now().Add(time.Hour)))
				work = slot.ID
				agent.Env = env(slot.Dir)
			}})
		if turn := out.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stFailed ||
			turn[0].Error != cursorUsageLimitText("Upgrade your plan to continue") {
			t.Fatalf("completions = %+v, want turn-1 failed on the usage limit", out.completions)
		}
		limits := readCursorUsageLimits()
		for id, at := range limits {
			if at.Before(started.Add(-time.Second)) || at.After(time.Now()) {
				t.Fatalf("%s met its limit at %v, not during the turn", id, at)
			}
		}
		if work != "" {
			if at, ok := limits[work]; ok {
				delete(limits, work)
				limits["work"] = at
			}
		}
		return limits
	}
	t.Run("on-default", func(t *testing.T) {
		limits := run(t, func(string) map[string]string { return map[string]string{} })
		if _, ok := limits[accountSlotDefaultID]; !ok || len(limits) != 1 {
			t.Fatalf("limits = %v, want Default's alone", limits)
		}
		// Kept on disk: a runner that starts again reports it.
		if got := newCursorAccountUsage().snapshot(); got == nil || got.Account != accountSlotDefaultID || got.IncludedUsage == nil || got.IncludedUsage.LimitReachedAt == "" {
			t.Fatalf("snapshot after a restart = %+v", got)
		}
	})
	t.Run("on-a-named-account", func(t *testing.T) {
		limits := run(t, func(dir string) map[string]string {
			return map[string]string{cursorAccountDirVar: dir, "CURSOR_API_KEY": "key-of-the-workspace"}
		})
		if _, ok := limits["work"]; !ok || len(limits) != 1 {
			t.Fatalf("limits = %v, want the named account's alone", limits)
		}
	})
	t.Run("on-a-key-of-its-own", func(t *testing.T) {
		limits := run(t, func(string) map[string]string { return map[string]string{"CURSOR_API_KEY": "key-of-the-workspace"} })
		if len(limits) != 0 {
			t.Fatalf("limits = %v, want none: the session spent no account of this runner's", limits)
		}
		if _, err := os.Stat(cursorUsageLimitsPath()); err == nil {
			t.Fatal("the usage limits were written for a session on a key")
		}
	})
}

// A turn the account ran ends the usage limit it met; an interrupted turn and any other failure say
// nothing of it, and a session on no account of the runner's keeps nothing.
func TestCursorTurnOnAnAccountEndsItsUsageLimit(t *testing.T) {
	useCursorRealHome(t)
	limit := TurnCompleteRequest{Status: stFailed, Error: cursorUsageLimitText("Upgrade your plan to continue")}
	noteCursorTurn(accountSlotDefaultID, limit)
	noteCursorTurn(cursorTeamAccount, limit)
	noteCursorTurn("", limit)
	for _, req := range []TurnCompleteRequest{
		{Status: stInterrupted},
		{Status: stFailed, Error: "Cursor CLI failed this turn: Error: RetriableError: [canceled] http/2 stream closed"},
		{Status: stFailed, Error: `Failed to authenticate: Cursor said: "Please sign in to continue."`},
	} {
		noteCursorTurn(accountSlotDefaultID, req)
	}
	if limits := readCursorUsageLimits(); len(limits) != 2 || limits[""] != (time.Time{}) {
		t.Fatalf("limits = %v, want Default's and Team's", limits)
	}
	noteCursorTurn(accountSlotDefaultID, TurnCompleteRequest{Status: stSucceeded})
	if limits := readCursorUsageLimits(); len(limits) != 1 || limits[cursorTeamAccount].IsZero() {
		t.Fatalf("limits = %v, want Team's alone", limits)
	}
}

// A Cursor CLI account is read again shortly after its included usage resets.
func TestPlanUsageRefreshDueAfterACursorPeriodEnds(t *testing.T) {
	now := time.Date(2026, 10, 24, 1, 0, 0, 0, time.UTC)
	usage := combinePlanUsage(nil, nil, nil, &PlanUsage{Provider: providerCursor, Account: accountSlotDefaultID,
		IncludedUsage: &PlanUsageIncludedUsage{Period: "weekly", ResetsAt: "2026-10-24T01:32:16.338Z"}})
	if reset, ok := nextPlanUsageResetAfter(usage, now); !ok || !reset.Equal(time.Date(2026, 10, 24, 1, 32, 16, 338e6, time.UTC)) {
		t.Fatalf("next reset = %v, %v", reset, ok)
	}
	if !planUsageRefreshDue(now, usage, now.Add(33*time.Minute), 10*time.Hour) {
		t.Fatal("not read again after the week reset")
	}
}
