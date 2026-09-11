package main

import (
	"context"
	"errors"
	"os"
	"time"
)

// The Codex rate-limit reset step, runner half of docs/codex-rate-limit-reset-contract.md §6.4: what
// this process does with the CONSUME or REFRESH command the relay (codex_rate_limit_reset_relay.go)
// hands it, on the runner's default Codex account. runnerCapabilitiesV1 declares
// codexRateLimitResetCapabilityV1 because this carries those commands out.
//
// The provider key is the command's, which is the operation's: nothing here makes one, keeps one, or
// calls consume without one. Each consume call follows a read, on the same app-server, that names the
// account it would spend, and a read naming any account but the operation's is reported without
// calling the provider at all.
//
// The two checkpoints stay apart. A consume's outcome is reported, and its receipt says the control
// plane holds it CONFIRMED, before the authoritative read starts; from there the step only reads and
// reports, whatever the refresh or its receipts come to. A consume that got no outcome is called again
// under the same key while the receipts answer RETRY_CONSUME; one that got an outcome never is — what
// is sent again is its result. A process that dies anywhere in between leaves its successor what the
// control plane recorded: a REFRESH once the outcome landed, or else the same key's CONSUME, which the
// provider answers for that key (alreadyRedeemed after a reset) rather than spending a second credit.

const (
	// The consume call's own budget (§6.4).
	codexResetConsumeTimeout = 30 * time.Second
	// One attempt at a step: the app-server's start and handshake, its reads, and the consume.
	codexResetAttemptTimeout = 90 * time.Second
)

// codexResetConsumer carries out the reset steps of one runner process.
type codexResetConsumer struct {
	// The Codex usage probe: its reader stamps each block a step reads in the sequence the probe's own
	// reads use, and its cache keeps the block for the next heartbeat.
	probe *planUsageProbe

	consumeTimeout time.Duration
	attemptTimeout time.Duration
	now            func() time.Time
	wait           func(ctx context.Context, d time.Duration) bool
}

func newCodexResetConsumer(probe *planUsageProbe) *codexResetConsumer {
	return &codexResetConsumer{
		probe:          probe,
		consumeTimeout: codexResetConsumeTimeout,
		attemptTimeout: codexResetAttemptTimeout,
		now:            time.Now,
		wait:           codexResetSleep,
	}
}

// execute is the relay's codexResetExecutor: a CONSUME command's consume and then the refresh its
// receipt asks for, or a REFRESH command's refresh.
func (c *codexResetConsumer) execute(ctx context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter) {
	if cmd.Phase == codexResetPhaseConsume {
		result, receipt, ok := c.repeat(ctx, report, func() CodexRateLimitResetResultRequest { return c.consume(ctx, cmd) },
			func(result CodexRateLimitResetResultRequest, receipt CodexRateLimitResetResultResponse) bool {
				return result.Kind == "CONSUME_RETRYING" && receipt.Next == "RETRY_CONSUME"
			})
		if !ok || result.Kind != "CONSUME_OUTCOME" || (receipt.Next != "REFRESH" && receipt.Next != "RETRY_REFRESH") {
			return
		}
		// Confirmed. What is left of this claim is the operation's refresh, which carries no key.
		cmd.Phase, cmd.ProviderIdempotencyKey = codexResetPhaseRefresh, ""
	}
	c.repeat(ctx, report, func() CodexRateLimitResetResultRequest { return c.refresh(ctx, cmd) },
		func(result CodexRateLimitResetResultRequest, receipt CodexRateLimitResetResultResponse) bool {
			return result.Kind == "REFRESH_FAILED" && (receipt.Next == "RETRY_REFRESH" || receipt.Next == "REFRESH")
		})
}

// repeat reports what attempt comes to, and attempts again after a backoff for as long as the receipt
// asks for exactly that (again) and codexResetReceiptWindow lasts. It returns the last result with its
// receipt, and false when that result got none: the process is stopping, or the result was refused or
// never delivered.
func (c *codexResetConsumer) repeat(ctx context.Context, report codexResetReporter, attempt func() CodexRateLimitResetResultRequest,
	again func(CodexRateLimitResetResultRequest, CodexRateLimitResetResultResponse) bool,
) (CodexRateLimitResetResultRequest, CodexRateLimitResetResultResponse, bool) {
	deadline := c.now().Add(codexResetReceiptWindow)
	delay := codexResetReceiptFirstDelay
	for {
		result := attempt()
		if ctx.Err() != nil {
			// Stopping: nothing is reported any more, and whatever the attempt reached is left to the
			// successor's claim, under the same key.
			return result, CodexRateLimitResetResultResponse{}, false
		}
		receipt, err := report(result)
		if err != nil {
			return result, receipt, false
		}
		if !again(result, receipt) || c.now().Add(delay).After(deadline) || !c.wait(ctx, delay) {
			return result, receipt, true
		}
		delay = min(delay*2, codexResetReceiptMaxDelay)
	}
}

