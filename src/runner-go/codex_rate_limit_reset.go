package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// Codex earned rate-limit reset: the runner half of docs/codex-rate-limit-reset-contract.md. The
// wire DTOs below mirror @orbit/shared (dto.ts, codexRateLimitReset.ts) field for field, and both
// mirrors are tested against contracts/codex-rate-limit-reset.contract.json and its fixtures.
// Nothing reads or acts on them yet: codexRateLimitResetCapabilityV1 joins runnerCapabilitiesV1
// only in the change that implements the heartbeat relay and the consume together.

const (
	codexRateLimitResetProtocolVersion = 1
	codexRateLimitResetCapabilityV1    = "codex-rate-limit-reset-v1"

	codexAccountReadMethod           = "account/read"
	codexRateLimitsReadMethod        = "account/rateLimits/read"
	codexRateLimitResetConsumeMethod = "account/rateLimitResetCredit/consume"

	// The fingerprint key: 32 random bytes in this file under machineHome(), mode 0600, created
	// once. It never leaves the machine. Losing it changes every fingerprint, which stops in-flight
	// operations as an account change rather than re-binding them to whatever account is current.
	codexAccountFingerprintKeyFile = "codex-account-fingerprint.key"
	codexAccountFingerprintKeySize = 32
	codexAccountFingerprintPrefix  = "cxa1_"
	codexAccountFingerprintMessage = "orbit.codex-account-fingerprint.v1\n"

	codexRateLimitResetMaxCreditDetails = 100
	codexRateLimitResetMaxCreditText    = 1000
	codexRateLimitResetMaxMessage       = 500

	// A consume call starts only for a command taken from a heartbeat response this recent.
	codexRateLimitResetCommandFreshness = 60 * time.Second

	codexResetMaxSafeInteger = 1<<53 - 1
)

const (
	codexResetSupported           = "SUPPORTED"
	codexResetCreditsUnavailable  = "CREDITS_UNAVAILABLE"
	codexResetProviderUnsupported = "PROVIDER_UNSUPPORTED"
	codexResetUnsupportedAuth     = "UNSUPPORTED_AUTH"
	codexResetAccountUnidentified = "ACCOUNT_UNIDENTIFIED"

	codexResetPhaseConsume = "CONSUME"
	codexResetPhaseRefresh = "REFRESH"

	// What a runner process does with a command (codexResetCommandDisposition).
	codexResetCommandAct            = "ACT"
	codexResetCommandIgnore         = "IGNORE"
	codexResetCommandRefuseProtocol = "REFUSE_PROTOCOL"
)

// codexRateLimitResetEnums is every contract enum the runner speaks, in contract order.
var codexRateLimitResetEnums = map[string][]string{
	"support": {codexResetSupported, codexResetCreditsUnavailable, codexResetProviderUnsupported,
		codexResetUnsupportedAuth, codexResetAccountUnidentified},
	"phase":        {codexResetPhaseConsume, codexResetPhaseRefresh},
	"consumeState": {"PENDING", "CLAIMED", "CONFIRMED", "NOT_ATTEMPTED", "UNRESOLVED"},
	"refreshState": {"NONE", "PENDING", "SUCCEEDED", "FAILED", "NOT_REQUIRED"},
	"operationStatus": {"PENDING", "CONSUMING", "REFRESHING", "SUCCEEDED", "REFRESH_FAILED",
		"NOTHING_TO_RESET", "NO_CREDIT", "NOT_ATTEMPTED", "UNRESOLVED"},
	"resultKind": {"CONSUME_OUTCOME", "CONSUME_NOT_CALLED", "CONSUME_RETRYING", "RELEASED",
		"REFRESHED", "REFRESH_FAILED"},
	"resultCode": {"ACCOUNT_MISMATCH", "UNSUPPORTED_AUTH", "PROVIDER_UNSUPPORTED", "PROTOCOL_UNSUPPORTED",
		"PROVIDER_ERROR", "PROVIDER_TIMEOUT", "APP_SERVER_UNAVAILABLE", "READ_FAILED",
		"ACCOUNT_UNIDENTIFIED", "RUNNER_DRAINING"},
	"failureCode": {"ACCOUNT_MISMATCH", "UNSUPPORTED_AUTH", "PROVIDER_UNSUPPORTED", "PROTOCOL_UNSUPPORTED",
		"ACCOUNT_CHANGED", "CONSUME_EXPIRED", "REFRESH_EXPIRED"},
	"resultRejection": {"INVALID_RESULT", "OPERATION_NOT_FOUND", "STALE_CLAIM", "OPERATION_SETTLED",
		"PHASE_MISMATCH", "OUTCOME_CONFLICT", "ACCOUNT_MISMATCH"},
	"resultDisposition": {"APPLIED", "DUPLICATE"},
	"nextStep":          {"REFRESH", "RETRY_CONSUME", "RETRY_REFRESH", "STOP"},
}

