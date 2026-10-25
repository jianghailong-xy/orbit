package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeKimiCLIEnv starts this test binary as a Kimi Code process asked for a fresh token (TestMain).
const fakeKimiCLIEnv = "ORBIT_TEST_FAKE_KIMI_CLI"

// properLockfile is proper-lockfile 4.1.2's lock() as Kimi Code calls it — stale 5000, update stale/2,
// retries 120 × 500 ms, realpath false — ported from lib/lockfile.js to stand in for a Kimi Code
// process: the library's algorithm, written apart from the runner's own (kimi_refresh_lock.go). mkdir;
// on EEXIST a stat, and a lock stale by its mtime removed and tried once more; on acquiring, the
// mtime-precision probe (set to the next whole second + 5 ms); every stale/2 the mtime checked to be
// the one last set (else compromised) and set again; rmdir on release.
type properLockfile struct {
	lockfilePath string
	mu           sync.Mutex
	mtime        time.Time
	lastUpdate   time.Time
	released     bool
	timer        *time.Timer
	// onCompromised is proper-lockfile's, which Kimi Code leaves at its default: throw.
	onCompromised func()
}

const (
	properLockfileStale  = 5000 * time.Millisecond
	properLockfileUpdate = properLockfileStale / 2
)

var errProperLockfileHeld = errors.New("ELOCKED: Lock file is already being held")

func properLockfileLock(file string, onCompromised func()) (*properLockfile, error) {
	lockfilePath := file + ".lock"
	var err error
	for attempt := 0; attempt <= 120; attempt++ {
		if attempt > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		var mtime time.Time
		if mtime, err = properLockfileAcquire(lockfilePath, properLockfileStale); err == nil {
			l := &properLockfile{lockfilePath: lockfilePath, mtime: mtime, lastUpdate: time.Now(), onCompromised: onCompromised}
			l.mu.Lock()
			l.timer = time.AfterFunc(properLockfileUpdate, l.update)
			l.mu.Unlock()
			return l, nil
		}
	}
	return nil, err
}

func properLockfileAcquire(lockfilePath string, stale time.Duration) (time.Time, error) {
	err := os.Mkdir(lockfilePath, 0o777)
	if err == nil {
		probe := time.UnixMilli((time.Now().UnixMilli()+999)/1000*1000 + 5)
		if err := os.Chtimes(lockfilePath, probe, probe); err != nil {
			_ = os.Remove(lockfilePath)
			return time.Time{}, err
		}
		info, err := os.Stat(lockfilePath)
		if err != nil {
			_ = os.Remove(lockfilePath)
			return time.Time{}, err
		}
		return info.ModTime(), nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return time.Time{}, err
	}
	if stale <= 0 {
		return time.Time{}, errProperLockfileHeld
	}
	info, err := os.Stat(lockfilePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return properLockfileAcquire(lockfilePath, 0)
		}
		return time.Time{}, err
	}
	if info.ModTime().UnixMilli() >= time.Now().Add(-stale).UnixMilli() {
		return time.Time{}, errProperLockfileHeld
	}
	if err := os.Remove(lockfilePath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return time.Time{}, err
	}
	return properLockfileAcquire(lockfilePath, 0)
}

func (l *properLockfile) update() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return
	}
	overThreshold := func() bool { return l.lastUpdate.Add(properLockfileStale).Before(time.Now()) }
	info, err := os.Stat(l.lockfilePath)
	if err == nil && info.ModTime().UnixMilli() != l.mtime.UnixMilli() {
		l.compromised()
		return
	}
	if err == nil {
		mtime := time.UnixMilli(time.Now().UnixMilli())
		if err = os.Chtimes(l.lockfilePath, mtime, mtime); err == nil {
			l.mtime, l.lastUpdate = mtime, time.Now()
			l.timer = time.AfterFunc(properLockfileUpdate, l.update)
			return
		}
	}
	if errors.Is(err, fs.ErrNotExist) || overThreshold() {
		l.compromised()
		return
	}
	l.timer = time.AfterFunc(time.Second, l.update)
}

