package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The runner half of the Codex rate-limit reset relay against a scripted control plane: what a
// delivery starts, what it never starts twice, and how a result is sent until it has a receipt. The
// executor is each test's own function; nothing here starts a Codex process or reads an account.

// codexResetFakeControlPlane answers POST /api/runner/codex-rate-limit-reset-result from a script:
// the n-th call gets answers[n-1], every call after the last gets the last, and every body is kept.
type codexResetFakeControlPlane struct {
	mu      sync.Mutex
	bodies  [][]byte
	answers []func(http.ResponseWriter)
}

func (cp *codexResetFakeControlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/api"+codexResetResultPath {
		http.NotFound(w, r)
		return
	}
	body, _ := io.ReadAll(r.Body)
	cp.mu.Lock()
	cp.bodies = append(cp.bodies, body)
	answer := cp.answers[min(len(cp.bodies), len(cp.answers))-1]
	cp.mu.Unlock()
	answer(w)
}

func (cp *codexResetFakeControlPlane) received() [][]byte {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([][]byte(nil), cp.bodies...)
}

func codexResetAnswer(status int, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// codexResetLostReceipt has read the whole result and drops the connection before answering: the
// result may well have been applied, and the sender cannot tell.
func codexResetLostReceipt(w http.ResponseWriter) {
	if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
		_ = conn.Close()
	}
}

// codexResetTestClock is the relay's clock in these tests: a wait advances it rather than sleeping,
// and every wait is recorded.
type codexResetTestClock struct {
	mu     sync.Mutex
	at     time.Time
	waited []time.Duration
}

func (c *codexResetTestClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *codexResetTestClock) wait(ctx context.Context, d time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.waited = append(c.waited, d)
	c.at = c.at.Add(d)
	return ctx.Err() == nil
}

// codexResetTestRelay is a relay of a fresh process whose results go to cp over a real Transport.
func codexResetTestRelay(t *testing.T, ctx context.Context, cp *codexResetFakeControlPlane, execute codexResetExecutor) (*codexResetRelay, *sync.WaitGroup, *codexResetTestClock) {
	t.Helper()
	server := httptest.NewServer(cp)
	t.Cleanup(server.Close)
	var ops sync.WaitGroup
	relay := newCodexResetRelay(ctx, NewTransport(server.URL, "runner-token"), execute, &ops)
	clock := &codexResetTestClock{at: time.Now()}
	relay.now = clock.now
	relay.wait = clock.wait
	return relay, &ops, clock
}

// codexResetDelivered is the command of a fixtures heartbeat response, claimed for process leaseOwner.
func codexResetDelivered(t *testing.T, response, leaseOwner string) CodexRateLimitResetCommand {
	t.Helper()
	var decoded HeartbeatResponse
	if err := json.Unmarshal(loadCodexResetFixtures(t).HeartbeatResponses[response], &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.CodexRateLimitResetRequest == nil {
		t.Fatalf("heartbeat response %q carries no command", response)
	}
	command := *decoded.CodexRateLimitResetRequest
	command.LeaseOwner = leaseOwner
	return command
}

func codexResetDecodeResult(t *testing.T, body []byte) CodexRateLimitResetResultRequest {
	t.Helper()
	result, err := decodeCodexResetWire(body, codexResetResultViolations)
	if err != nil {
		t.Fatalf("the relay sent something that is not a protocol v1 result: %v\n%s", err, body)
	}
	return result
}

func TestCodexResetRelayStartsEachClaimOncePerProcess(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetAnswer(http.StatusOK, `{"disposition":"APPLIED","status":"REFRESHING","next":"REFRESH"}`),
	}}
	release := make(chan struct{})
	var mu sync.Mutex
	var started []CodexRateLimitResetCommand
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(_ context.Context, cmd CodexRateLimitResetCommand, _ codexResetReporter, _ codexResetDeliveries) {
		mu.Lock()
		started = append(started, cmd)
		mu.Unlock()
		<-release
	})
	consume := codexResetDelivered(t, "consume", relay.leaseOwner)
	persisted := consume.ProviderIdempotencyKey
	for i := 0; i < 3; i++ {
		relay.handle(&consume, clock.now(), false) // redelivered on every heartbeat while its step runs
	}
	close(release)
	ops.Wait()
	relay.handle(&consume, clock.now(), false) // redelivered by a response that raced the step's end
	ops.Wait()

	// The same claim past its consume: a refresh starts, because a read may be repeated.
	refresh := codexResetDelivered(t, "refresh", relay.leaseOwner)
	refresh.ClaimGeneration = consume.ClaimGeneration
	relay.handle(&refresh, clock.now(), false)
	ops.Wait()
	// The operation's next claim — this process taking it over — consumes again, under the same key.
	takeover := consume
	takeover.ClaimGeneration = consume.ClaimGeneration + 1
	relay.handle(&takeover, clock.now(), false)
	relay.handle(&takeover, clock.now(), false)
	ops.Wait()

	var steps []string
	for _, cmd := range started {
		steps = append(steps, fmt.Sprintf("%s/%d", cmd.Phase, cmd.ClaimGeneration))
		if cmd.Phase != codexResetPhaseConsume {
			continue
		}
		params, err := codexResetConsumeParams(cmd)
		if err != nil || !reflect.DeepEqual(params, map[string]interface{}{"idempotencyKey": persisted}) {
			t.Fatalf("claim %d consumes with %v (%v), want only the operation's persisted key", cmd.ClaimGeneration, params, err)
		}
	}
	if want := []string{"CONSUME/1", "REFRESH/1", "CONSUME/2"}; !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps started %v, want %v: each claim's consume once, however often it is delivered", steps, want)
	}
	if bodies := cp.received(); len(bodies) != 0 {
		t.Fatalf("delivering commands posted %d results of its own", len(bodies))
	}
}

