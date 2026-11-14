package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The receipt (docs/orbit-agent-contract.md §6, gaps G3/G4).
//
// Every catalogued tool answers with one document of one shape, whatever happened: a write that
// took, a read, a dry run, a card the person declined, a card the owner wants to chat about, a card
// still waiting for them, a refusal, a call refused before anything was sent, and a request whose
// answer never came. It is the MCP result's structuredContent and, for every tool that writes, also
// its text (a chat's text is the owner's message as ownerChatReply hands it over); `orbit … --json`
// prints the same document for the same write (cli_receipt.go). A caller finds what it needs at
// fixed places instead of in prose:
//
//   - ok / outcome: did the call do what it asked, and if not, which of the ways it did not;
//   - operation / action / entityType / id / status: what it acted on, and how it stands now —
//     the id is the entity's own public id, the one to link as orbit-<kind>:<id>;
//   - changedFields: the fields this call wrote (a clear shows as written: the field is named);
//   - approval: whether a person was asked, and what they answered;
//   - idempotency: how a retry of this call is made safe;
//   - error: code, message and the retry rule, when ok is false and the outcome is not a chat;
//   - entity: the server's document, exactly as it answered.
//
// The receipt is versioned (receiptVersion) and its schema is every tool's advertised
// outputSchema. A field may be added within a version; none is renamed or retyped.

const toolReceiptVersion = 1

// The outcomes. ok is true for written, read and dry_run, false for every other one.
const (
	outcomeWritten  = "written"
	outcomeRead     = "read"
	outcomeDryRun   = "dry_run"
	outcomeDeclined = "declined"
	outcomePending  = "pending"
	outcomeRefused  = "refused"
	outcomeInvalid  = "invalid"
	outcomeUnknown  = "unknown"
	outcomeFailed   = "failed"
	// outcomeChat is the owner's "Chat about this" on the card (isOwnerChat): nothing was written and
	// nothing was refused. Their words are a message to answer, and the proposal is still open.
	outcomeChat = "chat"
)

var receiptOutcomes = []string{outcomeWritten, outcomeRead, outcomeDryRun, outcomeDeclined, outcomePending,
	outcomeRefused, outcomeInvalid, outcomeUnknown, outcomeFailed, outcomeChat}

// The approval outcomes.
const (
	approvalOutcomeNotRequired = "not_required"
	approvalOutcomeNotAsked    = "not_asked"
	approvalOutcomeApproved    = "approved"
	approvalOutcomeDeclined    = "declined"
	approvalOutcomePending     = "pending"
	// approvalOutcomeChat: the owner answered "Chat about this" and wants to talk it over first.
	approvalOutcomeChat = "chat"
)

var receiptApprovalOutcomes = []string{approvalOutcomeNotRequired, approvalOutcomeNotAsked, approvalOutcomeApproved,
	approvalOutcomeDeclined, approvalOutcomePending, approvalOutcomeChat}

// The retry rules an error carries (docs/orbit-agent-contract.md §5.2). Only resend is retryable:
// sending the same call again, unchanged, is safe and may succeed.
const (
	retryResend      = "resend"
	retryRereadFirst = "reread_first"
	retryFixInput    = "fix_input"
	retryDoNot       = "do_not_retry"
	retryWait        = "wait"
)

var receiptRetryRules = []string{retryResend, retryRereadFirst, retryFixInput, retryDoNot, retryWait}

// The error codes the runner itself gives. A refusal the server answered keeps the server's own code.
const (
	errorCodeInvalidArguments = "INVALID_ARGUMENTS"
	errorCodeApprovalDeclined = "APPROVAL_DECLINED"
	errorCodeAwaitingOwner    = "AWAITING_OWNER"
	errorCodeNoResponse       = "NO_RESPONSE"
	errorCodeNotSent          = "NOT_SENT"
	errorCodeOrchestrationOff = "ORCHESTRATION_OFF"
	errorCodeTaskIDRequired   = "TASK_ID_REQUIRED"
	errorCodeToolRefused      = "TOOL_REFUSED"
	// The server answered the write 2xx with ok:false — a start it skipped (superseded, a cancelled
	// project, …): nothing was started, and the answer says why.
	errorCodeNotDone = "NOT_DONE"
	// Orbit's Plan gate (plan_gate.go) refused a write before anything was sent: the session is in Plan mode,
	// so the write can be made once the plan is approved or the session leaves Plan, and not before (wait);
	// or the session's mode could not be read, and the same call may be sent again (resend).
	errorCodeSessionInPlanMode        = "SESSION_IN_PLAN_MODE"
	errorCodePermissionModeUnreadable = "PERMISSION_MODE_UNREADABLE"
)

// receiptEntityTypes are the operations whose answer is an entity of another object than the one
// they act on: task_start acts on a task and answers with the session it started.
var receiptEntityTypes = map[string]operationObject{"task_start": objectSession}

