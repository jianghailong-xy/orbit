package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// dshPermissionPolicy is what an Orbit permission mode means on DeepSeek Harness 0.2.0-rc.2,
// as measured by the P4 real-CLI scenarios (docs/evidence/deepseek-harness/p4/):
//
//   - read-only: native writes, including a command's writes, are denied by the file sandbox. The
//     tool may retry once with sandbox_permissions + justification, which is the only thing that
//     raises session/request_permission.
//   - workspace-write: writes inside the workspace and the temp directories run without asking;
//     anything wider is denied unless such an escalation is approved.
//   - MCP tools never raise a permission request, whatever their annotations say.
//   - A subagent's escalation never reaches ACP and its tool calls are not projected, so the
//     Orbit overlay removes the subagent tools (dshAgentOverlay).
//
// Plan, Accept Edits and Bypass have no enforceable equivalent and are refused, here and by
// the server (P0 contract §5).
type dshPermissionPolicy struct {
	FileMode string // DSH_PERMISSION_MODE, fixed when the process starts
	// Ask sends an escalation to an Orbit approval card; otherwise it is rejected unasked.
	Ask bool
	// ThirdPartyMCP admits servers the agent configured. Their tools act without any request,
	// so only a mode whose unapproved actions are allowed may mount them.
	ThirdPartyMCP bool
}

func dshPermissionPolicyFor(mode string) (dshPermissionPolicy, error) {
	switch mode {
	case "default":
		return dshPermissionPolicy{FileMode: "read-only", Ask: true}, nil
	case "dontAsk":
		return dshPermissionPolicy{FileMode: "read-only"}, nil
	case "auto", "":
		// An unset mode is the server's floor, Auto (apiserver common/permission-mode.ts).
		return dshPermissionPolicy{FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true}, nil
	}
	return dshPermissionPolicy{}, fmt.Errorf("DSH_PERMISSION_UNSUPPORTED: permission mode %q cannot be enforced by DeepSeek Harness; use Default, Auto or Don't Ask", mode)
}

const (
	dshAllowOnce  = "allow-once"
	dshRejectOnce = "reject-once"
)

// dshPermissionAsk is one session/request_permission joined to the tool call it names. dsh sends
// only the toolCallId, after draining that call's tool_call update.
type dshPermissionAsk struct {
	TurnID     string
	ToolCallID string
	Name       string
	Input      interface{}
}

// dshPermissionBridge answers dsh's approval requests. A request is answered once: allow-once
// only for an Orbit ALLOWED decision reached while its turn is still open, reject-once for a
// decision against it, cancelled otherwise. Closing the bridge (stop, settlement, transport
// loss) cancels every pending card, and the allow check and its write share one lock, so an
// answer that arrives after a stop can never reach dsh ahead of, or after, the cancellation.
type dshPermissionBridge struct {
	mu      sync.Mutex
	open    bool
	next    int
	pending map[int]context.CancelFunc
	wg      sync.WaitGroup
	policy  func() dshPermissionPolicy
	lookup  func(toolCallID string) (dshPermissionAsk, bool)
	decide  func(context.Context, dshPermissionAsk) string // option id, or "" for no decision
	reply   func(id interface{}, outcome map[string]interface{}) error
	emit    emitTurnFn
}

func newDshPermissionBridge(policy func() dshPermissionPolicy, lookup func(string) (dshPermissionAsk, bool),
	decide func(context.Context, dshPermissionAsk) string, emit emitTurnFn) *dshPermissionBridge {
	return &dshPermissionBridge{pending: map[int]context.CancelFunc{}, policy: policy, lookup: lookup, decide: decide, emit: emit}
}

// begin opens the bridge for a prompt that is about to be written.
func (b *dshPermissionBridge) begin() {
	b.mu.Lock()
	b.open = true
	b.mu.Unlock()
}

// close stops answering with anything but cancelled, and withdraws every pending card.
func (b *dshPermissionBridge) close() {
	b.mu.Lock()
	b.open = false
	for id, cancel := range b.pending {
		cancel()
		delete(b.pending, id)
	}
	b.mu.Unlock()
}

func (b *dshPermissionBridge) wait() { b.wg.Wait() }

func dshPermissionOutcome(optionID string) map[string]interface{} {
	if optionID == "" {
		return map[string]interface{}{"outcome": "cancelled"}
	}
	return map[string]interface{}{"outcome": "selected", "optionId": optionID}
}

// request runs on the ACP reader. It never blocks on a human: the decision is awaited on its own
// goroutine, so updates and the prompt response keep flowing while a card is open.
func (b *dshPermissionBridge) request(id interface{}, params map[string]interface{}) {
	callID := firstString(mapValue(params["toolCall"]), "toolCallId")
	ask, known := b.lookup(callID)
	note := func(subtype, reason string) {
		b.emit(ask.TurnID, evSystem, map[string]interface{}{"subtype": subtype, "provider": providerDsh,
			"toolCallId": callID, "name": ask.Name, "reason": reason})
	}
	// The two option ids P0 recorded. Anything else is a contract change, never a default allow.
	offered := map[string]bool{}
	options, _ := params["options"].([]interface{})
	for _, raw := range options {
		offered[firstString(mapValue(raw), "optionId")] = true
	}
	b.mu.Lock()
	open := b.open
	b.mu.Unlock()
	switch {
	case !open:
		b.answer(id, "")
		return
	case !offered[dshAllowOnce] || !offered[dshRejectOnce]:
		note("permission_denied", "DeepSeek Harness offered unknown approval options")
		b.answer(id, "")
		return
	case !known:
		// Without the call's name and arguments there is nothing a person could approve.
		note("permission_denied", "approval requested for a tool call Orbit has not received")
		b.answer(id, dshRejectOnce)
		return
	case !b.policy().Ask:
		note("permission_denied", "Don't Ask rejects every escalation without asking")
		b.answer(id, dshRejectOnce)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.mu.Lock()
	if !b.open {
		b.mu.Unlock()
		cancel()
		b.answer(id, "")
		return
	}
	b.next++
	key := b.next
	b.pending[key] = cancel
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		optionID := b.decide(ctx, ask)
		b.mu.Lock()
		defer b.mu.Unlock()
		if ctx.Err() != nil || !b.open {
			optionID = "" // stopped, settled or disconnected while the card was open
		}
		delete(b.pending, key)
		cancel()
		if err := b.reply(id, dshPermissionOutcome(optionID)); err != nil && !errors.Is(err, context.Canceled) {
			logln("dsh permission reply:", err)
		}
	}()
}

func (b *dshPermissionBridge) answer(id interface{}, optionID string) {
	if err := b.reply(id, dshPermissionOutcome(optionID)); err != nil {
		logln("dsh permission reply:", err)
	}
}

// bridgeDshPermission puts one escalation in front of a person as Orbit's approval card. Only
// ALLOWED allows, once; a card that cannot be filed or read is no decision at all.
func bridgeDshPermission(ctx context.Context, t *Transport, sessionID string, ask dshPermissionAsk) string {
	approvalID, err := t.createApproval(ctx, sessionID, map[string]interface{}{
		"toolName": ask.Name, "input": ask.Input, "toolUseId": ask.ToolCallID,
	})
	if err != nil {
		return ""
	}
	decision, err := awaitApprovalDecision(ctx, t, sessionID, approvalID)
	if err != nil {
		return ""
	}
	switch decision.Status {
	case "ALLOWED":
		return dshAllowOnce
	case "DENIED":
		return dshRejectOnce
	}
	return ""
}