// compromised is called with l.mu held.
func (l *properLockfile) compromised() {
	l.released = true
	l.onCompromised()
}

func (l *properLockfile) release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return
	}
	l.released = true
	l.timer.Stop()
	_ = os.Remove(l.lockfilePath)
}

// runFakeKimiCLI is a Kimi Code process asked for a fresh token: what OAuthManager.doEnsureFresh does
// (2.1.1) with the stored token due by the CLI's own threshold — take the lock on
// <home>/oauth/<storage> as acquireRefreshLock does, say LOCKED, hold it for FAKE_KIMI_CLI_HOLD,
// re-read the stored token and refresh only if it is still due, storing the new pair whole. Its last
// line says what it did: OUTCOME fresh | reused | refreshed | refused | compromised.
func runFakeKimiCLI() int {
	home, storage, oauthHost := os.Getenv("FAKE_KIMI_CLI_HOME"), os.Getenv("FAKE_KIMI_CLI_STORAGE"), os.Getenv("FAKE_KIMI_CLI_OAUTH_HOST")
	hold, _ := time.ParseDuration(os.Getenv("FAKE_KIMI_CLI_HOLD"))
	tokenPath := filepath.Join(home, "credentials", storage+".json")
	stored := func() (map[string]any, bool) {
		var token map[string]any
		b, _ := os.ReadFile(tokenPath)
		_ = json.Unmarshal(b, &token)
		expiresAt, _ := token["expires_at"].(float64)
		expiresIn, _ := token["expires_in"].(float64)
		return token, expiresAt != 0 && expiresAt-float64(time.Now().Unix()) < math.Max(300, expiresIn*0.5)
	}
	if _, due := stored(); !due {
		fmt.Println("OUTCOME fresh")
		return 0
	}
	target := filepath.Join(home, "oauth", storage)
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		fmt.Println("OUTCOME error", err)
		return 1
	}
	if f, err := os.OpenFile(target, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o666); err == nil {
		_ = f.Close()
	}
	lock, err := properLockfileLock(target, func() {
		fmt.Println("OUTCOME compromised")
		os.Exit(3)
	})
	if err != nil {
		fmt.Println("OUTCOME error", err)
		return 1
	}
	defer lock.release()
	fmt.Println("LOCKED")
	time.Sleep(hold)
	token, due := stored()
	if !due {
		fmt.Println("OUTCOME reused", token["access_token"])
		return 0
	}
	refresh, _ := token["refresh_token"].(string)
	form := url.Values{"client_id": {kimiOAuthClientID}, "grant_type": {"refresh_token"}, "refresh_token": {refresh}}
	req, _ := http.NewRequest(http.MethodPost, oauthHost+"/api/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("User-Agent", "kimi-code-cli/fake-cli")
	req.Header.Set("X-Msh-Platform", "kimi_code_cli")
	req.Header.Set("X-Msh-Version", "fake-cli")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Println("OUTCOME error", err)
		return 1
	}
	defer resp.Body.Close()
	var data map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&data)
	if resp.StatusCode != http.StatusOK {
		fmt.Println("OUTCOME refused", resp.StatusCode)
		return 1
	}
	expiresIn, _ := data["expires_in"].(float64)
	body := fmt.Sprintf("{\n  \"access_token\": %q,\n  \"refresh_token\": %q,\n  \"expires_at\": %d,\n  \"scope\": \"kimi-code\",\n  \"token_type\": \"Bearer\",\n  \"expires_in\": %d\n}\n",
		data["access_token"], data["refresh_token"], time.Now().Unix()+int64(expiresIn), int64(expiresIn))
	tmp := fmt.Sprintf("%s.tmp.%d.fake", tokenPath, os.Getpid())
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		fmt.Println("OUTCOME error", err)
		return 1
	}
	if err := os.Rename(tmp, tokenPath); err != nil {
		fmt.Println("OUTCOME error", err)
		return 1
	}
	fmt.Println("OUTCOME refreshed", data["access_token"])
	return 0
}

