package main

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// kimiCLIRefreshHeaders are the headers Kimi Code sends with a token request: its device headers
// (createKimiDefaultHeaders) and the form's own. What a client library adds besides is not the CLI's.
var kimiCLIRefreshHeaders = []string{
	"User-Agent", "X-Msh-Platform", "X-Msh-Version", "X-Msh-Device-Name", "X-Msh-Device-Model",
	"X-Msh-Os-Version", "X-Msh-Device-Id", "Content-Type", "Accept",
}

// TestKimiRefreshRacesTheRealKimiCLI is the runner's refresh against Kimi Code itself — its own
// OAuthManager and proper-lockfile — on a home signed in on a fake site: first each alone, whose
// refresh requests must be the same; then both at once, round after round, either first. Every round
// takes exactly one refresh, made under the lock, and the CLI's turn goes out with the token whoever
// refreshed stored. Opt-in (ORBIT_TEST_REAL_KIMI_CLI=1): it runs the real `kimi` on PATH, seconds a
// round.
func TestKimiRefreshRacesTheRealKimiCLI(t *testing.T) {
	if os.Getenv("ORBIT_TEST_REAL_KIMI_CLI") != "1" {
		t.Skip("set ORBIT_TEST_REAL_KIMI_CLI=1 to race the real kimi CLI")
	}
	kimiBin, err := exec.LookPath(providerKimi)
	if err != nil {
		t.Skip("no kimi on PATH")
	}
	t.Logf("kimi %s at %s", engineVersion(kimiBin), kimiBin)
	t.Setenv("KIMI_DISABLE_OAUTH_LOCK", "")
	svc := newFakeKimiService(t)
	svc.refreshDelay = 1500 * time.Millisecond
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.42,"reset_time":"2026-10-08T17:00:00Z"}}}`
	cliHome := t.TempDir()
	login := signInFakeKimi(t, filepath.Join(cliHome, "kimi-home"), svc, "at-0", "rt-0", time.Now().Add(-time.Hour).Unix())
	runCLI := func(after time.Duration) <-chan error {
		done := make(chan error, 1)
		go func() {
			time.Sleep(after)
			cmd := exec.Command(kimiBin, "-p", "hi", "--output-format", "stream-json")
			cmd.Dir = cliHome
			// A HOME and KIMI_CODE_HOME of its own, and nothing but the fake site reachable.
			cmd.Env = append(os.Environ(), "HOME="+cliHome, "KIMI_CODE_HOME="+login.home,
				"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost")
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			done <- cmd.Run() // exits 1 on the turn the fake site refuses, once its token is ready
		}()
		return done
	}
	waitCLI := func(done <-chan error) {
		select {
		case <-done:
		case <-time.After(90 * time.Second):
			t.Fatal("kimi never finished")
		}
	}

	// Alone, each refreshes the same way: the CLI's refresh request is the runner's.
	waitCLI(runCLI(0))
	expireFakeKimiToken(t, svc, login)
	if read := waitKimiRead(t, startKimiRead(svc, login.home)); read.refreshes != 1 {
		t.Fatalf("runner alone refreshed %d times, want once", read.refreshes)
	}
	granted := svc.granted()
	if len(granted) != 2 {
		t.Fatalf("%d refreshes, want the CLI's and the runner's", len(granted))
	}
	for _, name := range kimiCLIRefreshHeaders {
		if cli, runner := granted[0].Get(name), granted[1].Get(name); cli != runner || cli == "" {
			t.Errorf("%s: kimi sent %q, the runner %q", name, cli, runner)
		}
	}

	for round := 0; round < 6; round++ {
		expireFakeKimiToken(t, svc, login)
		before := len(svc.granted())
		// kimi takes a second or two to reach its refresh; the runner, started after it by up to that
		// much or before it, sometimes gets there first and sometimes not.
		offset := time.Duration(round/2) * 700 * time.Millisecond
		var cli <-chan error
		var done <-chan kimiReadResult
		if round%2 == 0 {
			cli = runCLI(0)
			time.Sleep(offset)
			done = startKimiRead(svc, login.home)
		} else {
			done = startKimiRead(svc, login.home)
			cli = runCLI(offset)
		}
		read := waitKimiRead(t, done)
		waitCLI(cli)
		if n := len(svc.granted()) - before; n != 1 {
			t.Fatalf("round %d: %d refreshes (runner %d), want exactly one", round, n, read.refreshes)
		}
		who := "kimi"
		if read.refreshes == 1 {
			who = "the runner"
		}
		auth := svc.usages()
		t.Logf("round %d: one refresh, by %s; the runner read %v%% with %s", round, who, read.usage.FiveHour.Utilization, auth[len(auth)-1])
	}
	expireFakeKimiToken(t, svc, login)
}

// TestRealKimiDefaultPlanUsageHeartbeat reads this machine's own Kimi Code login — Default, its token
// refreshed under Kimi's lock if it is near expiry — and sends the heartbeat the runner sends, to a
// stand-in for the control plane on this machine. It logs the windows that heartbeat carried, and
// nothing a sign-in could be made of. Opt-in (ORBIT_TEST_REAL_KIMI_USAGE=1): it reads, and may refresh,
// a real account.
func TestRealKimiDefaultPlanUsageHeartbeat(t *testing.T) {
	if os.Getenv("ORBIT_TEST_REAL_KIMI_USAGE") != "1" {
		t.Skip("set ORBIT_TEST_REAL_KIMI_USAGE=1 to read this machine's own Kimi Code login")
	}
	home, err := kimiAccountKind.home(accountSlotDefaultID)
	if err != nil {
		t.Fatal(err)
	}
	login, err := readKimiLogin(home)
	if err != nil {
		t.Fatal(err)
	}
	before, err := loadKimiToken(login)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Default %s: site %s, its token expiring in %ds", home, kimiRegionOfURL(login.oauthHost), int64(before.ExpiresAt)-time.Now().Unix())

	usage := newKimiAccountUsage()
	readKimiProbe(t, usage.def)
	after, err := loadKimiToken(login)
	if err != nil {
		t.Fatal(err)
	}
	refreshed := after.AccessToken != before.AccessToken
	t.Logf("refreshed under Kimi Code's lock: %v; the stored token now expires in %ds", refreshed, int64(after.ExpiresAt)-time.Now().Unix())
	if _, err := os.Stat(kimiRefreshLockDir(home, login.storage)); !os.IsNotExist(err) {
		t.Fatalf("the refresh lock was left behind: %v", err)
	}

	var body []byte
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/runner/heartbeat" {
			body, _ = io.ReadAll(r.Body)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer cp.Close()
	if _, err := NewTransport(cp.URL, "orbit-test").heartbeat(HeartbeatRequest{
		Status: "ONLINE", Version: version, PlanUsage: combinePlanUsage(nil, nil, usage.snapshot()),
	}); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{before.AccessToken, before.RefreshToken, after.AccessToken, after.RefreshToken} {
		if secret != "" && strings.Contains(string(body), secret) {
			t.Fatal("the heartbeat carried a token")
		}
	}
	var hb struct {
		PlanUsage struct {
			Kimi *PlanUsage `json:"kimi"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(body, &hb); err != nil {
		t.Fatal(err)
	}
	kimi := hb.PlanUsage.Kimi
	if kimi == nil || kimi.Provider != providerKimi {
		t.Fatalf("the heartbeat carried no planUsage.kimi")
	}
	t.Logf("planUsage.kimi.fetchedAt: %s", kimi.FetchedAt)

	// What Kimi itself answers now, with the token the runner left stored — read once more, and
	// without the runner's code: the heartbeat must carry each limit Kimi reported, as
	// used_ratio × 100 and reset_time, and no window for a limit it did not.
	req, err := http.NewRequest(http.MethodGet, login.baseURL+"/usages", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+after.AccessToken)
	req.Header.Set("User-Agent", "orbit-runner/"+version)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw struct {
		Usages map[string]struct {
			UsedRatio *float64 `json:"used_ratio"`
			ResetTime string   `json:"reset_time"`
		} `json:"usages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Kimi's own answer: %d, %v", resp.StatusCode, err)
	}
	reported := 0
	for _, w := range []struct {
		limit, name string
		w           *PlanUsageWindow
	}{{"limit_5h", "fiveHour", kimi.FiveHour}, {"limit_7d", "sevenDay", kimi.SevenDay}, {"limit_month_total", "month", kimi.Month}, {"limit_month_code", "monthCode", kimi.MonthCode}} {
		entry, sent := raw.Usages[w.limit]
		if !sent || entry.UsedRatio == nil {
			if w.w != nil {
				t.Fatalf("planUsage.kimi.%s reported, but Kimi sent no %s", w.name, w.limit)
			}
			t.Logf("planUsage.kimi.%s: not reported — Kimi sent no %s for this account", w.name, w.limit)
			continue
		}
		// Kimi works a rolling window's reset_time out from the moment it answers, so two answers a
		// second apart can differ by that second.
		resetAt, err := time.Parse(time.RFC3339Nano, entry.ResetTime)
		if err != nil {
			t.Fatalf("Kimi's %s reset_time %q: %v", w.limit, entry.ResetTime, err)
		}
		if w.w == nil || math.Abs(w.w.Utilization-*entry.UsedRatio*100) > 1e-6 || !kimiResetNear(w.w.ResetsAt, resetAt) {
			t.Fatalf("planUsage.kimi.%s = %#v, Kimi sent %s used_ratio %v reset_time %s", w.name, w.w, w.limit, *entry.UsedRatio, entry.ResetTime)
		}
		reported++
		t.Logf("planUsage.kimi.%s: %v%% used, resets %s (Kimi's %s)", w.name, w.w.Utilization, w.w.ResetsAt, w.limit)
	}
	if kimi.FiveHour == nil || (kimi.Month == nil && kimi.MonthCode == nil) {
		t.Fatal("the heartbeat lacks a 5-hour or a monthly reading")
	}

	// The token now stored reads again as it is, with no second refresh.
	if _, err := (&kimiUsageRead{}).fetch(context.Background(), &http.Client{}, home); err != nil {
		t.Fatalf("second read with the stored token: %v", err)
	}
	if latest, _ := loadKimiToken(login); latest.AccessToken != after.AccessToken {
		t.Fatal("a second read right after refreshed again")
	}
	t.Logf("%d windows, each as Kimi reported it; a second read used the stored token without refreshing", reported)
}

// kimiResetNear is a reported reset within a few seconds of the one Kimi sent.
func kimiResetNear(reported string, sent time.Time) bool {
	at, err := time.Parse(time.RFC3339Nano, reported)
	return err == nil && at.Sub(sent).Abs() <= 5*time.Second
}