// The provider's consume outcomes, spelled as it spells them.
var codexRateLimitResetConsumeOutcomes = []string{"reset", "nothingToReset", "noCredit", "alreadyRedeemed"}

type codexResetOutcomeEffect struct {
	Consumed        bool
	RefreshRequired bool
}

// alreadyRedeemed is this key's earlier reset answered again: it consumed a credit exactly as reset
// did, and both are followed by an authoritative read.
var codexRateLimitResetOutcomeEffects = map[string]codexResetOutcomeEffect{
	"reset":           {Consumed: true, RefreshRequired: true},
	"nothingToReset":  {},
	"noCredit":        {},
	"alreadyRedeemed": {Consumed: true, RefreshRequired: true},
}

type codexResetResultKindRule struct {
	Phases        []string
	Carries       string // "outcome" | "code" | "rateLimitReset"
	Codes         []string
	TerminalCodes []string
}

var codexRateLimitResetResultKinds = map[string]codexResetResultKindRule{
	"CONSUME_OUTCOME": {Phases: []string{codexResetPhaseConsume}, Carries: "outcome", Codes: []string{}, TerminalCodes: []string{}},
	"CONSUME_NOT_CALLED": {
		Phases:        []string{codexResetPhaseConsume},
		Carries:       "code",
		Codes:         []string{"ACCOUNT_MISMATCH", "UNSUPPORTED_AUTH", "PROVIDER_UNSUPPORTED", "PROTOCOL_UNSUPPORTED"},
		TerminalCodes: []string{"ACCOUNT_MISMATCH", "UNSUPPORTED_AUTH", "PROVIDER_UNSUPPORTED", "PROTOCOL_UNSUPPORTED"},
	},
	"CONSUME_RETRYING": {
		Phases:        []string{codexResetPhaseConsume},
		Carries:       "code",
		Codes:         []string{"PROVIDER_ERROR", "PROVIDER_TIMEOUT", "APP_SERVER_UNAVAILABLE", "READ_FAILED", "ACCOUNT_UNIDENTIFIED"},
		TerminalCodes: []string{},
	},
	"RELEASED": {Phases: []string{codexResetPhaseConsume, codexResetPhaseRefresh}, Carries: "code",
		Codes: []string{"RUNNER_DRAINING"}, TerminalCodes: []string{}},
	"REFRESHED": {Phases: []string{codexResetPhaseRefresh}, Carries: "rateLimitReset", Codes: []string{}, TerminalCodes: []string{}},
	"REFRESH_FAILED": {
		Phases:        []string{codexResetPhaseRefresh},
		Carries:       "code",
		Codes:         []string{"READ_FAILED", "APP_SERVER_UNAVAILABLE", "ACCOUNT_UNIDENTIFIED", "ACCOUNT_MISMATCH"},
		TerminalCodes: []string{"ACCOUNT_MISMATCH"},
	},
}

var (
	codexResetUUIDPattern             = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	codexResetTimestampMsPattern      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	codexResetTimestampSecondsPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)
	codexAccountFingerprintPattern    = regexp.MustCompile(`^cxa1_[0-9a-f]{32}$`)
)