func TestCodexResetRelayActsOnNothingItMustNotActOn(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetAnswer(http.StatusOK, `{"disposition":"APPLIED","status":"CONSUMING","next":"STOP"}`),
	}}
	var steps atomic.Int64
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(context.Context, CodexRateLimitResetCommand, codexResetReporter, codexResetDeliveries) {
		steps.Add(1)
	})
	var legacy HeartbeatResponse
	if err := json.Unmarshal(loadCodexResetFixtures(t).HeartbeatResponses["legacy"], &legacy); err != nil {
		t.Fatal(err)
	}
	own := codexResetDelivered(t, "consume", relay.leaseOwner)
	other := own
	other.LeaseOwner = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b"
	keyless := own
	keyless.ProviderIdempotencyKey = ""
	keyedRefresh := codexResetDelivered(t, "refresh", relay.leaseOwner)
	keyedRefresh.ProviderIdempotencyKey = own.ProviderIdempotencyKey
	cases := []struct {
		name     string
		cmd      *CodexRateLimitResetCommand
		received time.Time
	}{
		{"a legacy heartbeat response", legacy.CodexRateLimitResetRequest, clock.now()},
		{"another process's claim", &other, clock.now()},
		{"a response older than the freshness window", &own, clock.now().Add(-codexRateLimitResetCommandFreshness - time.Second)},
		{"a consume without its key", &keyless, clock.now()},
		{"a refresh that carries a key", &keyedRefresh, clock.now()},
	}
	for _, tc := range cases {
		relay.handle(tc.cmd, tc.received, false)
		ops.Wait()
		if steps.Load() != 0 || len(cp.received()) != 0 {
			t.Fatalf("%s: %d steps started, %d results sent; want none", tc.name, steps.Load(), len(cp.received()))
		}
	}
	// A binary without an executor acts on nothing, not even a command it would otherwise take.
	bare, bareOps, bareClock := codexResetTestRelay(t, context.Background(), cp, nil)
	bareCommand := codexResetDelivered(t, "consume", bare.leaseOwner)
	bare.handle(&bareCommand, bareClock.now(), false)
	bareOps.Wait()
	if len(cp.received()) != 0 {
		t.Fatalf("a relay with no executor sent %d results", len(cp.received()))
	}
	// Paired: the same relay acts on its own fresh command.
	relay.handle(&own, clock.now(), false)
	ops.Wait()
	if steps.Load() != 1 {
		t.Fatalf("this process's own fresh command started %d steps, want 1", steps.Load())
	}
}

