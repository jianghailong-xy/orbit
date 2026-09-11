package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// The Codex rate-limit reset relay, runner half (docs/codex-rate-limit-reset-contract.md §6.2–§6.5):
// what this process does with the command a heartbeat response hands it, and how each result of it
// reaches the control plane. The control-plane half is src/apiserver/src/runner-api/codex-reset-relay.ts.
//
// A DELIVERY is one heartbeat response carrying a command, and the control plane repeats it on every
// heartbeat for as long as the claim is this process's and the operation is active, renewing the claim
// each time. A delivery is therefore never by itself a reason to start: the relay runs one step per claim
// at a time, and a claim's CONSUME step once for the life of this process. Running a consume again after it
// answered is not harmless under the same key: the provider only promises alreadyRedeemed for a key that
// already completed a reset, so a key whose consume answered nothingToReset or noCredit is unspent, and a
// second call could spend a credit behind an operation already settled as not spending one. A delivery the
// relay does not act on is dropped without a report; the control plane redelivers it or, once the claim has
// gone unrenewed long enough, hands it to another process. What a delivery does do is tell a running step
// that its claim is still being handed over (codexResetDeliveries): the consume calls only while it is.
//
// A RECEIPT is the control plane's 200 answer to one result. Until a result has one it is sent again,
// byte for byte, with backoff, for at most codexResetReceiptWindow. A refusal (400/404/409 with a
// code) ends it at once. Whether the result was applied or recognised as a duplicate is the
// receipt's to say, not the sender's.
//
// The OUTCOME is the operation's settled state, and only the control plane holds it. Nothing here is
// kept on disk: a restart loses what is in memory, the claim ages into a takeover by the next process
// (§7.4), and that process starts the step again under the operation's one key.
//
// A process is handed commands only once it declares codexRateLimitResetCapabilityV1, which the runner
// declares for this relay together with the executor that carries the steps out: codexResetConsumer (§4).

const (
	codexResetResultPath = "/runner/codex-rate-limit-reset-result"
	// How long one result is sent again for without a receipt: the operation's consume and refresh
	// deadlines are this long, and past them the control plane settles it on a heartbeat anyway.
	codexResetReceiptWindow     = 10 * time.Minute
	codexResetReceiptFirstDelay = time.Second
	codexResetReceiptMaxDelay   = 30 * time.Second
	// How long a claim whose CONSUME started is remembered: longer than any claim can still be
	// delivered for (both deadlines, with a takeover window on each).
	codexResetConsumeMemory = 30 * time.Minute
)

// What the relay starts for one delivery.
const (
	codexResetStartStep    = "step"    // the executor, on a command this process acts on
	codexResetStartRelease = "release" // RELEASED, from a process that has begun draining
	codexResetStartRefuse  = "refuse"  // CONSUME_NOT_CALLED, for a consume of a protocol it does not speak
)

// codexResetExecutor carries out one command this process acts on, sending each result through report
// and following the next step each receipt names (§6.4). It is handed at most one command per claim
// at a time, and a claim's CONSUME at most once, with what the relay knows of that claim's deliveries.
// The runner's is codexResetConsumer.execute; a relay built without one acts on no command it is handed.
type codexResetExecutor func(ctx context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter, deliveries codexResetDeliveries)

// codexResetReporter sends one result until it has a receipt, and returns the receipt or the error
// that ended the attempt: *codexResetResultRefused when the control plane refused the result.
type codexResetReporter func(CodexRateLimitResetResultRequest) (CodexRateLimitResetResultResponse, error)

// codexResetDeliveries is what a step knows of the heartbeats that hand its claim to this process. The control
// plane delivers the command to the claim's holder on every heartbeat and renews the claim each time, and stops
// once the claim is another process's, the operation is settled or past its checkpoint's deadline, or this process
// is draining (§7.4). A claim delivered recently is therefore one no other process can have taken over yet.
type codexResetDeliveries interface {
	// latest is when the most recent heartbeat that delivered the claim was sent, which is no later than the
	// renewal it carried; the zero time before any.
	latest() time.Time
	// next waits for a heartbeat sent after `after` to deliver the claim, and reports whether one did before ctx
	// ended or `until` passed.
	next(ctx context.Context, after, until time.Time) bool
}

