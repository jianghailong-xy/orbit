//go:build codexresetlive

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

// TestCodexResetRelayAgainstALiveControlPlane drives this binary's own Transport and reset relay
// against a running control plane over real HTTP: the heartbeat that is handed the command, the
// command decoded as strictly as @orbit/shared validates it, the same bytes again on the next
// heartbeat, the results and their receipts — one receipt lost and its result sent again — and a
// late result refused once the operation has settled.
//
// Built only with -tags codexresetlive, so `go test ./...` neither runs nor skips it.
// scripts/test-codex-reset-relay.sh builds it, and src/apiserver/src/runner-api/codex-reset-relay.pg.spec.ts
// runs it against the runner routes it serves over a disposable PostgreSQL, then reads the rows back.
// The executor is this test's own function: no Codex process, no account, no credit.
func TestCodexResetRelayAgainstALiveControlPlane(t *testing.T) {
	env := func(name string) string {
		value := os.Getenv(name)
		if value == "" {
			t.Fatalf("%s is required: this test runs against a control plane its caller started", name)
		}
		return value
	}
	server := env("ORBIT_CODEX_RESET_LIVE_URL")
	token := env("ORBIT_CODEX_RESET_LIVE_TOKEN")
	operationID := env("ORBIT_CODEX_RESET_LIVE_OPERATION")
	fingerprint := env("ORBIT_CODEX_RESET_LIVE_FINGERPRINT")
	persistedKey := env("ORBIT_CODEX_RESET_LIVE_PROVIDER_KEY")

	transport := NewTransport(server, token)
	fmt.Printf("CODEX_RESET_LIVE_PROCESS=%s\n", transport.leaseOwner)
	sequence := int64(0)
	block := func() *PlanUsageRateLimitReset {
		sequence++
		return &PlanUsageRateLimitReset{
			ProtocolVersion:       codexRateLimitResetProtocolVersion,
			Support:               codexResetSupported,
			AccountFingerprint:    fingerprint,
			RateLimitResetCredits: &PlanUsageRateLimitResetCredits{AvailableCount: 2},
			FetchedAt:             time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Generation:            transport.leaseOwner,
			Sequence:              sequence,
		}
	}
	// One heartbeat of this process declaring the capability, reading the account: the response, and
	// the raw bytes of the command it carried (nil when it carried none).
	heartbeat := func() (*HeartbeatResponse, json.RawMessage) {
		t.Helper()
		request := HeartbeatRequest{
			Status: "ONLINE", IdleCapacity: 1, LeaseOwner: transport.leaseOwner,
			PlanUsage: &PlanUsage{Provider: "codex", RateLimitReset: block()},
		}
		headers := map[string]string{runnerCapabilitiesHeader: runnerCapabilitiesV1 + "," + codexRateLimitResetCapabilityV1}
		var raw json.RawMessage
		if err := transport.doHeaders(nil, "POST", "/runner/heartbeat", request, &raw, 15*time.Second, headers); err != nil {
			t.Fatalf("heartbeat: %v", err)
		}
		var response HeartbeatResponse
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		return &response, fields["codexRateLimitResetRequest"]
	}

	// 1. The command as the endpoint encodes it, decoded strictly.
	response, raw := heartbeat()
	if raw == nil {
		t.Fatalf("a capable, leased, non-draining process reading the account was handed no command: %+v", response)
	}
	command, err := decodeCodexResetWire([]byte(raw), codexResetCommandViolations)
	if err != nil {
		t.Fatalf("the heartbeat carried something that is not a protocol v1 command: %v\n%s", err, raw)
	}
	if !reflect.DeepEqual(*response.CodexRateLimitResetRequest, command) {
		t.Fatalf("the heartbeat response decodes the command as %+v, strict decoding as %+v", *response.CodexRateLimitResetRequest, command)
	}
	if command.OperationID != operationID || command.LeaseOwner != transport.leaseOwner || command.ClaimGeneration != 1 ||
		command.Phase != codexResetPhaseConsume || command.AccountFingerprint != fingerprint {
		t.Fatalf("command %s is not the first CONSUME claim of operation %s for process %s", raw, operationID, transport.leaseOwner)
	}
	if command.ProviderIdempotencyKey != persistedKey {
		t.Fatal("the CONSUME command does not carry the operation's persisted provider key")
	}
	params, err := codexResetConsumeParams(command)
	if err != nil || !reflect.DeepEqual(params, map[string]interface{}{"idempotencyKey": persistedKey}) {
		t.Fatalf("consume params %v (%v), want exactly the persisted key", params, err)
	}

	// 2. A lost response costs nothing: the next heartbeat carries the same bytes.
	if _, again := heartbeat(); !bytes.Equal(again, raw) {
		t.Fatalf("the command redelivered differs:\n%s\n%s", raw, again)
	}

	// 3. The relay carries it out: the outcome, sent again as if its receipt were lost, then the refresh
	// the receipt asks for. A redelivery while the step runs starts nothing.
	var ops sync.WaitGroup
	var mu sync.Mutex
	var receipts []CodexRateLimitResetResultResponse
	var failures []error
	steps := 0
	relay := newCodexResetRelay(context.Background(), transport, func(_ context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, _ codexResetDeliveries) {
		record := func(receipt CodexRateLimitResetResultResponse, err error) {
			mu.Lock()
			defer mu.Unlock()
			receipts = append(receipts, receipt)
			if err != nil {
				failures = append(failures, err)
			}
		}
		mu.Lock()
		steps++
		mu.Unlock()
		outcome := codexResetResult(cmd, "CONSUME_OUTCOME", "")
		outcome.Outcome = "reset"
		outcome.ObservedAccountFingerprint = cmd.AccountFingerprint
		record(report(outcome))
		record(report(outcome))
		refreshed := codexResetResult(cmd, "REFRESHED", "")
		refreshed.Phase = codexResetPhaseRefresh
		refreshed.RateLimitReset = block()
		record(report(refreshed))
	}, &ops)
	received := time.Now()
	relay.handle(&command, received, false)
	relay.handle(&command, received, false)
	ops.Wait()
	want := []CodexRateLimitResetResultResponse{
		{Disposition: "APPLIED", Status: "REFRESHING", Next: "REFRESH"},
		{Disposition: "DUPLICATE", Status: "REFRESHING", Next: "REFRESH"},
		{Disposition: "APPLIED", Status: "SUCCEEDED", Next: "STOP"},
	}
	if steps != 1 || len(failures) != 0 || !reflect.DeepEqual(receipts, want) {
		t.Fatalf("%d steps, receipts %+v, failures %v; want one step and %+v", steps, receipts, failures, want)
	}

	// 4. Settled: nothing is delivered any more, and a late result of the claim is refused.
	if _, after := heartbeat(); after != nil {
		t.Fatalf("a settled operation was delivered again: %s", after)
	}
	_, err = relay.report(codexResetResult(command, "CONSUME_RETRYING", "PROVIDER_TIMEOUT"))
	var refused *codexResetResultRefused
	if !errors.As(err, &refused) || refused.code != "OPERATION_SETTLED" {
		t.Fatalf("a late result after the outcome: %v, want the refusal OPERATION_SETTLED", err)
	}
}