// PlanUsageRateLimitReset mirrors @orbit/shared PlanUsageRateLimitReset: the default Codex
// account's earned reset state inside the Codex plan-usage snapshot.
type PlanUsageRateLimitReset struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Support         string `json:"support"`
	// Present exactly when Support is SUPPORTED or CREDITS_UNAVAILABLE.
	AccountFingerprint string `json:"accountFingerprint,omitempty"`
	// Non-nil exactly when Support is SUPPORTED. No omitempty: nil is sent as null.
	RateLimitResetCredits *PlanUsageRateLimitResetCredits `json:"rateLimitResetCredits"`
	// When the read started: RFC3339, UTC, milliseconds. Orders blocks.
	FetchedAt string `json:"fetchedAt"`
	// The process that made the read: its heartbeat leaseOwner.
	Generation string `json:"generation"`
	// That process's read counter, strictly increasing from 1.
	Sequence int64 `json:"sequence"`
}

// PlanUsageRateLimitResetCredits mirrors the provider's top-level rateLimitResetCredits.
// AvailableCount is authoritative. Credits is detail, never a count: nil (sent as null) means only
// the count is known, an empty non-nil slice means none came back, a shorter list is truncated.
type PlanUsageRateLimitResetCredits struct {
	AvailableCount int64                           `json:"availableCount"`
	Credits        []PlanUsageRateLimitResetCredit `json:"credits"`
}

// PlanUsageRateLimitResetCredit is one provider credit row with its unix-second times in RFC3339.
type PlanUsageRateLimitResetCredit struct {
	ID          string  `json:"id"`
	ResetType   string  `json:"resetType"`
	Status      string  `json:"status"`
	GrantedAt   string  `json:"grantedAt"`
	ExpiresAt   *string `json:"expiresAt"`
	Title       *string `json:"title"`
	Description *string `json:"description"`
}

// CodexRateLimitResetCommand mirrors @orbit/shared: one step of a reset operation, claimed for one
// runner process (LeaseOwner, ClaimGeneration) and redelivered until a result moves it on.
type CodexRateLimitResetCommand struct {
	ProtocolVersion    int    `json:"protocolVersion"`
	OperationID        string `json:"operationId"`
	LeaseOwner         string `json:"leaseOwner"`
	ClaimGeneration    int64  `json:"claimGeneration"`
	Phase              string `json:"phase"`
	AccountFingerprint string `json:"accountFingerprint"`
	// The operation's persisted provider key, exactly on CONSUME. Never generated or replaced here.
	ProviderIdempotencyKey string `json:"providerIdempotencyKey,omitempty"`
	RequestedAt            string `json:"requestedAt"`
}

// CodexRateLimitResetResultRequest mirrors @orbit/shared: what one claimed step came to, POSTed to
// /runner/codex-rate-limit-reset-result and retried byte for byte until acknowledged.
type CodexRateLimitResetResultRequest struct {
	ProtocolVersion            int                      `json:"protocolVersion"`
	OperationID                string                   `json:"operationId"`
	LeaseOwner                 string                   `json:"leaseOwner"`
	ClaimGeneration            int64                    `json:"claimGeneration"`
	Phase                      string                   `json:"phase"`
	Kind                       string                   `json:"kind"`
	Outcome                    string                   `json:"outcome,omitempty"`
	Code                       string                   `json:"code,omitempty"`
	Message                    string                   `json:"message,omitempty"`
	ObservedAccountFingerprint string                   `json:"observedAccountFingerprint,omitempty"`
	RateLimitReset             *PlanUsageRateLimitReset `json:"rateLimitReset,omitempty"`
}

// CodexRateLimitResetResultResponse mirrors @orbit/shared: how the control plane took a result and
// what the claim that sent it does next.
type CodexRateLimitResetResultResponse struct {
	Disposition string `json:"disposition"`
	Status      string `json:"status"`
	Next        string `json:"next"`
}

// CodexRateLimitResetResultRefusal mirrors @orbit/shared: the body of a refused result. Whatever the
// code, the claim that sent the result stops acting on that command.
type CodexRateLimitResetResultRefusal struct {
	Code string `json:"code"`
}

