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
//
// Two more rules keep a call from landing where the operation cannot account for it. A call starts only
// while the claim is still being delivered to this process (codexResetCallFreshness), so a process that lost
// its claim, is draining, or outlived its operation stops calling. And once a call of this claim has gone
// out, the step never reports CONSUME_NOT_CALLED for it, because the operation would settle as never having
// tried.

const (
	// The consume call's own budget (§6.4).
	codexResetConsumeTimeout = 30 * time.Second
	// One attempt at a step: the app-server's start and handshake, its reads, and the consume.
	codexResetAttemptTimeout = 90 * time.Second
	// How old the claim's latest delivery may be when a consume call starts. The control plane renews a claim
	// at every heartbeat that delivers it and lets another process take it only once it has gone
	// claimTakeoverAfterMs (60s) unrenewed (§7.4). A delivery counts from when its heartbeat was sent, before the
	// renewal it carried, so a call started inside this bound has ended, answered or timed out, while the claim
	// is still this process's: 60s less the call's own 30s, less 10s for scheduling and the heartbeat's round trip.
	codexResetCallFreshness = 20 * time.Second
)

// codexResetConsumer carries out the reset steps of one runner process.
type codexResetConsumer struct {
	// The Codex usage probe: its reader stamps each block a step reads in the sequence the probe's own
	// reads use, and its cache keeps the block for the next heartbeat.
	probe *planUsageProbe

	consumeTimeout time.Duration
	attemptTimeout time.Duration
	callFreshness  time.Duration
	now            func() time.Time
	wait           func(ctx context.Context, d time.Duration) bool
}

func newCodexResetConsumer(probe *planUsageProbe) *codexResetConsumer {
	return &codexResetConsumer{
		probe:          probe,
		consumeTimeout: codexResetConsumeTimeout,
		attemptTimeout: codexResetAttemptTimeout,
		callFreshness:  codexResetCallFreshness,
		now:            time.Now,
		wait:           codexResetSleep,
	}
}

// codexResetConsumeAttempt is what one attempt at a command's consume came to.
type codexResetConsumeAttempt struct {
	// The result to report; unset when the attempt was stale.
	result CodexRateLimitResetResultRequest
	// called: the consume request went out, so it may have reached the provider whatever came back.
	called bool
	// stale: no delivery of the claim was recent enough to call, so nothing was called; delivered is when the
	// latest one was sent.
	stale     bool
	delivered time.Time
	// How the attempt's read of the account compared with the operation's: match, mismatch, unidentified or
	// unsupported; empty when there was no read.
	account string
}

// execute is the relay's codexResetExecutor: a CONSUME command's consume and then the refresh its
// receipt asks for, or a REFRESH command's refresh.
func (c *codexResetConsumer) execute(ctx context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, deliveries codexResetDeliveries) {
	if cmd.Phase == codexResetPhaseConsume {
		receipt, confirmed := c.consumeUntilOutcome(ctx, cmd, report, deliveries)
		if !confirmed || (receipt.Next != "REFRESH" && receipt.Next != "RETRY_REFRESH") {
			return
		}
		// Confirmed. What is left of this claim is the operation's refresh, which carries no key.
		cmd.Phase, cmd.ProviderIdempotencyKey = codexResetPhaseRefresh, ""
	}
	attempt := 0
	c.repeat(ctx, report, func() CodexRateLimitResetResultRequest {
		attempt++
		return c.refresh(ctx, cmd, attempt)
	}, func(result CodexRateLimitResetResultRequest, receipt CodexRateLimitResetResultResponse) bool {
		return result.Kind == "REFRESH_FAILED" && (receipt.Next == "RETRY_REFRESH" || receipt.Next == "REFRESH")
	})
}