type toolReceipt struct {
	ReceiptVersion int                `json:"receiptVersion"`
	OK             bool               `json:"ok"`
	Outcome        string             `json:"outcome"`
	Operation      string             `json:"operation"`
	Action         string             `json:"action"`
	EntityType     string             `json:"entityType"`
	ID             *string            `json:"id"`
	Status         *string            `json:"status"`
	ChangedFields  []string           `json:"changedFields"`
	Approval       receiptApproval    `json:"approval"`
	Idempotency    receiptIdempotency `json:"idempotency"`
	Error          *receiptError      `json:"error,omitempty"`
	// Start is what became of the start a create asked for (startNow, or the owner's "Create and
	// start"): the started session, or why it was deferred.
	Start *receiptStart `json:"start,omitempty"`
	// Items maps a batch's items to what was written, in input order.
	Items []receiptItem `json:"items,omitempty"`
	// Count is how many entities a batch wrote.
	Count *int `json:"count,omitempty"`
	// Notes are the sentences that used to travel as prose beside the document.
	Notes []string `json:"notes,omitempty"`
	// Text is the tool's answer when it is not a JSON document.
	Text   string          `json:"text,omitempty"`
	Entity json.RawMessage `json:"entity,omitempty"`
}

type receiptApproval struct {
	Required bool   `json:"required"`
	Kind     string `json:"kind"`
	// Card is the confirmation card's name (orbit_task_create, …) when one was filed.
	Card    string `json:"card,omitempty"`
	Outcome string `json:"outcome"`
	// Decision is the card's own status as the server answered it: ALLOWED, DENIED, ABANDONED, ….
	Decision         string `json:"decision,omitempty"`
	DecidedBy        string `json:"decidedBy,omitempty"`
	Message          string `json:"message,omitempty"`
	StartAfterCreate bool   `json:"startAfterCreate,omitempty"`
}

type receiptIdempotency struct {
	Kind string `json:"kind"`
	Key  string `json:"key,omitempty"`
}

type receiptError struct {
	Code              string              `json:"code"`
	Message           string              `json:"message"`
	HTTPStatus        int                 `json:"httpStatus,omitempty"`
	Retryable         bool                `json:"retryable"`
	Retry             string              `json:"retry"`
	RetryAfterSeconds int                 `json:"retryAfterSeconds,omitempty"`
	RequiredAction    string              `json:"requiredAction,omitempty"`
	Violations        []argumentViolation `json:"violations,omitempty"`
	// Accepts is what the refused object takes, when a field was unknown.
	Accepts []string `json:"accepts,omitempty"`
}

type receiptStart struct {
	// By is who asked for the start: "startNow" (the caller) or "owner" (the card's Create and start).
	By        string          `json:"by"`
	Started   bool            `json:"started"`
	SessionID *string         `json:"sessionId"`
	Status    *string         `json:"status"`
	Deferred  string          `json:"deferred,omitempty"`
	Session   json.RawMessage `json:"session,omitempty"`
}

type receiptItem struct {
	Index  int     `json:"index"`
	Ref    string  `json:"ref,omitempty"`
	ID     *string `json:"id"`
	Status *string `json:"status"`
}

// answersWithReceipt says whether a tool's answer is the receipt. permission_prompt answers the
// engine in the engine's own protocol, and a tool that advertises an outputSchema of its own (the
// wiki tools) keeps the answer that schema describes.
func (op *operation) answersWithReceipt() bool {
	if op == nil || op.MCP == nil || openInputTools[op.Tool] {
		return false
	}
	if op.MCP.Extra != nil {
		if schema, own := op.MCP.Extra["outputSchema"]; own && !isReceiptSchema(schema) {
			return false
		}
	}
	return true
}

func isReceiptSchema(schema interface{}) bool {
	m, _ := schema.(map[string]interface{})
	return m != nil && m["title"] == toolReceiptSchemaTitle
}

// action is the verb a receipt reports: read for every operation that does not write, and for a
// write the operation's own verb (task_create → create, tasklist_update → update, task_dependency_add →
// dependency_add, notify → notify).
func (op *operation) action() string {
	if !op.Mutates {
		return "read"
	}
	tool := op.Tool
	for _, prefix := range []string{"tasklist_", "task_", "project_", "session_", "agent_", "provider_", "runner_",
		"watch_", "wiki_", "file_", "bg_", "integration_", "criterion_", "open_item_"} {
		if strings.HasPrefix(tool, prefix) && len(tool) > len(prefix) {
			tool = strings.TrimPrefix(tool, prefix)
			break
		}
	}
	return strings.TrimSuffix(tool, "_batch")
}

// The arguments that address an entity or steer the call rather than writing a field, in the order a
// receipt falls back to for its id when the answer names none.
var receiptAddressArguments = []string{"taskId", "listId", "projectId", "sessionId", "agentId", "runnerId",
	"providerId", "watchId", "jobId", "entryId", "attachmentId", "fileId", "itemId", "criterionId", "promotionId"}