// fakeKimiCLI is one fakeKimiCLI process: its LOCKED line, if it got that far, and its outcome.
type fakeKimiCLI struct {
	cmd     *exec.Cmd
	locked  chan struct{}
	outcome chan string
}

func startFakeKimiCLI(t *testing.T, login kimiLogin, hold time.Duration) *fakeKimiCLI {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(),
		fakeKimiCLIEnv+"=1",
		"FAKE_KIMI_CLI_HOME="+login.home,
		"FAKE_KIMI_CLI_STORAGE="+login.storage,
		"FAKE_KIMI_CLI_OAUTH_HOST="+login.oauthHost,
		"FAKE_KIMI_CLI_HOLD="+hold.String(),
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &fakeKimiCLI{cmd: cmd, locked: make(chan struct{}), outcome: make(chan string, 1)}
	go func() {
		scanner := bufio.NewScanner(stdout)
		last := ""
		for scanner.Scan() {
			switch line := scanner.Text(); {
			case line == "LOCKED":
				close(p.locked)
			case strings.HasPrefix(line, "OUTCOME "):
				last = strings.TrimPrefix(line, "OUTCOME ")
			}
		}
		_ = cmd.Wait()
		p.outcome <- last
	}()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	return p
}

func (p *fakeKimiCLI) waitLocked(t *testing.T) {
	t.Helper()
	select {
	case <-p.locked:
	case <-time.After(30 * time.Second):
		t.Fatal("the Kimi Code process never took the lock")
	}
}

func (p *fakeKimiCLI) wait(t *testing.T) string {
	t.Helper()
	select {
	case outcome := <-p.outcome:
		return outcome
	case <-time.After(90 * time.Second):
		t.Fatal("the Kimi Code process never finished")
		return ""
	}
}

// expireFakeKimiToken leaves the token the service last issued stored as expired — the token every
// idle machine has — so the next one asked has to refresh it.
func expireFakeKimiToken(t *testing.T, svc *fakeKimiService, login kimiLogin) {
	t.Helper()
	b, err := os.ReadFile(login.tokenPath())
	if err != nil {
		t.Fatal(err)
	}
	var token kimiStoredToken
	if err := json.Unmarshal(b, &token); err != nil {
		t.Fatal(err)
	}
	if token.RefreshToken != svc.currentRefreshToken() {
		t.Fatalf("stored refresh token %q is not the one the service takes (%q): it was lost", token.RefreshToken, svc.currentRefreshToken())
	}
	storeFakeKimiToken(t, login, token.AccessToken, token.RefreshToken, time.Now().Add(-time.Hour).Unix())
	svc.mu.Lock()
	svc.accessTokens[token.AccessToken] = false
	svc.mu.Unlock()
}

// kimiReadResult is one runner read run beside a Kimi Code process, and the refreshes it asked for.
type kimiReadResult struct {
	usage     *PlanUsage
	err       error
	refreshes int32
}

func startKimiRead(svc *fakeKimiService, home string) <-chan kimiReadResult {
	done := make(chan kimiReadResult, 1)
	go func() {
		var posts atomic.Int32
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method == http.MethodPost {
				posts.Add(1)
			}
			return http.DefaultTransport.RoundTrip(r)
		})}
		usage, err := (&kimiUsageRead{}).fetch(context.Background(), client, home)
		done <- kimiReadResult{usage: usage, err: err, refreshes: posts.Load()}
	}()
	return done
}

func waitKimiRead(t *testing.T, done <-chan kimiReadResult) kimiReadResult {
	t.Helper()
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("runner read: %v", r.err)
		}
		return r
	case <-time.After(90 * time.Second):
		t.Fatal("the runner's read never finished")
		return kimiReadResult{}
	}
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never appeared", path)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newKimiLockRace(t *testing.T) (*fakeKimiService, kimiLogin) {
	t.Helper()
	installFakeKimiVersion(t, "2.1.1-orbit-test")
	svc := newFakeKimiService(t)
	svc.usagesBody = `{"usages":{"limit_5h":{"used_ratio":0.42,"reset_time":"2026-10-08T17:00:00Z"}}}`
	home := t.TempDir()
	return svc, signInFakeKimi(t, home, svc, "at-0", "rt-0", time.Now().Add(-time.Hour).Unix())
}