// codexResetResultRefused is a result the control plane refused, with the code it refused it with.
type codexResetResultRefused struct{ code string }

func (e *codexResetResultRefused) Error() string {
	return "codex rate-limit reset result refused: " + e.code
}

// codexResetReceiptInvalid is a 2xx answer to a result that is not a protocol v1 receipt.
type codexResetReceiptInvalid struct{ err error }

func (e *codexResetReceiptInvalid) Error() string {
	return "codex rate-limit reset answer is not a receipt: " + e.err.Error()
}

type codexResetClaim struct {
	operationID string
	generation  int64
}

// codexResetDelivery is the latest heartbeat that delivered one claim to this process.
type codexResetDelivery struct {
	sent time.Time
	// changed is closed, and replaced, whenever sent moves on: what a waiting step selects on.
	changed chan struct{}
}

type codexResetRelay struct {
	leaseOwner string
	send       func(ctx context.Context, body []byte) (CodexRateLimitResetResultResponse, error)
	execute    codexResetExecutor
	// Steps run under ctx, which outlives the drain: a draining process still finishes and reports a
	// step it has started. ops is joined before the process image is replaced.
	ctx  context.Context
	ops  *sync.WaitGroup
	now  func() time.Time
	wait func(ctx context.Context, d time.Duration) bool
	// awaiting, when set, hears that a step has begun waiting for its claim to be delivered again. Tests use
	// it to send that heartbeat; the runner's own heartbeat loop needs no prompt.
	awaiting func(codexResetClaim)

	mu        sync.Mutex
	running   map[codexResetClaim]bool
	consumed  map[codexResetClaim]time.Time
	delivered map[codexResetClaim]*codexResetDelivery
}

func newCodexResetRelay(ctx context.Context, t *Transport, execute codexResetExecutor, ops *sync.WaitGroup) *codexResetRelay {
	return &codexResetRelay{
		leaseOwner: t.leaseOwner,
		send:       t.codexRateLimitResetResult,
		execute:    execute,
		ctx:        ctx,
		ops:        ops,
		now:        time.Now,
		wait:       codexResetSleep,
		running:    map[codexResetClaim]bool{},
		consumed:   map[codexResetClaim]time.Time{},
		delivered:  map[codexResetClaim]*codexResetDelivery{},
	}
}

// handle takes the command one heartbeat response carried (nil when it carried none), from the heartbeat this
// process sent at `sent`, by a process that is or is not draining by now. It never blocks.
func (r *codexResetRelay) handle(cmd *CodexRateLimitResetCommand, sent time.Time, draining bool) {
	if cmd == nil {
		return
	}
	command := *cmd
	switch codexResetCommandDisposition(command, r.leaseOwner, sent, r.now()) {
	case codexResetCommandIgnore:
		line := r.deliveryLine(command, "ignored")
		line.Reason = codexResetIgnoredBecause(command, r.leaseOwner, sent, r.now())
		codexResetLog(line, command.ProviderIdempotencyKey)
	case codexResetCommandRefuseProtocol:
		r.start(command, codexResetStartRefuse, func(context.Context, codexResetReporter, codexResetDeliveries) {
			_, _ = r.report(codexResetResult(command, "CONSUME_NOT_CALLED", "PROTOCOL_UNSUPPORTED"))
		})
	case codexResetCommandAct:
		switch {
		case draining:
			// A claim this process has not started goes back, so its successor takes it without
			// waiting the claim out. One it has started is its step's to finish and report.
			r.start(command, codexResetStartRelease, func(context.Context, codexResetReporter, codexResetDeliveries) {
				_, _ = r.report(codexResetResult(command, "RELEASED", "RUNNER_DRAINING"))
			})
		case r.execute == nil:
			line := r.deliveryLine(command, "ignored")
			line.Reason = "no_executor"
			codexResetLog(line, command.ProviderIdempotencyKey)
		default:
			r.deliver(command, sent)
			r.start(command, codexResetStartStep, func(ctx context.Context, report codexResetReporter, deliveries codexResetDeliveries) {
				r.execute(ctx, command, report, deliveries)
			})
		}
	}
}