var receiptControlArguments = map[string]bool{"idempotencyKey": true, "clientTurnId": true, "dryRun": true,
	"wait": true, "summary": true, "handoff": true, "expectedConfigRevision": true, "expectedRevision": true,
	// The fork snapshot a create carries is how the task starts, not a field of it.
	"fork": true}

// callRecord is what one tool call did, as the receipt needs it and the text cannot say: the requests
// it made and how each was answered, the cards it filed and their answers, the body it sent, and
// what became of a start.
type callRecord struct {
	op   *operation
	args map[string]interface{}
	// defaultTaskID is the current task a task tool acts on when it names none.
	defaultTaskID string

	// events are reported by the transports the call uses, which may be called from more than one
	// goroutine (a wait that polls while another request is answered).
	eventsMu sync.Mutex
	events   []transportEvent

	sent    map[string]interface{}
	start   *receiptStart
	pending string
	entity  json.RawMessage
	notes   []string
}

func newCallRecord(op *operation, args map[string]interface{}) *callRecord {
	return &callRecord{op: op, args: args}
}

func (rec *callRecord) observe(ev transportEvent) {
	if rec != nil {
		rec.eventsMu.Lock()
		rec.events = append(rec.events, ev)
		rec.eventsMu.Unlock()
	}
}

func (rec *callRecord) eventLog() []transportEvent {
	rec.eventsMu.Lock()
	defer rec.eventsMu.Unlock()
	return append([]transportEvent(nil), rec.events...)
}

// sentBody records the body the write sent, which is what changedFields reports: it holds the
// defaults the tool filled in (the assignee, a startNow's runAt) and not the arguments that only
// steered it.
func (rec *callRecord) sentBody(body map[string]interface{}) {
	if rec == nil {
		return
	}
	rec.sent = make(map[string]interface{}, len(body))
	for key, value := range body {
		rec.sent[key] = value
	}
}

// setEntity records the document the write answered with, for a tool whose text says more than it.
func (rec *callRecord) setEntity(doc json.RawMessage) {
	if rec != nil {
		rec.entity = doc
	}
}

func (rec *callRecord) note(sentence string) {
	if rec != nil && strings.TrimSpace(sentence) != "" {
		rec.notes = append(rec.notes, strings.TrimSpace(sentence))
	}
}

// waitingForOwner records that the call was handed to a runner-hosted job which asks the owner and
// performs the write itself if they confirm (handOffOwnerWait).
func (rec *callRecord) waitingForOwner(jobID string, job json.RawMessage) {
	if rec != nil {
		rec.pending = jobID
		if rec.pending == "" {
			rec.pending = "job"
		}
		rec.entity = job
	}
}

// sentBatch records a batch's bodies: its changedFields are every field some item sets.
func (rec *callRecord) sentBatch(bodies []map[string]interface{}) {
	if rec == nil {
		return
	}
	union := map[string]interface{}{}
	for _, body := range bodies {
		for key, value := range body {
			union[key] = value
		}
	}
	rec.sent = union
}

func (rec *callRecord) startOutcome(by string, started json.RawMessage, deferred string) {
	if rec == nil {
		return
	}
	if deferred == "" {
		if refusal := answerRefusal(started); refusal != nil {
			deferred = refusal.Message
		}
	}
	start := &receiptStart{By: by, Started: deferred == "" && len(started) > 0, Deferred: deferred}
	if start.Started {
		start.Session = started
		start.SessionID, start.Status = sessionIdentity(started)
	}
	rec.start = start
}

// answerRefusal reads an answer that says, in its own body, that the write did not happen: a top-level
// `ok: false` (a skipped start answers 2xx with {ok:false, skipped:"superseded"}). Nil for any other.
func answerRefusal(doc json.RawMessage) *receiptError {
	var answer struct {
		OK      *bool  `json:"ok"`
		Code    string `json:"code"`
		Skipped string `json:"skipped"`
		Message string `json:"message"`
		Reason  string `json:"reason"`
	}
	if len(doc) == 0 || doc[0] != '{' || json.Unmarshal(doc, &answer) != nil || answer.OK == nil || *answer.OK {
		return nil
	}
	e := &receiptError{Code: answer.Code, Retry: retryDoNot}
	if e.Code == "" {
		e.Code = errorCodeNotDone
	}
	switch {
	case answer.Message != "":
		e.Message = answer.Message
	case answer.Skipped != "":
		e.Message = "the server did not do it: skipped (" + answer.Skipped + ")"
	case answer.Reason != "":
		e.Message = "the server did not do it: " + answer.Reason
	default:
		e.Message = "the server answered ok: false"
	}
	return e
}