// consume is one attempt at the command's consume: a read that has to name the operation's account,
// then the call under the command's key.
func (c *codexResetConsumer) consume(ctx context.Context, cmd CodexRateLimitResetCommand) CodexRateLimitResetResultRequest {
	params, err := codexResetConsumeParams(cmd)
	if err != nil {
		// No persisted key to call with: the relay acts on no such command, and nothing is called.
		return codexResetResult(cmd, "CONSUME_NOT_CALLED", "PROTOCOL_UNSUPPORTED")
	}
	if !codexSharedStateAllowed(os.Environ()) {
		// The runner's own environment signs Codex in with custom API credentials, which is not the
		// default login an operation is bound to (§3).
		return codexResetResult(cmd, "CONSUME_NOT_CALLED", codexResetUnsupportedAuth)
	}
	var result CodexRateLimitResetResultRequest
	err = withDefaultCodexAppServer(ctx, c.attemptTimeout, func(ctx context.Context, app *codexAppServer) error {
		block, code := c.read(ctx, app)
		switch {
		case block == nil:
			result = codexResetResult(cmd, "CONSUME_RETRYING", code)
		case block.Support == codexResetUnsupportedAuth || block.Support == codexResetProviderUnsupported:
			result = codexResetResult(cmd, "CONSUME_NOT_CALLED", block.Support)
		case block.AccountFingerprint == "":
			result = codexResetResult(cmd, "CONSUME_RETRYING", codexResetAccountUnidentified)
		case block.AccountFingerprint != cmd.AccountFingerprint:
			result = codexResetResult(cmd, "CONSUME_NOT_CALLED", "ACCOUNT_MISMATCH")
			result.ObservedAccountFingerprint = block.AccountFingerprint
		default:
			// CREDITS_UNAVAILABLE and a count of 0 do not stop it: the outcome is the provider's (§6.4).
			result = c.call(ctx, app, cmd, params)
			result.ObservedAccountFingerprint = block.AccountFingerprint
		}
		return nil
	})
	if err != nil {
		return codexResetResult(cmd, "CONSUME_RETRYING", "APP_SERVER_UNAVAILABLE")
	}
	return result
}

// call makes the consume call and maps what it comes to (§1.2): the provider's outcome, or, when it gave
// none, why — the provider answered an error or something that is no outcome, no answer came in time,
// or no app-server was left to answer. The call may have reached the provider in each of those, so each
// is retried under the same key.
func (c *codexResetConsumer) call(ctx context.Context, app *codexAppServer, cmd CodexRateLimitResetCommand, params map[string]interface{}) CodexRateLimitResetResultRequest {
	callCtx, cancel := context.WithTimeout(ctx, c.consumeTimeout)
	answer, err := app.request(callCtx, codexRateLimitResetConsumeMethod, params)
	cancel()
	var refused *codexRPCCallError
	switch {
	case errors.As(err, &refused):
		return codexResetResult(cmd, "CONSUME_RETRYING", "PROVIDER_ERROR")
	case errors.Is(err, context.DeadlineExceeded):
		return codexResetResult(cmd, "CONSUME_RETRYING", "PROVIDER_TIMEOUT")
	case err != nil:
		return codexResetResult(cmd, "CONSUME_RETRYING", "APP_SERVER_UNAVAILABLE")
	}
	outcome, _ := answer["outcome"].(string)
	if _, known := codexRateLimitResetOutcomeEffects[outcome]; !known {
		return codexResetResult(cmd, "CONSUME_RETRYING", "PROVIDER_ERROR")
	}
	result := codexResetResult(cmd, "CONSUME_OUTCOME", "")
	result.Outcome = outcome
	return result
}

// refresh is one attempt at the authoritative read that follows a confirmed consume: a read of its own,
// which the operation takes as its refresh when it names the operation's account.
func (c *codexResetConsumer) refresh(ctx context.Context, cmd CodexRateLimitResetCommand) CodexRateLimitResetResultRequest {
	if !codexSharedStateAllowed(os.Environ()) {
		// Custom API credentials in the runner's environment: this process reads no default account.
		return codexResetResult(cmd, "REFRESH_FAILED", codexResetAccountUnidentified)
	}
	var result CodexRateLimitResetResultRequest
	err := withDefaultCodexAppServer(ctx, c.attemptTimeout, func(ctx context.Context, app *codexAppServer) error {
		block, code := c.read(ctx, app)
		switch {
		case block == nil:
			result = codexResetResult(cmd, "REFRESH_FAILED", code)
		case block.AccountFingerprint == "":
			// Signed out, an API key, or a read that names no account: nothing to compare yet, so the
			// refresh is asked for again until the operation's refresh deadline.
			result = codexResetResult(cmd, "REFRESH_FAILED", codexResetAccountUnidentified)
		case block.AccountFingerprint != cmd.AccountFingerprint:
			result = codexResetResult(cmd, "REFRESH_FAILED", "ACCOUNT_MISMATCH")
			result.ObservedAccountFingerprint = block.AccountFingerprint
		default:
			result = codexResetResult(cmd, "REFRESHED", "")
			result.RateLimitReset = block
			result.ObservedAccountFingerprint = block.AccountFingerprint
		}
		return nil
	})
	if err != nil {
		return codexResetResult(cmd, "REFRESH_FAILED", "APP_SERVER_UNAVAILABLE")
	}
	return result
}

// read makes this process's next read of the account on app and keeps it in the probe cache, as the
// probe keeps its own. It returns the read's block, or no block and the code of a read that made none.
func (c *codexResetConsumer) read(ctx context.Context, app *codexAppServer) (*PlanUsageRateLimitReset, string) {
	usage, err := c.probe.codexReset.readCodexPlanUsage(ctx, app)
	if err != nil {
		return nil, "READ_FAILED"
	}
	c.probe.store(usage)
	if usage.RateLimitReset == nil {
		return nil, "READ_FAILED"
	}
	return usage.RateLimitReset, ""
}