func TestCodexResetRelayRefusesAConsumeOfAnotherProtocol(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetAnswer(http.StatusOK, `{"disposition":"APPLIED","status":"NOT_ATTEMPTED","next":"STOP"}`),
	}}
	var steps atomic.Int64
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(context.Context, CodexRateLimitResetCommand, codexResetReporter, codexResetDeliveries) {
		steps.Add(1)
	})
	newer := codexResetDelivered(t, "consume", relay.leaseOwner)
	newer.ProtocolVersion = 2
	relay.handle(&newer, clock.now(), false)
	ops.Wait()
	bodies := cp.received()
	if steps.Load() != 0 || len(bodies) != 1 {
		t.Fatalf("a consume of protocol 2 started %d steps and sent %d results; want 0 and 1", steps.Load(), len(bodies))
	}
	want := CodexRateLimitResetResultRequest{
		ProtocolVersion: 1, OperationID: newer.OperationID, LeaseOwner: relay.leaseOwner,
		ClaimGeneration: newer.ClaimGeneration, Phase: codexResetPhaseConsume,
		Kind: "CONSUME_NOT_CALLED", Code: "PROTOCOL_UNSUPPORTED",
	}
	if got := codexResetDecodeResult(t, bodies[0]); !reflect.DeepEqual(got, want) {
		t.Fatalf("refusal sent %+v, want %+v", got, want)
	}
	if bytes.Contains(bodies[0], []byte(newer.ProviderIdempotencyKey)) {
		t.Fatal("the refusal carries the provider idempotency key")
	}
}

func TestCodexResetRelayHandsBackOnlyAnUnstartedClaimWhenDraining(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetAnswer(http.StatusOK, `{"disposition":"APPLIED","status":"CONSUMING","next":"STOP"}`),
	}}
	var steps atomic.Int64
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(context.Context, CodexRateLimitResetCommand, codexResetReporter, codexResetDeliveries) {
		steps.Add(1)
	})
	unstarted := codexResetDelivered(t, "consume", relay.leaseOwner)
	relay.handle(&unstarted, clock.now(), true)
	ops.Wait()
	bodies := cp.received()
	if steps.Load() != 0 || len(bodies) != 1 {
		t.Fatalf("draining: %d steps started, %d results sent; want 0 and 1", steps.Load(), len(bodies))
	}
	if got := codexResetDecodeResult(t, bodies[0]); got.Kind != "RELEASED" || got.Code != "RUNNER_DRAINING" ||
		got.Phase != codexResetPhaseConsume || got.ClaimGeneration != unstarted.ClaimGeneration {
		t.Fatalf("draining sent %+v, want RELEASED / RUNNER_DRAINING for claim %d", got, unstarted.ClaimGeneration)
	}

	started := unstarted
	started.ClaimGeneration = unstarted.ClaimGeneration + 1
	relay.handle(&started, clock.now(), false)
	ops.Wait()
	relay.handle(&started, clock.now(), true)
	ops.Wait()
	if steps.Load() != 1 || len(cp.received()) != 1 {
		t.Fatalf("a claim whose consume started was handed back while draining (%d steps, %d results)", steps.Load(), len(cp.received()))
	}
}

func TestCodexResetRelayResendsAResultUntilItHasAReceipt(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetLostReceipt,
		codexResetAnswer(http.StatusServiceUnavailable, `{"statusCode":503,"message":"database conflict, retry"}`),
		codexResetAnswer(http.StatusOK, `{"disposition":"DUPLICATE","status":"REFRESHING","next":"REFRESH"}`),
	}}
	var receipt CodexRateLimitResetResultResponse
	var reportErr error
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(_ context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, _ codexResetDeliveries) {
		outcome := codexResetResult(cmd, "CONSUME_OUTCOME", "")
		outcome.Outcome = "reset"
		outcome.ObservedAccountFingerprint = cmd.AccountFingerprint
		receipt, reportErr = report(outcome)
	})
	consume := codexResetDelivered(t, "consume", relay.leaseOwner)
	relay.handle(&consume, clock.now(), false)
	ops.Wait()

	if reportErr != nil {
		t.Fatalf("the result never got its receipt: %v", reportErr)
	}
	if want := (CodexRateLimitResetResultResponse{Disposition: "DUPLICATE", Status: "REFRESHING", Next: "REFRESH"}); receipt != want {
		t.Fatalf("receipt %+v, want %+v", receipt, want)
	}
	bodies := cp.received()
	if len(bodies) != 3 {
		t.Fatalf("sent %d times, want 3: lost receipt, 503, receipt", len(bodies))
	}
	for i, body := range bodies {
		if !bytes.Equal(body, bodies[0]) {
			t.Fatalf("send %d differs from the first:\n%s\n%s", i+1, bodies[0], body)
		}
	}
	if got := codexResetDecodeResult(t, bodies[0]); got.Kind != "CONSUME_OUTCOME" || got.Outcome != "reset" {
		t.Fatalf("sent %+v", got)
	}
	if bytes.Contains(bodies[0], []byte(consume.ProviderIdempotencyKey)) {
		t.Fatal("the result carries the provider idempotency key")
	}
	if want := []time.Duration{time.Second, 2 * time.Second}; !reflect.DeepEqual(clock.waited, want) {
		t.Fatalf("backed off %v, want %v", clock.waited, want)
	}
}