// lastDecision is the answer to the last card this call filed, and the card's name.
func (rec *callRecord) lastDecision() (*ApprovalDecisionResponse, string) {
	filed := map[string]string{}
	var decision *ApprovalDecisionResponse
	card := ""
	for _, ev := range rec.eventLog() {
		switch ev.Kind {
		case transportEventApprovalFiled:
			filed[ev.ApprovalID] = ev.ToolName
			card = ev.ToolName
		case transportEventApprovalDecided:
			decision = ev.Decision
			if name := filed[ev.ApprovalID]; name != "" {
				card = name
			}
		}
	}
	return decision, card
}

// lastFailedRequest is the call's last request when it failed, and nil when the last request
// succeeded or none was made: a failure after a request that succeeded is the tool's own.
func (rec *callRecord) lastFailedRequest() *transportEvent {
	events := rec.eventLog()
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind != transportEventRequest {
			continue
		}
		if events[i].Err == nil {
			return nil
		}
		ev := events[i]
		return &ev
	}
	return nil
}

// receipt builds the receipt for a result the handler returned.
func (rec *callRecord) receipt(text string, isErr bool) toolReceipt {
	op := rec.op
	r := baseReceipt(op, rec.args)
	decision, card := rec.lastDecision()
	if decision != nil {
		r.Approval.Required = true
		r.Approval.Card = card
		r.Approval.Decision = decision.Status
		r.Approval.DecidedBy = decision.DecidedByID
		r.Approval.StartAfterCreate = decision.StartAfterCreate
		switch {
		case decision.Status == "ALLOWED":
			r.Approval.Outcome = approvalOutcomeApproved
		case isOwnerChat(decision):
			// The owner's words as they sent them; the reply around them is the receipt's text.
			r.Approval.Outcome = approvalOutcomeChat
			r.Approval.Message = decision.Message
		default:
			r.Approval.Outcome = approvalOutcomeDeclined
			r.Approval.Message = declinedReason(decision)
		}
	}
	switch {
	case isOwnerChat(decision), decision == nil && !isErr && strings.HasPrefix(text, ownerChatLead):
		// "Chat about this" refuses nothing: nothing was written, the proposal is still open, and the
		// owner's words are a message to answer before calling again, changed as agreed. So there is
		// no error and no retry rule; the text is the reply every Orbit ask hands over (ownerChatReply).
		r.Outcome = outcomeChat
		r.Approval.Required = true
		r.Approval.Outcome = approvalOutcomeChat
		r.Text = text
		if decision != nil {
			r.Text = ownerChatReply(decision.Message)
		}
		return r
	case decision != nil && decision.Status != "ALLOWED", !isErr && strings.HasPrefix(text, "the human rejected"):
		r.Outcome = outcomeDeclined
		r.Approval.Required = true
		r.Approval.Outcome = approvalOutcomeDeclined
		r.Error = &receiptError{Code: errorCodeApprovalDeclined, Message: declineMessage(text, decision),
			Retry: retryDoNot}
		if r.Approval.Message == "" {
			r.Approval.Message = r.Error.Message
		}
		return r
	case rec.pending != "":
		r.Outcome = outcomePending
		r.Approval.Required = true
		r.Approval.Outcome = approvalOutcomePending
		r.Error = &receiptError{Code: errorCodeAwaitingOwner, Message: text, Retry: retryWait}
		r.Entity = rec.entity
		return r
	case isErr:
		r.Error, r.Outcome = rec.failure(text)
		if r.Approval.Outcome == approvalOutcomeNotRequired && op.Approval == approvalKindCard && decision == nil {
			r.Approval.Outcome = approvalOutcomeNotAsked
		}
		return r
	}
	r.OK = true
	r.Outcome = outcomeWritten
	if !op.Mutates {
		r.Outcome = outcomeRead
	}
	doc, notes, prose := splitProseAndJSON(text)
	if rec.entity != nil {
		// The handler said what its answer is; the prose around it is said by the receipt's own
		// fields (start, notes) instead.
		doc, notes, prose = rec.entity, nil, ""
	}
	r.Notes = append(notes, rec.notes...)
	if doc == nil {
		r.Text = prose
	} else {
		r.Entity = doc
	}
	if getBool(rec.args, "dryRun") {
		r.Outcome = outcomeDryRun
	}
	if refusal := answerRefusal(doc); refusal != nil && op.Mutates {
		r.OK, r.Outcome, r.Error = false, outcomeRefused, refusal
		if r.Approval.Outcome == approvalOutcomeNotRequired && op.Approval == approvalKindCard && decision == nil {
			r.Approval.Outcome = approvalOutcomeNotAsked
		}
		return r
	}
	if object, other := receiptEntityTypes[op.Tool]; other {
		r.EntityType = string(object)
		r.ID, r.Status = sessionIdentity(doc)
	} else {
		r.ID, r.Status = entityIdentity(doc)
	}
	if items, ok := batchItems(doc); ok && op.Mutates && r.Outcome != outcomeDryRun {
		r.Items = items
		count := len(items)
		r.Count = &count
	}
	if r.ID == nil {
		r.ID = rec.addressedID()
	}
	if op.Mutates && r.Outcome == outcomeWritten {
		r.ChangedFields = rec.changedFields()
	}
	r.Start = rec.start
	if op.Approval == approvalKindOwner && decision == nil && op.Mutates {
		// The call filed a question only the account owner answers; it is the answer that is pending.
		r.Approval.Required = true
		r.Approval.Outcome = approvalOutcomePending
	}
	return r
}

