package main

// What one tool call did on the wire, for its receipt (tool_receipt.go).
//
// A receipt has to say things a tool's text cannot be trusted to: whether the request was answered
// at all, with which status and which refusal code, whether a card was filed and what the person
// answered. The handlers do not have to report any of it: the transport they already call tells the
// call's observer about every request it makes and every card it files and hears back from. One
// observer at a time — `orbit mcp` answers one tools/call before reading the next, and the CLI runs
// one command per process.

// The kinds of transportEvent.
const (
	transportEventRequest         = "request"
	transportEventApprovalFiled   = "approval_filed"
	transportEventApprovalDecided = "approval_decided"
)

type transportEvent struct {
	Kind   string
	Method string
	Path   string
	// Err is the request's failure: a *transportHTTPError for an answer that refused, anything else
	// for a request that was never answered. Nil for a request that succeeded.
	Err error

	ApprovalID string
	ToolName   string
	Decision   *ApprovalDecisionResponse
}

// watch makes fn the transport's observer until the returned stop is called.
func (t *Transport) watch(fn func(transportEvent)) (stop func()) {
	if t == nil {
		return func() {}
	}
	t.observerMu.Lock()
	t.observer = fn
	t.observerMu.Unlock()
	return func() {
		t.observerMu.Lock()
		t.observer = nil
		t.observerMu.Unlock()
	}
}

func (t *Transport) observe(ev transportEvent) {
	if t == nil {
		return
	}
	t.observerMu.Lock()
	fn := t.observer
	t.observerMu.Unlock()
	if fn != nil {
		fn(ev)
		return
	}
	// A CLI command run for its receipt makes its transports itself; they report to its record.
	cliRecord().observe(ev)
}

// approvalToolName is the card's name in an approval filing body.
func approvalToolName(body interface{}) string {
	if m, ok := body.(map[string]interface{}); ok {
		if name, ok := m["toolName"].(string); ok {
			return name
		}
	}
	return ""
}