func (r *codexResetRelay) start(cmd CodexRateLimitResetCommand, kind string, step func(context.Context, codexResetReporter, codexResetDeliveries)) {
	claim := codexResetClaim{operationID: cmd.OperationID, generation: cmd.ClaimGeneration}
	consume := kind == codexResetStartStep && cmd.Phase == codexResetPhaseConsume
	now := r.now()
	r.mu.Lock()
	r.forget(now)
	running := r.running[claim]
	_, consumeStarted := r.consumed[claim]
	// One step per claim at a time; a claim's consume once; and a claim whose consume started is never
	// handed back, because that consume may have reached the provider.
	if running || (consumeStarted && (consume || kind == codexResetStartRelease)) {
		r.mu.Unlock()
		if !running {
			line := r.deliveryLine(cmd, "not_restarted")
			line.Reason = "consume_already_started"
			codexResetLog(line, cmd.ProviderIdempotencyKey)
		}
		return
	}
	r.running[claim] = true
	if consume {
		r.consumed[claim] = now
	}
	r.mu.Unlock()
	line := r.deliveryLine(cmd, "started")
	line.Reason = kind
	codexResetLog(line, cmd.ProviderIdempotencyKey)
	r.ops.Add(1)
	go func() {
		defer r.ops.Done()
		defer func() {
			r.mu.Lock()
			delete(r.running, claim)
			r.mu.Unlock()
		}()
		step(r.ctx, r.report, codexResetClaimDeliveries{relay: r, claim: claim})
	}()
}

// forget drops what the relay remembers of claims older than any that can still be delivered. Called with r.mu held.
func (r *codexResetRelay) forget(now time.Time) {
	for claim, at := range r.consumed {
		if now.Sub(at) > codexResetConsumeMemory {
			delete(r.consumed, claim)
		}
	}
	for claim, delivery := range r.delivered {
		if !r.running[claim] && now.Sub(delivery.sent) > codexResetConsumeMemory {
			delete(r.delivered, claim)
		}
	}
}

// deliver notes that the heartbeat sent at `sent` delivered cmd's claim, and wakes a step waiting for it.
func (r *codexResetRelay) deliver(cmd CodexRateLimitResetCommand, sent time.Time) {
	claim := codexResetClaim{operationID: cmd.OperationID, generation: cmd.ClaimGeneration}
	r.mu.Lock()
	defer r.mu.Unlock()
	delivery := r.deliveryOf(claim)
	if sent.After(delivery.sent) {
		delivery.sent = sent
		close(delivery.changed)
		delivery.changed = make(chan struct{})
	}
}

// deliveryOf is the delivery record of claim, an empty one when it has none yet. Called with r.mu held.
func (r *codexResetRelay) deliveryOf(claim codexResetClaim) *codexResetDelivery {
	delivery := r.delivered[claim]
	if delivery == nil {
		delivery = &codexResetDelivery{changed: make(chan struct{})}
		r.delivered[claim] = delivery
	}
	return delivery
}

// codexResetClaimDeliveries is codexResetDeliveries for one claim of relay.
type codexResetClaimDeliveries struct {
	relay *codexResetRelay
	claim codexResetClaim
}

func (d codexResetClaimDeliveries) latest() time.Time {
	d.relay.mu.Lock()
	defer d.relay.mu.Unlock()
	return d.relay.deliveryOf(d.claim).sent
}