// baseReceipt is the receipt's frame before anything happened: what the call addressed and how a
// retry of it is made safe.
func baseReceipt(op *operation, args map[string]interface{}) toolReceipt {
	r := toolReceipt{
		ReceiptVersion: toolReceiptVersion,
		Operation:      op.Tool,
		Action:         op.action(),
		EntityType:     string(op.Object),
		ChangedFields:  []string{},
		Approval:       receiptApproval{Kind: string(op.Approval), Outcome: approvalOutcomeNotRequired},
		Idempotency:    receiptIdempotency{Kind: string(op.Idempotency)},
	}
	if r.Approval.Kind == "" {
		r.Approval.Kind = string(approvalKindNone)
	}
	if key := strings.TrimSpace(getString(args, "idempotencyKey")); key != "" {
		r.Idempotency.Kind = string(idempotencyCallerKey)
		r.Idempotency.Key = key
	} else if key := strings.TrimSpace(getString(args, "clientTurnId")); key != "" {
		r.Idempotency.Key = key
	} else if r.Idempotency.Kind == string(idempotencyCallerKey) && callerKeyIsOptional[op.Tool] {
		// The key is the caller's to send; without it the create is only deduplicated when the turn
		// that made it is redelivered.
		r.Idempotency.Kind = string(idempotencyServerKey)
	}
	return r
}

// startedAtOnceNote is what a create that also started its task says beside the receipt.
const startedAtOnceNote = "Started at once, as task_start would have started it, so do not call task_start for it."

// callerKeyIsOptional are the caller-key operations whose key may be left out, and which fall back to
// the server's turn-scoped deduplication without one.
var callerKeyIsOptional = map[string]bool{"task_create": true, "task_create_batch": true}

func (rec *callRecord) changedFields() []string {
	source := rec.sent
	address := map[string]bool{}
	if source == nil {
		source = rec.args
		for _, key := range receiptAddressArguments {
			address[key] = true
		}
		// An argument that writes a field of the same name is a field, not an address: project_id
		// on a create files the task under that project.
		if rec.op.action() == "create" {
			address = map[string]bool{}
		}
	}
	fields := make([]string, 0, len(source))
	for key := range source {
		if receiptControlArguments[key] || address[key] {
			continue
		}
		fields = append(fields, key)
	}
	sort.Strings(fields)
	return fields
}

// failure classifies a failed call by what its last request was answered with, or, when the tool
// refused it itself, by what it said.
func (rec *callRecord) failure(text string) (*receiptError, string) {
	op := rec.op
	keyed := strings.TrimSpace(getString(rec.args, "idempotencyKey")) != ""
	resendIsSafe := !op.Mutates || (keyed && op.Idempotency == idempotencyCallerKey)
	if failed := rec.lastFailedRequest(); failed != nil {
		var httpErr *transportHTTPError
		if errors.As(failed.Err, &httpErr) {
			e := &receiptError{Code: httpErr.code(), Message: text, HTTPStatus: httpErr.statusCode,
				RequiredAction: httpErr.requiredAction()}
			if e.Code == "" {
				e.Code = "HTTP_" + strconv.Itoa(httpErr.statusCode)
			}
			outcome := outcomeRefused
			switch status := httpErr.statusCode; {
			case status == http.StatusTooManyRequests:
				e.Retry = retryResend
				if seconds, err := strconv.Atoi(strings.TrimSpace(httpErr.retryAfter)); err == nil && seconds > 0 {
					e.RetryAfterSeconds = seconds
				}
			case status == http.StatusRequestTimeout || status >= 500:
				if resendIsSafe {
					e.Retry = retryResend
				} else {
					e.Retry = retryRereadFirst
				}
				if op.Mutates {
					outcome = outcomeUnknown
				} else {
					outcome = outcomeFailed
				}
			case status == http.StatusConflict:
				e.Retry = retryRereadFirst
			case status == http.StatusUnauthorized || status == http.StatusForbidden:
				e.Retry = retryDoNot
			default:
				e.Retry = retryFixInput
			}
			e.Retryable = e.Retry == retryResend
			return e, outcome
		}
		// Never sent: the connection was not made, so nothing reached the server and the same call
		// may simply be sent again.
		if requestNeverLeft(failed.Err) {
			return &receiptError{Code: errorCodeNotSent, Message: text, Retry: retryResend, Retryable: true}, outcomeFailed
		}
		// No answer came back: the request may have been received and acted on.
		e := &receiptError{Code: errorCodeNoResponse, Message: text}
		if resendIsSafe {
			e.Retry = retryResend
		} else {
			e.Retry = retryRereadFirst
		}
		e.Retryable = e.Retry == retryResend
		if op.Mutates {
			return e, outcomeUnknown
		}
		return e, outcomeFailed
	}
	e := &receiptError{Code: errorCodeToolRefused, Message: text, Retry: retryFixInput}
	switch {
	case text == orchestrationOffMsg:
		e.Code, e.Retry = errorCodeOrchestrationOff, retryDoNot
	case text == noTaskMsg:
		e.Code = errorCodeTaskIDRequired
	case strings.HasPrefix(text, planGateRefusalLead):
		e.Code, e.Retry = errorCodeSessionInPlanMode, retryWait
	case strings.HasPrefix(text, planGateUnreadableLead):
		e.Code, e.Retry, e.Retryable = errorCodePermissionModeUnreadable, retryResend, true
	}
	return e, outcomeRefused
}

