package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Plan usage shows the runner's default Codex account as the windows its usage probe reads and, beside
// them, that account's reset credits. A running session refreshes those windows between reads with its
// account/rateLimits/updated notifications — but only a session on that same account may. One whose env
// picks another account (another CODEX_HOME, set directly or through HOME; CODEX_API_KEY; any OPENAI_*,
// a configured provider's included) would put that account's usage beside the default account's credits.
// None of these rows names a slot the runner added, so their rate limits land in no account at all
// (a slot's session feeding that slot is TestCodexAccountQuota*).
//
// Every row is the real runCodexAppServerSessionProcess, handed the per-account merge the way runloop.go
// hands it, against this test binary posing as `codex app-server`. After thread/start the fake says one
// account/rateLimits/updated for the plan's own bucket — one the probe merges whenever it is handed it —
// and then a text delta. A session handles its notifications in order, so once it has emitted the delta
// it has dealt with the rate limits, merged or not, and the probe is read then.
func TestCodexSessionRateLimitsFeedPlanUsageOnlyFromTheDefaultAccount(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
	fake.useAsRunnerDefault(t)
	const handled = "orbit-test: the rate limits before this delta were handled"
	fake.answerSessionsWith(t,
		map[string]interface{}{"method": "account/rateLimits/updated", "params": map[string]interface{}{
			"rateLimits": map[string]interface{}{
				"limitId":   codexPlanLimitID,
				"primary":   map[string]interface{}{"usedPercent": 37, "windowDurationMins": 300, "resetsAt": 1789003600},
				"secondary": map[string]interface{}{"usedPercent": 58, "windowDurationMins": 10080, "resetsAt": 1789400000},
			},
		}},
		map[string]interface{}{"method": "item/agentMessage/delta", "params": map[string]interface{}{"delta": handled}},
	)

	// The default account as the probe reads it: windows from its own read, and its reset block.
	reader := newCodexPlanUsageProbe(codexResetTestLeaseOwner)
	usage, err := reader.fetch(context.Background(), reader.client)
	if err != nil {
		t.Fatal(err)
	}
	reader.store(usage)
	read := reader.snapshot()
	if read.RateLimitReset == nil || read.Primary == nil || read.Primary.Utilization != 100 || read.Secondary != nil {
		t.Fatalf("the default account's read produced %+v", read)
	}
	cwd, _ := os.Getwd()
	defaultHome, err := effectiveCodexHome(os.Environ(), cwd)
	if err != nil {
		t.Fatal(err)
	}
	// The control plane has no message for these sessions: every inbox poll ends empty.
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(inbox.Close)

	for _, row := range []struct {
		name      string
		env       map[string]string
		onDefault bool
	}{
		{"CODEX_HOME names another home", map[string]string{"CODEX_HOME": t.TempDir()}, false},
		{"HOME moves CODEX_HOME", map[string]string{"HOME": t.TempDir()}, false},
		{"CODEX_API_KEY", map[string]string{"CODEX_API_KEY": "orbit-test-codex-api-key"}, false},
		{"OPENAI_API_KEY", map[string]string{"OPENAI_API_KEY": "orbit-test-openai-api-key"}, false},
		{"a configured provider", map[string]string{"OPENAI_BASE_URL": "https://provider.example.invalid/v1", "OPENAI_API_KEY": "orbit-test-provider-key"}, false},
		{"another OPENAI_ variable", map[string]string{"OPENAI_ORG_ID": "org-orbit-test"}, false},
		{"no account variables", map[string]string{"ORBIT_TEST_UNRELATED": "1", "CODEX_API_KEY": " ", "OPENAI_API_KEY": ""}, true},
		{"CODEX_HOME names the default home", map[string]string{"CODEX_HOME": defaultHome}, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			usage := newCodexAccountUsage(codexResetTestLeaseOwner)
			usage.def.store(read)
			runCodexSessionUntilHandled(t, inbox.URL, row.env, usage.mergeCodexRateLimits, handled)
			if accounts := usage.snapshot().Accounts; len(accounts) != 0 {
				t.Fatalf("a session on no added slot fed another account's snapshot: %+v", accounts)
			}
			got := usage.def.snapshot()
			if got.RateLimitReset == nil || !reflect.DeepEqual(*got.RateLimitReset, *read.RateLimitReset) {
				t.Fatalf("the session changed the default account's reset block: %+v, want %+v", got.RateLimitReset, read.RateLimitReset)
			}
			if !row.onDefault {
				if !reflect.DeepEqual(got, read) {
					t.Fatalf("a session on another account rewrote the default account's windows: primary %+v secondary %+v, want primary %+v secondary %+v", got.Primary, got.Secondary, read.Primary, read.Secondary)
				}
				return
			}
			if got.Primary == nil || got.Primary.Utilization != 37 || got.Secondary == nil || got.Secondary.Utilization != 58 {
				t.Fatalf("a session on the default account did not refresh the windows: primary %+v secondary %+v", got.Primary, got.Secondary)
			}
		})
	}
}

// runCodexSessionUntilHandled runs one Codex session under agent env env until it has emitted the text
// delta handled, then cancels it and waits for it to return.
func runCodexSessionUntilHandled(t *testing.T, inboxURL string, env map[string]string, onRateLimits codexRateLimitSink, handled string) {
	t.Helper()
	job := &ClaimedSession{
		SessionID: "5b0b8a4e-9d2c-4f7e-8a1b-3c6d9e0f1a2b",
		Provider:  providerCodex,
		Agent:     AgentExecConfig{Provider: providerCodex, Env: env},
	}
	execDir, scratchDir := t.TempDir(), t.TempDir()
	var mu sync.Mutex
	var errs []string
	seen := make(chan struct{})
	var once sync.Once
	emit := func(eventType string, payload map[string]interface{}) {
		switch {
		case eventType == evTextDelta && payload["text"] == handled:
			once.Do(func() { close(seen) })
		case eventType == evError:
			mu.Lock()
			errs = append(errs, asString(payload["message"]))
			mu.Unlock()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ended := make(chan string, 1)
	go func() {
		status, _, _ := runCodexAppServerSessionProcess(ctx, context.Background(), NewTransport(inboxURL, "runner-token"), job, "", execDir, scratchDir,
			emit, func(string, string, map[string]interface{}) {}, func(string) {}, true, nil, onRateLimits,
			func(TurnCompleteRequest, ...context.Context) error { return nil }, func(context.Context) bool { return true }, func(error) {})
		ended <- status
	}()
	failure := ""
	select {
	case <-seen:
	case status := <-ended:
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("the session ended %s before it emitted the delta: %s", status, strings.Join(errs, "; "))
	case <-time.After(30 * time.Second):
		failure = "the session never emitted the delta"
	}
	cancel()
	select {
	case <-ended:
	case <-time.After(30 * time.Second):
		t.Fatal("the session did not end once cancelled")
	}
	if failure != "" {
		t.Fatal(failure)
	}
}
