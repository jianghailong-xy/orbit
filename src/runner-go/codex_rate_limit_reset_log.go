package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Codex rate-limit reset telemetry, runner half (docs/codex-rate-limit-reset-runbook.md): one line per thing a
// step does, `codex-reset {json}`, keyed by the operationId the control plane's own lines carry, so the two
// halves read as one history of the operation.
//
// What a line may say is fixed here field by field: the operation id by its UUID shape, the process by eight hex
// digits of its leaseOwner, codes and states from the protocol's own vocabulary, and everything else a short
// lowercase word. A value that fits none of that, or that contains a secret the caller names (the provider key
// of the command at hand), is written as "[redacted]". Provider text, error messages, response bodies,
// fingerprints, account ids, tokens and environment values have no field at all, so no call site can pass one.

const codexResetLogRedacted = "[redacted]"

var (
	codexResetLogStages   = []string{"delivery", "consume", "refresh", "receipt"}
	codexResetLogAccounts = []string{"match", "mismatch", "unidentified", "unsupported"}
	codexResetLogWord     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
	codexResetLogProcess  = regexp.MustCompile(`^[0-9a-f]{8}$`)
)

// codexResetLogEvent is one line. Stage is delivery, consume, refresh or receipt; Event says what happened in it.
type codexResetLogEvent struct {
	Stage           string `json:"stage"`
	Event           string `json:"event"`
	OperationID     string `json:"operationId,omitempty"`
	Process         string `json:"process,omitempty"`
	Phase           string `json:"phase,omitempty"`
	ClaimGeneration int64  `json:"claimGeneration,omitempty"`
	Attempt         int    `json:"attempt,omitempty"`
	Kind            string `json:"kind,omitempty"`
	Outcome         string `json:"outcome,omitempty"`
	Code            string `json:"code,omitempty"`
	Disposition     string `json:"disposition,omitempty"`
	Status          string `json:"status,omitempty"`
	Next            string `json:"next,omitempty"`
	Account         string `json:"account,omitempty"`
	Reason          string `json:"reason,omitempty"`
	Error           string `json:"error,omitempty"`
	AgeMs           int64  `json:"ageMs,omitempty"`
	DelayMs         int64  `json:"delayMs,omitempty"`
}

// codexResetLog writes e as one line, redacted as codexResetLogLine says.
func codexResetLog(e codexResetLogEvent, secrets ...string) {
	logln("codex-reset", codexResetLogLine(e, secrets...))
}

// codexResetLogLine is e as the JSON a line carries, with every value that is not allowed in its field, or that
// contains one of secrets, replaced by "[redacted]".
func codexResetLogLine(e codexResetLogEvent, secrets ...string) string {
	allow := func(value string, ok bool) string {
		if value == "" {
			return ""
		}
		if !ok {
			return codexResetLogRedacted
		}
		for _, secret := range secrets {
			if len(secret) >= 8 && strings.Contains(value, secret) {
				return codexResetLogRedacted
			}
		}
		return value
	}
	enum := func(name, value string) string {
		return allow(value, codexResetOneOf(codexRateLimitResetEnums[name], value))
	}
	e.Stage = allow(e.Stage, codexResetOneOf(codexResetLogStages, e.Stage))
	e.Event = allow(e.Event, codexResetLogWord.MatchString(e.Event))
	e.OperationID = allow(e.OperationID, codexResetUUIDPattern.MatchString(e.OperationID))
	e.Process = allow(e.Process, codexResetLogProcess.MatchString(e.Process))
	e.Phase = enum("phase", e.Phase)
	e.Kind = enum("resultKind", e.Kind)
	e.Outcome = allow(e.Outcome, codexResetOneOf(codexRateLimitResetConsumeOutcomes, e.Outcome))
	e.Code = allow(e.Code, codexResetOneOf(codexRateLimitResetEnums["resultCode"], e.Code) ||
		codexResetOneOf(codexRateLimitResetEnums["resultRejection"], e.Code))
	e.Disposition = enum("resultDisposition", e.Disposition)
	e.Status = enum("operationStatus", e.Status)
	e.Next = enum("nextStep", e.Next)
	e.Account = allow(e.Account, codexResetOneOf(codexResetLogAccounts, e.Account))
	e.Reason = allow(e.Reason, codexResetLogWord.MatchString(e.Reason))
	e.Error = allow(e.Error, codexResetLogWord.MatchString(e.Error))
	data, err := json.Marshal(e)
	if err != nil {
		return `{"stage":"` + codexResetLogRedacted + `"}`
	}
	return string(data)
}

// codexResetProcessTag names a runner process in a line by the first eight hex digits of its leaseOwner: enough
// to tell the processes of one operation's history apart.
func codexResetProcessTag(leaseOwner string) string {
	if !codexResetUUIDPattern.MatchString(leaseOwner) {
		return ""
	}
	return leaseOwner[:8]
}

// codexResetErrorClass names an error by its kind, never by its text: a transport error's text carries the
// response body.
func codexResetErrorClass(err error) string {
	var refused *codexResetResultRefused
	var invalid *codexResetReceiptInvalid
	var status *transportHTTPError
	switch {
	case err == nil:
		return ""
	case errors.As(err, &refused):
		return "refused"
	case errors.As(err, &invalid):
		return "invalid_receipt"
	case errors.Is(err, context.Canceled):
		return "stopped"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &status):
		return fmt.Sprintf("http_%d", status.statusCode)
	default:
		return "transport"
	}
}