// requestNeverLeft says whether a request failed before any byte of it reached the server: the
// connection itself could not be made (refused, unreachable, no such host).
func requestNeverLeft(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

func declineMessage(text string, decision *ApprovalDecisionResponse) string {
	if strings.HasPrefix(text, "the human rejected") {
		return text
	}
	// The text is a refusal document of its own: its message is the sentence.
	var doc struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(text), &doc) == nil && doc.Message != "" {
		return doc.Message
	}
	if decision != nil {
		return "the human rejected this: " + declinedReason(decision)
	}
	return text
}

// invalidArgumentsReceipt is the refusal of a call whose arguments do not fit its schema. Nothing
// was sent: no card, no write.
func invalidArgumentsReceipt(op *operation, args map[string]interface{}, violations []argumentViolation) toolReceipt {
	r := baseReceipt(op, args)
	r.Outcome = outcomeInvalid
	if op.Approval == approvalKindCard {
		r.Approval.Outcome = approvalOutcomeNotAsked
	}
	sentences := make([]string, len(violations))
	accepts := map[string][]string{}
	for i, v := range violations {
		sentences[i] = v.Message
		if v.Problem == violationUnknownField {
			parent := ""
			if dot := strings.LastIndex(v.Path, "."); dot >= 0 {
				parent = v.Path[:dot]
			}
			accepts[parent] = nil
		}
	}
	message := op.Tool + " was not sent, and nothing was written or asked: " + strings.Join(sentences, "; ")
	if !strings.HasSuffix(message, "?") && !strings.HasSuffix(message, ".") {
		message += "."
	}
	r.Error = &receiptError{Code: errorCodeInvalidArguments, Message: message, Retry: retryFixInput,
		Violations: violations}
	// What the arguments object takes, when one of its own fields was unknown: the next call can then be
	// written without guessing. A nested object's fields are in the tool's input schema.
	if _, topLevel := accepts[""]; topLevel && op.MCP != nil {
		r.Error.Accepts = declaredFieldNames(op.MCP.InputSchema)
	}
	return r
}

// splitProseAndJSON separates a tool's text into the JSON document it carries and the prose around it:
// the whole text, a document followed by prose, or prose followed by a document from the first line
// that opens one. A text with no document is prose alone.
func splitProseAndJSON(text string) (doc json.RawMessage, notes []string, prose string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, nil, ""
	}
	if json.Valid([]byte(trimmed)) && (trimmed[0] == '{' || trimmed[0] == '[') {
		return json.RawMessage(compactReceiptJSON(trimmed)), nil, ""
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		dec := json.NewDecoder(strings.NewReader(trimmed))
		var first json.RawMessage
		if dec.Decode(&first) == nil {
			rest := strings.TrimSpace(trimmed[dec.InputOffset():])
			return json.RawMessage(compactReceiptJSON(string(first))), proseNotes(rest), ""
		}
	}
	lines := strings.Split(trimmed, "\n")
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || (line[0] != '{' && line[0] != '[') {
			continue
		}
		candidate := strings.TrimSpace(strings.Join(lines[i:], "\n"))
		if json.Valid([]byte(candidate)) {
			return json.RawMessage(compactReceiptJSON(candidate)), proseNotes(strings.Join(lines[:i], "\n")), ""
		}
	}
	return nil, nil, trimmed
}

func proseNotes(prose string) []string {
	prose = strings.TrimSpace(prose)
	if prose == "" {
		return nil
	}
	return []string{prose}
}

func compactReceiptJSON(text string) string {
	var buf bytes.Buffer
	if json.Compact(&buf, []byte(text)) != nil {
		return text
	}
	return buf.String()
}

// entityIdentity is a document's own id and status: `id` (or `publicId`, or a background job's
// `jobId`), and `status` (or `state`) when it is a string. An array, or a document that names
// neither, has none.
func entityIdentity(doc json.RawMessage) (id, status *string) {
	var m map[string]interface{}
	if len(doc) == 0 || json.Unmarshal(doc, &m) != nil {
		return nil, nil
	}
	for _, key := range []string{"id", "publicId", "jobId"} {
		if s, ok := m[key].(string); ok && s != "" {
			id = &s
			break
		}
	}
	for _, key := range []string{"status", "state"} {
		if s, ok := m[key].(string); ok && s != "" {
			status = &s
			break
		}
	}
	return id, status
}