// A Kimi Code process holds the lock — longer than the five seconds that would make a lock nobody keeps
// fresh abandoned — and refreshes inside it. The runner's read waits it out, finds the CLI's new token
// stored, and reads with it: one refresh, the CLI's, and the refresh token it stored still the good one.
func TestKimiRefreshWaitsForAKimiCLIHoldingTheLock(t *testing.T) {
	svc, login := newKimiLockRace(t)
	cli := startFakeKimiCLI(t, login, 6*time.Second)
	cli.waitLocked(t)
	read := waitKimiRead(t, startKimiRead(svc, login.home))

	if outcome := cli.wait(t); outcome != "refreshed at-1" {
		t.Fatalf("Kimi Code process: %q, want it to have refreshed", outcome)
	}
	granted := svc.granted()
	if read.refreshes != 0 || len(granted) != 1 || granted[0].Get("X-Msh-Version") != "fake-cli" {
		t.Fatalf("runner refreshes = %d, granted = %d — want the CLI's one refresh only", read.refreshes, len(granted))
	}
	if auth := svc.usages(); len(auth) != 1 || auth[0] != "Bearer at-1" || read.usage.FiveHour.Utilization != 42 {
		t.Fatalf("usages read with %q, reading %#v — want the CLI's new token", auth, read.usage)
	}
	expireFakeKimiToken(t, svc, login) // the stored refresh token is the good one
}

// The runner holds the lock across a refresh slower than the five seconds that make a lock abandoned,
// so it has to keep the lock fresh all along: a Kimi Code process that starts meanwhile waits, finds
// the runner's new token stored and refreshes nothing.
func TestKimiRefreshKeepsItsLockFreshForAKimiCLIWaitingOnIt(t *testing.T) {
	svc, login := newKimiLockRace(t)
	svc.refreshDelay = 7 * time.Second
	done := startKimiRead(svc, login.home)
	waitForPath(t, kimiRefreshLockDir(login.home, login.storage))
	cli := startFakeKimiCLI(t, login, 0)

	read := waitKimiRead(t, done)
	if outcome := cli.wait(t); outcome != "reused at-1" {
		t.Fatalf("Kimi Code process: %q, want it to have used the runner's token", outcome)
	}
	granted := svc.granted()
	if read.refreshes != 1 || len(granted) != 1 || granted[0].Get("X-Msh-Version") != "2.1.1-orbit-test" {
		t.Fatalf("runner refreshes = %d, granted = %d — want the runner's one refresh only", read.refreshes, len(granted))
	}
	expireFakeKimiToken(t, svc, login)
}

// Both asked at once, round after round, in either order: one refresh a round, never two in flight,
// never a spent refresh token sent, and the one stored at the end of each round the good one.
func TestKimiRefreshRacesAKimiCLIProcess(t *testing.T) {
	svc, login := newKimiLockRace(t)
	svc.refreshDelay = 300 * time.Millisecond
	for round := 0; round < 8; round++ {
		if round > 0 {
			expireFakeKimiToken(t, svc, login)
		}
		before := len(svc.granted())
		// Either first, the other after an offset that grows round by round: the CLI process needs a
		// moment to start, so it takes the lock first only once it is given one.
		offset := time.Duration(round/2) * 200 * time.Millisecond
		var cli *fakeKimiCLI
		var done <-chan kimiReadResult
		if round%2 == 0 {
			cli = startFakeKimiCLI(t, login, 0)
			time.Sleep(offset)
			done = startKimiRead(svc, login.home)
		} else {
			done = startKimiRead(svc, login.home)
			time.Sleep(offset)
			cli = startFakeKimiCLI(t, login, 0)
		}
		read := waitKimiRead(t, done)
		outcome := cli.wait(t)
		granted := svc.granted()[before:]
		if len(granted) != 1 {
			t.Fatalf("round %d: %d refreshes (runner %d, CLI %q), want exactly one", round, len(granted), read.refreshes, outcome)
		}
		if strings.HasPrefix(outcome, "refreshed") == (read.refreshes == 1) {
			t.Fatalf("round %d: runner refreshed %d times and the CLI %q — want exactly one of them", round, read.refreshes, outcome)
		}
		if read.usage.FiveHour == nil {
			t.Fatalf("round %d: runner read nothing", round)
		}
		t.Logf("round %d: refreshed by %s; CLI %q", round, granted[0].Get("X-Msh-Version"), outcome)
	}
	expireFakeKimiToken(t, svc, login)
}