func (d codexResetClaimDeliveries) next(ctx context.Context, after, until time.Time) bool {
	current := func() (time.Time, chan struct{}) {
		d.relay.mu.Lock()
		defer d.relay.mu.Unlock()
		delivery := d.relay.deliveryOf(d.claim)
		return delivery.sent, delivery.changed
	}
	for {
		sent, changed := current()
		if sent.After(after) {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		if d.relay.awaiting != nil {
			d.relay.awaiting(d.claim)
			if sent, _ := current(); sent.After(after) {
				return true
			}
		}
		remaining := until.Sub(d.relay.now())
		if remaining <= 0 {
			return false
		}
		timer := time.NewTimer(remaining)
		select {
		case <-changed:
			timer.Stop()
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
			return false
		}
	}
}

// report sends one result until it has a receipt: the same bytes every time, with backoff, while the
// receipt window and the relay's context last. A refusal, an answer that is not a receipt, or a
// failure that sending again cannot clear ends it at once.
func (r *codexResetRelay) report(result CodexRateLimitResetResultRequest) (CodexRateLimitResetResultResponse, error) {
	body, err := json.Marshal(result)
	if err != nil {
		return CodexRateLimitResetResultResponse{}, err
	}
	deadline := r.now().Add(codexResetReceiptWindow)
	delay := codexResetReceiptFirstDelay
	for attempt := 1; ; attempt++ {
		receipt, err := r.send(r.ctx, body)
		line := codexResetLogEvent{
			Stage: "receipt", OperationID: result.OperationID, Process: codexResetProcessTag(r.leaseOwner),
			Phase: result.Phase, ClaimGeneration: result.ClaimGeneration, Attempt: attempt,
			Kind: result.Kind, Outcome: result.Outcome, Code: result.Code, Error: codexResetErrorClass(err),
		}
		if err == nil {
			line.Event, line.Disposition, line.Status, line.Next = "received", receipt.Disposition, receipt.Status, receipt.Next
			codexResetLog(line)
			return receipt, nil
		}
		if !codexResetResultRetryable(err) || r.ctx.Err() != nil || r.now().Add(delay).After(deadline) {
			line.Event = "undelivered"
			var refused *codexResetResultRefused
			if errors.As(err, &refused) {
				line.Event, line.Code = "refused", refused.code
			}
			codexResetLog(line)
			return CodexRateLimitResetResultResponse{}, err
		}
		line.Event, line.DelayMs = "resending", delay.Milliseconds()
		codexResetLog(line)
		if !r.wait(r.ctx, delay) {
			return CodexRateLimitResetResultResponse{}, r.ctx.Err()
		}
		delay = min(delay*2, codexResetReceiptMaxDelay)
	}
}

// deliveryLine is the delivery-stage log line about cmd.
func (r *codexResetRelay) deliveryLine(cmd CodexRateLimitResetCommand, event string) codexResetLogEvent {
	return codexResetLogEvent{
		Stage: "delivery", Event: event, OperationID: cmd.OperationID, Process: codexResetProcessTag(r.leaseOwner),
		Phase: cmd.Phase, ClaimGeneration: cmd.ClaimGeneration,
	}
}

// codexResetIgnoredBecause is which of codexResetCommandDisposition's reasons to ignore cmd applies.
func codexResetIgnoredBecause(cmd CodexRateLimitResetCommand, leaseOwner string, sent, now time.Time) string {
	switch {
	case cmd.LeaseOwner != leaseOwner:
		return "another_process"
	case now.Sub(sent) > codexRateLimitResetCommandFreshness:
		return "stale_response"
	default:
		return "invalid_command"
	}
}

func codexResetResultRetryable(err error) bool {
	var refused *codexResetResultRefused
	var invalid *codexResetReceiptInvalid
	if errors.As(err, &refused) || errors.As(err, &invalid) {
		return false
	}
	return isRetryableTransportError(err)
}

// codexResetResult is a result of `kind` (with `code`, when the kind carries one) for the claim cmd
// was delivered under.
func codexResetResult(cmd CodexRateLimitResetCommand, kind, code string) CodexRateLimitResetResultRequest {
	return CodexRateLimitResetResultRequest{
		ProtocolVersion: codexRateLimitResetProtocolVersion,
		OperationID:     cmd.OperationID,
		LeaseOwner:      cmd.LeaseOwner,
		ClaimGeneration: cmd.ClaimGeneration,
		Phase:           cmd.Phase,
		Kind:            kind,
		Code:            code,
	}
}

func codexResetResultRefusalViolations(r CodexRateLimitResetResultRefusal) []string {
	if !codexResetOneOf(codexRateLimitResetEnums["resultRejection"], r.Code) {
		return []string{"code is not a result rejection"}
	}
	return nil
}

func codexResetSleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