// sessionIdentity reads a start's answer: the session document itself, or one that wraps it.
func sessionIdentity(doc json.RawMessage) (id, status *string) {
	id, status = entityIdentity(doc)
	if id != nil {
		return id, status
	}
	var wrapped struct {
		Session   json.RawMessage `json:"session"`
		SessionID string          `json:"sessionId"`
	}
	if json.Unmarshal(doc, &wrapped) == nil {
		if len(wrapped.Session) > 0 {
			return entityIdentity(wrapped.Session)
		}
		if wrapped.SessionID != "" {
			return &wrapped.SessionID, status
		}
	}
	return nil, nil
}

// batchItems maps a batch's answer, an array of the rows written in input order, to the receipt's items.
func batchItems(doc json.RawMessage) ([]receiptItem, bool) {
	var rows []map[string]interface{}
	if len(doc) == 0 || doc[0] != '[' || json.Unmarshal(doc, &rows) != nil {
		return nil, false
	}
	items := make([]receiptItem, len(rows))
	for i, row := range rows {
		items[i].Index = i
		if ref, ok := row["ref"].(string); ok {
			items[i].Ref = ref
		}
		if id, ok := row["id"].(string); ok {
			items[i].ID = &id
		}
		if status, ok := row["status"].(string); ok {
			items[i].Status = &status
		}
	}
	return items, true
}

// addressedID is the id the call named, for an answer that does not name its own: an address
// argument, or the current task a task tool defaults to.
func (rec *callRecord) addressedID() *string {
	for _, key := range receiptAddressArguments {
		if id := strings.TrimSpace(getString(rec.args, key)); id != "" {
			return &id
		}
	}
	if rec.op.Object == objectTask && rec.defaultTaskID != "" {
		if _, declared := rec.op.inputProperties()["taskId"]; declared {
			id := rec.defaultTaskID
			return &id
		}
	}
	return nil
}

// inputProperties is the tool's declared top-level arguments.
func (op *operation) inputProperties() map[string]interface{} {
	if op == nil || op.MCP == nil {
		return nil
	}
	props, _ := op.MCP.InputSchema["properties"].(map[string]interface{})
	return props
}

// receiptResult is the MCP tool result that carries a receipt: as structuredContent always, and as
// the text too, so a client that reads only the text reads the same document.
func receiptResult(r toolReceipt, isErr bool) map[string]interface{} {
	result := toolResult(prettyReceipt(r), isErr)
	result["structuredContent"] = r
	return result
}

func prettyReceipt(r toolReceipt) string {
	blob, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return `{"receiptVersion":1,"ok":false,"outcome":"failed"}`
	}
	return string(blob)
}

// mcpResultText is a tool result's text: its first content block's.
func mcpResultText(result map[string]interface{}) string {
	content, _ := result["content"].([]map[string]interface{})
	if len(content) > 0 {
		text, _ := content[0]["text"].(string)
		return text
	}
	blocks, _ := result["content"].([]interface{})
	if len(blocks) > 0 {
		if block, ok := blocks[0].(map[string]interface{}); ok {
			text, _ := block["text"].(string)
			return text
		}
	}
	return ""
}

// structure turns a handler's result into the receipt result. A write's text becomes the receipt; a
// read keeps the text it always had, with the receipt beside it as structuredContent when the read
// answered with a document (or failed), and alone when it answered in prose.
func (rec *callRecord) structure(result map[string]interface{}) map[string]interface{} {
	if result == nil {
		return result
	}
	if _, own := result["structuredContent"]; own {
		return result
	}
	isErr := result["isError"] == true
	text := mcpResultText(result)
	r := rec.receipt(text, isErr)
	if r.Outcome == outcomeChat {
		// The owner's words are a message to answer, so the text stays the reply word for word, which
		// is where the clients read the words back from (ownerChatWords in @orbit/shared). The
		// receipt is the structured content beside it.
		out := toolResult(r.Text, false)
		out["structuredContent"] = r
		return out
	}
	if rec.op.Mutates {
		return receiptResult(r, isErr)
	}
	if !isErr && r.Entity == nil {
		// A read answered in prose — a summary, a job's output — keeps its text and nothing else. An
		// engine shows the model the structured content of a successful result in place of its text
		// (Claude Code does, and so does Codex), and prose inside a JSON string is prose made harder
		// to read for nothing a caller could branch on.
		return result
	}
	out := make(map[string]interface{}, len(result)+1)
	for key, value := range result {
		out[key] = value
	}
	out["structuredContent"] = r
	return out
}

const toolReceiptSchemaTitle = "OrbitReceiptV1"

