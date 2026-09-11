package main

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The usage probe logs a failed read by what failed, never by the provider's text: a Codex app-server's error
// answer can name the account. Paired: a failure that is not the provider's answer keeps its own text.
func TestPlanUsageProbeLogsNoProviderErrorText(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{
			name: "the app-server's error answer",
			err:  &codexRPCCallError{method: codexRateLimitsReadMethod, message: "no usage for " + codexResetTestAccountID + " " + codexResetTestEmail},
			want: "codex plan-usage unavailable: account/rateLimits/read: the app-server answered an error",
		},
		{
			name: "a failure of the runner's own",
			err:  context.DeadlineExceeded,
			want: "codex plan-usage unavailable: context deadline exceeded",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var fetches atomic.Int64
			probe := &planUsageProbe{client: &http.Client{}, name: "codex plan-usage", fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
				fetches.Add(1)
				return nil, tc.err
			}}
			ctx, cancel := context.WithCancel(context.Background())
			logs := captureRunnerStdout(t, func() {
				done := make(chan struct{})
				go func() {
					defer close(done)
					probe.runWithIntervals(ctx, func() int { return 1 }, func() bool { return true }, time.Millisecond, time.Millisecond, time.Millisecond)
				}()
				deadline := time.Now().Add(10 * time.Second)
				for fetches.Load() < 2 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				cancel()
				<-done
			})
			if fetches.Load() < 2 {
				t.Fatalf("the probe fetched %d times in 10s", fetches.Load())
			}
			if !strings.Contains(logs, tc.want) {
				t.Fatalf("the probe logged:\n%s\nwant a line %q", logs, tc.want)
			}
			for _, secret := range []string{codexResetTestAccountID, codexResetTestEmail} {
				if strings.Contains(logs, secret) {
					t.Fatalf("%q reached the probe's log:\n%s", secret, logs)
				}
			}
		})
	}
}