// consumeUntilOutcome reports what each attempt at the command's consume comes to, and attempts again after a
// backoff for as long as the receipts answer RETRY_CONSUME and codexResetReceiptWindow lasts. It returns the last
// receipt, and true once that receipt is for an outcome.
//
// An attempt that finds the claim's latest delivery older than callFreshness calls nothing and reports nothing:
// the step waits for a heartbeat to deliver the claim again, which it does only while the claim is still this
// process's, the operation is active and inside its deadline, and this process is not draining. Without that
// delivery the step ends, and whatever it reached is left to the control plane's deadline or a successor's claim.
//
// Once a call of this claim has gone out, it may have spent a credit whatever came back. An attempt after that
// which cannot call (another account, a login that is not ChatGPT, a CLI without reset credits) is not reported
// as CONSUME_NOT_CALLED: that result says no call of this claim reached the provider, and the operation would
// settle NOT_ATTEMPTED, telling the user no credit was used. The step ends instead, and the control plane
// settles the claim UNRESOLVED on the account change or at the deadline (§7.4, §7.5).
func (c *codexResetConsumer) consumeUntilOutcome(ctx context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter,
	deliveries codexResetDeliveries,
) (CodexRateLimitResetResultResponse, bool) {
	deadline := c.now().Add(codexResetReceiptWindow)
	delay := codexResetReceiptFirstDelay
	called := false
	log := func(e codexResetLogEvent) {
		e.Stage, e.OperationID, e.Process = "consume", cmd.OperationID, codexResetProcessTag(cmd.LeaseOwner)
		e.Phase, e.ClaimGeneration = cmd.Phase, cmd.ClaimGeneration
		codexResetLog(e, cmd.ProviderIdempotencyKey)
	}
	for attempt := 1; ; attempt++ {
		tried := c.consume(ctx, cmd, deliveries, attempt)
		called = called || tried.called
		switch {
		case ctx.Err() != nil:
			// Stopping: nothing is reported any more, and whatever the attempt reached is left to the
			// successor's claim, under the same key.
			log(codexResetLogEvent{Event: "stopped", Attempt: attempt, Reason: "process_stopping"})
			return CodexRateLimitResetResultResponse{}, false
		case tried.stale:
			log(codexResetLogEvent{Event: "awaiting_delivery", Attempt: attempt, Account: tried.account, AgeMs: c.now().Sub(tried.delivered).Milliseconds()})
			if !deliveries.next(ctx, tried.delivered, deadline) {
				reason := "claim_not_delivered"
				if ctx.Err() != nil {
					reason = "process_stopping"
				}
				log(codexResetLogEvent{Event: "stopped", Attempt: attempt, Reason: reason})
				return CodexRateLimitResetResultResponse{}, false
			}
			continue
		}
		event := "not_called"
		if tried.called {
			event = "called"
		}
		log(codexResetLogEvent{Event: event, Attempt: attempt, Account: tried.account,
			Kind: tried.result.Kind, Outcome: tried.result.Outcome, Code: tried.result.Code})
		if tried.result.Kind == "CONSUME_NOT_CALLED" && called {
			log(codexResetLogEvent{Event: "stopped", Attempt: attempt, Reason: "not_called_after_a_call", Code: tried.result.Code})
			return CodexRateLimitResetResultResponse{}, false
		}
		receipt, err := report(tried.result)
		if err != nil {
			return receipt, false
		}
		if tried.result.Kind != "CONSUME_RETRYING" || receipt.Next != "RETRY_CONSUME" {
			return receipt, tried.result.Kind == "CONSUME_OUTCOME"
		}
		if c.now().Add(delay).After(deadline) || !c.wait(ctx, delay) {
			return receipt, false
		}
		delay = min(delay*2, codexResetReceiptMaxDelay)
	}
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

// consume is attempt number `attempt` at the command's consume: a read that has to name the operation's account,
// then, while the claim is still being delivered, the call under the command's key. The call is logged before it
// is made, so a process killed while it waits for the answer still leaves the line that says it may have spent.
func (c *codexResetConsumer) consume(ctx context.Context, cmd CodexRateLimitResetCommand, deliveries codexResetDeliveries, attempt int) codexResetConsumeAttempt {
	params, err := codexResetConsumeParams(cmd)
	if err != nil {
		// No persisted key to call with: the relay acts on no such command, and nothing is called.
		return codexResetConsumeAttempt{result: codexResetResult(cmd, "CONSUME_NOT_CALLED", "PROTOCOL_UNSUPPORTED")}
	}
	if !codexSharedStateAllowed(os.Environ()) {
		// The runner's own environment signs Codex in with custom API credentials, which is not the
		// default login an operation is bound to (§3).
		return codexResetConsumeAttempt{result: codexResetResult(cmd, "CONSUME_NOT_CALLED", codexResetUnsupportedAuth)}
	}
	var tried codexResetConsumeAttempt
	err = withDefaultCodexAppServer(ctx, c.attemptTimeout, func(ctx context.Context, app *codexAppServer) error {
		block, code := c.read(ctx, app)
		switch {
		case block == nil:
			tried.result = codexResetResult(cmd, "CONSUME_RETRYING", code)
		case block.Support == codexResetUnsupportedAuth || block.Support == codexResetProviderUnsupported:
			tried.account = "unsupported"
			tried.result = codexResetResult(cmd, "CONSUME_NOT_CALLED", block.Support)
		case block.AccountFingerprint == "":
			tried.account = "unidentified"
			tried.result = codexResetResult(cmd, "CONSUME_RETRYING", codexResetAccountUnidentified)
		case block.AccountFingerprint != cmd.AccountFingerprint:
			tried.account = "mismatch"
			tried.result = codexResetResult(cmd, "CONSUME_NOT_CALLED", "ACCOUNT_MISMATCH")
			tried.result.ObservedAccountFingerprint = block.AccountFingerprint
		default:
			tried.account = "match"
			// CREDITS_UNAVAILABLE and a count of 0 do not stop it: the outcome is the provider's (§6.4).
			if delivered := deliveries.latest(); c.now().Sub(delivered) >= c.callFreshness {
				tried.stale, tried.delivered = true, delivered
				return nil
			}
			tried.called = true
			codexResetLog(codexResetLogEvent{
				Stage: "consume", Event: "calling", OperationID: cmd.OperationID, Process: codexResetProcessTag(cmd.LeaseOwner),
				Phase: cmd.Phase, ClaimGeneration: cmd.ClaimGeneration, Attempt: attempt,
			}, cmd.ProviderIdempotencyKey)
			tried.result = c.call(ctx, app, cmd, params)
			tried.result.ObservedAccountFingerprint = block.AccountFingerprint
		}
		return nil
	})
	if err != nil {
		return codexResetConsumeAttempt{result: codexResetResult(cmd, "CONSUME_RETRYING", "APP_SERVER_UNAVAILABLE"), called: tried.called}
	}
	return tried
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
func (c *codexResetConsumer) refresh(ctx context.Context, cmd CodexRateLimitResetCommand, attempt int) CodexRateLimitResetResultRequest {
	account := ""
	result := func() CodexRateLimitResetResultRequest {
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
				account = "unidentified"
				result = codexResetResult(cmd, "REFRESH_FAILED", codexResetAccountUnidentified)
			case block.AccountFingerprint != cmd.AccountFingerprint:
				account = "mismatch"
				result = codexResetResult(cmd, "REFRESH_FAILED", "ACCOUNT_MISMATCH")
				result.ObservedAccountFingerprint = block.AccountFingerprint
			default:
				account = "match"
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
	}()
	codexResetLog(codexResetLogEvent{
		Stage: "refresh", Event: "read", OperationID: cmd.OperationID, Process: codexResetProcessTag(cmd.LeaseOwner),
		Phase: cmd.Phase, ClaimGeneration: cmd.ClaimGeneration, Attempt: attempt, Account: account,
		Kind: result.Kind, Code: result.Code,
	})
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