// toolReceiptOutputSchema is the receipt's schema, every receipt tool's advertised outputSchema.
// Deliberately loose where the receipt carries the server's own document (entity, start.session):
// that is the server's, and the receipt promises only that it is there as the server sent it.
func toolReceiptOutputSchema() map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	nullableStr := map[string]interface{}{"type": []string{"string", "null"}}
	strList := map[string]interface{}{"type": "array", "items": str}
	return map[string]interface{}{
		"title":       toolReceiptSchemaTitle,
		"description": "The Orbit receipt (docs/orbit-agent-contract.md §6): ok and outcome say what happened; id and status are the entity's; error says why not and whether a resend is safe.",
		"type":        "object",
		"properties": map[string]interface{}{
			"receiptVersion": map[string]interface{}{"type": "integer"},
			"ok":             map[string]interface{}{"type": "boolean"},
			"outcome":        map[string]interface{}{"type": "string", "enum": receiptOutcomes},
			"operation":      str,
			"action":         str,
			"entityType":     str,
			"id":             nullableStr,
			"status":         nullableStr,
			"changedFields":  strList,
			"approval": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"required":         map[string]interface{}{"type": "boolean"},
					"kind":             str,
					"card":             str,
					"outcome":          map[string]interface{}{"type": "string", "enum": receiptApprovalOutcomes},
					"decision":         str,
					"decidedBy":        str,
					"message":          str,
					"startAfterCreate": map[string]interface{}{"type": "boolean"},
				},
				"required": []string{"required", "kind", "outcome"},
			},
			"idempotency": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"kind": map[string]interface{}{"type": "string", "enum": []string{string(idempotencyRead), string(idempotencyCallerKey), string(idempotencyServerKey), string(idempotencyNone)}},
					"key":  str,
				},
				"required": []string{"kind"},
			},
			"error": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"code":              str,
					"message":           str,
					"httpStatus":        map[string]interface{}{"type": "integer"},
					"retryable":         map[string]interface{}{"type": "boolean"},
					"retry":             map[string]interface{}{"type": "string", "enum": receiptRetryRules},
					"retryAfterSeconds": map[string]interface{}{"type": "integer"},
					"requiredAction":    str,
					"violations":        map[string]interface{}{"type": "array"},
					"accepts":           strList,
				},
				"required": []string{"code", "message", "retryable", "retry"},
			},
			"start": map[string]interface{}{
				"type":     "object",
				"required": []string{"by", "started", "sessionId", "status"},
			},
			"items": map[string]interface{}{
				"type":  "array",
				"items": map[string]interface{}{"type": "object", "required": []string{"index", "id", "status"}},
			},
			"count":  map[string]interface{}{"type": "integer"},
			"notes":  strList,
			"text":   str,
			"entity": map[string]interface{}{},
		},
		"required": []string{"receiptVersion", "ok", "outcome", "operation", "action", "entityType", "id", "status",
			"changedFields", "approval", "idempotency"},
	}
}

// invokeTool is one tools/call as `orbit mcp` serves it: the arguments are judged against the schema
// the tool advertises before anything runs — no card is filed and no request is sent for a call that
// does not fit it — and the answer is the receipt.
func (s *mcpServer) invokeTool(name string, args map[string]interface{}) map[string]interface{} {
	op := lookupCatalogOperation(name)
	if op == nil || op.MCP == nil {
		return s.callTool(name, args)
	}
	if !openInputTools[name] {
		if violations := validateToolArguments(op, args); len(violations) > 0 {
			refusal := invalidArgumentsReceipt(op, args, violations)
			if !op.answersWithReceipt() {
				// A tool with an answer schema of its own is refused in words: a receipt would not be
				// the document its outputSchema promises.
				return toolResult(refusal.Error.Message, true)
			}
			return receiptResult(refusal, true)
		}
	}
	if !op.answersWithReceipt() {
		return s.callTool(name, args)
	}
	rec := newCallRecord(op, args)
	rec.defaultTaskID = s.taskID
	stop := s.t.watch(rec.observe)
	s.rec = rec
	defer func() {
		s.rec = nil
		stop()
	}()
	return rec.structure(s.callTool(name, args))
}

// lookupCatalogOperation is one row of the catalogue as tools/list advertises it, built without the
// content hash a lookup has no use for. session_create's permission modes are narrowed to what this
// machine can run, exactly as its descriptor is, so the schema a call is judged by is the one the
// caller was shown.
func lookupCatalogOperation(tool string) *operation {
	for _, op := range buildOperationCatalog() {
		if op.Tool != tool {
			continue
		}
		if op.MCP != nil && op.Tool == "session_create" {
			descriptor := applyPermissionModeOffer(map[string]interface{}{"inputSchema": op.MCP.InputSchema})
			if schema, ok := descriptor["inputSchema"].(map[string]interface{}); ok {
				narrowed := *op.MCP
				narrowed.InputSchema = schema
				op.MCP = &narrowed
			}
		}
		return op
	}
	return nil
}
