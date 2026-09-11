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
// heartbeat for as long as the claim is this process's and the operation is active. A delivery is
// therefore never by itself a reason to start: the relay runs one step per claim at a time, and a
// claim's CONSUME step once for the life of this process. Running a consume again after it answered
// is not harmless under the same key: the provider only promises alreadyRedeemed for a key that
// already completed a reset, so a key whose consume answered nothingToReset or noCredit is unspent,
// and a second call could spend a credit behind an operation already settled as not spending one. A
// delivery the relay does not act on is dropped without a report; the control plane redelivers it or,
// once the claim is old enough, hands it to another process.
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
// at a time, and a claim's CONSUME at most once. The runner's is codexResetConsumer.execute; a relay
// built without one acts on no command it is handed.
type codexResetExecutor func(ctx context.Context, cmd CodexRateLimitResetCommand, report codexResetReporter)

// codexResetReporter sends one result until it has a receipt, and returns the receipt or the error
// that ended the attempt: *codexResetResultRefused when the control plane refused the result.
type codexResetReporter func(CodexRateLimitResetResultRequest) (CodexRateLimitResetResultResponse, error)

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

	mu       sync.Mutex
	running  map[codexResetClaim]bool
	consumed map[codexResetClaim]time.Time
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
	}
}

// handle takes the command one heartbeat response carried (nil when it carried none), received at
// `received`, by a process that is or is not draining by now. It never blocks.
func (r *codexResetRelay) handle(cmd *CodexRateLimitResetCommand, received time.Time, draining bool) {
	if cmd == nil {
		return
	}
	command := *cmd
	switch codexResetCommandDisposition(command, r.leaseOwner, received, r.now()) {
	case codexResetCommandIgnore:
		logln("codex reset", command.OperationID, "claim", command.ClaimGeneration,
			"delivery not acted on: not this process's claim, a stale response, or not a v1 command")
	case codexResetCommandRefuseProtocol:
		r.start(command, codexResetStartRefuse, func(context.Context, codexResetReporter) {
			_, _ = r.report(codexResetResult(command, "CONSUME_NOT_CALLED", "PROTOCOL_UNSUPPORTED"))
		})
	case codexResetCommandAct:
		switch {
		case draining:
			// A claim this process has not started goes back, so its successor takes it without
			// waiting the claim out. One it has started is its step's to finish and report.
			r.start(command, codexResetStartRelease, func(context.Context, codexResetReporter) {
				_, _ = r.report(codexResetResult(command, "RELEASED", "RUNNER_DRAINING"))
			})
		case r.execute == nil:
			logln("codex reset", command.OperationID, "claim", command.ClaimGeneration,
				"delivery not acted on: this binary carries out no reset step")
		default:
			r.start(command, codexResetStartStep, func(ctx context.Context, report codexResetReporter) {
				r.execute(ctx, command, report)
			})
		}
	}
}

func (r *codexResetRelay) start(cmd CodexRateLimitResetCommand, kind string, step func(context.Context, codexResetReporter)) {
	claim := codexResetClaim{operationID: cmd.OperationID, generation: cmd.ClaimGeneration}
	consume := kind == codexResetStartStep && cmd.Phase == codexResetPhaseConsume
	now := r.now()
	r.mu.Lock()
	for old, at := range r.consumed {
		if now.Sub(at) > codexResetConsumeMemory {
			delete(r.consumed, old)
		}
	}
	_, consumeStarted := r.consumed[claim]
	// One step per claim at a time; a claim's consume once; and a claim whose consume started is never
	// handed back, because that consume may have reached the provider.
	if r.running[claim] || (consumeStarted && (consume || kind == codexResetStartRelease)) {
		r.mu.Unlock()
		return
	}
	r.running[claim] = true
	if consume {
		r.consumed[claim] = now
	}
	r.mu.Unlock()
	r.ops.Add(1)
	go func() {
		defer r.ops.Done()
		defer func() {
			r.mu.Lock()
			delete(r.running, claim)
			r.mu.Unlock()
		}()
		step(r.ctx, r.report)
	}()
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
	for {
		receipt, err := r.send(r.ctx, body)
		if err == nil {
			logln("codex reset", result.OperationID, "claim", result.ClaimGeneration, result.Kind, "->",
				receipt.Disposition, receipt.Status, "next", receipt.Next)
			return receipt, nil
		}
		if !codexResetResultRetryable(err) || r.ctx.Err() != nil || r.now().Add(delay).After(deadline) {
			logln("codex reset", result.OperationID, "claim", result.ClaimGeneration, result.Kind, "not delivered:", err)
			return CodexRateLimitResetResultResponse{}, err
		}
		if !r.wait(r.ctx, delay) {
			return CodexRateLimitResetResultResponse{}, r.ctx.Err()
		}
		delay = min(delay*2, codexResetReceiptMaxDelay)
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