func TestCodexResetRelayStopsAtARefusalOrAnAnswerThatIsNoReceipt(t *testing.T) {
	cases := []struct {
		name    string
		answer  func(http.ResponseWriter)
		refusal string
	}{
		{"a refusal", codexResetAnswer(http.StatusConflict, `{"code":"STALE_CLAIM"}`), "STALE_CLAIM"},
		{"a malformed result", codexResetAnswer(http.StatusBadRequest, `{"code":"INVALID_RESULT"}`), "INVALID_RESULT"},
		{"an older control plane without the route", codexResetAnswer(http.StatusNotFound,
			`{"message":"Cannot POST /api/runner/codex-rate-limit-reset-result","error":"Not Found","statusCode":404}`), ""},
		{"a 200 that is not a receipt", codexResetAnswer(http.StatusOK, `{"disposition":"APPLIED","status":"DONE","next":"STOP"}`), ""},
	}
	for _, tc := range cases {
		cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){tc.answer}}
		var reportErr error
		relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(_ context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, _ codexResetDeliveries) {
			_, reportErr = report(codexResetResult(cmd, "CONSUME_RETRYING", "PROVIDER_TIMEOUT"))
		})
		consume := codexResetDelivered(t, "consume", relay.leaseOwner)
		relay.handle(&consume, clock.now(), false)
		ops.Wait()
		var refused *codexResetResultRefused
		switch {
		case reportErr == nil:
			t.Fatalf("%s: reported as delivered", tc.name)
		case tc.refusal != "" && (!errors.As(reportErr, &refused) || refused.code != tc.refusal):
			t.Fatalf("%s: %v, want the refusal %s", tc.name, reportErr, tc.refusal)
		case tc.refusal == "" && errors.As(reportErr, &refused):
			t.Fatalf("%s: read as a refusal: %v", tc.name, reportErr)
		}
		if n := len(cp.received()); n != 1 || len(clock.waited) != 0 {
			t.Fatalf("%s: sent %d times after %d waits, want once", tc.name, n, len(clock.waited))
		}
	}
}

func TestCodexResetRelayGivesUpAfterItsReceiptWindow(t *testing.T) {
	cp := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){
		codexResetAnswer(http.StatusBadGateway, `upstream unavailable`),
	}}
	var reportErr error
	relay, ops, clock := codexResetTestRelay(t, context.Background(), cp, func(_ context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, _ codexResetDeliveries) {
		_, reportErr = report(codexResetResult(cmd, "CONSUME_RETRYING", "APP_SERVER_UNAVAILABLE"))
	})
	consume := codexResetDelivered(t, "consume", relay.leaseOwner)
	relay.handle(&consume, clock.now(), false)
	ops.Wait()
	var total time.Duration
	for _, d := range clock.waited {
		total += d
	}
	bodies := cp.received()
	if reportErr == nil || len(bodies) < 2 || total > codexResetReceiptWindow || clock.waited[len(clock.waited)-1] != codexResetReceiptMaxDelay {
		t.Fatalf("err %v after %d sends and %v of backoff (%v); want it to give up within %v, backing off to %v",
			reportErr, len(bodies), total, clock.waited, codexResetReceiptWindow, codexResetReceiptMaxDelay)
	}
	if total+codexResetReceiptMaxDelay <= codexResetReceiptWindow {
		t.Fatalf("gave up after %v of backoff, with a whole further retry still inside the %v window", total, codexResetReceiptWindow)
	}

	// A process that stops its relay stops sending at once.
	stopped, cancel := context.WithCancel(context.Background())
	cancel()
	quiet := &codexResetFakeControlPlane{answers: []func(http.ResponseWriter){codexResetAnswer(http.StatusBadGateway, `down`)}}
	var stoppedErr error
	halted, haltedOps, haltedClock := codexResetTestRelay(t, stopped, quiet, func(_ context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, _ codexResetDeliveries) {
		_, stoppedErr = report(codexResetResult(cmd, "CONSUME_RETRYING", "APP_SERVER_UNAVAILABLE"))
	})
	haltedCommand := codexResetDelivered(t, "consume", halted.leaseOwner)
	halted.handle(&haltedCommand, haltedClock.now(), false)
	haltedOps.Wait()
	if stoppedErr == nil || len(haltedClock.waited) != 0 {
		t.Fatalf("a stopped relay kept reporting: err %v, %d waits", stoppedErr, len(haltedClock.waited))
	}
}
