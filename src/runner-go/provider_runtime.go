package main

import "context"

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
				p.execDir, p.scratchDir, p.emit, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerCodex: {
		transport: transportJSONRPC,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runCodexSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.setTurn, p.firstSpawn, p.bg,
				p.onCodexRateLimits, p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerKimi: {
		transport: transportJSONRPC,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runKimiSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
	providerOpenCode: {
		transport: transportOneShot,
		run: func(p sessionProcessArgs) (string, bool, bool) {
			return runOpenCodeSessionProcess(p.ctx, p.shutdownCtx, p.t, p.job, p.leaseGeneration,
				p.execDir, p.scratchDir, p.emit, p.setTurn, p.firstSpawn, p.bg,
				p.completeTurn, p.waitTurnPermit, p.onLeaseLost)
		},
	},
}

// providerRuntimeFor answers how the named provider is driven. The name must already be
// normalised by runtimeProvider, which only ever returns a name this table holds.
func providerRuntimeFor(provider string) providerRuntime {
	return providerRuntimes[provider]
}
