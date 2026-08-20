package main

import (
	"context"
	"errors"
	"fmt"
)

// What each provider's engine is, as far as running a session is concerned. A session's
// driver is picked from this table rather than by comparing the provider name, so adding
// or changing an engine is one entry here instead of a branch in the session loop — and
// so callers can ask what a provider's transport IS without knowing which one it is.

// providerTransport is how an engine process is driven across a session's turns.
type providerTransport string

const (
	// transportStreamJSON: ONE process for the whole session, spoken to in stream-json
	// JSONL over a stdin that stays open. A turn's `result` is a turn boundary, not an
	// exit, so a prompt sent while the engine is mid-turn reaches the process that is
	// already working. The prompt is never argv — it is a `user` frame (claude).
	transportStreamJSON providerTransport = "stream-json"
	// transportJSONRPC: also one process for the whole session, but driven by a JSON-RPC
	// conversation over stdio rather than by conversation frames (codex app-server, kimi ACP).
	transportJSONRPC providerTransport = "json-rpc"
	// transportOneShot: one process per turn, carrying that turn's prompt and exiting when
	// it ends. Continuity across turns is the engine's own, via a session id it hands back
	// and we pass to the next spawn (opencode).
	transportOneShot providerTransport = "one-shot"
)

// sessionProcessArgs is what runSessionProcess hands a provider's session driver. Bundled
// only so the drivers can share one signature and sit behind the table below; the drivers
// themselves keep their own parameter lists.
type sessionProcessArgs struct {
	ctx               context.Context
	shutdownCtx       context.Context
	t                 *Transport
	job               *ClaimedSession
	leaseGeneration   string
	execDir           string
	scratchDir        string
	emit              emitFn
	emitFor           emitTurnFn
	setTurn           func(string)
	firstSpawn        bool
	bg                *bgTailer
	onCodexRateLimits func(map[string]interface{})
	completeTurn      turnCompleter
	waitTurnPermit    turnPermitWaiter
	onLeaseLost       leaseLossHandler
}

type providerRuntime struct {
	transport providerTransport
	run       func(sessionProcessArgs) (string, bool, bool)
}

// providerRuntimes is the set of engines this runner can drive: a name absent from it is
// not a provider (runtimeProvider falls back to the default for anything else).
var providerRuntimes = map[string]providerRuntime{
	providerClaude: {
		transport: transportStreamJSON,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runClaudeSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.emitFor, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerCodex: {
		transport: transportJSONRPC,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runCodexSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.emitFor, p.setTurn, p.firstSpawn, p.bg,
				p.onCodexRateLimits, p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerKimi: {
		transport: transportJSONRPC,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runKimiSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.emitFor, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerOpenCode: {
		transport: transportOneShot,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runOpenCodeSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.emitFor, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
}

// providerRuntimeFor answers how the named provider is driven. The name must already be
// normalised by runtimeProvider, which only ever returns a name this table holds.
func providerRuntimeFor(provider string) providerRuntime {
	return providerRuntimes[provider]
}

// errSteerUnsupported: a steer — a user message meant to be written into the turn already
// running — reached an engine that has no way to take one. The control plane decides that
// question before it files the turn (shared/providerTransport.ts), so this is the two of
// them disagreeing: a runner older than the control plane, or a session whose provider
// moved under it. It is settled loudly rather than ignored because the alternative is the
// one outcome mid-turn delivery must not produce — the turn is already leased and is never
// re-leased, so a message dropped here would simply be gone.
var errSteerUnsupported = errors.New("this engine cannot be given a message while a turn is running; send it again once the turn ends")

// refuseUnsupportedSteer settles a steer that arrived at a non-stream-json engine. It
// settles only that message: the turn it was meant to join is still running, and failing
// the session over a side-channel message that never reached the engine would take a
// working run down with it. Mirrors the claude loop's own refusal (errNoTurnToSteer) so a
// message refused by any provider reads the same on every client.
func refuseUnsupportedSteer(turnID, content, provider string, job *ClaimedSession, emitFor emitTurnFn, completeTurn turnCompleter) {
	cause := fmt.Errorf("%s: %w", provider, errSteerUnsupported)
	logln("refusing a steer for", job.SessionID+":", cause.Error())
	// The refusal enters the transcript as the failure it is. With no event at all the
	// sender is left watching an optimistic bubble wait for something never coming, and a
	// reload has nothing to render it from — a steer produces no reply of its own.
	emitFor(turnID, evUser, map[string]interface{}{
		"text": content, "delivery": string(deliveryFailed), "steer": true,
	})
	emitFor(turnID, evUserDelivery, map[string]interface{}{
		"turnId": turnID, "delivery": string(deliveryFailed),
		"reason": cause.Error(), "retryable": true,
	})
	settleSteerTurn(turnID, cause, job, completeTurn)
}
