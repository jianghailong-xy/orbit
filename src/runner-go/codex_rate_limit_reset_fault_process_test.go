//go:build codexresetfault

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestCodexResetFaultProcess is one runner process of the Codex rate-limit reset fault-injection harness
// (src/apiserver/src/runner-api/codex-reset-fault-injection.pg.spec.ts, scripts/test-codex-reset-fault-injection.sh):
// this binary's own Transport, usage probe, reset relay and consume against a live control plane, driven one
// command at a time from stdin, so the harness places every read, heartbeat, drain and crash where a fault needs
// it. The app-server it starts is the consume tests' programmable fake (runFakeCodexResetProvider), reached through
// a `codex` shim the harness puts first on PATH, and its credits are a file: no real account, no real credit.
//
// One JSON command per stdin line, one `FAULTPROC {json}` answer per command on stderr — apart from the runner's
// own log on stdout, so an answer and a log line never share a line:
//
//	{"id":1,"cmd":"probe"}                                   a usage read, kept for the next heartbeat
//	{"id":2,"cmd":"heartbeat","draining":false,"drainingOnReceipt":false,"capable":true,"leaseOwner":true}
//	                                                         one heartbeat; its command, if any, goes to the relay
//	{"id":3,"cmd":"idle","timeoutMs":20000}                  wait for the relay's steps to end
//	{"id":4,"cmd":"stop"}                                    stop the steps and exit
//
// An answer never carries the provider key or the account: a command is summarized as its operation, phase, claim
// and whether it carried a key. Built only with -tags codexresetfault, so `go test ./...` neither runs nor skips it.
func TestCodexResetFaultProcess(t *testing.T) {
	transport := NewTransport(codexResetFaultEnv(t, "ORBIT_CODEX_RESET_FAULT_URL"), codexResetFaultEnv(t, "ORBIT_CODEX_RESET_FAULT_TOKEN"))
	probe := newCodexPlanUsageProbe(transport.leaseOwner)
	consumer := newCodexResetConsumer(probe)
	consumer.consumeTimeout = codexResetFaultMillis("ORBIT_CODEX_RESET_FAULT_CONSUME_TIMEOUT_MS", consumer.consumeTimeout)
	consumer.attemptTimeout = codexResetFaultMillis("ORBIT_CODEX_RESET_FAULT_ATTEMPT_TIMEOUT_MS", consumer.attemptTimeout)
	consumer.callFreshness = codexResetFaultMillis("ORBIT_CODEX_RESET_FAULT_CALL_FRESHNESS_MS", consumer.callFreshness)
	// Backoffs shrink by this factor; every deadline and window stays as the runner has it.
	scale, err := strconv.ParseFloat(os.Getenv("ORBIT_CODEX_RESET_FAULT_BACKOFF_SCALE"), 64)
	if err != nil || scale <= 0 {
		scale = 1
	}
	wait := func(ctx context.Context, d time.Duration) bool {
		return codexResetSleep(ctx, time.Duration(float64(d)*scale))
	}
	consumer.wait = wait
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	var ops sync.WaitGroup
	relay := newCodexResetRelay(ctx, transport, consumer.execute, &ops)
	relay.wait = wait

	var answering sync.Mutex
	answer := func(id int64, fields map[string]interface{}) {
		fields["id"] = id
		data, _ := json.Marshal(fields)
		answering.Lock()
		defer answering.Unlock()
		fmt.Fprintf(os.Stderr, "FAULTPROC %s\n", data)
	}
	answer(0, map[string]interface{}{"ready": true, "leaseOwner": transport.leaseOwner})

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var cmd struct {
			ID                int64  `json:"id"`
			Cmd               string `json:"cmd"`
			Draining          bool   `json:"draining"`
			DrainingOnReceipt bool   `json:"drainingOnReceipt"`
			Capable           *bool  `json:"capable"`
			LeaseOwner        *bool  `json:"leaseOwner"`
			TimeoutMs         int64  `json:"timeoutMs"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			answer(0, map[string]interface{}{"ok": false, "error": "unreadable_command"})
			continue
		}
		switch cmd.Cmd {
		case "probe":
			usage, err := probe.fetch(ctx, probe.client)
			if err != nil {
				answer(cmd.ID, map[string]interface{}{"ok": false, "error": codexResetErrorClass(err)})
				continue
			}
			probe.store(usage)
			fields := map[string]interface{}{"ok": true}
			if snapshot := probe.snapshot(); snapshot != nil && snapshot.RateLimitReset != nil {
				block := snapshot.RateLimitReset
				fields["fetchedAt"], fields["sequence"], fields["support"] = block.FetchedAt, block.Sequence, block.Support
			}
			answer(cmd.ID, fields)
		case "heartbeat":
			request := HeartbeatRequest{Status: "ONLINE", IdleCapacity: 1, Draining: cmd.Draining, PlanUsage: combinePlanUsage(nil, probe.snapshot())}
			if cmd.LeaseOwner == nil || *cmd.LeaseOwner {
				request.LeaseOwner = transport.leaseOwner
			}
			capabilities := runnerCapabilitiesV1
			if cmd.Capable != nil && !*cmd.Capable {
				capabilities = codexResetFaultWithout(runnerCapabilitiesV1, codexRateLimitResetCapabilityV1)
			}
			sent := time.Now()
			var response HeartbeatResponse
			headers := map[string]string{runnerCapabilitiesHeader: capabilities}
			if err := transport.doHeaders(nil, "POST", "/runner/heartbeat", request, &response, 15*time.Second, headers); err != nil {
				answer(cmd.ID, map[string]interface{}{"ok": false, "error": codexResetErrorClass(err)})
				continue
			}
			relay.handle(response.CodexRateLimitResetRequest, sent, cmd.Draining || cmd.DrainingOnReceipt)
			fields := map[string]interface{}{"ok": true, "command": nil}
			if command := response.CodexRateLimitResetRequest; command != nil {
				fields["command"] = map[string]interface{}{
					"operationId": command.OperationID, "phase": command.Phase, "claimGeneration": command.ClaimGeneration,
					"carriesKey": command.ProviderIdempotencyKey != "",
				}
			}
			answer(cmd.ID, fields)
		case "idle":
			done := make(chan struct{})
			go func() {
				ops.Wait()
				close(done)
			}()
			timeout := time.Duration(cmd.TimeoutMs) * time.Millisecond
			if timeout <= 0 {
				timeout = 20 * time.Second
			}
			select {
			case <-done:
				answer(cmd.ID, map[string]interface{}{"ok": true, "idle": true})
			case <-time.After(timeout):
				answer(cmd.ID, map[string]interface{}{"ok": true, "idle": false})
			}
		case "stop":
			stop()
			ops.Wait()
			answer(cmd.ID, map[string]interface{}{"ok": true})
			return
		default:
			answer(cmd.ID, map[string]interface{}{"ok": false, "error": "unknown_command"})
		}
	}
	stop()
	ops.Wait()
}

// TestCodexResetFaultProvider applies ORBIT_CODEX_RESET_FAULT_PROVIDER_PATCH, a JSON object of provider-state fields
// (codexResetProviderState's), to the fake provider in ORBIT_CODEX_RESET_FAULT_PROVIDER_DIR under the lock every
// fake app-server takes, and writes the resulting state as `FAULTPROVIDER {json}` on stderr. `{}` only reads it.
func TestCodexResetFaultProvider(t *testing.T) {
	dir := codexResetFaultEnv(t, "ORBIT_CODEX_RESET_FAULT_PROVIDER_DIR")
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(codexResetFaultEnv(t, "ORBIT_CODEX_RESET_FAULT_PROVIDER_PATCH")), &patch); err != nil {
		t.Fatalf("the provider patch is not a JSON object: %v", err)
	}
	var result codexResetProviderState
	var patchErr error
	err := codexResetUpdateProvider(dir, func(state *codexResetProviderState) {
		current, _ := json.Marshal(state)
		merged := map[string]json.RawMessage{}
		_ = json.Unmarshal(current, &merged)
		for field, value := range patch {
			merged[field] = value
		}
		data, _ := json.Marshal(merged)
		var next codexResetProviderState
		if patchErr = json.Unmarshal(data, &next); patchErr == nil {
			*state = next
		}
		result = *state
	})
	if err != nil || patchErr != nil {
		t.Fatalf("patching the provider: %v %v", err, patchErr)
	}
	data, _ := json.Marshal(result)
	fmt.Fprintf(os.Stderr, "FAULTPROVIDER %s\n", data)
}

func codexResetFaultEnv(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required: this test is one process of a harness that starts it", name)
	}
	return value
}

func codexResetFaultMillis(name string, fallback time.Duration) time.Duration {
	ms, err := strconv.ParseInt(os.Getenv(name), 10, 64)
	if err != nil || ms <= 0 {
		return fallback
	}
	return time.Duration(ms) * time.Millisecond
}

// codexResetFaultWithout is the comma-separated capability list without one capability.
func codexResetFaultWithout(list, capability string) string {
	var kept []string
	for _, token := range strings.Split(list, ",") {
		if token != capability {
			kept = append(kept, token)
		}
	}
	return strings.Join(kept, ",")
}