// A Kimi Code process killed while it holds the lock leaves it behind, its mtime frozen: after five
// seconds the lock is abandoned, and the runner takes it over and refreshes — the refresh token the
// killed process never spent.
func TestKimiRefreshTakesOverALockAKilledKimiCLILeft(t *testing.T) {
	svc, login := newKimiLockRace(t)
	cli := startFakeKimiCLI(t, login, time.Hour)
	cli.waitLocked(t)
	if err := cli.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cli.wait(t)
	lockDir := kimiRefreshLockDir(login.home, login.storage)
	if _, err := os.Stat(lockDir); err != nil {
		t.Fatalf("the killed process's lock is gone already: %v", err)
	}
	start := time.Now()
	read := waitKimiRead(t, startKimiRead(svc, login.home))
	if waited := time.Since(start); waited < 2*time.Second || waited > 15*time.Second {
		t.Fatalf("took the abandoned lock after %v, want once it was five seconds stale", waited)
	}
	if read.refreshes != 1 || len(svc.granted()) != 1 {
		t.Fatalf("runner refreshes = %d, want one", read.refreshes)
	}
	expireFakeKimiToken(t, svc, login)
}

// The lock in-process: kept fresh while held, given back on release, waited for while another holds
// it (until ctx ends), and left alone once lost to a process that took it as abandoned.
func TestKimiRefreshLockProtocol(t *testing.T) {
	home := t.TempDir()
	lockDir := kimiRefreshLockDir(home, "kimi-code")

	lock, err := acquireKimiRefreshLock(context.Background(), home, "kimi-code")
	if err != nil {
		t.Fatal(err)
	}
	first, err := os.Stat(lockDir)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "a held lock's mtime kept fresh", func() bool {
		again, err := os.Stat(lockDir)
		return err == nil && again.ModTime().After(first.ModTime()) && lock.held()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	if _, err := acquireKimiRefreshLock(ctx, home, "kimi-code"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second acquire while held = %v, want it to wait until ctx ends", err)
	}
	cancel()
	lock.release()
	if _, err := os.Stat(lockDir); !os.IsNotExist(err) {
		t.Fatalf("release left the lock: %v", err)
	}

	// Abandoned: an mtime more than five seconds old is taken over at once.
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * time.Second)
	if err := os.Chtimes(lockDir, old, old); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	lock, err = acquireKimiRefreshLock(context.Background(), home, "kimi-code")
	if err != nil || time.Since(start) > 3*time.Second {
		t.Fatalf("abandoned lock taken = %v after %v, want at once", err, time.Since(start))
	}

	// Lost: someone took it over (its mtime is no longer ours). Release must not remove theirs.
	if err := os.Remove(lockDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	theirs := time.Now().Add(time.Minute)
	if err := os.Chtimes(lockDir, theirs, theirs); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a lock taken over read as lost", func() bool { return !lock.held() })
	lock.release()
	if info, err := os.Stat(lockDir); err != nil || info.ModTime().Unix() != theirs.Unix() {
		t.Fatalf("release touched a lock it had lost: %v", err)
	}

	// A home that is gone is not made again to be locked in.
	gone := filepath.Join(t.TempDir(), "removed-account")
	if _, err := acquireKimiRefreshLock(context.Background(), gone, "kimi-code"); err == nil {
		t.Fatal("locked inside a home that does not exist")
	}
	if _, err := os.Stat(gone); !os.IsNotExist(err) {
		t.Fatal("a removed home was made again")
	}
}

// eventually waits up to ten seconds for cond.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