// CodexRateLimitResetOperationView mirrors @orbit/shared: the operation as the API shows it. It has
// no provider key field on purpose — the strict decoder refuses one.
type CodexRateLimitResetOperationView struct {
	ID                 string  `json:"id"`
	RunnerID           string  `json:"runnerId"`
	ClientRequestID    string  `json:"clientRequestId"`
	AccountFingerprint string  `json:"accountFingerprint"`
	Status             string  `json:"status"`
	ConsumeState       string  `json:"consumeState"`
	ConsumeOutcome     *string `json:"consumeOutcome"`
	RefreshState       string  `json:"refreshState"`
	FailureCode        *string `json:"failureCode"`
	LastErrorCode      *string `json:"lastErrorCode"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
	ConsumeConfirmedAt *string `json:"consumeConfirmedAt"`
	CompletedAt        *string `json:"completedAt"`
}

// codexAccountFingerprint derives the non-sensitive account fingerprint from the runner-local key
// and the accountId of the same account/rateLimits/read that produced the credits it labels.
func codexAccountFingerprint(key []byte, accountID string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(codexAccountFingerprintMessage + accountID))
	return codexAccountFingerprintPrefix + hex.EncodeToString(mac.Sum(nil)[:16])
}

// codexRateLimitResetFromRead maps account/read and account/rateLimits/read results to the support
// value, the account id to fingerprint (only for SUPPORTED and CREDITS_UNAVAILABLE) and the
// lossless credits summary (only for SUPPORTED). The count is always the provider's availableCount.
func codexRateLimitResetFromRead(account, rateLimits map[string]interface{}) (string, string, *PlanUsageRateLimitResetCredits) {
	identity, _ := account["account"].(map[string]interface{})
	if kind, _ := identity["type"].(string); kind != "chatgpt" {
		return codexResetUnsupportedAuth, "", nil
	}
	summary, present := rateLimits["rateLimitResetCredits"]
	if !present {
		return codexResetProviderUnsupported, "", nil
	}
	accountID, _ := rateLimits["accountId"].(string)
	if strings.TrimSpace(accountID) == "" {
		return codexResetAccountUnidentified, "", nil
	}
	raw, _ := summary.(map[string]interface{})
	credits := codexRateLimitResetCredits(raw)
	if credits == nil {
		return codexResetCreditsUnavailable, accountID, nil
	}
	return codexResetSupported, accountID, credits
}

func codexRateLimitResetCredits(raw map[string]interface{}) *PlanUsageRateLimitResetCredits {
	if raw == nil {
		return nil
	}
	count, ok := codexResetInteger(raw["availableCount"])
	if !ok || count < 0 {
		return nil
	}
	summary := &PlanUsageRateLimitResetCredits{AvailableCount: count}
	rows, ok := raw["credits"].([]interface{})
	if !ok {
		return summary // null, absent or not a list: only the count is known
	}
	if len(rows) > codexRateLimitResetMaxCreditDetails {
		rows = rows[:codexRateLimitResetMaxCreditDetails]
	}
	credits := make([]PlanUsageRateLimitResetCredit, 0, len(rows))
	for _, row := range rows {
		credit, ok := codexRateLimitResetCredit(row)
		if !ok {
			return summary // one unreadable row makes the details unknown, never a partial list
		}
		credits = append(credits, credit)
	}
	summary.Credits = credits
	return summary
}

func codexRateLimitResetCredit(row interface{}) (PlanUsageRateLimitResetCredit, bool) {
	raw, _ := row.(map[string]interface{})
	id, okID := raw["id"].(string)
	resetType, okType := raw["resetType"].(string)
	status, okStatus := raw["status"].(string)
	grantedAt, okGranted := codexResetUnixSeconds(raw["grantedAt"])
	if !okID || !okType || !okStatus || !okGranted ||
		!codexResetText(id, false) || !codexResetText(resetType, false) || !codexResetText(status, false) {
		return PlanUsageRateLimitResetCredit{}, false
	}
	expiresAt, okExpires := codexResetNullable(raw, "expiresAt", codexResetUnixSeconds)
	title, okTitle := codexResetNullable(raw, "title", codexResetDisplayText)
	description, okDescription := codexResetNullable(raw, "description", codexResetDisplayText)
	if !okExpires || !okTitle || !okDescription {
		return PlanUsageRateLimitResetCredit{}, false
	}
	return PlanUsageRateLimitResetCredit{
		ID: id, ResetType: resetType, Status: status, GrantedAt: grantedAt,
		ExpiresAt: expiresAt, Title: title, Description: description,
	}, true
}

// codexResetNullable reads an optional provider field whose absence and null both mean null.
func codexResetNullable(raw map[string]interface{}, key string, read func(interface{}) (string, bool)) (*string, bool) {
	value, present := raw[key]
	if !present || value == nil {
		return nil, true
	}
	s, ok := read(value)
	if !ok {
		return nil, false
	}
	return &s, true
}

func codexResetDisplayText(v interface{}) (string, bool) {
	s, ok := v.(string)
	return s, ok && codexResetText(s, true)
}

func codexResetUnixSeconds(v interface{}) (string, bool) {
	seconds, ok := codexResetInteger(v)
	if !ok || seconds < 0 {
		return "", false
	}
	return time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05Z"), true
}

// codexResetInteger accepts a JSON integer only: 1.5 or "2" is not a count.
func codexResetInteger(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n != math.Trunc(n) || math.Abs(n) > codexResetMaxSafeInteger {
			return 0, false
		}
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil && i <= codexResetMaxSafeInteger && i >= -codexResetMaxSafeInteger
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}

// codexResetConsumeParams is the complete params object of account/rateLimitResetCredit/consume:
// the operation's persisted key and nothing else. Protocol v1 never selects a credit.
func codexResetConsumeParams(cmd CodexRateLimitResetCommand) (map[string]interface{}, error) {
	if cmd.Phase != codexResetPhaseConsume {
		return nil, fmt.Errorf("a %s command does not consume", cmd.Phase)
	}
	if !codexResetUUIDPattern.MatchString(cmd.ProviderIdempotencyKey) {
		return nil, fmt.Errorf("consume command carries no canonical provider idempotency key")
	}
	return map[string]interface{}{"idempotencyKey": cmd.ProviderIdempotencyKey}, nil
}

// codexResetCommandDisposition decides what the process `leaseOwner` does with a command from a
// heartbeat response it received at `received`: act on it; ignore it (another process's claim, a
// response older than the freshness window, or a malformed command — nothing is reported, and the
// control plane redelivers or reassigns); or refuse a consume of a protocol it does not speak.
func codexResetCommandDisposition(cmd CodexRateLimitResetCommand, leaseOwner string, received, now time.Time) string {
	if cmd.LeaseOwner != leaseOwner || now.Sub(received) > codexRateLimitResetCommandFreshness {
		return codexResetCommandIgnore
	}
	if cmd.ProtocolVersion != codexRateLimitResetProtocolVersion {
		if cmd.Phase == codexResetPhaseConsume && codexResetUUIDPattern.MatchString(cmd.OperationID) && cmd.ClaimGeneration >= 1 {
			return codexResetCommandRefuseProtocol
		}
		return codexResetCommandIgnore
	}
	if len(codexResetCommandViolations(cmd)) > 0 {
		return codexResetCommandIgnore
	}
	return codexResetCommandAct
}

// decodeCodexResetWire decodes one wire object as strictly as @orbit/shared validates it: unknown
// fields, missing required fields, nulls where none is allowed and present-but-empty optional
// strings are errors; then the type's own rules run.
func decodeCodexResetWire[T any](data []byte, rules func(T) []string) (T, error) {
	var value T
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	var raw interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return value, err
	}
	if err := codexResetPresence(reflect.TypeOf(value), raw, "$"); err != nil {
		return value, err
	}
	if violations := rules(value); len(violations) > 0 {
		return value, fmt.Errorf("%s", strings.Join(violations, "; "))
	}
	return value, nil
}

func codexResetPresence(t reflect.Type, raw interface{}, path string) error {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Struct:
		object, ok := raw.(map[string]interface{})
		if !ok {
			return fmt.Errorf("%s must be an object", path)
		}
		for i := 0; i < t.NumField(); i++ {
			field := t.Field(i)
			name, omitempty := codexResetJSONTag(field)
			if name == "" {
				continue
			}
			value, present := object[name]
			switch {
			case !present:
				if !omitempty {
					return fmt.Errorf("%s.%s is required", path, name)
				}
			case value == nil:
				if omitempty || !codexResetNilable(field.Type) {
					return fmt.Errorf("%s.%s must not be null", path, name)
				}
			case omitempty && value == "":
				return fmt.Errorf("%s.%s must not be empty", path, name)
			default:
				if err := codexResetPresence(field.Type, value, path+"."+name); err != nil {
					return err
				}
			}
		}
	case reflect.Slice:
		items, _ := raw.([]interface{})
		for i, item := range items {
			if err := codexResetPresence(t.Elem(), item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func codexResetJSONTag(field reflect.StructField) (string, bool) {
	tag := field.Tag.Get("json")
	if tag == "" || tag == "-" {
		return "", false
	}
	parts := strings.Split(tag, ",")
	omitempty := false
	for _, option := range parts[1:] {
		omitempty = omitempty || option == "omitempty"
	}
	return parts[0], omitempty
}

func codexResetNilable(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Ptr, reflect.Slice, reflect.Map, reflect.Interface:
		return true
	default:
		return false
	}
}

func codexRateLimitResetBlockViolations(b PlanUsageRateLimitReset) []string {
	var out []string
	if b.ProtocolVersion != codexRateLimitResetProtocolVersion {
		out = append(out, "protocolVersion must be 1")
	}
	if !codexResetOneOf(codexRateLimitResetEnums["support"], b.Support) {
		out = append(out, "support is not a support value")
	}
	if b.AccountFingerprint != "" && !codexAccountFingerprintPattern.MatchString(b.AccountFingerprint) {
		out = append(out, "accountFingerprint must match cxa1_ + 32 lowercase hex")
	}
	identified := b.Support == codexResetSupported || b.Support == codexResetCreditsUnavailable
	if identified != (b.AccountFingerprint != "") {
		out = append(out, "accountFingerprint must be present exactly when support is SUPPORTED or CREDITS_UNAVAILABLE")
	}
	if (b.Support == codexResetSupported) != (b.RateLimitResetCredits != nil) {
		out = append(out, "rateLimitResetCredits must be non-null exactly when support is SUPPORTED")
	}
	if c := b.RateLimitResetCredits; c != nil {
		if c.AvailableCount < 0 || c.AvailableCount > codexResetMaxSafeInteger {
			out = append(out, "availableCount must be a non-negative integer")
		}
		if len(c.Credits) > codexRateLimitResetMaxCreditDetails {
			out = append(out, "credits must list at most 100 credits")
		}
		for i, credit := range c.Credits {
			if !codexResetText(credit.ID, false) || !codexResetText(credit.ResetType, false) || !codexResetText(credit.Status, false) ||
				!codexResetTimestamp(credit.GrantedAt, false) ||
				(credit.ExpiresAt != nil && !codexResetTimestamp(*credit.ExpiresAt, false)) ||
				(credit.Title != nil && !codexResetText(*credit.Title, true)) ||
				(credit.Description != nil && !codexResetText(*credit.Description, true)) {
				out = append(out, fmt.Sprintf("credits[%d] is not a valid credit", i))
			}
		}
	}
	if !codexResetTimestamp(b.FetchedAt, true) {
		out = append(out, "fetchedAt must be RFC3339 UTC with milliseconds")
	}
	if !codexResetUUIDPattern.MatchString(b.Generation) {
		out = append(out, "generation must be a canonical lowercase UUID")
	}
	if b.Sequence < 1 || b.Sequence > codexResetMaxSafeInteger {
		out = append(out, "sequence must be an integer of at least 1")
	}
	return out
}

func codexResetEnvelopeViolations(protocolVersion int, operationID, leaseOwner string, claimGeneration int64, phase string) []string {
	var out []string
	if protocolVersion != codexRateLimitResetProtocolVersion {
		out = append(out, "protocolVersion must be 1")
	}
	if !codexResetUUIDPattern.MatchString(operationID) {
		out = append(out, "operationId must be a canonical lowercase UUID")
	}
	if !codexResetUUIDPattern.MatchString(leaseOwner) {
		out = append(out, "leaseOwner must be a canonical lowercase UUID")
	}
	if claimGeneration < 1 || claimGeneration > codexResetMaxSafeInteger {
		out = append(out, "claimGeneration must be an integer of at least 1")
	}
	if !codexResetOneOf(codexRateLimitResetEnums["phase"], phase) {
		out = append(out, "phase must be CONSUME or REFRESH")
	}
	return out
}

func codexResetCommandViolations(c CodexRateLimitResetCommand) []string {
	out := codexResetEnvelopeViolations(c.ProtocolVersion, c.OperationID, c.LeaseOwner, c.ClaimGeneration, c.Phase)
	if !codexAccountFingerprintPattern.MatchString(c.AccountFingerprint) {
		out = append(out, "accountFingerprint must match cxa1_ + 32 lowercase hex")
	}
	if !codexResetTimestamp(c.RequestedAt, true) {
		out = append(out, "requestedAt must be RFC3339 UTC with milliseconds")
	}
	if c.Phase == codexResetPhaseConsume {
		if !codexResetUUIDPattern.MatchString(c.ProviderIdempotencyKey) {
			out = append(out, "providerIdempotencyKey must be a canonical lowercase UUID on CONSUME")
		}
	} else if c.ProviderIdempotencyKey != "" {
		out = append(out, "providerIdempotencyKey must be absent on REFRESH")
	}
	return out
}

func codexResetResultViolations(r CodexRateLimitResetResultRequest) []string {
	out := codexResetEnvelopeViolations(r.ProtocolVersion, r.OperationID, r.LeaseOwner, r.ClaimGeneration, r.Phase)
	rule, ok := codexRateLimitResetResultKinds[r.Kind]
	if !ok {
		return append(out, "kind is not a result kind")
	}
	if !codexResetOneOf(rule.Phases, r.Phase) {
		out = append(out, fmt.Sprintf("kind %s is not a %s result", r.Kind, r.Phase))
	}
	carried := map[string]bool{"outcome": r.Outcome != "", "code": r.Code != "", "rateLimitReset": r.RateLimitReset != nil}
	for _, field := range []string{"outcome", "code", "rateLimitReset"} {
		if carried[field] != (rule.Carries == field) {
			out = append(out, fmt.Sprintf("%s must be carried exactly by the kinds that carry it", field))
		}
	}
	if r.Outcome != "" && !codexResetOneOf(codexRateLimitResetConsumeOutcomes, r.Outcome) {
		out = append(out, "outcome is not a provider outcome")
	}
	if r.Code != "" && !codexResetOneOf(rule.Codes, r.Code) {
		out = append(out, fmt.Sprintf("code is not allowed on %s", r.Kind))
	}
	if codexResetUTF16Len(r.Message) > codexRateLimitResetMaxMessage {
		out = append(out, "message must be at most 500 characters")
	}
	if r.ObservedAccountFingerprint != "" && !codexAccountFingerprintPattern.MatchString(r.ObservedAccountFingerprint) {
		out = append(out, "observedAccountFingerprint must match cxa1_ + 32 lowercase hex")
	}
	if b := r.RateLimitReset; b != nil {
		out = append(out, codexRateLimitResetBlockViolations(*b)...)
		if b.Generation != r.LeaseOwner {
			out = append(out, "rateLimitReset.generation must be this result's leaseOwner")
		}
		if b.AccountFingerprint == "" {
			out = append(out, "rateLimitReset must identify the account it read")
		}
	}
	return out
}

func codexResetResultResponseViolations(r CodexRateLimitResetResultResponse) []string {
	var out []string
	if !codexResetOneOf(codexRateLimitResetEnums["resultDisposition"], r.Disposition) {
		out = append(out, "disposition is not a disposition")
	}
	if !codexResetOneOf(codexRateLimitResetEnums["operationStatus"], r.Status) {
		out = append(out, "status is not an operation status")
	}
	if !codexResetOneOf(codexRateLimitResetEnums["nextStep"], r.Next) {
		out = append(out, "next is not a next step")
	}
	return out
}

func codexResetOperationViewViolations(v CodexRateLimitResetOperationView) []string {
	var out []string
	for _, id := range []string{v.ID, v.RunnerID} {
		if id == "" || codexResetUTF16Len(id) > 64 {
			out = append(out, "id and runnerId must be non-empty ids")
		}
	}
	if !codexResetUUIDPattern.MatchString(v.ClientRequestID) {
		out = append(out, "clientRequestId must be a canonical lowercase UUID")
	}
	if !codexAccountFingerprintPattern.MatchString(v.AccountFingerprint) {
		out = append(out, "accountFingerprint must match cxa1_ + 32 lowercase hex")
	}
	if !codexResetOneOf(codexRateLimitResetEnums["operationStatus"], v.Status) {
		out = append(out, "status is not an operation status")
	}
	if v.ConsumeOutcome != nil && !codexResetOneOf(codexRateLimitResetConsumeOutcomes, *v.ConsumeOutcome) {
		out = append(out, "consumeOutcome must be null or a provider outcome")
	}
	if v.FailureCode != nil && !codexResetOneOf(codexRateLimitResetEnums["failureCode"], *v.FailureCode) {
		out = append(out, "failureCode must be null or a failure code")
	}
	if v.LastErrorCode != nil && !codexResetOneOf(codexRateLimitResetEnums["resultCode"], *v.LastErrorCode) {
		out = append(out, "lastErrorCode must be null or a result code")
	}
	if !codexResetTimestamp(v.CreatedAt, true) || !codexResetTimestamp(v.UpdatedAt, true) ||
		(v.ConsumeConfirmedAt != nil && !codexResetTimestamp(*v.ConsumeConfirmedAt, true)) ||
		(v.CompletedAt != nil && !codexResetTimestamp(*v.CompletedAt, true)) {
		out = append(out, "timestamps must be RFC3339 UTC with milliseconds")
	}
	if derived := codexResetOperationStatus(v.ConsumeState, v.ConsumeOutcome, v.RefreshState); derived == "" || derived != v.Status {
		out = append(out, "status must be the status its checkpoints derive")
	}
	if (v.ConsumeState == "CONFIRMED") != (v.ConsumeConfirmedAt != nil) {
		out = append(out, "consumeConfirmedAt must be set exactly when the consume is CONFIRMED")
	}
	active := v.Status == "PENDING" || v.Status == "CONSUMING" || v.Status == "REFRESHING"
	if active == (v.CompletedAt != nil) {
		out = append(out, "completedAt must be set exactly when the operation is settled")
	}
	failed := v.Status == "REFRESH_FAILED" || v.Status == "NOT_ATTEMPTED" || v.Status == "UNRESOLVED"
	if failed != (v.FailureCode != nil) {
		out = append(out, "failureCode must be set exactly on REFRESH_FAILED, NOT_ATTEMPTED and UNRESOLVED")
	}
	return out
}

// codexResetOperationStatus is the status two checkpoints derive, or "" for a combination the
// contract does not allow. It mirrors @orbit/shared codexResetOperationStatus.
func codexResetOperationStatus(consumeState string, consumeOutcome *string, refreshState string) string {
	if consumeState != "CONFIRMED" {
		if consumeOutcome != nil {
			return ""
		}
		switch consumeState {
		case "PENDING", "CLAIMED":
			if refreshState != "NONE" {
				return ""
			}
			if consumeState == "PENDING" {
				return "PENDING"
			}
			return "CONSUMING"
		case "NOT_ATTEMPTED", "UNRESOLVED":
			if refreshState != "NOT_REQUIRED" {
				return ""
			}
			return consumeState
		default:
			return ""
		}
	}
	if consumeOutcome == nil {
		return ""
	}
	effect, ok := codexRateLimitResetOutcomeEffects[*consumeOutcome]
	if !ok {
		return ""
	}
	if !effect.RefreshRequired {
		if refreshState != "NOT_REQUIRED" {
			return ""
		}
		if *consumeOutcome == "nothingToReset" {
			return "NOTHING_TO_RESET"
		}
		return "NO_CREDIT"
	}
	switch refreshState {
	case "PENDING":
		return "REFRESHING"
	case "SUCCEEDED":
		return "SUCCEEDED"
	case "FAILED":
		return "REFRESH_FAILED"
	default:
		return ""
	}
}

func codexResetOneOf(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// codexResetUTF16Len measures a string the way @orbit/shared's `.length` does.
func codexResetUTF16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func codexResetText(s string, allowEmpty bool) bool {
	return (allowEmpty || s != "") && codexResetUTF16Len(s) <= codexRateLimitResetMaxCreditText
}

func codexResetTimestamp(s string, millis bool) bool {
	pattern, layout := codexResetTimestampSecondsPattern, "2006-01-02T15:04:05Z"
	if millis {
		pattern, layout = codexResetTimestampMsPattern, "2006-01-02T15:04:05.000Z"
	}
	if !pattern.MatchString(s) {
		return false
	}
	_, err := time.Parse(layout, s)
	return err == nil
}
